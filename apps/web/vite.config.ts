import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API paths to the backend so the browser always talks
// to a same-origin URL — no CORS needed in development. The proxy target is
// VITE_API_BASE_URL (see .env.example); the API path names match the
// assignment's endpoints exactly (no /api prefix).
const API_PATHS = ['/health', '/products', '/orders', '/payments'];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
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
