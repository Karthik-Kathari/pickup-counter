# AI_NOTES.md

Honest record of how AI was used while building this project.
**Rule: never fabricate.** Only record what actually happened, when it happened. Fields stay `PENDING` until real experience fills them. Recording a fabricated tool, prompt, mistake, or verification is itself an academic-integrity violation.

_Last updated: Phase 1 (application foundation)._

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

## 5. Human verification performed

**Status: PENDING — no human verification has been performed yet.**

The Phase 1 verification listed in the README and completion report was executed by the AI agent on the developer's machine, not by the human. The human should still: review the diff, re-run `npm install && npm run typecheck && npm run lint && npm test` (with a PostgreSQL available and `TEST_DATABASE_URL` set), run `docker compose up --build` on a Docker-capable machine, and complete the clean-clone audit in `IMPLEMENTATION_PLAN.md` Phase 8.

- _PENDING — to be filled by the human (or by a human-supervised re-run) when it actually happens._

---

## Honesty checklist (for the final submission)

- [ ] Every tool listed above was genuinely used, with its real version/model.
- [ ] The "worked well" prompt is verbatim and was actually sent.
- [ ] The recorded mistake is a real one that actually occurred and was actually detected.
- [ ] Human verification entries correspond to checks that were really performed.
- [ ] No entry claims a test ran, or passed, that did not actually run and pass.
