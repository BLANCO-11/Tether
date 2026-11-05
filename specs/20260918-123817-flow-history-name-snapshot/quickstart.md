# Quickstart: Flow History Name Snapshot + ID columns

Validation guide for this feature's two batches (name snapshot, and the new
Workflow ID / Run ID column split + status relabel). Run these against a dev
deployment after implementation.

## Prerequisites

- Server + Postgres running (`docker compose up -d` from `infra/`, or the dev
  server pointed at a local Postgres).
- Migrations applied: `pnpm --filter @foundry/server db:migrate` (or the repo's
  usual migrate command) — includes both `0069_add_flow_name_snapshot.sql` and
  the new `flow_id_snapshot` migration.
- A workspace with at least one approved, armed flow to run.

## Scenario 1 — Name and ID both show correctly on a fresh run (US1, US4)

1. Give a flow a real display name, e.g. "Rachit V1".
2. Trigger a run (test-run or a live fire).
3. Open `/history`.
4. **Expect**: the row shows "Rachit V1" in the Workflow Name column; the
   Workflow ID column shows the first 5 characters of the flow's uuid + `…`
   with a copy button; the Run ID column shows the first 5 characters of the
   execution's own uuid + `…` with a copy button; the Status column shows
   `completed` (not `run.completed`).

## Scenario 2 — Rename does not relabel past runs (US2)

1. Run a flow while named "A".
2. Rename it to "B".
3. Run it again.
4. **Expect**: History shows one row labeled "A" (the earlier run) and one row
   labeled "B" (the later run) — the Workflow ID column is identical on both
   rows (renaming doesn't change the id).

## Scenario 3 — Deleting the flow doesn't blank either identifier (US5, spec Edge Cases)

1. Run a flow, note its Workflow Name and Workflow ID as shown in `/history`.
2. Delete the flow.
3. Reload `/history`.
4. **Expect**: the same row still shows the same Workflow Name and the same
   Workflow ID — neither goes blank or falls back to "—".

## Scenario 4 — Copy buttons work and confirm via toast (US4)

1. On any row, click the copy button beside the Workflow ID.
2. **Expect**: a toast confirms the copy; pasting into a text field yields the
   *full* uuid, not the truncated 5-character form.
3. Repeat for the Run ID column's copy button.
4. (Optional, hard to force in a real browser) Simulate a clipboard failure —
   e.g. via devtools overriding `navigator.clipboard.writeText` to reject —
   and confirm a failure toast appears rather than nothing happening.

## Scenario 5 — Pre-existing rows degrade honestly (US2 edge case, US5 edge case)

1. Identify (or seed) a `flow_executions` row from before this feature's
   migrations (`flow_name_snapshot`/`flow_id_snapshot` both `NULL`).
2. View it in `/history`.
3. **Expect**: Workflow Name falls back to the Kestra slug (today's existing
   behavior); Workflow ID falls back to the live `flow_id` pointer if the flow
   still exists, or shows `"—"` with no copy button if the flow has since been
   deleted (no fabricated id).

## Scenario 6 — Status column wording (US6)

1. Find one row of each outcome: completed, stopped (failed), and — if a
   long-running flow is available — still running.
2. **Expect**: badges read `completed` / `stopped` / `running`, header reads
   "Status" (not "Action").

## Automated equivalents

- `packages/server/src/routes/executions.test.ts` (or equivalent) — asserts
  `begin` writes both snapshot fields from the same `flowRow` lookup.
- `packages/server/src/services/flow-visibility.test.ts` — asserts
  `executionBase` passes `flowIdSnapshot` through unchanged.
- `packages/client/src/lib/adapters.test.ts` — asserts `runWorkflowId()`'s
  fallback chain (snapshot → live id → null) in isolation.
- `packages/client/src/lib/run-history.test.ts` — asserts the same chain at
  the `listFlowRuns` call site (the seam that actually broke once before, per
  that file's own docblock on why it tests at the call site and not just the
  mapper).
- `packages/client/src/components/ui/CopyableId.test.tsx` — truncation length,
  null rendering, copy success/failure toasts (mocked `navigator.clipboard`
  and mocked `useToast`).
- History page render test — column headers, badge text, search matching the
  workflow id.

## Rollback

Both migrations are purely additive (`ADD COLUMN ... nullable`, no backfill,
no data rewritten). Reverting either is a plain `DROP COLUMN`; no other table
or row is affected. The client falls back to pre-feature rendering automatically
once the fields are absent from the API response (same honest-fallback chain
used for pre-existing rows in Scenario 5).
