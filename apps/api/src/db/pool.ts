import { Pool } from 'pg';

/**
 * Application PostgreSQL pool.
 *
 * Kept deliberately small and explicit: transactions in later phases borrow a
 * dedicated client via `pool.connect()` so locks (SELECT ... FOR UPDATE,
 * advisory locks) live for exactly one transaction/session.
 */
export function createPool(databaseUrl: string, maxConnections = 10): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** True when the database answers a trivial query within `timeoutMs`. */
export async function pingDatabase(pool: Pool, timeoutMs = 2_500): Promise<boolean> {
  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  const query = pool.query('SELECT 1').then(() => 'ok' as const);
  try {
    const result = await Promise.race([query, timeout]);
    return result === 'ok';
  } catch {
    return false;
  }
}
