# Tasks: UAT bug fixes — workspace switch, drawer edge, Roles tab

Retroactive: every task below is **done**. Ordered as executed. Each phase is
independently shippable; BUG-3 is the one worth shipping first.

**Read `spec.md` first** — the reasoning is there and is not repeated here.

---

## Phase 0 — measure before changing anything

- [x] **T000** Run `lib/workspace-placeholder.test.ts` unchanged.
  **Result: RED**, naming `createWorkspaceRole`, `listWorkspaceRoles`, `pick`,
  `retireWorkspaceRole`. This is BUG-3's root cause, found by the repo's own control
  before any screen was opened.
- [x] **T001** Baseline the client suite on a stashed tree, so a pre-existing failure
  cannot be read as a regression. **Result: 3 failures in 2 files**
  (`runs/[id]/page.test.tsx`, `flows/[id]/builder/page.test.tsx`), unrelated.

---

## Phase 1 — BUG-3, the Roles tab (P1: it is the only correctness defect)

- [x] **T100** Name `FAWorkspaceRoleMember` in `lib/foundry-client.ts` and type
  `listWorkspaceRoleMembers`' response with it, so the new wrapper has a return type
  rather than an inline shape.
- [x] **T101** Add six wrappers to `lib/api.ts`, each through `scopedWorkspace`:
  `listWorkspaceRoles`, `createWorkspaceRole`, `retireWorkspaceRole`,
  `listWorkspaceRoleMembers`, `assignWorkspaceRole`, `unassignWorkspaceRole`.
  The block above them carries the whole diagnosis.
- [x] **T102** Point `components/access/WorkspaceRolesPanel.tsx` at them. No `foundryApi.`
  left in the file.
- [x] **T103** Point `components/access/RoleHolders.tsx` at them (+ `listMembers`). It had
  the same defect and the guard could not see it — it takes `workspaceId` as a **prop**.
- [x] **T104** ⚠ Found while doing T103: `listMembers`, `grantMember` and `revokeMember`
  did not translate either, and `/admin/members` hands all three the context value.
  Fixed. Comment added saying why `scopedWorkspace` does **not** contradict the existing
  "these take an explicit workspace id" note above them.
- [x] **T105** Re-run T000. **GREEN, 5 passed.**

---

## Phase 2 — BUG-1, the workspace switch

- [x] **T200** `components/shell/Topbar.tsx`: extract `closeMenu`, and change the fallback
  row's `onClick={() => pick(workspaceId)}` to `onClick={closeMenu}`.
  ⚠ **This is the `pick` false positive from T000, removed at the source rather than by
  widening the scan** (I-62). The old call was already a guaranteed no-op.
- [x] **T201** `pick` → `closeMenu()`, return early on the current workspace,
  `switchWorkspace(id)`, `router.push(HOME_PATH)`. In that order.
- [x] **T202** `HOME_PATH` constant with the docblock recording that it is the sixth
  landing path and why it is not shared.

---

## Phase 3 — BUG-2, the drawer edge

- [x] **T300** `components/ui/Drawer.tsx`: drop `border-l border-line/60`, `shadow-sm` →
  `shadow-lg`. Docblock records the token arithmetic (`--line` is lighter than
  `--surface`), the `Modal.tsx` comparison, and the instruction not to re-add it.

---

## Phase 4 — tests, each with a control

- [x] **T400** `components/shell/Topbar.test.tsx` (**new**, 4 tests) — the switcher lists
  workspaces (CONTROL), switches **and** lands on `/dashboard`, adopts **before** it
  navigates (asserted as an ordered list, not two independent calls), and does nothing at
  all when the pick is the current workspace.
- [x] **T401** `components/access/WorkspaceRolesPanel.test.tsx` (**new**, 4 tests) — the
  mocked client **throws** for anything that is not the resolved uuid, so the test cannot
  pass against the bug. Asserts the roles render with the placeholder in the context, that
  the placeholder never reaches the wire, that the unreadable notice is absent, and a
  CONTROL with a real id already in the context.
- [x] **T402** `components/ui/Drawer.test.tsx` +3 — no directional border class, no
  all-round border, and a CONTROL proving the panel is found and carries its other classes
  (the assertions are ABSENCES and would otherwise pass over `null`).
- [x] **T403** `components/admin/MemberTabs.test.tsx` — add the six `@/lib/api` role
  exports to the whole-module `vi.mock`, with a note. Without this every test in the file
  dies on a page that works.

---

## Phase 5 — prove it

- [x] **T500** Perturb each fix in place and re-run. **Seven perturbations, seven red
  runs**; the control in each file stayed green, which is what distinguishes the
  assertions firing from the fixture collapsing.
- [x] **T501** `tsc --noEmit` on `packages/client` — clean.
- [x] **T502** Full client suite — **2691 passed / 177 files**, 3 failures matching the
  T001 baseline exactly.
- [x] **T503** `scripts/ui-honesty-check.sh` — **239 PASS / 0 FAIL**.

---

## Not done, deliberately

- **A `resolved` flag on the workspace context.** The durable fix for the whole class:
  every consumer would then be able to distinguish *"not asked yet"* from *"asked and
  failed"*, instead of relying on `scopedWorkspace` per call site and on
  `<main key={workspaceId}>` remounting. It needs a fourth state (resolution **failed** —
  the provider deliberately leaves the placeholder on screen) or the surfaces hang on
  "loading" forever, which is worse than an error.
- **Extending `workspace-placeholder.test.ts`'s scan to prop-drilled ids.** It is why both
  `RoleHolders` and `listMembers` hid. The honest version is the `resolved` flag above,
  not a wider regex.
- **A shared `HOME_PATH`.** Five other sites write `"/dashboard"` inline; rewiring
  `middleware.ts` and both sign-in buttons is its own change.
- **The two pre-existing test failures.** Baselined in T001, untouched.
