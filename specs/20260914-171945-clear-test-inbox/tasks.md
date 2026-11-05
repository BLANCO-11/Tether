# Tasks: Clear test inbox

**Input**: Design documents from `/specs/20260914-171945-clear-test-inbox/`
**Tests**: Required by the assignment contract — every new behavior ships with a test that fails without the change.

## Phase 1: Backend clear path (US1 — the one action)

**Goal**: `DELETE` on the parent empties ops-api's `mail_outbox` and nothing else.

**Independent Test**: Seed one mail row + one chat row in `foundry_ops`; DELETE the
parent route; mail reads back empty, chat intact.

 - [x] T001 [P] [US1] ops-api clear test FIRST in `packages/ops-api/src/routes/admin-clear.test.ts` — seeds one `mail_outbox` row + one `chat_messages` row, asserts DELETE clears mail only, unknown set 404s, missing key 401s. Verify it FAILS (route 404s) before T002.
 - [x] T002 [US1] `DELETE /admin/records/:name` in `packages/ops-api/src/routes/admin.ts` — allowlisted by the existing `READABLE` keys, single-table `DELETE`, returns `{ ok: true, cleared, set }`. (Depends on T001.)
 - [x] T003 [P] [US1] server clear test FIRST in `packages/server/src/routes/email-box-clear.test.ts` — `vi.mock`s `ops-client.service.js`, asserts DELETE calls `clearRecords("mail")` and returns the count, and asserts an ops-api failure surfaces as 5xx (not `{ok:true}`). Verify it FAILS (route 404s) before T004.
 - [x] T004 [US1] `opsClient.clearRecords(set)` in `packages/server/src/services/ops-client.service.ts` + `DELETE /email-box/simulated` in `packages/server/src/routes/email-box.ts` (literal `"mail"` set, workspaceId validation, `{ ok: true, cleared }`). (Depends on T003.)

**Checkpoint**: US1 backend works end-to-end (parent → ops-api → empty table).

---

## Phase 2: Button + confirmation (US1 UI, US2 copy)

**Goal**: The Email box page offers the clear with an honest confirmation.

**Independent Test**: With a non-empty simulated list, cancel leaves it intact and confirm empties it.

 - [x] T005 [P] [US1] client test FIRST in `packages/client/src/app/(app)/email-box/page.test.tsx` — mocked `clearSimulatedEmailBox`; cancel → no call + list intact; confirm → call + reload shows the read-and-empty state. Verify it FAILS (no button) before T006.
 - [x] T006 [US1] `clearSimulatedEmailBox` in `packages/client/src/lib/foundry-client.ts` + wrapper in `packages/client/src/lib/api.ts`. (Depends on T005.)
 - [x] T007 [US1/US2] "Clear test inbox" button + `Confirm` modal (danger, every-workspace scope in the body) in `packages/client/src/app/(app)/email-box/page.tsx`; success toasts the count and calls `box.reload()`, failure toasts and leaves the list. (Depends on T005, T006.)

**Checkpoint**: US1 + US2 fully work in the browser against the real stack.

---

## Phase 3: Verify (no new tasks — run, don't write)

 - [x] T008 Run affected suites: `packages/ops-api` (new test), `packages/server` (new + existing `email-box.test.ts`), `packages/client` (email-box page test + routes smoke). Typecheck all three packages. Leave everything uncommitted.

## Dependencies & Execution Order

- T001 → T002 (test-first per layer); T003 → T004; T005 → T006 → T007.
- T001/T003/T005 are [P]-parallel (different files, no shared edits).
- T002/T004/T006/T007 touch different files; implement in backend→frontend order but verify per-layer.
- No commits (assignment constraint); no migration (no schema change).
