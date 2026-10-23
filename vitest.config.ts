import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Load the repository-root .env before any test worker starts, so that
// TEST_DATABASE_URL and DATABASE_URL are in process.env.  Without this,
// vitest workers never see the .env file and integration tests fail with
// "TEST_DATABASE_URL must be set".  dotenv never overrides variables that
// are already present in the environment, so real env vars take precedence.
const rootEnv = path.resolve(import.meta.dirname, '.env');
if (existsSync(rootEnv)) {
  loadDotenv({ path: rootEnv });
}

export default defineConfig({
  test: {
    include: ['apps/**/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration test files share ONE test database and reset its schema in
    // beforeAll, so files must not run in parallel (they would drop the
    // schema under each other). Tests within a file already run sequentially.
    fileParallelism: false,
  },
});
