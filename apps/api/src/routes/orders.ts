import { Router } from 'express';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../errors.js';
import { expireOrderIfStale, expireStalePendingOrders } from '../orders/lifecycle.js';

/**
 * POST /orders — transactional, all-or-nothing stock reservation.
 *
 * Transaction design (READ COMMITTED + explicit row locks), in order:
 *
 *   1. Lifecycle sweep: one guarded UPDATE flips stale `pending` orders to
 *      `expired` (DB clock). Cheap, deterministic, and safe concurrently.
 *   2. Lock every referenced product row `FOR UPDATE`, in ascending product_id
 *      order (`ORDER BY id` sorts before LockRows locks, so competing
 *      transactions always acquire the same order → no deadlocks).
 *   3. Compute active holds (pending, expires_at > now()) — a SEPARATE
 *      statement AFTER the locks are held. Under READ COMMITTED each
 *      statement takes a fresh snapshot, so this read sees every competing
 *      reservation that committed while we waited for the locks. This is
 *      the crux that removes the check-then-insert race.
 *   4. Insufficient availability on ANY line → throw → ROLLBACK: nothing is
 *      written, no partial reservation exists.
 *   5. Insert the order (server-calculated total in SQL bigint paise,
 *      expires_at = now() + make_interval(secs => ttl)) and its lines
 *      (unit prices read from the locked product rows — never from the
 *      client).
 *   6. COMMIT, then compute `expiresInSeconds` from the database clock in a
 *      final query — measured as late as possible, not hardcoded (I2).
 *
 * Physical stock is NEVER decremented here (I5); reservations are derived
 * rows that stop counting once the hold elapses.
 */

const MAX_LINE_QUANTITY = 99;
const MAX_ITEMS_PER_ORDER = 20;

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid('productId must be a valid UUID'),
        quantity: z.number().int().positive().max(MAX_LINE_QUANTITY),
      }),
    )
    .min(1, 'items must contain at least one line')
    .max(MAX_ITEMS_PER_ORDER),
});

export interface OrderItemResponse {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

export interface OrderResponse {
  id: string;
  status: string;
  totalPaise: number;
  expiresInSeconds: number;
  items: OrderItemResponse[];
}

interface LockedProductRow {
  id: string;
  name: string;
  price_paise: string;
  stock_quantity: number;
  held_quantity: string | null;
  available_units: number;
}

/**
 * Consolidate duplicate productIds by summing quantities. The schema-level
 * UNIQUE (order_id, product_id) makes a consolidated line the only possible
 * representation, so duplicates can never corrupt totals or reservations.
 */
function consolidateItems(
  items: Array<{ productId: string; quantity: number }>,
): Array<{ productId: string; quantity: number }> {
  const byId = new Map<string, number>();
  for (const item of items) {
    byId.set(item.productId, (byId.get(item.productId) ?? 0) + item.quantity);
  }
  return [...byId.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

async function insertOrder(
  client: PoolClient,
  lines: Array<{ productId: string; quantity: number }>,
  holdTtlSeconds: number,
): Promise<{ id: string; total_paise: string; created_at: Date; expires_at: Date }> {
  const productIds = lines.map((line) => line.productId);
  const quantities = lines.map((line) => line.quantity);

  const orderResult = await client.query<{
    id: string;
    total_paise: string;
    created_at: Date;
    expires_at: Date;
  }>(
    `
      INSERT INTO orders (status, total_paise, expires_at)
      SELECT 'pending',
             COALESCE(SUM(q.quantity::bigint * p.price_paise), 0),
             now() + make_interval(secs => $3::int)
        FROM (SELECT unnest($1::uuid[]) AS pid, unnest($2::integer[]) AS quantity) q
        JOIN products p ON p.id = q.pid
      RETURNING id, total_paise, created_at, expires_at
    `,
    [productIds, quantities, holdTtlSeconds],
  );
  const order = orderResult.rows[0];
  if (order === undefined) {
    throw new Error('order insert returned no row');
  }

  await client.query(
    `
      INSERT INTO order_lines (order_id, product_id, quantity, unit_price_paise)
      SELECT $1, q.pid, q.quantity, p.price_paise
        FROM (SELECT unnest($2::uuid[]) AS pid, unnest($3::integer[]) AS quantity) q
        JOIN products p ON p.id = q.pid
    `,
    [order.id, productIds, quantities],
  );

  return order;
}

async function fetchOrderItems(orderId: string, pool: Pool): Promise<OrderItemResponse[]> {
  const result = await pool.query<{
    product_id: string;
    name: string;
    quantity: number;
    unit_price_paise: string;
  }>(
    `
      SELECT ol.product_id, p.name, ol.quantity, ol.unit_price_paise
        FROM order_lines ol
        JOIN products p ON p.id = ol.product_id
       WHERE ol.order_id = $1
       ORDER BY p.name, ol.product_id
    `,
    [orderId],
  );
  return result.rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    quantity: row.quantity,
    unitPricePaise: Number(row.unit_price_paise),
    lineTotalPaise: row.quantity * Number(row.unit_price_paise),
  }));
}

async function readExpiresInSeconds(orderId: string, pool: Pool): Promise<number> {
  const result = await pool.query<{ expires_in_seconds: number }>(
    `
      SELECT GREATEST(
               FLOOR(EXTRACT(EPOCH FROM (expires_at - now())))::int,
               0
             ) AS expires_in_seconds
        FROM orders
       WHERE id = $1
    `,
    [orderId],
  );
  return result.rows[0]?.expires_in_seconds ?? 0;
}

export async function createOrder(
  pool: Pool,
  holdTtlSeconds: number,
  rawBody: unknown,
): Promise<OrderResponse> {
  const parsed = createOrderSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Request body failed validation',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const lines = consolidateItems(parsed.data.items);
  const requestedIds = lines.map((line) => line.productId);

  const client = await pool.connect();
  let order;
  try {
    await client.query('BEGIN');

    await expireStalePendingOrders(client);

    // Step 1 — acquire product row locks in deterministic order. ORDER BY id
    // sorts before LockRows locks, so all order-creation transactions
    // acquire locks in the same order → no deadlocks. This statement's
    // snapshot is irrelevant: it exists only to take the locks.
    const lockResult = await client.query<{ id: string }>(
      `
        SELECT id
          FROM products
         WHERE id = ANY ($1::uuid[])
         ORDER BY id
         FOR UPDATE
      `,
      [requestedIds],
    );

    if (lockResult.rows.length !== requestedIds.length) {
      const found = new Set(lockResult.rows.map((row) => row.id));
      const missing = requestedIds.filter((id) => !found.has(id));
      throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'One or more products do not exist', {
        missingProductIds: missing,
      });
    }

    // Step 2 — a SEPARATE statement, so under READ COMMITTED it takes a fresh
    // snapshot. Competing creators that committed while we waited for the
    // locks are therefore already visible here: their reservations are
    // counted in `held_quantity`. Computing availability in the same
    // statement as the lock (as an earlier version of this code did) would
    // use the pre-wait snapshot and allow overselling — the integration
    // tests caught exactly that.
    const availabilityResult = await client.query<LockedProductRow>(
      `
        SELECT p.id,
               p.name,
               p.price_paise,
               p.stock_quantity,
               held.held_quantity,
               GREATEST(p.stock_quantity - COALESCE(held.held_quantity, 0), 0)::int
                 AS available_units
          FROM products p
          LEFT JOIN (
            SELECT ol.product_id, SUM(ol.quantity) AS held_quantity
              FROM order_lines ol
              JOIN orders o ON o.id = ol.order_id
             WHERE o.status = 'pending'
               AND o.expires_at > now()
               AND ol.product_id = ANY ($1::uuid[])
             GROUP BY ol.product_id
          ) held ON held.product_id = p.id
         WHERE p.id = ANY ($1::uuid[])
         ORDER BY p.id
      `,
      [requestedIds],
    );

    const byId = new Map(availabilityResult.rows.map((row) => [row.id, row]));
    const shortages = lines.flatMap((line) => {
      const row = byId.get(line.productId);
      if (row === undefined || row.available_units >= line.quantity) {
        return [];
      }
      return [
        {
          productId: line.productId,
          requested: line.quantity,
          available: row.available_units,
        },
      ];
    });
    if (shortages.length > 0) {
      throw new HttpError(
        409,
        'INSUFFICIENT_STOCK',
        'Insufficient available stock for one or more items; nothing was reserved',
        { shortages },
      );
    }

    order = await insertOrder(client, lines, holdTtlSeconds);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // Post-commit reads use the pool (the transaction client was released).
  // expiresInSeconds is computed from the DB clock as late as possible (I2).
  const expiresInSeconds = await readExpiresInSeconds(order.id, pool);
  const items = await fetchOrderItems(order.id, pool);

  return {
    id: order.id,
    status: 'pending',
    totalPaise: Number(order.total_paise),
    expiresInSeconds,
    items,
  };
}

/**
 * GET /orders/:id — customer-facing order status (polling endpoint).
 *
 * Transaction shape (short; no network I/O inside):
 *   1. Targeted lazy flip: the same guarded `pending → expired` update,
 *      scoped to this one order (row-level lock, idempotent).
 *   2. SELECT the order, computing `expires_in_seconds` from the database
 *      clock in the same statement, so the status and the countdown in one
 *      response can never disagree.
 * Non-pending orders get no countdown field at all: an expired order never
 * presents a positive remaining time, and the value can never increase
 * across reads because the database clock is monotonic and the deadline is
 * immutable after creation.
 */
export interface OrderStatusResponse {
  id: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  expiresAt: string;
  expiresInSeconds?: number;
  paidAt?: string;
  pickedUpAt?: string;
  needsReviewReason?: string;
  items: OrderItemResponse[];
}

interface OrderStatusRow {
  id: string;
  status: string;
  total_paise: string;
  created_at: Date;
  expires_at: Date;
  paid_at: Date | null;
  picked_up_at: Date | null;
  needs_review_reason: string | null;
  expires_in_seconds: number;
}

const orderStatusSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

function toIsoOrUndefined(value: Date | null): string | undefined {
  return value === null ? undefined : value.toISOString();
}

export async function getOrder(pool: Pool, rawId: string): Promise<OrderStatusResponse> {
  const parsed = orderStatusSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Request parameters failed validation',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const orderId = parsed.data.id;

  const client = await pool.connect();
  let row: OrderStatusRow | undefined;
  try {
    await client.query('BEGIN');
    await expireOrderIfStale(client, orderId);
    const result = await client.query<OrderStatusRow>(
      `
        SELECT id,
               status,
               total_paise,
               created_at,
               expires_at,
               paid_at,
               picked_up_at,
               needs_review_reason,
               GREATEST(
                 FLOOR(EXTRACT(EPOCH FROM (expires_at - now())))::int,
                 0
               ) AS expires_in_seconds
          FROM orders
         WHERE id = $1
      `,
      [orderId],
    );
    row = result.rows[0];
    if (row === undefined) {
      throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // order_lines are immutable after creation, so reading them after commit
  // keeps the transaction short without risking inconsistency.
  const items = await fetchOrderItems(orderId, pool);

  const response: OrderStatusResponse = {
    id: row.id,
    status: row.status,
    totalPaise: Number(row.total_paise),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    items,
  };
  if (row.status === 'pending') {
    response.expiresInSeconds = row.expires_in_seconds;
  }
  const paidAt = toIsoOrUndefined(row.paid_at);
  if (paidAt !== undefined) {
    response.paidAt = paidAt;
  }
  const pickedUpAt = toIsoOrUndefined(row.picked_up_at);
  if (pickedUpAt !== undefined) {
    response.pickedUpAt = pickedUpAt;
  }
  if (row.needs_review_reason !== null) {
    response.needsReviewReason = row.needs_review_reason;
  }
  return response;
}

/**
 * POST /orders/:id/pickup-claim — the atomic pickup claim (I10).
 *
 * One PostgreSQL transaction on a dedicated client, in this order:
 *
 *   1. `SELECT …, (expires_at <= now()) AS is_expired … FOR UPDATE` on the
 *      order row — THE serialization point. Concurrent claimants queue on
 *      this row lock; under READ COMMITTED the loser re-reads the winner's
 *      committed row, so exactly one transaction can ever observe
 *      `status = 'paid'`.
 *   2. Eligibility gate, evaluated on that single locked snapshot: only
 *      `paid` proceeds — `picked_up` → 409 ORDER_ALREADY_CLAIMED, `expired`
 *      or a `pending` hold whose deadline already passed (database clock,
 *      I2) → 409 ORDER_EXPIRED, `pending` / `needs_review` → 409
 *      ORDER_NOT_PAID, unknown id → 404. Every rejection throws → ROLLBACK,
 *      so a rejected or losing claim writes NOTHING — including the lazy
 *      `pending → expired` materialization, which stays with the two
 *      established observation points (order creation and GET /orders/:id).
 *   3. order_lines are immutable after creation, so they are read unlocked,
 *      then every product row is locked `FOR UPDATE` in ascending id order
 *      (identical lock order to order creation → no deadlocks). A fresh
 *      snapshot after the locks checks physical stock against the claim:
 *      the I4 availability formula excludes already-`paid` orders, so two
 *      paid orders can cover the same units — the shortfall is answered
 *      deterministically with 409 INSUFFICIENT_STOCK and nothing written.
 *   4. Guarded flip `paid → picked_up` (we hold the row lock, so it matches
 *      exactly once even under concurrent claims or retry storms), then the
 *      permanent decrement — one statement, one row per product, guarded by
 *      `AND stock_quantity >= claim_quantity` with the schema CHECK
 *      (`stock_quantity >= 0`) as backstop. A rowCount that does not equal
 *      the product count throws: the flip and the deduction succeed
 *      together or not at all (I5).
 *
 * COMMIT, then the response is re-read through getOrder() so a successful
 * claim returns byte-identical contract data to GET /orders/:id.
 */
export async function claimOrder(pool: Pool, rawId: string): Promise<OrderStatusResponse> {
  const parsed = orderStatusSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Request parameters failed validation',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const orderId = parsed.data.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1 — lock the order row; this single locked snapshot decides the
    // winner (I10) and carries the DB-clock deadline (I2) for the gate.
    const orderResult = await client.query<{ status: string; is_expired: boolean }>(
      `SELECT status, (expires_at <= now()) AS is_expired
         FROM orders
        WHERE id = $1
        FOR UPDATE`,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (order === undefined) {
      throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    if (order.status === 'picked_up') {
      throw new HttpError(409, 'ORDER_ALREADY_CLAIMED', 'Order has already been picked up');
    }
    if (order.status === 'expired' || (order.status === 'pending' && order.is_expired)) {
      throw new HttpError(
        409,
        'ORDER_EXPIRED',
        'Order hold expired before payment; it cannot be picked up',
      );
    }
    if (order.status !== 'paid') {
      throw new HttpError(
        409,
        'ORDER_NOT_PAID',
        `Order is in state "${order.status}"; only paid orders can be claimed`,
      );
    }

    // Step 2 — immutable lines, product row locks in ascending id order,
    // then a fresh-snapshot physical-stock check while the locks are held.
    const lineResult = await client.query<{ product_id: string; quantity: number }>(
      'SELECT product_id, quantity FROM order_lines WHERE order_id = $1 ORDER BY product_id',
      [orderId],
    );
    const lines = lineResult.rows;
    const productIds = [...new Set(lines.map((line) => line.product_id))];

    if (productIds.length > 0) {
      const lockResult = await client.query<{ id: string }>(
        `SELECT id
           FROM products
          WHERE id = ANY ($1::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [productIds],
      );
      if (lockResult.rows.length !== productIds.length) {
        throw new Error('order references a product row that does not exist');
      }

      const needed = new Map<string, number>();
      for (const line of lines) {
        needed.set(line.product_id, (needed.get(line.product_id) ?? 0) + line.quantity);
      }

      const stockResult = await client.query<{ id: string; stock_quantity: number }>(
        `SELECT id, stock_quantity
           FROM products
          WHERE id = ANY ($1::uuid[])
          ORDER BY id`,
        [productIds],
      );
      const shortages = stockResult.rows.flatMap((row) => {
        const required = needed.get(row.id) ?? 0;
        if (row.stock_quantity >= required) {
          return [];
        }
        return [{ productId: row.id, required, available: row.stock_quantity }];
      });
      if (shortages.length > 0) {
        throw new HttpError(
          409,
          'INSUFFICIENT_STOCK',
          'Physical stock cannot cover this paid order; nothing was deducted',
          { shortages },
        );
      }
    }

    // Step 3 — flip first, so the deduction is guarded by the transition.
    const flipped = await client.query(
      `UPDATE orders
          SET status = 'picked_up',
              picked_up_at = now()
        WHERE id = $1
          AND status = 'paid'`,
      [orderId],
    );
    if ((flipped.rowCount ?? 0) !== 1) {
      throw new Error('paid → picked_up flip did not match exactly one row under row lock');
    }

    // Step 4 — permanent, exactly-once deduction (I5), never negative.
    if (productIds.length > 0) {
      const deducted = await client.query(
        `UPDATE products p
            SET stock_quantity = p.stock_quantity - sub.claim_quantity,
                updated_at = now()
           FROM (
             SELECT product_id, SUM(quantity)::int AS claim_quantity
               FROM order_lines
              WHERE order_id = $1
              GROUP BY product_id
           ) sub
          WHERE p.id = sub.product_id
            AND p.stock_quantity >= sub.claim_quantity`,
        [orderId],
      );
      if ((deducted.rowCount ?? 0) !== productIds.length) {
        throw new Error('inventory deduction did not affect exactly one row per product');
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // The order is terminal (`picked_up`), so this re-read only echoes the
  // state just committed — same shape and fields as GET /orders/:id.
  return getOrder(pool, orderId);
}

export function createOrdersRouter(pool: Pool, holdTtlSeconds: number): Router {
  const router = Router();

  router.get('/orders/:id', async (req, res, next) => {
    try {
      const order = await getOrder(pool, String(req.params.id));
      res.json({ order });
    } catch (error) {
      next(error);
    }
  });

  router.post('/orders', async (req, res, next) => {
    try {
      const order = await createOrder(pool, holdTtlSeconds, req.body);
      res.status(201).location(`/orders/${order.id}`).json({ order });
    } catch (error) {
      next(error);
    }
  });

  // The pickup claim takes no body: the path parameter is the entire input.
  router.post('/orders/:id/pickup-claim', async (req, res, next) => {
    try {
      const order = await claimOrder(pool, String(req.params.id));
      res.json({ order });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
