# Research: Clear test inbox

**Date**: 2026-09-14 · **Spec**: [spec.md](./spec.md)

## Decision 1 — Which list is "the test inbox"

**Decision**: The simulated list (`test_email_send` / `mail_send` → ops-api `mail_outbox`).

**Evidence**:
- `packages/server/src/kestra/hr-screening.flow.yml:152` — the attendance flow's
  notify step uses `"ref": "mail_send"`, the simulated tool.
- `packages/server/src/demo/lean-catalogue.ts:26` — `test_email_send` is
  "captured, never delivered. Visible in the Email box."
- The page (`email-box/page.tsx`) labels that zone "Test emails from the
  simulated tool — nothing here was ever delivered".

**Rejected**: clearing the workspace-scoped `email_sends` record. Its module
docblock (`email-send.repo.ts`) states the row is the only evidence real mail
left the building; a UI button deleting audit rows would destroy exactly what
the run page exists to prevent losing.

## Decision 2 — New scoped clear vs reuse of `/reset`

**Decision**: New `DELETE /admin/records/:name`, allowlisted by the existing
`READABLE` keys, deleting (not truncating-all) one table.

**Rationale**: `POST /admin/reset` truncates five tables and resets the flaky
probe counter (`admin.ts:107-123`) — a button labelled "clear inbox" must not
wipe chat, tickets, pages and the call log as a side effect (FR-005).
`DELETE` (not `TRUNCATE ... RESTART IDENTITY`) keeps sequences stable; row
count is returned so the page can confirm what happened.

## Decision 3 — Confirmation control

**Decision**: `Confirm` modal (`components/ui/Confirm.tsx`) with `danger` and
`confirmLabel="Clear test inbox"`, body naming the every-workspace scope.

**Evidence**: `organization/page.tsx` uses `Confirm` (no `danger` prop there,
but the component supports it) for workspace deletion — the destructive-action
convention. `window.confirm` (`flows/[id]/page.tsx:1168`) is used for a soft
hide-the-revision action, not a destructive one.

## Decision 4 — Parent route shape

**Decision**: `DELETE /api/workspaces/:workspaceId/email-box/simulated` on the
existing `emailBoxRouter` (keeps `mergeParams` + workspaceId validation), 200
`{ ok: true, cleared: <n> }`; ops-api failure → honest 5xx via `OpsApiError`,
never an empty-list claim.

**Alternatives considered**: `DELETE` on the collection root (`/email-box`) —
rejected, ambiguous with the foundry record; a query param (`?source=simulated`)
— rejected, less boring than a named sub-resource.

## Decision 5 — Test strategy per layer

- **ops-api** (`admin-clear.test.ts`): mount `adminRouter` on express like the
  route is mounted; seed one `mail_outbox` row + one `chat_messages` row;
  assert DELETE clears mail only; unknown set → 404; no/wrong key → 401.
  Needs a live ops DB (`OPS_DATABASE_URL` → host postgres :5433 `foundry_ops`).
- **server** (`email-box-clear.test.ts`): `vi.mock` `ops-client.service.js`
  (`clearRecords`); assert the route calls it with `"mail"` and returns the
  count; assert ops-api failure → 5xx with error (not `{ok:true}`). Fails
  without the change (route 404s).
- **client** (`page.test.tsx` extension): mocked `@/lib/api` gains
  `clearSimulatedEmailBox`; assert cancel → no call + list intact; confirm →
  call + reload shows empty state. Fails without the change (no button).
