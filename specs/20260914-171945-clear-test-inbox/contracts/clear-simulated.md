# Contract: `DELETE /api/workspaces/:ws/email-box/simulated` (parent)

**Owner**: `packages/server/src/routes/email-box.ts` (`emailBoxRouter`, `mergeParams: true`).

## Request

```text
DELETE /api/workspaces/:workspaceId/email-box/simulated
```

Auth: existing `requireApiKey` mounting (unchanged). Missing `workspaceId`
param → `500` naming the mounting mistake (same rule as the GET route).

## Behavior

1. Call `opsClient.clearRecords("mail")` — the set name is a literal, never a
   request input (FR-007: the route cannot be steered at any other table).
2. Return `200 { ok: true, cleared }`.
3. ops-api unreachable/failing → the `OpsApiError` propagates to `errorHandler`
   (5xx with reason). The client toasts the failure and leaves the list as it was.

## Response

```text
200 { ok: true, cleared: <number> }
```

## Client companion

`foundry-client.clearSimulatedEmailBox(wsId)` → `DELETE /workspaces/:ws/email-box/simulated`;
`api.clearSimulatedEmailBox()` resolves the workspace and calls it. The page
shows the `Confirm` modal first; on success toasts `Cleared N test email(s)`
and calls `box.reload()`.

## Non-goals

- No change to `GET /email-box` shape.
- No delete path for the workspace-scoped `email_sends` record.
