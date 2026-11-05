# Feature Specification: Feature-level RBAC — permission catalogue, custom roles, platform tier

**Feature Branch**: `20260910-130448-feature-rbac-permissions`

**Created**: 2026-09-10 · ⚠ **RE-BASELINED 2026-09-12**

**Status**: Draft

**Input**: User description: "I want to implement rbac system for this project. Create a spec for it and it should be robust so that feature-wise access can be given to the users who will be using the platform."

---

## Context: what is true today *(measured, not assumed)*

⚠ **RE-MEASURED 2026-09-12 AGAINST THE MOUNTED EXPRESS STACK, AND THE FILE UNIT
UNDERSTATED THE GAP SIX TIMES OVER.** The paragraph below counted route *modules*; the
unit that matters is a reachable `(method, path)` pair. There are **46** modules, not 43,
and **196** mounted routes: **142** workspace-scoped, **38** deployment-level, **16**
deliberately exempt. Of the 142, **36** carry a check today and **106 carry none**. The
whole map is `contracts/route-permissions.md`, which is generated from the stack rather
than written by hand — the hand-written version drifted in six places in two days.

The original wording, kept because it is what a stakeholder was told: an inventory of the
route modules found **22 with no identity or role check of any kind**, eighteen of them
serving one tenant's data — audit events, bootstrap, credentials, datasources, email box,
flow chat, flow executions, flow flags, flow phases, flow positions, flow templates, next
fires, release gates, resources, search, tools, triggers and workspace secrets. Each is
protected only by the single shared platform API key. **That is true and it is the smaller
half**: `flows.ts` alone contributes 23 unguarded routes and `datasources.ts` 24, and both
were classified as "guarded" by the file-level scan because two of their handlers carry a
role.

⚠ **AND THE SURFACE MOVED TWICE WHILE THESE ARTEFACTS WERE BEING WRITTEN.** `beta-1.1.0`
(*"admin section goes real"*) added **ten** workspace-scoped routes on 2026-09-13, all of
them already guarded — which is why the route map is **generated** from the mounted stack
rather than written down. Any number in this document is a reading with a date on it.

The browser reaches the API through a same-origin proxy that holds that one key on
every user's behalf. The consequence is direct and currently reproducible: **any person
who can sign in can read and write any workspace's tools, datasources, secret
declarations, credentials, chat threads, triggers and audit history simply by changing
the workspace identifier in the URL.** The proxy's own documentation already states that
the control for this belongs on the API side; it is not there.

The remaining unguarded modules are correct as they are and are **out of scope** — **16
routes**, not the smaller number implied here: the two engine-callback surfaces
(authenticated by an execution-scoped token that carries the tenancy, and **six** step
callbacks rather than four since the Stage-4 runtime landed), the open liveness probe, the
real-email endpoint (its own derived key), the correctness oracle (a test surface, already
blocked at the proxy), the two public trigger receivers and the sign-in verify endpoint.

Three partial mechanisms already exist and are extended rather than replaced:

- **Workspace membership** with three ordered roles (author ⊂ approver ⊂ admin), keyed
  on the stable identity subject. Applied to 11 route modules today.
- **A member capability list** with seven named capabilities and a role→capability map.
  ⚠ **Read by THREE places, not one** (re-measured 2026-09-12): the break-glass real-data
  check, the callable-catalogue's real-data gate, and **the endpoint that tells the browser
  what the signed-in person may do** — which the browser then acts on. This is the seed of
  the permission model and it is also already a live, partly client-side one.
- **A super-admin allowlist** held in the API server's environment, matched on subject
  or email. Its defining property is that it cannot be granted from inside the product.

⚠ **AND A FOURTH MECHANISM NOBODY HAD WRITTEN DOWN: THE BROWSER DECIDES TOO.** The client
holds its **own** role→capability map, uses it to hide navigation and to filter search
results, and **it disagrees with the server's** on what an approver may do. Whichever way
that disagreement is resolved, one of the two is wrong today and has been for as long as
both have existed. This is not a gap the feature creates; it is one it uncovers, and it is
why FR-031 is a change rather than a restatement.

⚠ **AND NOBODY HOLDS A GRANT.** Measured 2026-09-12: **eight** live workspaces, **zero**
rows in the membership store, **zero** capability grants, **two** identities ever seen. So
the day the coarse check lands, every workspace refuses every person who is not in the
environment allowlist. That is FR-012 working exactly as specified, applied to a deployment
where nothing has been configured — and it is a consequence to state up front, not to
discover.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A workspace is closed to people who were not given access (Priority: P1)

A person signs in and can see and act only inside the workspaces they have been granted
access to. Pointing a request at a workspace they hold no grant in is refused, and the
refusal says which of the two possible reasons applies: nobody has been granted anything
here yet, or somebody has and it is not you.

**Why this priority**: This is the open door. Until it is shut, every other part of this
feature is decoration — a fine-grained permission model is worthless if the coarse
membership check it rests on is absent from eighteen endpoints. It is also the only
story that is a security fix rather than a capability, and it is shippable on its own
against the roles that already exist.

**Independent Test**: Sign in as a person with a grant in workspace A and none in
workspace B. Every workspace-scoped read and write against A succeeds; the same calls
against B are refused with a reason naming the missing grant. No credential, header or
request body field changes the outcome.

**Acceptance Scenarios**:

1. **Given** a person holding a grant in workspace A only, **When** they request any
   workspace-scoped resource in workspace B, **Then** the request is refused and the
   refusal names the missing grant, not a generic failure.
2. **Given** a workspace with no members at all, **When** any signed-in person who is
   not a platform-tier holder acts in it, **Then** the request is refused — an empty
   grant list never means "allow".
3. **Given** a request carrying the platform API key but naming no person, **When** it
   reaches a workspace-scoped route, **Then** it is refused with a reason distinguishing
   "no person named" from "this person is not permitted".
4. **Given** a workspace-scoped route is added without declaring a permission, **When**
   the test suite runs, **Then** it fails and names the undeclared route.
5. **Given** the engine's callback surfaces and the deployment-level operator surfaces,
   **When** this story ships, **Then** their authentication is byte-for-byte unchanged.
6. **Given** a person holding a grant in workspace A only, **When** they list the
   workspaces available to them, **Then** only A is returned — a workspace they cannot
   read the data of does not appear, and neither does its name.
7. **Given** a person holding no grant anywhere, **When** they sign in, **Then** they
   reach a state that explains they have not been granted access to any workspace yet
   and who can grant it, rather than an empty list with no explanation.

---

### User Story 2 - Access is granted per feature, not per role tier (Priority: P1)

An administrator grants somebody exactly what they need — "may edit automations and read
run history, may not register datasources, may not read the credential list" — instead
of choosing between three tiers that each carry a fixed bundle.

**Why this priority**: This is the capability the request actually asked for
("feature-wise access"). It is P1 alongside story 1 because the two share one mechanism:
the per-route declaration that story 1 introduces is the same declaration that makes
per-feature granting expressible. Building story 1 with a coarse check and retrofitting
per-feature granularity afterwards would mean declaring every route twice.

**Independent Test**: Take a person holding the built-in author preset. Remove one named
permission from them. The single corresponding action is refused; every other action they
previously could take still succeeds; and the refusal names the permission they lack.

**Acceptance Scenarios**:

1. **Given** the permission catalogue, **When** it is inspected, **Then** every
   workspace-scoped action a person can take through the product maps to exactly one
   named permission, and each permission is a fixed, code-owned identifier that no
   administrator can invent, rename or delete.
2. **Given** a person holding the built-in author preset before this feature, **When**
   the feature ships, **Then** every action they could take before, they can still take,
   and every action they were refused before, they are still refused — the presets
   reproduce the three existing roles exactly.
3. **Given** a person is denied one permission, **When** they attempt the action it
   governs, **Then** they are refused with a message naming that permission and who can
   grant it.
4. **Given** any request, **When** its permission is evaluated, **Then** the answer is
   computed on the server from stored grants only, and no value in the request — header,
   body, query or path — can widen it.

---

### User Story 3 - An administrator composes a role for their own team (Priority: P2)

A workspace administrator creates a named role — "Finance Reviewer", "Read-only Auditor",
"Automation Author (no secrets)" — by selecting permissions from the catalogue, assigns
people to it, and later edits or retires it.

**Why this priority**: Three fixed presets cannot describe seven product domains with
different review cultures. This is what makes the model *robust* rather than merely
finer-grained. It ranks below stories 1 and 2 because it is a convenience over a
mechanism that already works without it — per-member permissions alone deliver the
capability, custom roles deliver it at manageable scale.

**Independent Test**: Create a custom role holding two permissions, assign it to a person
with no other grant, confirm they can do exactly those two things and nothing else, edit
the role to remove one permission, confirm the corresponding action is refused
immediately, then retire the role and confirm the person retains no access from it.

**Acceptance Scenarios**:

1. **Given** a workspace administrator, **When** they create a role and select
   permissions for it, **Then** the role exists in that workspace only and is not visible
   to or usable by any other workspace.
2. **Given** a custom role in use, **When** a permission is removed from it, **Then**
   every member holding that role loses that permission on their next request, with no
   sign-out required.
3. **Given** a custom role, **When** an administrator attempts to grant it a permission
   they do not themselves hold, **Then** the attempt is refused — a role is not a way to
   manufacture authority its author lacks.
4. **Given** a custom role assigned to at least one person, **When** an administrator
   deletes it, **Then** they are told how many people will lose access and must confirm,
   and the affected members are left with their other grants intact.
5. **Given** the three built-in presets, **When** an administrator attempts to edit or
   delete one, **Then** it is refused — they may copy a preset into a custom role, never
   redefine what the preset means.

---

### User Story 4 - The deployment has roles above the workspace (Priority: P2)

The person who runs the platform assigns deployment-wide roles — a platform administrator
who manages workspaces and membership, an auditor who reads audit history across tenants
without seeing tenant data, a support role that reads without writing and never reads
secrets — instead of everything above a workspace being one un-delegatable environment
variable.

**Why this priority**: Two concrete problems, both present today. The generation-model
setting is guarded by "holds admin in *any* workspace", so a Finance administrator can
change what every workspace generates with — the guard's own documentation calls this
coarse and names a real role table as the fix. And the only authority above a workspace
is an environment allowlist, so there is no way to give somebody cross-tenant audit
access without giving them everything.

**Independent Test**: Assign a person the auditor role and nothing else. They can read
audit history in every workspace, and are refused every workspace data read, every write,
and every membership change.

**Acceptance Scenarios**:

1. **Given** the environment allowlist, **When** the platform tier ships, **Then** the
   allowlist remains the root of trust: it is still un-grantable from inside the product,
   still bootstraps the first platform-role holder, and still cannot be conferred by any
   platform role.
2. **Given** a platform administrator, **When** they act inside a workspace, **Then**
   their platform role grants the workspace-level access it is defined to grant and
   nothing beyond it, and that access is visible on screen as coming from the platform
   tier rather than from a membership row.
3. **Given** the deployment-wide generation setting, **When** this story ships, **Then**
   it is guarded by an explicit platform role and no longer by "admin in any workspace".
4. **Given** a person holds no platform role and is not in the allowlist, **When** they
   attempt any deployment-wide action, **Then** they are refused with a message that
   distinguishes "nobody is configured" from "somebody is and it is not you".
5. **Given** the last remaining platform administrator, **When** removal or demotion is
   attempted, **Then** it is refused unless the caller is in the environment allowlist —
   the deployment must never reach a state where nobody can grant.

---

### User Story 5 - The screen shows what you can do, and says so honestly (Priority: P3)

A person sees the controls they can actually use. An action they lack permission for is
either absent or visibly disabled with the reason, rather than a button that fails when
pressed. When the permission check itself cannot be completed, the screen says the check
did not run — never that the person has no access, and never that they have it.

**Why this priority**: Server enforcement is the control; this is the affordance. It
ranks below the tiers because a 403 on click is ugly but safe, whereas a screen that
decides for itself is a second authority that can disagree with the only one that
refuses anything. Shipping the server first and the UI second is the correct order.

**Independent Test**: Sign in as a person with a narrow grant. Every control for an
action they cannot perform is absent or disabled with a reason. Force the permission
lookup to fail and confirm the screen reports that the check did not run, rather than
rendering either answer.

**Acceptance Scenarios**:

1. **Given** the client, **When** it decides whether to show or enable a control,
   **Then** it uses an answer obtained from the server and never a claim carried in the
   sign-in session — the existing prohibition on the client deciding from session role
   claims survives this feature intact.
2. **Given** a disabled control, **When** a person inspects it, **Then** it states which
   permission is missing and who can grant it.
3. **Given** the permission lookup fails or is unreachable, **When** the page renders,
   **Then** it reports that the check could not be completed, and renders neither the
   permitted nor the forbidden state.
4. **Given** the client hides a control, **When** the same request is made directly,
   **Then** the server refuses it — hiding is never the enforcement.

---

### User Story 6 - Every grant, revocation and refusal is on the record (Priority: P3)

An administrator or auditor can answer, after the fact: who was given what, by whom,
when; what was taken away; and what was attempted and refused.

**Why this priority**: An access model with no record of its own changes cannot be
reviewed, and "who granted this person secret access" is the first question asked after
an incident. It is P3 only because the grants themselves must exist before they can be
recorded.

**Independent Test**: Grant a role, override a permission, revoke both, and attempt one
forbidden action. All five appear in the audit history with actor, subject, what changed
and when — and the record of a refusal never contains the data that was being protected.

**Acceptance Scenarios**:

1. **Given** any change to a role definition, a role assignment or a per-member
   permission, **When** it is committed, **Then** an audit entry records who made it, who
   it was about, what changed from what to what, and when.
2. **Given** a refused request, **When** it is recorded, **Then** the entry names the
   person, the permission and the resource addressed, and contains **no** part of the
   protected resource itself.
3. **Given** repeated identical refusals from one person against one resource, **When**
   they are recorded, **Then** the volume is bounded so that a loop cannot flood the audit
   history and push real entries out of a reader's view.
4. **Given** audit history, **When** anyone attempts to alter or delete an entry through
   the product, **Then** there is no surface that permits it.

---

### Edge Cases

- **A person's grants change mid-session.** A revoked permission stops applying on the
  next request; a person is never asked to sign out for a revocation to take effect. A
  cached permission answer must not outlive a revocation by more than a stated bound.
- **A person is granted a role and an explicit per-member entry covering the same
  permission.** They cannot disagree: overrides only add, so the answer is the union and
  the duplicate is harmless. This is the property that keeps "why do I have this?"
  answerable in one sentence.
- **An administrator wants somebody to have a role minus one permission.** There is no
  way to subtract, by decision. They compose a custom role — which is the case Story 3
  exists to serve, and the reason it is not optional.
- **A person holds a grant in no workspace.** They see no workspaces at all, and a state
  that says so and names who can grant access. An empty list with no explanation reads as
  a broken product rather than an unconfigured account.
- **A person's last workspace grant is revoked while they are signed in.** Their next
  request stops resolving that workspace, and the workspace disappears from their list —
  including from a switcher currently pointed at it, which must handle its selection
  vanishing rather than erroring.
- **The permission catalogue gains an entry in a release.** Existing custom roles do not
  silently acquire it; a new permission is held by nobody until granted, and the built-in
  presets change only by an explicit, reviewed decision.
- **A permission is removed from the catalogue.** Grants referencing it are surfaced
  rather than silently dropped, so nobody's access changes without somebody seeing it.
- **The last administrator of a workspace is demoted or removed**, leaving members and
  nobody able to grant. Refused, with the existing platform-tier exemption preserved —
  an irreversible mis-assignment is a worse failure than the state the refusal protects.
- **A workspace is created and nobody is assigned to it.** It is inert and says so, and
  only the platform tier can give it a first member. There is deliberately no
  first-caller-wins bootstrap.
- **A route is mounted where the workspace identifier is not in scope.** Treated as a
  wiring defect and refused loudly as such, never allowed — matching how the existing
  guards already fail.
- **Two people are granted concurrently, or one person twice.** One person holds one
  answer per workspace; a second row would be two answers decided by row order.
- **A person's identity subject changes** (a known past incident: one sign-in identity
  rotated per session and silently detached a member's role). Grants are keyed on the
  stable subject, and a person whose grants stop resolving is surfaced rather than
  silently reduced to no access.
- **Non-interactive callers** — every seeding, provisioning, demonstration and
  verification harness — call services directly with no person attached and must continue
  to work unchanged.

---

## Requirements *(mandatory)*

### Functional Requirements

#### The permission catalogue

- **FR-001**: The system MUST define a fixed catalogue of named permissions, each
  corresponding to one category of action a person can take. The catalogue is owned by
  the codebase: no administrator, request or configuration value can add, rename or
  remove a permission.
- **FR-002**: Every workspace-scoped route MUST declare the permission it requires. A
  route that declares none MUST cause an automated check to fail, naming the route.
- **FR-003**: The completeness check in FR-002 MUST include a control proving it can
  detect an omission, so that a check scanning nothing cannot pass as a check finding
  nothing.
- **FR-004**: The catalogue MUST cover, at minimum, distinct permissions for: reading and
  writing automations; approving and arming them; reading and writing datasources, tools,
  credentials and secret declarations; reading run history and replaying runs; reading
  audit history; managing members and roles; activating break-glass; and using real
  rather than sandboxed data.
- **FR-005**: The routes listed as out of scope in Context — the engine callback
  surfaces, the liveness probe, the mail endpoint, the oracle and the three
  deployment-level operator surfaces — MUST retain their existing authentication
  unchanged, and MUST be recorded as deliberate exemptions rather than omissions, so that
  the FR-002 check treats them as decided rather than missing.

#### Roles and grants

- **FR-006**: The system MUST provide three built-in role presets whose permission sets
  reproduce the current author, approver and admin roles, including the existing property
  that each higher role subsumes the ones below it.
  - ⚠ **"Exactly" is not achievable and the word is removed.** There are **two** existing
    role→capability maps — one on the server, one in the browser — and they **disagree on
    whether an approver may arm an automation**. One of them has been wrong for as long as
    both have existed. Resolved: **an approver may arm.** That is a widening of the server's
    current behaviour and it MUST be recorded as a behaviour change in its own right, not
    absorbed into a preset that claims to reproduce today.
- **FR-007**: Built-in presets MUST NOT be editable or deletable. An administrator may
  copy one into a custom role.
- **FR-008**: A workspace administrator MUST be able to create, edit and retire named
  custom roles scoped to their own workspace, selecting any permissions from the
  catalogue.
- **FR-009**: A custom role MUST NOT be grantable permissions the granting person does
  not themselves hold.
- **FR-010**: An administrator MUST be able to grant individual permissions to a named
  person on top of their role. An override MUST NOT be able to subtract a permission the
  person's role confers — narrowing is expressed by assigning a role that does not carry
  it, which is what custom roles (FR-008) exist to make cheap.
- **FR-011**: A person's effective permissions MUST be the union of those conferred by
  their platform role, their workspace role and their individual grants. The result MUST
  therefore be independent of evaluation order, and the reason a person holds a
  permission — which role or grant conferred it — MUST be answerable on request.
- **FR-012**: A person holding no grant in a workspace MUST hold no permission in it. A
  workspace with no members MUST refuse every person outside the platform tier — an
  absence of configuration MUST NOT read as permission.
  - ⚠ **ON THE CURRENT DEPLOYMENT THIS APPLIES TO EVERY WORKSPACE AT ONCE.** There are eight
    workspaces and zero grants. FR-012 is correct and is not being softened; the requirement
    on the *delivery* is that the consequence is stated before the change ships, surfaced by
    a pre-flight count, and explained on screen by FR-016 — never discovered by the first
    person who signs in afterwards.
  - There is deliberately no bulk grant. Backfilling everybody as an administrator is the
    shape the membership migration already refused, for the reason it recorded.
  - ⚠ **"outside the platform tier" only became true with D-9.** This clause was written as
    though the platform tier could act in a memberless workspace; until D-9 it conferred
    nothing, so the exception described a case that could not occur. A platform
    administrator can now give a memberless workspace its first member — which is the
    bootstrap this requirement always implied and did not have.
- **FR-013**: The system MUST refuse to leave a workspace with members and nobody able to
  grant, preserving the existing exemption for the environment allowlist holder.
- **FR-014**: There MUST be no self-service path by which a person obtains their first
  grant in a workspace. Grants are made by an administrator or by the platform tier.
- **FR-015**: A person MUST be shown only the workspaces in which they hold a grant.
  Listing MUST NOT disclose the existence, name or metadata of a workspace they hold no
  grant in. A platform-tier holder whose role confers it sees all of them.
  - ⚠ **After D-9 that last sentence resolves to something concrete**: a platform
    administrator holds `members.read` in every workspace, so they see all of them; an
    **auditor and a support-role holder see none**, because neither confers anything into a
    workspace. An auditor reads audit history across tenants through the deployment-level
    record, not by being shown the workspaces — which is what keeps FR-021 and SC-010 true.
- **FR-016**: A person holding no grant in any workspace MUST reach a state that says so
  and names who can grant access, rather than an unexplained empty list.

#### The platform tier

- **FR-017**: The system MUST support deployment-wide roles, assignable to a person,
  independent of any workspace membership. It MUST ship with at least a platform
  administrator, an auditor and a support role, each with a stated permission set.
- **FR-018**: The environment allowlist MUST remain the root of trust: un-grantable from
  inside the product, able to bootstrap the first platform-role holder, and never
  conferrable by any platform role.
- **FR-019**: The deployment-wide generation setting MUST be guarded by an explicit
  platform permission and MUST NOT continue to be guarded by "holds admin in any
  workspace".
- **FR-020**: Where a platform role confers access inside a workspace, the source of that
  access MUST be distinguishable from a membership grant wherever a person's access is
  displayed or explained.
  - ⚠ **THIS REQUIREMENT HAD NO SUBJECT UNTIL D-9.** Platform roles conferred nothing inside
    a workspace, so it was a rule about a case that could not arise. It is now live: the
    platform-administrator permission confers exactly `members.read` and `members.grant` in
    every workspace, and those two must render and explain as *"because they administer the
    platform"* — never as though somebody had put them in this workspace.
  - The conferred set MUST be **exactly** those two. A test asserts the set, not a subset:
    written as "does not include secrets" it would pass while a third permission was added,
    and the whole cost of D-9 is bounded by that number.
- **FR-021**: The auditor role MUST be able to read audit history across workspaces
  without thereby gaining read access to workspace data or to any secret.
  - ⚠ **After D-9 this MUST be verified against the conferral, not the role's own list.**
    Platform roles can now confer workspace permissions, so "the auditor's permissions do
    not intersect the workspace catalogue" is the wrong assertion — it would hold while the
    auditor's one permission quietly acquired a conferral. The check is that the auditor's
    **conferred** set is empty, computed through the same map the resolver uses.

#### Refusals and diagnosis

- **FR-022**: A refusal MUST distinguish "no person is named on this request" from "this
  person is not permitted", and MUST distinguish "nobody is configured to grant this" from
  "somebody is and it is not you". Each refusal names the action its reader can take.
- **FR-023**: A refusal MUST NOT disclose the permission sets, role definitions or
  identities of the people who could grant the missing permission.
- **FR-024**: A route reached without the workspace identifier its check requires MUST
  fail loudly as a wiring defect, never pass.
- **FR-025**: No field of a request — header, body, query or path — may assert, widen or
  exempt the caller's own authority. Request schemas for grant surfaces MUST reject
  unknown fields rather than ignore them.

#### Preservation

- **FR-026**: The accountability gates MUST continue to operate unchanged and MUST remain
  separate from authorisation: the refusal to approve one's own revision, the escalation
  required for a revision whose authorship nobody attested, and the refusal to decide a
  pause on a run one started. Holding a permission MUST NOT satisfy any of them.
- **FR-027**: Permission checks MUST live at the request boundary, not inside the
  services. Every non-interactive caller — seeds, provisioners, demonstration and
  verification harnesses — MUST continue to work with no person attached and no change.
- **FR-028**: Existing members and existing capability grants MUST be carried forward so
  that every person's effective access on the day this ships is identical to their
  effective access the day before, with the sole intended exception of the eighteen
  routes in Context, which become restricted.
- **FR-029**: The change MUST be reversible in the sense that the carried-forward state
  is derivable and inspectable before it is applied, so that the effect on every existing
  person can be reviewed rather than discovered.

#### Visibility and record

- **FR-030**: The system MUST be able to tell a signed-in person what they may do in a
  given workspace, so the client can render affordances without deciding anything itself.
- **FR-031**: The client MUST NOT decide any access question — from a claim carried in the
  sign-in session, **or from a policy of its own applied to a server answer**. It MUST hold
  no role-to-permission mapping, no capability-to-navigation mapping and no per-result-kind
  filter; every affordance decision comes from the server's answer for that person in that
  workspace, unmodified.
  - ⚠ **This is a CHANGE, not a restatement.** The prohibition as previously written covered
    only the sign-in session, and the client satisfies that today while holding a complete
    second authorisation model that disagrees with the server's. The automated check for the
    session prohibition does not match any of it.
  - The check therefore has two halves and each needs its own positive control: the absence
    of any second mapping, and the presence of the one legitimate reader.
- **FR-032**: Where the client cannot obtain a permission answer, it MUST render that the
  check did not run, and MUST NOT render either the permitted or the forbidden state.
- **FR-033**: Every creation, modification and deletion of a role, role assignment or
  per-member permission MUST be recorded with actor, subject, before and after, and time.
- **FR-034**: Refused requests MUST be recorded with the person, the permission and the
  resource addressed, and MUST NOT record any part of the protected resource. The volume
  of repeated identical refusals MUST be bounded.
- **FR-035**: There MUST be no product surface that edits or deletes an audit entry.
- **FR-036**: Deployment-wide access decisions — platform role grants, revocations and
  refusals — MUST be recorded in a deployment-level record distinct from the
  workspace-scoped one, because they belong to no workspace and attributing them to one
  would make the record say an event happened somewhere it did not. Existing
  workspace-scoped audit reads MUST be unaffected by its introduction.
- **FR-037**: A reader entitled to audit across both tiers MUST be able to see workspace
  and deployment events together, in one time order, without needing to know that two
  records exist.
- **FR-038**: An administrator MUST be able to see, for one person, every permission they
  hold in a workspace and where each comes from; and for one permission, every person who
  holds it.

#### Proof

- **FR-039**: Every control introduced by this feature MUST be proven by perturbation:
  removing or disabling the control turns a named automated test red. A control with no
  such test is not delivered.
- **FR-040**: An automated check MUST assert that the permission check and the identity
  requirement are applied together on every route that carries either, so a route cannot
  carry one alone.

### Key Entities

- **Permission**: One named, code-owned identifier for a category of action. Fixed set;
  not data an administrator can extend.
- **Role**: A named set of permissions. Either a built-in preset (immutable, three of
  them, reproducing today's roles) or a custom role scoped to one workspace.
- **Role Assignment**: The fact that one person holds one role in one workspace. One
  answer per person per workspace.
- **Permission Grant (override)**: An explicit grant of a single permission to one person
  in one workspace, added on top of their role. Additive only — it can never subtract
  (FR-010), which is what keeps the effective set order-independent.
- **Platform Role**: A named set of deployment-wide permissions, assignable independently
  of workspace membership.
- **Platform Role Assignment**: The fact that one person holds one platform role. Rooted
  in, and never able to confer, the environment allowlist.
- **Workspace Access Decision Record**: The durable record of a grant, a revocation or a
  refusal belonging to one workspace — actor, subject, permission, resource addressed,
  time. Never contains protected data.
- **Deployment Access Decision Record**: The same, for events belonging to no workspace —
  platform role grants, revocations and refusals. Distinct from the workspace-scoped
  record (FR-036) because a platform event has no workspace it could truthfully be filed
  under, and readable together with it in one time order (FR-037).
- **Effective Permission Set**: The computed answer for one person in one workspace — the
  union of platform role, workspace role and individual grants; served to the client for
  affordances and never accepted from it.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero workspace-scoped endpoints can be reached by a signed-in person who
  holds no grant in that workspace. Verified by attempting every workspace-scoped
  endpoint as such a person and observing a refusal from each.
- **SC-002**: Zero workspace-scoped endpoints lack a declared permission, enforced by an
  automated check that fails on omission and is itself proven able to detect one.
- **SC-003**: 100% of people holding a built-in role today can perform the same set of
  actions after the change as before it — with two stated exceptions: the **106** previously
  unguarded routes, and an **approver gaining the ability to arm** (FR-006).
  - ⚠ **VACUOUS ON THE CURRENT DEPLOYMENT — nobody holds a role.** It is worth keeping for a
    deployment that has members; here it can only be argued at the level of the code, and
    the argument must not be reported as a measurement.
  - ⚠ The original wording said "the eighteen previously unguarded routes". It was 18
    *modules* and 106 *routes*, so the exception it granted was six times larger than it
    read.
- **SC-004**: An administrator can define a role, assign it, have the assignee exercise
  exactly its permissions, and revoke it, in under 5 minutes and without assistance.
- **SC-005**: A revoked permission stops applying within one request, and in no case more
  than 60 seconds, without the affected person signing out.
- **SC-006**: 100% of grants, revocations and role changes appear in audit with actor,
  subject, before, after and time; and no audit entry produced by this feature contains
  protected data.
- **SC-007**: Every refusal a person can encounter names the missing permission and the
  action its reader can take; measured by reviewing every distinct refusal message the
  feature can emit.
- **SC-008**: Every control introduced is covered by a perturbation test — count of
  controls equals count of tests proven to turn red when the control is removed.
- **SC-009**: The full existing verification suite passes unchanged, including every
  domain verification harness, the engine phase harnesses, the scenario harnesses, the
  HTTP journey harness and the client honesty checks.
- **SC-010**: A person holding only the auditor platform role can read audit history in
  every workspace and is refused 100% of workspace data reads, all writes, and all
  membership changes — **and sees no workspaces at all in the workspace list**, since
  `platform.audit.read` confers nothing into a workspace (D-9).
- **SC-015**: A person holding only the platform-administrator role is permitted exactly two
  workspace-scoped actions in a workspace they are not a member of — reading the member list
  and changing it — and is refused every other workspace-scoped route. Verified by attempting
  the full workspace-scoped surface as such a person, with the permitted count asserted as
  **exactly 2**, not "at least 2".
- **SC-011**: No screen renders an action a person cannot perform as though they can, and
  no screen renders an unavailable permission check as either an allow or a deny.
- **SC-012**: A person listing their workspaces receives exactly the set they hold a
  grant in — no more, and none omitted — verified across at least one person with several
  grants, one with a single grant, one with none, and one platform-tier holder.
- **SC-013**: A person with no grant anywhere reaches an explanation of that state naming
  who can grant access, in 100% of cases, rather than an empty or errored screen.
- **SC-014**: 100% of platform-tier grants, revocations and refusals are retrievable from
  the deployment-level record, and the introduction of that record changes the result of
  zero existing workspace-scoped audit reads.
  - ⚠ **The second half is unmeasurable here**: the workspace audit store holds **zero**
    rows and has exactly **one** production writer today. Comparing a saved pre-change
    response with the post-change one compares an empty response to an empty response. Say
    which was done.

---

## Assumptions

- **Roles are per-workspace, not shared templates.** A custom role belongs to the
  workspace that created it. A future need for shared templates is a separate feature;
  making roles global now would mean one workspace's administrator editing a role another
  workspace relies on.
- **The catalogue is coarse enough to be readable.** Permissions are per feature area and
  operation class (read / write / approve), not per endpoint. A catalogue with one entry
  per route would be unreviewable, and an unreviewable permission list is granted by
  copy-paste.
- **The existing three roles are correct as presets.** Their current meanings are carried
  forward verbatim rather than re-litigated, so the change is behaviour-preserving for
  everybody who has a grant today.
- **The existing member capability list is the grain for per-member overrides.** It
  already has the right shape (workspace, person, capability, granter) and is currently
  read by one route; extending it avoids a second store answering the same question.
- **The environment allowlist stays.** It is the only authority that cannot be obtained
  through the product, and every alternative root of trust considered can be granted by
  somebody who has it.
- **Grants are keyed on the stable identity subject, never the email address.** An
  address can be reassigned; this repository has already had one incident where an
  unstable key silently detached a person's role.
- **Non-interactive callers stay outside the model.** Harnesses and seeds address the
  services directly and name no person. This is why enforcement is at the request
  boundary, and it is a deliberate boundary of the feature rather than a gap.
- **Sign-in itself is unchanged.** Which identity providers exist, how a session is
  established and how a person is named are out of scope; this feature decides only what
  a named person may do.
- **Audit volume is bounded by deduplication rather than by sampling**, so that a
  refusal that happens once is never dropped.
- **The client learns its affordances by asking the server.** No permission logic is
  duplicated into the browser; the existing prohibition on client-side access decisions
  is treated as binding.
- **The HTTP journey harness will need an identity that resolves to a grant.** It
  currently finds its fixture workspace by listing all workspaces, which FR-015 stops
  returning. It already has the same requirement for the membership step, where it
  presents the first entry of the environment allowlist — the same approach applies, and
  where the variable is unset it should record the omission rather than report the
  product as broken.
- **Filtering the workspace list is a change in what people see, not only in what they
  can reach.** Somebody accustomed to seeing every workspace will see fewer. That is the
  intent, and it is worth saying aloud because it will be reported as a regression by
  whoever sees it first.

---

## Out of Scope

- Changing how anybody signs in, or which identity providers are accepted.
- Making any part of this separation of duties. Anything holding the identity signing
  secret can produce any identity, so the claim this feature supports is bounded: *a
  person who has not been granted X in this workspace cannot do X in it.* The stronger
  phrasing is not available and must not be written down anywhere.
- Any self-service access-request or approval flow.
- Re-tiering the engine callback surfaces, the mail endpoint, the oracle or the
  deployment-level operator surfaces.
- Attribute- or data-level access control — row filtering, column masking, per-record
  ownership. The unit here is a feature, not a record.
- Time-bounded or just-in-time elevation beyond the break-glass mechanism that already
  exists.
- Cross-tenant role templates or role inheritance between workspaces.

---

## Dependencies

- The identity resolution already in place, which names a person from a verified token.
- The existing workspace membership store and its ordered roles.
- The existing member capability store and its role→capability mapping.
- The existing workspace-scoped audit event store, which is left structurally untouched;
  deployment-wide events go to a new record beside it (FR-036).
- The existing verified-identity directory, which is the list an administrator assigns
  from.
- The same-origin proxy, which is where the browser's requests acquire the platform API
  key and the caller's identity.

---

## Resolved Decisions

Nine decisions materially changed scope and were not safely defaultable. **D-1…D-3** were
put to the requester on 2026-09-10; **D-4…D-6** arose from the 2026-09-12 re-baseline, when
measuring the codebase found three things the 2026-09-10 reading had not; **D-7 and D-8**
came out of working the role presets into concrete sets on 2026-09-13, which is when it
became visible that one permission was held by nobody and another cell had three readings;
**D-9** was raised on 2026-09-13 by the question *"who assigns a workspace admin, and who
assigns a platform admin?"*, which walked straight into a dead end nobody had noticed. All
were answered the day they were raised. They are recorded here with the option
not taken, because a decision whose alternative is lost reads later as an oversight.

- **D-1 · The workspace list is membership-filtered.** A person sees only the workspaces
  they hold a grant in; a workspace they cannot read the data of does not appear, and
  neither does its name. *Not taken*: leaving the list open, which would have kept
  today's behaviour and broken nothing, at the cost of workspace names and metadata
  staying readable by every signed-in person — an inconsistency with the eighteen routes
  this feature closes. Recorded in FR-015, FR-016; costs in Assumptions.

- **D-2 · Deployment-wide access decisions go to a separate deployment-level record.**
  The workspace-scoped audit store keeps its requirement that every entry belong to a
  workspace, so no existing audit read changes. *Not taken*: relaxing that requirement to
  hold both tiers in one store, which would have meant re-verifying every existing audit
  query for a filter it may not have, where a missing one surfaces platform events inside
  a tenant's view. Also not taken: filing platform events against a nominated workspace,
  which needs no schema change and makes the audit record assert something untrue.
  Recorded in FR-036, FR-037.

- **D-3 · Individual permission grants are additive only.** An override can add a
  permission; nothing can subtract one. Effective permissions are therefore a union and
  the answer does not depend on evaluation order. *Not taken*: allowing denial, which
  would express "admin, but never secrets" without composing a role, at the cost of an
  order-dependent resolution that every screen showing a person's access would have to
  explain — and in which promoting somebody may silently not give them what the promoter
  expects. Narrowing is done by composing a custom role instead, which is why Story 3 is
  not optional. Recorded in FR-010, FR-011.

- **D-4 · An approver may arm an automation.** *(2026-09-12)* Two role→capability maps
  exist — `workspace-member-capabilities.service.ts` on the server and `lib/capabilities.ts`
  in the browser — and they disagree on exactly this. The server withholds it; the client
  grants it; the preset table drafted for this feature agreed with the client. *Not taken*:
  the server's reading, which would have made the presets a true carry-forward (FR-006's
  "exactly") at the cost of taking a capability away from every approver the UI has been
  showing it to. Either way one of the two was wrong; what is not acceptable is shipping
  presets that claim to reproduce today while silently picking a side. Recorded as a
  behaviour change in `plan.md`, in FR-006 and in the standards amendment.

- **D-5 · The zero-member state is accepted, stated, and not bulk-fixed.** *(2026-09-12)*
  The deployment has eight workspaces and no grants at all, so closing the 106 routes makes
  every workspace unusable to everyone outside the environment allowlist until somebody
  assigns members. *Not taken*: deriving members from the identities the API has seen and
  granting them administrator — which would restore access instantly and grant the highest
  role to whoever happened to have signed in, the shape the membership migration already
  refused. Also *not taken*: an "allow while unconfigured" grace period, which is FR-012
  inverted and would be the control switched off precisely where it was never set up. The
  cost is paid in explanation: a pre-flight count before the guard is mounted, FR-016's
  screen after it, and a line in the standards amendment. Recorded in FR-012.

- **D-6 · The browser stops deciding, and that is a change rather than a rule being kept.**
  *(2026-09-12)* The client holds its own role→capability map, hides navigation with it and
  filters search results with it. None of that reads the sign-in session, so the existing
  prohibition — and the automated check enforcing it — passes over all of it. *Not taken*:
  leaving it and widening only the session check, which would let the feature claim FR-031
  while a second authorisation model kept disagreeing with the first. Recorded in FR-031,
  with the check split into an absence assertion and a presence control.

- **D-7 · `runs.replay` belongs to `approver` and above.** *(2026-09-13)* It was in the
  catalogue and in **no preset at all**, so replaying a past run would have been unreachable
  through every built-in role — a capability the product already has, grantable only by
  composing a custom role. A replay re-executes against real datasources and re-applies the
  run's effects, which sits nearer to arming than to authoring. *Not taken*: `admin` only,
  which treats a replay as an operational act like registering a datasource — defensible,
  and it puts routine re-runs behind the workspace's most privileged role. Also *not taken*:
  `author`, which would let anybody who can edit a flow re-run its production history. Also
  *not taken*: leaving it out of all three deliberately, which is honest but makes a shipped
  capability invisible until somebody composes a role, and reads as an omission rather than
  a choice. Recorded in `data-model.md` §2.

- **D-8 · An author does not get every read; three sensitive ones sit with `admin`.**
  *(2026-09-13)* The preset table said `author` = "all `*.read`". Read literally that
  granted the credential-name list, the full workspace audit history and active break-glass
  sessions — and the `admin` row then re-listed `secrets.read`, `members.read` and
  `breakglass.read` as things `admin` *adds*, which is only coherent if the author line was
  never meant literally. **`secrets.read`, `audit.read` and `breakglass.read` move to
  `admin`** (with `budget.read`); **`members.read` stays with `author`**, being the one read
  in the group with a real answer today and the one a member needs in order to find out who
  can approve for them. *Not taken*: the literal reading, which is simpler and makes the
  `admin` row redundant, at the cost of every automation author seeing the credential list
  and the whole audit trail. Also *not taken*: moving `audit.read` to `approver` on the
  grounds that a reviewer needs history — finer-grained, and the only variant where a role
  gains a *read* rather than a write, but it splits one feature area across three tiers.
  ⚠ **Nothing is taken from anybody**: all three routes are among the 106 that carry no
  guard at all today, so this is a free choice rather than a narrowing. Recorded in
  `data-model.md` §2.

- **D-9 · A platform role confers `members.read` and `members.grant` in every workspace.**
  *(2026-09-13)* Platform roles previously conferred **nothing** inside a workspace — the
  resolution algorithm said so in as many words — which produced a dead end: a
  `platform-admin` holds `platform.workspaces.write`, so they can **create** a workspace and
  could then put nobody into it, themselves included, because membership needed a super
  admin or `members.grant`. Every new workspace required a `SUPER_ADMIN_EMAILS` holder to
  become usable. It was also inconsistent rather than merely strict: the route that grants a
  **local account** access to a workspace writes the same table and is guarded by
  `platform.members.grant`, so the same act had two routes and two answers depending on
  which identity provider the person signs in with.

  *Not taken*: **keeping platform roles workspace-blind**, which preserves the property that
  nothing below the environment allowlist can reach a tenant — and accepts that
  `platform.workspaces.write` creates inert workspaces by design, and that the local-account
  route must drop back to super-admin-only to stop being an exception. *Also not taken*: a
  narrower **`platform.workspaces.bootstrap`** conferring `members.grant` **only where a
  workspace has no members**, which closes the dead end without granting standing authority
  over populated tenants — rejected as a third bootstrap concept to hold in mind, and because
  "no members" is a state an administrator can manufacture by removing the last one.

  ⚠ **The cost is real and is recorded rather than mitigated**: a platform administrator can
  assign themselves `admin` in any workspace and thereby reach any tenant's data. What bounds
  it is that the conferral is **exactly two permissions** — not `flows.read`, not
  `secrets.read` — so reading a tenant's automations requires *first* granting themselves a
  role, and that grant is a write on the record (FR-033). The sentence that is true is *"a
  platform administrator cannot see a tenant's data, but can give themselves the ability to,
  and doing so leaves an audit entry naming them"*. Never the unqualified *"a platform admin
  cannot access tenant data"*. Recorded in FR-020, FR-015 and `data-model.md` §10.
