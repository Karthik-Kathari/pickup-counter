# ACCEPTANCE_CRITERIA.md

Every requirement from the assignment, rewritten as an individually testable criterion.
**Proof** is one of: `AUTOMATED` (integration/unit test ID, to be implemented per `IMPLEMENTATION_PLAN.md`), `MANUAL` (a documented human step), or `INSPECTION` (code/docs review). Test IDs (`T…`) are the planned names in `apps/api/tests/`; they will be created in Phases 2–6 — **no such test exists yet as of Phase 0**, and none may be claimed as passing until it has actually run against real PostgreSQL.

Status legend: `PLANNED` (not yet implemented/proven) — this is the only legal value until the corresponding phase lands.

---

## A. Catalog and stock

| ID  | Criterion                                                                                                            | Proof                                                     | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| A1  | Exactly ~5 (≥4) snack products exist after seeding, each with a name and a positive price.                            | AUTOMATED `T-SEED-01` + MANUAL `npm run -w apps/api seed` | PLANNED  |
| A2  | All prices and totals are integer paise end to end (DB columns integral, JSON numbers integral; no floats anywhere). | INSPECTION + AUTOMATED `T-MONEY-01`                       | PLANNED  |
| A3  | `GET /products` returns `id`, `name`, `pricePaise`, `availableUnits` for each product.                                | AUTOMATED `T-CATALOG-01`                                  | PLANNED  |
| A4  | `availableUnits = stock_quantity − Σ(line quantities of orders in status 'pending' with expires_at > now())`.         | AUTOMATED `T-AVAIL-01`                                    | PLANNED  |
| A5  | An expired hold does not reduce availability (before any status flip happens).                                       | AUTOMATED `T-AVAIL-02`                                    | PLANNED  |
| A6  | `stock_quantity` is never decremented at order creation (reservations ≠ deductions).                                 | INSPECTION + AUTOMATED `T-AVAIL-01`                       | PLANNED  |

## B. Order creation

| ID  | Criterion                                                                                                                    | Proof                                                             | Status   |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| B1  | `POST /orders` accepts line items `{ productId, quantity }`; malformed bodies, unknown products, non-integer/≤0 quantities, and empty carts are rejected with `400` and a clear error code. | AUTOMATED `T-VALID-01..0n`                                        | PLANNED  |
| B2  | Order totals are calculated server-side from current `products.price_paise`; a client-supplied price is ignored/impossible.  | AUTOMATED `T-ORDER-02` + INSPECTION                               | PLANNED  |
| B3  | A created order reserves its stock for 120 seconds (`HOLD_TTL_SECONDS`, default 120).                                        | AUTOMATED `T-ORDER-03`                                            | PLANNED  |
| B4  | The creation response includes `expiresInSeconds`, computed from the **server/DB clock when the response is sent**.           | AUTOMATED `T-ORDER-04` + INSPECTION                               | PLANNED  |
| B5  | Concurrent order creation never oversells: N customers racing for K units reserve at most K units in total.                   | AUTOMATED `T-CONC-01` (**mandatory scenario 1**)                  | PLANNED  |
| B6  | A multi-product order reserves all lines or none — insufficient stock on any line writes zero rows.                           | AUTOMATED `T-ORDER-05`                                            | PLANNED  |
| B7  | Repeated `productId` entries in one request are handled safely (consolidated by summing, or rejected explicitly with `400`).  | AUTOMATED `T-VALID-05` + INSPECTION of chosen policy               | PLANNED  |
| B8  | An insufficient-stock request fails clearly: `409` with error code (e.g. `INSUFFICIENT_STOCK`) and no partially reserved items. | AUTOMATED `T-CONC-01`, `T-ORDER-05`                               | PLANNED  |
| B9  | An unpaid order whose hold elapses transitions to `expired` (lazy flip on access; deterministic, no background job needed).  | AUTOMATED `T-EXPIRY-01`                                           | PLANNED  |

## C. Payment webhook

| ID  | Criterion                                                                                                                              | Proof                                                          | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| C1  | `POST /payments/webhook` accepts a JSON event `{ eventId, orderId, amountPaise, status }`.                                              | AUTOMATED `T-WH-01`                                            | PLANNED  |
| C2  | `X-Signature` is verified as HMAC-SHA256 with a shared secret from an environment variable (`WEBHOOK_SECRET`).                          | AUTOMATED `T-WH-02` + INSPECTION                               | PLANNED  |
| C3  | The signature is computed over the **exact raw request body bytes** before the event is parsed or trusted (raw middleware precedes JSON parsing). | INSPECTION + AUTOMATED `T-WH-02` (body mutated-serialization case) | PLANNED  |
| C4  | Missing, malformed (non-hex/wrong length), and invalid signatures are all rejected (`401`), with no state side effects.                | AUTOMATED `T-WH-03`, `T-WH-04`, `T-WH-05`                      | PLANNED  |
| C5  | Signature comparison uses constant-time comparison (`crypto.timingSafeEqual`) after format/length validation.                          | INSPECTION                                                     | PLANNED  |
| C6  | Duplicate `eventId` deliveries are idempotent: one `payment_events` row, one transition, repeated delivery acknowledged without reversing the result. | AUTOMATED `T-IDEM-01` (**mandatory scenario 2**) + `T-IDEM-02` (concurrent duplicate) | PLANNED  |
| C7  | Amount mismatch (`amountPaise ≠ total_paise`) ⇒ order → `needs_review`; it is never fulfilled or marked `paid`.                        | AUTOMATED `T-WH-08`                                            | PLANNED  |
| C8  | A valid captured payment for an eligible (`pending`, unexpired) order transitions it to `paid` and stamps `paid_at`.                   | AUTOMATED `T-WH-01`                                            | PLANNED  |
| C9  | Unknown `orderId`: event is recorded, no state change, `2xx` acknowledged (provider is not stuck retrying forever).                    | AUTOMATED `T-WH-06`                                            | PLANNED  |
| C10 | Unsupported event `status` (e.g. `failed`): recorded, no transition, `2xx`.                                                             | AUTOMATED `T-WH-07`                                            | PLANNED  |
| C11 | **Late payment policy:** a valid capture arriving after hold expiry ⇒ `needs_review` (reason `late_payment`), never auto-restocked or fulfilled; expected/received amounts and timestamps persisted for reconciliation; README documents that production would refund or open a manual resolution. | AUTOMATED `T-WH-09` + INSPECTION of README                      | PLANNED  |
| C12 | Sufficient event-processing data is persisted (`payment_events` with PK `event_id`, payload, outcome, timestamps) to prevent duplicate side effects. | INSPECTION + AUTOMATED `T-IDEM-01`                             | PLANNED  |
| C13 | A replayed event never regresses a terminal/advanced state (e.g. `picked_up` stays `picked_up`).                                      | AUTOMATED `T-IDEM-03`                                          | PLANNED  |
| C14 | `npm run -w apps/api send-webhook -- …` sends a correctly signed event and prints the API's real response.                            | MANUAL + AUTOMATED `T-WH-10` (script signs → API accepts)       | PLANNED  |

## D. Pickup

| ID  | Criterion                                                                                                                | Proof                                                    | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------- |
| D1  | `POST /orders/:id/pickup-claim` succeeds only for `paid`, unclaimed orders.                                              | AUTOMATED `T-PICK-01`                                    | PLANNED  |
| D2  | Two concurrent claims ⇒ exactly one success and one `409 Conflict`.                                                     | AUTOMATED `T-CONC-02` (**mandatory scenario 3**)          | PLANNED  |
| D3  | `pending` (unpaid), `expired`, and `needs_review` orders cannot be claimed (clear `409`/appropriate error code).         | AUTOMATED `T-PICK-02`                                    | PLANNED  |
| D4  | A successful claim reduces physical `stock_quantity` permanently, exactly once, in the same transaction as the state flip. | AUTOMATED `T-PICK-03` + INSPECTION                       | PLANNED  |
| D5  | A second claim after success returns `409` and changes nothing.                                                          | AUTOMATED `T-PICK-02`                                    | PLANNED  |

## E. Customer screen

| ID  | Criterion                                                                                                                             | Proof  | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| E1  | The screen lists available products with their currently available quantities.                                                        | MANUAL | PLANNED  |
| E2  | A working cart and order-creation flow exist; a placed order reflects server-computed totals.                                          | MANUAL | PLANNED  |
| E3  | After ordering, the screen shows payment instructions and a live countdown.                                                           | MANUAL | PLANNED  |
| E4  | The UI polls server order status until `paid`, `expired`, or `needs_review`, then shows the correct matching outcome and stops polling. | MANUAL + INSPECTION | PLANNED  |
| E5  | The countdown does **not** rely on the customer's wall clock: it is initialized from server-supplied `expiresInSeconds` and ticks on a monotonic elapsed-time basis; re-syncs on polls. | INSPECTION + MANUAL (verify with OS clock shifted ±10 min) | PLANNED  |
| E6  | Order status shown is always the server's reported state; payment success/expiry is never inferred from the display timer alone.      | INSPECTION + MANUAL | PLANNED  |

## F. Infrastructure

| ID  | Criterion                                                                                                            | Proof                                                        | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| F1  | `docker compose up` (one command, from a clean clone with `.env` from `.env.example`) starts PostgreSQL + API + web.  | MANUAL (Phase 8 clean-clone audit)                           | PLANNED  |
| F2  | Environment configuration is validated at boot; missing/invalid required variables fail fast with a clear message.    | AUTOMATED `T-CONFIG-01`                                      | PLANNED  |
| F3  | `GET /health` reports `200` when the database is reachable and `503` when it is not.                                 | AUTOMATED `T-HEALTH-01`                                      | PLANNED  |
| F4  | Integration tests run against **real PostgreSQL** (separate test database), never a mock or in-memory substitute.    | INSPECTION + AUTOMATED (suite itself)                         | PLANNED  |
| F5  | Strict TypeScript passes (`npm run typecheck`) and lint/format checks pass.                                          | MANUAL (commands in every phase's exit gate)                  | PLANNED  |

## G. Documentation and submission

| ID  | Criterion                                                                                                                                     | Proof       | Status   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| G1  | `README.md` covers prerequisites, setup, architecture, commands, assumptions, decisions, late-payment policy, tests, limitations, future work. | INSPECTION  | PLANNED  |
| G2  | `AI_NOTES.md` states the real AI tools used, how, one effective prompt, one specific real AI mistake + its detection, and human verification — nothing fabricated. | INSPECTION  | PARTIAL (template created in Phase 0 with fields honestly marked pending) |
| G3  | A clean clone passes every documented setup step with no manual fix-ups.                                                                      | MANUAL      | PLANNED  |
| G4  | No secret, credential, populated `.env`, dependency directory, or build artifact is committed.                                                | INSPECTION (`git log -p` sweep)                             | PLANNED  |
| G5  | This repository (not a new one) contains the work; history is not rewritten; commits are focused and honest.                                  | INSPECTION + Git verification                               | IN PROGRESS (blueprint commit this phase) |

---

## Mandatory scenario traceability

The assignment's three mandated demonstrations map to:

1. **Ten concurrent customers, last two units** → `T-CONC-01` (criteria B5, B8, A4, A6).
2. **Replayed payment event processes once** → `T-IDEM-01` (criteria C6, C12), reinforced by `T-IDEM-02`/`T-IDEM-03`.
3. **Two concurrent pickup claims** → `T-CONC-02` (criteria D2, D4, D5).

Each must pass against real PostgreSQL, and the concurrency tests must survive a ≥10-iteration soak loop before the corresponding exit criterion may be checked off in `IMPLEMENTATION_PLAN.md`.
