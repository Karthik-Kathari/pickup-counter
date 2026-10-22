import type { PoolClient } from 'pg';

/**
 * Lazy expiration (established lifecycle policy — no background scheduler).
 *
 * Materializes the `pending → expired` transition for every hold whose
 * deadline has passed, using the database clock. The guarded single UPDATE
 * (`WHERE status = 'pending' AND expires_at <= now()`) is safe under
 * concurrency: concurrent sweeps serialize on the affected row locks and the
 * second one matches zero rows.
 *
 * Correctness of inventory does NOT depend on this flip — the availability
 * formula already excludes pending orders whose hold elapsed. This sweep
 * only makes the persisted status agree with reality when orders are
 * observed/processed (currently at order creation; Phase 3 extends it to
 * `GET /orders/:id`).
 */
export async function expireStalePendingOrders(client: PoolClient): Promise<number> {
  const result = await client.query(
    `UPDATE orders
        SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}
