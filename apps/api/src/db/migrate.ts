import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Minimal, explicit SQL migration runner.
 *
 * Behavior:
 * - Files live in `apps/api/migrations` and MUST be named `NNNN_snake_case.sql`.
 *   They are applied in ascending filename order (deterministic).
 * - A session-level PostgreSQL advisory lock serializes concurrent runners:
 *   a second runner blocks until the first finishes, then sees the recorded
 *   migrations and applies nothing. (The lock is per-database and released
 *   when the connection is released or closed.)
 * - Each migration runs inside its own transaction together with the
 *   history-record INSERT, so a failing migration leaves no partial state.
 * - Applied migrations are recorded in `schema_migrations` with a SHA-256
 *   checksum; editing an already-applied file is detected and rejected.
 *
 * Documented limitations (also in README):
 * - Migrations must be append-only. There is no auto-generated diffing; write
 *   a new file for every change. Down/rollback migrations are intentionally
 *   out of scope for this assignment.
 * - Because each file is applied in one transaction, a single file cannot
 *   contain statements that PostgreSQL forbids inside transactions
 *   (e.g. CREATE INDEX CONCURRENTLY). Keep migration files transactional.
 * - The advisory lock key is a fixed constant; two unrelated projects sharing
 *   one database would contend on it (harmless, just serialized).
 */

export const MIGRATIONS_ADVISORY_LOCK_KEY = 412_975_301;
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  fileName: string;
  sql: string;
  checksum: string;
}

export interface MigrationRunResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  const seenVersions = new Set<string>();

  for (const fileName of sqlFiles) {
    const match = FILE_PATTERN.exec(fileName);
    if (!match || match[1] === undefined) {
      throw new MigrationError(
        `Invalid migration file name "${fileName}" — expected NNNN_snake_case.sql`,
      );
    }
    const version = match[1];
    if (seenVersions.has(version)) {
      throw new MigrationError(`Duplicate migration version "${version}" (${fileName})`);
    }
    seenVersions.add(version);
    const sql = await readFile(new URL(fileName, `file://${dir.replace(/\\/g, '/')}/`), 'utf8');
    migrations.push({ version, fileName, sql, checksum: sha256(sql) });
  }

  return migrations;
}

export async function runMigrations(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationRunResult> {
  const migrations = await loadMigrations(dir);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const historyResult = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const history = new Map(historyResult.rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const recordedChecksum = history.get(migration.version);
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksum) {
          throw new MigrationError(
            `Migration ${migration.fileName} was modified after being applied ` +
              `(recorded checksum ${recordedChecksum.slice(0, 12)}…, file checksum ` +
              `${migration.checksum.slice(0, 12)}…). Migrations are append-only: ` +
              'revert the edit or add a new migration file.',
          );
        }
        alreadyApplied.push(migration.version);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.fileName, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`Migration ${migration.fileName} failed: ${detail}`, {
          cause: error,
        });
      }
      applied.push(migration.version);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }

  return { applied, alreadyApplied };
}
