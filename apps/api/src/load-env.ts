import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

/**
 * Load `.env` for the CLI/server entry points (replaces `import 'dotenv/config'`).
 *
 * npm runs workspace scripts with `cwd` = the workspace package directory
 * (e.g. `apps/api`), so dotenv's default cwd lookup misses the
 * repository-root `.env` that the README documents (`cp .env.example .env`
 * at the repository root). `INIT_CWD` is the directory npm was invoked from,
 * so that `.env` is loaded first (it wins on shared keys), then the cwd one
 * as a fallback. dotenv never overrides variables already present in the
 * environment, so real env vars and production configuration always take
 * precedence over the file.
 *
 * Found by the clean-clone audit (G3): without this, `npm run migrate` from
 * a fresh clone silently used the built-in dev defaults (port 5432) and
 * failed on any machine whose PostgreSQL is not exactly at those defaults.
 */
const initCwd = process.env.INIT_CWD;
if (initCwd !== undefined) {
  const rootEnv = path.join(initCwd, '.env');
  if (existsSync(rootEnv)) {
    config({ path: rootEnv });
  }
}
config();
