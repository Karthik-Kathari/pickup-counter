import { defineConfig } from 'vitest/config';

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
