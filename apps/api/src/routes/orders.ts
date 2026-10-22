import { Router } from 'express';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../errors.js';
import { expireStalePendingOrders } from '../orders/lifecycle.js';

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

export function createOrdersRouter(pool: Pool, holdTtlSeconds: number): Router {
  const router = Router();

  router.post('/orders', async (req, res, next) => {
    try {
      const order = await createOrder(pool, holdTtlSeconds, req.body);
      res.status(201).location(`/orders/${order.id}`).json({ order });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
