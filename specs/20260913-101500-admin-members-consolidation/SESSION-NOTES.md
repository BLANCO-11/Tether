---
feature: admin-members-consolidation
started: 2026-09-13
spec: ./spec.md
tasks: ./tasks.md
mock: ./mock.html
baseline: ./baseline.txt
---

# Session notes — resume point

**This file is the handover.** If a session ends, a new one reads this file and
`tasks.md` and continues. Update the phase table below **at the end of every phase**,
before the commit, not after.

---

## ⚠ Read this before touching anything

- **Node 22 is required.** `vitest.config.ts` throws below it, and below 22 the entire
  jsdom render layer fails to load while the summary line still says green.
  ```bash
  export PATH="$HOME/.local/share/node-versions/v22.23.2/bin:$PATH"
  ```
- **There are two files called `MembersPanel.tsx`.**
  `components/admin/MembersPanel.tsx` **stays** and grows a drawer.
  `components/workspace/MembersPanel.tsx` is the duplicate that **goes** (Phase 6).
  Read the import path twice before deleting.
- **Phase 1 before Phase 6.** Phase 6 deletes `/organization`'s member panel; Phase 1 is
  what lets a non-super-admin reach the one on `/admin/members`. The other order takes
  member management away from every workspace admin between two commits.
- **Phase 5 before Phase 6.** The panels must exist on `/admin/members` before the
  originals are deleted.
- **Never `|| me.superAdmin` beside a permission check.** The resolver already
  short-circuits an allowlist holder to every permission in both tiers. A second check is
  a second authority that can disagree with the first.
- **Hiding is never the enforcement.** Every route behind every tab refuses on its own.
  These changes decide what is *offered*.
- **`canPlatform`, not `can`, for a platform permission.** `data.permissions` is the
  workspace-tier union for one workspace; a platform permission is never in it, so
  `can("platform.users.read")` answers **denied for a super admin holding all eleven**.
- **A perturbation whose anchor does not match DID NOT RUN.** Its green result is
  meaningless, not a pass. Fix the anchor and redo it. This happened once already.

## Commands

```bash
export PATH="$HOME/.local/share/node-versions/v22.23.2/bin:$PATH"
pnpm --filter @foundry/client test
pnpm --filter @foundry/client typecheck     # 4 stale .next/types errors are NOT ours
bash scripts/ui-honesty-check.sh            # baseline 239 PASS / 0 FAIL
```

Baseline to diff against: `./baseline.txt`. **Any client test failing that is not one of
the three named there is ours.**

---

## Phase status

| Phase | What | Status | Commit |
| :--- | :--- | :--- | :--- |
| 0 | baseline | **DONE** | — |
| 1 | the dead gate — `/admin/members` admits `members.read` | **DONE** | `ad21b9b` |
| 2 | primitives — `Drawer`, `MultiSelect` | **DONE** | `d46670f` |
| 3 | the member drawer | **DONE** | `09c46db` |
| 4 | the workspace multi-select | **DONE** | `291e84d` |
| 5 | the tabs; delete the two standalone pages | **DONE** | `b41da85` |
| 6 | strip `/organization` | **DONE** | `5cd5eca` |
| 7 | registry, honesty check, perturbation sweep | **DONE** | `7e030b5` |

## Log

### Phase 0 — baseline (DONE)

- **T001/T002/T003 complete.** `baseline.txt` written.
- Client suite **2 files / 3 tests failing, all pre-existing and named** in `baseline.txt`.
- Typecheck: 4 errors, all stale `.next/types` for pages that do not exist.
- `ui-honesty-check.sh`: **239 PASS / 0 FAIL**.
- 37 pages under `(app)`, 37 registry keys.
- **T003's premise CHECKED, not assumed**: `CAPABILITIES = WORKSPACE_PERMISSIONS`,
  `getCapabilities` delegates to the resolver, and migration `0065` DROPs `admin`
  (lines 14-15 and the `DELETE` at line 95). So
  `!superAdmin && !capabilities.includes("admin")` on `/admin/members` is a **dead
  branch** — the page is super-admin-only in practice while reading otherwise.

### Phase 1 — the dead gate (DONE)

- **T010** `dead-capability-gate.test.ts` — four assertions, each with a control:
  `admin` is not a key in `auth/permissions.ts`; `CAPABILITIES = WORKSPACE_PERMISSIONS`;
  migration `0065`'s `DELETE` is still in the tree; and the page no longer makes the read.
- **T011** The gate is `useCan("members.read")`. **Four states kept**: allowed · denied ·
  unreadable · no-workspace-selected, plus a *checking* state read off the provider's own
  `loading` (⚠ `useCan` has none — before the answer arrives it correctly says
  `unreadable`, and rendering "the check did not run" while it is still running is a
  third kind of lie).
- ⚠ **The page-level refusal fires only when ALL THREE of `members.read`, `members.grant`
  and `platform.localusers.write` are denied.** Refusing the whole page on `members.read`
  alone would hide local-account creation — a **platform** capability with nothing to do
  with the active workspace — from somebody entitled to it. That is the same shape as the
  `canPlatform` bug, and it is why `LocalAccountsPanel` is gated with `useCanPlatform`.
- **T012** Each control states its own answer. Inside `MembersPanel` the role `<select>`,
  Save, Remove, Invite and the capability checkboxes are gated on `members.grant`:
  denied → **disabled with the permission named** (not hidden); unreadable → **left
  enabled with a note**, because disabling on a failed check denies access on a network
  error.
- **T013** `page.test.tsx` rewritten — 10 tests. ⚠ Its old four "access states" were
  **super-admin** states and all four passed against a page that refused every workspace
  administrator in the product. The CONTROL ("a super admin still reaches it") is what
  stops "refuse everybody" scoring 100%.
- **T014 PERTURBATION: 1 attempted, 1 fired.** Restoring the old gate turned **5** tests
  red across both files, including the one named "A WORKSPACE ADMIN WHO IS NOT A SUPER
  ADMIN REACHES IT".

⚠ **I-62 FIRED ON MY OWN GUARD, the fifth time in this repo.** T010's fourth assertion
matched `capabilities?.includes("admin")` against the raw page file and went red —
because the page's docblock **quotes the dead gate verbatim** to explain why it is gone.
The explanation and the violation say the same words. Fixed the way this repo says to:
**strip comments, then scan**, with a control asserting the strip did not empty the file
and a second control asserting the docblock's copy really is in the raw text, so the
strip is doing work rather than passing over an absence.

**Green at the end of Phase 1**: client **2551 passed**, the same 2 files red as the
baseline and no others; typecheck clean under `src/`; `ui-honesty-check.sh` **239 PASS /
0 FAIL**.

### Phase 2 — the two primitives (DONE)

- **T020 `components/ui/Drawer.tsx`** — right-side, Escape, backdrop click, focus trap,
  focus returned to the opener, page scroll locked **and restored to its previous value
  rather than blanked**.
  - ⚠ **A separate component from `Modal`, not a `side` prop.** A modal is a *question*:
    it interrupts and the page behind it is suspended. A drawer is a *detail view*: the
    list stays visible beside it and closing it is a navigation. One name over two
    behaviours means the one that reads as the default is whichever the next caller
    happened to write.
  - ⚠ **The `useId()` lesson travelled with it.** `Modal`'s title id was the constant
    `"modal-title"`; two open dialogs both carried `aria-labelledby="modal-title"`, the id
    existed twice, every resolver takes the first, and a screen reader announced one
    dialog under the other's title. **A drawer and a `Confirm` are open together here**
    (removing a member from inside the drawer), so this is not hypothetical.
  - `w-full` first, `sm:max-w-[460px]` second — a fixed 420px panel on a 400px screen
    scrolls the page sideways with the backdrop out of one edge.
- **T022 `components/ui/MultiSelect.tsx`** — `N of M selected`, a popover of checkboxes,
  Select all with a real indeterminate state, closes on outside click and Escape,
  `aria-expanded` + `aria-multiselectable`.
  - ⚠ **It reports selection and owns none** — the `FlowCanvas` posture. A component
    holding its own copy is a second answer to "what is selected".
  - ⚠ **Zero selected is representable and what it MEANS is the caller's to decide.** It
    is not silently promoted to "all". `BulkAssignPanel` disables submit on it; a filter
    control would reasonably read zero as "no filter".
  - ⚠ **`indeterminate` is a DOM PROPERTY.** `indeterminate={true}` in JSX compiles,
    renders and does nothing — a partial selection would draw an EMPTY box, saying "none
    of these" over a list where some are picked. Set in an effect off a ref.
  - ⚠ Deliberately **not** a native `<select multiple>`: it needs ctrl-click for a second
    item, shows no count, and silently clears the whole selection on a plain click.
- **T021 / T023**: 9 + 10 tests, every behavioural assertion carrying its control (a click
  inside must NOT close; a full selection is checked and not indeterminate; an empty
  selection is neither).
- **PERTURBATIONS: 2 attempted, 2 fired.** `indeterminate = false` turns the MultiSelect
  assertion red; a constant `titleId` turns the two-drawers assertion red.

**Two primitives, tested, used by nothing yet.**

### Phase 3 — the member drawer (DONE)

- **T030 `components/admin/MemberDrawer.tsx` — MOVED, not rewritten.** The grants read,
  the catalogue read, the role `<select>`, the per-permission checkboxes, the impact
  preview, the last-admin warning, Save and Remove. Every refusal, caveat and three-state
  branch came across intact.
- **T031** `MembersPanel` is full width: table, search, **the role-is-not-identity footer
  (INV-6)** and the invite affordance. ⚠ Invite stayed on the panel deliberately — it is
  about the workspace, not about one member.
  - The old resting state was a table beside an empty box reading *"Select a member to
    edit their role"* — a permanent instruction occupying a third of the width. It is
    gone; `member: null` renders `null`.
  - ⚠ **The open member is `null` unless somebody opens one.** The old aside defaulted to
    `filtered[0]` because it was always on screen and had to show something; a drawer
    doing that would be a dialog nobody asked for, over a person nobody chose.
  - ⚠ The open member is tracked by **SUBJECT, not by row** — a reload rebuilds the rows.
- **T032** Click, `Enter` and `Space`. ⚠ A `<tr>` is not focusable and has no role that
  accepts a click: without `tabIndex`/`role`/`onKeyDown` the table would still LOOK
  interactive and simply do nothing for anybody navigating by keyboard — the failure
  nobody sees because everybody testing it has a mouse.
- **T033 INV-9** — no platform role, no `platform.*` permission. The mechanism is
  `tier === "workspace"` off the server's own catalogue, **not** a `platform.` prefix
  blocklist: filtering on what the server declares stays true when a permission is
  renamed.
- **T034 INV-3** — the role dropdown offers the three PRESETS, asserted **exactly, not as
  a superset**. A custom role is held *alongside* a preset (the resolver is a union with
  no subtraction), so offering one here would say they are alternatives and switching
  somebody back to their preset would silently drop it.
  - ⚠ The drawer **states its own bound**: *"Any custom role they also hold adds to this
    and is managed on the Roles tab."* It reads the preset plus explicit grants and does
    not read custom roles, so it must not be presented as the complete effective set.
- **T035** 15 tests. The INV-9 assertion carries **two** controls — the scan can find a
  workspace permission at all, and the mocked catalogue really does carry platform
  permissions, so the filter is doing work rather than passing over an absence. The
  last-admin warning carries two controls (a second admin exists; the person is not an
  admin).
- ⚠ **`MembersPanel.test.tsx` was REPOINTED, not deleted.** Its ten editor assertions ran
  against the permanent aside; they now open the drawer first. Deleting them would have
  been the quiet option — the capability-grant write path, the locked-by-role reason, the
  unreadable-grants notice and the two-list preview all still need saying.
- ⚠ A `getByText("admin")` found **two** nodes (the drawer subtitle and an `<option>` in
  the role select) and failed in a way that reads as the subtitle not rendering. The
  subtitle carries a `data-testid`; the reason is in the code.
- **PERTURBATIONS: 5 attempted, 5 fired.** Drop the `tier` filter → INV-9 red. A fourth
  entry in `ROLES` → INV-3 red. Replace the footer → INV-6 red. Default the drawer to
  `members[0]` → 2 red. `tabIndex={-1}` → the keyboard assertion red.

**Green at the end of Phase 3**: client **2584 passed**, the same 2 baseline files red and
no others; typecheck clean under `src/`; `ui-honesty-check.sh` **239 PASS / 0 FAIL**.

⚠ **A third file flaked once under full-suite load** and passes in isolation:
`flows/[id]/builder/page.test.tsx` > *"BX-005 … streams the execution it started"*
(1200 ms). Not ours — verified by running it alone.

### Phase 4 — the workspace multi-select (DONE)

- **T040** The `<fieldset>` of checkboxes is one `MultiSelect`. The panel's height no
  longer grows with the tenancy.
- **T041** ⚠ **The fan-out, the per-workspace result list and the "not atomic" sentence
  are UNCHANGED.** Each workspace is assigned independently and the result list says
  which. A partial success rendered as one green tick is the lie this panel exists to
  prevent.
- **T042** The submit button and the `Confirm` both count the selection. Zero selected
  **disables** submit.

⚠ **A PRE-EXISTING BUG, FOUND WHILE SWAPPING THE CONTROL — the documented default never
happened.** `useState(workspaces.map(...))` is evaluated on the FIRST render only, and
the page mounts the panel as `workspaces={spaces.data ?? []}` where `spaces` is a
`useAsync`. So the real first render got `[]`, nothing re-seeded when the list arrived,
and **the panel opened with nothing selected and a disabled submit button** while its own
comment said every workspace was selected on arrival. It survived because every test
passed a populated array at mount — the one arrangement where the initial value is right.
Seeded **once** via a ref: re-seeding on every change would silently re-tick every box the
instant the list reloaded, undoing a deliberate deselection right before somebody pressed
Assign, which is the more dangerous direction. There is a test for each direction.

⚠ A `<label htmlFor="bulk-workspaces">` was left pointing at nothing (the control is a
button, not an input with that id). Removed.

- **PERTURBATIONS: 5 attempted, 5 fired — but only after a test was fixed.**

⚠ **P1 DID NOT FIRE ON ITS FIRST RUN, AND THAT WAS A HOLE IN MY TEST, NOT A PASS.**
Making the panel ignore the selection and submit to every workspace turned **nothing**
red — including the assertion written specifically to catch it. The cause:

```
await waitFor(() => expect(grantMember).toHaveBeenCalledTimes(1));
```

`waitFor` **retries until the assertion passes**, and the fan-out is a sequential loop of
awaits — so a panel submitting to BOTH workspaces passes through a moment where exactly
one call has been made, and `waitFor` caught that moment and went green. The wait is now
on the loop having **finished** (the result list, which only renders after it) and the
count is asserted once, afterwards, on a settled state.
**Never `waitFor` a call count you expect to be an upper bound.** P1 fires now.

**Green at the end of Phase 4**: client **2591 passed**, the same 2 baseline files red;
typecheck clean under `src/`; `ui-honesty-check.sh` **239 PASS / 0 FAIL**.

### Phase 5 — the tabs (DONE)

- **T050/T051** `components/access/WorkspaceRolesPanel.tsx` and `PlatformRolesPanel.tsx`
  — the bodies of the two pages, `<Page>`/`<PageHeader>` removed, **reasoning moved with
  them**: presets listed beside custom roles; retiring is a timestamp with the count in
  the confirmation; the conferral note **conditional on the chosen role carrying
  `platform.members.grant`**.
  - ⚠ `PlatformRolesPanel`'s docblock said *"a different SCREEN from `/organization/roles`"*.
    **Corrected in place, not deleted** — it is a different TAB now, and the distinction
    it was protecting is unchanged: a platform role is still not an option in the
    workspace role list and still not something the member drawer can set (INV-9). What
    changed is the number of URLs, not the number of answers.
  - ⚠ Its trailing cross-link pointed at `/organization/roles`. It now NAMES the Roles
    tab rather than linking to a 404.
- **T052** `page.test.tsx` → `components/access/PlatformRolesPanel.test.tsx`, **repointed,
  not deleted** — all **11** assertions travelled, conferral control and both unreadable
  states included.
- **T053** The tab bar follows `app/(app)/flows/page.tsx`: `useSearchParams` → validate
  → fall back → `router.replace`. No second pattern invented.
- **T054 INV-1** — the Platform tab is gated through **`canPlatform`**. Three states:
  shown · absent · **shown-with-a-caveat** when unreadable.
- **T055** `app/(app)/organization/roles/` and `.../platform-roles/` are **DELETED**.
  ⚠ Their `/organization` doors were **repointed at the tabs in this same commit** rather
  than left dangling — every phase has to leave the product working, and Phase 6 is what
  removes them entirely.
- ⚠ **The two `alpha-registry` entries were ABSORBED into `/admin/members`', not dropped.**
  `alpha-registry.test.ts` fails on an orphan entry, so they had to go now; deleting true
  claims and re-deriving them in Phase 7 would have left the product saying less than it
  does for a commit. The `/admin/members` entry is rewritten to cover all three tabs, the
  drawer and the multi-select.
- **T058** ⚠ **The `/organization/roles` exemption in `Sidebar.test.tsx` WAS ALREADY
  DEAD** — the Admin group's `ownedPaths` carries `/organization` and the claim check
  prefix-matches (`pathname.startsWith(p + "/")`), so both pages were claimed by the rail
  and the exemption was never consulted. That is why `/organization/platform-roles` never
  needed one. Removed, with the reason written where the entry was. **Read the claim
  logic before adding an exemption.**
- ⚠ `page.test.tsx` crashed in all 10 tests once the tabs landed — the page reads
  `useSearchParams`/`useRouter` and jsdom has no Next router. Mocked, with a note saying
  that file is about ACCESS and `MemberTabs.test.tsx` is where the tab is asserted.
- **PERTURBATIONS: 4 attempted, 4 fired.** React-state-only tab → 2 red. `useCan` for the
  Platform tab → 3 red. An unvalidated `?tab=` → 1 red. Collapsing `unreadable` into
  `denied` → 1 red.

**Green at the end of Phase 5**: client **2596 passed**, the same 2 baseline files red;
typecheck clean under `src/`; `ui-honesty-check.sh` **239 PASS / 0 FAIL**.

**⚠ `/organization` still shows its two panels — it is now the duplicate, not the home.**

### Phase 6 — strip `/organization` (DONE)

- **T060** The two role links, `<MembersPanel>`, `<PlatformUsersPanel>`, their imports,
  `membersKey` and `activeName` are gone. The page creates, renames and deletes
  workspaces, and nothing else.
- **T061** ⚠ **ALL FOUR ACCESS STATES STAY**: super admin · signed in but not one · none
  configured · **could not be checked**.
- **T062** `components/workspace/{MembersPanel,PlatformUsersPanel}.tsx` and their tests
  deleted. ⚠ **`components/workspace/`, not `components/admin/`.**
  - **Two assertions from the deleted test files had a live subject and were CARRIED
    OVER rather than deleted**: *"offers no claim button"* (the self-claim route is
    deleted, so a claim button would be a control with no route behind it) onto
    `MemberDrawer.test.tsx`, and *"an unreadable people list does not read as nobody
    having signed in"* onto `BulkAssignPanel.test.tsx`.
- **T063** The `page.test.tsx` "doors" block is **replaced by its opposite** — the four
  access states kept, and three new assertions that the duplicates are gone, with a
  CONTROL that the workspace surface itself still renders. (Without that control a page
  rendering nothing passes every deletion assertion — I-38, and it matters most when the
  subject *is* a deletion.)
- **T064** ⚠ **THE ONE REAL BEHAVIOUR CHANGE, and it is not a pure win.**
  `PlatformUsersPanel` assigned a signed-in person as `admin` in ONE CLICK
  (`const ASSIGN_ROLE: WorkspaceRole = "admin"`). Its replacement asks for person, role
  and workspaces — **one step more**, and a better default, because the old panel made
  everybody an administrator whether or not anybody meant it. Recorded in the page's own
  comment, in the commit message and in the registry entry.

⚠ **THREE `ui-honesty-check.sh` ASSERTIONS WERE PINNED TO THE DELETED FILES, and one of
them protected a sentence that had lost its home.** `SEEN_USERS_EXPLAINER` and
`SEEN_USERS_UNREADABLE` were rendered by **nothing** after the deletion — so the picker
in `BulkAssignPanel`, which reads the **same `platform_users` list**, would have listed
those people with no statement of what a row means. That is the picker reading as a user
directory, which is the one claim this whole surface is careful not to make.

**Fixed in the substance, not in the assertion.** `BulkAssignPanel` now renders both
sentences, and the three assertions are **repointed** at the components that render them
(`components/admin/MembersPanel.tsx`, `components/admin/BulkAssignPanel.tsx`) with a note
saying why. An assertion deleted along with its file takes the claim with it silently,
which is exactly the failure the assertion exists to prevent.

- **PERTURBATIONS: 3 attempted, 3 fired.** Remove the unreadable state → red. Collapse
  the two super-admin refusals into one sentence → red. Put a members panel back → red.

**Green at the end of Phase 6**: client **2587 passed**, the same 2 baseline files red;
typecheck clean under `src/`; `ui-honesty-check.sh` **239 PASS / 0 FAIL**.

### Phase 7 — the registry, the honesty check and the sweep (DONE)

- **T070** `/organization`'s registry entry **rewritten**: it claimed *"workspaces, their
  members and their roles are real and are enforced"*, which is true of the product and
  **false of that screen** now — the shape an alpha entry exists to refuse. The
  `/admin/members` entry was already rewritten in Phase 5 (it had to be, to absorb the
  two orphans).
- **T071** `ui-honesty-check.sh` **239 PASS / 0 FAIL**, equal to the baseline.
- **T072** ⚠ **Confirmed by reading, not assumed.** Both `app/(app)/organization`-scoped
  assertions still hold: the ban on reading `session.user.roles` there (the directory
  still exists), and `present_code_in 'getMe' organization/page.tsx` (the page keeps it).
- **T073** Client **2587 passed** against a **2542** baseline. **2 files red, and they
  are the two named in `baseline.txt`.** No failure outside that list. Typecheck clean
  under `src/` (the 4 stale `.next/types` errors are unchanged). Pages under `(app)`:
  **35**, down from 37, which is the two deletions and nothing else.
- **T075** `docs/ACCESS-CONTROL.md` §7 rewritten — the table named two pages that no
  longer exist. It now names the three tabs, and carries three bounds it did not: INV-9
  (the drawer shows no platform role), why the Platform tab needs `canPlatform`, and the
  one real behaviour change.
- Two stale **present-tense** claims about `/organization/roles` were corrected in
  `RoleHolders.tsx` and its test. Every other mention of the deleted pages in the tree is
  historical — *"used to be"*, *"was here and is gone"* — which is correct and stays.

### ⚠ T074 — THE PERTURBATION SWEEP: **20 fired / 20 attempted · 0 NOT RUN · 0 MISSED**

⚠ **Superseded by the 2026-09-15 entry below: the sweep is now 26 / 26, and P04 here had
gone stale.** The reading in this section is the one taken at T074 and is left as taken.

Script: `scratchpad/sweep.py` (session-local). It reports **n fired / n attempted**, and
an unmatched anchor is its own outcome — **NOT RUN**, never counted as a pass. That
distinction is the whole reason it exists: a perturbation whose anchor does not match did
not run, and its green result is meaningless.

| | Perturbation | Fires |
| :--- | :--- | :--- |
| P01 | restore the dead capability gate | ✔ |
| P02 | `MultiSelect` never sets `indeterminate` | ✔ |
| P03 | `Drawer` uses a constant title id (Modal's bug) | ✔ |
| P04 | INV-9: platform permissions rendered in the drawer | ✔ |
| P05 | INV-3: a custom role in the preset dropdown | ✔ |
| P06 | INV-6: the role-is-not-identity footer removed | ✔ |
| P07 | the drawer opens itself on the first member | ✔ |
| P08 | rows are not keyboard reachable | ✔ |
| P09 | bulk assign ignores the selection and submits to all | ✔ |
| P10 | one result instead of per-workspace results | ✔ |
| P11 | zero selected can submit | ✔ |
| P12 | re-seed on every change (clobbers a deselection) | ✔ |
| P13 | never seed (a late list stays unselected) | ✔ |
| P14 | the tab is React state only, not the URL | ✔ |
| P15 | INV-1: the Platform tab gated on `useCan` | ✔ |
| P16 | an unrecognised `?tab=` is used verbatim | ✔ |
| P17 | an unreadable platform check hides the tab | ✔ |
| P18 | `/organization` loses its could-not-be-checked state | ✔ |
| P19 | the two super-admin refusals collapse into one | ✔ |
| P20 | a members panel comes back to `/organization` | ✔ |

⚠ **P09 MISSED ON ITS FIRST RUN during Phase 4 and that was a hole in the test, not a
pass** — see the Phase 4 entry. It fires now.

---

## Definition of done

| # | Check | Status |
| :--- | :--- | :--- |
| A-1 | Three tabs; `?tab=` deep-links; unrecognised falls back without erroring | ✔ |
| A-2 | Platform tab absent without the permission, present for a super admin, caveated when unreadable | ✔ |
| A-3 | Clicking a member opens the drawer; Escape closes; nobody selected renders no empty column | ✔ |
| A-4 | The role dropdown saves; the last-admin warning still appears for the sole admin | ✔ |
| A-5 | Assign across workspaces submits to every selected workspace, reports each, still says it is not atomic | ✔ |
| A-6 | `/organization` has no members panel, no signed-in panel, no role links — and all four access states | ✔ |
| A-7 | A workspace admin with `members.read` reaches `/admin/members` | ✔ |
| A-8 | The drawer renders no `platform.*` key and no platform role name | ✔ |
| A-9 | `ui-honesty-check.sh` ≥ baseline PASS, 0 FAIL | ✔ 239 / 0 |
| A-10 | No client test failing that was not failing at T001 | ✔ |
| A-11 | Every control proven by perturbation, with the attempted count reported | ✔ 20/20 |

---

### Follow-up from use — the workspace popover was clipped (2026-09-13)

Reported with a screenshot: the Workspaces dropdown opened and showed **"Select all" and
one workspace out of eight**, cut off at the panel's bottom edge.

**Cause: `BulkAssignPanel`'s own `<section className="overflow-hidden …">`.**
`MultiSelect` positions its list `absolute`, so an ancestor hiding overflow cuts it at
the panel's boundary. The list rendered correctly and six rows were simply not there —
nothing errored, and it reads as the control being broken rather than the container.

The `overflow-hidden` was only clipping the section's rounded corners, and nothing inside
paints to them (the header has a `border-b` and no background of its own), so removing it
costs nothing. ⚠ The app shell's `overflow-y-auto` is **not** a second clipper — an
absolutely positioned child extends a scrollable area rather than being cut by it; that
was checked rather than assumed.

- ⚠ **The constraint is now stated on the PRIMITIVE**, because the next caller will hit
  it: *the popover is `absolute`, so a caller with `overflow-hidden` will clip it — check
  the ancestors before mounting this inside a panel.* A portal would make it immune and is
  deliberately not done: positioning and scroll-tracking code for one caller, where the
  constraint is cheap to state.
- ⚠ **jsdom performs no layout**, so no test here can measure a clipped popover. The test
  asserts the CLASS — the same posture the collapsed-sidebar fix took — with a control
  that the scan found the right section.
- **PERTURBATION: 1 attempted, 1 fired.** Putting `overflow-hidden` back turns it red.

### Follow-up from use — the page tore itself down once a minute (2026-09-13)

Asked as *"does /admin/members refresh every few seconds to check the access?"* — and the
answer to the literal question is **no, every 60 seconds**
(`REFRESH_MS = 60_000` in `PermissionsProvider`, so a revocation takes effect without a
sign-out). Nothing on the page polls; its reads run on mount and on explicit `reload()`.

**But something WAS happening on screen, and it was mine, from Phase 1.** The provider
calls `setLoading(true)` on **every** one of those ticks, and the page gated its whole
render on `accessLoading`. So once a minute the page was replaced by *"Checking your
access…"* and rebuilt — the subtree unmounted, taking **the search text, an open drawer,
and any role change somebody had chosen and not yet saved** with it.

The fix is that the checking state belongs to the **first load only**:
`accessLoading && !myPermissions`. A background refresh has nothing to hide — the provider
retains `data` across it (it clears only on failure), so `can()` keeps answering with the
last thing the server said, which is what a refresh is *for*.

- ⚠ **`loading` and `data` are independent, and conflating them is the whole bug.**
  *Loading with data* is the ordinary background refresh; *loading without data* is the
  only state with nothing to show.
- ⚠ **The test mock derived `data` FROM `loading`**, so "refreshing while holding an
  answer" was a state it could not represent — which is why the original assertion passed
  against a page that tore itself down. Two separate flags now.
- ⚠ **Checked whether anything else has this shape: nothing does.** `Can`,
  `PermissionGate` and `Sidebar` read the ANSWER (`can`/`data`), never the loading flag.
  `/admin/members` was the only surface reading `loading`, and it was added in Phase 1.
- **PERTURBATION: 1 attempted, 1 fired.** Gating on `accessLoading` again turns the new
  assertion red.

### `release/beta` merged in (2026-09-14) — `b8e26b9`

Ten conflicts. Six were ours-is-a-superset, three needed a real decision, and one was a
migration collision that would have been silent and expensive. **The four surfaces this
feature built are unchanged**; what follows is what the merge had to decide.

**⚠ THE MIGRATION COLLISION.** Both branches minted an `0062` — beta's
`0062_mock_readiness` and ours `0062_workspace_roles` — with the same idx and the same
`when`. Ours **are already applied here** (watermark `1789500000000`), and drizzle's test
is `created_at < folderMillis` against `max(created_at)`, so renumbering an applied
migration makes it look new and re-runs it for ever. The applied ones kept their numbers;
the incoming one became **`0066`** with a `when` above the watermark. ⚠ Safe only because
its SQL is idempotent throughout — checked before renaming, not assumed. Verified at the
database: 67 applied, watermark `1789600000000`, all three columns present.

**⚠ TWO ROUTES WOULD HAVE SHIPPED OPEN.** `route-permissions.test.ts` went red on arrival
— beta's `GET …/datasources/:dsId/mock` and `…/mock/rows` declare nothing, because beta
predates the RBAC work. Both are `datasources.read`, like every sibling read there. ⚠
`/mock/rows` returns ROWS and that is still the right tier: fixture rows come from the
schema only and are never production data (D-54). Declared in `gen-map.py` and the map
**regenerated** (it is generated); tripwire counts 214 → 216, 150 → 152.

**The one design conflict** — `resources/[id]`. Beta made `/data-sources/[id]` rich and
turned that section into a summary pointing there; we had put the full datasource panes on
the resources page. Taken literally the merge lists every table twice. Both halves kept:
the summary's table list dropped (the pane does it with columns), beta's exit sentence
kept.

**Ours, where ours had moved past beta**: `app.ts`, `member-capabilities.ts`,
`MembersPanel`, `BulkAssignPanel`, the members page, and the registry line claiming
"capabilities are the SEVEN the server knows" (there are 38). ⚠ Restoring beta's
`requireSuperAdmin` on `member-capabilities` would have been an AND with the spliced
guard and would have stopped a workspace admin managing grants in their own workspace.

**One test file was slow, not broken.** Three pglite driver tests timed out at 5s; all 22
pass at 5.5–6.1s and siblings already sat at 2.8–3.3s, so the file drifted over the
default on a host whose EDR makes `/usr/bin/true` cost ~62ms. Given a 30s budget **with
the diagnosis written down** — the number is there because the tests boot a real Postgres,
not to make them green.

**Verified**: both typechecks clean · server **3002 passed** (5 red = the documented
pre-existing `elseOf`/`failureMode`/`flow-replay` set) · client **2639 passed** (2 files
red, both in `baseline.txt`) · `ui-honesty-check.sh` **239 PASS / 0 FAIL** ·
`kestra:check` boundary intact · `next build` exit 0.

### Follow-up from use — the bands expand and collapse (2026-09-15)

Asked for directly: *"make the permission under role expandable and collapsable"*. The
banding landed in `4528c2a`; this is the disclosure over it.

**`components/access/PermissionBand.tsx` is ONE implementation, read by both consumers.**
`MemberDrawer` and `RoleEditor` band the same catalogue through the same `groupByPreset`;
two disclosures over one banding is how the two screens come to disagree about what a
band is called, what its count means and whether it starts open — the same reasoning as
the banding itself, and as the deleted `lib/capabilities.ts`.

⚠ **A COLLAPSED BAND STILL SAYS SOMETHING TRUE.** The count (`12 of 19`) and the hint are
in the head, outside the body, so a closed band reads as *"nineteen here, twelve held"* —
never as an absence. `summary` is a required prop for that reason: a band able to render a
closed head with no count would be a panel claiming nothing while looking complete.
Collapsing removes detail; it must never remove evidence.

⚠ **THE BODY UNMOUNTS RATHER THAN HIDING, AND THAT IS THE LOAD-BEARING CHOICE.** `hidden`
was the smaller diff and would have left every existing assertion green without anybody
touching a test — which is precisely the objection. `getByLabelText` and
`container.textContent` both read hidden nodes, so INV-9's `not.toContain("platform.")`
would then have passed over a **closed** drawer rather than over a **filtered** one, and
`boxes.length === 3` would have counted checkboxes nobody can see. A suite that cannot
tell the screen from the DOM is I-38 with extra steps. Nine tests were repointed to open
the bands first; each one is now an assertion about what a person sees.

**Defaults, and why they are not a rule about which screen this is.** The drawer opens
every band closed — the counts answer *"what does this person hold"* at a glance. The role
editor opens a band that already carries a chosen permission, because editing an existing
role behind three closed heads hides the thing being edited. Both fall out of the data
(`defaultOpen={picked > 0}`), so a new role opens closed and an edited one opens where the
work is.

⚠ **P04's anchor in `sweep.py` had gone STALE and was reporting NOT RUN.** The tier filter
moved into `groupByPreset` when the permissions were banded, so the INV-9 perturbation had
stopped matching — which the script reports as NOT RUN rather than as a pass, which is the
entire reason it distinguishes them. Re-anchored, plus `P04b` from the other end (the
drawer asking for the platform tier).

**Verification.** Client typecheck clean · `src/components/access/` + `src/components/admin/`
**95 passed** · full client suite **2681 passed**, the same pre-existing failures as the
baseline (`runs/[id]` flake, the builder input test that fails on `release/beta` itself,
and `workspace-placeholder`'s source-scan control — all three confirmed red at HEAD with
the change stashed) · `ui-honesty-check.sh` **239 PASS / 0 FAIL**.

⚠ **The recorded sweep is now 26 fired / 26 attempted · 0 NOT RUN · 0 MISSED** — the 20
originals with P04 re-anchored, P04b, and five for the disclosure (body always rendered,
count dropped from a closed head, hint swallowed, `aria-expanded` pinned, every band
forced open).

## ⚠ What this feature found that it was not looking for

Three real defects, none of them in the four UI changes that were asked for:

1. **`/admin/members` was super-admin-only in practice while reading otherwise** — the
   gate's second condition could never be true. Phase 1.
2. **`BulkAssignPanel`'s documented default never happened** — `useState(workspaces.map(…))`
   on a prop that arrives a render later, so the panel opened with nothing selected and a
   disabled submit button. Phase 4.
3. **`SEEN_USERS_EXPLAINER` and `SEEN_USERS_UNREADABLE` would have been orphaned** by the
   Phase 6 deletion, leaving the person picker listing the same people with no statement
   of what a row means. Caught by `ui-honesty-check.sh`, fixed in the substance.

And two mistakes of my own, both worth carrying:

- **I-62 fired on my own guard** (Phase 1) — a docblock quoting the dead gate to explain
  why it is gone trips a scan for the dead gate. Strip comments, or match a use.
- **`waitFor` on a call count is not an upper bound** (Phase 4) — it retries until the
  assertion passes, so a sequential fan-out passes through the number you were asserting.

## Open questions carried from the spec (§9)

- Whether `/organization` keeps its rail row once it only does workspace CRUD.
- Whether `me.capabilities` should exist at all — it duplicates the resolver's answer,
  and removing it touches `break-glass`, `catalogue.service` and the sidebar.

## Left open, deliberately

- **`/organization` keeps its rail row.** It still creates, renames and deletes
  workspaces, which is a real capability and the only place it lives. Whether a page that
  small deserves a rail row is a product decision, not this feature's.
- **`me.capabilities` still exists** and still duplicates the resolver's answer. Removing
  it touches `break-glass`, `catalogue.service` and the sidebar. Spec §9.
- **`LocalAccountsPanel` renders on the Members tab under a `platform.localusers.write`
  gate**, which is a platform capability sitting on a workspace-scoped tab. Defensible —
  it is where a person looking for people goes — but it is the one placement in this
  feature that mixes tiers, and it is named rather than left to be noticed.

## Not this feature's, found and left alone

- Composing a **custom platform role** still has no form (`POST /api/platform/roles`
  exists). Recorded in the RBAC feature's own notes.
- The three baseline test failures above.
