import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API paths to the backend so the browser always talks
// to a same-origin URL — no CORS needed in development. The proxy target is
// VITE_API_BASE_URL (see .env.example at the repository root); the API path
// names match the assignment's endpoints exactly (no /api prefix).
const API_PATHS = ['/health', '/products', '/orders', '/payments'];

// npm workspace scripts run with cwd = apps/web, so loading env only from
// process.cwd() would miss the repository-root `.env` that the README
// documents. Root values win; the cwd env is a lower-priority fallback.
// (Clean-clone audit, G3 — same defect class as the API's dotenv lookup.)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...loadEnv(mode, repoRoot, '') };
  const apiTarget = env.VITE_API_BASE_URL || 'http://localhost:3001';

  const proxy = Object.fromEntries(
    API_PATHS.map((path) => [path, { target: apiTarget, changeOrigin: true }]),
  );

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy,
    },
  };
});
