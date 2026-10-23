import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type express from 'express';
import { HttpError } from './errors.js';

interface WebhookPayload {
  eventId: string;
  orderId: string;
  amountPaise: number;
  status: string;
}

export type WebhookHandler = (payload: WebhookPayload, client: PoolClient) => Promise<void>;

interface WebhookDeps {
  pool: Pool;
  webhookSecret: string;
}

const HEX_ALPHABET = /^[0-9a-fA-F]{64}$/;

/**
 * Verify that `signature` is a 64-char hexadecimal HMAC-SHA256 over `body`
 * using `secret`, compared in constant time (I8). Format and length are
 * validated first so timingSafeEqual never receives mismatched lengths.
 * The signature is never logged or echoed.
 */
export function verifySignature(body: Buffer, signature: string, secret: string): void {
  if (typeof signature !== 'string' || !HEX_ALPHABET.test(signature)) {
    throw new HttpError(
      400,
      'SIGNATURE_INVALID',
      'X-Signature must be a 64-character hexadecimal HMAC-SHA256 digest',
    );
  }

  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature.toLowerCase(), 'utf8');

  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new HttpError(401, 'SIGNATURE_INVALID', 'X-Signature does not match the request body');
  }
}

/**
 * Parse the webhook JSON body without inventing extra fields or coercing types.
 * Nothing sensitive is echoed in error details.
 */
export function parseWebhookPayload(raw: unknown): WebhookPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'Request body must be a JSON object');
  }
  const object = raw as Record<string, unknown>;

  const eventId = object.eventId;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'eventId must be a non-empty string');
  }
  const orderId = object.orderId;
  if (typeof orderId !== 'string' || orderId.length === 0) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'orderId must be a non-empty string');
  }
  const amountPaise = object.amountPaise;
  if (typeof amountPaise !== 'number' || !Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'amountPaise must be a non-negative integer');
  }
  const status = object.status;
  if (typeof status !== 'string' || status.length === 0) {
    throw new HttpError(400, 'INVALID_PAYLOAD', 'status must be a non-empty string');
  }

  return { eventId, orderId, amountPaise, status };
}

const SUPPORTED_CAPTURE_STATUSES = new Set(['captured']);

/**
 * Process a validated webhook delivery inside ONE PostgreSQL transaction on
 * the provided dedicated client (never the shared pool), so every lock and
 * write is scoped to a single session (I7/I9).
 *
 * Ordering inside the transaction:
 *   1. INSERT the event first; the event_id PRIMARY KEY is the idempotency
 *      boundary (I7). ON CONFLICT DO NOTHING keeps the first writer's payload.
 *   2. Read the row back. A row that already has processed_at is a replay:
 *      acknowledge (2xx) without re-running side effects.
 *   3. Otherwise compute the outcome from the CURRENT order state and commit
 *      the event's outcome together with the order transition, so the two can
 *      never disagree.
 *
 * Outcomes, per the documented state policy (I6/I9):
 *   unknown_order   — order_id does not resolve; recorded, 2xx, no state change
 *   ignored_status  — provider status is not a supported capture; recorded, 2xx
 *   no_transition   — order already paid/picked_up/expired; never regress (I6)
 *   amount_mismatch — amount != total; needs_review('amount_mismatch'), 2xx
 *   late_payment    — valid capture after DB-clock expiry; needs_review, 2xx
 *   paid            — pending + unexpired + amount match; paid + paid_at, 2xx
 *
 * Any throw rolls the whole transaction back, so a failed event leaves no
 * partial state and is safe to re-deliver (the PK makes replay harmless).
 */
export async function processWebhook(payload: WebhookPayload, client: PoolClient): Promise<void> {
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO payment_events (event_id, order_id, amount_paise, status, raw_payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      payload.eventId,
      payload.orderId,
      payload.amountPaise,
      payload.status,
      JSON.stringify(payload),
    ],
  );

  const eventRow = await client.query<{
    outcome: string | null;
    processed_at: Date | null;
    order_id: string | null;
  }>('SELECT outcome, processed_at, order_id FROM payment_events WHERE event_id = $1', [
    payload.eventId,
  ]);
  const event = eventRow.rows[0];
  if (!event) {
    await client.query('ROLLBACK');
    throw new Error('payment_events row missing after insert');
  }

  // Duplicate delivery: acknowledge without re-executing side effects (I7).
  if (event.processed_at !== null) {
    await client.query('COMMIT');
    return;
  }

  // Unknown order: record the outcome and acknowledge; do not create one (I9).
  if (event.order_id === null) {
    await client.query(
      `UPDATE payment_events SET outcome = 'unknown_order', processed_at = now() WHERE event_id = $1`,
      [payload.eventId],
    );
    await client.query('COMMIT');
    throw new HttpError(
      200,
      'ORDER_NOT_FOUND',
      'No order exists for the supplied orderId; the event was recorded as unknown_order',
    );
  }

  // Unsupported provider statuses are recorded and ignored (I9).
  if (!SUPPORTED_CAPTURE_STATUSES.has(payload.status)) {
    await client.query(
      `UPDATE payment_events SET outcome = 'ignored_status', processed_at = now() WHERE event_id = $1`,
      [payload.eventId],
    );
    await client.query('COMMIT');
    throw new HttpError(
      200,
      'IGNORED_PAYMENT_STATUS',
      `Payment status "${payload.status}" is not a supported capture; order unchanged`,
    );
  }

  // Lock the order row and read its current state in the same transaction so
  // the outcome and the transition are computed from one consistent snapshot.
  const orderRow = await client.query<{
    id: string;
    status: string;
    total_paise: string;
    is_expired: boolean;
  }>(
    `SELECT id, status, total_paise, (expires_at <= now()) AS is_expired
       FROM orders
      WHERE id = $1
      FOR UPDATE`,
    [payload.orderId],
  );
  const order = orderRow.rows[0];
  if (!order) {
    await client.query(
      `UPDATE payment_events SET outcome = 'unknown_order', processed_at = now() WHERE event_id = $1`,
      [payload.eventId],
    );
    await client.query('COMMIT');
    throw new HttpError(
      200,
      'ORDER_NOT_FOUND',
      'No order exists for the supplied orderId; the event was recorded as unknown_order',
    );
  }

  const storedAmount = BigInt(order.total_paise);
  const receivedAmount = BigInt(payload.amountPaise);

  // Terminal / already-settled states must never regress (I6). paid and
  // picked_up are settled; expired is terminal for automation.
  if (order.status !== 'pending') {
    await client.query(
      `UPDATE payment_events SET outcome = 'no_transition', processed_at = now() WHERE event_id = $1`,
      [payload.eventId],
    );
    await client.query('COMMIT');
    throw new HttpError(
      200,
      'NO_TRANSITION',
      `Order is already in state "${order.status}"; no payment transition applied`,
    );
  }

  // Amount mismatch: record the outcome and move the order to needs_review
  // without fulfilling it or touching physical inventory (I9).
  if (receivedAmount !== storedAmount) {
    await client.query(
      `UPDATE payment_events SET outcome = 'amount_mismatch', processed_at = now() WHERE event_id = $1`,
      [payload.eventId],
    );
    await client.query(
      `UPDATE orders
          SET status = 'needs_review',
              needs_review_reason = 'amount_mismatch'
        WHERE id = $1
          AND status = 'pending'`,
      [payload.orderId],
    );
    await client.query('COMMIT');
    throw new HttpError(
      200,
      'AMOUNT_MISMATCH',
      `Received ${payload.amountPaise} paise but the order total is ${order.total_paise} paise; order marked needs_review`,
    );
  }

  // Amount matches. A capture that arrives after the hold already expired (per
  // the DATABASE clock, never a Node clock — I2) takes the conservative
  // late-payment path: needs_review, never auto-fulfilled, never restocked (I9).
  if (order.is_expired) {
    await client.query(
      `UPDATE payment_events SET outcome = 'late_payment', processed_at = now() WHERE event_id = $1`,
      [payload.eventId],
    );
    await client.query(
      `UPDATE orders
          SET status = 'needs_review',
              needs_review_reason = 'late_payment'
        WHERE id = $1
          AND status = 'pending'`,
      [payload.orderId],
    );
    await client.query('COMMIT');
    throw new HttpError(
      200,
      'LATE_PAYMENT',
      `Late payment for order ${payload.orderId}: hold already expired; order marked needs_review`,
    );
  }

  // Eligible: pending + unexpired + exact amount => paid (I6/C8).
  await client.query(
    `UPDATE payment_events SET outcome = 'paid', processed_at = now() WHERE event_id = $1`,
    [payload.eventId],
  );
  const updated = await client.query(
    `UPDATE orders
        SET status = 'paid',
            paid_at = now()
      WHERE id = $1
        AND status = 'pending'
        AND expires_at > now()`,
    [payload.orderId],
  );
  await client.query('COMMIT');

  if ((updated.rowCount ?? 0) === 0) {
    throw new HttpError(
      200,
      'NO_TRANSITION',
      'Order was no longer payable at commit time; no payment transition applied',
    );
  }
}

/**
 * Express middleware: verify the HMAC-SHA256 over the RAW request body (I8),
 * parse the JSON payload, run the handler on a dedicated pool client, then
 * release it. Raw bytes come from req.body, populated by express.raw() which
 * is mounted before express.json() in app.ts.
 */
export function createWebhookMiddleware(
  deps: WebhookDeps,
  handler: WebhookHandler,
): express.RequestHandler {
  return (req, res, next) => {
    void res;
    (async () => {
      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new HttpError(400, 'MISSING_BODY', 'Request body is required');
      }

      const signatureHeader = req.headers['x-signature'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (signature === undefined) {
        throw new HttpError(400, 'MISSING_SIGNATURE', 'X-Signature header is required');
      }

      verifySignature(rawBody, signature, deps.webhookSecret);
      const payload = parseWebhookPayload(JSON.parse(rawBody.toString('utf8')));

      const client = await deps.pool.connect();
      try {
        await handler(payload, client);
      } finally {
        client.release();
      }
    })().then(
      () => next(),
      (error: unknown) => next(error),
    );
  };
}
