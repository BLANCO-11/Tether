# Plan — orphan draft wait cleanup

## Approach
Extend `flowRunnerService` with `reconcileOrphanedDraftWaits` and tighten `expireStaleApprovals`. Wire boot from `index.ts`. Cancel waiting `lastRunId` from `destroySession` and before a new `startDraftRun` in the pi-builder test path.

## Files
- `packages/server/src/services/flow-runner.service.ts`
- `packages/server/src/index.ts`
- `packages/server/src/pi-builder/service.ts`
- Colocated source-shape / behaviour tests

## Risk
Must not cancel waiting runs that still have a `flow_id` (Approvals inbox path).
