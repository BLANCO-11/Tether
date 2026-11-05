# Implementation Plan: Flow History Name Snapshot (+ Workflow/Run ID columns, ID snapshot, Status relabel)

**Branch**: `20260918-123817-flow-history-name-snapshot` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260918-123817-flow-history-name-snapshot/spec.md`

## Summary

History's run rows must show the workflow's display name and id **as they were at the
moment that specific run started**, not the current live values — a rename or a
deletion of the workflow must never retroactively relabel or blank a past run. This
plan covers two batches of work under one spec:

1. **Name snapshot** (User Stories 1–3, already substantially implemented on this
   branch): `flow_executions.flow_name_snapshot`, written at `begin`, preferred by
   `runLabel()` over the live slug.
2. **ID-column restructuring** (User Stories 4–6, new): split History's combined
   "Automation" cell into `Workflow name / Workflow ID / Run ID` columns, each id
   truncated to 5 chars with a copy-to-clipboard control (toast feedback); freeze the
   workflow id the same way the name is frozen (`flow_executions.flow_id_snapshot`,
   same rationale as (1), since `flow_id` is `ON DELETE SET NULL`); rename the
   "Action" column to "Status" and simplify its badge text.

Both batches touch the same table (`flow_executions`), the same write-site (`begin` in
`routes/executions.ts`), the same read-path (`flow-visibility.service.ts` →
`foundry-client.ts` → `adapters.ts` → `history/page.tsx`), and the same architectural
pattern (freeze-at-write, prefer-frozen-at-read, fall back honestly for old rows).

## Technical Context

**Language/Version**: TypeScript throughout (server: Node.js/Express; client: Next.js/React)

**Primary Dependencies**: Drizzle ORM + PostgreSQL (server, existing); no new client
dependencies — reuses the existing `useToast()` provider (`lib/toast.tsx`) for copy
feedback and the existing inline SVG icon convention (`components/ui/icons.tsx`) for a
new `Copy` icon.

**Storage**: PostgreSQL, `foundry_parent` database, `flow_executions` table. One new
nullable column this batch: `flow_id_snapshot uuid` (no FK — must survive the
referenced flow's deletion, same as the existing `flow_name_snapshot varchar(255)`).

**Testing**: Vitest, both packages (`packages/server`, `packages/client`) — existing
per-package config, run via `pnpm test` from each package or `pnpm -r test` at root
(Node 22 required; see CLAUDE.md's "client's whole rendering test layer" note).

**Target Platform**: Existing deployment — server on Linux/Docker, client in-browser.

**Project Type**: Web application — existing `packages/server` (API) +
`packages/client` (Next.js UI) monorepo. No new packages.

**Performance Goals**: Negligible — one additional nullable column read on an
already-fetched row; no new queries, no new N+1. `listFlowRuns`'s existing per-page
detail-fetch fan-out (documented in `api.ts`) is unchanged.

**Constraints**:
- Must not alter `flow_executions.flow_id`'s existing FK / `ON DELETE SET NULL`
  behavior — the new snapshot column is strictly additive, mirroring how
  `flow_name_snapshot` was added without touching `flows.name`'s own column.
- Truncation is exactly 5 leading characters + ellipsis (user-specified), applied to
  the *display* only — the full id is always what gets copied and what `title=`
  exposes on hover.
- Copy failures must be user-visible (Constitution V — no silent catch-and-continue):
  toast on both success and failure, matching the existing best-effort clipboard
  pattern already used in `FlowIntegrationPanel.tsx` / `AllowRequest.tsx`.

**Scale/Scope**: One page (`/history`), one new shared UI component (`CopyableId`),
one new DB column + one write-site + one read-path already threaded end-to-end from
the name-snapshot work. Roughly 10 files touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Article | Status | Notes |
| :--- | :--- | :--- |
| I. Spec-First | PASS | This plan + `spec.md` + upcoming `tasks.md` cover all source edits; no manual/uncovered changes. |
| II. Test-First | PASS | Every new behavior (id snapshot fallback chain, truncation, copy success/failure, status relabel) gets a test per FR — enumerated in tasks.md. |
| III. Code Review | N/A at plan time | Applies at PR review; `/speckit-comply` to run before requesting review. |
| IV. Simplicity | PASS | No new architectural layer: reuses `DataTable`'s existing named-set extension point (`run` set), the existing `useToast()` provider, and the existing freeze-at-write pattern already proven for the name. One new small component (`CopyableId`) is justified by two call sites (Workflow ID, Run ID) needing identical truncate+copy behavior — three-line duplication was rejected in favor of the one shared component per Article IV's own "three similar lines beat one premature abstraction" only holds below 2 call sites with identical logic; here it's the same control instantiated twice with different data, which is the textbook case *for* extraction, not against it. |
| V. Observability | PASS | Clipboard failure surfaces as a toast naming what happened, not a silent no-op. |
| VI. Branch/Delivery | PASS | Single timestamped branch/spec dir already in place; no new branch needed since this extends the same page/spec. |
| VII. Documentation Currency | PASS (tracked) | CLAUDE.md gets a short dated entry describing the ID-snapshot + column-split change in the same PR, alongside the existing name-snapshot entry pattern this file already uses for prior History changes. |
| VIII. Secrets Hygiene | N/A | No credentials involved. |

No violations — Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/20260918-123817-flow-history-name-snapshot/
├── spec.md               # updated with User Stories 4-6, FR-008..FR-012
├── plan.md               # this file
├── research.md           # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output (API/type contract for the new field)
└── tasks.md              # Phase 2 output (/speckit-tasks — not this command)
```

### Source Code (repository root)

Existing monorepo structure — no new projects/packages created.

```text
packages/server/
├── drizzle/
│   ├── 0069_add_flow_name_snapshot.sql        # existing (this branch, prior batch)
│   └── 00XX_add_flow_id_snapshot.sql          # NEW — this batch
├── src/
│   ├── db/schema.ts                            # flow_executions: + flowIdSnapshot
│   ├── routes/executions.ts                    # `begin`: write flowIdSnapshot
│   └── services/
│       ├── flow-visibility.service.ts          # ExecutionView/executionBase: + field
│       └── flow-visibility.test.ts             # + assertions

packages/client/src/
├── lib/
│   ├── foundry-client.ts                       # FAFlowExecutionSummary: + flowIdSnapshot
│   ├── types.ts                                # FlowExecutionSummary, Run: + fields
│   ├── adapters.ts                              # runFromFlowExecution, + runWorkflowId()
│   ├── adapters.test.ts                         # + fallback-chain cases
│   ├── run-history.test.ts                      # + fallback-chain cases (call-site level)
│   └── api.ts                                   # listFlowRuns — unaffected, verify only
├── components/ui/
│   ├── icons.tsx                                # + Copy icon
│   ├── CopyableId.tsx                           # NEW
│   ├── CopyableId.test.tsx                      # NEW
│   └── DataTable.tsx                            # `run` set: 5 → 6 columns
└── app/(app)/history/
    ├── page.tsx                                 # column split, status relabel, search
    └── page.test.tsx                             # NEW (or extend routes.smoke.test.tsx)
```

**Structure Decision**: Existing web-app monorepo layout (`packages/server` +
`packages/client`). This feature adds one migration + one schema field + one
write-site + one service field on the server, and one shared UI component + type/
adapter plumbing + the History page itself on the client. No new package, no new
top-level directory.

## Complexity Tracking

*No Constitution Check violations — table intentionally empty.*
