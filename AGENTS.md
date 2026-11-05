# Repository Guidelines

This repository uses **enforced spec-driven development** with
[GitHub spec-kit](https://github.com/github/spec-kit). These rules apply to
every AI coding agent (Claude Code, Codex CLI, Cursor, Gemini CLI, and any
other) and to every session.

<!-- TEAM-RULES:BEGIN (do not remove; enforced by scripts/spec-gate-core.sh, .githooks/pre-commit and ci/check-spec-compliance.sh) -->
## Team Rules: Enforced Spec-Driven Development

1. **ALL source-code changes go through the spec-kit workflow**:
   `/speckit-specify` → (`/speckit-clarify`) → `/speckit-plan` →
   `/speckit-tasks` → `/speckit-implement`.
   (Gemini CLI uses dots: `/speckit.specify` etc. Codex invokes skills as
   `$speckit-specify`.)

2. **If asked to change code and there is no active feature** (no feature
   directory under `specs/` with `spec.md`, `plan.md` AND `tasks.md`),
   DO NOT edit source files. First run `/speckit-specify` with the requested
   change as the feature description, and complete plan + tasks.

3. **A pre-write hook denies source-file writes outside this workflow.**
   If a write is denied, read the denial reason and run the command it names.
   NEVER attempt to work around the hook (no shell redirection tricks, no
   scripting language file writes, no editing the hook/policy files).

4. **Manual or uncovered changes**: if you detect a dirty working tree or
   committed diffs not reflected in the feature's `tasks.md`, run
   `/speckit-backfill` (reverse-engineers spec/plan/tasks from the diff),
   then `/speckit-comply`.

5. **Run `/speckit-comply` before declaring a feature complete or opening a
   PR.** Resolve CRITICAL findings first.

6. **Never set `SPECKIT_ENFORCE=0`, use `git commit --no-verify`, or create a
   `.speckit-template-dev` file** unless a human explicitly instructs you to
   in this session.

7. **Always-editable paths** (no feature required): `specs/**`, `.specify/**`,
   `docs/**`, agent skill/command directories (`.claude/skills/`,
   `.agents/skills/`, `.cursor/skills/`, `.gemini/commands/`), `.gitignore`,
   `LICENSE`, and standalone `*.md` docs. Everything else is source.

8. **Branching**: features live on timestamp branches
   (`YYYYMMDD-HHMMSS-slug`) created by the spec-kit git extension during
   `/speckit-specify`. Do not create feature branches by hand. Emergency
   fixes use `hotfix/*` and require a follow-up `/speckit-backfill` PR.

9. **Secrets (constitution article VIII, NON-NEGOTIABLE)**: NEVER hardcode
   API keys, tokens, passwords, connection strings or private keys in any
   tracked file - source, config, specs or docs. Read secrets from
   environment variables or Azure Key Vault. Local values go ONLY in `.env`
   (gitignored); add a placeholder line to `.env.example` for every variable
   you introduce. Never commit `.env`, `*.pem`, `id_rsa`, or similar files.
   If a hook blocks you for a "hardcoded secret", refactor the code to read
   the value from the environment - do not reword the string to evade the
   scanner. If you notice a real credential already committed, STOP and tell
   the human: it must be rotated and purged from history.

10. **Foundational standards come first**: a new project MUST run
    `/speckit-start` to establish its standards (Constitution, Frameworks,
    Security, and Design if it has a UI) before any source work. The pre-write
    hook hard-blocks source writes until the required standards exist (security
    always; design only when the project has a UI). If a write is denied for a
    missing standard, run `/speckit-start`. Change an existing standard only via
    `/speckit-update-standards` (never by silent edit). All code MUST conform to
    these standards; conformance is checked by `/speckit-comply` and the
    pull-time review.

See `.specify/memory/constitution.md` for the project principles and
`docs/TEAM-WORKFLOW.md` for the full team workflow.
<!-- TEAM-RULES:END -->

<!-- STANDARDS-CONTEXT:BEGIN (do not remove) -->
## Foundational Standards (load every session)

At the start of every session, read the following project standards **if they
exist** and treat them as binding for all work. They are established by
`/speckit-start` and amended by `/speckit-update-standards`:

- `.specify/memory/constitution.md` — governing principles
- `.specify/memory/frameworks.md` — chosen stack + whether the project has a UI
- `.specify/memory/security.md` — security posture (applies to every project)
- `.specify/memory/design.md` — UI/UX design system (UI projects only); build UI
  by composing from the scaffolded component library it references
- `.specify/memory/standards.json` — machine-readable manifest (arming state +
  `has_ui`); the pre-write gate reads this

If `standards.json` shows `status: pending`, onboarding is incomplete - run
`/speckit-start`. See `docs/STANDARDS.md` for the full model.
<!-- STANDARDS-CONTEXT:END -->

## Project Overview

Foundry Parent Application — workspace-centric script generation atop a flow
engine (Kestra). pnpm monorepo (`packages/*`): Express API (`server`),
Next.js UI (`client`), flow-editing library (`flow-edit`), shared validation
(`shared`), redaction (`redact`), operational tool layer with its own database
(`ops-api`), standalone MCP bridge (`mcp-bridge`).

## Architecture & Data Flow

- **Request path:** Next.js client (`packages/client/src/app`) → parent REST
  API (`packages/server/src/routes`, `app.ts`) → services
  (`packages/server/src/services`) → repositories
  (`packages/server/src/repositories`, drizzle-orm + `pg`) → Postgres
  (`foundry_parent`). Cross-cutting checks live in
  `packages/server/src/middleware` (identity, run-requester,
  revision-provenance, error, async-routes).
- **Flow execution:** server compiles models (`flow-compiler.service.ts`,
  `flow-validator.service.ts`) and drives Kestra as an internal engine —
  clients never reach Kestra directly. Run progress streams over WebSocket
  (`/ws/flow-execution`, ticket-authorised); the run page falls back to
  polling without it. Kestra flows/verify harnesses live in
  `packages/server/src/kestra`.
- **Chat builder:** `flow-chat.service.ts` + `flow-chat-op.ts` turn chat into
  ops applied through `@foundry/flow-edit` (`packages/flow-edit/src/ops.ts`);
  single-op turns only (`chat-turn-one-op.test.ts`). Display/expression
  conversion lives in `from-model.ts` / `model-version.ts` / `render.ts`.
- **Compiled builder (goal → flow):** `flow-chat-builder.ts` →
  `builder/conversation.ts` drive whole-workflow builds from chat. Its
  clarification state is durable on the flow's incomplete build: append-only
  `answers` keyed by CONTENT-stable question ids, `deferred` (a defer closes
  that question for the build), `clarifyRounds` (clarification bounded at 5 —
  then a terminal accept/discard offer). A question is asked once, whatever
  the model returns: `specs/20261001-174640-builder-clarify-loop/`.
- **Ops layer:** `ops-api` is a separate Express service with its own Postgres
  database and per-route auth (14 endpoints); it was split out of server so
  tool calls terminate away from parent credentials. `mcp-bridge` is likewise
  standalone with its own API key (`MCP_BRIDGE_API_KEY`, never
  `PARENT_API_KEY`).
- **Shared code:** `@foundry/shared` (zod validation), `@foundry/redact`,
  `@foundry/flow-edit` (no runtime deps). Client consumes
  `@foundry/flow-edit` and `@foundry/shared` via `workspace:*`.

## Key Directories

- `packages/server/src/routes` — REST endpoints (`flows.ts`, `steps.ts`,
  `triggers.ts`, `email-box.ts`, `mail.ts`, …).
- `packages/server/src/services` — business logic (`flow*.service.ts`,
  `trigger.service.ts`, `ops-client.service.ts`, `mail*.ts`, …).
- `packages/server/src/repositories` — drizzle data access (`flow.repo.ts`,
  `flow-execution.repo.ts`, `tool.repo.ts`, …).
- `packages/server/src/db` — `schema.ts`, `migrate.ts`, migration tests.
- `packages/server/src/demo`, `scenarios`, `showcase` — seed/verify datasets
  and flows (`hr-demo-flows.ts`, `finance-flows.ts`, `itops-flows.ts`, …).
- `packages/server/src/kestra` — engine flows (`*.flow.yml`) plus
  `phase*-verify.ts` / `*-verify.ts` harnesses.
- `packages/client/src/app` — Next.js App Router pages and API routes.
- `packages/client/src/components/flow|automation|data|admin|workspace` —
  domain UI; `components/ui|layout|shell` — shared UI.
- `packages/client/src/lib` — API clients (`api.ts`, `foundry-client.ts`),
  canvas model/layout (`canvas-model.ts`, `canvas-layout.ts`), flow helpers.
- `packages/flow-edit/src` — `ops.ts`, `node-types.ts`, `from-model.ts`,
  `model-version.ts`, `render.ts`, `inventory.ts`.
- `packages/shared/src` — `validation/`, `request-policy/`, `rules/`,
  `rate-limit/`, `egress/`.
- `packages/ops-api/src/routes|db|llm` — ops endpoints, own schema, provider.
- `infra/` — `docker-compose.yml` (single source of truth for local stack).
- `scripts/`, `ci/`, `.githooks/` — gates, checks, backup/restore, Kestra/CA
  helpers. `specs/<YYYYMMDD-HHMMSS-slug>/` — one directory per feature.
  `docs/` — workflow, standards, runbooks, `nodes/`, `canvas/`, `design/`.

## Development Commands

```bash
./setup.sh                                  # first clone: hooks, tools, standards gate
cp .env.example .env                        # required; server loads ../../.env
pnpm --filter @foundry/server dev           # API with tsx watch
pnpm --filter @foundry/client dev           # Next.js on :4002
pnpm --filter @foundry/mcp-bridge dev
pnpm -r --parallel dev                      # everything
pnpm -r build | pnpm -r typecheck | pnpm -r test
pnpm --filter @foundry/server db:generate|db:migrate|db:push
docker compose --env-file .env -f infra/docker-compose.yml up --build  # full stack, from repo root
node scripts/e2e-smoke.mjs                  # smoke; bash scripts/kestra-boundary-check.sh
bash scripts/ui-honesty-check.sh            # client UI honesty gate
```

Server is seed-heavy: `pnpm --filter @foundry/server demo:seed demo:seed-alt
finance:seed legal:seed itops:seed generic:seed catalogue:seed`
(`seed:all`), plus `demo:verify`, `scenarios:verify`, `showcase:verify`,
and `kestra:phase1-verify|phase3|phase4|phase6`, `kestra:prove`,
`kestra:system`. Host-side Kestra harnesses need
`eval "$(./scripts/kestra-env.sh)"` first. Backup:
`pnpm backup` / `backup:verify` / `restore`.

## Code Conventions & Common Patterns

- **ESM everywhere** (`"type": "module"`); TypeScript strict-ish; `tsc --noEmit`
  per package (`flow-edit` typechecks via `tsconfig.typecheck.json`).
- **Layering:** routes parse/validate (zod) → services decide → repositories
  persist. New failure paths log actionable context (what, inputs, remedy);
  user errors must be diagnosable from logs; no silent catch-and-continue
  (constitution V).
- **Colocated tests:** `*.test.ts(x)` next to source, e.g.
  `packages/server/src/services/flow-compiler.test.ts`,
  `packages/client/src/lib/canvas-model.test.ts`. Name tests after the unit
  under test; keep contract/behaviour tests (e.g. `chat-turn-one-op`,
  `revision-provenance`, `callback-body-limit`) with the code they pin.
- **Simplicity (constitution IV):** YAGNI; new deps/abstractions/layers need
  justification in `plan.md`; prefer deleting code.
- **Docs currency (constitution VII):** update `specs/`, `docs/`, and agent
  context in the same PR as the behaviour change.
- **Branching/releases:** one feature = one timestamp branch =
  one `specs/` dir; squash-merge to `main`; release line `release/beta` with
  annotated `beta-1.x` tags (see `docs/VERSIONING.md` — patches group fixes,
  `git push --tags` banned).
- **Client:** App Router + React 18 + Tailwind; canvas via `@xyflow/react` +
  `@dagrejs/dagre`; auth via `next-auth` beta; fonts IBM Plex Sans +
  JetBrains Mono.

## Important Files

- Entry points: `packages/server/src/index.ts`, `app.ts`;
  `packages/client/src/app/layout.tsx`, `page.tsx`, `middleware.ts`;
  `packages/ops-api/src/index.ts`, `packages/mcp-bridge/src/index.ts`.
- Configs: `package.json`, `pnpm-workspace.yaml`, `.node-version`/`.nvmrc`
  (Node 22), per-package `tsconfig*.json`, `packages/client/vitest.config.ts`
  + `tailwind`/`postcss` configs, `opencode.json`, `.mcp.json`.
- Data: `packages/server/src/db/schema.ts`,
  `packages/ops-api/src/db/schema.ts`, `infra/docker-compose.yml`.
- Policy: `.specify/memory/constitution.md`, `ci/spec-policy.sh`,
  `ci/secret-policy.sh`, `scripts/spec-gate-core.sh`,
  `.githooks/pre-commit|pre-push`, `azure-pipelines.yml`.
- Env: `.env` (gitignored, local only), `.env.example` (committed template —
  add a placeholder line per new variable).

## Runtime/Tooling Preferences

- **Node >= 22** (`.node-version`, `.nvmrc`, `engines`; CI pins `22.x` —
  jsdom/undici needs `worker_threads.markAsUncloneable`), **pnpm 10.29.2**
  (`packageManager`, frozen lockfile in CI; run `corepack enable`).
- `postinstall` builds `@foundry/redact`, `@foundry/flow-edit`,
  `@foundry/shared` first — build order matters.
- Docker: run compose **from the repo root with `--env-file .env`** or
  interpolation/CA trust silently breaks. Ports: `4000` API, `4001` WS,
  `4002` web, `4003` mcp-bridge, `4004` ops-api, `5433` Postgres
  (`foundry`/`foundry`/`foundry_parent`). No Redis (removed — do not re-add
  without a consumer). Kestra has **no published port** (`internal: true`);
  never proxy/iframe it; host scripts use `scripts/kestra-env.sh`.
- Corporate proxy: `./scripts/stage-corp-ca.sh` + `CORP_CA_FILE=corp-ca.pem`
  + `./scripts/check-corp-ca-trust.sh`. Gates need `git`, `jq`, `uv`, and one
  agent CLI.

## Testing & QA

- **Frameworks:** Vitest everywhere (`vitest run` per package, `pnpm -r test`
  for all). Client adds `jsdom` + `@testing-library/react`; server tests hit
  routes/services/repos/middleware/demo/scenarios; `flow-edit`/`shared`/
  `redact`/`ops-api` test pure logic, validation, rules, rate-limit, egress.
- **Run:** `pnpm --filter <pkg> test` for scope; `pnpm vitest run
  src/.../<file>.test.ts` for a single file. Keep new tests colocated and
  behaviour-focused; every behaviour change ships with tests (constitution
  II), justified in `plan.md` if absent.
- **Gates (all must pass for merge):** secret scan (no exceptions, every
  branch), spec-compliance gate, plugin-manifest gate (removals recorded),
  client typecheck + tests + `ui-honesty-check.sh`. Pre-commit blocks
  uncovered changes/wrong branch names/staged secrets; pre-push re-scans for
  secrets. `check-standards-compliance.sh` reports on pull (read-only).
- **Expectation:** green package suite + clean typecheck before
  `/speckit-comply`; fix CRITICAL findings first; never bypass gates to get
  green.
