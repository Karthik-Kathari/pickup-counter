# IMPLEMENTATION_PLAN.md — Pickup Counter Build Plan

This is the authoritative, phase-by-phase plan for building the pickup counter.
Work proceeds strictly phase by phase: **a phase's exit criteria must be demonstrated before the next phase begins.** Update the checkboxes and the Status column in `README.md` in the same change that completes a phase.

- Baseline specification: `ACCEPTANCE_CRITERIA.md` (derived from the assignment).
- Engineering invariants and conventions: `AGENTS.md`.
- Current status: **Phase 1 complete (application foundation running and verified against real PostgreSQL). Phase 2 is next.**

**Priority rule:** backend correctness and real-database tests always outrank cosmetic frontend work. If time is cut short, ship Phases 1–6 working and documented over a polished UI.

---

## Phase 0 — Repository and specification baseline

- **Scope:** This document set. No application code, no dependencies installed.
- **Dependencies:** None.
- **Deliverables:**
  - `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, `ACCEPTANCE_CRITERIA.md`, `README.md`, `AI_NOTES.md`, `.env.example`
  - Existing `.gitignore` preserved (it already excludes `.env`/`.env.*` while keeping `.env.example`).
  - One focused commit: `docs: establish pickup counter engineering plan`
- **Commands:** `git status`, `git log`, `git add`, `git commit` (and `git push` if credentials are available).
- **Exit criteria:**
  - [x] Repository inspected; only pre-existing `.gitignore` was present.
  - [x] Six files created; no application code, no dependencies installed.
  - [x] No real secrets anywhere in the committed files.
  - [x] Every assignment requirement appears in `ACCEPTANCE_CRITERIA.md`.
  - [x] Blueprint committed (and pushed if credentials allow).
- **Common failure modes:**
  - Documenting a command or feature as if it already works — everything not yet built must be labeled as planned.
  - Committing a populated `.env` by accident — always check `git status` output before committing.

---

## Phase 1 — Skeleton, Docker Compose, database, migrations, seed, health

- **Scope:** Monorepo scaffolding and a running, health-checked API with a schema and seed data. No business endpoints yet.
- **Dependencies:** Phase 0.
- **Deliverables:**
  - Root `package.json` with npm workspaces (`apps/api`, `apps/web`) + `package-lock.json` committed.
  - `tsconfig.base.json` with the strict settings from `AGENTS.md`; per-workspace configs extending it.
  - `apps/api`: Express app factory, config module (zod-validated env, fail-fast on boot), centralized error middleware, `GET /health` (checks DB with `SELECT 1`, returns 200/503), Prettier + ESLint configs.
  - PostgreSQL client: `pg` with a small pool; explicit SQL only.
  - `apps/api/migrations/`: numbered SQL files + a ~50-line runner that applies them in order inside a transaction and records them in `schema_migrations` (advisory lock so concurrent runners can't race).
    - `0001_init.sql`: `products` (uuid PK, stable `key` UNIQUE, `name`, `price_paise BIGINT NOT NULL CHECK (price_paise > 0)`, `stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0)`), `orders` (uuid PK, `status` with a `CHECK` over the five states plus state↔timestamp coherence checks, `total_paise`, `expires_at timestamptz`, `created_at`, `paid_at`, `picked_up_at`, `needs_review_reason` with a `CHECK` allowlist), `order_lines` (FK to orders/products, `quantity INTEGER CHECK (quantity > 0)`, `unit_price_paise`, unique `(order_id, product_id)`), `payment_events` (`event_id TEXT PRIMARY KEY`, `order_id uuid` **without FK — recorded deviation**: the ledger must record provider events for unknown orders per ACCEPTANCE_CRITERIA C9 and survive independently of order rows; referential integrity is validated at processing time), plus indexes on `orders(status, expires_at)` and `order_lines(product_id)`.
    - Pickup claim state lives on the order (`status = 'picked_up'`, `picked_up_at`); a dedicated claims table was deliberately not added — the atomic status flip in the Phase 5 transaction is itself the exactly-once claim record (justified in README).
  - `apps/api/src/seed/`: seed script inserting 5 snack products with integer-paise prices and fixed UUIDs; upserts by `id` and NEVER rewrites `stock_quantity`.
  - `docker-compose.yml`: `db` service (official `postgres:16-alpine` image, named volume, healthcheck, first-boot init SQL that creates the test database), a one-shot `init` service (runs migrations + seed, then exits), and an `api` service gated on `db` healthy **and** `init` completed successfully; ports and env wired from `.env`. (Recorded addition vs. the original deliverable list: the one-shot `init` service exists specifically to eliminate the "API healthy before schema exists" race.)
  - Migration runner notes: session-level `pg_advisory_lock`, per-file transaction, `schema_migrations` history with SHA-256 checksums (editing an applied migration is detected and rejected). Limitations are documented in README and the runner's header comment: append-only migrations, one transaction per file (no `CREATE INDEX CONCURRENTLY`), fixed lock key.
  - `.env` created locally from `.env.example` (never committed).
- **Commands:**
  - `npm install`
  - `docker compose up -d db`
  - `npm run -w apps/api migrate && npm run -w apps/api seed`
  - `npm run typecheck && npm run lint && npm run format:check`
  - `curl -s localhost:3001/health` → `{"status":"ok"}`
- **Exit criteria:**
  - [ ] Fresh clone + `.env` from `.env.example` + the commands above yields a healthy API. _(Partially verified only: the dev machine has **no Docker and no system PostgreSQL**; the same commands were verified against a real local PostgreSQL 18.4 (downloaded binaries, port 5433). The fresh-clone + Compose run remains for Phase 8's audit or any Docker-capable machine.)_
  - [x] Migrations are idempotent to re-run (`migrate` reports "already applied", exits 0). _(Verified twice against real PostgreSQL; also verified: broken migration rolls back fully with a useful error, and two concurrent runners serialize via the advisory lock — exactly one applies.)_
  - [x] Seed is safe to re-run without duplicating products (upsert by stable product key). _(Verified: run 1 inserted 5; after manually consuming stock to 3, run 2 refreshed 5 / inserted 0 and stock stayed 3.)_
  - [x] App refuses to boot with a clear message when `DATABASE_URL`/`WEBHOOK_SECRET` are missing. _(Verified: `NODE_ENV=production` with empty env exits 1 listing both missing variables.)_
  - [x] `git status` clean; lockfile committed. _(Verified at commit time; `npm audit` reports 0 vulnerabilities after dev-toolchain version bumps.)_
- **Common failure modes:**
  - Windows path/line-ending trouble in bind mounts — rely on named volumes for Postgres data.
  - Migrations partially applied after a failure — apply each file in a transaction; never edit an applied migration, add a new one instead.
  - Forgetting `CHECK (stock_quantity >= 0)` — it is a backstop invariant for oversell bugs.
  - `pg` returning `BIGINT`/`NUMERIC` as strings — convert once, at the query boundary, and keep paise integral.

---

## Phase 2 — Catalog availability and transactional stock reservations

- **Scope:** `GET /products` and `POST /orders` with concurrency-safe, all-or-nothing reservations.
- **Dependencies:** Phase 1.
- **Deliverables:**
  - `GET /products` → `[{ id, name, pricePaise, availableUnits }]`, where `availableUnits` implements invariant I4 (pending, unexpired holds only).
  - `POST /orders` accepting `{ items: [{ productId, quantity }] }` (zod-validated: known UUIDs, `quantity` integer ≥ 1, non-empty array, bounded item count).
    - Duplicate `productId`s in one request are consolidated (summed) into a single line; over-strict alternatives are documented if chosen instead.
    - Transaction: lock all referenced `products` rows `FOR UPDATE` in ascending `product_id` order → compute availability for all lines → insert `orders` + `order_lines` with server-computed `total_paise` (from `products.price_paise` at execution time, never client-supplied) and `expires_at = now() + interval '… seconds'` → commit.
    - Insufficient stock on **any** line ⇒ `409 CONFLICT` (code `INSUFFICIENT_STOCK`, per-line details), zero rows written.
  - Response includes `expiresInSeconds` computed from the DB clock at response time (invariant I2), plus `totalPaise` and line echoes.
  - Basic integration tests for the happy path, validation failures, and the multi-product all-or-nothing case (the big concurrency scenarios land in Phase 6, but basic tests must exist here).
- **Commands:** `npm test`, `npm run -w apps/api seed`, manual `curl` of both endpoints.
- **Exit criteria:**
  - [ ] Availability excludes expired holds (test: create an order with a tiny TTL, wait past expiry, assert `availableUnits` restored before any status flip).
  - [ ] A two-product request where only one product has stock reserves neither.
  - [ ] No code path decrements `stock_quantity` in this phase.
  - [ ] Concurrent-creation smoke test (e.g., 5 parallel requests for 1 unit) shows exactly one success.
- **Common failure modes:**
  - Checking availability without `FOR UPDATE`, then inserting — the classic oversell window.
  - Lock ordering inconsistent between code paths — any multi-product path must sort by `product_id`.
  - Reading `now()` in Node for `expires_at` — forbidden (I2).
  - Returning `expiresInSeconds` from a stale variable instead of a fresh DB computation.

---

## Phase 3 — Order lifecycle and expiration handling

- **Scope:** Status retrieval and expiration transitions; make every state observable and reachable.
- **Dependencies:** Phase 2.
- **Deliverables:**
  - `GET /orders/:id` → `{ id, status, totalPaise, expiresInSeconds, items: [...], paidAt?, pickedUpAt?, needsReviewReason? }`.
  - **Lazy expiration:** any operation that loads an order first flips `pending` orders with `expires_at <= now()` to `expired` (single guarded `UPDATE … WHERE status='pending' AND expires_at <= now()` inside the transaction that reads it). Availability (I4) remains independent of this flip so a not-yet-flipped expired hold is still invisible to other buyers.
  - Re-assert: `expired` is terminal; a later payment cannot resurrect it (handled fully in Phase 4).
  - Integration tests: hold expiry flips status; expired orders report `expiresInSeconds = 0`; concurrent status reads stay consistent.
- **Commands:** `npm test`; manual: create order, watch `GET /orders/:id` become `expired`.
- **Exit criteria:**
  - [ ] An unpaid order becomes `expired` without any background job (deterministic, test-friendly).
  - [ ] Expiry uses DB time; a deliberately skewed process clock changes nothing (inspection + test using SQL-set `expires_at`).
  - [ ] `GET /orders/:id` never returns an internal error for unknown IDs (clean `404 NOT_FOUND`).
- **Common failure modes:**
  - A cron/sweep-based expiration that makes tests flaky — rejected in favor of lazy flips + formula exclusion.
  - Non-guarded status updates (no `AND status='pending'`) that let two paths both "expire" or un-expire an order.

---

## Phase 4 — Signed payment webhook, dedup, amount validation, late payments, sender script

- **Scope:** `POST /payments/webhook` end to end, including idempotency and the conservative money policy.
- **Dependencies:** Phase 3 (order states to transition).
- **Deliverables:**
  - Raw-body middleware on this route only (`express.raw({ type: 'application/json' })`) mounted before global JSON parsing; the signature is computed over the exact received bytes (I8).
  - `X-Signature` validation: reject missing (`401`), non-hex or wrong length (`401`), mismatched HMAC (`401`), all with the error envelope and no order-state side effects. Comparison via `crypto.timingSafeEqual` after format checks.
  - Body schema (zod): `eventId` (non-empty string), `orderId` (UUID), `amountPaise` (non-negative integer), `status` (e.g. `captured` | `failed` — enumerated).
  - Processing pipeline inside one transaction:
    1. `INSERT … ON CONFLICT (event_id) DO NOTHING` into `payment_events`; if no row inserted ⇒ duplicate ⇒ return `200` with `outcome: "duplicate"` and change nothing (I7).
    2. Lock the order `FOR UPDATE`. Unknown order ⇒ record `outcome: "unknown_order"`, `200` (acknowledge; retrying can't fix it — I9).
    3. Unsupported event status ⇒ `outcome: "ignored_status"`, `200`, no transition.
    4. `amountPaise !== total_paise` ⇒ order → `needs_review` (`needs_review_reason = 'amount_mismatch'`), event `outcome: "amount_mismatch"`, `200`. Never fulfill.
    5. Valid capture, amount matches, order `pending` with hold still valid ⇒ → `paid` (`paid_at = now()`), event `outcome: "paid"`, `200`.
    6. Valid capture but order already `expired` (late payment) ⇒ → `needs_review` (`needs_review_reason: 'late_payment'`), persist expected/received amounts and timestamps for reconciliation; **no** restock, **no** fulfillment (I9). Document that a real provider integration would now call the refund API or open a manual ticket.
    7. Order already `paid`/`picked_up`/`needs_review` ⇒ no regression (I6); event recorded with outcome reflecting the no-op.
  - `npm run -w apps/api send-webhook -- --order <uuid> --amount <paise> --status captured [--event-id <id>] [--secret <s>]` — script that computes the HMAC over the serialized body with `WEBHOOK_SECRET` and POSTs it; prints HTTP status and response body. Also supports `--body-file` for replaying exact bytes.
  - Integration tests: valid capture; missing/malformed/bad signature; replayed event (sequential + concurrent) processes once; amount mismatch; late payment; unknown order; unsupported status.
- **Commands:** `npm test`; manual: create an order, then `npm run -w apps/api send-webhook -- --order <id> --amount <total> --status captured`, poll `GET /orders/:id` → `paid`.
- **Exit criteria:**
  - [ ] Every rejection path leaves `orders` and `payment_events` untouched except the intended record.
  - [ ] Replaying an identical event twice yields one `payment_events` row and one transition.
  - [ ] Signature verification demonstrably uses the raw bytes (inspection of middleware order).
- **Common failure modes:**
  - Signing the parsed JSON body — signature breaks whenever serialization differs (whitespace, key order). Always the raw buffer.
  - Trusting `req.body` before verifying — never read business fields before the HMAC check.
  - Treating HTTP `4xx/5xx` as the dedup mechanism instead of the DB constraint.
  - Using `orderId` from the body to upsert blindly without checking current status.

---

## Phase 5 — Atomic pickup claims and permanent inventory deduction

- **Scope:** `POST /orders/:id/pickup-claim` and exactly-once stock deduction.
- **Dependencies:** Phase 4 (orders must be able to reach `paid`).
- **Deliverables:**
  - Claim transaction (I10): lock order `FOR UPDATE` → status must be `paid` (else `409` with codes `ORDER_NOT_PAID` / `ORDER_ALREADY_CLAIMED` / `ORDER_EXPIRED` as appropriate, or `404` for unknown) → `UPDATE orders SET status='picked_up', picked_up_at = now()` → decrement `stock_quantity` for each line in the same transaction.
  - The decrement is guarded by the status flip, so it can happen at most once per order even under retry storms (add a `CHECK (stock_quantity >= 0)`-backed update; a constraint violation here is a bug, not a retry signal).
  - Integration tests: happy claim; claim on `pending`/`expired`/`needs_review` rejected; second claim after success → `409`; **two truly concurrent claims → exactly one 200 and one 409, stock decremented exactly once** (mandatory scenario 3).
- **Commands:** `npm test`; manual: pay an order via the sender script, claim it twice, observe `409` on the second.
- **Exit criteria:**
  - [ ] Mandatory concurrency scenario 3 passes repeatedly (loop the test ≥10 iterations in a soak run).
  - [ ] Physical stock after claim equals stock before order creation minus picked-up quantity (asserted in test).
  - [ ] No other code path writes `stock_quantity` (inspection).
- **Common failure modes:**
  - Checking status, then updating in a second statement without a lock — two claims both pass the check.
  - Decrementing stock before confirming the status transition.
  - Using an application-level mutex — meaningless with multiple processes/containers.

---

## Phase 6 — Real-PostgreSQL concurrency and integration test suite

- **Scope:** The three mandatory scenarios at full strength, plus suite hardening. (Basic tests are written alongside Phases 2–5; this phase makes them a gate.)
- **Dependencies:** Phases 1–5.
- **Deliverables:**
  - Vitest setup: global setup that creates/migrates a **dedicated test database** from `TEST_DATABASE_URL`, truncates between tests, per-test transaction or cleanup helper; `pool` sized ≥ the concurrency used in tests (10-way scenario needs ≥10 connections — size the Postgres `max_connections` and the pool accordingly, or serialize scenarios that share one pool).
  - **Mandatory test 1 — last-two-units race:** seed/arrange a product with exactly 2 units; fire **10 concurrent** `POST /orders` for 1 unit each; assert exactly 2 succeed, exactly 8 fail with a clean insufficient-stock error, reserved-quantity sum across successful orders equals 2, `stock_quantity` unchanged, and availability ends at 0 with no negative anywhere.
  - **Mandatory test 2 — webhook replay:** deliver the same signed event twice (also a concurrent double-delivery variant); assert a single `payment_events` row, one `pending → paid` transition, and that a replay after `picked_up` does not regress the order.
  - **Mandatory test 3 — concurrent pickup claims:** two simultaneous claims; assert exactly one success, one `409`, stock decremented exactly once.
  - Supporting tests: signature rejection matrix, amount mismatch, late payment, multi-product all-or-nothing, duplicate line consolidation, validation failures, expired-hold availability.
  - `npm test` orchestrates unit + integration; `npm run test:integration` runs DB-backed tests only; plain `npm test` fails loudly (not silently skips) when `TEST_DATABASE_URL` is unreachable.
- **Commands:** `docker compose up -d db && npm run -w apps/api migrate && npm test`
- **Exit criteria:**
  - [ ] All three mandatory scenarios pass, and the concurrency tests pass in a ≥10-iteration soak loop.
  - [ ] No test mocks the database; no `.skip`/`.only` anywhere.
  - [ ] Suite runs green twice in a row from a reset database (no inter-test leakage).
- **Common failure modes:**
  - Connection-pool starvation masquerading as a deadlock (`TimeoutError: Pool Resource exhausted`) — raise pool size or run scenarios sequentially.
  - Tests sharing one database without truncation — order-dependent flakes.
  - Asserting on timing ("took < 500 ms") instead of state.
  - A "concurrent" test that actually awaits requests sequentially — use `Promise.all` over genuinely simultaneous calls (or `pgbench`-style barrier).

---

## Phase 7 — React customer screen, countdown, polling

- **Scope:** A simple, functional storefront + order screen. No design system, no router sprawl unless needed.
- **Dependencies:** API from Phases 2–5.
- **Deliverables:**
  - `apps/web` (Vite + React + TS): product list with `availableUnits`, add-to-cart with quantity controls, place-order flow that surfaces the error envelope on failure (esp. `INSUFFICIENT_STOCK`).
  - Order screen: order summary with `totalPaise`, payment instructions (how to trigger the provider payment / run the sender script in this demo), and a countdown.
  - **Countdown (I12):** initialize from the server's `expiresInSeconds`; tick by measuring elapsed monotonic time (`performance.now()` deltas or a schedule anchored to receipt time), never by subtracting `Date.now()` from a stored wall-clock instant; re-sync on every poll response.
  - **Polling:** `GET /orders/:id` every ~2 s until status ∈ {`paid`, `expired`, `needs_review`}; render the matching outcome (paid ⇒ "head to the locker, claim code …"; expired ⇒ offer to re-order; needs_review ⇒ "payment under review, no action needed"). Stop polling on terminal statuses. The timer never decides the outcome — the server does.
  - Docker Compose extended so `docker compose up --build` starts db + api + web and the app is usable in a browser end-to-end.
- **Commands:** `docker compose up --build`, then manual walkthrough: browse → cart → order → countdown → webhook → UI flips to paid → claim → picked up.
- **Exit criteria:**
  - [ ] Full manual happy path works in a browser with the system clock deliberately shifted ±10 minutes (countdown still correct; only the server's numbers drive it).
  - [ ] Insufficient stock and expired-order paths show honest messages.
  - [ ] No console errors; polling stops on terminal states.
- **Common failure modes:**
  - Countdown derived from `new Date(expiresAt)` arithmetic — breaks on skewed clocks; forbidden.
  - Polling forever after `expired` — must stop on terminal statuses.
  - CORS misconfig between Vite dev server and API — document the proxy/origin setup.

---

## Phase 8 — README, AI notes, clean-clone verification, final submission audit

- **Scope:** Documentation truth-up and a from-scratch verification pass.
- **Dependencies:** All previous phases.
- **Deliverables:**
  - `README.md` rewritten to describe reality: prerequisites, setup, architecture, commands, assumptions, decisions, **late-payment policy**, tests, limitations, future improvements. Status section updated; "planned" labels removed only where the feature now exists.
  - `AI_NOTES.md` completed with the actual tools, one effective prompt, one real AI mistake and how it was caught, and the human verification performed. Nothing fabricated.
  - `ACCEPTANCE_CRITERIA.md` cross-checked: every criterion marked proven (test ID / manual step / inspection) with the command that proved it.
  - Clean-clone audit: in a fresh directory — `git clone <repo> && cd <repo> && cp .env.example .env && npm install && docker compose up -d db && npm run -w apps/api migrate && npm run -w apps/api seed && npm test && docker compose up --build` — every step works exactly as documented.
  - Security sweep: `git log -p | grep -iE "secret|password|webhook_secret"` finds nothing real; `.env` untracked; no build artifacts committed.
- **Commands:** the clean-clone sequence above, plus `npm run typecheck && npm run lint && npm run format:check && npm test`.
- **Exit criteria:**
  - [ ] Clean clone passes every documented step with no manual fix-ups.
  - [ ] README contains no claim that isn't backed by a command or test in this repo.
  - [ ] All `ACCEPTANCE_CRITERIA.md` rows have a proof method; failures/limitations are stated openly.
  - [ ] Final commits focused and pushed (or push commands handed to the human).
- **Common failure modes:**
  - README drift — documenting flags/commands that don't exist; the clean-clone run catches this, so actually run it.
  - "Green on my machine" — the audit must use the documented environment only.
  - Quietly downgrading a failed criterion instead of reporting it.

---

## Cross-phase rules

1. **One phase at a time**, in order; do not start Phase N+1 deliverables while Phase N exit criteria are unproven.
2. Every code change ships with the tests that demonstrate it; the "big" concurrency tests are Phase 6, but nothing reaches Phase 6 untested.
3. Update `README.md` Status and this plan's checkboxes in the same commit that completes the work.
4. If an invariant in `AGENTS.md` proves wrong in practice, change `AGENTS.md` deliberately and record the reason — never just route around it.
5. Record every real AI mistake you catch in `AI_NOTES.md` when it happens, while the details are fresh.
