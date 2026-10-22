# pickup-counter

A full-stack, self-service **snack pickup counter**: customers reserve snacks from a short catalog, holds expire after two minutes, payment is confirmed through a **signed webhook**, and a pickup/locker endpoint claims paid orders — atomically, without ever overselling.

> ## Current status — Phase 1 complete ✅
>
> The application foundation is implemented and verified: npm-workspaces monorepo, zod-validated configuration, PostgreSQL schema + advisory-lock migration runner, idempotent seed, `GET /health` with real database checks, Docker Compose definition, and a minimal React starter. Verified against a **real PostgreSQL 18.4** (see [Verification](#verification-status)); **Docker was not available on the development machine**, so `docker compose up --build` has been written and reviewed but not executed — run it on a Docker-capable machine.
>
> Not built yet: orders, stock reservation, payments/pickup endpoints (Phases 2–5), the customer UI (Phase 7). See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

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
│   │   ├── src/routes/       /health (more in Phases 2–5)
│   │   └── tests/            config unit tests + real-PG migration integration tests
│   └── web/                  React + Vite starter (Phase 7 builds the real UI)
├── docker/init/              first-boot SQL: creates the integration-test database
├── docker-compose.yml        db + one-shot init (migrate & seed) + api, health-gated
└── (root configs)            tsconfig.base.json, eslint, prettier, vitest
```

Core decisions (rationale in [`AGENTS.md`](./AGENTS.md) §3):

- **Money** is integer **paise** everywhere (`BIGINT` columns with CHECKs; no floats anywhere).
- **Time** comes from the database clock only; `expires_at` is computed in SQL, and `expiresInSeconds` (Phase 2) will be computed from the DB clock at response time.
- **Availability** (Phase 2) = physical stock − quantities held by _pending, unexpired_ orders. Expired holds never count. `stock_quantity` is only permanently reduced by a successful pickup claim — `CHECK (stock_quantity >= 0)` is the database-level backstop.
- **Reservations** (Phase 2) will lock product rows `FOR UPDATE` in sorted order inside one transaction — all lines or none.
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

## Tests

Run with a real PostgreSQL: `TEST_DATABASE_URL` must point at a **disposable** database (Compose creates `pickup_counter_test` on first boot; integration tests `DROP SCHEMA` inside it). There is no mock fallback — without a reachable database the suite fails loudly.

Currently implemented (`apps/api/tests/`):

- `config.test.ts` — 13 unit tests for env validation (defaults, production requirements, placeholder-secret rejection, no-password-echo, bounds, multi-issue reporting).
- `migrations.integration.test.ts` — 4 integration tests on real PostgreSQL: fresh-database apply, idempotent second run, expected tables/constraints/indexes (including all-`BIGINT` money columns and the stock CHECK), and DB-level state-machine enforcement.

The three mandatory concurrency scenarios (last-two-units race, webhook replay, concurrent pickup claims) belong to Phases 4–6 and are **not yet implemented**.

## Late-payment policy (conservative)

If a validly signed capture arrives for an order whose hold already expired, or the amount doesn't match the order total: the order goes to **`needs_review`** with full reconciliation data (expected vs. received amount, timestamps, raw payload) — never auto-fulfillment, never automatic restocking. A production system would now call the provider's refund API or open a manual resolution queue. Details: [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md) C7/C11.

## Verification status (honest)

Executed on the development machine (Windows, Node v24.15.0, npm 11.12.1), against **real PostgreSQL 18.4** run from downloaded official binaries on `127.0.0.1:5433` (Docker unavailable):

| Check                                                   | Result                                                                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install` (lockfile generated, `npm audit`)         | ✅ 0 vulnerabilities after dev-toolchain version bumps (vitest 5, vite 6.4.5, eslint 10)                                                                                   |
| `npm run typecheck` / `lint` / `format:check` / `build` | ✅ all exit 0 (API via `tsc`, web via `tsc && vite build`)                                                                                                                 |
| `npm test`                                              | ✅ 17/17 (13 unit + 4 real-PG integration)                                                                                                                                 |
| `npm run migrate` × 2                                   | ✅ run 1 applies `0001_init`; run 2 reports up to date                                                                                                                     |
| Broken migration (scratch check)                        | ✅ fails naming the file, full rollback, no history row                                                                                                                    |
| Concurrent migration runners (scratch check)            | ✅ exactly one applies; the other waits on the advisory lock                                                                                                               |
| `npm run seed` × 2                                      | ✅ run 1 inserts 5; after simulating consumed stock (=3), run 2 refreshes 5 / inserts 0, stock stays 3                                                                     |
| `GET /health` with DB up / killed / restarted           | ✅ 200 → 503 (generic, credential-free body) → 200                                                                                                                         |
| Production boot with empty env                          | ✅ exits 1 listing both missing variables                                                                                                                                  |
| Data persistence across database restart                | ✅ 5 products and the consumed-stock row intact                                                                                                                            |
| `docker compose up --build`                             | ⚠️ **NOT RUN — Docker unavailable on this machine.** File written and reviewed; must be verified on a Docker-capable machine                                               |
| Fresh-clone audit                                       | ⚠️ Deferred to Phase 8 (per plan)                                                                                                                                          |
| Graceful-shutdown signal handling                       | ⚠️ Implemented (SIGINT/SIGTERM → close server + pool, 10 s force-exit); live signal behavior **not verified** — Windows does not deliver POSIX signals to native processes |

## Limitations (current and known)

- Business endpoints (products, orders, webhook, pickup) do not exist yet — Phases 2–5.
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
