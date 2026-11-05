# Phase 1 — Data Model

**Feature**: Feature-level RBAC · **Branch**: `20260910-130448-feature-rbac-permissions`
**Date**: 2026-09-10 · ⚠ **RE-BASELINED 2026-09-12**

Five new tables, one altered, two untouched. ⚠ **Migrations `0062`–`0065`**, `when` values
above the **`1789100000000`** watermark (research M-4).

⚠ **RENUMBERED 2026-09-12.** This file said `0061`–`0064` above `1789000000000`.
`0061_flow_chat_config` has since landed and took `1789100000000` — the exact value the
plan assigned to its own `0061`. The filename would have collided and the first `when`
would have duplicated an applied one.

---

## 1. The permission catalogue — CODE, not a table

`packages/server/src/auth/permissions.ts`. A frozen array plus a derived union type.
There is deliberately **no `permissions` table**: FR-001 requires that no administrator
can invent, rename or delete a permission, and a table makes all three possible. It
would also allow a row referencing a permission the code does not implement.

Naming is `<domain>.<action>`, lower-case, dot-separated. Read is always separate from
write, because "can see the credential list" and "can add a credential" are the two
questions administrators actually ask apart.

| Permission | Governs |
| :--- | :--- |
| `flows.read` | List and read automations, revisions, steps, positions, phases, flags |
| `flows.write` | Create, edit, delete, save a draft, import, generate, refine, chat |
| `flows.run` | Draft/test runs, replay, fire a manual trigger |
| `flows.approve` | Approve a revision, revoke an approval, recheck |
| `flows.arm` | Create, enable, disable and delete triggers |
| `runs.read` | Executions, step runs, run history, the email box |
| `runs.replay` | Replay a past execution |
| `approvals.read` | The pending-approval inbox and one approval's detail |
| `approvals.decide` | Decide a paused step (gate 3) |
| `datasources.read` | List datasources, read schema, read named queries and DB operations |
| `datasources.write` | Register, edit, delete a datasource; refresh schema; sandbox |
| `datasources.query.write` | Create, edit, delete named queries and DB operations |
| `tools.read` | List and read tool registrations |
| `tools.write` | Register, edit, delete, probe a tool |
| `secrets.read` | The secret NAME list and the collision audit. Never a value — no permission grants a value, because no endpoint returns one |
| `secrets.write` | Declare, edit, delete a secret; write a credential |
| `catalogue.read` | The callable catalogue the builder reads |
| `catalogue.write` | Register a catalogue item, raise an access request |
| `templates.read` / `templates.write` | Workspace flow templates |
| `resources.read` | The unified resource list |
| `audit.read` | Workspace audit history and its export |
| `members.read` | See who is in this workspace and what they hold |
| `members.grant` | Assign and remove members and roles |
| `roles.write` | Create, edit, retire custom roles |
| `incidents.read` / `incidents.write` | Incidents and their lifecycle |
| `gates.read` / `gates.write` | Publish review gates — ⚠ **new with `beta-1.1.0`** |
| `budget.read` / `budget.write` | The workspace's M3 concurrency budget — ⚠ **new with `beta-1.1.0`** |
| `breakglass.read` | See the active break-glass sessions — ⚠ **new, see below** |
| `breakglass.activate` | Activate or revoke a break-glass session |
| `realdata.use` | Act against production rather than sandbox data |
| `search.read` · `bootstrap.read` · `scenarios.read` · `steps.try` | The remaining scoped reads |

**Platform-tier permissions** live in the same catalogue under a `platform.` prefix, so
one name space answers "what is this string" everywhere:

`platform.workspaces.write` · `platform.members.grant` · `platform.users.read` ·
`platform.roles.write` · `platform.generation.write` · `platform.audit.read` ·
`platform.localusers.write` · ⚠ `platform.ops.read` · `platform.toolmodel.read` ·
`platform.toolmodel.write` · `platform.signals.read`

⚠ **FOUR PLATFORM PERMISSIONS ADDED 2026-09-12, and each closes a wrong assignment in the
route map.** The hand-written map gave `ops-proxy.ts`'s ten handlers and `signals.ts`'s one
a single `platform.audit.read`. Six of those ten are outbox and status reads
(`platform.ops.read`); **four are the `llm_complete` tool-model setting**
(`platform.toolmodel.read|write`), which D-115 keeps deliberately separate from the
generation model and which has confused a user twice — merging them at the authorisation
layer would undo that separation. `signals.ts` answers *"is the system still doing its
job"*, not audit history, and is read by a scheduler, so it gets `platform.signals.read`.

⚠ **`breakglass.read` is added for the same class of reason.** The map gave all three
break-glass handlers `breakglass.activate`, which gates a **read** (`GET /break-glass/active`)
behind an **activation** permission. It sits in the `admin` preset and nowhere else, so
effective access is byte-identical to today's `requireWorkspaceRole("admin")`; what changes
is that the name stops lying.

**Catalogue size: 38 workspace + 11 platform = 49 named permissions.**

⚠ **FOUR MORE ARRIVED ON 2026-09-13, FROM THE PRODUCT RATHER THAN FROM THIS SPEC.** A merge
from `release/beta` landed `beta-1.1.0` — *"admin section goes real: capability grants,
incident lifecycle, break-glass activation, gate toggles, budget routes, admin overview"* —
adding **ten workspace-scoped routes**, all already guarded. `gates.read`/`gates.write` and
`budget.read`/`budget.write` are theirs. Regenerating the route map cost one command; the
hand-written version would have been wrong for the third time in four days.

Of the 38 workspace permissions, **36** guard an existing route; `roles.write` guards the
custom-role routes this feature adds, and `realdata.use` is enforced **inside**
`break-glass.ts` and `catalogue.service.ts` rather than at a route. Of the 11 platform
permissions, **9** guard an existing route and `platform.roles.write` /
`platform.audit.read` guard the platform-tier routes this feature adds. The completeness
check tests **routes against the catalogue, never the catalogue against routes** — a
permission with no route is legal, a route with no permission is not.

### Invariants

- **INV-1**: the catalogue is frozen at module load; nothing mutates it at runtime.
- **INV-2**: every string stored in `workspace_member_capabilities.capability`,
  `workspace_role_permissions.permission` and `platform_roles`' permission list is a
  member of the catalogue. Enforced by a CHECK generated from the catalogue and by a
  test that fails if the two drift (this is the `FOUNDRY_EMITS` idiom — the number is
  read from the array by a test, never written down twice).
- **INV-3**: no permission grants read access to a secret **value**. There is no
  endpoint that returns one and this feature adds none.

---

## 2. Built-in role presets — CODE, not rows

`packages/server/src/auth/role-presets.ts`. Not editable, not deletable (FR-007).

Three presets. ⚠ **They are now enumerated, not described.** The original table read
`author` = "all `*.read`", which was under-specified in three directions and contradicted
the `admin` row that re-listed `secrets.read`, `members.read` and `breakglass.read` as
things admin *adds*. Two decisions on 2026-09-13 (**D-7**, **D-8** in spec.md) settle it.

| Preset | Count | Permissions |
| :--- | ---: | :--- |
| `author` | **19** | `approvals.read` `bootstrap.read` `catalogue.read` `catalogue.write` `datasources.query.write` `datasources.read` `flows.read` `flows.run` `flows.write` `gates.read` `incidents.read` `members.read` `resources.read` `runs.read` `scenarios.read` `search.read` `steps.try` `templates.read` `tools.read` |
| `approver` | **23** | `author` + `approvals.decide` `flows.approve` `flows.arm` `runs.replay` |
| `admin` | **38** | `approver` + `audit.read` `breakglass.activate` `breakglass.read` `budget.read` `budget.write` `datasources.write` `gates.write` `incidents.write` `members.grant` `realdata.use` `roles.write` `secrets.read` `secrets.write` `templates.write` `tools.write` |

`admin` is the **whole** workspace catalogue — 38 of 38. That is deliberate and asserted:
an administrator of a workspace can do everything inside it and nothing outside it.

⚠ **D-8 — `author` does NOT get every read.** Three sensitive reads sit with `admin`
instead: **`secrets.read`** (the credential-name list), **`audit.read`** (the workspace
audit history) and **`breakglass.read`** (active emergency-access sessions). `budget.read`
likewise. `members.read` **stays with `author`** — it is the one read in this group with a
real answer today (`requireWorkspaceRole("author")`), and a member who cannot approve still
has to be able to see who can. **Nothing is taken from anybody**: the secrets and audit
routes are among the 106 that carry no guard at all today, so there is no behaviour to
carry forward and this is a free choice, not a narrowing.

⚠ **D-7 — `runs.replay` is on `approver`, and before this it was on NOBODY.** It appears in
the catalogue and appeared in no preset, so `POST /flow-executions/:id/replay` would have
been unreachable through every built-in role — a capability the product has, that only a
custom role could grant. A replay re-executes a past run against real datasources and
re-applies its effects, which is nearer to arming than to authoring; `author` keeps
`flows.run` for draft and test runs.

⚠ **THE `approver` ROW CARRIES A BEHAVIOUR CHANGE (`flows.arm`) AND MUST NOT BE PRESENTED
AS A CARRY-FORWARD.** There are two `ROLE_CAPS` maps in this codebase and they disagree on
exactly that (research M-7): the server's `workspace-member-capabilities.service.ts` gives
`approver` only `edit-workflows` + `approve`, while the client's `lib/capabilities.ts`
gives it `publish` as well. **Decided 2026-09-12 (D-4): an approver may arm, so the server
map is the bug.** FR-006's "reproduce today's roles exactly" is false for this one cell,
and saying otherwise would hide a widening inside a migration.

**INV-4 — the ordering survives.** `admin ⊇ approver ⊇ author` as *sets*, asserted by a
test, because the existing `RANK` comparison is being replaced by set membership and a
subset break would silently narrow an admin.

**INV-5 — the presets are pinned against today's behaviour.** A test asserts each preset's
set equals the set derived from the current `ROLE_CAPS` map plus the routes each role can
reach today.

⚠ **AS WRITTEN THIS IS NOT DERIVABLE, AND THE REASON IS TWO MEASUREMENTS.**

- **There are two `ROLE_CAPS`** and they disagree on `approver` (M-7). The test pins against
  the **server's**, with `flows.arm` added as the one declared exception above — that
  exception is the entire behaviour change and it must be spelled out in the test, not
  folded into the expected set.
- **"the routes each role can reach today" is degenerate.** Today every role — and every
  non-member — can reach all 106 unguarded routes, so the derived set would be the whole
  catalogue for everybody. The second half of INV-5 has no content and is dropped; what
  remains is the `ROLE_CAPS` pinning plus the 25 guarded routes.
- ⚠ **And there is nobody to pin for** (M-6): `workspace_members` is empty. FR-028 and
  SC-003 are **vacuously** true on this deployment. They are worth keeping for the next one;
  they prove nothing here, and the test must not be described as proving them.

---

## 3. `workspace_roles` — new (migration 0062)

Custom role definitions, scoped to one workspace.

| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL → `workspaces` ON DELETE CASCADE | |
| `name` | text NOT NULL | Display name, e.g. "Finance Reviewer" |
| `description` | text | |
| `created_by` | text NOT NULL | Identity **subject** |
| `created_at` / `updated_at` | timestamptz | |
| `retired_at` | timestamptz NULL | Soft retire — see INV-7 |

- `UNIQUE (workspace_id, lower(name)) WHERE retired_at IS NULL` — two roles with the
  same name in one workspace are two answers to "what does Finance Reviewer mean".
- **INV-6**: a custom role's name may not collide with a preset name
  (`author`/`approver`/`admin`), or a grant becomes ambiguous between code and data.
- **INV-7**: retiring is a timestamp, not a delete. A deleted role leaves audit entries
  referencing a name nobody can look up, and FR-033 forbids editing the audit to fix it.

## 4. `workspace_role_permissions` — new (0062)

| Column | Type |
| :--- | :--- |
| `role_id` | uuid NOT NULL → `workspace_roles` ON DELETE CASCADE |
| `permission` | text NOT NULL, CHECK ∈ catalogue |
| `granted_by` | text NOT NULL |
| `created_at` | timestamptz |

`PRIMARY KEY (role_id, permission)` — a role holds a permission once or not at all.

**INV-8**: a `platform.*` permission may not appear here. A workspace role granting a
deployment-wide permission is privilege escalation by role authoring. CHECK-enforced,
not just validated in the service.

## 5. `workspace_role_assignments` — new (0062)

| Column | Type |
| :--- | :--- |
| `id` | uuid PK |
| `workspace_id` | uuid NOT NULL → `workspaces` ON DELETE CASCADE |
| `subject` | text NOT NULL |
| `role_id` | uuid NOT NULL → `workspace_roles` ON DELETE CASCADE |
| `granted_by` | text NOT NULL |
| `created_at` | timestamptz |

- `UNIQUE (workspace_id, subject, role_id)`.
- **A person may hold several custom roles**, unlike the single preset in
  `workspace_members.role`. The effective set is the union (FR-011), so several roles
  cannot conflict — which is precisely what D-3 (grant-only) bought.
- **INV-9**: an assignment requires a `workspace_members` row for the same
  `(workspace_id, subject)`. Membership stays the single answer to "is this person in
  this workspace"; a custom role adds to what they may do, never smuggles them in.

## 6. `workspace_member_capabilities` — ALTERED (0065)

Reused as the individual-grant store (research D-2). Structure unchanged —
`(workspace_id, subject, capability, granted_by, created_at)` with its unique index
already correct.

**Migration 0065** renames the seven existing values to catalogue names and adds the
CHECK:

| Was | Becomes |
| :--- | :--- |
| `edit-workflows` | `flows.write` |
| `publish` | `flows.arm` |
| `approve` | `flows.approve` |
| `resources` | `resources.read` |
| `admin` | *(dropped — a role, never a permission; see INV-10)* |
| `platform-admin` | *(dropped — the platform tier replaces it)* |
| `real-data` | `realdata.use` |

- **INV-10**: `admin` and `platform-admin` were *roles wearing a capability's clothes*.
  Dropping them is a behaviour change for any row that holds one, so the backfill script
  reports every affected person before writing, and the two are re-expressed as a preset
  assignment and a platform role respectively.
- **INV-11**: additive only. There is no `effect` column and no `deny` value — D-3. The
  absence is the enforcement; a column with one legal value invites a second.
- ⚠ **Verify the row count before adding the CHECK.** Added VALID, after confirming
  every existing value maps (the `0038` precedent). If any unmapped value exists the
  migration must fail loudly rather than grandfather it in with NOT VALID.

## 7. `platform_roles` / `platform_role_assignments` — new (0063)

`platform_roles`: `id` · `key` (text UNIQUE) · `name` · `description` ·
`permissions` (text[] NOT NULL, CHECK every element ∈ catalogue and every element
`platform.*`-prefixed) · `builtin` (boolean NOT NULL DEFAULT false) · timestamps.

Three built-in rows seeded by the migration:

| key | Permissions |
| :--- | :--- |
| `platform-admin` | ⚠ **confers `members.read` + `members.grant` in EVERY workspace** (§10) · `platform.workspaces.write` `platform.members.grant` `platform.users.read` `platform.roles.write` `platform.generation.write` `platform.localusers.write` `platform.audit.read` `platform.ops.read` `platform.toolmodel.read` `platform.toolmodel.write` `platform.signals.read` |
| `auditor` | `platform.audit.read` only |
| `support` | `platform.users.read` `platform.audit.read` `platform.ops.read` `platform.signals.read` |

⚠ **Only `platform.members.grant` confers anything into a workspace** (§10, INV-18).
`auditor` and `support` confer **nothing** — they hold no key of `PLATFORM_CONFERS`, so a
holder of either sees no workspace and reads no tenant data, which is what FR-021 and
SC-010 require.

⚠ **`support` gains `platform.ops.read` and `platform.signals.read` (2026-09-12).** Reading
the outbox and the four silent-failure signals is what a support role is *for*; without them
the role can see who exists and nothing about whether the system is working.
⚠ **It deliberately does NOT gain `platform.toolmodel.*`** — support reads, it does not
change what the deployment generates or calls models with.

`platform_role_assignments`: `id` · `subject` (text NOT NULL) · `email` (text NOT NULL,
display only) · `role_key` (text NOT NULL → `platform_roles.key`) · `granted_by` ·
`created_at`. `UNIQUE (subject, role_key)`.

- **INV-12 — the auditor sees audit and no tenant data.** `platform.audit.read` confers
  **no** workspace permission. FR-021 and SC-010 both rest on this. ⚠ **The test's subject
  moved with D-9** (§10): platform roles now *can* confer workspace permissions, so the
  assertion is no longer "the auditor's permission list does not intersect the workspace
  catalogue" — it is *the auditor's **conferred** set is empty*, computed through
  `PLATFORM_CONFERS`, the same map the resolver uses. The old form would pass while
  `platform.audit.read` quietly acquired a conferral.
- **INV-13 — no platform role may confer super admin.** `config.isSuperAdmin` reads the
  environment and nothing else; there is no `platform.superadmin` permission and no code
  path from a row to that predicate. FR-018.
- **INV-14 — the last platform admin cannot be removed** except by an allowlist holder
  (FR-005 of Story 4), mirroring the existing last-workspace-admin refusal and its
  measured super-admin exemption.
- **INV-15 — built-in platform roles are not editable.** `builtin = true` refuses edit
  and delete, matching INV-7's reasoning for presets.

## 8. `platform_audit_events` — new (0064)

Spec D-2. Deliberately **not** a nullable `workspace_id` on `audit_events`.

| Column | Type |
| :--- | :--- |
| `id` | uuid PK |
| `time` | timestamptz NOT NULL DEFAULT now() |
| `actor` | text NOT NULL |
| `operation` | text NOT NULL, CHECK ∈ (`create`,`update`,`delete`,`access`) |
| `entity` | text NOT NULL, CHECK ∈ (`platform_role`,`platform_role_assignment`,`workspace`,`local_user`,`generation_provider`) |
| `entity_id` | text |
| `description` | text NOT NULL |
| `raw` | jsonb |

Indexed on `time` and on `actor`.

- **INV-16**: `audit_events` is structurally untouched — no column, constraint or index
  changes. SC-014's second half is exactly this, and it is what makes "zero existing
  audit reads change" provable by inspection rather than by testing every query.
  - ⚠ **`where_text` is `NOT NULL`** and `accessAuditService` must supply it. Not a
    constraint change; a field the writer has to fill, and the only thing in that table's
    shape that a new caller can get wrong.
  - ⚠ **The table is EMPTY and has exactly ONE production writer today**
    (`break-glass.service.ts`). So SC-014's stated verification — *"compare a saved
    pre-change workspace-audit response against the post-change one"* — compares an empty
    response to an empty response. It is a real check on a deployment with history and
    proves nothing here; say which.
- **INV-17**: the two records are read together in one time order for a caller holding
  `platform.audit.read` (FR-037), by union in the service. Two stores is a storage
  decision, never a reader-visible one.

## 9. Untouched

- **`workspace_members`** — no column, constraint or index change. Its `role` keeps
  holding a preset name. This is what makes FR-028 cheap to prove.
- **`platform_users`** — still "identities that have presented a verified token". It is
  the list an administrator assigns *from* and gains no authority of its own.
- **`audit_events`** — INV-16.

---

## Resolution algorithm

```
effective(person, workspace) =
      preset(workspace_members.role)                    if a membership row exists
    ∪ ⋃ permissions(r) for r in workspace_role_assignments
    ∪ workspace_member_capabilities rows
    ∪ ⋃ PLATFORM_CONFERS[p] for p in the person's platform permissions   ← §10

    = ALL catalogue permissions                          if config.isSuperAdmin(identity)
    = ∅                                                  otherwise
```

Six properties, each with a named test:

- **P-1 · Union, therefore order-independent** (FR-011, D-3). No subtraction anywhere.
- **P-2 · Empty means empty** (FR-012). No membership row, no custom role, no capability
  grant **and no conferring platform permission** ⇒ no permission.
- **P-3 · Super admin short-circuits before any read**, as `check()` does today — which is
  what keeps a memberless workspace assignable now that `claim` is deleted.
- **P-4 · Provenance is returned with the answer.** Every permission carries which preset,
  role, grant **or platform role** conferred it, so FR-038 is answered from the same
  computation that decides, not a second one that can disagree.
- **P-5 · One query shape per request** (research R-4), **plus one platform-role read**
  which is keyed on subject alone and is therefore the same read for every workspace in a
  request.
- **P-6 · A conferred permission is DISTINGUISHABLE from a granted one** (FR-020). Its
  provenance entry is `{ via: "platform", role: "platform-admin" }` and never
  `{ via: "preset" }`. This is the property that lets a screen say *"you can do this
  because you administer the platform"* rather than implying somebody put you in this
  workspace.

---

## 10. ⚠ Platform roles CONFER workspace permissions — spec D-9

⚠ **THIS SECTION IS NEW (2026-09-13) AND IT REVERSES `(currently: none)`.** The resolution
algorithm previously gave platform roles **zero** workspace permissions, which produced a
dead end nobody had noticed: a `platform-admin` holds `platform.workspaces.write`, so they
can **create** a workspace — and then could not put anybody into it, including themselves,
because `POST /workspaces/:ws/members` needed a super admin or `members.grant` and they had
neither. They had to go back to a `SUPER_ADMIN_EMAILS` holder to make their own new
workspace usable.

It was also **inconsistent, not merely restrictive**: `PUT /api/local-users/:id/access/:workspaceId`
writes `workspace_members` and is mapped to `platform.members.grant`, but is scoped by
construction to local accounts (*"it cannot be pointed at an Entra identity"*). So the same
act — put a person in a workspace — had two routes and two answers, decided by which
identity provider that person signs in with.

### The mechanism

`packages/server/src/auth/platform-conferral.ts`:

```ts
/** Workspace permissions a PLATFORM permission confers, in EVERY workspace. */
export const PLATFORM_CONFERS: Readonly<
  Partial<Record<PlatformPermission, readonly WorkspacePermission[]>>
> = Object.freeze({
  "platform.members.grant": ["members.read", "members.grant"],
});
```

**Keyed on the permission, not on the role.** A custom platform role holding
`platform.members.grant` confers exactly what the built-in one does; a role's *name* never
decides anything. This is the same reason the catalogue is code-owned: one answer to "what
does this string mean", everywhere.

### Invariants

- **INV-18 — the conferral is EXACTLY two permissions, asserted directly.** The image of
  `PLATFORM_CONFERS` must equal `{members.read, members.grant}` — not "is a subset of", not
  "does not contain secrets". A test reads the map's values and compares the set. ⚠ Written
  as a subset assertion it would pass while somebody added `flows.read`, and the whole cost
  of D-9 is bounded by this one number.
- **INV-12 — `auditor` still confers NOTHING, and the test moves.** It used to assert that
  the auditor's *permission list* intersects the workspace catalogue at zero. That is now
  the wrong subject: the auditor holds `platform.audit.read`, which is not a key in
  `PLATFORM_CONFERS`, so the assertion becomes *the auditor's conferred set is empty* —
  computed through the same map the resolver uses, never by inspecting the role's own list.
  FR-021 and SC-010 rest on this.
- **INV-19 — a conferred permission carries `via: "platform"`.** FR-020, which until this
  section had no subject at all. A screen showing why somebody may act must be able to say
  "because they administer the platform" rather than implying a membership row exists.
- **INV-20 — the last-admin refusal's exemption does NOT extend to the platform tier.**
  `config.isSuperAdmin` keeps it and nothing else gains it. The measured incident that
  created that exemption was a super admin making an irreversible mis-assignment with
  *nobody above them to undo it*; a platform admin always has an allowlist holder above
  them, so the refusal is recoverable and stays. A platform admin who hits it escalates.

### ⚠ The cost, stated rather than mitigated

**A platform administrator can assign themselves `admin` in any workspace and thereby reach
any tenant's data.** That is true, it is the price of (a), and it must be written into the
standards amendment rather than left for somebody to discover.

Two things bound it, and the difference between them matters:

- **A platform admin cannot read tenant data.** The conferral is `members.read` and
  `members.grant` — who is in the workspace and the ability to change that. It is **not**
  `flows.read`, `secrets.read`, `runs.read` or anything else. Opening a tenant's automations
  requires *first* granting themselves a workspace role.
- **That grant is a write, and it is on the record** (FR-033) — actor, subject, before,
  after, time. So the honest sentence is: *a platform administrator cannot see a tenant's
  data, but can give themselves the ability to, and doing so leaves an audit entry naming
  them.* Never *"a platform admin cannot access tenant data"*, which is false.

⚠ **This is not separation of duties and D-9 does not make it closer to being so.** The
allowlist remains the un-grantable root, and anything holding `RUNTIME_JWT_SECRET` still
mints any identity.

---

## Backfill (script, not migration — research D-5)

`pnpm --filter @foundry/server rbac:backfill [--dry-run]`. Default is dry run; writing
requires `--apply`.

Reports, per person per workspace, three columns: permissions **today**, permissions
**after**, and the **difference**. FR-029 is satisfied by this report existing before
anything is written; SC-003 is satisfied by the difference column being empty for
everybody except the known cases:

1. holders of the dropped `admin` / `platform-admin` capability values (INV-10);
2. workspace admins who lose the ability to change the generation model (research D-6);
3. ⚠ **approvers, who gain `flows.arm`** (D-4) and **`runs.replay`** (D-7) — the declared
   preset changes (§2);
4. ⚠ **authors, who lose `secrets.read`, `audit.read` and `breakglass.read`** (D-8) — on
   paper only: all three routes carry no guard today, so nobody's *effective* access moves.

⚠ **ON THIS DEPLOYMENT THE REPORT IS EMPTY, AND AN EMPTY REPORT IS NOT A CLEAN ONE.**
`workspace_members` and `workspace_member_capabilities` both hold **zero rows** against
**8 workspaces** (research M-6). So:

- there is nobody to carry forward, and `baseline-access.json` is `{}`;
- migration `0065`'s capability rename operates on zero rows — correct, and it proves
  nothing about the mapping, so **its CHECK must still be verified against a fixture**
  rather than against the live table;
- **the script must print the row count it read and refuse to report success on zero.**
  A backfill that says "0 differences" over 0 people reads exactly like a backfill that
  carried 40 people forward perfectly, and that is the failure this repo keeps finding
  (I-38). It exits 0 and says *"no members exist on this deployment; nothing to carry
  forward"*, naming the count.
