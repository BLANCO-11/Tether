# Contract: Flow Execution view — `flowIdSnapshot` field addition

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
