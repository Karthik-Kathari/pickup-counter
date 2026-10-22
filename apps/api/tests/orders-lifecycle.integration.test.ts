import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createTestPool,
  insertFixtureProduct,
  resetTestDatabase,
  startTestServer,
} from './helpers/db.js';

/**
 * Order status & expiration lifecycle integration tests (Phase 3),
 * GET /orders/:id against REAL PostgreSQL.
 *
 * Required cases (assignment §5):
 *  1. T-STATUS-01 pending order: items, paise totals, expiry, remaining seconds
 *  2. T-STATUS-02 unknown order → 404
 *  3. T-STATUS-03 expired hold flips to expired when status is accessed
 *  4. T-STATUS-04 expired holds restore availability, physical stock untouched
 *  5. T-STATUS-05 repeated reads and sweeps are idempotent; countdown never grows
 *  6. T-STATUS-06 paid / needs_review / picked_up are never expired
 *  7. T-STATUS-07 concurrent reads on an expired order stay consistent
 *  8. T-STATUS-08 invalid order id → documented 400
 *  9. T-STATUS-09 countdown from DB time, deterministic (no 120 s sleeps)
 */

let pool: Pool;
let baseUrl: string;
let closeServer: () => Promise<void>;

interface ErrorJson {
  error: { code: string; message: string; details?: unknown };
}

interface OrderJson {
  order: {
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
  };
}

async function getOrder(id: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}/orders/${id}`);
  return { status: response.status, json: (await response.json()) as unknown };
}

async function createOrder(productId: string, quantity = 1): Promise<OrderJson['order']> {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId, quantity }] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as OrderJson).order;
}

/** Deterministically expire an order: simulate "created an hour ago, hold elapsed". */
async function expireOrderInDb(orderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders
        SET created_at = now() - interval '1 hour',
            expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [orderId],
  );
}

/** Availability of one product straight from the catalog endpoint. */
async function availabilityOf(productId: string): Promise<number> {
  const body = (await (await fetch(`${baseUrl}/products`)).json()) as {
    products: Array<{ id: string; availableUnits: number; stockQuantity: number }>;
  };
  return body.products.find((p) => p.id === productId)!.availableUnits;
}

beforeAll(async () => {
  pool = createTestPool();
  await resetTestDatabase(pool);
  const server = await startTestServer(pool);
  baseUrl = server.baseUrl;
  closeServer = server.close;
});

afterAll(async () => {
  await closeServer();
  await pool.end();
});

describe('GET /orders/:id (real PostgreSQL)', () => {
  it('T-STATUS-01: pending order returns items, paise totals, expiry and remaining seconds', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 10, pricePaise: 2500 });
    const created = await createOrder(product.id, 3);

    const { status, json } = await getOrder(created.id);
    expect(status).toBe(200);
    const order = (json as OrderJson).order;

    expect(order.id).toBe(created.id);
    expect(order.status).toBe('pending');
    expect(order.totalPaise).toBe(7500); // 3 × 2500
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      productId: product.id,
      quantity: 3,
      unitPricePaise: 2500,
      lineTotalPaise: 7500,
    });
    expect(Number.isInteger(order.expiresInSeconds)).toBe(true);
    expect(order.expiresInSeconds!).toBeGreaterThan(0);
    expect(order.expiresInSeconds!).toBeLessThanOrEqual(120);
    // Timestamps round-trip as ISO strings; expiresAt is in the future.
    expect(Number.isNaN(Date.parse(order.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(order.expiresAt))).toBe(false);
    expect(Date.parse(order.expiresAt)).toBeGreaterThan(Date.parse(order.createdAt));
    // No paid/pickup fields on a pending order.
    expect(order.paidAt).toBeUndefined();
    expect(order.pickedUpAt).toBeUndefined();
  });

  it('T-STATUS-02: unknown order returns 404 ORDER_NOT_FOUND', async () => {
    const { status, json } = await getOrder('99999999-9999-4999-8999-999999999999');
    expect(status).toBe(404);
    expect((json as ErrorJson).error.code).toBe('ORDER_NOT_FOUND');
  });

  it('T-STATUS-08: invalid order id returns the documented 400 validation response', async () => {
    const { status, json } = await getOrder('not-a-uuid');
    expect(status).toBe(400);
    const body = json as ErrorJson;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toMatchObject([{ path: 'id' }]);
  });

  it('T-STATUS-03/04: expired hold flips to expired on access and restores availability without touching physical stock', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 4 });
    const order = await createOrder(product.id, 3);
    expect(await availabilityOf(product.id)).toBe(1); // 4 − 3 held

    await expireOrderInDb(order.id);

    // Availability is restored by the formula even before any flip.
    expect(await availabilityOf(product.id)).toBe(4);

    const { status, json } = await getOrder(order.id);
    expect(status).toBe(200);
    const fetched = (json as OrderJson).order;
    expect(fetched.status).toBe('expired');
    expect(fetched.expiresInSeconds).toBeUndefined(); // never a positive countdown
    // Items and totals survive expiration (historical record).
    // 3 × 1500 (the fixture's default price) = 4500.
    expect(fetched.totalPaise).toBe(4500);
    expect(fetched.items[0]!.quantity).toBe(3);

    // Physical stock untouched by both expiration paths.
    const stock = await pool.query<{ stock_quantity: number }>(
      'SELECT stock_quantity FROM products WHERE id = $1',
      [product.id],
    );
    expect(stock.rows[0]!.stock_quantity).toBe(4);
    // Flipped in the database, not just in the response.
    const persisted = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [order.id],
    );
    expect(persisted.rows[0]!.status).toBe('expired');
  });

  it('T-STATUS-05: repeated reads and sweeps are idempotent; the countdown never increases', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
    // Shrink the hold deterministically: expires_at stays AFTER created_at,
    // keeping the orders_expires_after_creation invariant intact.
    const order = await createOrder(product.id, 1);
    await pool.query(
      `UPDATE orders SET expires_at = created_at + interval '30 seconds' WHERE id = $1`,
      [order.id],
    );

    const first = (await getOrder(order.id)).json as OrderJson;
    const second = (await getOrder(order.id)).json as OrderJson;
    expect(first.order.status).toBe('pending');
    expect(second.order.status).toBe('pending');
    expect(first.order.expiresInSeconds!).toBeLessThanOrEqual(30);
    // Monotonic non-increasing across reads (database clock).
    expect(second.order.expiresInSeconds!).toBeLessThanOrEqual(first.order.expiresInSeconds!);

    // Expiring it, then reading repeatedly, is stable: same terminal status,
    // still no countdown, still no further changes.
    await expireOrderInDb(order.id);
    const reads = await Promise.all([getOrder(order.id), getOrder(order.id), getOrder(order.id)]);
    for (const read of reads) {
      expect(read.status).toBe(200);
      expect((read.json as OrderJson).order.status).toBe('expired');
      expect((read.json as OrderJson).order.expiresInSeconds).toBeUndefined();
    }
    // The global creation-time sweep is idempotent too: running it again
    // (via another order creation) changes nothing.
    await createOrder(product.id, 1);
    const afterSweep = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [order.id],
    );
    expect(afterSweep.rows[0]!.status).toBe('expired');
  });

  it('T-STATUS-06: paid, needs_review and picked_up orders are never expired', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 10 });
    const base = await createOrder(product.id, 1);

    // Move every order into a terminal/advanced state with an ALREADY-PASSED
    // hold deadline, keeping each state's coherence constraints satisfied.
    const toPaid = `${base.id}`;
    await pool.query(
      `UPDATE orders
          SET status = 'paid',
              paid_at = now(),
              created_at = now() - interval '1 hour',
              expires_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [toPaid],
    );
    const needsReview = await createOrder(product.id, 1);
    await pool.query(
      `UPDATE orders
          SET status = 'needs_review',
              needs_review_reason = 'amount_mismatch',
              created_at = now() - interval '1 hour',
              expires_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [needsReview.id],
    );
    const pickedUp = await createOrder(product.id, 1);
    await pool.query(
      `UPDATE orders
          SET status = 'picked_up',
              paid_at = now(),
              picked_up_at = now(),
              created_at = now() - interval '1 hour',
              expires_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [pickedUp.id],
    );

    // Observe each order (targeted flip) AND run the global sweep (by
    // creating another order) — none of the three may change.
    for (const [id, expected] of [
      [toPaid, 'paid'],
      [needsReview.id, 'needs_review'],
      [pickedUp.id, 'picked_up'],
    ] as const) {
      const { status, json } = await getOrder(id);
      expect(status).toBe(200);
      expect((json as OrderJson).order.status).toBe(expected);
      expect((json as OrderJson).order.expiresInSeconds).toBeUndefined();
    }
    await createOrder(product.id, 1);

    const statuses = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM orders WHERE id = ANY ($1::uuid[])',
      [[toPaid, needsReview.id, pickedUp.id]],
    );
    const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
    expect(byId.get(toPaid)).toBe('paid');
    expect(byId.get(needsReview.id)).toBe('needs_review');
    expect(byId.get(pickedUp.id)).toBe('picked_up');

    // Timestamps/reasons survive for the payment/pickup phases downstream.
    const detailed = (await getOrder(pickedUp.id)).json as OrderJson;
    expect(detailed.order.paidAt).toBeTruthy();
    expect(detailed.order.pickedUpAt).toBeTruthy();
    const review = (await getOrder(needsReview.id)).json as OrderJson;
    expect(review.order.needsReviewReason).toBe('amount_mismatch');
  });

  it('T-STATUS-07: concurrent status reads on an expired order leave one consistent terminal state', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
    const order = await createOrder(product.id, 1);
    await expireOrderInDb(order.id);

    const reads = await Promise.all(Array.from({ length: 8 }, () => getOrder(order.id)));
    for (const read of reads) {
      expect(read.status).toBe(200);
      const body = (read.json as OrderJson).order;
      expect(body.status).toBe('expired');
      expect(body.expiresInSeconds).toBeUndefined();
      expect(body.id).toBe(order.id);
      expect(body.totalPaise).toBe(order.totalPaise);
    }
    const persisted = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [order.id],
    );
    expect(persisted.rows[0]!.status).toBe('expired');
  });

  it('T-STATUS-09: the countdown reflects the database clock, not a constant', async () => {
    const shortTtlServer = await startTestServer(pool, 30);
    try {
      const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
      const response = await fetch(`${shortTtlServer.baseUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
      });
      const created = ((await response.json()) as OrderJson).order;

      const status = (await (
        await fetch(`${shortTtlServer.baseUrl}/orders/${created.id}`)
      ).json()) as OrderJson;
      expect(status.order.status).toBe('pending');
      expect(status.order.expiresInSeconds!).toBeLessThanOrEqual(30);
      expect(status.order.expiresInSeconds!).toBeGreaterThan(0);

      // Shrink the stored hold to 5 s of DB time and re-read: the countdown
      // follows the stored deadline, deterministically (no sleeping).
      await pool.query(
        `UPDATE orders SET expires_at = created_at + interval '5 seconds' WHERE id = $1`,
        [created.id],
      );
      const reRead = (await (
        await fetch(`${shortTtlServer.baseUrl}/orders/${created.id}`)
      ).json()) as OrderJson;
      expect(reRead.order.expiresInSeconds!).toBeLessThanOrEqual(5);
      expect(reRead.order.expiresInSeconds!).toBeGreaterThan(0);
    } finally {
      await shortTtlServer.close();
    }
  });
});
