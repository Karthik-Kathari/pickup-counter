import { useCallback, useEffect, useRef, useState } from 'react';

import { Header, Footer } from './layout';
import { Catalog, CartPanel, OrderSummary, WebhookPanel } from './components';
import Button from './ui/Button';
import StatusBanner from './ui/StatusBanner';

import './ui/index.css';
import './layout/index.css';
import './components/Component.css';
import './App.css';

/** ---------- types ---------- */

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

/** ---------- helpers ---------- */

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

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

/** ---------- component ---------- */

function formatDateTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

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

  // Monotonic countdown — anchored from server expiresInSeconds, elapsed from performance.now().
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
      countdownAnchor.current = { seconds: next.expiresInSeconds, at: performance.now() };
      setCountdown(next.expiresInSeconds);
    } else {
      setCountdown(null);
    }
  }, []);

  // Poll the server while pending; stop on any terminal status (E4).
  useEffect(() => {
    if (screen !== 'order' || order === null || order.status !== 'pending') {
      return;
    }

    const orderId = order.id;
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`/orders/${orderId}`);
        if (!response.ok || cancelled) {
          return;
        }
        const json = (await response.json()) as { order: Order };
        if (!cancelled) {
          applyServerOrder(json.order);
        }
      } catch {
        // keep polling; never infer status client-side
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [screen, order?.id, order?.status, applyServerOrder]);

  const adjustQuantity = useCallback((productId: string, delta: number, availableUnits: number) => {
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
  }, []);

  const placeOrder = async () => {
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
        void loadCatalog();
        return;
      }
      setCart({});
      setActionError(null);
      setOrderError(null);
      applyServerOrder(json.order);
      setScreen('order');
      void loadCatalog();
    } catch {
      setOrderError('Network error — no order was created');
    } finally {
      setPlacing(false);
    }
  };

  const claimPickup = async () => {
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

  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);

  const cartItems = products
    .filter((product) => cart[product.id] !== undefined)
    .map((product) => ({
      productId: product.id,
      name: product.name,
      quantity: cart[product.id]!,
      pricePaise: product.pricePaise,
    }));

  const backToCatalog = () => {
    setScreen('shop');
    setOrder(null);
    setCountdown(null);
    setOrderError(null);
    setActionError(null);
    void loadCatalog();
  };

  return (
    <div className="page">
      <Header
        brand="Pickup Counter"
        tagline="Self-service snack pickup — reserve, pay, collect."
        cartCount={cartCount}
      />

      <main className="page__main">
        <div className="page__section">
          {screen === 'shop' && (
            <div className="shop-layout">
              <div className="shop-layout__main">
                <Catalog
                  products={products}
                  loading={catalogLoading}
                  error={catalogError}
                  cart={cart}
                  onAdd={(id: string) =>
                    adjustQuantity(id, 1, products.find((p) => p.id === id)?.availableUnits ?? 0)
                  }
                  onDecrement={(id: string) =>
                    adjustQuantity(id, -1, products.find((p) => p.id === id)?.availableUnits ?? 0)
                  }
                  onRemove={(id: string) =>
                    adjustQuantity(
                      id,
                      -(cart[id] ?? 0),
                      products.find((p) => p.id === id)?.availableUnits ?? 0,
                    )
                  }
                />
              </div>
              <aside className="shop-layout__aside" aria-label="Your cart">
                <div className="cart-card">
                  <CartPanel
                    items={cartItems}
                    cartCount={cartCount}
                    placing={placing}
                    error={orderError}
                    onPlaceOrder={placeOrder}
                    onRemoveItem={(id: string) =>
                      adjustQuantity(
                        id,
                        -(cart[id] ?? 0),
                        products.find((p) => p.id === id)?.availableUnits ?? 0,
                      )
                    }
                  />
                </div>
              </aside>
            </div>
          )}

          {screen === 'order' && order !== null && (
            <>
              <div className="order-back">
                <Button variant="ghost" onClick={backToCatalog}>
                  ← Back to catalog
                </Button>
              </div>

              <div className="order-layout">
                <div className="order-layout__summary">
                  <div className="order-summary-card">
                    <OrderSummary
                      orderId={order.id}
                      items={order.items}
                      totalPaise={order.totalPaise}
                      paidAt={order.paidAt}
                      pickedUpAt={order.pickedUpAt}
                    />
                  </div>
                </div>

                <div className="order-main">
                  {order.status === 'pending' && (
                    <>
                      <div className="order-countdown-row">
                        <StatusBanner variant="pending" title="Awaiting payment" code="PENDING">
                          {countdown === 0
                            ? 'Time is up — waiting for the server to confirm the hold…'
                            : `The hold keeps your items until the timer runs out.`}
                        </StatusBanner>
                      </div>

                      <div className="order-countdown-block">
                        <span className="countdown">
                          {countdown !== null ? formatCountdown(countdown) : '…'}
                        </span>
                        <p className="order-poll-note">
                          Polling the server every 2 s for the payment result…
                        </p>
                      </div>

                      <WebhookPanel orderId={order.id} amountPaise={order.totalPaise} />

                      <div className="order-timer-note">
                        The displayed status always comes straight from the server; the timer above
                        never decides the outcome.
                      </div>
                    </>
                  )}

                  {order.status === 'paid' && (
                    <>
                      <StatusBanner variant="paid" title="Payment confirmed" code="PAID">
                        {order.paidAt
                          ? `Paid at ${formatDateTime(order.paidAt)} — head to the locker to collect.`
                          : 'Payment confirmed — head to the locker to collect.'}
                      </StatusBanner>

                      <div className="order-action">
                        <Button
                          variant="primary"
                          size="lg"
                          onClick={() => void claimPickup()}
                          loading={claiming}
                        >
                          {claiming ? 'Claiming…' : 'Confirm pickup'}
                        </Button>
                      </div>
                    </>
                  )}

                  {order.status === 'picked_up' && (
                    <>
                      <StatusBanner variant="picked_up" title="Picked up" code="PICKED_UP">
                        {order.pickedUpAt ? 'Enjoy your snacks!' : 'Enjoy your snacks!'}
                      </StatusBanner>
                    </>
                  )}

                  {order.status === 'expired' && (
                    <>
                      <StatusBanner variant="expired" title="Hold expired" code="EXPIRED">
                        The hold expired before payment arrived. Your items are available again.
                      </StatusBanner>

                      <div className="order-action">
                        <Button variant="primary" onClick={backToCatalog}>
                          Order something else
                        </Button>
                      </div>
                    </>
                  )}

                  {order.status === 'needs_review' && (
                    <StatusBanner variant="review" title="Flagged for review" code="NEEDS_REVIEW">
                      Payment received but flagged for review (
                      {order.needsReviewReason === 'amount_mismatch'
                        ? 'amount did not match the order total'
                        : order.needsReviewReason === 'late_payment'
                          ? 'payment arrived after the hold expired'
                          : 'manual review'}
                      ). No action needed from you — staff will resolve it.
                    </StatusBanner>
                  )}

                  {actionError !== null && (
                    <div className="order-error">
                      <StatusBanner variant="error" code="ERROR">
                        {actionError}
                      </StatusBanner>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
