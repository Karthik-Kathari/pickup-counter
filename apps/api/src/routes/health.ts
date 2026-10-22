import { Router } from 'express';
import type { Pool } from 'pg';
import { pingDatabase } from '../db/pool.js';

/**
 * GET /health — verifies actual database connectivity.
 *
 * 200 when a trivial query succeeds, 503 when it does not. The failure
 * response is intentionally generic: it must not leak connection strings,
 * credentials, or driver errors.
 */
export function createHealthRouter(pool: Pool): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const databaseUp = await pingDatabase(pool);
    if (databaseUp) {
      res.status(200).json({ status: 'ok', database: 'connected' });
      return;
    }
    res.status(503).json({
      status: 'unavailable',
      error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is not reachable' },
    });
  });

  return router;
}
