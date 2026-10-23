/**
 * POST /payments/webhook — signed payment-event integration tests.
 *
 * These exercise the webhook middleware against a real PostgreSQL database
 * via a running Express app on an ephemeral port (no mocks, per AGENTS.md).
 * The shared secret used by tests/helpers/db.ts is 'test-webhook-secret-12345678'.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createTestPool,
  resetTestDatabase,
  startTestServer,
  insertFixtureProduct,
  activeHeldQuantity,
} from './helpers/db.js';
import { insertStaleFixtureProduct, insertStaleOrder } from './helpers/webhook.js';

const FIXTURE_SECRET = 'test-webhook-secret-12345678';

function sign(body: string, secret = FIXTURE_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

interface WebhookResponse {
  status: number;
  body: { error?: { code?: string; message?: string }; received?: boolean };
}

async function postWebhook(
  baseUrl: string,
  body: string,
  signature?: string | null,
): Promise<WebhookResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) {
    headers['x-signature'] = signature ?? sign(body);
  }
  const res = await fetch(`${baseUrl}/payments/webhook`, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as WebhookResponse['body'];
  return { status: res.status, body: json };
}

/** Create a pending order via the real API; returns id and total in paise. */
async function createOrder(
  baseUrl: string,
  productId: string,
  quantity = 1,
): Promise<{ id: string; totalPaise: number }> {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity }] }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { order: { id: string; totalPaise: number } };
  return { id: json.order.id, totalPaise: json.order.totalPaise };
}

async function getOrderStatus(baseUrl: string, orderId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/orders/${orderId}`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { order: Record<string, unknown> };
  return json.order;
}

async function countEvents(pool: Pool, eventId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM payment_events WHERE event_id = $1',
    [eventId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

let pool: Pool;
let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  pool = createTestPool();
  await resetTestDatabase(pool);
  const server = await startTestServer(pool);
  baseUrl = server.baseUrl;
  close = server.close;
});

afterAll(async () => {
  await close?.();
  await pool?.end();
});

describe('POST /payments/webhook — signature security', () => {
  it('T-WH-01: valid signed capture for a pending unexpired order marks it paid', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1500 });
    const order = await createOrder(baseUrl, product.id, 1);

    const body = JSON.stringify({
      eventId: 'evt-paid-1',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('paid');
    expect(after.paidAt).toBeTruthy();
  });

  it('T-WH-02: signature is verified over the exact raw bytes (mutated body rejected)', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const raw = JSON.stringify({
      eventId: 'evt-raw-1',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    // Sign `raw`, then send semantically-identical JSON with different
    // whitespace/byte layout — the HMAC must NOT match.
    const signature = sign(raw);
    const mutated = JSON.stringify(JSON.parse(raw), null, 2);
    const res = await postWebhook(baseUrl, mutated, signature);
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('SIGNATURE_INVALID');

    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('pending');
  });

  it('T-WH-03: missing signature is rejected (400), no state change', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-missing-sig',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body, null);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('MISSING_SIGNATURE');
    expect((await getOrderStatus(baseUrl, order.id)).status).toBe('pending');
  });

  it('T-WH-04: non-hex signature is rejected (400)', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-nonhex',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body, 'z'.repeat(64));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('SIGNATURE_INVALID');
  });

  it('T-WH-05: wrong-length signature is rejected (400)', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-badlen',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body, 'ab'.repeat(31));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('SIGNATURE_INVALID');
  });

  it('T-WH-06: signature signed with the wrong secret is rejected (401)', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-wrong-secret',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body, sign(body, 'not-the-real-secret'));
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('SIGNATURE_INVALID');
  });
});

describe('POST /payments/webhook — idempotency and duplicates', () => {
  it('T-IDEM-01: duplicate eventId is processed once (one row, one transition)', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 2500 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-dup-1',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });

    const first = await postWebhook(baseUrl, body);
    expect(first.status).toBe(200);
    const second = await postWebhook(baseUrl, body);
    expect(second.status).toBe(200);

    expect(await countEvents(pool, 'evt-dup-1')).toBe(1);
    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('paid');
    expect(after.paidAt).toBeTruthy();
  });

  it('T-IDEM-02: concurrent duplicate deliveries collapse to one processed event', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 3000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-conc-dup',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => postWebhook(baseUrl, body)));
    // Every delivery is acknowledged with 2xx (provider is never told to retry).
    for (const r of results) {
      expect(r.status).toBe(200);
    }
    expect(await countEvents(pool, 'evt-conc-dup')).toBe(1);

    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('paid');
  });

  it('T-IDEM-03: a replayed event never regresses picked_up back to paid', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1200, stockQuantity: 5 });
    const order = await createOrder(baseUrl, product.id, 1);
    const captureBody = JSON.stringify({
      eventId: 'evt-replay-pay',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    expect((await postWebhook(baseUrl, captureBody)).status).toBe(200);

    // Move to picked_up directly in the DB (pickup endpoint is Phase 5; we
    // simulate its terminal state to prove the webhook cannot regress it).
    await pool.query(`UPDATE orders SET status = 'picked_up', picked_up_at = now() WHERE id = $1`, [
      order.id,
    ]);

    // Replaying the SAME event id after processing is an idempotent no-op:
    // acknowledged 2xx, side effects never re-run, state unchanged (I7).
    const replay = await postWebhook(baseUrl, captureBody);
    expect(replay.status).toBe(200);
    expect(replay.body.received).toBe(true);
    expect((await getOrderStatus(baseUrl, order.id)).status).toBe('picked_up');

    // A NEW distinct event id targeting the already-advanced order must be a
    // no_transition and must NOT regress picked_up back to paid (I6/C13).
    const distinctBody = JSON.stringify({
      eventId: 'evt-replay-pay-2',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    const distinct = await postWebhook(baseUrl, distinctBody);
    expect(distinct.status).toBe(200);
    expect(distinct.body.error?.code).toBe('NO_TRANSITION');
    expect((await getOrderStatus(baseUrl, order.id)).status).toBe('picked_up');
  });
});

describe('POST /payments/webhook — amount, late, unknown, unsupported', () => {
  it('T-WH-07: amount mismatch marks order needs_review (amount_mismatch), never paid', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 5000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-mismatch',
      orderId: order.id,
      amountPaise: order.totalPaise - 100,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body);
    expect(res.status).toBe(200);
    expect(res.body.error?.code).toBe('AMOUNT_MISMATCH');

    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('needs_review');
    expect(after.needsReviewReason).toBe('amount_mismatch');
    expect(after.paidAt).toBeFalsy();
  });

  it('T-WH-08: valid capture after DB-clock expiry is needs_review (late_payment)', async () => {
    const product = await insertStaleFixtureProduct(pool, { pricePaise: 2000 });
    const orderId = '30000000-0000-4000-8000-000000000001';
    const { totalPaise } = await insertStaleOrder(pool, orderId, product.id, 1);

    const body = JSON.stringify({
      eventId: 'evt-late-1',
      orderId,
      amountPaise: totalPaise,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body);
    expect(res.status).toBe(200);
    expect(res.body.error?.code).toBe('LATE_PAYMENT');

    const after = await getOrderStatus(baseUrl, orderId);
    expect(after.status).toBe('needs_review');
    expect(after.needsReviewReason).toBe('late_payment');
    expect(after.paidAt).toBeFalsy();

    // Physical stock must be untouched by a late payment.
    const stock = await pool.query<{ stock_quantity: number }>(
      'SELECT stock_quantity FROM products WHERE id = $1',
      [product.id],
    );
    expect(stock.rows[0]?.stock_quantity).toBe(product.stockQuantity);
  });

  it('T-WH-09: unknown orderId is recorded, acknowledged 2xx, no state change', async () => {
    const body = JSON.stringify({
      eventId: 'evt-unknown-order',
      orderId: '00000000-0000-4000-8000-00000000dead',
      amountPaise: 1000,
      status: 'captured',
    });
    const res = await postWebhook(baseUrl, body);
    expect(res.status).toBe(200);
    expect(res.body.error?.code).toBe('ORDER_NOT_FOUND');

    expect(await countEvents(pool, 'evt-unknown-order')).toBe(1);
    const row = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM payment_events WHERE event_id = $1',
      ['evt-unknown-order'],
    );
    expect(row.rows[0]?.outcome).toBe('unknown_order');
  });

  it('T-WH-10: unsupported status is recorded, acknowledged 2xx, order unchanged', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1000 });
    const order = await createOrder(baseUrl, product.id, 1);
    const body = JSON.stringify({
      eventId: 'evt-unsupported',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'failed',
    });
    const res = await postWebhook(baseUrl, body);
    expect(res.status).toBe(200);
    expect(res.body.error?.code).toBe('IGNORED_PAYMENT_STATUS');

    expect((await getOrderStatus(baseUrl, order.id)).status).toBe('pending');
    const row = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM payment_events WHERE event_id = $1',
      ['evt-unsupported'],
    );
    expect(row.rows[0]?.outcome).toBe('ignored_status');
  });

  it('T-WH-11: a valid capture never changes physical stock (I5 — only pickup does)', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1500, stockQuantity: 7 });
    const order = await createOrder(baseUrl, product.id, 2);
    expect(await activeHeldQuantity(pool, product.id)).toBe(2);

    const body = JSON.stringify({
      eventId: 'evt-no-stock-change',
      orderId: order.id,
      amountPaise: order.totalPaise,
      status: 'captured',
    });
    expect((await postWebhook(baseUrl, body)).status).toBe(200);

    const stock = await pool.query<{ stock_quantity: number }>(
      'SELECT stock_quantity FROM products WHERE id = $1',
      [product.id],
    );
    expect(stock.rows[0]?.stock_quantity).toBe(7);
  });
});
