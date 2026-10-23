import '../load-env.js';
import { ConfigError, loadConfig } from '../config.js';
import { MigrationError, MIGRATIONS_DIR, runMigrations } from './migrate.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[migrate] refusing to run: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const pool = createPool(config.databaseUrl, 1);
  try {
    const result = await runMigrations(pool, MIGRATIONS_DIR);
    if (result.applied.length === 0) {
      console.log(
        `[migrate] up to date (${result.alreadyApplied.length} migrations already applied)`,
      );
    } else {
      console.log(`[migrate] applied: ${result.applied.join(', ')}`);
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`[migrate] failed — ${error.message}`);
    } else {
      console.error('[migrate] failed with unexpected error:', error);
    }
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main();
