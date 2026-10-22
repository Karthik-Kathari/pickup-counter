import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  activeHeldQuantity,
  createTestPool,
  insertFixtureProduct,
  resetTestDatabase,
  startTestServer,
} from './helpers/db.js';

/**
 * Order-creation integration tests — POST /orders against REAL PostgreSQL.
 *
 * (Test IDs referenced by ACCEPTANCE_CRITERIA / the Phase 2 assignment:)
 *   Test A — T-CONC-01  ten concurrent customers, last two units
 *   Test B — T-ORDER-05 multi-item all-or-nothing atomicity
 *   Test C — T-EXPIRY-01 expired holds restored + lazy status flip
 *   Test D — T-VALID-* + T-ORDER-02 + T-ORDER-04 validation and pricing
 *   Test E — T-LOCK-01  competing multi-product orders, sorted lock order
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
    expiresInSeconds: number;
    items: Array<{
      productId: string;
      name: string;
      quantity: number;
      unitPricePaise: number;
      lineTotalPaise: number;
    }>;
  };
}

function postOrder(body: unknown): Promise<{ status: number; json: unknown }> {
  return fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (response) => ({
    status: response.status,
    json: (await response.json()) as unknown,
  }));
}

function oneUnit(productId: string): { items: Array<{ productId: string; quantity: number }> } {
  return { items: [{ productId, quantity: 1 }] };
}

beforeAll(async () => {
  pool = createTestPool(25);
  await resetTestDatabase(pool);
  const server = await startTestServer(pool);
  baseUrl = server.baseUrl;
  closeServer = server.close;
});

afterAll(async () => {
  await closeServer();
  await pool.end();
});

describe('Test A — concurrency: ten customers compete for the last two units (T-CONC-01)', () => {
  it('reserves exactly two units; every other request fails cleanly; nothing is partial', async () => {
    // Five independent rounds to surface flaky behavior within a single run.
    for (let round = 1; round <= 5; round += 1) {
      const product = await insertFixtureProduct(pool, { stockQuantity: 2 });

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          postOrder({ items: [{ productId: product.id, quantity: 1 }] }),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      const rejected = responses.filter((r) => r.status === 409);

      expect(created.length).toBe(2);
      expect(rejected.length).toBe(8);
      for (const rejection of rejected) {
        expect((rejection.json as ErrorJson).error.code).toBe('INSUFFICIENT_STOCK');
      }

      // Inventory truth: 2 reserved, 0 available, physical still 2.
      expect(await activeHeldQuantity(pool, product.id)).toBe(2);
      const stock = await pool.query<{ stock_quantity: number; available: number }>(
        `
          SELECT p.stock_quantity,
                 GREATEST(p.stock_quantity - COALESCE(h.held, 0), 0) AS available
            FROM products p
            LEFT JOIN (
              SELECT SUM(ol.quantity) AS held
                FROM order_lines ol
                JOIN orders o ON o.id = ol.order_id
               WHERE ol.product_id = $1
                 AND o.status = 'pending'
                 AND o.expires_at > now()
            ) h ON TRUE
           WHERE p.id = $1
        `,
        [product.id],
      );
      expect(stock.rows[0]!.stock_quantity).toBe(2);
      expect(Number(stock.rows[0]!.available)).toBe(0);

      // No partial orders: exactly as many orders as successes, one line each,
      // zero orphaned lines, zero failed-order remnants.
      const rows = await pool.query<{ order_count: string; line_count: string }>(
        `
          SELECT (SELECT COUNT(*) FROM orders o
                   JOIN order_lines ol ON ol.order_id = o.id
                  WHERE ol.product_id = $1) AS order_count,
                 (SELECT COUNT(*) FROM order_lines WHERE product_id = $1) AS line_count
        `,
        [product.id],
      );
      expect(Number(rows.rows[0]!.order_count)).toBe(2);
      expect(Number(rows.rows[0]!.line_count)).toBe(2);

      const orphans = await pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM order_lines ol
          WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = ol.order_id)`,
      );
      expect(Number(orphans.rows[0]!.count)).toBe(0);
    }
  });
});

describe('Test B — multi-item atomicity (T-ORDER-05)', () => {
  it('reserves nothing when any single line is insufficient', async () => {
    const plenty = await insertFixtureProduct(pool, { stockQuantity: 5 });
    const scarce = await insertFixtureProduct(pool, { stockQuantity: 1 });

    const response = await postOrder({
      items: [
        { productId: plenty.id, quantity: 2 },
        { productId: scarce.id, quantity: 3 },
      ],
    });

    expect(response.status).toBe(409);
    const body = response.json as ErrorJson;
    expect(body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(body.error.details).toMatchObject({
      shortages: [{ productId: scarce.id, requested: 3, available: 1 }],
    });

    // Neither product has any reservation, and no order references them
    // (order_lines and orders commit together, so zero lines ⇒ zero orders).
    for (const product of [plenty, scarce]) {
      expect(await activeHeldQuantity(pool, product.id)).toBe(0);
      const linked = await pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM order_lines WHERE product_id = $1`,
        [product.id],
      );
      expect(Number(linked.rows[0]!.count)).toBe(0);

      const referencingOrders = await pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM orders o
           JOIN order_lines ol ON ol.order_id = o.id
          WHERE ol.product_id = $1`,
        [product.id],
      );
      expect(Number(referencingOrders.rows[0]!.count)).toBe(0);
    }
  });
});

describe('Test C — expired holds (T-EXPIRY-01)', () => {
  it('restores availability immediately and flips the order to expired on observation', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 3 });

    const first = await postOrder({ items: [{ productId: product.id, quantity: 2 }] });
    expect(first.status).toBe(201);
    const orderId = (first.json as OrderJson).order.id;

    const held = async (): Promise<number> => {
      const { products } = (await (await fetch(`${baseUrl}/products`)).json()) as {
        products: Array<{ id: string; availableUnits: number }>;
      };
      return products.find((p) => p.id === product.id)!.availableUnits;
    };
    expect(await held()).toBe(1);

    // Deterministic expiry: move the hold deadline into the past with the DB
    // clock — no sleeping, no wall-clock dependence. `created_at` moves too,
    // so the orders_expires_after_creation invariant (a fresh order always
    // has a positive hold) stays intact; this simulates an order created an
    // hour ago whose hold has elapsed.
    await pool.query(
      `UPDATE orders
          SET created_at = now() - interval '1 hour',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [orderId],
    );

    // Availability is restored by the FORMULA, before any status flip.
    expect(await held()).toBe(3);
    const beforeFlip = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [orderId],
    );
    expect(beforeFlip.rows[0]!.status).toBe('pending');

    // Order creation is an observation point: the lazy sweep flips the order.
    const second = await postOrder({ items: [{ productId: product.id, quantity: 1 }] });
    expect(second.status).toBe(201);

    const afterFlip = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [orderId],
    );
    expect(afterFlip.rows[0]!.status).toBe('expired');

    // The expired order stays expired (no revival) and holds nothing.
    expect(await activeHeldQuantity(pool, product.id)).toBe(1);
  });
});

describe('Test D — validation and pricing (T-VALID-*, T-ORDER-02, T-ORDER-04)', () => {
  it('rejects invalid request bodies with 400 VALIDATION_ERROR', async () => {
    const product = await insertFixtureProduct(pool);
    const cases: unknown[] = [
      {}, // no items
      { items: [] }, // empty cart
      { items: [{ productId: product.id, quantity: 0 }] },
      { items: [{ productId: product.id, quantity: -1 }] },
      { items: [{ productId: product.id, quantity: 1.5 }] },
      { items: [{ productId: product.id, quantity: '2' }] },
      { items: [{ productId: 'not-a-uuid', quantity: 1 }] },
      { items: 'nope' },
      '{invalid json',
    ];
    for (const body of cases) {
      const response = await postOrder(body);
      const code = (response.json as ErrorJson).error?.code;
      expect([400], `body=${JSON.stringify(body)}`).toContain(response.status);
      expect(['VALIDATION_ERROR', 'INVALID_JSON']).toContain(code);
    }
  });

  it('rejects unknown products with 404 and names the missing IDs', async () => {
    const missingId = '99999999-9999-4999-8999-999999999999';
    const response = await postOrder(oneUnit(missingId));
    expect(response.status).toBe(404);
    const body = response.json as ErrorJson;
    expect(body.error.code).toBe('PRODUCT_NOT_FOUND');
    expect(body.error.details).toMatchObject({ missingProductIds: [missingId] });
  });

  it('consolidates repeated productIds into one line with summed quantity', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 10, pricePaise: 2500 });
    const response = await postOrder({
      items: [
        { productId: product.id, quantity: 1 },
        { productId: product.id, quantity: 2 },
      ],
    });
    expect(response.status).toBe(201);
    const order = (response.json as OrderJson).order;
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.quantity).toBe(3);
    expect(order.totalPaise).toBe(7500); // 3 × 2500, integer paise
  });

  it('calculates all money server-side and ignores client-supplied prices/totals', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 10, pricePaise: 1200 });
    const response = await postOrder({
      items: [{ productId: product.id, quantity: 4, unitPricePaise: 1, pricePaise: 1 }],
      totalPaise: 0,
      total: 999999,
    });
    expect(response.status).toBe(201);
    const order = (response.json as OrderJson).order;
    expect(order.totalPaise).toBe(4800); // 4 × 1200 from products.price_paise
    expect(order.items[0]!.unitPricePaise).toBe(1200);
    expect(order.items[0]!.lineTotalPaise).toBe(4800);

    // Persisted total agrees with the response.
    const persisted = await pool.query<{ total_paise: string }>(
      'SELECT total_paise FROM orders WHERE id = $1',
      [order.id],
    );
    expect(Number(persisted.rows[0]!.total_paise)).toBe(4800);
  });

  it('T-ORDER-04: derives expiresInSeconds from the configured hold and DB clock', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
    const response = await postOrder(oneUnit(product.id));
    const order = (response.json as OrderJson).order;
    expect(order.expiresInSeconds).toBeLessThanOrEqual(120);
    expect(order.expiresInSeconds).toBeGreaterThanOrEqual(100);

    // Stored hold length is exactly TTL seconds of database time.
    const hold = await pool.query<{ seconds: number }>(
      `SELECT FLOOR(EXTRACT(EPOCH FROM (expires_at - created_at)))::int AS seconds
         FROM orders WHERE id = $1`,
      [order.id],
    );
    expect(hold.rows[0]!.seconds).toBe(120);
  });

  it('T-ORDER-04b: expiresInSeconds follows the server config, not a hardcoded 120', async () => {
    const shortTtlServer = await startTestServer(pool, 30);
    try {
      const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
      const response = await fetch(`${shortTtlServer.baseUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(oneUnit(product.id)),
      });
      const body = (await response.json()) as OrderJson;
      expect(body.order.expiresInSeconds).toBeLessThanOrEqual(30);
      expect(body.order.expiresInSeconds).toBeGreaterThanOrEqual(20);
    } finally {
      await shortTtlServer.close();
    }
  });

  it('returns orders with status pending and a Location header', async () => {
    const product = await insertFixtureProduct(pool, { stockQuantity: 5 });
    const response = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(oneUnit(product.id)),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toMatch(/^\/orders\//);
    const body = (await response.json()) as OrderJson;
    expect(body.order.status).toBe('pending');
    expect(body.order.id).toBeTruthy();
  });
});

describe('Test E — competing multi-product orders and lock ordering (T-LOCK-01)', () => {
  it('exactly one of two reversed-order concurrent orders wins; no deadlocks or partials', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const x = await insertFixtureProduct(pool, { stockQuantity: 1 });
      const y = await insertFixtureProduct(pool, { stockQuantity: 1 });

      const [first, second] = await Promise.all([
        postOrder({
          items: [
            { productId: x.id, quantity: 1 },
            { productId: y.id, quantity: 1 },
          ],
        }),
        postOrder({
          items: [
            { productId: y.id, quantity: 1 },
            { productId: x.id, quantity: 1 },
          ],
        }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      // The rejection is a stock decision, never a deadlock/500.
      const rejected = first.status === 409 ? first : second;
      expect((rejected.json as ErrorJson).error.code).toBe('INSUFFICIENT_STOCK');

      expect(await activeHeldQuantity(pool, x.id)).toBe(1);
      expect(await activeHeldQuantity(pool, y.id)).toBe(1);
      const winner = first.status === 201 ? (first.json as OrderJson) : (second.json as OrderJson);
      const winnerLines = await pool.query<{ count: string }>(
        'SELECT COUNT(*) FROM order_lines WHERE order_id = $1',
        [winner.order.id],
      );
      expect(Number(winnerLines.rows[0]!.count)).toBe(2);
    }
  });
});
