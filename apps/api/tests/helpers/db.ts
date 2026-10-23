import { loadConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runSeed } from '../../src/seed/seed.js';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';

/**
 * Integration-test helpers against REAL PostgreSQL.
 *
 * The test database comes from TEST_DATABASE_URL (see config.ts). It is
 * disposable by definition: `resetTestDatabase` drops and recreates the
 * public schema, re-applies migrations and re-seeds, so every test file
 * starts from a deterministic state and no test depends on execution order.
 *
 * There is no mock fallback: without a reachable database the suite fails
 * loudly (AGENTS.md, no-fake-tests rule).
 */

const config = loadConfig(process.env);

if (config.testDatabaseUrl === undefined) {
  throw new Error(
    'TEST_DATABASE_URL must be set to run integration tests (a real PostgreSQL database, ' +
      'e.g. postgres://postgres:postgres@localhost:5432/pickup_counter_test)',
  );
}

/** Independent pool per test file (vitest runs files in separate workers). */
export function createTestPool(maxConnections = 20): Pool {
  return createPool(config.testDatabaseUrl!, maxConnections);
}

export async function resetTestDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool);
  await runSeed(pool);
}

/** Fixture product with exactly controlled stock; deterministic per-test UUID. */
export async function insertFixtureProduct(
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
    `10000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  const key = overrides.key ?? `fixture-${id.slice(-8)}`;
  const name = overrides.name ?? `Fixture Product ${id.slice(-4)}`;
  const pricePaise = overrides.pricePaise ?? 1500;
  const stockQuantity = overrides.stockQuantity ?? 10;

  await pool.query(
    `INSERT INTO products (id, key, name, price_paise, stock_quantity)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, key, name, pricePaise, stockQuantity],
  );
  return { id, name, pricePaise, stockQuantity };
}

/** Start the real Express app on an ephemeral port; returns base URL + closer. */
export async function startTestServer(
  pool: Pool,
  holdTtlSeconds = 120,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = createApp({ pool, holdTtlSeconds, webhookSecret: 'test-webhook-secret-12345678' });
  const server: Server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Active (pending, unexpired) held quantity for a product, straight from SQL. */
export async function activeHeldQuantity(pool: Pool, productId: string): Promise<number> {
  const result = await pool.query<{ held: string | null }>(
    `
      SELECT SUM(ol.quantity) AS held
        FROM order_lines ol
        JOIN orders o ON o.id = ol.order_id
       WHERE ol.product_id = $1
         AND o.status = 'pending'
         AND o.expires_at > now()
    `,
    [productId],
  );
  return Number(result.rows[0]?.held ?? 0);
}
