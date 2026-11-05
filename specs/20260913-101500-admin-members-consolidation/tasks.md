---
feature: admin-members-consolidation
created: 2026-09-13
spec: ./spec.md
mock: ./mock.html
status: COMPLETE — all seven phases, see ./SESSION-NOTES.md
---

# Tasks — one page for people and access

Seven phases. **Each phase is a commit and each one leaves the product working**, so the
work can stop at any checkpoint without a half-moved access surface.

`[P]` = can run in parallel with the other `[P]` tasks in the same phase.
Every task cites the spec section it comes from.

---

## ⚠ Read before starting

- **There are two files called `MembersPanel.tsx`.** `components/admin/` is the one that
  **stays** and grows a drawer. `components/workspace/` is the duplicate that **goes**.
  Deleting the wrong one removes the surface this feature is built around.
- **Phase 1 must land before Phase 6.** Phase 6 deletes `/organization`'s member panel;
  Phase 1 is what lets a non-super-admin reach the one on `/admin/members`. In the other
  order, every workspace admin loses member management between the two commits.
- **Hiding is never the enforcement.** Every route behind every tab refuses on its own.
  These tasks change what is *offered*.
- **No task adds `|| me.superAdmin` beside a permission check.** The resolver already
  short-circuits an allowlist holder to every permission in both tiers. A second check is
  a second authority that can disagree with the first (spec D-4).

---

## Phase 0 — baseline

**Goal**: a record of what is true now, so Phase 7 can diff rather than eyeball.

- [ ] **T001** Capture to `baseline.txt`: `pnpm --filter @foundry/client test` (file/test
      counts **and the names of every failing test**), `pnpm --filter @foundry/client
      typecheck`, `bash scripts/ui-honesty-check.sh` (PASS/FAIL counts).
      ⚠ **Record the failures deliberately.** Two client tests are red before this feature
      touches anything — `runs/[id]/page.test.tsx` (documented flaky) and
      `workspace-placeholder.test.ts`. A baseline that omits them makes them look like
      ours. ⚠ Four `typecheck` errors are stale `.next/types` artefacts for
      `admin/downtime` and `admin/policies`, which **do not exist** — not source errors.
- [ ] **T002** [P] Record the current route inventory under `app/(app)/` (the page count
      `ui-honesty-check.sh` derives by walking the filesystem) and the current
      `alpha-registry.ts` keys. Both change in Phases 5–6 and both are asserted.
- [ ] **T003** [P] Confirm at the database or via `/api/me?workspaceId=…` that
      `capabilities` carries **permission keys** and does **not** contain `admin`. This is
      the premise of Phase 1 — check it rather than trusting spec §7.

**Checkpoint**: the numbers to beat are written down.

---

## Phase 1 — the dead gate (spec §7)

**Goal**: `/admin/members` admits the people who are actually entitled to it.
⚠ **Ship this first and separately.** It is a real access change and it should be
bisectable on its own.

- [ ] **T010** Prove the branch is dead before changing it: a test asserting
      `me.capabilities` never contains `"admin"`, citing migration `0065`'s two DROPs.
      ⚠ Without this the fix looks cosmetic and the next person re-adds the check.
- [ ] **T011** Replace the gate in `app/(app)/admin/members/page.tsx`:
      `!superAdmin && !capabilities.includes("admin")` → `useCan("members.read")`.
      ⚠ **Keep four states, not two**: allowed · denied · **unreadable** ·
      no-workspace-selected. `useCan` returns the first three; *"the check did not run"*
      keeps its own sentence and must not collapse into the refusal (INV-2).
- [ ] **T012** Gate each control on its own permission, per spec D-4's table — the role
      dropdown and Save on `members.grant`, Local accounts on
      `platform.localusers.write`, Assign across workspaces on `members.grant`.
      ⚠ A control a person cannot use is **disabled with a reason**, not hidden, wherever
      the surrounding panel is still useful to them.
- [ ] **T013** [P] `app/(app)/admin/members/page.test.tsx` — a workspace admin holding
      `members.read` reaches the page; somebody without it is refused; an unreadable check
      says so and reads as **neither** answer. ⚠ Include the **control**: a super admin
      still reaches it, or "refuse everybody" passes every assertion.
- [ ] **T014** [P] Perturbation: restore the old gate, watch T010 and T013 go red.

**Checkpoint**: a workspace admin can manage members without being a super admin.
**⚠ Nothing has moved yet — `/organization` still works exactly as before.**

---

## Phase 2 — the two primitives (spec §2.3, §2.4)

**Goal**: a drawer and a multi-select that are worth reusing. No behaviour change.

- [ ] **T020** Create `components/ui/Drawer.tsx` — right-side, Escape, backdrop click,
      focus trap, focus returned to the opener, page scroll locked.
      ⚠ **Model it on `components/ui/Modal.tsx` and take its lesson with it**: the title
      id is `useId()` **per instance**, never a constant. A fixed `"modal-title"` put two
      dialogs' `aria-labelledby` on one id and a screen reader announced the wrong title.
      A drawer and a `Confirm` will be open together here.
- [ ] **T021** [P] `components/ui/Drawer.test.tsx` — renders nothing when closed; Escape
      and backdrop close it; focus moves in on open and back to the opener on close.
- [ ] **T022** Create `components/ui/MultiSelect.tsx` — a button reading
      `N of M selected`, a popover of checkboxes, **Select all** with an indeterminate
      state, closes on outside click and Escape, `aria-expanded` + `aria-multiselectable`.
      ⚠ **It reports selection and owns none.** The selected ids stay the caller's state,
      like `FlowCanvas` reporting intents and never writing.
- [ ] **T023** [P] `components/ui/MultiSelect.test.tsx` — the label counts, Select all
      ticks and clears everything, the indeterminate state appears at a partial selection,
      outside click closes it, and **zero selected is representable** (the caller decides
      what that means).

**Checkpoint**: two primitives, tested, used by nothing yet.

---

## Phase 3 — the member drawer (spec §2.3, §8)

**Goal**: the permanent 420px column becomes a drawer opened by clicking a row.

- [ ] **T030** Create `components/admin/MemberDrawer.tsx` by **moving** the `<aside>` out
      of `components/admin/MembersPanel.tsx` — the grants read, the catalogue read, the
      role `<select>`, the per-capability checkboxes, the impact preview, the last-admin
      warning and Save. ⚠ **Move, do not rewrite.** Every refusal, caveat and three-state
      branch in there was put in deliberately; a rewrite loses them silently.
- [ ] **T031** `MembersPanel.tsx` becomes full width: the table, the search, and the
      footer. ⚠ **The role-is-not-identity footer STAYS** (INV-6) — *"A role decides what
      someone may do here; it is not proof of who they are…"*. It is the one sentence on
      the page that bounds what a role means.
- [ ] **T032** A row opens the drawer: click, and `Enter`/`Space` on a focused row.
      ⚠ Rows are `<tr>`; give them `tabindex` and a role, or the drawer is mouse-only.
- [ ] **T033** ⚠ **INV-9 — the drawer shows NO platform role and no `platform.*`
      permission.** Workspace access only: the preset, what it carries, and what was
      granted on top. Holders of a platform role are on the Platform tab and nowhere else.
- [ ] **T034** ⚠ **INV-3 — the role dropdown offers the three PRESETS only.** A custom
      role is held *alongside* a preset and is granted on the Roles tab. Putting one in
      this dropdown would say they are alternatives, and switching a person back to their
      preset would silently drop the custom role. The drawer may **list** custom roles the
      person holds as read-only context; it must not offer them here.
- [ ] **T035** [P] `components/admin/MemberDrawer.test.tsx` — opens with the clicked
      person's role and accesses; the last-admin warning appears for the sole admin and
      **not** for anybody else; an unreadable grants read says the check did not run;
      Escape closes. ⚠ Plus the INV-9 assertion **with a control** proving the scan can
      find a permission key at all — a grep that matches nothing passes vacuously.
- [ ] **T036** [P] Perturbation: put a `platform.*` row in the drawer (T033 red); put a
      custom role in the preset dropdown (T034 red); drop the footer (T031 red).

**Checkpoint**: no empty column when nobody is selected; everything the aside did still
works.

---

## Phase 4 — the workspace multi-select (spec §2.4)

**Goal**: `BulkAssignPanel`'s checkbox list becomes one control. Nothing else changes.

- [ ] **T040** Swap the `<fieldset>` of checkboxes for `MultiSelect`.
      ⚠ **Keep the default**: every workspace selected on mount
      (`workspaces.map(w => w.id)`), which is what makes the panel useful on arrival.
- [ ] **T041** ⚠ **The fan-out, the per-workspace result list and the "not atomic"
      sentence are UNCHANGED.** Each workspace is assigned independently, a failure in one
      does not undo the others, and the result list says which. A partial success rendered
      as one green tick is the lie this panel exists to prevent.
- [ ] **T042** The submit button and the `Confirm` body keep counting the selection —
      `Assign in N workspaces`, and the confirmation names N. ⚠ Zero selected **disables**
      submit; it must not silently submit to none and report success over an empty list.
- [ ] **T043** [P] `components/admin/BulkAssignPanel.test.tsx` — selecting two workspaces
      calls the grant twice with the right ids; a failure in one still reports the other as
      succeeded; zero selected cannot submit.
- [ ] **T044** [P] Perturbation: make the panel submit to all workspaces regardless of
      selection (T043 red); drop the per-workspace results (T041 red).

**Checkpoint**: the panel does exactly what it did, in less space.

---

## Phase 5 — the tabs (spec §2.1)

**Goal**: `/admin/members` holds all three views. **The two standalone pages die here.**

- [ ] **T050** Create `components/access/WorkspaceRolesPanel.tsx` — the body of
      `app/(app)/organization/roles/page.tsx`, `<Page>`/`<PageHeader>` removed.
      ⚠ **Move the file's reasoning with it**, including why presets are listed beside
      custom roles and why retiring is a timestamp and never a delete.
- [ ] **T051** [P] Create `components/access/PlatformRolesPanel.tsx` the same way from
      `app/(app)/organization/platform-roles/page.tsx`. ⚠ Keep the conferral sentence and
      keep it **conditional on the chosen role carrying `platform.members.grant`** — on
      every role it would teach that every platform role reaches tenant data.
- [ ] **T052** [P] Repoint `app/(app)/organization/platform-roles/page.test.tsx` at the
      new component as `components/access/PlatformRolesPanel.test.tsx`.
      ⚠ **Repoint, do not delete.** Eleven assertions including the conferral CONTROL and
      the two unreadable states; they are about the panel, not the route.
- [ ] **T053** Add the tab bar to `app/(app)/admin/members/page.tsx`.
      ⚠ **Follow `app/(app)/flows/page.tsx`, which already does this**: read the key from
      `useSearchParams`, validate it against the known list, fall back to the default when
      absent or unrecognised, and `router.replace` on change. Do not invent a second
      pattern.
- [ ] **T054** ⚠ **INV-1 — the Platform tab is gated on `platform.users.read` through
      `canPlatform`, NOT `useCan`.** A platform permission is never in the workspace union,
      so `useCan("platform.users.read")` answers **denied for a super admin holding all
      eleven**. Three states: shown · absent · shown-with-a-caveat when unreadable.
- [ ] **T055** **DELETE** `app/(app)/organization/roles/` and
      `app/(app)/organization/platform-roles/`.
      ⚠ **Delete, do not leave unlinked.** A page with no door is the defect closed on
      2026-09-13 — the platform tier was seeded, enforced and measured while unreachable.
      Leaving these alive with nothing linking to them re-creates it one week later.
- [ ] **T056** [P] Create `components/admin/MemberTabs.test.tsx` — the default tab; a
      deep link to `?tab=roles`; **an unrecognised `?tab=` value falls back to Members
      without erroring**; and INV-1 in all three states, with a control that the Platform
      tab *can* render.
- [ ] **T057** [P] `app/routes.smoke.test.tsx` — drop the two deleted paths, add the three
      tab URLs.
- [ ] **T058** [P] `components/shell/Sidebar.test.tsx` — its exemption map has an entry
      for `/organization/roles`, a page that no longer exists. Remove it. ⚠ Check whether
      `/organization/platform-roles` needs one too, and whether the Admin group's
      `ownedPaths` was claiming both by prefix — do not assume either way, read the test.
- [ ] **T059** Perturbation: make the tab React-state-only (T056's deep-link assertion
      red); gate the Platform tab on `useCan` (T054 red).

**Checkpoint**: every access surface is on `/admin/members`.
**⚠ `/organization` still shows its two panels — it is now the duplicate, not the home.**

---

## Phase 6 — strip `/organization` (spec §2.2, §4)

**Goal**: the workspaces page is about workspaces.
⚠ **Requires Phase 1.** Without it, non-super-admins lose member management entirely.

- [ ] **T060** Remove from `app/(app)/organization/page.tsx`: the **Roles and
      permissions** link, the **Platform roles** link, `<MembersPanel>` and
      `<PlatformUsersPanel>` — with their imports, the `membersKey` remount state and
      `activeName` if nothing else reads it.
- [ ] **T061** ⚠ **ALL FOUR ACCESS STATES STAY** (INV-2): super admin · signed in but not
      one · none configured · **could not be checked**. Removing panels must not remove
      the sentence that separates *"you may not"* from *"we could not find out"*.
- [ ] **T062** **DELETE** `components/workspace/MembersPanel.tsx`,
      `PlatformUsersPanel.tsx` and their tests.
      ⚠ **`components/workspace/`, NOT `components/admin/`.** Read the import path twice.
- [ ] **T063** `app/(app)/organization/page.test.tsx` — remove the "doors" block added on
      2026-09-13; **keep all four state tests**; assert the two panels are **gone**.
- [ ] **T064** ⚠ **Record the one real behaviour change** (spec §4) in the commit message
      and in `alpha-registry`: *"People who have signed in"* assigned as `admin` in **one
      click** (`const ASSIGN_ROLE: WorkspaceRole = "admin"`). Its replacement asks for
      person, role and workspaces — one step more, and a better default, because the old
      panel made everybody an administrator whether or not anybody meant it.
      **Do not present this as a pure win.**
- [ ] **T065** [P] Perturbation: delete one of the four access states (T061 red).

**Checkpoint**: `/organization` creates, renames and deletes workspaces, and nothing else.

---

## Phase 7 — the registry, the honesty check, and the sweep

**Goal**: every claim the product makes about these pages is true again.

- [ ] **T070** `lib/alpha-registry.ts` — delete the two entries for the deleted pages;
      rewrite `/admin/members`' to cover the three tabs, the drawer and the multi-select;
      revisit `/organization`'s now that it only does workspace CRUD.
      ⚠ **An entry is a claim.** One listing something under `soon` that has been built is
      a live falsehood — that bit once already, on 2026-09-13.
- [ ] **T071** [P] `bash scripts/ui-honesty-check.sh` green.
      ⚠ Two of its rules will bite: **no `max-w-` anywhere in a page file** (`<Page
      measure>` owns width — this failed on the platform-roles page when it was written),
      and **every page under `(app)` has a render test**, whose count it derives by
      walking the filesystem, so the two deletions move it on their own.
- [ ] **T072** [P] Check the honesty check's `app/(app)/organization`-scoped assertions
      still hold — the ban on reading `session.user.roles` there, and
      `present_code_in … 'getMe' … organization/page.tsx`. The page keeps `getMe`; confirm
      rather than assume.
- [ ] **T073** Full run: client suite, typecheck, honesty check. ⚠ Diff against
      `baseline.txt`, do not eyeball. **Any failure not in T001's list is ours.**
- [ ] **T074** **The perturbation sweep.** Re-run every perturbation named above in one
      pass and record *n fired / n attempted*.
      ⚠ **A perturbation whose anchor does not match DID NOT RUN, and its green result is
      meaningless — not a pass.** That happened once already on 2026-09-13; if a patch
      does not apply, fix the anchor and redo it.
- [ ] **T075** [P] Update `docs/ACCESS-CONTROL.md` §7 — the "where each of these is done"
      table names `/organization/roles` and `/organization/platform-roles`, both of which
      will be gone. Republish the page.
- [ ] **T076** [P] Append the outcome to this directory as `SESSION-NOTES.md`: what
      moved, the §4 behaviour change, the sweep result, and anything left open.

**Checkpoint**: no claim on any of these pages is stale.

---

## Dependencies

```
Phase 0  baseline
   │
   ├─→ Phase 1  the dead gate ─────────────────┐  (ships alone; must precede Phase 6)
   │                                           │
   ├─→ Phase 2  primitives ──┬─→ Phase 3 drawer│
   │                         └─→ Phase 4 multi │   (3 and 4 are independent)
   │                                           │
   └─→ Phase 5  extract + tabs ────────────────┤
                                               ▼
                                        Phase 6  strip /organization
                                               │
                                               ▼
                                        Phase 7  registry + sweep
```

Phases 1, 2–4 and 5 do not touch each other and can be done in any order.
**Only two orderings are load-bearing: Phase 1 before Phase 6, and Phase 5 before
Phase 6** — the panels must exist on `/admin/members` before the originals are deleted.

---

## Definition of done

| # | Check | From |
| :--- | :--- | :--- |
| A-1 | Three tabs; `?tab=` deep-links; an unrecognised value falls back without erroring | T053, T056 |
| A-2 | Platform tab absent without `platform.users.read`, present for a super admin, caveated when unreadable | T054, T056 |
| A-3 | Clicking a member opens the drawer; Escape closes; nobody selected renders **no** empty column | T032, T035 |
| A-4 | The role dropdown saves; the last-admin warning still appears for the sole admin | T035 |
| A-5 | Assign across workspaces submits to every selected workspace, reports each separately, still says it is not atomic | T041, T043 |
| A-6 | `/organization` has no members panel, no signed-in panel, no role links — and all four access states | T060, T061, T063 |
| A-7 | A workspace admin with `members.read` reaches `/admin/members` | T011, T013 |
| A-8 | The drawer renders no `platform.*` key and no platform role name | T033, T035 |
| A-9 | `ui-honesty-check.sh` ≥ baseline PASS, 0 FAIL | T071 |
| A-10 | No client test failing that was not failing at T001 | T073 |
| A-11 | Every control proven by perturbation, with the attempted count reported | T074 |
