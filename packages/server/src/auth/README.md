# `src/auth/` — the authorisation policy

This directory holds **what the system is willing to let somebody do**. It is policy, not
behaviour: nothing in here reads a database, dials a service, or serves a request.

| File | What it is |
| :--- | :--- |
| `permissions.ts` | The frozen catalogue — every permission that exists, and nothing else. |
| `role-presets.ts` | `author` / `approver` / `admin` expressed as sets over the catalogue. |
| `platform-conferral.ts` | Which workspace permissions a **platform** permission confers. |
| `route-permissions.ts` | Which permission each mounted route requires, plus the exemptions. |

## Why these four live together rather than in `services/`

They are one answer read four ways, and splitting them is how the four answers drift.

A `services/` module exists to *do* something with the database or an external system —
`workspace-member.service.ts` reads rows, `flow-approval.service.ts` writes to the live
Kestra namespace. Every file here is the opposite: a declaration with no I/O, which is
what makes it testable by reading it and what makes the completeness check possible at
all. `route-permissions.test.ts` walks the mounted Express stack and requires every
`(method, path)` to appear in the map or in `EXEMPT`. That check can only exist because
the map is a value sitting in one place, not a decision scattered across forty-four route
files.

**This repo has already paid for the alternative, more than once.** There are two
`ROLE_CAPS` — one in `services/workspace-member-capabilities.service.ts` and one in
`packages/client/src/lib/capabilities.ts` — and they **disagree** about whether an
`approver` may publish. Neither is wrong on its own; there are simply two of them.
`ENV_NAME_RE` was defined independently in three client files and a fourth, stricter,
undocumented copy silently rejected env names the server accepted. The rule this
directory exists to enforce is the one `@foundry/shared` was created for: **a policy with
two definitions has no definition.**

## The rules that hold here

- **No I/O.** No `db`, no `fetch`, no repository import. If a file here needs a row, the
  design is wrong — the *resolver* (`services/effective-permissions.service.ts`) reads
  rows and consults these declarations, never the other way round.
- **Frozen at module load.** `Object.freeze`, and a test that says so. A catalogue a
  caller can mutate is a catalogue a caller can widen.
- **Read the number from the array; never write it down twice.** The `FOUNDRY_EMITS`
  idiom. Counts in comments go stale silently; a test that reads `.length` does not.
- **Keyed on the permission, never on a role name.** `PLATFORM_CONFERS` maps
  `platform.members.grant`, not `"platform-admin"`, so a custom role holding that
  permission confers exactly what the built-in one does. A name is not an authority.
- **An exemption carries a reason string.** `EXEMPT` entries say *why* a route needs no
  permission, so an exemption is something somebody decided rather than something nobody
  noticed.
