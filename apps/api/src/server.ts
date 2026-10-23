import './load-env.js';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const SHUTDOWN_GRACE_MS = 10_000;

function bootstrap(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[api] refusing to start: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const pool = createPool(config.databaseUrl);
  const app = createApp({
    pool,
    holdTtlSeconds: config.holdTtlSeconds,
    webhookSecret: config.webhookSecret,
  });

  const server: Server = app.listen(config.apiPort, () => {
    console.log(`[api] listening on port ${config.apiPort} (${config.nodeEnv})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[api] received ${signal}, shutting down (grace ${SHUTDOWN_GRACE_MS}ms)`);

    const forceExit = setTimeout(() => {
      console.error('[api] shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close((serverError) => {
      if (serverError) {
        console.error('[api] error while closing HTTP server:', serverError);
      }
      pool
        .end()
        .then(() => {
          console.log('[api] shutdown complete');
          process.exit(0);
        })
        .catch((poolError: unknown) => {
          console.error('[api] error while closing database pool:', poolError);
          process.exit(1);
        });
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap();
