# IMPLEMENTATION_PLAN.md — Pickup Counter Build Plan

This is the authoritative, phase-by-phase plan for building the pickup counter.
Work proceeds strictly phase by phase: **a phase's exit criteria must be demonstrated before the next phase begins.** Update the checkboxes and the Status column in `README.md` in the same change that completes a phase.

- Baseline specification: `ACCEPTANCE_CRITERIA.md` (derived from the assignment).
- Engineering invariants and conventions: `AGENTS.md`.
- Current status: **Phases 1–4 complete (signed payment webhook with raw-body HMAC, DB-enforced idempotency, amount/late-payment policy verified against real PostgreSQL). Phase 5 (pickup claims) is next.**

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
  - [x] Availability excludes expired holds (test: create an order with a tiny TTL, wait past expiry, assert `availableUnits` restored before any status flip). _(T-AVAIL-02: expired hold while order still `pending`; availability fully restored — no sleeps, DB-clock timestamps.)_
  - [x] A two-product request where only one product has stock reserves neither. _(T-ORDER-05: 2/5 available + 3/1 requested → 409, zero lines, zero orders.)_
  - [x] No code path decrements `stock_quantity` in this phase. _(Inspection + T-CONC-01 asserts physical stock unchanged after reservations.)_
  - [x] Concurrent-creation smoke test (e.g., 5 parallel requests for 1 unit) shows exactly one success. _(Exceeded by T-CONC-01: 10 parallel requests for a 2-unit product, exactly 2 winners — 5 rounds per run × 4 runs; plus T-LOCK-01 reversed-order pairs: exactly one winner, no deadlocks.)_

  **Recorded during implementation:**
  - The first implementation computed availability **in the same statement** as the `FOR UPDATE` lock. That statement's READ COMMITTED snapshot predates the lock wait, so all ten racers saw pre-competitor availability and every one oversold — the integration tests caught it, and availability now runs as a separate post-lock statement (the plan's design all along; the code briefly deviated). See `AI_NOTES.md`.
  - `vitest` now sets `fileParallelism: false`: integration files share one test database and reset its schema in `beforeAll`, so parallel files dropped the schema under each other. Also recorded in README/AGENTS.
  - No schema change was needed: `0001_init.sql` already supported reservations (availability formula, five-state machine, `orders(status, expires_at)` index). No `0002` migration exists.

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
  - [x] An unpaid order becomes `expired` without any background job (deterministic, test-friendly). _(T-EXPIRY-01 + T-STATUS-03/04: DB-clock expiry via SQL-set timestamps; flip happens at both observation points — creation sweep and status read.)_
  - [x] Expiry uses DB time; a deliberately skewed process clock changes nothing (inspection + test using SQL-set `expires_at`). _(Inspection: every expiry decision is a `now()` comparison in SQL; no Node clock is read anywhere in the lifecycle path. Countdown follows the stored deadline: shrink `expires_at` to 5 s → read ≈5, T-STATUS-09.)_
  - [x] `GET /orders/:id` never returns an internal error for unknown IDs (clean `404 NOT_FOUND`). _(T-STATUS-02: 404 `ORDER_NOT_FOUND`; T-STATUS-08: non-UUID → 400 `VALIDATION_ERROR`; live smoke on compiled dist confirms both.)_

  **Recorded during implementation:** two defects were found in the new test code itself on the first run (a wrong expected total — the fixture's default price is 1500, not 2500 — and a `WHERE id = ANY($1)` binding passed as three parameters instead of one array). Both were fixed in the tests; the endpoint implementation passed on its first run. Logged in `AI_NOTES.md`. No schema change was needed; no `0002` migration exists.

- **Common failure modes:**
  - A cron/sweep-based expiration that makes tests flaky — rejected in favor of lazy flips + formula exclusion.
  - Non-guarded status updates (no `AND status='pending'`) that let two paths both "expire" or un-expire an order.

---

## Phase 4 — Signed payment webhook, dedup, amount validation, late payments, sender script

- **Scope:** `POST /payments/webhook` end to end, including idempotency and the conservative money policy.
- **Dependencies:** Phase 3 (order states to transition).
- **Deliverables:**
  - Raw-body middleware on this route only (`express.raw({ type: 'application/json' })`) mounted before global JSON parsing; the signature is computed over the exact received bytes (I8).
  - `X-Signature` validation: reject missing (`400 MISSING_SIGNATURE`), non-hex or wrong length (`400 SIGNATURE_INVALID`), mismatched HMAC (`401 SIGNATURE_INVALID`), all with the error envelope and no order-state side effects. Comparison via `crypto.timingSafeEqual` after a `/^[0-9a-f]{64}$/` format check (I8).
  - Body schema (validated inline in `parseWebhookPayload`): `eventId` (non-empty string), `orderId` (non-empty string), `amountPaise` (non-negative integer), `status` (non-empty string). Note: `orderId` is validated as a non-empty string, not a strict UUID, so the ledger can still record events referencing a malformed/unknown order as `unknown_order` (C9) rather than 400-ing before the dedup insert.
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
  - [x] Every rejection path leaves `orders` and `payment_events` untouched except the intended record. _(Verified: signature failures, missing/malformed signature, unsupported status, and unknown order each produce no order-state change; only the single `payment_events` row with the matching outcome is written.)_
  - [x] Replaying an identical event twice yields one `payment_events` row and one transition. _(T-IDEM-01 + T-IDEM-02: sequential and 10-way concurrent duplicate collapse to 1 row / 1 transition; soak looped the webhook file 10× consecutively, 10/10 green on real PostgreSQL.)_
  - [x] Signature verification demonstrably uses the raw bytes (inspection of middleware order). _(Inspection: `express.raw({type:'application/json'})` is mounted for `/payments/webhook` before the global `express.json()` in `app.ts`; T-WH-02 signs canonical JSON then sends re-formatted bytes and is rejected `401`.)_

  **Recorded during implementation (Phase 4 recovery):**
  - The prior attempt left `src/webhook.ts`, `src/app.ts` and `tests/webhook.integration.test.ts` in a corrupted state (duplicated/partial `import … as any;` lines that are not valid TypeScript, and the "test" file was actually a stale copy of an older webhook source rather than a test). These were reconstructed cleanly rather than patched line-by-line.
  - Two real correctness bugs were fixed during the repair: (1) the handler read/wrote `payment_events.provider_status` and `received_amount_paise`, columns that do not exist in `0001_init.sql` — removed, since `status` and `amount_paise` already carry the provider status and received amount; (2) late-payment detection compared `expires_at` to `new Date()` (a Node clock, violating I2) and attempted a `pending→expired→needs_review` double flip where the second guarded `UPDATE … WHERE status='pending'` could never match — replaced with a single DB-clock `needs_review('late_payment')` transition.
  - The `send-webhook` sender script (C14) was NOT built in this pass; the webhook is exercised directly by integration tests that construct and sign the requests in-process. Tracked as PLANNED in `ACCEPTANCE_CRITERIA.md`. _(Completed in the final audit: `src/webhook-sender.ts` + `src/send-webhook.ts` CLI, T-SEND-01/02, live-verified — see the Phase 7 / final-audit note below.)_

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
  - [x] Mandatory concurrency scenario 3 passes repeatedly (loop the test ≥10 iterations in a soak run). _(T-CONC-02 loops 10 rounds per run — two `Promise.all` claims on one paid order each round; the pickup file then passed **10 consecutive runs** against real PostgreSQL 18.4, i.e. 100 concurrent-claim rounds: every round exactly one 200 + one 409 `ORDER_ALREADY_CLAIMED`, stock decremented exactly once.)_
  - [x] Physical stock after claim equals stock before order creation minus picked-up quantity (asserted in test). _(T-PICK-01: 5 − 2 = 3 after claiming a 2-unit paid order, with creation/payment asserted to leave stock at 5; T-PICK-03 multi-product: 4→2 and 3→2 with `order_lines` unchanged. Post-run DB inspection reconstructed `physical + Σ picked-up line quantities = seeded initial` for every product in the run — no double or missing deduction.)_
  - [x] No other code path writes `stock_quantity` (inspection). _(`grep -E "UPDATE products|stock_quantity\\s*=" apps/api/src/` → only the claim's guarded decrement in `routes/orders.ts` and the seed's first-time INSERT, which never rewrites existing stock; no test writes it either.)_
- **Recorded during implementation (Phase 5):**
  - The first `claimOrder` ran the lazy `pending → expired` flip inside the claim transaction, but every rejected claim rolls back — so the flip was always undone while the endpoint still answered `ORDER_EXPIRED`. T-PICK-02 caught it (`expected 'pending' to be 'expired'`). Resolved by making rejected claims strictly read-only: the locking `SELECT … FOR UPDATE` carries `(expires_at <= now()) AS is_expired` (database clock) and the gate uses it directly; expiry materialization stays with the two established observation points.
  - **Amendment to the deliverable's error set:** besides the planned `ORDER_NOT_PAID` / `ORDER_ALREADY_CLAIMED` / `ORDER_EXPIRED` / 404, the claim adds a guarded physical-stock check answering `409 INSUFFICIENT_STOCK` (`details.shortages`) before the flip. Reason: the I4 availability formula excludes already-`paid` orders, so two paid orders CAN cover the same units (T-PICK-05 reproduces this through the public API); without the guard the second claim would hit the `CHECK (stock_quantity >= 0)` backstop as a 500 instead of a deterministic conflict. Success is `200` echoing the `GET /orders/:id` shape.
  - T-PICK-06 fault-injects a real PostgreSQL exception (trigger on the decrement UPDATE) to prove the flip and the deduction roll back together; the retry after removing the fault deducts exactly once.
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
  - [ ] Full manual happy path works in a browser with the system clock deliberately shifted ±10 minutes (countdown still correct; only the server's numbers drive it). _(**NOT RUN — human step:** deliberately shifting the machine's OS clock was left to the reviewer. The countdown's clock-independence is verified by inspection: `performance.now()` anchors + server re-sync, no `Date.now()` arithmetic.)_
  - [x] Insufficient stock and expired-order paths show honest messages. _(Browser-verified in the final audit: `INSUFFICIENT_STOCK — … nothing was reserved (3 requested / 0 available)` on a held-out product, and `The hold expired before payment arrived…` + re-order button after a DB-aged hold flipped via the poll.)_
  - [x] No console errors; polling stops on terminal states. _(Network log: order GETs every 2 s stop at the paid/expired/needs_review flip — only the claim POST follows; console shows vite/React-devtools lines plus one browser-native `Failed to load resource: 409` for the deliberately triggered rejection, which the app rendered as its banner; zero application/JS errors.)_
- **Recorded during the final audit (no new phase opened):**
  - The Phase 1 placeholder `App.tsx` (health badge only) was replaced with the customer screen above; `index.css` extended; a failed placement now refreshes the catalog so displayed availability follows the server.
  - Browser walkthrough against the **compiled** API (`node apps/api/dist/server.js`) + Vite dev covered: catalog → cart → `201` with server total → countdown → `send-webhook` → `paid` (≤2 s, polling stopped) → **Confirm pickup** → `picked_up` with DB stock 35→34 exactly once → expired banner → `needs_review` banner → insufficient-stock banner. Zero app console errors.
  - C14 `send-webhook` built and live-tested (correct amount → `HTTP 200 {"received": true}`; wrong amount → `2xx AMOUNT_MISMATCH` → `needs_review`).
  - Docker/Compose: added the `web` service (nginx proxy) and `apps/web/Dockerfile`; also fixed the Phase 1 `CMD ['node', …]` single-quoted exec form in `apps/api/Dockerfile` (Docker's JSON form requires double quotes — found by inspection). **All Docker paths remain NOT RUN: `docker: command not found` on this machine.**
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
  - Clean-clone audit: in a fresh directory — `git clone <repo> && cd <repo> && cp .env.example .env && npm install && docker compose up -d db && npm run -w apps/api migrate && npm run -w apps/api seed && npm test && docker compose up --build` — every step works exactly as documented. _(Final audit: the non-Docker steps were executed from a fresh clone of `2124a1c` and all pass — see ACCEPTANCE G3 — while the two `docker compose` steps remain **NOT RUN** (no Docker on this machine). Two defects were found and fixed en route: CRLF checkouts failing `format:check` (now `.gitattributes` pins LF), and workspace entry points ignoring the root `.env` (now an INIT_CWD-aware loader).)_
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
