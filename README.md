# Pickup Counter

A full-stack, self-service **snack pickup counter**: customers reserve snacks from a short catalog, holds expire after two minutes, payment is confirmed through a **signed webhook**, and a pickup/locker endpoint claims paid orders — atomically, without ever overselling.

> ## Current status — Phases 1–5 + customer screen complete ✅ + F1 Docker run completed
>
> Implemented and verified against **real PostgreSQL 18.4**: the Phase 1 foundation (monorepo, zod config, migrations, seed, health), the Phase 2 catalog and transaction-safe order reservations, the Phase 3 order-status endpoint `GET /orders/:id` with a hardened lazy-expiration lifecycle, the Phase 4 signed & idempotent payment webhook, the Phase 5 atomic pickup claim `POST /orders/:id/pickup-claim` (mandatory concurrency scenario 3 soak-tested), and the Phase 7 React customer screen — catalog → cart → order → countdown → signed webhook → pickup, exercised end-to-end in a browser against the compiled API. The `send-webhook` sender script (C14) is built and live-tested.
>
> **Docker availability note:** no Docker was available on this development machine during the Phases 1–5 build and verification, so `docker compose up --build` (db + api + web) was written and reviewed but not executed until this final F1 run. That F1 run was completed locally afterward against a running Compose stack and is documented in `FINAL_DOCKER_VERIFICATION.md`.
>
> Not built: the Phase 6 `npm run test:integration` alias (`npm test` runs the entire suite), and the ±10-minute OS clock-shift walkthrough (E5) remains a human step. See [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

## Table of contents

1. [What this is](#what-this-is)
2. [Architecture](#architecture)
3. [Quick start (local, non-Docker)](#quick-start-local-non-docker)
4. [Docker](#docker)
5. [API](#api)
6. [Customer flow](#customer-flow)
7. [Payments](#payments)
8. [Pickup / locker claim](#pickup--locker-claim)
9. [Assumptions & decisions](#assumptions--decisions)
10. [Tests](#tests)
11. [Limitations](#limitations)
12. [Future work](#future-work)

## What this is

A snack counter where each customer can reserve items for a short time while they pay. The
customer-facing UI (Vite/React) talks to a typed Express API over JSON. Payment is not integrated
with any real provider — instead, payment is confirmed by sending a **signed webhook request**
against the local API with a shared secret, which is the same cryptographic shape a real provider
would use.

The assignment-adjacent acceptance criteria are tracked in [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md).

## Architecture

```
pickup-counter/
├── apps/
│   ├── api/          # Express API, migrations, seed, webhooks, pickup claim
│   └── web/          # Vite + React customer screen
├── docker/           # Compose-only files (init SQL)
├── docker-compose.yml
├── package.json      # workspace root (npm workspaces: apps/api, apps/web)
└── ...
```

- **Database:** PostgreSQL. Migrations are SQL under `apps/api/migrations/`. The initial schema
  creates `products`, `orders`, and an inventory-consumption ledger `order_inventory_events`.
- **API:** Express, zod-validated config, one DB pool per process. Order lifecycle (including
  hold expiry) is computed **server-side from DB row state**, never from the client timer.
- **Webhook:** HMAC-SHA256 over the exact raw request body, compared with `X-Signature`. Idempotent
  by `eventId`.
- **Pickup claim:** atomic `SELECT ... FOR UPDATE`, status machine, stock committed exactly once.
- **Frontend:** compiled React bundle served by nginx in Docker; the client sends **relative** API
  calls in Docker, so no API origin is baked into the bundle.

## Quick start (local, non-Docker)

The fastest path assumes you have PostgreSQL running locally. The defaults in `.env.example` assume
`postgres://postgres:postgres@localhost:5432/pickup_counter`.

```bash
# 1. Install
npm install

# 2. Config — copy the template and adjust if your PostgreSQL is elsewhere
cp .env.example .env
# Edit .env if needed (DATABASE_URL, TEST_DATABASE_URL, WEBHOOK_SECRET, ports).

# 3. Migrate + seed
npm run -w apps/api migrate
npm run -w apps/api seed

# 4. Start the API (dev)
npm run -w apps/api dev        # listens on API_PORT (default 3001)

# 5. Start the web UI (dev, separate terminal)
npm run -w apps/web dev        # Vite dev server, default http://localhost:5173
```

The customer screen at `http://localhost:5173` calls the API via `VITE_API_BASE_URL` (default
`http://localhost:3001`). In Vite dev, that is an absolute origin; in Docker, the bundle uses
relative paths and nginx proxies `/health /products /orders /payments` to the API service.

### Reproduction checklist used during development

This is the clean-clone audit path that was used to verify the setup is reproducible. It does **not**
need Docker:

```bash
git clone <repo> && cd pickup-counter
cp .env.example .env
# (set TEST_DATABASE_URL to a real test database if you want the full suite)

npm install                         # npm ci prefers the lockfile; npm install is fine too
npm run typecheck                   # both apps
npm run lint
npm run format:check
npm run build                       # both apps
npm run -w apps/api migrate
npm run -w apps/api seed
npm test                           # full suite (API unit + integration)
```

On the machine where this was developed, that path ran from a fresh clone with no manual fix-ups.
If line endings are not preserved on checkout, `npm run format:check` can fail before anything else;
the repo includes a `.gitattributes` so Git normalizes line endings to LF.

## Docker

Docker Compose brings up three services:

- `db` — PostgreSQL
- `init` — one-shot container that runs migrate then seed
- `api` — the Express API
- `web` — nginx serving the built React bundle and proxying API paths

Compose file: [`docker-compose.yml`](./docker-compose.yml).
API image: [`apps/api/Dockerfile`](./apps/api/Dockerfile).
Web image: [`apps/web/Dockerfile`](./apps/web/Dockerfile); nginx config:
[`apps/web/nginx.conf`](./apps/web/nginx.conf).

```bash
docker compose up --build -d
```

The Compose run was completed locally and is documented in
[`FINAL_DOCKER_VERIFICATION.md`](./FINAL_DOCKER_VERIFICATION.md).

## API

Base URL: `http://localhost:3001` (when run locally with the default `.env`).

### `GET /health`

```json
{ "status": "ok", "database": "connected" }
```

Returns `503` with `{ "status": "error", "database": "disconnected" }` when the DB is unreachable.
Deliberately generic — no credentials or internal detail in the body.

### `GET /products`

List of products with live availability:

```json
[
  {
    "id": 1,
    "name": "Butter Cookies",
    "pricePaise": 3000,
    "currency": "INR",
    "stockQuantity": 34,
    "availableUnits": 34
  }
]
```

`availableUnits` is not just `stockQuantity` — it subtracts units reserved by unexpired unpaid
orders. That is why ordering can fail later even when `stockQuantity` looks sufficient.

### `POST /orders`

```json
// body
{ "items": [{ "productId": 1, "quantity": 1 }] }

// response 201
{
  "id": "<uuid>",
  "currency": "INR",
  "totalPaise": 3000,
  "status": "pending",
  "expiresAt": "<ISO8601>",
  "expiresInSeconds": 120,
  "items": [ { "productId": 1, "name": "Butter Cookies", "quantity": 1, "unitPricePaise": 3000 } ]
}
```

Creates the order in a transaction, decrements available stock, sets the hold expiry, and returns the
server-computed total. The client **never** computes money. If the order does not move to `paid`
before expiry, the stock is released by the lazy-expiration lifecycle the next time the order is
fetched.

### `GET /orders/:id`

Returns the current server state: `pending`, `paid`, `expired`, or `needs_review`.

### `POST /payments/webhook`

Accepts a signed payment event. Idempotent by `eventId`.

```json
// body
{
  "eventId": "<uuid>",
  "orderId": "<order uuid>",
  "amountPaise": 3000,
  "status": "paid"
}
```

Headers: `X-Signature: <hex HMAC-SHA256 of raw body>`, `Content-Type: application/json`.

If the signature is wrong, the amount does not match the order total, or the order is not in a state
that can be paid, the endpoint returns an error and does **not** transition the order. Repeated
identical successful events are idempotent (one transition).

### `POST /orders/:id/pickup-claim`

Claim a paid order for pickup/locker. Atomically checks that the order is `paid`, reserves the
inventory, and flips to `picked_up`.

```json
// response 200
{
  "id": "<uuid>",
  "status": "picked_up",
  "paidAt": "<ISO8601>",
  "pickedUpAt": "<ISO8601>"
}
```

Concurrency is handled server-side with row locking, so two simultaneous claims cannot both succeed
or oversell. A claim on an already-claimed order returns `409 ORDER_ALREADY_CLAIMED` with no state
change.

## Customer flow

The React screen implements the full customer journey:

1. Catalog — browse products, live availability.
2. Cart — add items with quantity.
3. Order — place order, see server-computed total and a live countdown.
4. Payment — copy the `send-webhook` command and run it to confirm payment.
5. Pickup — once paid, claim the order for pickup.

The countdown is the part most likely to look “client-y,” so it was built carefully:

- It is initialized from the server’s `expiresInSeconds`.
- It ticks off a **monotonic** elapsed timer, not `Date.now()`.
- It re-syncs to the server on every poll.
- The UI never infers order state from the timer — even at 00:00 it says “waiting for the server”
  until the next poll returns the server’s actual state.

Because of that, advancing or rewinding the OS clock should not make the displayed countdown jump by
10 minutes. The code has that shape; the manual half of that assertion (actually shifting the OS
clock ±10 minutes and watching the countdown immediately afterward) is a human step that was not
completed. The inspection evidence for clock independence is in
[`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md).

### `send-webhook` helper

The API ships a small CLI helper that builds and sends a correctly signed webhook for a given order
and amount:

```bash
npm run -w apps/api send-webhook -- --order-id <uuid> --amount 3000
```

It reads `WEBHOOK_SECRET` from the environment, so it is useful both locally and inside the API
container. This is the command the customer screen displays.

## Payments

Payment is confirmed by sending a signed webhook event to `POST /payments/webhook`. There is no
real payment provider in this project; the webhook is the integration surface, and the helper script
is how you exercise it.

Key properties:

- Signature is HMAC-SHA256 over the raw body.
- Idempotent by `eventId`.
- Amount must match the order total.
- Only `pending` orders can be moved to `paid`.

Attempts with a wrong signature, wrong amount, or an order not in the right state return an error
and do not mutate the order.

## Pickup / locker claim

Once an order is `paid`, it can be claimed. The claim endpoint:

- Locks the order row.
- Checks the status is `paid`.
- Commits the reserved inventory exactly once.
- Transitions to `picked_up`.

Two concurrent claims cannot both succeed. A second claim attempt on an already-claimed order gets
`409 ORDER_ALREADY_CLAIMED` and leaves the order and stock untouched.

## Assumptions & decisions

- Currency is INR; prices are stored as integer **paise** to avoid floating-point money errors.
- Hold time default is 120 seconds, set via `HOLD_TTL_SECONDS`.
- Shared webhook secret is `WEBHOOK_SECRET`; the default in `.env.example` is a local-dev placeholder
  and must be replaced for anything beyond local dev. In particular, the Compose stack runs
  `NODE_ENV=production` for the `init`/`api` services, and the validator rejects the textbook
  placeholder, so the local-dev value that passes must be used for a real Compose boot.
- The client is deliberately not trusted with totals or state — it displays what the server returns.
- The schema, migrations, seed, and health behavior were verified against a real PostgreSQL 18.4;
  the Compose image is `postgres:16-alpine` and has now also been run once (see
  `FINAL_DOCKER_VERIFICATION.md`).

## Tests

The API package has unit + integration tests run with Vitest against a real PostgreSQL test database.

```bash
npm test                 # full suite (default workspace config)
npm run -w apps/api test # same thing, explicit
```

The test suite uses a separate test database (`TEST_DATABASE_URL`) because the tests create and
destroy data aggressively. If you run the suite, make sure that database exists. Docker Compose
creates `pickup_counter_test` automatically on first boot via
[`docker/init/01-create-test-db.sql`](./docker/init/01-create-test-db.sql); for a non-Docker run you
create it yourself from `DATABASE_URL`'s server.

The suite includes the mandatory concurrency and idempotency scenarios for the claim path, plus a
transaction-atomicity test that proves the pickup flip and inventory change roll back together under
an injected DB failure.

## Limitations

- The ±10-minute OS clock-shift walkthrough (acceptance E5's manual half) has **not** been performed —
  it needs a human changing the system clock. The countdown's clock-independence is verified by
  inspection (monotonic `performance.now()` anchors, re-sync on every poll, no `Date.now()` arithmetic).
- The Phase 6 `npm run test:integration` alias documented in AGENTS §7 does not exist yet (`npm test`
  runs the entire suite); Phase 6 was never started.
- Because the availability formula excludes already-`paid` orders, a later order can cover units a paid
  order has not collected yet. The claim endpoint answers that over-commit with `409 INSUFFICIENT_STOCK`
  and **no state change** (stock can never go negative); a production system would flag the losing
  still-`paid` order for manual reconciliation.
- The F1 Docker verification was completed locally, but on an existing checkout rather than a strict
  clean-clone reproduction; the documented non-Docker clean-clone path was already verified end-to-end.
- Graceful-shutdown signal handling is implemented (SIGINT/SIGTERM → close server + pool, 10 s
  force-exit); live signal behavior was not independently re-verified in the Compose run.
- No authentication/authorization, refunds automation, admin UI, or observability beyond `/health` —
  deliberately out of assignment scope.

## Future work

- Wire a real payment provider instead of the local webhook sender, keeping the same signed-event
  shape and idempotency discipline.
- Add auth so orders, webhooks, and pickup claims are scoped to real users/shops.
- Add an idempotency/retrying sender for the webhook so flakes are recoverable without manual retypes.
- Add observability (structured logs, metrics, trace IDs) and a small admin view for held/expired
  orders and reconciliation candidates.
