---
feature: admin-members-consolidation
created: 2026-09-13
status: SPEC — nothing implemented
mock: ./mock.html
---

# One page for people and access

`/admin/members` becomes the single place where people, roles and platform access are
managed. `/organization` goes back to being about **workspaces** and nothing else.

⚠ **NOTHING IN THIS SPEC IS BUILT.** The mock beside it is a static HTML sketch, not a
component. Read the mock first; this document is the reasoning behind it and the list of
what actually has to move.

---

## 1. Why

Four surfaces answer the question *"who can do what"* and they are on two pages:

| Today | Where |
| :--- | :--- |
| Workspace members + capability editor | `/admin/members` |
| Local accounts | `/admin/members` |
| Assign across workspaces | `/admin/members` |
| **Workspace members (a second panel)** | `/organization` |
| **People who have signed in** | `/organization` |
| Custom workspace roles | `/organization/roles` |
| Platform roles | `/organization/platform-roles` |

Two of those are duplicates and two are links off a page about workspaces. A person
looking for "who has access" has to know which of two pages to open, and `/organization`
— a page whose header says *"Each workspace has its own credentials, data sources and
automations"* — is carrying half the access model.

After this change: **`/admin/members` answers every access question; `/organization`
creates, renames and deletes workspaces.**

---

## 2. What changes

### 2.1 `/admin/members` gains three tabs

```
┌ Members ┬ Roles & permissions ┬ Platform roles ┐
```

| Tab | Holds | Scope |
| :--- | :--- | :--- |
| **Members** | the workspace member table · Local accounts · Assign across workspaces | the active workspace, except local accounts (deployment) |
| **Roles & permissions** | custom workspace roles, their permissions, and who holds each | the active workspace |
| **Platform roles** | platform roles, their permissions, and who holds each | the deployment |

**D-1 — the tab is in the URL** (`?tab=roles`, `?tab=platform`). A tab that lives only in
React state cannot be linked to, cannot be reloaded into, and cannot be covered by
`routes.smoke.test.tsx`, which walks paths. Default (absent or unrecognised) is
**Members**.

**D-2 — the two standalone pages are DELETED, not left unlinked.**
`app/(app)/organization/roles/` and `app/(app)/organization/platform-roles/` go; their
bodies move to `components/access/WorkspaceRolesPanel.tsx` and
`components/access/PlatformRolesPanel.tsx`, which the tabs render.

> ⚠ A page with no door is the defect closed on 2026-09-13 — the platform tier was
> seeded, enforced and measured while being unreachable. Keeping these two routes alive
> with nothing linking to them would re-create exactly that, one week later. If a
> bookmarked URL ever matters they come back as redirects, not as pages.

### 2.2 `/organization` loses four things

- the **Roles and permissions** link
- the **Platform roles** link
- the **Members** panel (`components/workspace/MembersPanel.tsx`)
- the **People who have signed in** panel (`components/workspace/PlatformUsersPanel.tsx`)

What remains: the workspace list, create, rename, delete, and the four access states
(super admin · not one · none configured · **could not be checked**).

⚠ **All four states stay.** The page is still super-admin gated and the gate is still not
the control — every mutating route refuses server-side. Removing panels must not remove
the sentence that distinguishes *"you may not"* from *"we could not find out"*.

### 2.3 Clicking a member opens a drawer, not a side column

The capability editor currently sits in a permanent 420px column beside the table, whether
or not anybody is selected. It becomes a **right-side drawer**, opened by clicking a row.

It holds, for the selected person:

- their **role**, as a dropdown (`author` · `approver` · `admin` · any custom role they
  could be moved to — see INV-3)
- **every access they hold**, each labelled with where it comes from
- the last-admin warning, unchanged
- Save

**D-3 — a drawer, not a modal.** The table stays visible behind it, so the person can see
which row they opened. Escape and a backdrop click close it.

### 2.4 Workspace selection becomes a multi-select dropdown

"Assign across workspaces" keeps the fan-out — one person, one role, **several**
workspaces — and trades eight checkboxes for one control that reads `3 of 8 selected` and
opens to a ticked list with **Select all**.

⚠ **NOT a single-select.** A single-select would delete the panel's only reason to exist:
it would then do what the member table above it already does, one workspace at a time, and
one of the two should be removed rather than left as a quieter duplicate. Asked and
answered 2026-09-13.

⚠ **Everything else about the panel is unchanged, including that it is NOT atomic.** Each
workspace is assigned independently, a failure in one does not undo the others, and the
per-workspace result list stays. A partial success rendered as one green tick is the lie
that panel exists to prevent.

---

## 3. Invariants — the things that must still be true afterwards

| | |
| :--- | :--- |
| **INV-1** | **The Platform roles tab is gated on `platform.users.read`, through `canPlatform`.** After §7 the page admits anybody with `members.read`, so a workspace admin who is not a platform user reaches it. Offering them a tab whose every read 403s is an affordance that does not match. ⚠ **`useCan` cannot answer this** — a platform permission is never in the workspace union, so `useCan("platform.users.read")` is `denied` for a super admin holding all eleven. |
| **INV-2** | **Three states on every tab and every read.** Allowed · denied · **unreadable**. "The check did not run" must never render as "there are none" or as "you may not". This already holds in the two pages being moved and must survive the move. |
| **INV-3** | **A custom role is ADDITIVE and the drawer must not say otherwise.** The role dropdown writes `workspace_members.role` — one preset. Custom roles are held *alongside* it and are granted from the Roles tab's holder list, which writes `workspace_role_assignments`. ⚠ The drawer may **show** custom roles a person holds; it must not offer them *in the preset dropdown*, or granting one would appear to remove their preset. |
| **INV-4** | **Hiding is never the enforcement.** Every route behind every tab refuses independently. Tabs decide what is *offered*. |
| **INV-5** | **No capability is lost in the move.** Everything `/organization`'s two panels could do must be reachable on `/admin/members` — see §4 for the one place this is not a straight swap. |
| **INV-6** | **The role-is-not-identity sentence survives.** *"A role decides what someone may do here; it is not proof of who they are…"* — it is on the member table's footer today and must not be dropped in the re-layout. |
| **INV-7** | **`<Page measure>` owns width; no page sets its own.** `ui-honesty-check.sh` fails on a `max-w-` anywhere in a page file. |
| **INV-8** | **Every page has an `alpha-registry` entry and the entry must be TRUE.** Two entries are deleted with their pages; `/admin/members`'s is rewritten to cover what it now holds. ⚠ An entry claiming something under `soon` that has been built is a live falsehood — this bit once already on 2026-09-13. |
| **INV-9** | **The drawer renders no platform permission and no platform role.** Platform holders are shown on the Platform roles tab only — see §8. |

---

## 4. ⚠ The one real behaviour change, stated rather than buried

**"People who have signed in" assigns with ONE CLICK as `admin` to the active workspace.**
Its replacement — the person picker inside Assign across workspaces — takes three choices:
person, role, workspace(s).

That is **one step more** and it is the better default: the current panel hardcodes
`const ASSIGN_ROLE: WorkspaceRole = "admin"`, so every person added through it becomes a
workspace administrator whether or not anybody meant that. The replacement makes the role
a decision instead of an assumption.

⚠ **It is still a loss of speed, and if the one-click path is wanted it should be added
back deliberately** — as "Add to this workspace as…" with a role picker, not as a button
that picks `admin` silently.

---

## 5. Files

### Deleted
```
app/(app)/organization/roles/page.tsx
app/(app)/organization/platform-roles/page.tsx
app/(app)/organization/platform-roles/page.test.tsx
components/workspace/MembersPanel.tsx              ⚠ the /organization one, not admin/
components/workspace/MembersPanel.test.tsx
components/workspace/PlatformUsersPanel.tsx
components/workspace/PlatformUsersPanel.test.tsx
```

⚠ **There are two files called `MembersPanel.tsx`.** `components/admin/` is the one that
stays and grows a drawer; `components/workspace/` is the duplicate that goes. Deleting the
wrong one removes the surface this feature is built around.

### Created
```
components/access/WorkspaceRolesPanel.tsx      ← the body of /organization/roles
components/access/PlatformRolesPanel.tsx       ← the body of /organization/platform-roles
components/access/PlatformRolesPanel.test.tsx  ← the existing page test, repointed
components/admin/MemberDrawer.tsx              ← the capability editor, as a drawer
components/admin/MemberDrawer.test.tsx
components/ui/MultiSelect.tsx                  ← the workspace picker
components/ui/MultiSelect.test.tsx
components/admin/MemberTabs.test.tsx           ← tab routing + INV-1 gating
```

### Modified
```
app/(app)/admin/members/page.tsx     tabs, ?tab= state, the three panels, AND the
                                     dead `capabilities.includes("admin")` gate replaced
                                     by `useCan("members.read")` — see §7
app/(app)/organization/page.tsx      four removals; the four states stay
components/admin/MembersPanel.tsx    the aside becomes the drawer; table keeps the footer
components/admin/BulkAssignPanel.tsx checkboxes → MultiSelect
app/routes.smoke.test.tsx            drop 2 paths, add the 3 tab URLs
lib/alpha-registry.ts                drop 2 entries, rewrite /admin/members'
app/(app)/organization/page.test.tsx the "doors" block goes; the 4 states stay
```

---

## 6. Acceptance

| # | Check |
| :--- | :--- |
| A-1 | `/admin/members` shows three tabs; `?tab=roles` and `?tab=platform` deep-link; an unrecognised value falls back to Members without erroring |
| A-2 | The Platform roles tab is **absent** for a caller without `platform.users.read`, **present** for a super admin, and **present with a caveat** when the check could not run |
| A-3 | Clicking a member opens the drawer with their role and accesses; Escape closes it; no member selected renders **no** empty column |
| A-4 | The role dropdown saves, and the last-admin warning still appears for the sole admin |
| A-5 | Assign across workspaces submits to every selected workspace, reports each separately, and still says it is not atomic |
| A-6 | `/organization` has no members panel, no signed-in panel and no role links, and still has all four access states |
| A-7 | `ui-honesty-check.sh` ≥ 239 PASS / 0 FAIL |
| A-8 | Client suite: no new failures against the 2 baseline ones |
| A-9 | Every new control proven by **perturbation** — remove it, watch a test go red |

---

## 7. ⚠ The page gate is a DEAD BRANCH, and this feature cannot ship without fixing it

Resolved 2026-09-13: **remove the old capabilities model here; gate on the permission
catalogue.** It is not a tidy-up — the current check cannot succeed, and this feature
turns that from cosmetic into a capability loss.

`app/(app)/admin/members/page.tsx` refuses with:

```ts
if (!me.data.superAdmin && !me.data.capabilities?.includes("admin")) { /* refuse */ }
```

⚠ **`capabilities.includes("admin")` IS ALWAYS FALSE.** `capabilities` no longer carries
the seven invented strings — `CAPABILITIES = WORKSPACE_PERMISSIONS` and `getCapabilities`
delegates to the resolver, so the array holds **permission keys**. And `admin` is not one
of them: migration `0065` **DROPPED** `admin` and `platform-admin` outright (INV-10 — they
were *"roles wearing a capability's clothes"*). `Sidebar.tsx` had this exact read removed
by RBAC T092b; **this page was missed.**

So `/admin/members` is **super-admin-only in practice** while reading as though a workspace
admin can get in.

⚠ **Today that is latent. After §2.2 it is a regression.** This feature deletes
`/organization`'s member panel — the other place membership is managed. A workspace admin
who legitimately holds `members.grant` would be left with **nowhere at all** to manage
their own workspace's members. Fixing the gate is what stops this refactor taking a
capability away.

### D-4 — the page admits `members.read`; every control gates on its own permission

| Surface | Gate |
| :--- | :--- |
| the page itself | `members.read` — the floor to see anything here |
| member table, the drawer's read | `members.read` |
| role dropdown, Save, Assign across workspaces | `members.grant` |
| Roles tab — compose / retire | `roles.write` |
| Roles tab — holder add / remove | `members.grant` |
| Local accounts | `platform.localusers.write` |
| Platform roles tab | `platform.users.read` (via `canPlatform`) |

⚠ **`superAdmin` needs no special case anywhere in that table.** The resolver
short-circuits an allowlist holder to every permission in both tiers, so `useCan` and
`canPlatform` already answer `allowed` for them. Adding `|| me.superAdmin` beside a
permission check would be a second authority that can disagree with the first — which is
the whole defect this feature's parent was written to end.

⚠ **The four access states stay**, re-expressed: allowed · denied · **unreadable** ·
no-workspace-selected. `useCan` returns exactly the first three; *"the check did not run"*
must keep its own sentence and must not collapse into the refusal.

---

## 8. ⚠ The drawer shows NO platform roles

Resolved 2026-09-13. The member drawer lists **workspace** access only — the role preset,
what that preset carries, and anything granted on top. **People holding a platform role are
visible on the Platform roles tab and nowhere else.**

This closes open question 3 with a *no*, and the reason is worth keeping:

- A drawer is opened from **this workspace's** member table. A platform role is not held in
  a workspace; showing it there invites the reading that it was granted *here* and can be
  changed *here*, and neither is true.
- It would put a deployment-wide fact on a tenant-scoped screen, for a person who may hold
  `members.read` in one workspace and nothing at the platform tier.
- The drawer would then have two things called "role" meaning different things, one of them
  not editable from the control beside it.

⚠ **The one thing this costs, stated:** the drawer cannot answer *"why can this person see
every workspace?"*. The Platform roles tab answers it, one click away, and the honest fix
if that proves annoying is a **link** to that tab — never a copy of the fact in the drawer.

⚠ **INV-9 — no platform permission is rendered in the drawer.** A test asserts the drawer
shows no `platform.*` key and no platform role name, with a control proving the assertion
can find a permission key at all.

---

## 9. Still open, and deliberately not decided here

1. **Does `/organization` still deserve its own rail row** once it only does workspace
   CRUD? It keeps its row.
2. **Whether `me.capabilities` should exist at all.** It is now a duplicate of the
   resolver's answer, served on a different key, and `/api/workspaces/:ws/me/permissions`
   is the one this feature reads. Removing it touches `break-glass`, `catalogue.service`
   and the sidebar — **out of scope**, recorded so the next person finds it written down
   rather than discovering a third reader.
