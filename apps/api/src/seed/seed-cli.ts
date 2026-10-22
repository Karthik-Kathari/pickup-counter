import 'dotenv/config';
import { ConfigError, loadConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { runSeed } from './seed.js';

/**
 * Seed CLI. Applies pending migrations first (migrations own the schema; the
 * seed assumes a migrated database and fails loudly if it is not one).
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[seed] refusing to run: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const pool = createPool(config.databaseUrl, 1);
  try {
    const migration = await runMigrations(pool);
    if (migration.applied.length > 0) {
      console.log(`[seed] applied pending migrations first: ${migration.applied.join(', ')}`);
    }

    const result = await runSeed(pool);
    console.log(
      `[seed] done — ${result.inserted} product(s) inserted, ${result.updated} refreshed ` +
        '(existing stock_quantity preserved)',
    );
    process.exit(0);
  } catch (error) {
    console.error('[seed] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main();
