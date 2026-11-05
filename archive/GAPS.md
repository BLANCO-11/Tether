# Gaps — what is known to be missing, wrong, or unproven

**As of 2026-08-03, branch `kestra-migration`, after Kestra Phases 0–6, *away from demo mode*
Stages 1–9 + 10.1, canvas-and-sandbox Stages 1–5, the drafting/canvas follow-up (I-57…I-60,
D-55…D-59), and the gap-closing batch of the same day (D-60…D-67, I-61…I-65).**

⚠ **Twelve entries closed on 2026-08-03** — **1.1**, 1.2, **1.3**, 3.1, 3.2, 3.3, **6.1**, 6.2,
6.3, 6.4 and the two upstream ones, **7.1** and **7.2**. Each is kept in place
marked **CLOSED** rather than deleted, because the reasoning for how it was closed is the part worth
keeping, and several of them closed in a narrower way than the original entry implied. **Read the
CLOSED text before assuming a gap is fully gone** — 1.2 in particular records a provenance and
deliberately refuses nothing on it, and 1.1 landing did NOT change that — see 1.2b.

Every entry here is something a harness, a test, a measurement or a code read actually found —
none of it is speculative. Where an item is **deliberate**, the reasoning is given, because the
most expensive mistake with a list like this is "fixing" something that was a decision.

Each entry names: **what**, **the evidence**, **why it is still here**, and **what fixing it
looks like**. Sorted by how much it would cost to be wrong about, not by effort.

> **How to read the four labels.**
> **OPEN** — a real defect or absence; fixing it is uncontroversial.
> **DELIBERATE** — a decision with a recorded reason. Changing it needs the reason to change first.
> **UNPROVEN** — the thing exists; the evidence that it works does not, or is one reading.
> **UPSTREAM** — it is not in this repo. ⚠ Both upstream entries are now CLOSED, so
> `../Foundry-Harness/` has been modified **twice**: defect A on 2026-07-31 and B+C plus the
> orphan reconciliation on 2026-08-03. The bar is unchanged — nothing Foundry-specific, every new
> field optional, every default the old value.

---

## 1. Identity and authorisation

### 1.1 There is no separation of duties, anywhere · **CLOSED 2026-08-03 for the role half** (D-67) · **ENFORCEMENT HALF CLOSED 2026-09-13**

> ⚠ **EXTENDED, NOT RE-CLOSED.** The 2026-08-03 entry closed the *role* half — roles
> exist and guard the approval routes. It did not close the **enforcement** half, and
> the sentence below (*"`requireWorkspaceRole("approver")` guards approve, revoke and the
> gate-3 decide route"*) was true of **25 routes out of 142**. The other **106 carried no
> authorisation check at all**: `DELETE /flows/:flowId` and `POST /flows/:flowId/test-run`
> among them, reachable by anyone who could sign in.
>
> **Closed 2026-09-13** by `20260910-130448-feature-rbac-permissions`. Every
> workspace-scoped route now declares a permission in a **generated** map, the guard is
> spliced per handler at boot, and a route that declares none **fails a test rather than
> shipping open**. Measured at the wire: `rbac:verify` reports **150/150 refused** for a
> signed-in person with no grant, **150/150 refused** in a workspace they are not in, and
> **150/150 permitted** for an administrator of it — the last number being the control,
> without which "refuse everything" scores 100%.
>
> ⚠ **IT CLOSED NARROWER THAN IT READS, AND THE NARROWNESS IS MEASURED.** This deployment
> has **zero members and zero capability grants across eight workspaces**, so the closure
> is **structural and unmeasured against real people**: SC-003 ("nobody's effective access
> changed") is *vacuous* here — trivially true over zero members. What is proven is that
> the routes refuse; what is not proven is that a population of existing users carried
> forward, because there is no such population. Recorded in `baseline-access.json` as
> counts rather than as an empty object, because an empty snapshot and a snapshot nobody
> took look identical.
>
> ⚠ **STILL NOT SEPARATION OF DUTIES**, and now for one more reason: a **platform
> administrator** can grant themselves a workspace role anywhere (D-9). The bound is that
> the conferral is exactly `members.read` + `members.grant`, so reading tenant data needs
> a *prior self-grant* that lands in the audit record. Say *"a platform administrator
> cannot see a tenant's data, but can give themselves the ability to, and doing so leaves
> an audit entry naming them."*


**Was.** Gate 2 and gate 3 refused *self*-approval and nothing else. There were no roles: anyone
who could sign in could approve anything, in any workspace.

**Now.** `workspace_members` — `author` | `approver` | `admin`, keyed on the identity **subject**
(an email can be reassigned). `requireWorkspaceRole("approver")` guards approve, revoke and the
gate-3 decide route, and `POST/DELETE /api/workspaces/:ws/members` manages it. The claim that is
now true and was not: **a person who has not been granted the approver role in this workspace
cannot approve in it.**

**⚠ It is STILL not separation of duties, and the phrase must still not be used unqualified**
(I-13). Anything holding `RUNTIME_JWT_SECRET` mints any identity — `e2e:ui` does — and a minted
identity with an approver row approves. This raises the bar from *"can sign in"* to *"can sign in
AND was granted the role"*. It does not defend against the signing secret.

**⚠ Every existing workspace starts with ZERO members and refuses approvals until claimed.**
Migration 0027 backfills nothing, deliberately: backfilling every identity as admin produces a role
model that grants the role to everybody. The two tempting shapes were both refused — *"no members
⇒ allow"* is a control that turns itself off wherever it was never configured, and *"the first
person to approve becomes admin"* is a gate that grants the role to whoever arrives. Claiming is
its own endpoint, recorded as `granted_by = 'bootstrap'` for ever, and on a deployment where anyone
can sign in **the first person to claim an unclaimed workspace owns it**.

**⚠ The check is at the ROUTE, not in the approval services**, and that is the opposite of this
repo's usual instinct. It is an authorisation decision about a *request* and needs `req.user`,
which `scenarios:seed` does not have and must not invent — putting it in the service would either
break every harness or be satisfied by a constant. A test reads the route tree and fails if any
route reaching `flowApprovalService.approve/revoke` or `stepApprovalService.decide` lacks the
guard, **and a second test asserts that scan finds those call sites at all**, so a rename cannot
leave it scanning nothing and reporting green.

**Gate 3's other half is still open** — see 1.1b.

### 1.1b Gate 3 has nobody to compare a decider against · **CLOSED 2026-08-04** (D-70)

**Was.** Gate 2 refuses self-approval because a revision has a recorded author. An execution did
not — it was started by a schedule, a trigger or a test run — so for gate 3 the role was the whole
control, with no second layer behind it.

**Now.** `flow_executions.requested_by` / `requested_by_subject` / `requested_by_kind`, written at
`begin` from a **pointer label** (`foundry_run_request`) the starting route records first — the same
shape `foundry_trigger_fire` already uses. `requireNotRunRequester()` on the decide route refuses a
decider whose identity **subject** matches the run's requester.

⚠ **The person never travels to Kestra.** A label lives in Kestra's database and renders in
`kestra-ui`, which has no tenant isolation and is internal-engineers-only; only the uuid goes.

⚠ **It compares SUBJECTS, not names.** Gate 2 can only compare names (I-32) and is the weaker half
of the pair for that reason.

⚠ **It stands down where there is genuinely nobody** — a schedule, a trigger fire, a harness, or a
run predating migration 0029 (`unknown`). Refusing those would block every historical pause on a
fact nobody recorded, and the fix people reach for is deleting the check.

⚠ **Still not separation of duties** (I-13). Say: *the person who started a run cannot also approve
its pause.*

### 1.2 `created_by` is self-asserted · **CLOSED 2026-08-03** (D-60, I-61)

**Was.** Gate 2's self-approval refusal compares the approver against `flow_revisions.created_by`.
That column was verified on the approver side only; the *author* side was whatever the writer said,
so the refusal could be walked past by writing a different name.

**Now.** `flow_revisions.created_by_kind` — `user` | `system` | `unknown`, NOT NULL with **no
default**. `authorOf()` in `middleware/identity.middleware.ts` is the **only** minter of `user`, and
a test asserts that by reading the source tree. A body `createdBy` is now an *input* to `authorOf`
and is **refused outright from a signed-in caller** (400) rather than overriding the verified
identity; a second test greps every route for a body value reaching anything else, and both of the
real historical defects (`…/steps/:stepId/regenerate` off `req.body`, `POST …/import` off
`input.createdBy`) were re-introduced to prove it still catches them.

**⚠ Three things this deliberately did NOT do.**
- **It is still not separation of duties, and 1.1 is still open.** No roles; anyone who can sign in
  can approve; anything holding `RUNTIME_JWT_SECRET` can mint an identity, and `e2e:ui` does.
- **The refusal is unchanged.** It still compares strings and still fires for a system author whose
  name matches. Refusing every system-authored revision would break `kestra:phase3`, the seeds and
  the whole regression net, which arm flows that way. What is new is the **record**:
  `flow_approvals.revision_author_kind` makes *"a second pair of eyes was possible and happened"*
  and *"there was nobody to be the first pair"* different rows.
- **The backfill is `unknown`, not `system`** — 37 existing rows. They came from browsers, harnesses,
  seeds and imports and nothing recorded which; that absence *is* the gap. `system` would assert no
  person was involved, which for the browser-authored rows is false.

### 1.2b `created_by_kind` is recorded but nothing refuses on it · **CLOSED 2026-08-04** (D-69)

**Was.** The column said whether authorship was attested and nothing acted on it. §1.1 was named as
the unblocker and was not sufficient on its own: refusing every `system`-authored revision still
breaks `kestra:phase3`, the seeds, the showcase and the scenarios.

**Now.** The policy this entry itself proposed: **an `approver` may approve a revision a person is
recorded as having written; approving one nobody is recorded as having written needs an `admin`.**
`requireProvenanceAuthority()` on the approve route.

⚠ **It escalates, it does not block.** The unattested case does not go away — that would be the
day-one refusal everybody routes around — it goes *up*, to somebody who can grant roles and who is
therefore the right person to say "I have read what this does and I am arming it anyway".

⚠ **At the ROUTE, so the regression net is untouched by design.** Every harness arms flows through
`systemAuthor()` and calls the service directly; in the service this policy would refuse the entire
net (D-67's argument, second application). What is governed is a person approving through a browser.

⚠ **Revoke deliberately does NOT carry it**, and there is a test pinning that: making an unattested
flow harder to turn *off* would point the control backwards.

⚠ Still not separation of duties (I-13).

### 1.3 A hand-registered datasource is only checked for read-only · **CLOSED 2026-08-03** (D-64)

**Was.** `POST …/datasources` refused a credential that can write (D-40, tested by the absent
grant) and constrained nothing else — not the host, not the database. So a **read-only** credential
on `foundry_parent` registered with zero findings, and read-only is not a mitigation there: it is
exactly the credential needed to read every workspace's secrets, encrypted DSNs, flow revisions and
generated fragments.

**Now.** `services/datasource-target.service.ts` runs on every `create` and every
credential-affecting `update`, **before** the privilege check — running D-40 first produces a clean
verdict on the one target that must never be stored. It asks the target **who it is** over the
connection being registered: `(system_identifier, current_database())` against Foundry's own, plus a
table-name signature for the parent, the Kestra database and the ops-api database. The parent
signature is derived from `db/schema.ts`, so a rename tracks it.

**⚠ Three things this deliberately did NOT do.**
- **The host allowlist this entry proposed as "the cheap 80%" is the WEAKER half, and shipping it
  alone would have been I-38 twice.** Unset it cannot fail; set, it is walked past by spelling the
  same database differently. It exists (`DATASOURCE_HOST_ALLOWLIST`), is `null` when unset rather
  than `[]`, and the verdict reports that state instead of passing silently. A test asserts that
  satisfying it does **not** rescue the control plane.
- **It is not a firewall.** Nothing stops the API container reaching a host; it refuses to *store* a
  datasource that resolves to one of three things.
- **This entry's second half stays open** — see 1.3b. What a tenant is allowed to point Foundry at,
  beyond "not at Foundry", is a product decision and nothing here answers it.

**Measured before building it**, because "it would be bad if" is not evidence: `foundry_parent` has
CONNECT revoked from PUBLIC (a property of the *cluster*, which nothing re-asserts), while `kestra`
and `foundry_ops` have the default ACL and `foundry_ro` connects to both — reading 0 tables, so
D-40 called it read-only. Signature scores across the whole cluster: every tenant database **0 on
all three**, `foundry_ops` 4, `kestra` 8, `foundry_parent` 21.

### 1.3b What a tenant may point Foundry at, beyond "not at Foundry" · **PARTLY CLOSED 2026-08-04** (D-72)

**Closed: the class that needs no policy.** Registration now resolves the host and refuses, on every
deployment and regardless of the allowlist, any target resolving to a **link-local** address
(169.254.0.0/16 — the cloud metadata endpoint on AWS, GCP, Azure and DigitalOcean — plus fe80::/10),
an unspecified/broadcast address, or a multicast group. Nothing legitimate is a Postgres or MySQL
server on any of those, so refusing them breaks nothing that ever worked. It runs **before** the
identity probe, because otherwise Foundry would already have made the request being prevented.

⚠ **Private ranges and loopback are deliberately NOT refused.** That is where this deployment's own
demo databases live; refusing them breaks `demo:seed`, `finance:seed` and the sandbox on day one, and
I-36 is the record of the last time a datasource check did exactly that.

⚠ **Two things remain open**, and the original text below is why:

- **DNS can move underneath it.** The check resolves at registration; the driver resolves again at
  use. Closing that needs the resolved address pinned into the DSN every connection path dials.
- **The policy question is untouched.** Whether a tenant may point at a third party's database or an
  internal service on the deployment network still needs an answer to what a tenant is, which is
  §1.1. `DATASOURCE_HOST_ALLOWLIST` is the mechanism and remains the weaker half (D-64).

1.3 closed the case where the target is Foundry's own state. It says nothing about a tenant pointing
a datasource at a *third party's* database, at an internal service on the deployment network, or at
a host the operator would not have chosen. The host allowlist is the mechanism and it is built; what
is missing is a policy, and a policy needs an answer to *what is a tenant* — which is 1.1.

---

## 2. The development sandbox (Stage 4)

### 2.1 No product workspace has a sandbox · **DELIBERATE**

**What.** HR, Finance and the showcase all read **production** on a draft run. Only the
`Sandbox (dev-data rehearsal)` fixture workspace has one. `pnpm --filter @foundry/server
sandbox:status` reports it: *3 of 4 datasources would have a DRAFT run read production.*

**Why.** `demo:verify`, `showcase:verify` and `scenarios:verify` all score a **draft** run
against an oracle computed from the real dataset. Turning fixtures on under them makes them fail
for a correct reason, and a harness that fails correctly is a harness people stop running.

**Fixing it.** Two separable pieces: (a) teach those harnesses to run their scored arm **live**
(they already approve and arm flows, so the machinery exists), then (b) provision sandboxes.
Doing (b) first breaks the net.

### 2.2 A draft run against a datasource with no sandbox reads production · **DELIBERATE**

**What.** It is not refused. Every batch carries `readFrom: "production"`, a warning names the
datasource, and the run view and datasource page render it — but the rows are real.

**Why.** A hard refusal on day one is a change everybody routes around, and what gets routed
around is the control. The property that holds is *if a sandbox exists, a draft run reads it, and
nothing in a request can change that*. See D-52.

**⚠ Never state this as "test runs no longer touch real data."** That is the sentence this gap
exists to prevent.

**Fixing it.** Becomes reasonable once 2.1 is done: a per-workspace `require_sandbox` that
refuses rather than warns. It must be a *workspace* setting an operator sets, never a request
parameter — the moment it is per-run it is not a control.

### 2.3 Fixtures do not carry expected outputs, so gate 1 is unchanged · **CLOSED 2026-08-04** (D-68)

**Was.** Gate 1 required one successful run and nothing else. The measured disaster this migration
exists to fix passed it: a script that *"hardcoded `period="2023-10"`, emailed 0 of 11, and still
exited 0"*. The programme's position section claimed fixtures would *"carry expected outputs…
upgrading gate 1 from 'it ran once' to 'it produced the right answer'"*, and that was not built.

**Now.** A flow declares **expectations** on its own model — claims about its steps' output — and
gate 1 additionally requires each one to have held on a successful run. Three assert types
(`rowCount`, `field`, `rows` with an `every`/`none` quantifier), nine operators, one optional
single-key `select`; no paths, no regex, no expression. They are declared through
`foundryApi.saveFlowRevision` (so a claim is part of what an approver approves), evaluated by
Foundry against the run's redacted outputs, persisted per run, and rendered on `/runs/[id]`.

**⚠ It closed NARROWER than the entry's own framing, in three ways worth reading before quoting it.**

- **It is per FLOW, not per fixture**, which is what the entry's "fixing it" paragraph recommended
  and it is the smaller of the two things "expected outputs" could have meant. A sandbox fixture
  still carries no expected output of its own; a flow carries claims about what it does with one.
- **An expectation is not an oracle.** It is written by the same person who wrote the flow and can
  be wrong in the same direction. It catches a flow drifting from its author's stated intent — the
  hardcoded-date failure — and it does **not** catch the units trap, which only an oracle sees.
  **Never say a passing expectation means a correct run.** Every screen showing one says so, and
  `ui-honesty-check.sh` fails if either drops the caveat.
- **A flow that declares nothing is unchanged.** Opting in is the whole mechanism, because a
  day-one refusal is a control everybody routes around (D-52's argument, again).

**Measured.** `pnpm --filter @foundry/server kestra:expect` — 26 assertions green at `2026-06` and
`2026-05`, with a negative control per assert type and per output shape, and both arms of the gate.
`e2e:ui` phase 5d drives the same thing over the client's own HTTP surface.

⚠ **`unevaluable` is a third state and does not satisfy the gate** — a claim nobody could check must
not read as one that held (I-38), nor blame the flow for the checker's blind spot.

### 2.3b Nothing generates a claim, and nothing suggests one · **SUGGESTING CLOSED 2026-08-04** (D-73)

**Suggesting is built.** `GET …/flows/:id/expectation-suggestions` derives claims mechanically from
the flow's own shape — a `datasource` step offers `rowCount gte 1`, a `tool` step `field failed eq 0`,
a `code` step one `field <key> present` per declared `outputKey`. No model is involved and none can
be. The editor renders them with the server's own caveat and a **Use** button that goes through the
same `addExpectation` a hand-typed claim goes through.

⚠ **Every suggestion is deliberately WEAK and there is a test pinning that.** A suggestion reading
`rowCount eq 11` would be the system inventing the very fact the claim exists to pin down, and its
author would accept it because it looks specific. The numbers have to come from the person.

⚠ **Generating stays OPEN, and should.** Asking the drafter what its own flow should produce is
`generation-audit.service.ts` with a new name — that service marked `clean` a script which emailed 0
of 11 people, and it was deleted for it. If it is ever built, the claim must come from the GOAL a
person typed rather than from the flow the model produced, and the two must not share a context
(D-23).

### 2.3b-orig (the original entry, kept for its reasoning)

Expectations exist and are hand-written. The drafter has never heard of them, so a generated flow
arrives with none — and the flows most likely to drift are exactly the generated ones. Two separate
questions sit behind this and only the first is cheap:

- **Suggesting.** The shapes are mechanical from the model: a `datasource` step could offer
  `rowCount gte 1`, a `tool` step `field failed eq 0`, a `code` step one claim per `outputKeys`
  entry. That is a palette, not inference, and it needs no model.
- **Generating.** Asking the drafter for claims is asking it to grade its own work, which is the
  `generation-audit.service.ts` failure mode with a new name — it marked `clean` a script that
  emailed 0 of 11. If it is ever done, the claim must come from the GOAL the person typed, not from
  the flow the model produced, and the two prompts must not share a context (D-23's argument).

### 2.4 The sandbox is not a faithful copy in three stated respects · **DELIBERATE**

- **A view becomes a plain table.** Introspection records a view's *columns*, not its definition,
  so a view that pre-resolves a join is filled directly and its relationship to the base tables is
  not reproduced. A flow reading both is not testing that relationship.
- **UNIQUE constraints are absent.** Introspection records primary keys only, so the sandbox is
  *more* permissive than production — a fixture can hold two rows the real database would refuse.
- **The fixture's date window ages.** Frozen rows dated at provisioning time drift out of the
  period anyone asks for, and a flow then reads zero rows (I-56). `SandboxStatus.dateRange`
  reports the actual span; re-dating silently would be the "a fixture that moves under a test"
  failure the freeze exists to prevent.

**Why not inferred.** Guessing a UNIQUE from a column name creates constraints production does
not have — the same error in the other direction.

**Fixing it.** All three want introspection to record more: `pg_get_viewdef`, `pg_constraint`
where `contype = 'u'`. That is a change to the manifest's own input, so it has to be checked the
way I-40 was — `refFingerprints()` hashes what introspection produces, and moving those hashes
suspends every armed flow in every workspace.

### 2.5 MySQL datasources cannot have a sandbox · **DELIBERATE**

Refused by name at provisioning. The DDL emitter, the role model and all seven taxonomy queries
are Postgres. A half-working sandbox is exactly the failure mode the stage is about.

### 2.6 The taxonomy is a reading on one model and one schema · **UNPROVEN**

2 of 2 runs of `google/gemma-4-26B-A4B-it` passed all seven categories first attempt against
`hr_demo`'s 7-table shape. That is a measurement, not a property. A wider schema, a different
model, or a domain with no numeric columns are all untested — and `near_threshold` in particular
is tuned (2% of a column's range, a round-number step) in a way a different shape could make
impossible to satisfy.

---

## 3. Client / API surface

### 3.1 `test-run` and `fire` hand the client a Kestra id · **CLOSED 2026-08-03** (D-61)

**Was.** `POST …/flows/:id/test-run` returned `kestraExecutionId` **and** `namespace`;
`POST …/triggers/:tid/fire` returned `kestraExecutionId`, against R5 and `ExecutionView`'s own
docblock (`ISSUES.md` I-22, `e2e:ui` MISMATCH at step 18).

**Now.** Stripped **at the route boundary, not in the service**. The services still return the
engine ids for in-process callers, which is what `kestra:phase3` reads — so the harnesses are
untouched and the HTTP surface carries the Foundry id only. `e2e:ui` step 18 verifies it by
scanning the response body for engine-shaped values rather than by checking two field names, so a
third leak under a new name is caught too.

### 3.2 An execution's `flowId` is the Kestra slug · **CLOSED 2026-08-03** (D-61, I-23)

**Was.** Both `list()` and `get()` set `flowId: r.kestraFlowId`. A client filtering the runs list by
the uuid it held got **zero rows**, and a deleted-then-recreated flow reused the slug — so
executions of two different flows were indistinguishable. `e2e:ui` hit exactly that.

**Now.** `flowId` is the Foundry uuid and **nullable** (flowless Phase-1 history exists); the engine
slug is served as its own field, `flowName`, because that is what the UI renders as a label and
removing it silently would have cost `/runs/[id]` its page title. Both routes project through **one**
exported function, `executionBase()` — I-23 was two identical bugs, and fixing one alone would have
left the routes disagreeing about what `flowId` means, which is worse than both being wrong.

⚠ **`e2e:ui` step 20 is now a COMPUTED comparison.** It used to hardcode `verdict: "MISMATCH"` and a
paragraph of prose — a constant cannot notice a regression, and the prose had already drifted into
nonsense (*"the KESTRA flow id X rather than the uuid X"*, the same string twice, because this flow's
slug is derived from its uuid).

### 3.3 The trigger fire audit trail has no client method · **CLOSED 2026-08-03**

`foundryApi.listTriggerFires` → `lib/api.ts` → `components/automation/TriggerFires.tsx`, rendered on
the triggers page. ⚠ **`e2e:ui` decides this by reading the client source**, both layers — the
transport and the module a component imports. Relabelling the verdict would make the report agree
with itself, which is the one thing that harness's rule exists to prevent. It **fails closed**: a
bad path reports the gap as still open, which it did on the first run.

### 3.4 The H.1 trigger type inconsistency · **DELIBERATE**

A trigger created as **Email** reloads as **Webhook** — a three-layer type mismatch. Left unfixed
on purpose: triggers were rewritten in migration Phase 3 and the old bug is not worth chasing.
**Do not reproduce it**; do not spend time fixing it.

### 3.5 A datasource credential cannot be fetched from a vault · **DELIBERATE 2026-08-10** (D-117, I-122)

**What.** There is no way to point Foundry at HashiCorp Vault, AWS Secrets Manager or Azure Key
Vault for a datasource's password. A connection's secret is typed once and stored encrypted, and
`/data-sources/new` says so on the step where the choice used to be.

**What it replaced, which is the reason this entry exists.** The choice *was* offered, with complete
per-provider field sets (`lib/vault-fields.ts`: address, mount, KV version, secret path, namespace,
AppRole, region, ARN, tenant/client id, plus a key map onto the connector's own secret fields), and
it was wired to **nothing**. Measured: `buildPayload` dropped the connector's secret fields and
attached `payload._vault` + `payload._credential_source`; `assembleConnectionString` reads only
`connection_string|url|dsn|uri`, `host`, `port`, `database`, `username|user`, `password`; and
`grep -rn "_vault\|_credential_source" packages/server/src` returned **zero hits**. So picking it
assembled a **password-less DSN** and the person got `400 could not verify that this credential is
read-only` — a true message about the wrong subject, which reads as a bug in the gate rather than as
an unsupported choice. `components/keys/CredentialForm.tsx` carried a second copy of the same mode.

**Why refusing is the right answer rather than the cheap one.** It is not the three provider SDKs, a
credential-for-a-credential store and a cache-invalidation story — though it is those too. **It
cannot pass the gates.** `assertRegistrableTarget` (§1.3, D-64) and `assertReadOnly` (D-40) both
open the connection **at registration, from the registering process**. A vault-sourced DSN is not
known until execution, so a vault datasource could only be stored **unverified** — precisely what
`assertReadOnly`'s own docblock refuses: *"register now, verify when it comes back means the row that
exists is the unverified one, and the check that would have caught it runs at a moment nobody is
watching."* Vault is not a feature with a cost; it inverts the strongest control on this path.

**And leaving it inert was the worst of the three options.** `lib/connectors.ts`'s header states the
rule — *inert is worse than refused, because a refusal names the reason in front of the person who
chose it, while inert surfaces weeks later as a broken flow* — and that rule is why MongoDB, S3 and
GCS were **deleted** from the catalogue on 2026-08-04 rather than styled as coming-soon. This is the
same rule applied one step upstream, to a credential mode instead of an engine.

⚠ **`Connection.credential_source` was renamed in the same pass and is NOT about this.** It is
derived from `secretEnvName` — whether a datasource declares a credential *name*, which the manifest
renders as `<secretRef>` and `/keys` audits — and its value is now `"secret_ref"`, not `"vault"`.
The two met in production code: `/keys` passed that field in as `CredentialForm`'s `initialMode`, so
declaring a name reopened the sign-in form in the mode that could only build a password-less DSN.
**Two things called "vault" meaning different things is how this survived review.**

**Held in place by** four assertions in `scripts/ui-honesty-check.sh` (the file is gone, the wizard
cannot name `_vault`/`VAULT_PROVIDER`, the wizard states the refusal on screen, and the refusal's
`findings` are rendered), each perturbation-tested to fail, plus `lib/manifest-form.test.ts`.

**Fixing it** would mean a *second* registration-time verification path: resolve the reference once
at registration, run both gates against what came back, and then accept that the credential the
gates saw is not necessarily the credential a run will get — which is a weaker claim than the one
this product makes today. Do not build it as a UI option first.

---

## 4. Controls that are weaker than they look

### 4.1 Two of the canvas's ten controls are not refusals · **DELIBERATE**

`kestra:canvas` reports **7 fired · 2 passed · 1 N/A · 0 missed**, and the harness says which:

- **Fan-out cap — N/A.** It cannot be checked statically: an authored flow declares an
  *expression*, not an item count. The real bound is `stepBatchSchema.params.max(1000)` at
  runtime.
- **An appended gate is a legal flow.** Nothing server-side can refuse one. The control is that
  the canvas can only *splice* (`spliceApproval` is now the single implementation), that the
  finding is shown, and that emission order is asserted against the compiler.

Recorded rather than faked, because a control that cannot fail is worse than none (I-38).

### 4.2 A tool call whose response was lost had its effect · **DELIBERATE**

Runtime retry is safe for `tool` steps because `stepExecutionService.tool` throws only when
*every* item failed, so "7 of 10 sent, retry sends all 10 again" is structurally impossible. The
residual is a call that succeeded and whose response never came back. Stated, not hidden.

### 4.3 `endpoint_connectivity` passing with a sandbox key does not prove production connectivity

A tool with `sandbox_value_enc` set is smoke-tested against the sandbox credential, so the green
result is about the wrong key. Deliberate (it keeps production keys out of agent workspaces), and
the caveat travels with it.

---

## 5. Generation quality

### 5.1 Goal-mode drafting is unreliable on the configured model · **UNPROVEN → measured, and poor**

`outline:measure`: outline mode kept the given shape **2 of 3** (0 drifted, 1 produced no
parseable draft); the goal-mode control reached the same shape **0 of 3** — it produced twelve
steps for a five-line outline. Separately, on the I-53 test goal, goal mode failed after three
attempts while outline mode produced a flow that ran green end to end.

**Why outline is the default** (D-47). This is not a bug to fix so much as the reason the product
is shaped the way it is — but it does mean *"describe your goal and we'll build it"* is the
weakest path in the product, and it is the one a new user reaches for first.

**Fixing it.** A better model is the obvious lever and the least informative. The measurable one
is whether the redraft loop's findings are specific enough to converge; I-47 (a bad step kind
reporting itself as `steps: Required`) was one instance of them not being.

⚠ **Partly acted on, 2026-08-03, and the honest result is "the reasons changed, the rate did
not."** `draft:measure` instruments attempts, wall clock and the reason each rejection happened.
It found that most attempts were being spent on things that were not the model's fault: I-57
(the expression scanner rejecting valid jq — **25 of 26 findings in a run**), I-58 (a schema the
prompt never stated), D-56 (22 findings fed back at once) and D-57 (a draft truncated at a
fragment-sized token ceiling). All are fixed.

Outline mode went from 0/1 at 3.0 attempts to **2/2 at 1.0 attempts**, which is the arm most
people use. **Goal mode did not become reliable**: 3/3, 1/3 and 1/6 across three runs, at
~2.3–2.8 attempts. The run-to-run variance is larger than the change. What is different is that
the remaining rejections are *correct* — a genuine nested `{{ }}` or a genuine wrong output
shape — where before the validator was misreading valid expressions.

**What is left, and it is the real remaining lever.** A rejection re-asks for the **whole flow**:
~25 s to re-emit twelve steps because one expression in one step was wrong. A targeted
"regenerate this expression" call would be seconds. That is a new inference shape and a real
design question (it risks flow-level coherence), so it is a gap and not an oversight.

### 5.2 The refusal measurement is five rounds on one model

`kestra:refusal`: **5 refused, 0 invented**, against a control contract that produced clean code
5 of 5. Read I-24 before quoting it — the first run scored 0 refusals because Tether's transport
was destroying the channel, and it failed *asymmetrically*, so the transport looked fine whenever
the answer was yes.

---

## 6. Operations

### 6.1 No metrics and no alerting · **CLOSED 2026-08-03 for the signals half** (D-66)

**Was.** No signal that a scheduled flow stopped firing, that the agent poller had stalled, that the
staleness sweep was not running, or that M3 budget slots were leaking. Every one of those failure
modes was found by a person running a harness by hand.

**Now.** `GET /api/signals` → `services/operational-signals.service.ts` answers exactly those four
questions, each with a state, a detail a person can act on, and a **`caveat` naming what it cannot
detect**. Distinct from `/api/health` (D-62), which answers *"can this process serve a request"* —
every component there can be green while all four of these are failing, because none of them is a
reachability failure.

⚠ **AUTHENTICATED, unlike `/api/health`, and never to be merged into it.** This route names
workspaces and flows, which is a description of the customer base. The merge is tempting and it
either drags tenant names onto an open route or puts the liveness probe behind a credential.

⚠ **`unknown` is a state, and it is the difference between this and a dashboard that lies.** Two
signals calibrate from history and have nothing to say until there is some; the sweep signal is
in-memory and knows nothing for one interval after a restart. Reporting `ok` in those windows is how
a monitor teaches people to ignore it. Verified live: immediately after a restart the rollup is
`unknown` with *"the scheduler started recently and has not reached its first sweep yet"*, and flips
to `ok` — *"last sweep 4s ago — checked 4, suspended 0"* — once one has actually run.

⚠ **The scheduled-flow period is LEARNED, never parsed from the cron.** A cron parser tells you what
a flow was *configured* to do, and the failure being looked for is a flow not doing it; observed gaps
also catch a schedule that has been firing at the wrong cadence all along. It needs ≥3 runs and uses
the **widest** observed gap, because a weekday-only schedule has a legitimate weekend gap and a
median-based threshold would page somebody every Monday.

⚠ **The slot signal does NOT ask Kestra**, and says so. `reconcileRunning` is the authority and costs
an engine call per row — its own docblock says to call it only on the refusal path, and a monitoring
endpoint polled every 30 s must not be that path. So it reports the *shape* of a leak, not a
confirmed one.

### 6.1b Nothing is wired to those signals · **CLOSED 2026-08-04** (D-71)

"A reader" turned out to be two things and only one of them is a screen:

- **A person** — `SignalsPanel` on `/dashboard`, above the numbers, because "did the automations do
  the right thing" is the wrong question to open with when the answer might be "they stopped running
  a week ago". Every signal's `caveat` is rendered verbatim, including on the green ones.
- **A machine** — `pnpm --filter @foundry/server signals`, which exits **0** on ok/unknown, **1** on
  warn/alarm and **2** when the endpoint could not be read at all. That third code matters: *"the
  system is unhealthy"* and *"I could not find out"* need different responses.

⚠ **`unknown` does not page**, matching the server's own ranking (D-66). A signal with nothing to go
on would otherwise produce a permanent low-grade alarm on every fresh deployment — and a permanent
alarm is one people mute, after which the real one is muted too.

⚠ **No alerting vendor is integrated, deliberately.** Every deployment already has something that
runs a command on a timer and pages on a non-zero exit. Picking one here would be inventing a
deployment this repo does not have, and the wrapper would be the thing nobody wired up.

### 6.1b-orig (the original entry, kept for its reasoning)

`GET /api/signals` gives an alert the answers it would need; it is not an alert. Choosing where a
page goes — Prometheus scrape, a cron that curls it, a paging provider — needs a deployment target,
which is the same thing the rest of Stage 10 is waiting on. ⚠ Until something reads it, this is a
control that fires into a void: the endpoint can report `alarm` for a week with nobody looking.

### 6.2 Health checks answer for the database and Tether only · **CLOSED 2026-08-03** (D-62)

**Now.** `GET /api/health` reports five components — own database, **migration state**, Kestra,
ops-api and Tether — each with status, latency, and a **`caveat` naming what it cannot detect**.

⚠ **`status` stays `ok` while a non-critical component is down, and that is the decision, not an
oversight.** Only the process's own prerequisites (its database, its migrations) are `critical`.
Taking the API out of the load balancer the moment Kestra becomes unreachable removes the only
surface that could *tell anyone why* — and every read, every flow list and the diagnosis itself
still work. `serves` answers "can this process serve requests"; the component list answers "is
everything it depends on healthy", and those are different questions that one boolean was
conflating.

⚠ **The caveats are in the payload, not in a doc**, because this endpoint's whole failure mode is
the false green. Tether's says so by name: *"`llmConnected` is derived from Tether listing models —
a documented FALSE GREEN … read `up` as 'the runtime answered', never as 'the runtime works'."*
Every probe is timeout-bounded (a health check that hangs is worse than one that lies) and the
result is cached with its **age** in the response.

**What it still cannot say**: that a flow can execute (the Docker runner, the fragment base image on
the host daemon and the namespace boundaries are unchecked — `kestra:check` is what proves those),
or that a tool call will authenticate (the five per-service credentials are derived separately).

### 6.3 Retention is also the replay window · **CLOSED 2026-08-03** (D-63)

**Now.** `services/retention.ts` — one module, still reading `config.kestra.retentionDays` and
nothing else, exporting the coupling as **one sentence every surface quotes** and a `replayWindow()`
that says how much window a *specific run* has left. `ReplayControl` states it before anyone plans
around it, and a run near the edge says so rather than waiting for the 410.

⚠ **The "expiring soon" threshold is a FRACTION of the window, not a fixed week.** A fixed 7 days
against a 4-day retention warns nobody in time; against a 365-day retention it warns from day 358.
Both are the warning quietly losing track of the thing it warns about.

⚠ **No second source for the number, and the tests enforce it** by reading it back from
`retentionDays()` rather than writing `30` — so a deployment setting `KESTRA_RETENTION_DAYS=7` does
not fail the suite, which is exactly what a hardcoded expectation would do, and the "fix" for that
is a second default.

### 6.4 Redis is dead · **CLOSED 2026-08-03 — removed**

Service, volume declaration, `REDIS_URL`, `config.redisUrl` and the `backup.sh` manifest line, all
gone. Measured first: `DBSIZE` 0, no client dependency, one definition and no reader.

**Why removing beat leaving it.** A healthy container is the most convincing possible evidence of a
working dependency — it answered `PING`, `depends_on` made the server wait for it, `REDIS_URL` sat
in the environment. Every signal said "in use"; only a grep said otherwise.

⚠ **`kestra:check`'s `"Foundry redis"` DENY probe was replaced, not deleted, and it had stopped
being a control twice over.** With Redis gone the hostname does not resolve, so it would have passed
because there was nothing there (I-38). And Redis never spoke HTTP, so `curl` could not tell "no
route" from "connected and got nothing" even before that. It now probes
`http://ops-api:4004/healthz` — live HTTP, on `default`, not on `kestra-net`, holding the outbox,
the tickets, the call log and the one billable outbound credential. Verified at the wire both ways:
**200** from the parent container, **000** from Kestra.

⚠ **The volume was not deleted.** `infra_foundry_redisdata` is an orphan Compose now ignores;
`docker volume rm infra_foundry_redisdata` reclaims it. A compose edit that silently deletes a
volume is the wrong default even when the volume is empty.

---

## 7. Upstream (Tether)

### 7.1 `activeRuns` has no boot reconciliation · **CLOSED 2026-08-03** (upstream `f4ac654`)

**Was.** `activeRuns` is an in-memory Map holding a run's timers and harness handle. A restart
orphaned every run it described at `status:"running"` for ever, and Foundry's poller then polled
an orphan to its own deadline.

**Now.** Tether schema 21: `runs.owner_instance` plus an `instances` table, every process
heartbeating every 15 s, and boot reclamation that closes out runs whose owner is provably gone.
It fired on real data at first boot — **5 runs reclaimed**, all `owner=none`, every one stuck at
`running` since a restart.

⚠ **The obvious fix was worse than the bug and was not taken.** "On boot, fail every non-terminal
run" passes the obvious test and, with two processes, terminates the runs of the sibling still
working on them. Reclamation touches only owners that missed their heartbeats, plus rows with **no**
owner (pre-schema-21, so nothing can ever claim them). A live sibling's runs are left alone, and
that is the case the upstream test asserts most loudly.

⚠ **This did NOT make Tether multi-replica**, and the entry should not be read that way.
`cancelRun` and `findRunBySession` still need the in-process handle, so HITL and cancel work only
on the owning instance. What changed is that this is now *said*: `POST /api/run/:id/cancel`
returns a 409 naming `ownerInstance` instead of the misleading "run is not in flight".

### 7.2 Agent-step defects B and C · **CLOSED 2026-08-03** (upstream `f4ac654`)

`../Foundry-Harness/plans/agent-step-run-contract.md`, all three defects now done. **B** is
`expects: "script" | "answer"` on `POST /api/run`, defaulting to `"script"` — today's behaviour
exactly. **C** keys `deriveStatus` off the same declaration. Taken **together, in that order**, in
one change, and after A (which landed 2026-07-31).

**Foundry's side is one field**: `agentRunService` sends `expects: "answer"`.

⚠ **`profileId` was never the mitigation and this is.** 8.3 passed `mode: "chat"`, `skills: []` and
it looked protective; instrumenting Tether withdrew that (**I-34 round 3** — the nudge fired **27 of
27** in both arms). `skills: []` could not remove a mandatory skill. `expects` can.

**Measured as a matched pair on the live runtime** — same prompt, same profile:
`expects: "answer"` → **`succeeded`**, no nudge logged; the control → `needs_review`, nudge logged.
Both answered correctly; without the control the `succeeded` could have come from anywhere.

⚠ **`outcomeOf` deliberately still tolerates `needs_review`**, and removing that branch would be a
tidy that breaks things. An older Tether ignores `expects` and returns `needs_review` for every
answer run — a version coupling on a runtime in a different repo and a different compose stack. And
`needs_review` now *means* something on an answer run: the run completed cleanly and the agent said
**nothing**.

---

## 8. Deferred by decision, listed so nobody re-discovers them

| | |
| :--- | :--- |
| **Phase 5.4 — `FlowEditor` / `StepPalette`** | Half un-deferred. Stage 7 built a *review* surface and Stage 5 built a *canvas builder*; a general step editor is still deliberately absent. Un-defer when real goals have produced edits a review surface cannot make. |
| **`ForEach` per-item loops** | Refused by M1. Array-shaped fan-out already exists; per-item multiplies taskruns and buys nothing. |
| **External SaaS integrations** | Scope, not architecture. The tool layer is already the right shape. |
| **Self-service named-query SQL** | A curated catalogue is a legitimate design, not a gap. |
| **`generation-audit.service.ts`** | Deleted, and only deletable because `datasource` steps run *named* queries rather than generated SQL. ⚠ If a generated-SQL step kind is ever introduced, resurrect the audit for that kind alone — and keep its `attempted_write` negative tests. |

---

## What is NOT a gap

Listed because each has been mistaken for one at least once.

- **`manifest-builder` emits a hardcoded `isDummy: false`.** That key is inside
  `refFingerprints()`'s hash; dropping it suspends every armed flow in every workspace. **Do not
  tidy it away** (I-39/I-40 family).
- **`StepStrip` duplicates the canvas.** It is the canvas's text equivalent. A canvas that is the
  only representation is a flow some people cannot read.
- **A refusal returns 200.** Filing the most useful diagnosis this system produces under "error"
  is how a client renders it as a failure and retries — and re-asking is how a correct
  `insufficient_contract` becomes an invented `period="2023-10"` on attempt 2.
- **`begin`, `complete` and `_await` show up on the run graph.** They are labelled `platform`, not
  hidden: `begin` is where the approval gate and the budget check happen, so a run that failed
  there failed for the most interesting reason available.
- **The `Sandbox (dev-data rehearsal)` and `HR (alt — swap rehearsal)` workspaces.** Both are
  `kind: "fixture"`, both are required by a harness, and both are shown with a badge rather than
  hidden — a hidden workspace is one nobody notices has broken.
