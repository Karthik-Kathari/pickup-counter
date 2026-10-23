/**
 * Signed webhook sender — acceptance criterion C14 (automated half).
 *
 * T-SEND-01/02 exercise the same `sendSignedEvent` function the
 * `npm run -w apps/api send-webhook -- …` CLI calls, against a real Express
 * app and a real PostgreSQL database (no mocks). The CLI's argument parsing
 * and its "prints the API's real response" behavior are proven by the
 * documented MANUAL step (a live run captured in README/verification notes).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import {
  createTestPool,
  resetTestDatabase,
  startTestServer,
  insertFixtureProduct,
} from './helpers/db.js';
import { sendSignedEvent } from '../src/webhook-sender.js';

const FIXTURE_SECRET = 'test-webhook-secret-12345678';

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

describe('send-webhook sender (C14)', () => {
  it("T-SEND-01: a correctly signed delivery returns the API's real response and marks the order paid", async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1500, stockQuantity: 5 });
    const order = await createOrder(baseUrl, product.id, 1);

    const result = await sendSignedEvent({
      baseUrl,
      secret: FIXTURE_SECRET,
      eventId: `evt-send-${order.id}`,
      orderId: order.id,
      amountPaise: order.totalPaise,
    });

    // The REAL response from the running API, passed straight through.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });

    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('paid');
    expect(after.paidAt).toBeTruthy();
  });

  it('T-SEND-02: a wrong --amount is acknowledged (2xx) and conservatively marks the order needs_review', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 900, stockQuantity: 5 });
    const order = await createOrder(baseUrl, product.id, 1);

    const result = await sendSignedEvent({
      baseUrl,
      secret: FIXTURE_SECRET,
      eventId: `evt-send-mismatch-${order.id}`,
      orderId: order.id,
      amountPaise: order.totalPaise - 100,
    });

    expect(result.status).toBe(200);
    const body = result.body as { error?: { code?: string } };
    expect(body.error?.code).toBe('AMOUNT_MISMATCH');

    const after = await getOrderStatus(baseUrl, order.id);
    expect(after.status).toBe('needs_review');
    expect(after.needsReviewReason).toBe('amount_mismatch');
  });
});
