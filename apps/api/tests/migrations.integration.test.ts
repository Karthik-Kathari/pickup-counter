import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

/**
 * Integration tests for the migration runner against REAL PostgreSQL.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable database — the same
 * database the Docker Compose init service creates (pickup_counter_test).
 * There is deliberately no mock fallback: if the database is unreachable the
 * suite fails loudly (AGENTS.md, no-fake-tests rule).
 */

const config = loadConfig(process.env);

if (config.testDatabaseUrl === undefined) {
  throw new Error(
    'TEST_DATABASE_URL must be set to run integration tests (a real PostgreSQL database, ' +
      'e.g. postgres://postgres:postgres@localhost:5432/pickup_counter_test)',
  );
}

let pool: Pool;

describe('migration runner (real PostgreSQL)', () => {
  beforeAll(async () => {
    pool = createPool(config.testDatabaseUrl!, 2);
    // Start from a clean slate: the test database is disposable by definition.
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies pending migrations on a fresh database', async () => {
    const result = await runMigrations(pool);
    expect(result.applied).toContain('0001_init');
    expect(result.applied.length).toBeGreaterThan(0);

    const history = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(history.rows.length).toBe(result.applied.length + result.alreadyApplied.length);
  });

  it('is idempotent: a second run applies nothing and records nothing new', async () => {
    const before = await pool.query<{ count: string }>('SELECT count(*) FROM schema_migrations');

    const second = await runMigrations(pool);
    expect(second.applied).toHaveLength(0);

    const after = await pool.query<{ count: string }>('SELECT count(*) FROM schema_migrations');
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('creates the expected tables, constraints, and indexes', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'products',
        'orders',
        'order_lines',
        'payment_events',
        'schema_migrations',
      ]),
    );

    // Money columns must be integral types, never floating point.
    const moneyColumns = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name LIKE '%_paise'`,
    );
    expect(moneyColumns.rows.length).toBeGreaterThanOrEqual(3);
    for (const column of moneyColumns.rows) {
      expect(['bigint', 'integer'], `${column.table_name}.${column.column_name}`).toContain(
        column.data_type,
      );
    }

    // The idempotency key for payment events exists as a primary key.
    const pk = await pool.query(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = 'payment_events' AND constraint_type = 'PRIMARY KEY'`,
    );
    expect(pk.rows.length).toBe(1);

    // Physical stock can never go negative at the database level.
    const stockCheck = await pool.query(
      `SELECT check_clause FROM information_schema.check_constraints
        WHERE constraint_name = 'products_stock_quantity_check'`,
    );
    expect(stockCheck.rows.length).toBe(1);
  });

  it('enforces the order status state machine at the database level', async () => {
    await expect(
      pool.query(
        `INSERT INTO orders (status, total_paise, expires_at)
         VALUES ('on_mars', 100, now() + interval '120 seconds')`,
      ),
    ).rejects.toThrow(/orders_status_check|violates check constraint/);

    // pending without paid_at is fine; paid without paid_at must fail.
    await expect(
      pool.query(
        `INSERT INTO orders (status, total_paise, expires_at)
         VALUES ('paid', 100, now() + interval '120 seconds')`,
      ),
    ).rejects.toThrow(/orders_paid_requires_paid_at/);
  });
});
