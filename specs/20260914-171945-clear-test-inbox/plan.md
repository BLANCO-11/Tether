# Implementation Plan: Clear test inbox

**Branch**: `release/beta` (shared checkout; left uncommitted) | **Date**: 2026-09-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20260914-171945-clear-test-inbox/spec.md`

## Summary

One button on the Email box page empties the simulated test-email list. The
clear travels three hops, each already half-built: the page calls the parent,
the parent calls ops-api's admin surface, ops-api truncates only `mail_outbox`.
The single new backend piece is a per-table clear on ops-api's admin surface
(allowlised by the existing `READABLE` keys, mirroring `GET /records/:name`);
the existing truncate-all `/reset` is deliberately not reused because it also
wipes chat/tickets/pages/call-log. Confirmation uses the app's `Confirm` modal
(danger + explicit label), as for workspace deletion.

## Technical Context

**Language/Version**: TypeScript 5.7, Node 22, React 18 / Next 14 (client), Express 4 (services)

**Primary Dependencies**: drizzle-orm 0.38.3, pg, vitest 2.1.8, testing-library (client)

**Storage**: PostgreSQL — `foundry_ops.mail_outbox` (ops-api owned); parent `email_sends` untouched

**Testing**: vitest run per package (server tests hit the real parent DB via repo `.env`; ops-api tests get `OPS_DATABASE_URL` + `OPS_API_KEY` from the environment; client tests are jsdom + mocked `@/lib/api`)

**Target Platform**: Docker-compose stack (parent :4000, ops-api :4004, client :4002); no migration — no schema change

**Project Type**: Web application (Express backend x2 + Next frontend)

**Performance Goals**: Clear completes in seconds for hundreds of rows (single `DELETE`, no `RESTART IDENTITY` so sequences are undisturbed)

**Constraints**: No caller-supplied SQL identifiers (allowlist only); no secret in tracked files; shared-scope copy must stay honest; changes uncommitted

**Scale/Scope**: 3 source files changed + 1 extended (client page), 2 new endpoints, 3 test files (2 new, 1 extended)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Per `.specify/memory/constitution.md` (load-bearing principles, applied here):

- **Evidence over assertion**: new behavior covered by tests that fail without the change (client confirm-gating test, server DELETE test, ops-api clear test).
- **Boring over clever**: reuse `READABLE` allowlist, `opsClient.admin` helper, `Confirm` modal, `useAsync.reload()` — no new abstractions.
- **No silent scope growth**: clear touches `mail_outbox` only (FR-005/FR-007); truncate-all untouched.
- **Unreadable renders as unreadable**: clear failure surfaces as error, never as an empty list (FR-006).
- **Secrets**: no new secrets; ops-api clear rides the existing root-key admin surface.

No violations. No complexity-tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/20260914-171945-clear-test-inbox/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── clear-simulated.md
│   └── admin-clear-records.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/ops-api/src/routes/
├── admin.ts                 # + DELETE /records/:name (allowlisted single-table clear)
└── admin-clear.test.ts      # NEW: clears mail only, 404s unknown set, needs root key

packages/server/src/
├── services/ops-client.service.ts  # + opsClient.clearRecords(set)
└── routes/
    ├── email-box.ts             # + DELETE /simulated
    └── email-box-clear.test.ts  # NEW: deletes via ops-api, honest failure

packages/client/src/
├── lib/
│   ├── foundry-client.ts  # + clearSimulatedEmailBox
│   └── api.ts             # + clearSimulatedEmailBox wrapper
└── app/(app)/email-box/
    ├── page.tsx       # + "Clear test inbox" button + Confirm modal
    └── page.test.tsx  # + confirm-gating tests
```

**Structure Decision**: In-place extension of the existing Email-box vertical
(ops-api admin → parent email-box route → client page), following the exact
read-path layering already there. No new packages, no new tables, no migration.

## Complexity Tracking

> No constitution violations — nothing to track.
