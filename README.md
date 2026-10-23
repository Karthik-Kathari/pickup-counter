# pickup-counter

A full-stack, self-service **snack pickup counter**: customers reserve snacks from a short catalog, holds expire after two minutes, payment is confirmed through a **signed webhook**, and a pickup/locker endpoint claims paid orders — atomically, without ever overselling.

> ## Current status — Phases 1–5 complete ✅
>
> Implemented and verified against **real PostgreSQL 18.4**: the Phase 1 foundation (monorepo, zod config, migrations, seed, health), the Phase 2 catalog and transaction-safe order reservations, the Phase 3 order-status endpoint `GET /orders/:id` with a hardened lazy-expiration lifecycle, the Phase 4 signed & idempotent payment webhook, and the Phase 5 atomic pickup claim `POST /orders/:id/pickup-claim` — mandatory concurrency scenario 3 (two simultaneous claims ⇒ exactly one winner) is implemented and soak-tested. **Docker was not available on the development machine**, so `docker compose up --build` has been written and reviewed but not executed — run it on a Docker-capable machine.
>
> Not built yet: the customer UI (Phase 7) and the `send-webhook` sender script (C14). See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

---

## Project goals

- Reserve stock for ~120 seconds at order time without ever overselling, even under concurrency.
- Confirm payment via an HMAC-SHA256-signed webhook that is **idempotent** under duplicate delivery.
- Fulfill (pick up) paid orders exactly once, deducting physical stock permanently exactly once.
- Keep every rule explainable in a 45-minute interview: explicit SQL, explicit transactions, no magic.

## Prerequisites

- **Node.js 20+** (developed and verified on v24.15.0) with npm 11+
- **Docker + Docker Compose** — one-command PostgreSQL + API (not available on the machine where Phase 1 was implemented, so Compose is written but unexecuted there)
- No local PostgreSQL install is required when using Compose

## Quick start

```bash
cp .env.example .env            # local defaults; nothing to edit for a first run
npm install
docker compose up --build       # db + one-shot migrate/seed + api (port 3001)
curl -s http://localhost:3001/health   # → {"status":"ok","database":"connected"}
```

Without Docker (any machine with Node + a reachable PostgreSQL):

```bash
cp .env.example .env            # point DATABASE_URL at your PostgreSQL
npm install
npm run migrate                 # applies apps/api/migrations/*.sql (idempotent)
npm run seed                    # inserts 5 products (idempotent; never resets stock)
npm run dev                     # API on http://localhost:3001
npm run dev:web                 # web starter on http://localhost:5173 (proxies /health etc.)
```

## Environment configuration

All variables are documented in [`.env.example`](./.env.example). The API validates them at startup with zod ([`apps/api/src/config.ts`](./apps/api/src/config.ts)) and **fails fast** with a message listing every problem — values are never echoed (they can contain secrets).

| Variable                                                                | Purpose                                                          | Default (dev only)                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                                                          | Application PostgreSQL connection string                         | `postgres://postgres:postgres@localhost:5432/pickup_counter` |
| `TEST_DATABASE_URL`                                                     | Separate DB for integration tests (never defaults to the dev DB) | — (required for `npm test`)                                  |
| `API_PORT`                                                              | Express listen port                                              | `3001`                                                       |
| `NODE_ENV`                                                              | `development` \| `test` \| `production`                          | `development`                                                |
| `HOLD_TTL_SECONDS`                                                      | Unpaid-order hold window                                         | `120`                                                        |
| `WEBHOOK_SECRET`                                                        | HMAC-SHA256 shared secret for payment webhooks                   | `change-me-local-dev-secret` (dev only)                      |
| `VITE_API_BASE_URL`                                                     | Frontend: API origin (used by the Vite dev proxy)                | `http://localhost:3001`                                      |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Compose `db` service settings                                    | `postgres` / `postgres` / `pickup_counter` / `5432`          |

In **production** (`NODE_ENV=production`) `DATABASE_URL` and `WEBHOOK_SECRET` must be set explicitly, the secret must be ≥ 16 characters, and the dev placeholder is rejected. The webhook secret is server-side only — it never reaches the frontend (the web app talks same-origin through the Vite proxy).

## Commands

| Command                                 | What it does                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm install`                           | Install workspace dependencies (generates `package-lock.json`)                                           |
| `npm run dev` / `npm run dev:web`       | API (watch mode) / web starter (Vite)                                                                    |
| `npm run build`                         | Build both apps (`tsc` for the API, `tsc && vite build` for web)                                         |
| `npm run typecheck`                     | Strict TypeScript across both workspaces                                                                 |
| `npm run lint` / `npm run format:check` | ESLint 10 (typescript-eslint) / Prettier                                                                 |
| `npm test`                              | Vitest: unit + real-PostgreSQL integration tests (`TEST_DATABASE_URL` required; fails loudly without it) |
| `npm run migrate`                       | Apply pending SQL migrations (advisory-locked, checksummed)                                              |
| `npm run seed`                          | Insert/refresh 5 products (never resets consumed stock)                                                  |
| `docker compose up --build`             | PostgreSQL + one-shot migrate/seed + API                                                                 |
| `docker compose down`                   | Stop (named volume keeps the data)                                                                       |

## Architecture

```text
pickup-counter/
├── apps/
│   ├── api/                  Express + TypeScript (ESM) + pg
│   │   ├── migrations/       NNNN_name.sql, applied in order, recorded in schema_migrations
│   │   ├── src/config.ts     zod-validated env, fail-fast, no value echoing
│   │   ├── src/db/           pool factory, advisory-lock migration runner + CLI
│   │   ├── src/seed/         idempotent seed + CLI
│   │   ├── src/routes/       /health, /products, /orders
│   │   ├── src/orders/       lazy-expiry lifecycle helper
│   │   └── tests/            unit + real-PG integration suites (helpers, catalog, orders, webhook, pickup)
│   └── web/                  React + Vite starter (Phase 7 builds the real UI)
├── docker/init/              first-boot SQL: creates the integration-test database
├── docker-compose.yml        db + one-shot init (migrate & seed) + api, health-gated
└── (root configs)            tsconfig.base.json, eslint, prettier, vitest
```

Core decisions (rationale in [`AGENTS.md`](./AGENTS.md) §3):

- **Money** is integer **paise** everywhere (`BIGINT` columns with CHECKs; no floats anywhere). Totals are computed **in SQL** from `products.price_paise` at execution time; client-supplied prices are ignored; `BIGINT` results are cast to `int` before crossing the JSON boundary.
- **Time** comes from the database clock only; `expires_at` is computed in SQL (`now() + make_interval(secs => ttl)`), and `expiresInSeconds` is computed from the DB clock in a query **after** the order transaction commits — not hardcoded (verified: a server configured with TTL 30 returns ≈30).
- **Availability** = physical stock − quantities held by _pending, unexpired_ orders, computed by one SQL expression with `GREATEST(…, 0)` so it can never be negative. Expired holds never count, regardless of whether their order's status row has been flipped yet. `stock_quantity` is only permanently reduced by a successful pickup claim — `CHECK (stock_quantity >= 0)` is the database-level backstop.
- **Reservations**: `POST /orders` locks product rows `FOR UPDATE` in ascending product_id order inside one transaction; availability is computed in a **later statement** (fresh READ COMMITTED snapshot — the crux that prevents overselling); all lines or none.
- **Idempotency** is database-enforced: `payment_events.event_id` is a primary key; events are inserted before any side effect (Phase 4).
- **Order state machine** is encoded in the schema: `status` CHECK over the five states plus coherence checks tying `paid_at` / `picked_up_at` / `needs_review_reason` to the state.

### Schema (0001_init)

- `products` — uuid PK, stable `key` (seed upsert target), `price_paise > 0`, `stock_quantity >= 0`
- `orders` — five-state CHECK (`pending`, `paid`, `expired`, `needs_review`, `picked_up`), `total_paise`, DB-generated `expires_at`, state↔timestamp coherence CHECKs
- `order_lines` — FKs to orders/products, `quantity > 0`, `unit_price_paise > 0`, unique `(order_id, product_id)`
- `payment_events` — `event_id` PK (provider idempotency), payload JSONB, processing outcome, timestamps

**Recorded deviations and why:**

1. **`payment_events.order_id` has no foreign key.** The webhook must record events for orders we don't know (acceptance criterion C9) and the ledger must survive independently of order rows. Referential integrity is checked at processing time. (Amended in `IMPLEMENTATION_PLAN.md`.)
2. **Pickup claim state lives on the order** (`status='picked_up'` + `picked_up_at`), not a separate claims table: the Phase 5 transaction makes the status flip and the stock decrement atomic, so the flip _is_ the exactly-once claim record.
3. **Migrations are append-only, one transaction per file**, serialized by `pg_advisory_lock`, with SHA-256 checksums that detect edits to applied files. Limitation: no rollback files, and a single file cannot contain statements PostgreSQL forbids in transactions (e.g. `CREATE INDEX CONCURRENTLY`).
4. **Seed upserts by fixed UUID and never rewrites `stock_quantity`**, so re-seeding cannot silently reset inventory consumed by real orders (verified).

## HTTP API

All errors use one envelope: `{ "error": { "code", "message", "details"? } }`.

### `GET /products`

```json
{
  "products": [
    {
      "id": "6a4c8e2f-3d71-4b95-9e0a-1f8c2d6b4a39",
      "name": "Butter Cookies",
      "pricePaise": 3000,
      "stockQuantity": 35,
      "availableUnits": 34
    }
  ]
}
```

`availableUnits = GREATEST(stock_quantity − Σ pending-unexpired held quantity, 0)`, computed in one SQL statement with the database clock. `stockQuantity` is physical stock; a difference between the two is the reservation footprint.

### `GET /orders/:id`

Customer-facing status endpoint (the polling target for the Phase 7 UI). The id must be a UUID. Response `200`:

```json
{
  "order": {
    "id": "84a65028-c1ed-498c-90d8-d82ddb793a9b",
    "status": "pending",
    "totalPaise": 6000,
    "createdAt": "2026-10-22T12:00:00.000Z",
    "expiresAt": "2026-10-22T12:02:00.000Z",
    "expiresInSeconds": 119,
    "items": [
      {
        "productId": "…uuid…",
        "name": "Butter Cookies",
        "quantity": 2,
        "unitPricePaise": 3000,
        "lineTotalPaise": 6000
      }
    ]
  }
}
```

Status semantics and countdown rules:

- `pending` — the only status that carries `expiresInSeconds`: a non-negative integer computed from the **database clock in the same SELECT** that reads the status, so the two can never disagree. It reflects the remaining hold, not a constant (a TTL-30 server returns ≈30), and it **never increases** across reads: the deadline is immutable after creation and the database clock is monotonic.
- `expired` — the countdown field is **absent entirely** (an expired order never shows a positive countdown). `paid`/`picked_up` also carry no countdown; `paidAt` appears on `paid` and `picked_up`, `pickedUpAt` and `needsReviewReason` where applicable.
- Reading an order is an **observation point**: a targeted, guarded `UPDATE … WHERE id = $1 AND status = 'pending' AND expires_at <= now()` flips it to `expired` inside a short transaction before the read — row-level lock only, idempotent, no revival path, and `paid`/`needs_review`/`picked_up` can never match. Physical stock is never written.
- Items and totals survive expiration: the order is a historical record.

Errors: `400 VALIDATION_ERROR` (non-UUID id; `details[].path = "id"`), `404 ORDER_NOT_FOUND` (unknown id).

### `POST /orders`

Request (repeated productIds are consolidated by summing — documented policy, enforced by `UNIQUE (order_id, product_id)`):

```json
{ "items": [{ "productId": "…uuid…", "quantity": 2 }] }
```

Response `201` (with `Location: /orders/:id`):

```json
{
  "order": {
    "id": "11bbedb9-2909-450e-99ad-28384f5a1928",
    "status": "pending",
    "totalPaise": 6000,
    "expiresInSeconds": 119,
    "items": [
      {
        "productId": "…uuid…",
        "name": "Butter Cookies",
        "quantity": 2,
        "unitPricePaise": 3000,
        "lineTotalPaise": 6000
      }
    ]
  }
}
```

Errors:

| Status | Code                 | When                                                                                                          |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`   | Empty cart, non-UUID productId, quantity ≤ 0 / non-integer / > 99, > 20 lines (`details` lists field paths)   |
| 400    | `INVALID_JSON`       | Malformed JSON body                                                                                           |
| 404    | `PRODUCT_NOT_FOUND`  | Unknown product IDs (`details.missingProductIds`)                                                             |
| 409    | `INSUFFICIENT_STOCK` | Any line lacks availability — **nothing is reserved** (`details.shortages`: per-line requested vs. available) |

### `POST /orders/:id/pickup-claim`

The locker/fulfilment endpoint: claims a **paid** order and permanently deducts its units exactly once (I5/I10). No request body; the id must be a UUID.

Response `200` — the same shape as `GET /orders/:id`, with `status: "picked_up"` and `pickedUpAt` generated by the database clock:

```json
{
  "order": {
    "id": "…uuid…",
    "status": "picked_up",
    "totalPaise": 6000,
    "createdAt": "2026-10-23T12:00:00.000Z",
    "expiresAt": "2026-10-23T12:02:00.000Z",
    "paidAt": "2026-10-23T12:00:30.000Z",
    "pickedUpAt": "2026-10-23T12:01:10.000Z",
    "items": [
      {
        "productId": "…uuid…",
        "name": "Butter Cookies",
        "quantity": 2,
        "unitPricePaise": 3000,
        "lineTotalPaise": 6000
      }
    ]
  }
}
```

Errors — every rejection rolls the whole claim transaction back, so a rejected claim writes **nothing**:

| Status | Code                    | When                                                                                                |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`      | Non-UUID id (`details[].path = "id"`)                                                               |
| 404    | `ORDER_NOT_FOUND`       | Unknown id                                                                                          |
| 409    | `ORDER_NOT_PAID`        | Order is `pending` (hold still valid) or `needs_review`                                             |
| 409    | `ORDER_EXPIRED`         | Order is `expired`, or `pending` whose hold already elapsed (database clock)                        |
| 409    | `ORDER_ALREADY_CLAIMED` | Already `picked_up` — a repeat claim or the losing concurrent claim (mandatory scenario 3)          |
| 409    | `INSUFFICIENT_STOCK`    | Paid, but physical stock cannot cover the lines (`details.shortages` per product); nothing deducted |

Deterministic behavior: repeat claims always answer `409 ORDER_ALREADY_CLAIMED`, unknown ids `404`, ineligible states `409`, and under concurrent claims exactly one request ever observes `status = 'paid'` — the rest receive `409`.

### The reservation transaction (why it cannot oversell)

1. `BEGIN` (READ COMMITTED) — one guarded `UPDATE` lazily expires stale pending orders.
2. `SELECT id … ORDER BY id FOR UPDATE` — every referenced product row is locked; the deterministic order means competing transactions acquire the same locks in the same sequence → **no deadlocks**.
3. A **separate statement** computes availability. Because it runs after the locks are held, its fresh snapshot already includes every competing reservation committed while we waited — this is what eliminates the check-then-insert race. (An earlier version computed availability in the same statement as the lock; its pre-wait snapshot allowed all ten racers through, and the integration tests caught it.)
4. Any shortage → `ROLLBACK` → zero rows written; otherwise insert order + lines (server-calculated paise totals in SQL), `COMMIT`.
5. After commit, `expiresInSeconds` is read from the DB clock.

The 120-second hold (`HOLD_TTL_SECONDS`) is reservation-only: creating an order never touches `stock_quantity`. Availability instantly excludes holds whose `expires_at` has passed; the persisted `pending → expired` status flip happens lazily at the two observation points — order creation (global guarded sweep) and `GET /orders/:id` (targeted guarded update) — no background scheduler.

### The pickup-claim transaction (why exactly one claim wins)

1. `BEGIN` — one statement locks the order row: `SELECT …, (expires_at <= now()) AS is_expired … FOR UPDATE`. This is **the serialization point**: concurrent claimants queue on the row lock and, under READ COMMITTED, the loser re-reads the winner's committed row — so exactly one transaction can ever observe `status = 'paid'` (I10).
2. Eligibility gate on that locked snapshot, with the deadline read from the **database clock** (I2): `picked_up` → `ORDER_ALREADY_CLAIMED`, `expired` / stale `pending` → `ORDER_EXPIRED`, `pending` / `needs_review` → `ORDER_NOT_PAID`, unknown → `404`. Every rejection throws → `ROLLBACK`: a rejected or losing claim writes nothing at all. The claim is deliberately **not** an expiration observation point — `pending → expired` materialization stays with the two established points (order creation, `GET /orders/:id`).
3. The immutable `order_lines` are read unlocked, then every product row is locked `FOR UPDATE` in **ascending id order** — the same lock order as order creation, so claims and creations can never deadlock. A fresh snapshot after the locks checks physical stock (`stock_quantity ≥ Σ line quantity`); any shortfall answers `409 INSUFFICIENT_STOCK` with `details.shortages`. Such a shortfall is reachable because the I4 availability formula excludes already-`paid` orders, so a later order can cover units a paid order has not collected yet.
4. Guarded flip `paid → picked_up` (`picked_up_at = now()`, database clock; the held row lock makes the guard match exactly once even under concurrent claims), then the permanent decrement — one statement, one row per product, guarded by `AND stock_quantity >= claim_quantity`, with the schema `CHECK (stock_quantity >= 0)` as backstop. Any rowCount mismatch throws, so **the flip and the deduction commit together or not at all**.
5. `COMMIT`, then the response re-reads through the `GET /orders/:id` code path, so a successful claim returns byte-identical contract data to the status endpoint.

A genuine mid-transaction database failure is proven to roll both writes back by T-PICK-06: a trigger raises an exception during the decrement UPDATE, the API answers `500`, the order is still `paid` with `picked_up_at NULL`, stock is unchanged, and a retry after removing the fault succeeds with exactly one total deduction.

## Tests

Run with a real PostgreSQL: `TEST_DATABASE_URL` must point at a **disposable** database (Compose creates `pickup_counter_test` on first boot; integration tests `DROP SCHEMA` inside it). There is no mock fallback — without a reachable database the suite fails loudly. Test files run **serially** (`fileParallelism: false`): they share one test database and reset its schema in `beforeAll`.

Implemented (`apps/api/tests/`):

- `config.test.ts` — 13 unit tests for env validation.
- `migrations.integration.test.ts` — 4 integration tests: fresh apply, idempotent re-run, schema/constraints (all-`BIGINT` money, stock CHECK), DB-level state machine.
- `catalog.integration.test.ts` — 3 integration tests (T-CATALOG-01, T-AVAIL-01/02): documented JSON shape; pending holds reduce availability but not physical stock; expired holds never reduce availability even before the status flip.
- `orders.integration.test.ts` — 11 integration tests:
  - **T-CONC-01 (mandatory scenario 1)** — ten concurrent customers, last two units, repeated for 5 rounds per run: exactly 2 × 201, 8 × 409 `INSUFFICIENT_STOCK`, reserved exactly 2, availability 0, physical stock unchanged, zero orphaned lines or partial orders.
  - T-ORDER-05 — multi-item order with one insufficient line reserves nothing.
  - T-EXPIRY-01 — deterministic expiry via DB timestamps: availability restored immediately, lazy flip to `expired` on the next observation, no revival.
  - T-VALID-01..n — invalid bodies/quantities/UUIDs → 400; unknown product → 404; duplicate IDs consolidated; server-side pricing ignores client prices; `expiresInSeconds` follows server config (TTL 30 server returns ≈30) and stored hold is exactly 120 s of DB time.
  - T-LOCK-01 — two reversed-order concurrent multi-product orders: exactly one wins, no deadlocks, both products reserved once (5 rounds).
- `orders-lifecycle.integration.test.ts` — 8 integration tests for `GET /orders/:id` and the expiration lifecycle (T-STATUS-01..09): pending response contract (items, paise totals, ISO timestamps, countdown ≤ hold); unknown → 404; non-UUID → 400; expired hold flips on access while availability is restored by the formula and physical stock stays untouched; repeated reads and sweeps idempotent with a never-increasing countdown; `paid`/`needs_review`/`picked_up` never expired even with passed deadlines; 8 concurrent reads on an expired order stay consistent; countdown follows the stored deadline deterministically (no sleeps).

`webhook.integration.test.ts` — 14 integration tests for `POST /payments/webhook` (T-WH-01..11, T-IDEM-01..03): valid signed capture → `paid` with `paid_at`; signature checked over the exact raw bytes (canonical JSON re-formatted ⇒ `401`); missing signature → `400`, non-hex / wrong-length / wrong-secret rejected with no state change; amount mismatch and DB-clock late payment → `needs_review` (never paid, physical stock untouched); unknown order and unsupported status recorded and acknowledged `2xx`; duplicate and 10-way concurrent duplicate `eventId` collapse to one `payment_events` row and one transition (mandatory scenario 2 — the webhook file was soak-looped 10× green against real PostgreSQL).

`pickup.integration.test.ts` — 8 integration tests for `POST /orders/:id/pickup-claim` (T-PICK-01..06, T-CONC-02): happy claim on a `paid` order deducts each line exactly once with `pickedUpAt` from the database clock while creation/payment never touch stock; a multi-product claim deducts both lines once and leaves `order_lines` immutable; ineligible states (`pending`, `needs_review`, DB-clock-expired, unknown id, non-UUID id) and repeat claims are rejected deterministically with zero state change; **T-CONC-02 (mandatory scenario 3)** fires two genuinely simultaneous claims at the same paid order for 10 rounds per run — always exactly one `200` + one `409 ORDER_ALREADY_CLAIMED`, stock decremented exactly once; two different paid orders race for the last 2 units and end at stock 0 (never negative), and an over-committed paid order is answered `409 INSUFFICIENT_STOCK` with stock still 0; T-PICK-06 injects a real PostgreSQL exception during the decrement and proves the status flip and inventory change roll back together, then a retry succeeds exactly once. Soak: the file passed **10 consecutive runs** against real PostgreSQL 18.4 (100 two-simultaneous-claim rounds total).

## Late-payment policy (conservative)

If a validly signed capture arrives for an order whose hold already expired, or the amount doesn't match the order total: the order goes to **`needs_review`** with full reconciliation data (expected vs. received amount, timestamps, raw payload) — never auto-fulfillment, never automatic restocking. A production system would now call the provider's refund API or open a manual resolution queue. Details: [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md) C7/C11.

## Verification status (honest)

Executed on the development machine (Windows, Node v24.15.0, npm 11.12.1), against **real PostgreSQL 18.4** run from downloaded official binaries on `127.0.0.1:5433` (Docker unavailable):

| Check                                                   | Result                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install` (lockfile generated, `npm audit`)         | ✅ 0 vulnerabilities after dev-toolchain version bumps (vitest 5, vite 6.4.5, eslint 10)                                                                                                                                                                                                                                                                      |
| `npm run typecheck` / `lint` / `format:check` / `build` | ✅ all exit 0 (API via `tsc`, web via `tsc && vite build`)                                                                                                                                                                                                                                                                                                    |     | `npm test` | ✅ **61/61** (13 unit + 48 real-PG integration) after Phase 5 — suites include the 10-round T-CONC-02 claim race, 5 rounds × 10 concurrent orders, webhook idempotency, and the lifecycle suite; the pickup file additionally soaked 10 consecutive runs (100 two-simultaneous-claim rounds: always exactly one 200 + one 409, stock decremented exactly once), and post-run DB inspection found 0 negative stock, 0 `picked_up` coherence violations, and physical + picked-up quantities = seeded initial stock for every product |
| Post-suite DB inspection                                | ✅ zero negative stock, zero oversold holds, zero orphaned lines, zero orders without lines, zero duplicate product lines                                                                                                                                                                                                                                     |
| Live smoke check (compiled `dist`, real PG)             | ✅ Phase 2: catalog shape, 201 with `expiresInSeconds: 119`, 409/400 paths, availability 35→34 with physical stock untouched. Phase 3: pending GET returns `expiresInSeconds: 119`; after DB-clock expiry the same order reads `expired` with **no** countdown field and its total intact; unknown → 404 `ORDER_NOT_FOUND`; non-UUID → 400 `VALIDATION_ERROR` |
| `npm run migrate` × 2                                   | ✅ run 1 applies `0001_init`; run 2 reports up to date                                                                                                                                                                                                                                                                                                        |
| Broken migration (scratch check)                        | ✅ fails naming the file, full rollback, no history row                                                                                                                                                                                                                                                                                                       |
| Concurrent migration runners (scratch check)            | ✅ exactly one applies; the other waits on the advisory lock                                                                                                                                                                                                                                                                                                  |
| `npm run seed` × 2                                      | ✅ run 1 inserts 5; after simulating consumed stock (=3), run 2 refreshes 5 / inserts 0, stock stays 3                                                                                                                                                                                                                                                        |
| `GET /health` with DB up / killed / restarted           | ✅ 200 → 503 (generic, credential-free body) → 200                                                                                                                                                                                                                                                                                                            |
| Production boot with empty env                          | ✅ exits 1 listing both missing variables                                                                                                                                                                                                                                                                                                                     |
| Data persistence across database restart                | ✅ 5 products and the consumed-stock row intact                                                                                                                                                                                                                                                                                                               |
| `docker compose up --build`                             | ⚠️ **NOT RUN — Docker unavailable on this machine.** File written and reviewed; must be verified on a Docker-capable machine                                                                                                                                                                                                                                  |
| Fresh-clone audit                                       | ⚠️ Deferred to Phase 8 (per plan)                                                                                                                                                                                                                                                                                                                             |
| Graceful-shutdown signal handling                       | ⚠️ Implemented (SIGINT/SIGTERM → close server + pool, 10 s force-exit); live signal behavior **not verified** — Windows does not deliver POSIX signals to native processes                                                                                                                                                                                    |

## Limitations (current and known)

- The `send-webhook` sender script (C14) is not built; the webhook is exercised directly by integration tests that sign requests in-process.
- Because the I4 availability formula excludes already-`paid` orders, a later order can cover units a paid order has not collected yet. The claim endpoint answers that over-commit with `409 INSUFFICIENT_STOCK` and **no state change** (stock can never go negative); a production system would flag the losing still-`paid` order for manual reconciliation.
- The customer UI is a placeholder; the real storefront is Phase 7.
- Compose is unverified on this machine (no Docker). The schema, migrations, seed and health behavior were verified against real PostgreSQL 18.4 rather than the Compose `postgres:16-alpine` image — same protocol/SQL surface, but the image itself still needs its first run.
- No authentication/authorization, refunds automation, admin UI, or observability beyond `/health` — deliberately out of assignment scope.

## Future improvements

- Refund orchestration for `needs_review` late payments.
- Optional periodic sweep job to materialize `expired` statuses eagerly.
- Metrics/tracing (structured logs, request IDs) and an admin reconciliation view.
- Rate limiting and idempotency keys on `POST /orders`.

## Repository documentation

| File                                                 | Purpose                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| [`AGENTS.md`](./AGENTS.md)                           | Invariants and rules every coding agent must follow        |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Phase-by-phase build plan with exit criteria               |
| [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md) | Every requirement as an individually testable criterion    |
| [`AI_NOTES.md`](./AI_NOTES.md)                       | Honest record of AI usage, prompts, mistakes, verification |
| [`.env.example`](./.env.example)                     | Environment variable template (placeholders only)          |
