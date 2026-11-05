# Quickstart: validating the clarification-loop fix

**Feature**: [spec.md](./spec.md) | **Contract**: [contracts/clarification-turn.md](./contracts/clarification-turn.md)

## Prerequisites

- Node 22, `corepack enable` (pnpm 10.29.2)
- `.env` present (`cp .env.example .env`); local Postgres per
  `infra/docker-compose.yml` if running the server (unit tests do not need it)

## 1. Automated suites (primary evidence)

```bash
# The turn state machine — accumulation, defer, bound, stable ids
pnpm --filter @foundry/server vitest run src/services/builder/conversation.test.ts

# Question identity + no-loop trace rules
pnpm --filter @foundry/server vitest run src/services/builder/build-questions.test.ts

# Chat seam filing (status truthfulness, question id sanitisation)
pnpm --filter @foundry/server vitest run src/services/flow-chat-builder.test.ts

# Panel rendering of statuses
pnpm --filter @foundry/client vitest run src/components/flow/ChatPanel.test.tsx

# Whole package, then everything
pnpm --filter @foundry/server test
pnpm -r test && pnpm -r typecheck
```

Expected: all green; the NEW regression tests in `conversation.test.ts`
(named for C1–C8) fail on the pre-fix code — run them against `70f07fa0` to
confirm they reproduce the field bug before the fix lands.

## 2. Field-transcript replay (end-to-end)

The scenario from the field report (local://paste-1.md):

1. Start the stack: `docker compose --env-file .env -f infra/docker-compose.yml up --build`,
   then `pnpm -r --parallel dev` (or the combined dev command from AGENTS.md).
2. Open the app (:4002), new chat, send:

   > get list of all orders that are pending, send two emails, one to
   > customer and one to the orderfulfilment@microland.com, input the
   > relevant body message into the email respectively

3. Answer each clarifying question once, in the report's own words:
   - "message relevant to the recipient"
   - "send it to himanshu.saini@microland.com"
   - "so order team gets message relevant to handling orders and customer
     gets a status update message"

**Expected outcomes** (contract clauses in brackets):

- The question "What do you mean by \"relevant body message\"?" is asked
  **exactly once** for the build — never re-asked after being answered [C2].
- "Not settled yet" items shrink or change reason each round; a byte-identical
  repeat after a relevant answer never appears [C5].
- Typing bare `leave` at any pending question defers it: draft kept, no
  further question, no "Needs your input" [C6].
- After 5 clarification rounds the builder stops asking and offers
  accept-or-stop [C7].
- A turn answered by code replay shows as answered with "no model call"
  wording only as a call count — never "Needs your input" while nothing is
  pending [C8].

## 3. Restart durability

While a build has accumulated answers (question pending or `clarifyRounds > 0`):

```bash
# restart only the API
pnpm --filter @foundry/server dev   # Ctrl-C, then again
```

Then send the next reply: prior answers still apply (no re-ask) [C9/C1].

## 4. Honesty gates

```bash
node scripts/e2e-smoke.mjs
bash scripts/ui-honesty-check.sh
pnpm vitest run            # in packages/client (typecheck + tests)
```
