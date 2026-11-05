# Implementation Plan: Guardrail Port — V2/V4/V5/V8 (krt/guardrail_validation → v1-alpha)

**Branch**: `20260812-101032-guardrail-v2-v4-v5-v8` | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20260812-101032-guardrail-v2-v4-v5-v8/spec.md`

## Summary

Second of two guardrail-port features from `krt/guardrail_validation` into `v1-alpha`. Of the four
slices assumed deferred by the first feature, planning's direct-evidence audit (continuing the same
methodology `research.md` of the prior feature used) found only two are real, present-day gaps:
mcp-bridge's total absence of authentication (the real part of V2) and the request-policy/clone-
detection engine (V8, in full). V4's envelope + injection-detection half is a real gap; its
`unrequested_action` half has no artifact to run against and stays out of scope. V5 needs no code —
`flow-expectation.service.ts` + `trigger.service.ts` already provide its exact discipline.

Planning went further than spec.md's own deferred assumptions required and found the V8 attach point
assumed in spec.md ("`flow-chat.service.ts`'s `turn()`, confirmed as the default per D-47") was
**wrong** — `turn()` is v1-alpha's chat-based *editing* surface, not creation. The actual
initial-creation free text lives in `flow-generation-job.service.ts`'s `runGeneration()`
(`input.goal` / `input.outline`). Both are real entry points; spec.md has been corrected in place
(FR-007, User Story 4, Assumptions) to name both rather than the one originally assumed. See
`research.md` Decision 2 for the full trace.

## Technical Context

**Language/Version**: TypeScript, ES2022 target, `NodeNext` module resolution — unchanged from the
prior feature.

**Primary Dependencies**: Express 4 (`packages/server`), `zod`, `@foundry/shared` (introduced by the
prior feature, extended here with a `request-policy` submodule). `packages/mcp-bridge` is a standalone
Express service with its own `package.json` — it does not depend on `packages/server` or
`@foundry/shared` today and this feature does not introduce that dependency (Decision 1).

**Storage**: None new. The request-policy TRANSFORM-proposal tracking (FR-009) is in-memory only,
mirroring the source branch's own design (`request-policy.service.ts`'s `issuedProposals` Map, TTL
30 min) — a lost in-flight proposal on restart just means the next attempt re-evaluates from scratch.

**Testing**: Vitest, colocated `*.test.ts`, matching every existing package including
`packages/mcp-bridge` (which currently has zero tests — this feature adds its first).

**Target Platform**: Linux server, Docker Compose. `packages/mcp-bridge` runs as its own container
(`foundry-parent-mcp-bridge`, :4003) — confirmed dead-on-arrival infrastructure (Decision 1): the
compose file's own comment states "nothing registers it today... not currently on any live path."

**Performance Goals**: None new. The request-policy check runs synchronously before an inference
call that already takes seconds — its own cost (regex matching over one short string) is immaterial
next to that, so no latency budget is tracked.

**Constraints**: No behavior change for any already-valid request (FR-013, SC-005, SC-007) — an
`allow` decision and an ordinary manifest build must be indistinguishable from today's. No change to
`identity.middleware.ts`, `requireWorkspaceRole`, the D-15 progress ticket, `flow-expectation.service.ts`,
or `trigger.service.ts` (FR-012).

**Scale/Scope**: Same single-instance deployment as the prior feature.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design below.*

| Principle | Check | Status |
|---|---|---|
| I. Spec-First | spec.md, this plan, research.md, data-model.md, contracts/, quickstart.md all exist under this feature's `specs/` directory before any source write; tasks.md (Phase 2) gates `/speckit-implement`. | PASS |
| II. Test-First | Every new module (`prompt-boundary/*`, `@foundry/shared`'s `request-policy/*`, mcp-bridge's auth middleware) ships with colocated tests written alongside implementation, matching the prior feature's discipline. `quickstart.md`'s SC-007 regression pass is the acceptance gate. | PASS (enforced task-by-task in tasks.md) |
| III. Code Review | Not applicable at planning time — enforced at PR/merge time. | DEFERRED |
| IV. Simplicity/YAGNI | Directly shaped this plan: V5 gets a documentation entry, not code (nothing to build beats a second gate that could disagree with the first); V4's `unrequested_action` is not built (no artifact exists to audit); V2's credential primitive is not rebuilt (superseded by `identity.middleware.ts` + `requireWorkspaceRole` + D-15, already more mature); mcp-bridge gets the smallest mechanism that fits its actual callers (none) rather than a per-workspace primitive. | PASS |
| V. Observability | mcp-bridge auth failures are logged (mirroring `auth.middleware.ts`'s existing pattern); injection-pattern warnings are structured findings, never silent; a `reject`/`transform` policy decision is recorded on the turn/job row it applies to, not just returned and forgotten. | PASS |
| VI. Branch Discipline | Timestamp branch `20260812-101032-guardrail-v2-v4-v5-v8`, one `specs/` directory, created by the git extension hook for this feature. | PASS |
| VII. Documentation Currency | tasks.md (next phase) includes a CLAUDE.md update task recording where V2/V4/V5/V8 landed (or, for V5, why nothing landed) — same discipline as the prior feature's CLAUDE.md section. | PASS (tracked forward) |
| VIII. Secrets Hygiene | `MCP_BRIDGE_API_KEY` is a new env var name added to `.env.example` as a placeholder only; no real value is ever written to a tracked file. | PASS |

No violations requiring the Complexity Tracking table below to be filled.

## Project Structure

### Documentation (this feature)

```text
specs/20260812-101032-guardrail-v2-v4-v5-v8/
├── spec.md               # Feature specification (corrected in planning — see research.md D2)
├── plan.md               # This file
├── research.md           # Phase 0 output — grounded decisions, including the two audits
├── data-model.md         # Phase 1 output — new entities + shared-package API surface
├── contracts/
│   └── generation-outcome-contracts.md   # New outcome variants on runGeneration/turn responses
├── quickstart.md         # Phase 1 output — manual + automated validation steps
└── tasks.md              # Phase 2 output (/speckit-tasks — not created by this command)
```

### Source Code (repository root)

```text
packages/
├── shared/src/
│   ├── index.ts                      # CHANGED: re-export request-policy submodule
│   └── request-policy/
│       ├── index.ts                  # evidence types, rules, combinator, config, transform —
│       │                             #   ported near-verbatim from krt/guardrail_validation's
│       │                             #   foundry/packages/shared/src/request-policy/*
│       └── request-policy.test.ts
│
├── mcp-bridge/
│   ├── package.json                  # CHANGED: no new dependency — auth check is hand-rolled,
│   │                                 #   matching this package's existing zero-dependency style
│   ├── .env.example                  # NEW: documents MCP_BRIDGE_API_KEY
│   └── src/
│       ├── auth.ts                   # NEW: requireApiKey-equivalent, standalone (no @foundry/shared
│       │                             #   / packages/server dependency — this package has neither)
│       ├── auth.test.ts              # NEW
│       └── index.ts                  # CHANGED: mount auth.ts's middleware before /mcp and /health
│                                     #   stays open (matches server's own health-endpoint precedent)
│
└── server/src/
    ├── prompt-boundary/               # NEW directory — ported near-verbatim from
    │   │                             #   krt/guardrail_validation's foundry/packages/server/src/prompt-boundary/
    │   ├── normalize.ts + .test.ts
    │   ├── patterns.ts + .test.ts
    │   ├── spans.ts + .test.ts
    │   ├── envelope.ts + .test.ts
    │   └── detect.ts + .test.ts
    │
    ├── services/
    │   ├── manifest-builder.service.ts   # CHANGED: buildAndPersist() additionally returns
    │   │                                 #   `warnings` (detectInjection over spansFromInventory);
    │   │                                 #   the persisted manifestXml/summaryXml and their hash
    │   │                                 #   are byte-identical to today (non-mutating, SC-003)
    │   ├── manifest-builder.service.test.ts   # CHANGED: new assertions for warnings + byte-identity
    │   ├── flow-generation.service.ts    # CHANGED: buildDraftPrompt() wraps opts.manifestXml in
    │   │                                 #   PROVENANCE_DECLARATION + wrapUntrusted (the one place
    │   │                                 #   manifestXml text enters a generation prompt — confirmed
    │   │                                 #   by reading every caller, research.md Decision 3)
    │   ├── flow-generation.service.test.ts   # CHANGED
    │   ├── request-policy.service.ts     # NEW: thin server wrapper over @foundry/shared's engine —
    │   │                                 #   ported near-verbatim from krt/guardrail_validation's
    │   │                                 #   foundry/packages/server/src/services/request-policy.service.ts
    │   ├── request-policy.service.test.ts   # NEW
    │   ├── flow-generation-job.service.ts   # CHANGED: runGeneration() evaluates the policy on
    │   │                                 #   input.goal/input.outline BEFORE calling draftFlow/
    │   │                                 #   authorFlow (canvas/authored mode is skipped — no free
    │   │                                 #   text); new GenerationOutcome variants policy_reject/
    │   │                                 #   policy_transform, same 200-not-error shape as
    │   │                                 #   insufficient_catalogue
    │   ├── flow-generation-job.service.test.ts   # CHANGED
    │   ├── flow-chat.service.ts          # CHANGED: turn() evaluates the policy on parsed.message
    │   │                                 #   before runTurn() builds a prompt or calls inference;
    │   │                                 #   TurnOutcome grows the same two variants
    │   └── flow-chat.service.test.ts     # CHANGED
    └── routes/
        ├── flows.ts                      # CHANGED (if needed): confirm the job-status response
        │                                 #   already passes GenerationOutcome through untouched
        └── flow-chat.ts                  # CHANGED (if needed): confirm TurnOutcome passes through
```

**Structure Decision**: `@foundry/shared` (from the prior feature) gains one submodule
(`request-policy/`) rather than a new package — it is domain-agnostic text classification with the
same shape as the existing `rules/` submodule. `packages/mcp-bridge` gets its own small, dependency-free
auth check rather than importing `@foundry/shared`'s `authFailureThrottle` or `packages/server`'s
`requireApiKey` — it has never depended on either and this feature does not introduce that coupling
for one middleware function (Decision 1). `prompt-boundary/` lands as a new leaf directory under
`packages/server/src/`, matching the source branch's own placement rationale (pure, no repository
imports, sits beside `services/` rather than inside it).

## Complexity Tracking

*No entries — Constitution Check found no violations requiring justification.*
