# Implementation Plan: Guardrail Infrastructure Port (V1/V3/V6/V7 → v1-alpha)

**Branch**: `20260812-075013-guardrail-infra-port` | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20260812-075013-guardrail-infra-port/spec.md`

## Summary

Port four generic, product-shape-independent guardrail slices from
`krt/guardrail_validation` (V1 validation kernel, V3 auth-failure
throttling + request id, V6 egress/SSRF policy, V7 shared client+server
validation package) into `v1-alpha` as new, additive infrastructure —
closing measured gaps (no request id, no auth-failure throttling, two
unvalidated routes, an error-message leak, three unguarded outbound-fetch
call sites) without retrofitting or regressing the ~20 routes, the
auth/identity/datasource checks, and the three pre-existing generation/
execution concurrency ceilings that already work correctly. See
`research.md` for the six planning decisions this required — Decision 5 in
particular narrows V3's scope after discovering `flow-chat.service.ts`,
`flow-generation-job.service.ts`, and `tenant-budget.service.ts` already
implement FR-006 completely; this feature does not duplicate them.

## Technical Context

**Language/Version**: TypeScript, ES2022 target, `NodeNext` module resolution
(matches every existing `packages/*/tsconfig.json`).

**Primary Dependencies**: Express 4 (`packages/server`), Next.js
(`packages/client`), `zod` (validation — already the dominant pattern),
`jose` (already used by `identity.middleware.ts`), no new runtime dependency
beyond what's already in the workspace.

**Storage**: None new. Postgres (already running) is untouched by this
feature — rate-limit/concurrency state is in-memory (Decision 1, `research.md`).

**Testing**: Vitest `^2.1.8`, colocated `*.test.ts` files, matching every
existing package.

**Target Platform**: Linux server, Docker Compose, single Express process.

**Project Type**: Web service (API) + web client, pnpm workspace monorepo.

**Performance Goals**: None new — this feature is about correctness of new
rejection paths, not throughput.

**Constraints**: No new infrastructure service (no Redis — reintroducing one
would contradict a documented prior removal; see `research.md` Decision 1).
Must not change any 2xx response body or existing test outcome (FR-013,
SC-007) except the one documented, justified 5xx-body narrowing (removing a
leaking `.message` field — see `contracts/http-response-contracts.md`).

**Scale/Scope**: Single server instance, single Postgres instance — sized for
the deployment that exists today, not a hypothetical multi-replica future.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design below.*

| Principle | Check | Status |
|---|---|---|
| I. Spec-First | This plan, `research.md`, `data-model.md`, `contracts/`, `quickstart.md` all exist under this feature's `specs/` directory before any source write; `tasks.md` (Phase 2) gates `/speckit-implement`. | PASS |
| II. Test-First | Every new module (`validation/`, `rate-limit/`, `egress/`, `rules/`) ships with colocated tests per the existing convention; `tasks.md` will order test-writing alongside each implementation task, not after. `quickstart.md`'s SC-007 regression diff is the acceptance gate for "no existing test broke." | PASS (to be enforced task-by-task in `tasks.md`) |
| III. Code Review | Not applicable at planning time — enforced at PR time via `/speckit-comply`. | DEFERRED (post-implementation) |
| IV. Simplicity/YAGNI | Directly shaped this plan: Decision 1 (in-memory, not Postgres/Redis), Decision 3 (close 2 gaps, don't retrofit 20 working routes), Decision 4 (one shared package, not four). Each is justified in `research.md` against this principle by name. | PASS |
| V. Observability | Request id (Decision 6) threads through every new rejection path (400/429/503/egress-reject/5xx); auth failures are logged with context (FR-007); egress denials log the resolved address server-side even though the response body only carries a `reason` enum (`contracts/http-response-contracts.md`). | PASS |
| VI. Branch Discipline | Timestamp branch `20260812-075013-guardrail-infra-port`, one `specs/` directory, matches the branch this session already created via the git extension hook. | PASS |
| VII. Documentation Currency | `tasks.md` (next phase) will include a task to update `CLAUDE.md`'s v1-alpha section (if one exists) or add the equivalent doc-currency note once code lands — tracked explicitly rather than assumed. | PASS (tracked forward) |
| VIII. Secrets Hygiene | No feature artifact here references a credential value; the shared package and new middleware read no secrets. | PASS |

No violations requiring the Complexity Tracking table below to be filled.

## Project Structure

### Documentation (this feature)

```text
specs/20260812-075013-guardrail-infra-port/
├── spec.md               # Feature specification
├── plan.md               # This file
├── research.md           # Phase 0 output — 6 grounded decisions
├── data-model.md          # Phase 1 output — runtime entities + shared-package API surface
├── contracts/
│   └── http-response-contracts.md   # New/changed response shapes
├── quickstart.md          # Phase 1 output — manual + automated validation steps
└── tasks.md               # Phase 2 output (/speckit-tasks — not created by this command)
```

### Source Code (repository root)

```text
packages/
├── shared/                          # NEW package — @foundry/shared
│   ├── package.json                 # Mirrors packages/redact/package.json exactly
│   ├── tsconfig.json                # Mirrors packages/redact/tsconfig.json exactly
│   └── src/
│       ├── index.ts                 # Re-exports the four submodules
│       ├── validation/
│       │   ├── index.ts             # validate() middleware factory + primitives
│       │   └── validation.test.ts
│       ├── rate-limit/
│       │   ├── index.ts             # authFailureThrottle only (Decision 5 — no generic
│       │   │                        #   rate limiter/concurrency ceiling: those already
│       │   │                        #   exist for generation/execution and are not duplicated)
│       │   └── rate-limit.test.ts
│       ├── egress/
│       │   ├── index.ts             # classifyHost, guardedFetch, STRICT/PERMISSIVE profiles
│       │   └── egress.test.ts
│       └── rules/
│           ├── index.ts             # ENV_NAME_RE, AUTH_STYLES
│           └── rules.test.ts        # SC-006 equivalence tests live here
│
├── server/src/
│   ├── app.ts                       # CHANGED: mount request-id middleware first (only
│   │                                 #   structural addition to this file). No existing
│   │                                 #   mount reordered or removed.
│   ├── middleware/
│   │   ├── request-id.middleware.ts # NEW
│   │   ├── request-id.middleware.test.ts   # NEW
│   │   └── error.middleware.ts      # CHANGED: 2 fallback branches stop leaking err.message
│   ├── routes/
│   │   ├── catalogue.ts             # CHANGED: adopt validate() for workspaceId
│   │   └── ops-proxy.ts             # CHANGED: adopt validate() + egress check for /llm/*
│   └── services/
│       ├── trigger-scheduler.ts     # CHANGED: bare fetch → guardedFetch (STRICT)
│       └── step-execution.service.ts  # CHANGED: bare fetch → guardedFetch (STRICT) for tool calls
│
└── client/src/lib/
    ├── secret-edit.ts               # CHANGED: import ENV_NAME_RE from @foundry/shared
    └── tool-edit.ts                 # CHANGED: import ENV_NAME_RE/AUTH_STYLES from @foundry/shared
```

**Structure Decision**: New `packages/shared` package (Decision 4), consumed
by both `packages/server` and `packages/client` as a `workspace:*` dependency,
added to root `postinstall`'s build-order list alongside `@foundry/redact`/
`@foundry/flow-edit`. All other changes are narrow edits to the exact files
named in `research.md`'s summary table — no new route files, no new services,
no directory restructuring of either existing package.

## Complexity Tracking

*No entries — Constitution Check found no violations requiring justification.*
