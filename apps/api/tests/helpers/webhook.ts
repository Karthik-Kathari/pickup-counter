import type { Pool } from 'pg';

/**
 * Deterministic fixture product with a controlled stale expiration window.
 * pricePaise is always the raw bigint value used in SQL and assertions.
 */
export async function insertStaleFixtureProduct(
  pool: Pool,
  overrides: {
    id?: string;
    key?: string;
    name?: string;
    pricePaise?: number;
    stockQuantity?: number;
  } = {},
): Promise<{ id: string; name: string; pricePaise: number; stockQuantity: number }> {
  const id =
    overrides.id ??
    `20000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  const key = overrides.key ?? `fixture-stale-${id.slice(-8)}`;
  const name = overrides.name ?? `Fixture Product (stale) ${id.slice(-4)}`;
  const pricePaise = overrides.pricePaise ?? 2000;
  const stockQuantity = overrides.stockQuantity ?? 10;

  await pool.query(
    `INSERT INTO products (id, key, name, price_paise, stock_quantity)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, key, name, pricePaise, stockQuantity],
  );
  return { id, name, pricePaise, stockQuantity };
}

/**
 * Create a pending order with a deadline that has ALREADY passed, expressed
 * only in database-clock terms.  `created_at` moves with `expires_at` so the
 * `orders_expires_after_creation` invariant stays intact; this simulates a
 * vendor order created an hour ago whose hold has elapsed.
 */
export async function insertStaleOrder(
  pool: Pool,
  orderId: string,
  productId: string,
  quantity = 1,
): Promise<{ totalPaise: number }> {
  const row = await pool.query<{ price_paise: string }>(
    'SELECT price_paise FROM products WHERE id = $1',
    [productId],
  );
  const pricePaise = Number(row.rows[0]?.price_paise ?? 0);
  const totalPaise = pricePaise * quantity;

  await pool.query(
    `INSERT INTO orders (id, status, total_paise, created_at, expires_at)
     VALUES ($1, 'pending', $2, now() - interval '1 hour', now() - interval '1 second')`,
    [orderId, totalPaise],
  );
  await pool.query(
    `INSERT INTO order_lines (order_id, product_id, quantity, unit_price_paise)
     VALUES ($1, $2, $3, $4)`,
    [orderId, productId, quantity, pricePaise],
  );

  return { totalPaise };
}
