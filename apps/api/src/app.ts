import express from 'express';
import type { Pool } from 'pg';
import { errorHandler, notFoundHandler } from './errors.js';
import { createHealthRouter } from './routes/health.js';
import { createOrdersRouter } from './routes/orders.js';
import { createProductsRouter } from './routes/products.js';
import { createWebhookMiddleware, processWebhook } from './webhook.js';

export interface AppDeps {
  pool: Pool;
  holdTtlSeconds: number;
  webhookSecret: string;
}

/**
 * Express application factory. Kept free of `process.env` reads and socket
 * binding so tests can build an app around an injected pool.
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.disable('x-powered-by');

  // HMAC verification (I8) requires the signature to be computed over the
  // EXACT raw bytes the provider sent. express.raw() is therefore mounted for
  // the webhook path BEFORE the global express.json() parser; once raw has
  // consumed the stream, express.json() leaves the Buffer untouched, so the
  // webhook middleware receives the original bytes in req.body.
  app.use('/payments/webhook', express.raw({ type: 'application/json', limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter(deps.pool));
  app.use(createProductsRouter(deps.pool));
  app.use(createOrdersRouter(deps.pool, deps.holdTtlSeconds));

  app.use('/payments/webhook', createWebhookMiddleware(deps, processWebhook), (_req, res) => {
    res.json({ received: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
