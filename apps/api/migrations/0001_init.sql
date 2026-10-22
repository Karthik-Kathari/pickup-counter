-- 0001_init.sql — core schema for the pickup counter.
--
-- Invariants encoded here (see AGENTS.md):
--   I1  all monetary values are integer paise (bigint columns, CHECK >= 0 / > 0)
--   I5  stock_quantity is only ever decremented by a successful pickup claim
--   I6  order status is constrained to the five documented states, with
--       coherence checks tying timestamps to states
--
-- Time is always database-generated (timestamptz DEFAULT now()); no column
-- is ever populated from an application clock.

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable, human-friendly identifier used by the seed script (idempotent upserts).
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  price_paise bigint NOT NULL CHECK (price_paise > 0),
  -- Physical stock on hand. Reservations do NOT reduce this column; they are
  -- derived from active (pending, unexpired) orders. Only pickup claims
  -- decrement it, permanently and exactly once (enforced in Phase 5 logic;
  -- the CHECK below is the last-line backstop against overselling).
  stock_quantity integer NOT NULL CHECK (stock_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'needs_review', 'picked_up')),
  -- Server-calculated total (sum of quantity * unit_price_paise at creation).
  total_paise bigint NOT NULL CHECK (total_paise >= 0),
  -- Hold deadline, always computed from the database clock.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  picked_up_at timestamptz,
  needs_review_reason text
    CHECK (needs_review_reason IS NULL OR needs_review_reason IN ('amount_mismatch', 'late_payment')),
  -- State-machine coherence (AGENTS.md I6): timestamps must match the state.
  CONSTRAINT orders_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT orders_paid_requires_paid_at CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT orders_review_requires_reason CHECK (status <> 'needs_review' OR needs_review_reason IS NOT NULL),
  CONSTRAINT orders_picked_up_consistency
    CHECK (status <> 'picked_up' OR (paid_at IS NOT NULL AND picked_up_at IS NOT NULL))
);

-- Supports the lazy-expiry scan and the availability formula
-- (status = 'pending' AND expires_at > now()).
CREATE INDEX IF NOT EXISTS orders_status_expires_at_idx ON orders (status, expires_at);

CREATE TABLE IF NOT EXISTS order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  -- Price snapshot taken from products.price_paise at order creation.
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Duplicate product lines in one order are consolidated before insert;
  -- this unique key is the hard guarantee.
  CONSTRAINT order_lines_unique_product UNIQUE (order_id, product_id)
);

-- Availability joins lock/scan by product.
CREATE INDEX IF NOT EXISTS order_lines_product_id_idx ON order_lines (product_id);

CREATE TABLE IF NOT EXISTS payment_events (
  -- Provider-supplied event ID: opaque string, database-enforced idempotency
  -- key (AGENTS.md I7). Duplicates are rejected here before any side effect.
  event_id text PRIMARY KEY,
  -- Intentionally NO foreign key to orders: the ledger must be able to record
  -- a provider event for an order we do not know (ACCEPTANCE_CRITERIA C9) and
  -- must survive independent of order-row lifecycle. Referential integrity is
  -- validated at processing time.
  order_id uuid,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  -- Provider event status (e.g. 'captured'); not our order status.
  status text NOT NULL,
  -- Processing outcome, written in the same transaction as the state change.
  outcome text CHECK (outcome IS NULL OR outcome IN (
    'paid',
    'amount_mismatch',
    'late_payment',
    'unknown_order',
    'ignored_status',
    'no_transition'
  )),
  -- Exact payload as received, for reconciliation.
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS payment_events_order_id_idx ON payment_events (order_id)
  WHERE order_id IS NOT NULL;
