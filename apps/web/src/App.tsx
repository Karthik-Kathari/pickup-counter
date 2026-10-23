import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Customer screen (acceptance criteria E1–E6).
 *
 * Design rules that come straight from AGENTS.md:
 *  - I1: money is integer paise everywhere; display formatting is integer
 *    arithmetic only (no float money math). The placed order always shows
 *    the SERVER's totalPaise, never a client-side sum (E2).
 *  - I12/E5: the countdown initializes from the server's expiresInSeconds
 *    and ticks by measuring elapsed monotonic time (performance.now()
 *    deltas), never by subtracting Date.now() from a wall-clock instant; it
 *    re-syncs on every poll response. Shifting the OS clock cannot make it
 *    jump.
 *  - E6: the displayed status is ALWAYS the server's reported status. The
 *    timer never decides payment success or expiry — when it reaches 00:00
 *    the UI keeps waiting for the server's own verdict.
 *  - E4: polling stops the moment the server reports a non-pending status.
 *
 * All requests use relative URLs: the Vite dev server proxies API paths in
 * development, nginx proxies them in Docker — same origin, no CORS, and the
 * webhook secret never reaches the browser.
 */

interface Product {
  id: string;
  name: string;
  pricePaise: number;
  stockQuantity: number;
  availableUnits: number;
}

interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

interface Order {
  id: string;
  status: string;
  totalPaise: number;
  createdAt?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  paidAt?: string;
  pickedUpAt?: string;
  needsReviewReason?: string;
  items: OrderItem[];
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

/** Integer-only paise → display string (no floating-point money math, I1). */
function formatPaise(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `₹${rupees.toString()}.${String(rest).padStart(2, '0')}`;
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Render the API's standard error envelope as one readable line (E: honest messages). */
function describeError(status: number, body: ErrorEnvelope): string {
  const code = body.error?.code ?? `HTTP_${status}`;
  const message = body.error?.message ?? 'Unexpected response from the API';
  const details = body.error?.details;
  if (details !== null && typeof details === 'object') {
    const shortages = (details as { shortages?: unknown }).shortages;
    if (Array.isArray(shortages)) {
      const parts = shortages
        .map((entry) => {
          const s = entry as { requested?: number; available?: number };
          return `${s.requested ?? '?'} requested / ${s.available ?? '?'} available`;
        })
        .join(', ');
      if (parts.length > 0) {
        return `${code} — ${message} (${parts})`;
      }
    }
  }
  return `${code} — ${message}`;
}

type Screen = 'shop' | 'order';

export default function App(): React.ReactElement {
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const [screen, setScreen] = useState<Screen>('shop');
  const [order, setOrder] = useState<Order | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Monotonic countdown anchor (I12/E5): seconds as last reported by the
  // server, anchored to a performance.now() reading. Never a wall clock.
  const countdownAnchor = useRef<{ seconds: number; at: number }>({ seconds: 0, at: 0 });

  const loadCatalog = useCallback(async () => {
    try {
      const response = await fetch('/products');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = (await response.json()) as { products: Product[] };
      setProducts(json.products);
      setCatalogError(null);
    } catch {
      setCatalogError('Catalog unavailable — is the API running? (GET /health)');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Tick the countdown from monotonic elapsed time only.
  useEffect(() => {
    if (screen !== 'order' || order?.status !== 'pending') {
      return;
    }
    const timer = window.setInterval(() => {
      const anchor = countdownAnchor.current;
      const elapsedSeconds = (performance.now() - anchor.at) / 1000;
      const remaining = Math.max(Math.floor(anchor.seconds - elapsedSeconds), 0);
      setCountdown(remaining);
    }, 250);
    return () => window.clearInterval(timer);
  }, [screen, order?.status]);

  const applyServerOrder = useCallback((next: Order) => {
    setOrder(next);
    if (next.status === 'pending' && typeof next.expiresInSeconds === 'number') {
      // Re-sync the monotonic anchor on every server response (I12).
      countdownAnchor.current = { seconds: next.expiresInSeconds, at: performance.now() };
      setCountdown(next.expiresInSeconds);
    } else {
      setCountdown(null);
    }
  }, []);

  // Poll the server while the order is pending; STOP on any other status (E4).
  useEffect(() => {
    if (screen !== 'order' || order === null || order.status !== 'pending') {
      return;
    }
    const orderId = order.id;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`/orders/${orderId}`);
        if (!response.ok || cancelled) {
          return; // transient failure: keep waiting for the server, never guess
        }
        const json = (await response.json()) as { order: Order };
        if (!cancelled) {
          applyServerOrder(json.order);
        }
      } catch {
        // Network hiccup: keep polling; status never changes client-side.
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [screen, order?.id, order?.status, applyServerOrder]);

  const adjustQuantity = (productId: string, delta: number, availableUnits: number): void => {
    setCart((current) => {
      const next = Math.min(Math.max((current[productId] ?? 0) + delta, 0), availableUnits);
      const updated = { ...current };
      if (next === 0) {
        delete updated[productId];
      } else {
        updated[productId] = next;
      }
      return updated;
    });
  };

  const placeOrder = async (): Promise<void> => {
    setPlacing(true);
    setOrderError(null);
    try {
      const items = Object.entries(cart).map(([productId, quantity]) => ({
        productId,
        quantity,
      }));
      const response = await fetch('/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const json = (await response.json().catch(() => ({}))) as ErrorEnvelope & { order?: Order };
      if (!response.ok || json.order === undefined) {
        setOrderError(describeError(response.status, json));
        // Rejections usually mean availability moved — refresh the catalog so
        // the displayed quantities follow the server, not the stale snapshot.
        void loadCatalog();
        return;
      }
      setCart({});
      setActionError(null);
      applyServerOrder(json.order);
      setScreen('order');
      void loadCatalog(); // availability changed everywhere
    } catch {
      setOrderError('Network error — no order was created');
    } finally {
      setPlacing(false);
    }
  };

  const claimPickup = async (): Promise<void> => {
    if (order === null) {
      return;
    }
    setClaiming(true);
    setActionError(null);
    try {
      const response = await fetch(`/orders/${order.id}/pickup-claim`, { method: 'POST' });
      const json = (await response.json().catch(() => ({}))) as ErrorEnvelope & { order?: Order };
      if (response.ok && json.order !== undefined) {
        applyServerOrder(json.order);
        void loadCatalog();
        return;
      }
      setActionError(describeError(response.status, json));
      // The server is authoritative (E6): re-read the real state after a
      // failed claim (e.g. already claimed in another tab).
      const fresh = await fetch(`/orders/${order.id}`);
      if (fresh.ok) {
        const freshJson = (await fresh.json()) as { order: Order };
        applyServerOrder(freshJson.order);
      }
    } catch {
      setActionError('Network error — claim not confirmed; order unchanged');
    } finally {
      setClaiming(false);
    }
  };

  const backToCatalog = (): void => {
    setScreen('shop');
    setOrder(null);
    setCountdown(null);
    setOrderError(null);
    setActionError(null);
    void loadCatalog();
  };

  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);

  return (
    <main className="container">
      <header className="app-header">
        <div>
          <h1>Pickup Counter</h1>
          <p className="tagline">Self-service snack pickup — reserve, pay, collect.</p>
        </div>
        {screen === 'shop' && cartCount > 0 && (
          <span className="cart-badge">{cartCount} in cart</span>
        )}
      </header>

      {screen === 'shop' && (
        <section aria-label="Catalog">
          <h2>Catalog</h2>
          {catalogLoading && <p className="muted">Loading products…</p>}
          {catalogError !== null && <p className="error-banner">{catalogError}</p>}
          <ul className="product-list">
            {products.map((product) => {
              const inCart = cart[product.id] ?? 0;
              const soldOut = product.availableUnits === 0;
              return (
                <li key={product.id} className="product-row">
                  <div>
                    <strong>{product.name}</strong>
                    <div className="muted">
                      {formatPaise(product.pricePaise)} ·{' '}
                      {soldOut ? 'sold out' : `${product.availableUnits} available`}
                    </div>
                  </div>
                  {soldOut ? (
                    <span className="muted">Sold out</span>
                  ) : inCart > 0 ? (
                    <div className="qty">
                      <button
                        type="button"
                        aria-label={`Remove one ${product.name}`}
                        onClick={() => adjustQuantity(product.id, -1, product.availableUnits)}
                      >
                        −
                      </button>
                      <span>{inCart}</span>
                      <button
                        type="button"
                        aria-label={`Add one ${product.name}`}
                        onClick={() => adjustQuantity(product.id, 1, product.availableUnits)}
                        disabled={inCart >= product.availableUnits}
                      >
                        +
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => adjustQuantity(product.id, 1, product.availableUnits)}
                    >
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="panel">
            <h2>Your order</h2>
            {cartCount === 0 ? (
              <p className="muted">Cart is empty — add something above.</p>
            ) : (
              <>
                <ul className="cart-list">
                  {products
                    .filter((product) => cart[product.id] !== undefined)
                    .map((product) => (
                      <li key={product.id}>
                        {product.name} × {cart[product.id]}{' '}
                        <span className="muted">(@ {formatPaise(product.pricePaise)} each)</span>
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            adjustQuantity(
                              product.id,
                              -(cart[product.id] ?? 0),
                              product.availableUnits,
                            )
                          }
                        >
                          remove
                        </button>
                      </li>
                    ))}
                </ul>
                <p className="muted">
                  The total is calculated by the server when the order is placed — prices are read
                  from the catalog at that moment.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void placeOrder()}
                  disabled={placing}
                >
                  {placing ? 'Placing order…' : 'Place order'}
                </button>
              </>
            )}
            {orderError !== null && <p className="error-banner">{orderError}</p>}
          </div>
        </section>
      )}

      {screen === 'order' && order !== null && (
        <section aria-label="Order">
          <button type="button" className="link" onClick={backToCatalog}>
            ← Back to catalog
          </button>

          <div className="panel">
            <h2>Order {order.id.slice(0, 8)}…</h2>
            <ul className="summary-list">
              {order.items.map((item) => (
                <li key={item.productId}>
                  {item.name} × {item.quantity} — {formatPaise(item.lineTotalPaise)}{' '}
                  <span className="muted">({formatPaise(item.unitPricePaise)} each)</span>
                </li>
              ))}
            </ul>
            <p className="total">
              Total (server-computed): <strong>{formatPaise(order.totalPaise)}</strong>
            </p>

            {order.status === 'pending' && (
              <>
                <div className="countdown" aria-live="polite">
                  {countdown !== null ? formatCountdown(countdown) : '…'}
                </div>
                <p className="status-banner status--pending">
                  {countdown === 0
                    ? 'Time is up — waiting for the server to confirm the hold…'
                    : 'Awaiting payment — the hold keeps your items until the timer runs out.'}
                </p>

                <div className="panel panel--inner">
                  <h3>How to pay (demo)</h3>
                  <p>
                    The payment provider confirms payment with an HMAC-signed webhook. Trigger it
                    from the repository root with:
                  </p>
                  <pre className="code">
                    npm run -w apps/api send-webhook -- --order-id {order.id} --amount{' '}
                    {order.totalPaise}
                  </pre>
                  <p className="muted">
                    The amount must equal the order total exactly; a mismatch or a late payment
                    sends the order to manual review, never straight to paid.
                  </p>
                </div>
                <p className="muted">Polling the server every 2 s for the payment result…</p>
              </>
            )}

            {order.status === 'paid' && (
              <>
                <p className="status-banner status--paid">
                  Payment confirmed
                  {order.paidAt ? ` at ${new Date(order.paidAt).toISOString()}` : ''} — head to the
                  locker to collect.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void claimPickup()}
                  disabled={claiming}
                >
                  {claiming ? 'Claiming…' : 'Confirm pickup'}
                </button>
              </>
            )}

            {order.status === 'picked_up' && (
              <p className="status-banner status--picked_up">
                ✓ Picked up
                {order.pickedUpAt ? ` at ${new Date(order.pickedUpAt).toISOString()}` : ''} — enjoy!
              </p>
            )}

            {order.status === 'expired' && (
              <>
                <p className="status-banner status--expired">
                  The hold expired before payment arrived. Your items are available again.
                </p>
                <button type="button" className="primary" onClick={backToCatalog}>
                  Order something else
                </button>
              </>
            )}

            {order.status === 'needs_review' && (
              <p className="status-banner status--review">
                Payment received but flagged for review (
                {order.needsReviewReason === 'amount_mismatch'
                  ? 'amount did not match the order total'
                  : order.needsReviewReason === 'late_payment'
                    ? 'payment arrived after the hold expired'
                    : (order.needsReviewReason ?? 'manual review')}
                ). No action needed from you — staff will resolve it.
              </p>
            )}

            {actionError !== null && <p className="error-banner">{actionError}</p>}
            <p className="muted">
              The displayed status always comes straight from the server; the timer above never
              decides the outcome.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
