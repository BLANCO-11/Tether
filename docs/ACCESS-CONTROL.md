# Roles, access levels, and who can assign what

**What this is.** Every role this deployment has, exactly what each one can do, and who is
allowed to give it to somebody else. Written 2026-09-13, against the feature-level RBAC
work on branch `20260910-130448-feature-rbac-permissions`.

⚠ **The code is the authority, not this file.** The permission catalogue is
`packages/server/src/auth/permissions.ts`, the presets are `auth/role-presets.ts`, the
conferral is `auth/platform-conferral.ts`, and the route map is `auth/route-permissions.ts`
(**generated — do not edit**). Where this document and those files disagree, they are right
and this is stale. Counts below are transcribed from those arrays for a human reader; the
tests read `.length`.

---

## 1. The shape in one picture

There are **two tiers** and one thing above both of them.

```
  SUPER ADMIN            env allowlist, SUPER_ADMIN_EMAILS. Not a role. Cannot be
                         granted from inside the product. Acts as admin in every
                         workspace, holds every platform permission.
        │
  PLATFORM TIER          answered against a PERSON — no workspace in the question.
  platform-admin         Rows in `platform_roles`. 11 permissions exist.
  auditor
  support
  (custom)
        │
  WORKSPACE TIER         answered against a (PERSON, WORKSPACE) pair.
  admin                  Presets are CODE. 38 permissions exist.
  approver
  author
  (custom, per workspace)
```

**49 permissions total = 38 workspace + 11 platform.** They are a frozen array in code, not
a table — so no administrator can invent, rename or delete one, and no grant can name a
permission the code does not implement.

---

## 2. Workspace roles — the built-in three

Presets are **code, not rows**: they cannot be edited or deleted, on any deployment.
`admin ⊇ approver ⊇ author` is **set containment**, and it is true by construction — the
approver set is literally the author set plus four, and the admin set is the approver set
plus fifteen.

| Role | Holds | In one sentence |
| :--- | ---: | :--- |
| **author** | 19 of 38 | Builds automations and runs them. Decides nothing. |
| **approver** | 23 of 38 | Everything an author does, plus the decisions: approve a revision, arm a trigger, decide a paused step, replay a run. |
| **admin** | **38 of 38** | Everything inside the workspace, and nothing outside it. |

⚠ `admin` being the *whole* workspace catalogue is deliberate and asserted by a test. "And
nothing outside it" is the platform tier's business.

### 2.1 What each one actually carries

✅ = held. Rows are grouped by what a person would go looking for.

| Permission | What it lets you do | author | approver | admin |
| :--- | :--- | :---: | :---: | :---: |
| `flows.read` | List and open automations, revisions, steps | ✅ | ✅ | ✅ |
| `flows.write` | Create, edit, delete, import; save a draft; build one in chat | ✅ | ✅ | ✅ |
| `flows.run` | Start a draft or test run; fire a manual trigger | ✅ | ✅ | ✅ |
| `flows.approve` | Approve a revision, revoke, re-arm, recheck | | ✅ | ✅ |
| `flows.arm` | Create, enable, disable and delete triggers | | ✅ | ✅ |
| `runs.read` | Executions, step runs, run history, the email box | ✅ | ✅ | ✅ |
| `runs.replay` | Re-execute a past run, whole or in part | | ✅ | ✅ |
| `approvals.read` | See paused steps waiting on a person | ✅ | ✅ | ✅ |
| `approvals.decide` | Approve or reject a paused step | | ✅ | ✅ |
| `datasources.read` | List data sources, their schema, queries and DB operations | ✅ | ✅ | ✅ |
| `datasources.query.write` | Author named queries and DB operations | ✅ | ✅ | ✅ |
| `datasources.write` | Register/edit/delete a data source; sandbox; test a connection | | | ✅ |
| `tools.read` | List and open tool registrations | ✅ | ✅ | ✅ |
| `tools.write` | Register, edit, delete and probe a tool | | | ✅ |
| `secrets.read` | The credential **NAME** list and the collision audit | | | ✅ |
| `secrets.write` | Declare, edit, delete a credential and write its value | | | ✅ |
| `catalogue.read` | Refs, parameter descriptions, expression allowlist, caps | ✅ | ✅ | ✅ |
| `catalogue.write` | Register a catalogue item, raise an access request | ✅ | ✅ | ✅ |
| `templates.read` | List and open saved templates | ✅ | ✅ | ✅ |
| `templates.write` | Save, rename, delete a template | | | ✅ |
| `resources.read` | The resource list, detail and impact view | ✅ | ✅ | ✅ |
| `audit.read` | This workspace's audit history and its export | | | ✅ |
| `members.read` | See who is in this workspace and what they hold | ✅ | ✅ | ✅ |
| `members.grant` | **Add/remove members and change what they hold** | | | ✅ |
| `roles.write` | **Create, edit and retire custom roles here** | | | ✅ |
| `incidents.read` | Incidents raised here and their history | ✅ | ✅ | ✅ |
| `incidents.write` | Raise, update and close an incident | | | ✅ |
| `gates.read` | See which publish review gates are in force | ✅ | ✅ | ✅ |
| `gates.write` | Turn a publish review gate on or off | | | ✅ |
| `budget.read` | The concurrent-execution budget and what is using it | | | ✅ |
| `budget.write` | Change the budget (a fairness control across tenants) | | | ✅ |
| `breakglass.read` | See which break-glass sessions are active | | | ✅ |
| `breakglass.activate` | Activate or revoke a break-glass session | | | ✅ |
| `realdata.use` | Act against production rather than sandbox data | | | ✅ |
| `search.read` | Search this workspace | ✅ | ✅ | ✅ |
| `bootstrap.read` | The setup state a fresh workspace renders from | ✅ | ✅ | ✅ |
| `scenarios.read` | The worked scenarios registered here | ✅ | ✅ | ✅ |
| `steps.try` | Run a single step in isolation while building | ✅ | ✅ | ✅ |

### 2.2 Four things about that table that are not obvious

- ⚠ **No permission grants read access to a secret VALUE.** `secrets.read` is the NAME list
  and the collision audit. That is not a restraint the catalogue imposes — **there is no
  endpoint that returns a value**, and there is deliberately no `?reveal=`. If one is ever
  added it needs its own permission and its own argument; do not let it ride in on this one.
- ⚠ **`members.read` sits with `author` on purpose.** A member who cannot approve still has
  to be able to find out who can.
- ⚠ **An approver may arm.** This is a **widening** over the old role model, decided
  deliberately (spec D-4): the server's old capability table withheld it and the client's
  granted it, and the two had disagreed for months. The client's reading won.
- ⚠ **`search.read` is a floor, not a bypass.** Each kind of result is *additionally*
  filtered by the permission for that kind.
- ⚠ **`realdata.use` is enforced inside break-glass and the catalogue service, not at a
  route.** It qualifies what a call *does* rather than whether it is allowed.

### 2.3 Custom workspace roles

Any set of workspace permissions, named, scoped to **one** workspace. Stored in
`workspace_roles`; listed beside the three presets, which are marked `builtin: true` and
have no id.

**A custom role can never carry a permission its author does not hold** — the refusal is
`role_exceeds_granter` (403) and it names the offending permission and nothing about what
the caller holds. A 403 is the last place to publish a capability list.

**A workspace role can never carry a `platform.*` permission.** Refused in the service so
the message can explain, and again by a CHECK constraint generated from the catalogue. A
workspace role granting a deployment-wide permission would be privilege escalation by role
authoring.

---

## 3. Platform roles

Rows in `platform_roles`. Answered against a **person**, with no workspace in the question.
The three below ship with `builtin: true` and **cannot be edited or deleted**.

| Role | Holds | For |
| :--- | ---: | :--- |
| **platform-admin** | **11 of 11** | Runs the deployment. |
| **support** | 4 | Reads who exists, the audit record, the tool layer and the system signals. Changes nothing. |
| **auditor** | 1 | Reads the audit record across every workspace, and nothing else. |

| Permission | What it lets you do | platform-admin | support | auditor |
| :--- | :--- | :---: | :---: | :---: |
| `platform.workspaces.write` | Create, rename, delete a workspace anywhere | ✅ | | |
| `platform.members.grant` | **Add/remove members in EVERY workspace** | ✅ | | |
| `platform.users.read` | The list of identities that have presented a verified token | ✅ | ✅ | |
| `platform.roles.write` | Compose platform roles and assign them | ✅ | | |
| `platform.generation.write` | Change the model that **drafts** automations | ✅ | | |
| `platform.audit.read` | Audit history across every workspace, in one time order | ✅ | ✅ | ✅ |
| `platform.localusers.write` | Create, edit, disable, delete **local** credential accounts | ✅ | | |
| `platform.ops.read` | The outbox, the call log, the tool layer's status | ✅ | ✅ | |
| `platform.toolmodel.read` | The provider/model behind the `llm_complete` **tool** | ✅ | | |
| `platform.toolmodel.write` | Change it, and test one | ✅ | | |
| `platform.signals.read` | The four silent-failure signals | ✅ | ✅ | |

- ⚠ **`platform.generation.write` and `platform.toolmodel.write` are two different
  settings** and are deliberately two different permissions. One is what drafts an
  automation; the other is what the `llm_complete` tool calls. This has confused a user
  twice. A single permission over both would merge them at the authorisation layer.
- ⚠ **`support` deliberately does NOT hold `platform.toolmodel.*`.** Support reads; it does
  not change what the deployment generates or calls models with.
- ⚠ **`platform.audit.read` confers nothing inside a workspace.** Its holder reads the
  record, not the data the record is about.

### 3.1 The one conferral — and the sentence to use about it

`platform.members.grant` confers, in **every** workspace, exactly:

```
members.read   +   members.grant        ← and nothing else
```

It exists because without it a platform administrator could **create** a workspace and then
not put anybody into it, including themselves — they had to go back to a
`SUPER_ADMIN_EMAILS` holder to make their own new workspace usable.

The bound is the number **two**, asserted as a **set equality** (a subset assertion passes
while somebody adds `flows.read`) and, from the other end, by `rbac:platform-verify`
requiring a platform admin to reach **exactly 11** workspace-scoped routes rather than "at
least".

> ⚠ **A platform administrator cannot see a tenant's data, but can give themselves the
> ability to, and doing so leaves an audit entry naming them.**

**Never** the unqualified *"a platform admin cannot access tenant data"* — it is false.
Opening a tenant's automations requires **first** granting themselves a workspace role, and
that grant is a write on the record: actor, subject, before, after, time.

⚠ **None of this is separation of duties.** Anything holding `RUNTIME_JWT_SECRET` mints any
identity it likes.

---

## 4. Super admin — the un-grantable root

Not a role and not a row. `SUPER_ADMIN_EMAILS` on the API server, comma-separated, matched
on identity **subject or email** (email case-insensitively).

- Acts as **admin in every workspace**, member or not — and that check runs **before** the
  member list is read, which is what makes a memberless workspace assignable at all.
- Holds every platform permission.
- ⚠ **There is no code path from a row to super admin.** No `platform.superadmin` permission
  exists, and `config.isSuperAdmin` reads the environment and nothing else. The allowlist is
  the one authority in the product that **cannot be handed out from inside the product** —
  which is precisely why every other authority can be.
- Changing it means editing the environment on the API server and restarting. There is no
  screen for it, by design.

⚠ **An access grant only.** The accountability gates downstream still apply separately.

⚠ **`SUPER_ADMIN_EMAILS` is load-bearing and is no longer optional.** With `POST
…/members/claim` deleted, an empty allowlist means **no workspace can be created and no
memberless workspace can ever get a member**. This deployment currently has **zero members
across eight workspaces**, so on day one every workspace refuses every non-super-admin.
Accepted rather than fixed (spec D-5).

---

## 5. Who can assign what to whom

### 5.1 Workspace membership

| Act | Needs | So, in practice |
| :--- | :--- | :--- |
| See who is in a workspace | `members.read` | any **author**, **approver** or **admin** of it; a **platform-admin**; a super admin |
| Add a member / change their role | `members.grant` | a workspace **admin**; a custom role carrying it; a **platform-admin** (conferred); a super admin |
| Remove a member | `members.grant` | same |
| Put a **local account** in a workspace | `platform.members.grant` | a **platform-admin**; a super admin |
| Create, disable or reset a **local account** | `platform.localusers.write` | a **platform-admin**; a super admin |

⚠ **Those last two are DIFFERENT permissions and the split is deliberate.** Making an
account exist is `platform.localusers.write`; deciding which workspaces it may enter is
`platform.members.grant` — the same permission that puts anybody else in a workspace. One
permission covering both would mean whoever can create accounts can also place them
anywhere, which is the escalation the split exists to refuse.

**The rules that bite:**

- ⚠ **You cannot grant a role carrying a permission you do not hold.** Checked on create,
  on edit, and again **at assignment time** against the granter's effective permissions in
  that workspace. 403, `role_exceeds_granter`.
- ⚠ **The last admin of a workspace cannot be demoted or removed.** 409. A workspace with
  members and no admin can never grant again, and the only repair is a database edit.
  - **A super admin is exempt**, and that exemption was **measured, not reasoned**: with the
    refusal absolute, a super admin assigned the wrong person as a workspace's only member
    and **could not take it back**. An irreversible mis-assignment is worse than the state
    the refusal protects.
  - ⚠ **A platform administrator is NOT exempt** (INV-20). There is always an allowlist
    holder above them, so for them the refusal is recoverable. A platform admin who hits it
    escalates.
  - The exemption is set by the route from the verified identity — **never accepted from a
    request body**, which would make it something a caller could assert.

### 5.2 Composing and handing out **workspace** roles

| Act | Needs |
| :--- | :--- |
| List the roles available here | `members.read` |
| Create / edit / retire a custom role | `roles.write` — **admin** only, among the built-ins |
| Give a person a custom role | `members.grant` **and** `assertGrantable` against the role's permissions |
| Edit a preset (`author`/`approver`/`admin`) | **Nobody.** They are code. |

### 5.3 Composing and handing out **platform** roles

| Act | Needs | So, in practice |
| :--- | :--- | :--- |
| Read the people list / role list / assignments | `platform.users.read` | platform-admin, **support**, super admin |
| Create / edit / retire a platform role | `platform.roles.write` | platform-admin, super admin |
| Assign a platform role to a person | `platform.members.grant` | platform-admin, super admin |
| Unassign one | `platform.members.grant` | platform-admin, super admin |
| Edit a built-in (`platform-admin`/`auditor`/`support`) | **Nobody.** |

- ⚠ **The same FR-009 rule applies here**: you cannot put a platform permission into a role,
  or assign a role carrying one, that you do not yourself hold.
- ⚠ **The last `platform-admin` cannot be unassigned** except by somebody on
  `SUPER_ADMIN_EMAILS`. 409, `last_platform_admin`. If no super admin is configured, the
  refusal says so and names the variable.
- ⚠ **A platform role may only carry `platform.*` permissions.** Naming a workspace
  permission here would be a second route to conferral, and `PLATFORM_CONFERS` — the single,
  audited, two-entry map — is the entire bound on that cost.

### 5.4 The full escalation picture, in one table

Read this as *"X can give Y"*.

| Who | Can hand out |
| :--- | :--- |
| **author** | nothing |
| **approver** | nothing |
| **workspace admin** | membership and custom roles **in their own workspace**, up to and including `admin` — but never a permission they do not hold, and never the last admin seat away from itself |
| **support** / **auditor** | nothing |
| **platform-admin** | membership in **every** workspace; platform roles; local accounts. **Not** super admin. |
| **super admin** | everything above. **Not** super admin — that is the environment's to give. |

---

## 6. Three things this document is careful not to claim

- **None of this is separation of duties.** Anything holding `RUNTIME_JWT_SECRET` can mint
  any identity, and a minted identity with an approver row approves. The controls here
  decide *who may do what given a verified identity*; they say nothing about whether the
  identity is genuine.
- **Hiding is never enforcement.** The client has `Can`, `useCan`, `useCanPlatform` and
  `PermissionGate`. ⚠ **`useCanPlatform` is a SEPARATE HOOK, not a flag on `useCan`, and
  the reason is a bug this repo hit twice.** `data.permissions` is the workspace-tier union
  for one workspace, and a platform permission is never in it — so
  `useCan("platform.users.read")` answers **denied for a super admin holding all eleven**,
  hiding a control from exactly the person entitled to use it. A separate hook makes the
  wrong one a different call rather than a forgotten argument; an optional input is how one
  consumer silently gets a different answer from another.
  - ⚠ **Affordance gating is applied to the access surface and to nothing else.** Measured
    2026-09-13: **one page** (`/admin/members`) and **seven components** read a permission,
    and all eight are this surface — out of **35** pages under `app/(app)`. Every other
    page relies on the server refusing. That is correct and it is not the same as an
    affordance that matches what a person can actually do.
    `grep -rln 'useCan(\|useCanPlatform(\|PermissionGate\|<Can ' packages/client/src`
    is the count; the number above will go stale and the command will not.
- ⚠ **And the converse bit once already: enforced is not the same as reachable.** A
  capability can be completely correct server-side and still exist for nobody, because
  nothing in the product reaches it. The platform tier was in exactly that state for a
  whole feature — *the server being right is what made it invisible*, since every test
  passed and every route refused correctly while the roles had no holders, because nobody
  could create one. §7 is the record of where each grant is actually made.

---

## 7. Where each of these is done in the UI

⚠ **Until 2026-09-13 the answer for most of this table was "nowhere".** The platform tier
was seeded, enforced and measured, its four client methods existed, and **nothing called
them** — so the only roles appointable through the product were the three workspace
presets, and a composed custom role could be created and given to nobody. That is this
repo's own recorded failure: *a field only a seed script can write is a field the product
does not have.* Both gaps are closed; the table says where.

⚠ **AND THE TABLE MOVED AGAIN ON THE SAME DAY.** The three surfaces first landed as
`/organization` plus two pages reached from it; they are now **three tabs on one page**,
`/admin/members`, which is the row the sidebar actually offers. The two standalone pages
were **deleted rather than unlinked** — for exactly the reason in the paragraph above: a
page with no door is a page the product does not have, and leaving them alive with nothing
linking to them would have re-created the defect a week after it was closed.

| Act | Where |
| :--- | :--- |
| Put somebody in a workspace with a preset role | `/admin/members` → **Members** → click them |
| Assign one person to several workspaces at once | `/admin/members` → **Members** → Assign across workspaces |
| Compose or retire a custom workspace role | `/admin/members?tab=roles` |
| **Give somebody a custom workspace role** | `/admin/members?tab=roles` → the role's own holder list |
| **Assign or remove a platform role** | `/admin/members?tab=platform` |
| Create a local account | `/admin/members` → **Members** → Local accounts |
| Create, rename or delete a workspace | `/organization` |
| Compose a *custom* platform role | ⚠ **Nowhere yet** — the route exists, the form does not |
| Change who is a super admin | ⚠ **Nowhere, by design** — `SUPER_ADMIN_EMAILS` on the API server |

⚠ **WHO CAN REACH THAT PAGE AT ALL, and it changed on 2026-09-13.** It was gated on
`!superAdmin && !capabilities.includes("admin")` — which reads as *"a super admin OR a
workspace admin"* and is not, because `me.capabilities` carries **permission keys**
(`CAPABILITIES = WORKSPACE_PERMISSIONS`) and migration `0065` **dropped** the `admin`
capability. The second half could never be true, so the page was **super-admin-only in
practice while reading otherwise**, and a workspace administrator holding all 38
permissions was refused. It is `members.read` now.

| On `/admin/members` | Needs |
| :--- | :--- |
| Reach the page at all | any one of `members.read`, `members.grant`, `platform.localusers.write` |
| See the members table, open the drawer | `members.read` |
| The role dropdown, Save, Remove, Invite, the permission checkboxes | `members.grant` |
| The **Roles** tab's compose / retire | `roles.write` |
| The **Platform** tab being offered | `platform.users.read` |
| Assigning a platform role on it | `platform.members.grant` |
| Local accounts | `platform.localusers.write` |

⚠ **An `approver` can see the members table and change nothing on it** — the read and the
write are separate permissions, so the drawer opens and its controls are **disabled with
the permission named** rather than hidden. A hidden control is indistinguishable from one
that does not exist, which leaves the person nothing to ask for and nobody to ask.

⚠ **The page refuses outright only when all three of those are denied.** Refusing on
`members.read` alone would hide local-account creation — a *platform* capability with
nothing to do with the active workspace — from somebody entitled to it, which is the same
mistake as asking the workspace question about a platform permission.

⚠ **A custom workspace role is held ALONGSIDE the preset, never instead of it** — which is
why it is granted from the role's own holder list and not as a fourth option in the member
drawer's dropdown. That dropdown writes `workspace_members.role`; the holder list writes
`workspace_role_assignments`. Merging them would make a person given a custom role appear
to have lost their preset, and the obvious "fix" would silently remove the custom role.

⚠ **THE MEMBER DRAWER SHOWS NO PLATFORM ROLE AND NO `platform.*` PERMISSION** (INV-9). It
is one person's access to ONE workspace; a platform role is held against the deployment
and is the same in every workspace, so showing it there would say once per workspace that
somebody's platform access is a property of this workspace — and the controls beside it are
writable, so it would read as something that form can change. Holders of a platform role
are on the Platform tab.

⚠ **THE PLATFORM TAB IS GATED ON A PLATFORM PERMISSION, AND THAT IS NOT A DETAIL.** The
workspace-tier union never contains a platform permission, so asking the workspace question
(`can("platform.users.read")`) answers **denied for a super admin holding all eleven** —
hiding the tab from exactly the person who administers the deployment. There is a separate
`canPlatform`, and the tab has three states: shown · absent · shown-with-a-caveat when the
check could not run.

⚠ **`/organization` IS ABOUT WORKSPACES ONLY NOW.** Its members panel and its "People who
have signed in" panel are deleted. The second of those assigned somebody as `admin` in
**one click**; its replacement asks for the person, the role and the workspaces — one step
more, and a better default, because the old panel made everybody an administrator whether
or not anybody meant it.

---

## 8. Checking any of this at the wire

```bash
pnpm --filter @foundry/server rbac:verify           # every workspace route × 4 probes, with the control
pnpm --filter @foundry/server rbac:platform-verify  # auditor, support and platform-admin, measured
pnpm --filter @foundry/server rbac:backfill         # DRY RUN by default; --apply writes
```

⚠ `rbac:verify`'s third probe — **an admin of the workspace is PERMITTED** — is the one that
makes the other three mean anything. Without it, "refuse everything" scores 100%.
