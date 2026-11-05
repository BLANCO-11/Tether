# Bug Fix Specification: workspace switch, the member drawer's edge, and the Roles tab

**Feature Branch**: `feat/rbac-permissions`

**Release**: `beta-1.1.2` — a PATCH on the 1.1 line. Three grouped fixes, no schema, no
migration, no route change. See `docs/VERSIONING.md`.

**Created**: 2026-09-16

**Status**: Released

**Input**: User description: *"1. Whenever user changes the workspace redirect the user to the home page with the selected workspace. 2. In the /admin/members page the side panel which shows the permission of the member has one side highlighted — remove it and make it consistent. 3. In the /admin/members?tab=roles the built-in roles description sometimes doesn't load and page needs to be reloaded — fix it, loads it without refreshing the page."*

Three defects reported from UAT on `/admin/members`. All three are client-only: **no
route, service, schema or migration changed.** Two are cosmetic-adjacent; the third
(BUG-3) is a real correctness defect whose blast radius is wider than the report, and
whose guard **was already in the repository and already failing**.

---

## The three bugs

| # | Symptom as reported | What was actually wrong | Severity |
| :--- | :--- | :--- | :--- |
| BUG-1 | Switching workspace leaves you on the page you were on | A workspace switch was a state change, not a navigation — so it left people standing on a page scoped to an object the new workspace does not contain | Medium — wrong-looking data, no data loss |
| BUG-2 | The member drawer has "one side highlighted" | The drawer panel carried `border-l border-line/60` and nothing on its other three edges. `--line` is *lighter* than `--surface`, and the scrim darkens everything to its left, so the one rule read as a highlighted seam the full height of the viewport | Low — cosmetic |
| BUG-3 | Built-in role descriptions sometimes do not load; reloading fixes it | The Roles tab took the workspace-**context** value straight to the wire. Until the resolver answers, that value is the `UNRESOLVED_WORKSPACE` placeholder (`ws_it`), which names no workspace and is not a uuid — so the read failed | **High** — a correct screen rendering "could not be read", intermittently |

---

## BUG-1 — a workspace switch is a navigation

### What was wrong

`WorkspaceSwitcher.pick` in `components/shell/Topbar.tsx` did three things: close the
menu, adopt the workspace, re-render. It did not move.

Every page under the app shell is scoped to a workspace, and a great many are scoped to
a **thing inside one** — `/flows/<id>`, `/runs/<id>`, `/resources/<id>`,
`/admin/members?tab=roles` with a drawer open. Switching while standing on one of those
leaves the person looking at a page about an object the new workspace does not contain:
`app/(app)/layout.tsx`'s `key={workspaceId}` remounts it, it refetches, and it renders a
404 or an empty state.

⚠ **The failure reads as data loss rather than as a context change.** That is what makes
this worth fixing rather than tolerating: "your workflow is gone" and "you are looking at
a different tenant now" are the same screen.

### The fix

`pick` now: `closeMenu()` → return if the pick is the current workspace →
`switchWorkspace(id)` → `router.push(HOME_PATH)`.

Four things are load-bearing, and each has a test:

- ⚠ **`switchWorkspace` FIRST, THEN navigate.** `switchWorkspace` calls
  `adoptWorkspaceId`, which repoints the module cache every scoped call in `lib/api.ts`
  reads. Navigating first would let `/dashboard` mount and fetch against the workspace
  being switched **away from** — which is I-103 reintroduced from the other end.
  `Topbar.test.tsx` asserts the **order**, not merely that both happened.
- ⚠ **`push`, not `replace`.** The page they were on is a real place they were, and Back
  should return them to it — in the workspace they have now chosen.
- ⚠ **Picking the workspace you are already in does nothing at all**, not even the
  navigation. Re-selecting the current workspace must not throw away the page being read.
- ⚠ **Home is `/dashboard`, and the literal is written rather than shared.** There are
  already five landing paths (`app/page.tsx`'s root redirect, `middleware.ts`'s
  already-signed-in bounce, both sign-in buttons, the sidebar lockup) plus `Sidebar.tsx`'s
  Home row, and every one of them writes `"/dashboard"` inline. Introducing a constant
  that one of six sites imports is a second answer to *"where is home"* — the exact thing
  being avoided. The constant is local, and its docblock says it moves when they move.

### Deliberately NOT changed

`app/(app)/organization/page.tsx` also calls `switchWorkspace`, when the workspace you
are standing in has just been **deleted**. That is a recovery, not a choice, and the
person is on the page whose job is managing workspaces — moving them to `/dashboard`
there would take them away from the work they are doing. The navigation therefore lives
in the switcher, not in `WorkspaceProvider.switchWorkspace`.

---

## BUG-2 — one edge of the drawer treated unlike the other three

### What was wrong

`components/ui/Drawer.tsx`'s panel:

```
className="… border-l border-line/60 bg-surface shadow-sm …"
```

`--line` (`#20242d`) is **lighter** than `--surface` (`#14161d`), and the backdrop is
`--scrim` at 60% black, so the rule was lighter than both surfaces it separated. It was
also the only edge with any treatment: the other three sit flush against the window.

### The fix

The border is removed; the panel is `bg-surface` + `shadow-lg` against the scrim.

⚠ **"Consistent" here means *none*, and that is a decision rather than a taste call.**
`Modal.tsx` — this component's sibling, same scrim, same surface — uses `border` on **all
four** sides, which is a closed shape and reads as a shape. A drawer sits flush against
three window edges and cannot have that. The remaining options are one border (what this
was) or none; the separation is already carried by `bg-surface` against a 60% scrim,
which is a far larger contrast step than a 1px hairline.

⚠ **Do not re-add a single-sided border to "define the edge"** — defining three edges out
of four is precisely what was reported.

The drawer is used by `MemberDrawer` and by every other caller, so this is one change at
the component, not a patch at the members page.

### The bound on the test

jsdom performs no layout, so `Drawer.test.tsx` asserts **class intent** — the same bound
every other styling test in this repo states. The assertion is an **absence**, so it
carries a control: an absence passes just as happily against a panel that could not be
found at all.

---

## BUG-3 — the Roles tab read a workspace that does not exist

### What was actually wrong

`useWorkspace()` holds `UNRESOLVED_WORKSPACE` (`"ws_it"`) until `resolveWorkspaceId()`
answers. `WorkspaceRolesPanel` called `foundryApi.listWorkspaceRoles(workspaceId)`
**directly with that value**, so on a cold load the request was
`GET /api/workspaces/ws_it/roles` — a path naming no workspace, with a segment Postgres
refuses as a uuid (`22P02`). The panel's three-state rendering then did its job correctly
and showed *"The roles could not be read … the check did not run"*, which is the honest
answer to a question that should never have been asked.

⚠ **IT WAS INTERMITTENT BECAUSE THE RECOVERY WAS A COINCIDENCE, NOT A MECHANISM.**
Nothing in the panel retried. What sometimes rescued it was
`app/(app)/layout.tsx`'s `key={workspaceId}` remounting `<main>` when the real id landed
— and whether that happened before or after the read depended on whether the module-level
`_wsId` cache was already warm from an earlier navigation. A hard load of
`/admin/members?tab=roles` lost the race; a reload (with the cache warm) won it. That is
exactly the shape of the report: *"sometimes doesn't load, and reloading fixes it"*.

### ⚠ THE GUARD WAS ALREADY IN THE REPOSITORY, AND IT WAS ALREADY RED

`lib/workspace-placeholder.test.ts`'s final `CONTROL` — written after the 2026-09-08
outage, where `getMe(workspaceId)` with this same placeholder took the API server down
fifteen times — scans every file containing `useWorkspace()` for functions handed the raw
context value, and requires every one of them to be a `lib/api.ts` function that
translates it through `scopedWorkspace`.

Run unchanged at the start of this work:

```
AssertionError: expected [ 'createWorkspaceRole', …(3) ] to deeply equal []
  + "createWorkspaceRole"
  + "listWorkspaceRoles"
  + "pick"
  + "retireWorkspaceRole"
```

Three of those four are this bug, named before anybody looked at the screen. **The guard
was right and had not been run.**

⚠ **The fourth name was a false positive, and it was fixed by removing the false
positive rather than by widening the guard.** `pick` is `Topbar`'s own local function,
and the one call `pick(workspaceId)` — the fallback row for an unknown workspace — was a
guaranteed no-op (`pick` returns early when the id is the current one). It is now
`closeMenu`, which is what it always did. **Widening the scan to ignore local functions
is I-62**: a guard that cries wolf gets widened, and the widening people reach for is the
one that permits the defect.

### The fix

Six wrappers in `lib/api.ts`, each routing through `scopedWorkspace`, and two components
moved onto them:

| Call | Was | Now |
| :--- | :--- | :--- |
| `listWorkspaceRoles` | `foundryApi.*` in `WorkspaceRolesPanel` | `lib/api.ts` |
| `createWorkspaceRole` | `foundryApi.*` in `WorkspaceRolesPanel` | `lib/api.ts` |
| `retireWorkspaceRole` | `foundryApi.*` in `WorkspaceRolesPanel` | `lib/api.ts` |
| `listWorkspaceRoleMembers` | `foundryApi.*` in `RoleHolders` | `lib/api.ts` |
| `assignWorkspaceRole` | `foundryApi.*` in `RoleHolders` | `lib/api.ts` |
| `unassignWorkspaceRole` | `foundryApi.*` in `RoleHolders` | `lib/api.ts` |

`scopedWorkspace` translates **one** value — the placeholder — and passes every real id
straight through, so nothing about `/organization`'s per-row subject changes.

`RoleHolders` was not named by the guard (it has no `useWorkspace()`; it takes
`workspaceId` as a **prop**) and had the identical defect. It is fixed in the same pass
rather than left to be rediscovered.

### ⚠ Three more calls with the same defect, found while fixing this one

`listMembers`, `grantMember` and `revokeMember` in `lib/api.ts` did **not** call
`scopedWorkspace`, and `/admin/members` hands all three the workspace-context value. The
guard did not catch them for the same reason it missed `RoleHolders`: the calls are made
from `MembersPanel` / `MemberDrawer`, which receive the id as a prop.

They now translate too. This is the **Members** tab of the same page, and it was one
warm-cache race away from the same report.

### ⚠ What is NOT claimed

This does not make the placeholder unreachable in general. It closes it for the roles and
members surfaces. The durable guard is `workspace-placeholder.test.ts`'s CONTROL, which is
now green and will name the next offender **in a file that uses `useWorkspace()`** — it
still cannot see a component that takes the id as a prop, which is how both `RoleHolders`
and `listMembers` hid. That limit is stated here rather than left implied.

---

## Requirements

### Functional

- **FR-001** Choosing a different workspace from the topbar switcher MUST adopt that
  workspace and then navigate to the home page (`/dashboard`).
- **FR-002** The adoption MUST happen before the navigation, so the destination page's
  first read is scoped to the newly chosen workspace.
- **FR-003** Choosing the workspace already active MUST change nothing — no switch, no
  navigation.
- **FR-004** The drawer panel MUST NOT carry a border on one edge only.
- **FR-005** The Roles tab MUST render the built-in roles and their permission lines on a
  cold load, without a page refresh.
- **FR-006** No request from these surfaces may carry the `UNRESOLVED_WORKSPACE`
  placeholder as its workspace id.
- **FR-007** The three-state rendering on every touched surface is unchanged: a read that
  genuinely fails still says *the check did not run*, and never renders as "none".

### Non-functional / non-goals

- **NFR-001** No server route, service, schema or migration changes. Verified: the diff
  touches `packages/client` only.
- **NFR-002** No change to what any of these screens is permitted to do.
  `requireWorkspaceRole` / `require-permission` guards are untouched; this is an
  affordance and correctness pass, not an access one.
- **NFR-003 (non-goal)** A shared `HOME_PATH` constant across all six landing paths. Five
  of them write the literal; rewiring `middleware.ts` and both sign-in buttons is a
  separate change with its own risk.
- **NFR-004 (non-goal)** Making the placeholder structurally unable to reach any request.
  That wants a `resolved` flag on the workspace context and a sweep of every prop-drilled
  `workspaceId`; see "What is NOT claimed".

---

## Success criteria

- **SC-001** `lib/workspace-placeholder.test.ts` — **red before, green after**, with the
  offending names quoted above.
- **SC-002** The Roles tab renders its roles with the placeholder still in the context.
  Proven against a mock that **fails** for the placeholder, so the test cannot pass
  against the bug.
- **SC-003** The switcher's order of operations is asserted, not assumed.
- **SC-004** The drawer carries no directional border class, with a control proving the
  panel was found.
- **SC-005** Every control added is proven by perturbation.

---

## Verification

Run on Node 22.23.2.

| Check | Result |
| :--- | :--- |
| `workspace-placeholder.test.ts` (the pre-existing CONTROL) | **red before → 5 passed after** |
| client typecheck (`tsc --noEmit`) | clean |
| client suite | **2691 passed / 177 files**; `3 failed` in 2 files |
| `scripts/ui-honesty-check.sh` | **239 PASS / 0 FAIL** |

⚠ **The 3 failures are PRE-EXISTING and were measured, not assumed.** The same two files
(`app/(app)/runs/[id]/page.test.tsx`, `app/(app)/flows/[id]/builder/page.test.tsx`) fail
with the identical count on a stashed tree at the session's starting commit. They touch
nothing in this change. `runs/[id]` is the file CLAUDE.md already records as **flaky** —
a different member of its pair failed on the baseline run than on the post-change run.
**Do not fix them here.**

### ⚠ Seven perturbations, seven red runs

Each fix was reverted in place and the suite re-run:

| Perturbation | Went red |
| :--- | :--- |
| `WorkspaceRolesPanel` back to `foundryApi.listWorkspaceRoles(workspaceId)` | 3 tests |
| `border-l border-line/60` restored on the drawer panel | 1 test |
| `pick` back to `if (id !== workspaceId) switchWorkspace(id)` (no navigation) | 2 tests |

The control in each file stayed green throughout, which is what shows the red runs are
the assertions firing rather than the fixture collapsing.

---

## Files changed

| File | Bug | What |
| :--- | :--- | :--- |
| `components/shell/Topbar.tsx` | 1, 3 | `pick` adopts then navigates; `closeMenu` extracted; `HOME_PATH` |
| `components/ui/Drawer.tsx` | 2 | the one-sided border removed; `shadow-sm` → `shadow-lg` |
| `lib/api.ts` | 3 | six role wrappers + `scopedWorkspace` on `listMembers`/`grantMember`/`revokeMember` |
| `lib/foundry-client.ts` | 3 | `FAWorkspaceRoleMember` named, so the wrapper has a return type |
| `components/access/WorkspaceRolesPanel.tsx` | 3 | reads `@/lib/api` |
| `components/access/RoleHolders.tsx` | 3 | reads `@/lib/api` |

### Tests

| File | New |
| :--- | :--- |
| `components/shell/Topbar.test.tsx` | **new** — 4 tests, switcher navigation + ordering + control |
| `components/access/WorkspaceRolesPanel.test.tsx` | **new** — 4 tests, cold-load roles read + control |
| `components/ui/Drawer.test.tsx` | +3 — no one-sided border, with a control |
| `components/admin/MemberTabs.test.tsx` | mock updated — see below |

⚠ **`MemberTabs.test.tsx`'s `vi.mock("@/lib/api")` is a WHOLE-MODULE REPLACEMENT.** Moving
the Roles tab onto `@/lib/api` meant an omitted export came back `undefined`, `useAsync`
invoked it, and **every test in the file died on a page that works**. This is the exact
hazard CLAUDE.md already records for `tools/page.test.tsx`. The mock now carries a note
for the next person adding a read to that page.
