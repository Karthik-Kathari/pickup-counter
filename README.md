# pickup-counter

A full-stack, self-service **snack pickup counter**: customers reserve snacks from a short catalog, holds expire after two minutes, payment is confirmed through a **signed webhook**, and a pickup/locker endpoint claims paid orders — atomically, without ever overselling.

> ## ⚠️ Current status: Phase 0 — planning baseline only
>
> This repository currently contains **engineering documentation only**. There is no application code, no dependencies are installed, and no test has been run. Everything below the status box describes the **planned** system, with unimplemented items marked. Setup/run commands are **not yet available**. Progress is tracked in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md); verified behavior is tracked in [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md).

---

## Prerequisites (needed once the app exists)

- **Node.js 20+** with npm (workspaces)
- **Docker + Docker Compose** — PostgreSQL 16 and the app services run in containers; no local PostgreSQL install is required
- Nothing else; per-phase commands appear in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)

## Project goals

- Reserve stock for ~120 seconds at order time without ever overselling, even under concurrency.
- Confirm payment via an HMAC-SHA256-signed webhook that is **idempotent** under duplicate delivery.
- Fulfill (pick up) paid orders exactly once, deducting physical stock permanently exactly once.
- Keep every rule explainable in a 45-minute interview: explicit SQL, explicit transactions, no magic.

## Planned stack and architecture

| Layer          | Choice                                                            |
| -------------- | ----------------------------------------------------------------- |
| Language       | TypeScript (strict) throughout                                    |
| API            | Node.js + Express, ESM                                            |
| Database       | PostgreSQL 16, explicit SQL migrations and transactions, `pg` pool |
| Frontend       | React + Vite + TypeScript                                        |
| Tests          | Vitest; integration tests against **real PostgreSQL**             |
| Orchestration  | Docker Compose (db + api + web), npm workspaces monorepo          |
| Deliberately absent | ORMs, queues, caches, microservices                          |

Core design decisions (rationale in [`AGENTS.md`](./AGENTS.md) §3 and the plan):

- **Money** is integer **paise** everywhere (`price_paise`, `total_paise`, `amount_paise`).
- **Time** comes from the database clock only; `expires_at` is computed in SQL, and `expiresInSeconds` is computed from the DB clock when the response is sent.
- **Availability** = physical stock − quantities held by *pending, unexpired* orders. Expired holds never count. Physical stock is only permanently reduced by a successful pickup claim.
- **Reservations** lock product rows `FOR UPDATE` in deterministic (sorted) order inside one transaction — all lines or none.
- **Idempotency** is database-enforced: `payment_events.event_id` is a primary key; events are inserted before any side effect.
- **Signatures** are verified over the exact raw body bytes with constant-time comparison before any event data is trusted.
- **Late payments / amount mismatches** go to `needs_review`, never auto-fulfillment (see policy below).
- **Pickup** is one atomic `paid → picked_up` transition that decrements stock in the same transaction.
- **Frontend countdown** is initialized from the server's remaining seconds and ticks on a monotonic clock; server-reported status is always authoritative.

## Planned directory structure

```text
pickup-counter/
├── AGENTS.md                  ✅ present
├── IMPLEMENTATION_PLAN.md     ✅ present
├── ACCEPTANCE_CRITERIA.md     ✅ present
├── README.md                  ✅ present (this file)
├── AI_NOTES.md                ✅ present
├── .env.example               ✅ present
├── .gitignore                 ✅ present (pre-existing)
├── package.json               ⬜ Phase 1 (npm workspaces root)
├── package-lock.json          ⬜ Phase 1
├── tsconfig.base.json         ⬜ Phase 1
├── docker-compose.yml         ⬜ Phase 1
├── apps/
│   ├── api/                   ⬜ Phase 1+
│   │   ├── src/               app code (Express, config, errors, routes)
│   │   ├── migrations/        numbered SQL migrations + runner
│   │   ├── seeds/             ~5 snack products
│   │   ├── scripts/           send-webhook signer (Phase 4)
│   │   └── tests/             integration & concurrency tests (Phases 2–6)
│   └── web/                   ⬜ Phase 7 (React + Vite customer screen)
└── scripts/                   ⬜ helper scripts if needed
```

## Planned commands — **NOT YET AVAILABLE**

These will exist once the listed phase lands. Running them today fails; nothing here has been executed successfully.

| Command                                   | What it will do                              | Available in |
| ----------------------------------------- | -------------------------------------------- | ------------ |
| `cp .env.example .env`                    | Create local env config                      | now          |
| `docker compose up -d db`                 | Start PostgreSQL                             | Phase 1      |
| `npm install`                             | Install workspace dependencies               | Phase 1      |
| `npm run -w apps/api migrate`             | Apply SQL migrations                         | Phase 1      |
| `npm run -w apps/api seed`                | Seed snack products                          | Phase 1      |
| `npm run typecheck` / `lint` / `format:check` | Strict TS, ESLint, Prettier              | Phase 1      |
| `npm test`                                | Full test suite (real PostgreSQL)            | Phase 6      |
| `npm run -w apps/api send-webhook -- …`   | Send a correctly signed payment event        | Phase 4      |
| `docker compose up --build`               | One-command full startup (db + api + web)    | Phase 7      |

## Assumptions

- Payments are simulated by an external provider that calls our webhook; the repo ships a **signing sender script** as the stand-in provider (the assignment's `npm run send-webhook`).
- The shared webhook secret (`WEBHOOK_SECRET`) is provisioned out of band and is identical on both sides; `.env.example` carries only a local placeholder.
- ~5 seeded products, integer-paise prices, single-currency, no tax/shipping.
- "Locker claiming" is modeled as an authenticated-by-contract internal endpoint (`POST /orders/:id/pickup-claim`); real locker hardware/auth is out of scope.
- Hold duration defaults to 120 s and is configurable via `HOLD_TTL_SECONDS`.
- Expiration is handled lazily (on access) plus the availability formula — no background sweep job, for deterministic tests.

## Key decisions and policies

### Late-payment policy (conservative)

If a **validly signed, correctly formed capture** arrives for an order whose hold already expired:

- The order transitions to **`needs_review`** (reason `late_payment`) — it is **not** resurrected, **not** fulfilled, and its stock is **not** automatically restocked by the webhook.
- The event and reconciliation data (expected vs. received amount, timestamps, current order state) are persisted in `payment_events`.
- An **amount mismatch** behaves the same way (`needs_review`, reason `amount_mismatch`).
- In production this is where a refund API call or a manual resolution queue would take over; this assignment stops at recording the state honestly.

### Order state machine

`pending → paid | expired | needs_review`, and `paid → picked_up`. `expired`, `picked_up`, and `needs_review` are terminal for automation — replays and late events never regress them.

## Tests

Planned in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) Phase 6, proven per [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md), all against real PostgreSQL:

1. **Last-two-units race** — 10 concurrent customers, exactly 2 reservations succeed, all others fail cleanly, nothing oversold.
2. **Webhook replay** — the same signed event delivered twice processes once.
3. **Concurrent pickup claims** — exactly one success and one `409`, stock deducted exactly once.

**No test exists or has been run yet. No coverage claim is made.**

## Limitations (current and known)

- The repository has no application code as of this Phase 0 baseline.
- Planned scope omits authentication/authorization, refunds automation, admin UI, and observability beyond a health endpoint — deliberately, per the assignment.
- Single-node assumption: correctness relies on PostgreSQL row locks; no distributed coordination exists or is planned.

## Future improvements

- Refund orchestration for `needs_review` late payments.
- Optional periodic sweep job to materialize `expired` statuses eagerly.
- Metrics/tracing (structured logs, request IDs) and an admin reconciliation view.
- Rate limiting and idempotency keys on `POST /orders`.

## Repository documentation

| File                                            | Purpose                                                        |
| ----------------------------------------------- | -------------------------------------------------------------- |
| [`AGENTS.md`](./AGENTS.md)                      | Invariants and rules every coding agent must follow            |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Phase-by-phase build plan with exit criteria               |
| [`ACCEPTANCE_CRITERIA.md`](./ACCEPTANCE_CRITERIA.md) | Every requirement as an individually testable criterion    |
| [`AI_NOTES.md`](./AI_NOTES.md)                  | Honest record of AI usage, prompts, mistakes, verification    |
| [`.env.example`](./.env.example)                | Environment variable template (placeholders only)              |
