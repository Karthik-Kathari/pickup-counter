import express from 'express';
import type { Pool } from 'pg';
import { errorHandler, notFoundHandler } from './errors.js';
import { createHealthRouter } from './routes/health.js';

export interface AppDeps {
  pool: Pool;
}

/**
 * Express application factory. Kept free of `process.env` reads and socket
 * binding so tests can build an app around an injected pool.
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter(deps.pool));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
