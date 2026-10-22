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
 * observed/processed (order creation runs the global sweep; `GET /orders/:id`
 * runs the targeted variant below).
 *
 * The WHERE clause is what guarantees the rest of the state machine is
 * untouched: only `pending` rows can match, so `paid`, `needs_review`,
 * `picked_up` and already-`expired` orders can never be expired, and an
 * expired order can never return to `pending`. Physical stock is never
 * written by either statement.
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

/**
 * Targeted lazy expiration for a single observed order (status reads).
 *
 * Same guarded transition as the global sweep, scoped to one row so reads
 * never take table-wide work: row-level lock only, idempotent (a second call
 * matches zero rows), database clock, no revival path.
 */
export async function expireOrderIfStale(client: PoolClient, orderId: string): Promise<number> {
  const result = await client.query(
    `UPDATE orders
        SET status = 'expired'
      WHERE id = $1
        AND status = 'pending'
        AND expires_at <= now()`,
    [orderId],
  );
  return result.rowCount ?? 0;
}
