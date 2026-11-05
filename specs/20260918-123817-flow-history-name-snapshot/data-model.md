# Phase 1 Data Model: Flow History Name Snapshot + ID columns

## Entity: Flow Execution (`flow_executions`)

Existing table, extended additively. Relevant columns only (full table has many more,
unrelated to this feature):

| Column | Type | Nullable | Added | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `id` | uuid (PK) | no | pre-existing | The run's own identity — displayed as "Run ID". Never snapshotted; it IS the run. |
| `flow_id` | uuid, FK → `flows.id`, `ON DELETE SET NULL` | yes | pre-existing | Live pointer to the workflow. Goes `NULL` when the flow is deleted. |
| `kestra_flow_id` | varchar(255) | no | pre-existing | The Kestra slug — existing fallback label, unaffected by this feature. |
| `flow_name_snapshot` | varchar(255) | yes | migration `0069` (this branch, prior batch) | The flow's `name` at `begin`-time. `NULL` for rows predating the column. |
| `flow_id_snapshot` | uuid | yes | **migration `00XX` (this batch, NEW)** | The flow's `id` at `begin`-time. No FK — must survive the referenced flow's deletion, exactly like `flow_name_snapshot`. `NULL` for rows predating the column. |

### Why `flow_id_snapshot` carries no foreign key

A FK to `flows.id` would itself need `ON DELETE SET NULL` or `CASCADE` to avoid
blocking deletion — and `SET NULL` is precisely the behavior being worked around
(that's what happens to the *live* `flow_id` column already). A snapshot column's
whole purpose is to hold a value that outlives the row it points at, so it is a plain
`uuid` with no referential constraint, matching `flow_name_snapshot`'s existing
design (a plain `varchar`, no constraint back to `flows.name`).

### Write-time rule (unchanged pattern, new field)

Both snapshot columns are written **once**, at the same moment, in
`routes/executions.ts`'s `begin` handler, from the same `flowRow` lookup already
used for `flowRevision`:

```ts
flowId: flowRow?.id ?? null,
flowRevision,
flowNameSnapshot: flowRow?.name ?? null,   // existing
flowIdSnapshot: flowRow?.id ?? null,        // NEW — same source read, same moment
```

Never updated afterward. Never joined at read time. This is the same rule already
stated for `flowRevision` and `flowNameSnapshot` in that file's comments (§6.5's
"approval binds to a revision" logic and D-18's "the model, not a live join" logic
both rhyme with this).

## Derived value: Run.workflowId (client-side)

Not a stored field — a display-time preference chain, computed the same way
`runLabel()` already computes the display name:

```
workflowIdFor(run) = run.flowIdSnapshot ?? run.flowId ?? null
```

- `flowIdSnapshot` present → use it (frozen at run-start; survives deletion; survives
  rename — ids don't rename, but this keeps the two snapshot fields symmetric).
- `flowIdSnapshot` null (row predates the column) → fall back to the live `flowId`
  pointer, which is itself `null` if the flow has since been deleted. This matches
  spec.md's Edge Cases: a pre-feature orphaned run has no way to reconstruct its true
  historical id and must not fabricate one.
- Both null → the Workflow ID cell renders `"—"` with no copy button (nothing to
  copy).

## UI-layer types touched (no new entities — field additions only)

| Type | File | New field |
| :--- | :--- | :--- |
| `FAFlowExecutionSummary` | `packages/client/src/lib/foundry-client.ts` | `flowIdSnapshot: string \| null` |
| `FlowExecutionSummary` | `packages/client/src/lib/types.ts` | `flowIdSnapshot: string \| null` |
| `Run` | `packages/client/src/lib/types.ts` | `flowId?: string \| null` (added this batch — previously absent), `flowIdSnapshot?: string \| null` |
| `ExecutionView` | `packages/server/src/services/flow-visibility.service.ts` | `flowIdSnapshot: string \| null` |

## State transitions

None — this is a write-once-at-creation, read-many field, same as `flowNameSnapshot`.
No update path exists or is added; `flow_executions` rows are not mutated after
`begin` writes them (consistent with the rest of the table's fields in this area,
per the file's own comments on `flowRevision`/`requestedBy`).

## Contract: Flow Execution view — `flowIdSnapshot` field addition

*(Folded in here rather than a separate `contracts/` file — a tooling outage made
new-file creation unavailable at plan time; Edit on this existing file still
worked. Content is otherwise what would have been `contracts/flow-execution-view.md`.)*

Applies to both response shapes that already carry `flowNameSnapshot`:
`GET /api/workspaces/:ws/flow-executions` (list) and
`GET /api/workspaces/:ws/flow-executions/:id` (detail), both served by
`flow-visibility.service.ts`.

New field: `flowIdSnapshot: string | null`. Everything else on that shape already
exists (`id`, `workspaceId`, `flowId`, `flowName`, `flowNameSnapshot`, `status`,
`engineStatus`, `startedAt`, `endedAt`, `durationMs`).

Guarantees:
1. Valid uuid string or `null` — never an empty string or the literal string
   `"undefined"`/`"null"`, same convention `flowName`'s own docblock states.
2. `null` for every row created before this migration lands, or where `flows.id`
   was unavailable at `begin` time.
3. Immutable once written — no route updates it, and it is NOT cleared when the
   referenced flow is deleted (unlike the live `flowId` column) — that is the
   entire point of the field.
4. Backward compatible — purely additive.

Client contract: `runWorkflowId(e)` in `adapters.ts` mirrors `runLabel()`'s shape —
prefers `e.flowIdSnapshot`, falls back to `e.flowId`, else `null`. Consumed by
`runFromFlowExecution` to populate `Run.flowId`/`Run.flowIdSnapshot`, and by
`CopyableId`'s caller in `history/page.tsx` to decide what to render/copy for the
Workflow ID column.

## Validation rules

- Server: none beyond the existing `uuid` column type constraint (Postgres rejects a
  non-uuid value at the driver level; no new Zod schema needed since this is never
  accepted from a request body — it is derived server-side from `flowRow.id`, the
  same trusted source as `flowId` itself).
- Client: `CopyableId` treats `null`/`undefined`/empty string as "nothing to display
  or copy" → renders `"—"`, no button. No other validation; these are opaque
  identifiers, not user input.
