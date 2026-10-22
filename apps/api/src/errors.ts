import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * Typed HTTP error carrying a stable machine-readable code and optional
 * structured details (e.g. per-line insufficient-stock information).
 * The error envelope stays `{ error: { code, message, details? } }`.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

/**
 * Central error handler: one response shape for every failure,
 * `{ error: { code, message, details? } }`. Unexpected errors are logged
 * server-side and reported generically — no stack traces or internal details
 * to clients.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    const body: { error: { code: string; message: string; details?: unknown } } = {
      error: { code: err.code, message: err.message },
    };
    if (err.details !== undefined) {
      body.error.details = err.details;
    }
    res.status(err.status).json(body);
    return;
  }
  // Body-parser errors from express.json() arrive as SyntaxError-like objects.
  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  ) {
    res
      .status(400)
      .json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};
