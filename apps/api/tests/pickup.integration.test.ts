/**
 * POST /orders/:id/pickup-claim — atomic pickup-claim integration tests.
 *
 * Everything runs against a REAL PostgreSQL database through a running
 * Express app on an ephemeral port (no mocks, per AGENTS.md §6). The webhook
 * secret is the shared fixture from tests/helpers/db.ts:
 * 'test-webhook-secret-12345678'.
 *
 * Covered acceptance criteria: D1 (T-PICK-01), D2 (T-CONC-02 — mandatory
 * scenario 3), D3/D5 (T-PICK-02), D4 (T-PICK-03), plus T-PICK-04/05 (limited
 * stock across different orders never goes negative) and T-PICK-06 (a
 * mid-transaction database failure rolls back both the status flip and the
 * inventory change).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createTestPool,
  resetTestDatabase,
  startTestServer,
  insertFixtureProduct,
} from './helpers/db.js';
import { insertStaleOrder } from './helpers/webhook.js';

const FIXTURE_SECRET = 'test-webhook-secret-12345678';

interface OrderShape {
  id: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  expiresAt: string;
  expiresInSeconds?: number;
  paidAt?: string;
  pickedUpAt?: string;
  needsReviewReason?: string;
  items: Array<{
    productId: string;
    name: string;
    quantity: number;
    unitPricePaise: number;
    lineTotalPaise: number;
  }>;
}

interface ApiResponse {
  status: number;
  body: {
    error?: { code?: string; message?: string; details?: unknown };
    order?: OrderShape;
    received?: boolean;
  };
}

function sign(body: string): string {
  return createHmac('sha256', FIXTURE_SECRET).update(body).digest('hex');
}

/** Create a pending order through the real API (expect 201). */
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

/**
 * Deliver a correctly signed capture for an order. Returns the full response
 * so callers can assert the acknowledged error envelope on mismatches (2xx).
 */
async function sendCapture(
  baseUrl: string,
  orderId: string,
  amountPaise: number,
): Promise<ApiResponse> {
  const body = JSON.stringify({
    eventId: `evt-pickup-${randomUUID()}`,
    orderId,
    amountPaise,
    status: 'captured',
  });
  const res = await fetch(`${baseUrl}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sign(body) },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as ApiResponse['body'];
  return { status: res.status, body: json };
}

/** Pay an order successfully (helper for scenarios that need `paid`). */
async function payOrder(baseUrl: string, orderId: string, amountPaise: number): Promise<void> {
  const res = await sendCapture(baseUrl, orderId, amountPaise);
  expect(res.status).toBe(200);
}

/** POST /orders/:id/pickup-claim with no body. */
async function claim(baseUrl: string, orderId: string): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/orders/${orderId}/pickup-claim`, { method: 'POST' });
  const json = (await res.json().catch(() => ({}))) as ApiResponse['body'];
  return { status: res.status, body: json };
}

async function getOrderStatus(baseUrl: string, orderId: string): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/orders/${orderId}`);
  const json = (await res.json().catch(() => ({}))) as ApiResponse['body'];
  return { status: res.status, body: json };
}

/** Physical stock straight from SQL — the only trusted inventory truth. */
async function stockOf(pool: Pool, productId: string): Promise<number> {
  const result = await pool.query<{ stock_quantity: number }>(
    'SELECT stock_quantity FROM products WHERE id = $1',
    [productId],
  );
  expect(result.rows.length).toBe(1);
  return result.rows[0]!.stock_quantity;
}

/** Persisted order row — verifies state transitions independently of HTTP. */
async function orderRow(
  pool: Pool,
  orderId: string,
): Promise<{
  status: string;
  paid_at: Date | null;
  picked_up_at: Date | null;
  needs_review_reason: string | null;
}> {
  const result = await pool.query<{
    status: string;
    paid_at: Date | null;
    picked_up_at: Date | null;
    needs_review_reason: string | null;
  }>('SELECT status, paid_at, picked_up_at, needs_review_reason FROM orders WHERE id = $1', [
    orderId,
  ]);
  expect(result.rows.length).toBe(1);
  return result.rows[0]!;
}

let pool: Pool;
let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  pool = createTestPool(25);
  await resetTestDatabase(pool);
  const server = await startTestServer(pool);
  baseUrl = server.baseUrl;
  close = server.close;
});

afterAll(async () => {
  await close?.();
  await pool?.end();
});

describe('POST /orders/:id/pickup-claim — claim semantics (D1, D3, D4, D5)', () => {
  it('T-PICK-01: claims a paid order exactly once — picked_up, DB-clock pickedUpAt, stock deducted once', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1500, stockQuantity: 5 });
    const order = await createOrder(baseUrl, product.id, 2);
    expect(order.totalPaise).toBe(3000);

    // Neither reservation nor payment ever touches physical stock (I5).
    expect(await stockOf(pool, product.id)).toBe(5);
    await payOrder(baseUrl, order.id, order.totalPaise);
    expect(await stockOf(pool, product.id)).toBe(5);

    const res = await claim(baseUrl, order.id);
    expect(res.status).toBe(200);
    const claimed = res.body.order!;
    expect(claimed.status).toBe('picked_up');
    expect(claimed.paidAt).toBeTruthy();
    expect(claimed.pickedUpAt).toBeTruthy();
    // picked_up is terminal: no countdown field on a claimed order.
    expect(claimed.expiresInSeconds).toBeUndefined();
    // DB-clock ISO timestamp that is parseable.
    expect(Number.isNaN(Date.parse(claimed.pickedUpAt!))).toBe(false);
    expect(claimed.items).toHaveLength(1);
    expect(claimed.items[0]!.quantity).toBe(2);

    // Exactly-once deduction: 5 − 2 = 3, nothing more.
    expect(await stockOf(pool, product.id)).toBe(3);

    // The status endpoint agrees with the claim response.
    const observed = await getOrderStatus(baseUrl, order.id);
    expect(observed.status).toBe(200);
    expect(observed.body.order!.status).toBe('picked_up');
    expect(observed.body.order!.pickedUpAt).toBe(claimed.pickedUpAt);

    // Persisted row carries the coherence-checked state (I6).
    const row = await orderRow(pool, order.id);
    expect(row.status).toBe('picked_up');
    expect(row.paid_at).not.toBeNull();
    expect(row.picked_up_at).not.toBeNull();
  });

  it('T-PICK-03: a multi-product claim deducts every line exactly once and leaves order_lines immutable', async () => {
    const a = await insertFixtureProduct(pool, { pricePaise: 1000, stockQuantity: 4 });
    const b = await insertFixtureProduct(pool, { pricePaise: 2500, stockQuantity: 3 });

    const res0 = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { productId: a.id, quantity: 2 },
          { productId: b.id, quantity: 1 },
        ],
      }),
    });
    expect(res0.status).toBe(201);
    const created = (await res0.json()) as { order: { id: string; totalPaise: number } };
    const multi = { id: created.order.id, totalPaise: created.order.totalPaise };
    expect(multi.totalPaise).toBe(2 * 1000 + 1 * 2500);

    await payOrder(baseUrl, multi.id, multi.totalPaise);
    expect(await stockOf(pool, a.id)).toBe(4);
    expect(await stockOf(pool, b.id)).toBe(3);

    const res = await claim(baseUrl, multi.id);
    expect(res.status).toBe(200);
    expect(res.body.order!.status).toBe('picked_up');

    // Permanent deduction of each line's quantity, exactly once.
    expect(await stockOf(pool, a.id)).toBe(2);
    expect(await stockOf(pool, b.id)).toBe(2);

    // order_lines are immutable historical records after the claim.
    const lines = await pool.query<{
      product_id: string;
      quantity: number;
      unit_price_paise: string;
    }>(
      'SELECT product_id, quantity, unit_price_paise FROM order_lines WHERE order_id = $1 ORDER BY product_id',
      [multi.id],
    );
    expect(lines.rows).toHaveLength(2);
    const byId = new Map(lines.rows.map((row) => [row.product_id, row]));
    expect(byId.get(a.id)?.quantity).toBe(2);
    expect(Number(byId.get(a.id)?.unit_price_paise)).toBe(1000);
    expect(byId.get(b.id)?.quantity).toBe(1);
    expect(Number(byId.get(b.id)?.unit_price_paise)).toBe(2500);
  });

  it('T-PICK-02: ineligible states (pending, needs_review, expired, unknown, invalid id) are rejected deterministically with no state change', async () => {
    // (a) fresh unpaid pending order → 409 ORDER_NOT_PAID, nothing changes.
    const pendingProduct = await insertFixtureProduct(pool, { pricePaise: 700, stockQuantity: 4 });
    const pendingOrder = await createOrder(baseUrl, pendingProduct.id, 1);
    const pendingRes = await claim(baseUrl, pendingOrder.id);
    expect(pendingRes.status).toBe(409);
    expect(pendingRes.body.error?.code).toBe('ORDER_NOT_PAID');
    expect(await stockOf(pool, pendingProduct.id)).toBe(4);
    let row = await orderRow(pool, pendingOrder.id);
    expect(row.status).toBe('pending');
    expect(row.picked_up_at).toBeNull();

    // (b) needs_review (amount mismatch) → 409 ORDER_NOT_PAID, reason intact.
    await payOrder(baseUrl, pendingOrder.id, pendingOrder.totalPaise - 1);
    row = await orderRow(pool, pendingOrder.id);
    expect(row.status).toBe('needs_review');
    expect(row.needs_review_reason).toBe('amount_mismatch');
    expect(await stockOf(pool, pendingProduct.id)).toBe(4);
    const reviewRes = await claim(baseUrl, pendingOrder.id);
    expect(reviewRes.status).toBe(409);
    expect(reviewRes.body.error?.code).toBe('ORDER_NOT_PAID');
    row = await orderRow(pool, pendingOrder.id);
    expect(row.status).toBe('needs_review');
    expect(row.picked_up_at).toBeNull();
    expect(await stockOf(pool, pendingProduct.id)).toBe(4);

    // (c) expired hold → 409 ORDER_EXPIRED, decided from the DB-clock
    // deadline. The rejected claim writes NOTHING (rollback), so the stale
    // row is still `pending` here — materialization stays with the two
    // established observation points; a GET immediately flips it.
    const staleProduct = await insertFixtureProduct(pool, { pricePaise: 900, stockQuantity: 6 });
    const staleOrderId = randomUUID();
    await insertStaleOrder(pool, staleOrderId, staleProduct.id, 1);
    const expiredRes = await claim(baseUrl, staleOrderId);
    expect(expiredRes.status).toBe(409);
    expect(expiredRes.body.error?.code).toBe('ORDER_EXPIRED');
    row = await orderRow(pool, staleOrderId);
    expect(row.status).toBe('pending');
    expect(row.picked_up_at).toBeNull();
    expect(await stockOf(pool, staleProduct.id)).toBe(6);
    const observed = await getOrderStatus(baseUrl, staleOrderId);
    expect(observed.status).toBe(200);
    expect(observed.body.order!.status).toBe('expired');
    expect(await stockOf(pool, staleProduct.id)).toBe(6);

    // (d) unknown order → 404 ORDER_NOT_FOUND; non-UUID → 400 VALIDATION_ERROR
    // with details[].path = "id".
    const unknownRes = await claim(baseUrl, randomUUID());
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.body.error?.code).toBe('ORDER_NOT_FOUND');

    const invalidRes = await claim(baseUrl, 'not-a-uuid');
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.error?.code).toBe('VALIDATION_ERROR');
    const details = invalidRes.body.error?.details as Array<{ path: string }>;
    expect(details[0]?.path).toBe('id');
  });

  it('T-PICK-02: a repeated claim returns 409 ORDER_ALREADY_CLAIMED and never deducts stock again', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1200, stockQuantity: 3 });
    const order = await createOrder(baseUrl, product.id, 1);
    await payOrder(baseUrl, order.id, order.totalPaise);

    const first = await claim(baseUrl, order.id);
    expect(first.status).toBe(200);
    expect(await stockOf(pool, product.id)).toBe(2);

    // Second and third claims: deterministic 409, stock untouched (D5).
    const second = await claim(baseUrl, order.id);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('ORDER_ALREADY_CLAIMED');
    expect(await stockOf(pool, product.id)).toBe(2);

    const third = await claim(baseUrl, order.id);
    expect(third.status).toBe(409);
    expect(third.body.error?.code).toBe('ORDER_ALREADY_CLAIMED');
    expect(await stockOf(pool, product.id)).toBe(2);

    const row = await orderRow(pool, order.id);
    expect(row.status).toBe('picked_up');
    // Exactly one transition to picked_up: picked_up_at is a single timestamp.
    expect(row.picked_up_at).not.toBeNull();
  });
});

describe('Test — concurrent pickup claims (T-CONC-02, mandatory scenario 3)', () => {
  it('two simultaneous claims yield exactly one 200 and one 409; stock decremented exactly once — 10 rounds', async () => {
    for (let round = 1; round <= 10; round += 1) {
      const product = await insertFixtureProduct(pool, { pricePaise: 800, stockQuantity: 5 });
      const order = await createOrder(baseUrl, product.id, 1);
      await payOrder(baseUrl, order.id, order.totalPaise);
      expect(await stockOf(pool, product.id)).toBe(5);

      // Genuinely simultaneous requests (Promise.all), same paid order.
      const [a, b] = await Promise.all([claim(baseUrl, order.id), claim(baseUrl, order.id)]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 409]);

      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      expect(winner.body.order!.status).toBe('picked_up');
      expect(winner.body.order!.pickedUpAt).toBeTruthy();
      expect(loser.body.error?.code).toBe('ORDER_ALREADY_CLAIMED');

      // Exactly-once deduction: 5 − 1 = 4, never −1/−2.
      expect(await stockOf(pool, product.id)).toBe(4);

      const row = await orderRow(pool, order.id);
      expect(row.status).toBe('picked_up');
      expect(row.picked_up_at).not.toBeNull();
    }
  });
});

describe('Test — limited stock across different orders (T-PICK-04, T-PICK-05)', () => {
  it('T-PICK-04: two different paid orders claiming the last units concurrently both succeed; stock ends at 0, never negative', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 500, stockQuantity: 2 });
    const orderA = await createOrder(baseUrl, product.id, 1);
    const orderB = await createOrder(baseUrl, product.id, 1);
    await payOrder(baseUrl, orderA.id, orderA.totalPaise);
    await payOrder(baseUrl, orderB.id, orderB.totalPaise);
    expect(await stockOf(pool, product.id)).toBe(2);

    const [claimA, claimB] = await Promise.all([
      claim(baseUrl, orderA.id),
      claim(baseUrl, orderB.id),
    ]);
    expect([claimA.status, claimB.status].sort((x, y) => x - y)).toEqual([200, 200]);
    expect(claimA.body.order!.status).toBe('picked_up');
    expect(claimB.body.order!.status).toBe('picked_up');

    // Both claims accounted for; the invariant is stock >= 0 at every step.
    const stock = await stockOf(pool, product.id);
    expect(stock).toBe(0);
    expect(stock).toBeGreaterThanOrEqual(0);
  });

  it('T-PICK-05: over-committed paid orders are rejected deterministically; stock never goes negative', async () => {
    // The I4 availability formula excludes already-`paid` orders, so a second
    // order can cover units a paid order is still waiting to pick up. The
    // claim must answer that with a deterministic conflict, not a negative
    // stock row or a 500.
    const product = await insertFixtureProduct(pool, { pricePaise: 2000, stockQuantity: 2 });
    const orderA = await createOrder(baseUrl, product.id, 2);
    await payOrder(baseUrl, orderA.id, orderA.totalPaise);
    // Availability is full again (A is paid, not pending): B can be created.
    const orderB = await createOrder(baseUrl, product.id, 2);
    await payOrder(baseUrl, orderB.id, orderB.totalPaise);

    // First claim consumes the physical stock.
    const first = await claim(baseUrl, orderA.id);
    expect(first.status).toBe(200);
    expect(await stockOf(pool, product.id)).toBe(0);

    // Second claim: 409 INSUFFICIENT_STOCK with per-line details, no writes.
    const second = await claim(baseUrl, orderB.id);
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('INSUFFICIENT_STOCK');
    const details = second.body.error?.details as {
      shortages: Array<{ productId: string; required: number; available: number }>;
    };
    expect(details.shortages).toEqual([{ productId: product.id, required: 2, available: 0 }]);

    // Nothing changed for the loser: still paid, no pickup, stock not negative.
    const stock = await stockOf(pool, product.id);
    expect(stock).toBe(0);
    expect(stock).toBeGreaterThanOrEqual(0);
    const loserRow = await orderRow(pool, orderB.id);
    expect(loserRow.status).toBe('paid');
    expect(loserRow.picked_up_at).toBeNull();
    // The winner's claim still holds.
    const winnerRow = await orderRow(pool, orderA.id);
    expect(winnerRow.status).toBe('picked_up');
  });
});

describe('Test — transaction atomicity under database failure (T-PICK-06)', () => {
  it('a failure after the status flip rolls back BOTH the flip and the inventory change; a retry then succeeds exactly once', async () => {
    const product = await insertFixtureProduct(pool, { pricePaise: 1100, stockQuantity: 4 });
    const order = await createOrder(baseUrl, product.id, 1);
    await payOrder(baseUrl, order.id, order.totalPaise);
    expect(await stockOf(pool, product.id)).toBe(4);

    // Fault injection: a real PostgreSQL error raised by a trigger DURING the
    // decrement UPDATE — i.e. after the paid → picked_up flip already ran in
    // the same transaction. This is a genuine mid-transaction DB failure, not
    // an application-level shortcut. The trigger is scoped to this fixture's
    // product id (test-generated UUID literal; DDL cannot be parameterized).
    await pool.query(
      `CREATE OR REPLACE FUNCTION pickup_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'pickup_test_fail injected'; END;
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER pickup_test_fail_trigger BEFORE UPDATE ON products
         FOR EACH ROW WHEN (OLD.id = '${product.id}')
         EXECUTE FUNCTION pickup_test_fail()`,
    );

    try {
      const failed = await claim(baseUrl, order.id);
      expect(failed.status).toBe(500);
      expect(failed.body.error?.code).toBe('INTERNAL_ERROR');

      // Rollback proved: the flip was undone and stock untouched.
      const row = await orderRow(pool, order.id);
      expect(row.status).toBe('paid');
      expect(row.picked_up_at).toBeNull();
      expect(row.paid_at).not.toBeNull();
      expect(await stockOf(pool, product.id)).toBe(4);
    } finally {
      await pool.query('DROP TRIGGER pickup_test_fail_trigger ON products');
      await pool.query('DROP FUNCTION pickup_test_fail()');
    }

    // With the fault removed, the same order claims successfully: total
    // deduction across failed + successful attempts is exactly one.
    const retry = await claim(baseUrl, order.id);
    expect(retry.status).toBe(200);
    expect(retry.body.order!.status).toBe('picked_up');
    expect(await stockOf(pool, product.id)).toBe(3);
  });
});
