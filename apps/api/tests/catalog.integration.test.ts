import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createTestPool,
  insertFixtureProduct,
  resetTestDatabase,
  startTestServer,
} from './helpers/db.js';

/**
 * Catalog integration tests — GET /products against REAL PostgreSQL.
 * (Test IDs referenced by ACCEPTANCE_CRITERIA: T-CATALOG-01, T-AVAIL-01, T-AVAIL-02.)
 */

let pool: Pool;
let baseUrl: string;
let closeServer: () => Promise<void>;

interface ProductJson {
  id: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
  availableUnits: number;
}

async function fetchProducts(): Promise<{ products: ProductJson[] }> {
  const response = await fetch(`${baseUrl}/products`);
  expect(response.status).toBe(200);
  return (await response.json()) as { products: ProductJson[] };
}

beforeAll(async () => {
  pool = createTestPool();
  await resetTestDatabase(pool);
  const server = await startTestServer(pool);
  baseUrl = server.baseUrl;
  closeServer = server.close;
});

afterAll(async () => {
  await closeServer();
  await pool.end();
});

describe('GET /products (real PostgreSQL)', () => {
  it('T-CATALOG-01: returns seeded products with the documented shape', async () => {
    const { products } = await fetchProducts();
    expect(products.length).toBeGreaterThanOrEqual(4);

    for (const product of products) {
      expect(typeof product.id).toBe('string');
      expect(product.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(typeof product.name).toBe('string');
      expect(Number.isInteger(product.pricePaise)).toBe(true);
      expect(product.pricePaise).toBeGreaterThan(0);
      expect(Number.isInteger(product.stockQuantity)).toBe(true);
      expect(product.stockQuantity).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(product.availableUnits)).toBe(true);
      expect(product.availableUnits).toBeGreaterThanOrEqual(0);
      expect(product.availableUnits).toBeLessThanOrEqual(product.stockQuantity);
    }
  });

  it('T-AVAIL-01: pending unexpired holds reduce availability but not physical stock', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 7 });
    const orderId = (
      await pool.query<{ id: string }>(
        `INSERT INTO orders (status, total_paise, expires_at)
         VALUES ('pending', 3000, now() + interval '120 seconds')
         RETURNING id`,
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO order_lines (order_id, product_id, quantity, unit_price_paise)
       VALUES ($1, $2, 3, 1000)`,
      [orderId, product.id],
    );

    const { products } = await fetchProducts();
    const found = products.find((p) => p.id === product.id)!;
    expect(found.availableUnits).toBe(4); // 7 physical − 3 held
    expect(found.stockQuantity).toBe(7); // physical stock untouched
  });

  it('T-AVAIL-02: expired holds never reduce availability, even before the status flips', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
    // Simulate an order created an hour ago whose hold has elapsed. Both
    // timestamps move together so the orders_expires_after_creation
    // invariant (a fresh order always has a positive hold) stays intact.
    const orderId = (
      await pool.query<{ id: string }>(
        `INSERT INTO orders (status, total_paise, created_at, expires_at)
         VALUES ('pending', 1000, now() - interval '1 hour', now() - interval '1 second')
         RETURNING id`,
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO order_lines (order_id, product_id, quantity, unit_price_paise)
       VALUES ($1, $2, 4, 1000)`,
      [orderId, product.id],
    );

    const { products } = await fetchProducts();
    const found = products.find((p) => p.id === product.id)!;
    expect(found.availableUnits).toBe(5); // expired hold is invisible to the formula

    // The row is still status='pending' (lazy policy) — the formula, not the
    // flip, is what protects availability.
    const order = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
      orderId,
    ]);
    expect(order.rows[0]!.status).toBe('pending');
  });
});
