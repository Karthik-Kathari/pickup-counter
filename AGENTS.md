# AGENTS.md — Persistent Instructions for Coding Agents

**Repository:** `pickup-counter` — a full-stack, self-service snack pickup counter (assignment project).
**Read this file before writing or changing any code.** It records engineering invariants that must survive every refactor, model change, and "quick fix". If any instruction here conflicts with a new request, surface the conflict instead of silently violating it.

---

## 1. Project summary

A customer orders snacks from a catalog; the order **reserves** (holds) stock for a short window; the customer pays through an external payment provider that notifies us via a signed webhook; once paid, a locker/pickup endpoint claims the order and permanently deducts the stock.

| Layer    | Choice                                                  |
| -------- | ------------------------------------------------------- |
| Language | TypeScript everywhere (strict)                          |
| API      | Node.js + Express                                       |
| Database | PostgreSQL, explicit SQL, explicit transactions         |
| Frontend | React + Vite + TypeScript                               |
| Tests    | Vitest; integration tests against a **real** PostgreSQL |
| Runtime  | Docker Compose for one-command startup                  |
| Layout   | Monorepo: `apps/api`, `apps/web` (npm workspaces)       |

Deliberately **not** used: ORMs, queues, caches, microservices, Kubernetes, message brokers. Complexity must earn its place by making the assignment's correctness requirements easier to demonstrate. The whole system must be explainable live in a 45-minute interview.

---

## 2. Inspect before you edit

1. Run `git status` and `git log --oneline -5` first. Never assume the working tree is clean.
2. Read every file you intend to change — in full if it is under ~500 lines — before editing it.
3. Never discard, overwrite, stash, or revert changes you did not make. If uncommitted work of unknown ownership exists, leave it and say so in your report.
4. Look for an existing helper, pattern, or convention before adding a new one. Match the surrounding code.
5. Before adding a dependency, confirm it is (or should be) already used in the project; prefer the standard library.

---

## 3. Mandatory engineering invariants

These are non-negotiable. Any change that breaks one is a bug, regardless of tests passing.

**I1 — Money is integer paise.** Every price, total, and amount is an integer number of paise (`price_paise`, `total_paise`, `amount_paise`) stored in `BIGINT`/`INTEGER` columns and transmitted as JSON numbers. Floating-point money (`float`, `numeric` arithmetic in JS, `0.1 + 0.2`) is forbidden anywhere.

**I2 — The database clock is the single source of truth for time.** Hold expiry is stored as `expires_at timestamptz` and computed **in SQL** (`now()` / `transaction_timestamp()`), never from a Node `Date` the client or app server can skew. `expiresInSeconds` sent to clients is computed from the DB clock as late as possible (at/just after commit, in the response-building query). Browser wall clocks are never trusted.

**I3 — Reservations are all-or-nothing.** An order reserves every requested unit or none of it. Multi-product carts first lock **all** referenced product rows with `SELECT ... FOR UPDATE` in ascending `product_id` order (deterministic lock ordering prevents deadlock), then evaluate availability for all lines, then write. A single insufficient line aborts the whole transaction with a clear error.

**I4 — Availability formula.** `availableUnits = products.stock_quantity − Σ(quantity of order lines whose order is in status 'pending' AND expires_at > now())`. Expired holds **never** reduce availability. Physical stock is never reduced at order creation.

**I5 — Permanent deduction happens only at pickup.** `products.stock_quantity` is decremented exactly once, inside the same transaction that transitions an order `paid → picked_up`. No other code path may decrement it.

**I6 — Order state machine.** Statuses: `pending`, `paid`, `expired`, `needs_review`, `picked_up`. Allowed transitions only:

```
pending ──(valid captured payment, amount matches, hold still valid)──► paid
pending ──(hold expires, still unpaid)────────────────────────────────► expired
pending ──(amount mismatch OR valid capture after expiry)─────────────► needs_review
paid    ──(successful pickup claim)───────────────────────────────────► picked_up
```

`expired`, `picked_up`, and `needs_review` are terminal for automation: no webhook or timer may move them, and a replayed event must never reverse an existing result (e.g., `picked_up` must not fall back to `paid`).

**I7 — Payment idempotency is enforced by the database.** `payment_events.event_id` is a `PRIMARY KEY`/`UNIQUE` constraint. Every incoming event is persisted with `INSERT ... ON CONFLICT (event_id) DO NOTHING` **before** any side effect; a row that was not inserted means "duplicate — do nothing, acknowledge with 2xx". Concurrent duplicate deliveries must collapse to one processed event.

**I8 — Signatures are verified over raw bytes, in constant time.** The webhook route uses a raw-body parser mounted **before** `express.json()`. `X-Signature` must be validated for presence, hex format, and exact length first, then compared with `crypto.timingSafeEqual` over `HMAC-SHA256(secret, rawBody)`. A parsed-and-re-serialized JSON body is never an acceptable signature input.

**I9 — Conservative payment outcomes.** Amount mismatch or a valid capture arriving after expiry ⇒ `needs_review`, with enough persisted detail (event payload, expected vs. received amount, order state at receipt) for manual reconciliation or refund. Never auto-fulfill, never auto-restock. Unknown order IDs and unsupported statuses are recorded and acknowledged (2xx) without a state change, so the provider does not retry forever.

**I10 — Pickup is an atomic claim.** The claim transaction locks the order row (`FOR UPDATE`), verifies `status = 'paid'`, flips it to `picked_up`, records `picked_up_at`, and decrements product stock — all or nothing. Two concurrent claims must yield exactly one success and one `409 Conflict`.

**I11 — Parameterized SQL only.** No string interpolation/concatenation of user input into SQL. Migrations contain DDL; runtime queries use bound parameters.

**I12 — The frontend treats the server as authoritative.** The countdown initializes from the server's `expiresInSeconds` and ticks using a monotonic source (elapsed time since initialization), not arithmetic on `Date.now()`. Status is reconciled by polling `GET /orders/:id` until a terminal status; the timer never "decides" that payment succeeded or failed.

---

## 4. Coding conventions

- **TypeScript:** `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `forceConsistentCasingInFileNames`, `noFallthroughCasesInSwitch`. No `any` without a written justification; prefer `unknown` + narrowing.
- **Modules:** ESM (`"type": "module"`, `moduleResolution: "NodeNext"`). Import explicit `.js` extensions in relative imports where NodeNext requires them.
- **Validation:** every HTTP input (body, params, query) is validated at the boundary with `zod` and rejected with `400` and a precise message before touching the database.
- **Errors:** one `AppError` type (`code`, `httpStatus`, `message`, optional `details`) and one error-handling middleware. Success responses are plain JSON; failures use the envelope `{ "error": { "code": "...", "message": "..." } }`. Stack traces never reach clients.
- **Naming:** money fields end in `_paise`; timestamps are `timestamptz`; IDs are UUIDs; DB columns are `snake_case`, API JSON is `camelCase`, mapped at the HTTP boundary only.
- **SQL:** migrations are numbered, immutable-after-apply SQL files (`0001_init.sql`, …) applied in order and recorded in a `schema_migrations` table. Runtime SQL stays close to its call site as clearly named query functions; no repository/service layering ceremony.
- **Transactions:** open explicitly, keep them short, do no HTTP or slow work inside them, and always release locks by committing or rolling back.
- **Formatting/lint:** Prettier + ESLint (`typescript-eslint`) with the configs committed at the repo root; CI-style checks must pass before any commit.

---

## 5. Security rules

- Secrets live only in environment variables (`.env`, git-ignored). `.env.example` contains placeholders/local defaults only. Never commit a real secret, key, token, or credential — not even a "temporary" one.
- Never log secrets, HMAC signatures, or raw webhook payloads verbatim. Log event IDs and order IDs instead.
- Reject malformed payloads early; never echo internal error details in responses.
- Webhook authenticity depends on the shared secret; document any change to `WEBHOOK_SECRET` handling in the README.

---

## 6. No-fake-tests rule

This project's grade rests on demonstrated behavior. Therefore:

1. **Integration tests run against a real PostgreSQL.** Never mock `pg`, never assert against an in-memory substitute for a test labeled "integration".
2. **No test may be written to pass without proving something**: no assertions on constants, no `catch (e) { /* ignore */ }`, no spinning on `setTimeout` as a substitute for an assertion.
3. **Never** add `.skip`/`.only`, delete or weaken an assertion, lower a concurrency count, or add retries "to make CI green". If a test finds a real bug, fix the bug.
4. If a test cannot run (no database, port conflict, missing env), report it as **NOT RUN** — never as passed, and never by implication.
5. Coverage or pass-rate claims may only come from a command you actually executed, quoted with its real output.

---

## 7. Required validation commands

Run every applicable command before declaring work complete, and paste the **actual** output in the final report.

| Command                                 | Purpose                                                                                                    | Available since |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------- |
| `npm install`                           | Install workspace dependencies                                                                             | Phase 1         |
| `docker compose up -d db`               | Start PostgreSQL for local dev/tests                                                                       | Phase 1         |
| `npm run -w apps/api migrate`           | Apply SQL migrations to the dev database                                                                   | Phase 1         |
| `npm run -w apps/api seed`              | Seed the ~5 snack products                                                                                 | Phase 1         |
| `npm run typecheck`                     | Strict TypeScript across workspaces                                                                        | Phase 1         |
| `npm run lint`                          | ESLint                                                                                                     | Phase 1         |
| `npm run format:check`                  | Prettier                                                                                                   | Phase 1         |
| `npm test`                              | Vitest suite (unit + real-PG integration tests; the three mandatory concurrency scenarios join in Phase 6) | Phase 1         |     | `npm run test:integration` | Integration tests only (needs Postgres) | Phase 6 |
| `docker compose up --build`             | One-command startup (db + one-shot init + api; web joins in Phase 7)                                       | Phase 1         |
| `npm run -w apps/api send-webhook -- …` | Send a correctly signed webhook event                                                                      | Phase 4         |

If a command is not yet available for the current phase, say so honestly rather than inventing an alias that fakes it.

---

## 8. Documentation and progress tracking

- **`README.md`** must never describe unfinished features as working. Update its Status section in the same change that lands a capability.
- **`IMPLEMENTATION_PLAN.md`** — check off an exit criterion only after it has been demonstrated (command output, test, or inspection). Partial completion stays unchecked.
- **`ACCEPTANCE_CRITERIA.md`** — every criterion must map to an automated test ID, a manual verification step, or an inspection; keep the mapping current when tests are added or renamed.
- **`AI_NOTES.md`** — record only tools, prompts, mistakes, and verifications that actually happened. Fabricating an "AI mistake" or claiming a tool was used is itself a violation.
- Keep commits focused: one phase or one concern per commit, with a message explaining the _why_.

---

## 9. Git safety

- Never force-push, rewrite history, delete remote branches, or change repository visibility.
- Never commit `.env`, secrets, `node_modules/`, build output, or coverage artifacts.
- Never report a commit or push as successful without verifying (`git log`, `git status`, `git status -sb` after push).
- If a push fails for lack of credentials, keep the work local and hand the user the exact commands to run.

---

## 10. Reporting honesty

When you finish a turn, state: what actually changed, which commands you actually ran and their real results, anything that failed or could not run, and known limitations. Overstating completeness is worse than admitting a gap — another agent (or interviewer) will build on your report.
