# AI_NOTES.md

Honest record of how AI was used while building this project.
**Rule: never fabricate.** Only record what actually happened, when it happened. Fields stay `PENDING` until real experience fills them. Recording a fabricated tool, prompt, mistake, or verification is itself an academic-integrity violation.

_Last updated: Phase 7 (customer screen) + final submission audit._

---

## 1. AI tool(s) actually used

| Tool                                                                         | Version/model                                                                                         | Where used                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Freebuff "Buffy" coding agent (Codebuff)                                     | Session ran two models: MiniMax M3.1 Flash (Phase 0 docs) and mimo/mimo-v2.5 (Phase 1 implementation) | Drafting the Phase 0 blueprint docs; implementing and verifying Phase 1 |
| Local terminal / Git / npm (agent-driven on the developer's Windows machine) | Node v24.15.0, npm 11.12.1, Git 2.56.0                                                                | All commands recorded in this file and in README's verification section |

## 2. What each tool helped with

- Drafted the Phase 0 engineering documents (`AGENTS.md`, plan, acceptance criteria, README, `.env.example`).
- Implemented all Phase 1 code: workspace configs, zod-backed `config.ts`, migration runner, `0001_init.sql`, seed, `/health`, Docker artifacts, the web starter, and the Vitest suites.
- Ran and interpreted the verification commands (install, lint, typecheck, build, tests, and the real-PostgreSQL checks), and caught failures rather than routing around them.
- Final audit: built the Phase 7 customer screen (`apps/web`) and the C14 `send-webhook` sender, exercised the full flow in a browser against the compiled API, ran the git-history secret sweep, and re-ran every gate (typecheck, lint, format, build, 63/63 tests on real PostgreSQL 18.4).

## 3. One prompt that worked well

The Phase 1 hand-off prompt (written by the human) was effective because it pinned scope, required honest verification, and pre-authorized the fallback when tooling is missing. Excerpt (verbatim):

```text
Use the available terminal to perform as many of these checks as the environment supports:
...
If Docker is unavailable, report that explicitly and still run all checks possible locally.
Do not claim live database or Compose verification without actual successful execution.
Add small, genuine automated tests for configuration validation, migration behavior, or health handling if practical.
```

Why it worked: the explicit "do not claim X without actual execution" constraint is what separates a trustworthy report from a fabricated one, and "report that explicitly" gave permission to state the Docker gap instead of hiding it.

## 4. One specific AI mistake, and how it was detected

- **Mistake:** The AI-written zod config schema placed cross-field policy checks ("DATABASE_URL is required in production", "WEBHOOK_SECRET is required in production") in an object-level `.superRefine()`. In zod v3, outer refinements are skipped once a nested field parse fails, so an env like `NODE_ENV=production, API_PORT=0, HOLD_TTL_SECONDS=-1` reported only the two field errors and silently dropped the two "required in production" errors.
- **Detected by:** The AI-written unit test `collects multiple issues in a single failure` (`apps/api/tests/config.test.ts`), which asserted ≥ 3 collected issues and failed with exactly 2. (Found on the first full test run of Phase 1 — the test caught the code, not the other way around.)
- **Resolution:** Restructured `loadConfig` so zod validates shape/enum/integer fields while cross-field policy checks run unconditionally on the raw source after parsing, guaranteeing every problem is reported in one failure. All 13 config tests now pass; the behavior is covered by the same test that caught the bug.

### Later real mistakes (Phase 2)

- **Mistake (serious — a genuine oversell bug):** The first `POST /orders` implementation computed availability in the **same SQL statement** that took the `FOR UPDATE` locks, even though the plan documented "lock first, then compute availability in a later statement". Under READ COMMITTED that statement's snapshot is taken _before_ it waits for the locks, so a transaction that queued behind a competitor still read pre-competitor availability. Result: all ten racers in the mandatory concurrency test created orders for a 2-unit product, and both reversed-order pairs in the lock-ordering test succeeded.
- **Detected by:** The AI-written integration tests T-CONC-01 and T-LOCK-01 (`apps/api/tests/orders.integration.test.ts`): `expected 10 to be 2` and `expected [201, 201] to deeply equal [201, 409]` — the tests proved the oversell instead of being adjusted to hide it.
- **Resolution:** Split into two statements: a pure lock statement (`SELECT id … ORDER BY id FOR UPDATE`), then a separate availability statement whose fresh snapshot sees everything committed while the locks were awaited. The bug and its mechanism are documented in the code comments and README.
- **Two smaller Phase 2 catches, for completeness:** (1) `SUM()` returns `bigint`, so `available_units` crossed the JSON boundary as a string (`expected '4' to be 4`) — fixed with an explicit `::int` cast in SQL; (2) test fixtures expired orders by moving only `expires_at`, violating the legitimate `orders_expires_after_creation` CHECK — fixed by moving `created_at` too (simulating an hour-old order) rather than weakening the schema constraint.

### Later real mistakes (Phase 3)

- **Mistake:** Two defects in the newly written lifecycle test code: an assertion expected `totalPaise` 7500 when the fixture's default price (1500 × 3) makes it 4500, and a query `WHERE id = ANY ($1::uuid[])` was given three bind parameters instead of one array (runtime error: "bind message supplies 3 parameters, but prepared statement requires 1").
- **Detected by:** Running the suite — both failures pointed at the test lines, not the endpoint. The `GET /orders/:id` implementation itself passed all nine required cases on its first run.
- **Resolution:** Corrected the expected total and the parameter binding. Recorded here because both are real defects that existed in the committed code, however small.

### Later real mistakes (Phase 4)

- **Mistake 1 (tooling — self-inflicted file corruption):** While repairing the prior attempt, the agent repeatedly sliced `webhook.ts` with `tail -n +N`/`sed` on guessed line numbers and re-appended it, instead of reading the file and making a targeted edit. Each pass duplicated the import block (`import { createPool } from '...' as any;` — itself invalid TypeScript) and eventually chopped the top of the file off. This is why the earlier turns produced a long streak of "No change to the file" / TS1005 errors.
- **Detected by:** `npx tsc -p tsconfig.json` reporting `TS1005: ';' expected` at the import lines, plus `head`/`cat -A` inspection showing duplicated `import … as any;` lines and a file that began mid-comment.
- **Resolution:** Abandoned slicing entirely. Restored `app.ts` from git, then rewrote `app.ts` and `webhook.ts` coherently with `write_file`, and replaced the corrupted "test" file (which was actually a stale copy of an older webhook source, containing no `describe`/`it`) with a genuine integration suite. Lesson recorded: when targeted edits fail, read the whole file and rewrite it once — do not stitch it from guessed offsets.

- **Mistake 2 (real correctness bugs in the inherited webhook code):** (a) The handler SELECTed/UPDATEed `payment_events.provider_status` and read `received_amount_paise` — columns that do not exist in `0001_init.sql`, so every event would have failed at runtime with "column does not exist"; `status` and `amount_paise` already carry those values. (b) Late-payment detection compared `expires_at <= new Date()` (a Node clock — a direct violation of invariant I2) and then attempted a `pending → expired → needs_review` double-flip, where the second guarded `UPDATE … WHERE status = 'pending'` could never match, silently leaving the order `expired` instead of `needs_review`. (c) `app.ts` mounted `express.json()` before the raw parser for the webhook path, which would have parsed-and-reserialized the body before the HMAC ran (violating I8).
- **Detected by:** Reading `0001_init.sql` and the webhook source side by side during the audit (schema mismatch and `new Date()` are inspection catches), and by the raw-bytes test `T-WH-02` (re-formatted canonical JSON must be rejected) once the middleware order was corrected.
- **Resolution:** Removed the non-existent column references; replaced the late-payment branch with a single DB-clock `needs_review('late_payment')` transition guarded by `FOR UPDATE`; moved `express.raw()` for `/payments/webhook` ahead of the global `express.json()`. All verified by the 14-test webhook suite plus a 10× soak on real PostgreSQL.

### Later real mistakes (Phase 5)

- **Mistake (self-contradictory claim transaction):** The first `claimOrder` implementation ran the lazy `pending → expired` flip (the same guarded UPDATE used by `GET /orders/:id`) inside the claim transaction, and its doc comment claimed the endpoint was a new "observation point" that materializes expiry. But every rejected claim is designed to `ROLLBACK` — so the flip was always undone, and the endpoint could answer `409 ORDER_EXPIRED` while the stored row still said `pending`. The design contradicted its own rollback semantics.
- **Detected by:** The AI-written test T-PICK-02 (`apps/api/tests/pickup.integration.test.ts`): the claim itself correctly returned `409 ORDER_EXPIRED`, but the next assertion — that the row had been materialized to `expired` — failed with `AssertionError: expected 'pending' to be 'expired'`. The test refused the inconsistency instead of being relaxed to accept `pending`.
- **Resolution:** Rejected claims are now strictly read-only: the locking `SELECT … FOR UPDATE` carries `(expires_at <= now()) AS is_expired` (database clock, I2) and the eligibility gate uses it directly — `expired`/stale-`pending` → `ORDER_EXPIRED` with zero writes. Expiry materialization stays with the two documented observation points. T-PICK-02 now asserts the row is still `pending` after the rejected claim and flips to `expired` at the very next `GET`, which proves both the read-only rejection and the lifecycle behavior.

### Later real mistakes (final audit)

- **Mistake (latent Phase 1 defect):** `apps/api/Dockerfile` ended with `CMD ['node', 'apps/api/dist/server.js']` — Docker's exec form is JSON and requires double quotes; the single-quoted form is invalid and would likely fail the image build. It survived because Docker was never available to run the build.
- **Detected by:** Reading the Dockerfile during the submission audit (inspection, not a test — no Docker exists on this machine to fail it).
- **Resolution:** Changed to `CMD ["node", "apps/api/dist/server.js"]`. Honest caveat recorded in the plan: this remains **unverified locally** (`docker: command not found`); the corrected form follows the Dockerfile reference syntax.

- **Mistake 2 (fresh clones failed `format:check`):** the repo had no `.gitattributes`, so on Windows (`core.autocrlf=true`) a fresh clone checked every file out as CRLF while Prettier's default `endOfLine` is `lf` — 48 files failed in the clone even though the working tree passed (it only passed because Prettier/ESLint had rewritten those files with LF in place).
- **Detected by:** actually running the documented sequence in a real fresh clone for the first time (clean-clone audit, G3) instead of trusting the passing working tree.
- **Resolution:** added `.gitattributes` (`* text=auto eol=lf`) and stated `"endOfLine": "lf"` in `.prettierrc.json`; the re-cloned `format:check` passes.

- **Mistake 3 (the root `.env` was silently ignored):** all four entry points used `import 'dotenv/config'`, which resolves `.env` from `process.cwd()` — but npm runs workspace scripts with `cwd = apps/api`, so the repository-root `.env` that the README documents was never loaded. `npm run migrate` in the fresh clone hit `ECONNREFUSED ::1:5432` because the built-in dev defaults were used instead. `apps/web/vite.config.ts` had the same class of bug (`loadEnv` only from `apps/web`). The defect had survived since Phase 1 because the dev machine had no `.env` and the defaults happened to equal the Compose values.
- **Detected by:** the same clean-clone run — the `migrate` step failed with exit 1 while `npm test` (which reads `TEST_DATABASE_URL` from the shell) passed.
- **Resolution:** `src/load-env.ts` loads the `.env` from `INIT_CWD` (the directory npm was invoked from) then the cwd one, without ever overriding real environment variables; the four entry points import it, and the Vite config merges the repo-root env over the cwd one. Verified with `DATABASE_URL` stripped from the environment: migrate/seed now resolve the root `.env`, and `loadEnv(repoRoot)` returns `VITE_API_BASE_URL` where the old lookup returned nothing.

## 5. Human verification performed

**Status: PENDING — no human verification has been performed yet.**

The Phase 1 and Phase 2 verification listed in the README and completion reports was executed by the AI agent on the developer's machine, not by the human. The human should still: review the diff, re-run `npm install && npm run typecheck && npm run lint && npm test` (with a PostgreSQL available and `TEST_DATABASE_URL` set), run `docker compose up --build` on a Docker-capable machine, and complete the clean-clone audit in `IMPLEMENTATION_PLAN.md` Phase 8.

- _PENDING — to be filled by the human (or by a human-supervised re-run) when it actually happens._

---

## Honesty checklist (for the final submission)

- [ ] Every tool listed above was genuinely used, with its real version/model.
- [ ] The "worked well" prompt is verbatim and was actually sent.
- [ ] The recorded mistake is a real one that actually occurred and was actually detected.
- [ ] Human verification entries correspond to checks that were really performed.
- [ ] No entry claims a test ran, or passed, that did not actually run and pass.
