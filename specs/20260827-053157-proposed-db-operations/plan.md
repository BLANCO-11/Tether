# Implementation Plan: a newly onboarded datasource becomes callable without a person writing SQL

**Branch**: `20260827-053157-proposed-db-operations` (not started) | **Date**: 2026-08-27 |
**Spec**: [spec.md](./spec.md)

**Reserves**: **D-169…D-197** and **I-171…I-178**. (Highest in use at time of writing: **D-168**,
**I-170**. Numbering is one repo-wide sequence — see `CLAUDE.md`.)

⚠ **The reservation was EXTENDED from D-193 to D-197 during P2 and P3**, and only for decisions this
document had explicitly deferred or actively got wrong: **D-194** and **D-196** are the two T09a and T17a
name as open, **D-195** is T16's mechanism (described by outcome, not by means), and **D-197** is where this
plan's own Phase-3 file table contradicted D-179. `D-194`…`D-197` were verified unclaimed across `specs/`
and `docs/` before being taken.

⚠ **D-180…D-204 were added DURING implementation**, not at planning time — the code forced choices
this document had not settled. They are Decisions 12–36 below (**D-180…D-183** from P0, **D-184…D-188**
from P1a, **D-189…D-193** from P1b, **D-194…D-196** from P2, **D-197** from P3, **D-198…D-201** from
P4, **D-202…D-204** from P5), and each says what it contradicts. ⚠ **P4's four are not implementation choices about the
feature — they are choices about how it is MEASURED**, which is the half a reader is most likely to
take on trust. The running log is [session-notes.md](./session-notes.md), which is also the handover file if a
session dies mid-feature.

---

## Summary

Make a datasource that has been onboarded but has no readers **say so honestly**, then let a model
propose the missing reader as a **`DbOperationSpec` a person approves** — never as SQL, and never
without approval.

Five phases, each shipping value alone. ⚠ **Phase 5 was added AFTER Phase 4 measured Phase 3 as not
working** — it is not a planned extension, it is the finding:

| Phase | What | Ships without the next? |
| :--- | :--- | :--- |
| **0** | The honest refusal — one prompt rule, one sharper finding. **No proposer.** | ✅ Yes — this is most of the reported pain |
| **1** | `proposeOperation()` behind a route. No UI, no chat. | ✅ Yes — reachable by API, testable in isolation |
| **2** | The approval surface — **readback-led**, SQL collapsed, no sample rows. | ✅ Yes — completes US2 |
| **3** | Chat surfaces a proposal as a setup step. | ⚠ **Built, and it does not fire** — see Phase 5 |
| **4** | Re-take the measurements Phase 0 invalidates. | ⚠ **Not optional** — see Decision 8 |
| **5** | One `CHAT_RULES` rule so the op call reaches Phase 3's machinery at all. | ⚠ **Without it US3 is dead code** — see Decision 34 |

**The load-bearing shape**: the model fills in a form; existing, tested, deterministic code turns that
form into SQL. No LLM ever emits SQL text.

---

## Technical Context

**Language/Version**: TypeScript, Node ≥ 22, ESM.

**Primary Dependencies**: **None new.** zod, Drizzle and the existing `InferenceClient` cover it. The
`DbOperationSpec` schema, its compiler, its structured findings and its check-without-saving route all
already exist — this feature adds a *producer* for an input shape that already has a consumer.

**Storage**: Postgres (`foundry_parent`). **No migration.** `db_operations` is unchanged; a proposal is
transient and is never persisted.

**Testing**: vitest. Unit tests for the proposer's parse/refusal/feedback loop; a source-reading test for
FR-006; a fingerprint measurement for FR-015; client render tests per `ui-honesty-check.sh`'s rule that
every page under `(app)` has one.

**Target Platform**: existing containers. No new service, no new port.

**Project Type**: web — `packages/server` + `packages/client`.

**Performance Goals**: a proposal is one inference call over a schema-sized prompt. At the measured
~35 tok/s decode and a spec of a few hundred tokens, **~10–20 s** is the expected shape. It is not on the
generation critical path — propose → approve → regenerate is three separate user actions (Decision 6).

**Constraints**: `CHAT_TURN_MAX_TOKENS` stays 1024 (FR-016). No new egress. No new secret. Read-only DSN
unchanged. `compileOperation` unchanged.

**Scale/Scope**: ~1 new server service, 1 new route, 1 new client panel, 1 chat response kind. Bounded by
FR-014.

---

## Constitution Check

| Article | Status |
| :--- | :--- |
| **I. Spec-First** (NON-NEGOTIABLE) | ✅ This spec + plan precede any source change. `tasks.md` via `/speckit-tasks` before `/speckit-implement`. |
| **II. Test-First** | ✅ Acceptance scenarios in `spec.md` define the tests. FR-006 (source-reading), SC-003 (fingerprints), SC-004 (nothing written) and SC-005 (token ceiling) are each a named test. |
| **III. Code Review** | ✅ `/speckit-comply` before review. ⚠ This feature adds a model-authored artefact to a **security boundary**; the reviewer must read Decisions 1, 2 and 7 specifically. |
| **IV. Simplicity** | ✅ **No new dependency, no new abstraction, no new layer, no migration.** The one new module is a producer for an existing input shape. Phase 0 ships real value as two edits. |
| **V. Observability** | ✅ Every refusal names its boundary (FR-002, FR-007). Every fed-back finding is verbatim (FR-009). ⚠ Decision 9 covers what must **not** be logged. |
| **VI. Branch Discipline** | ✅ One timestamp branch = this directory. Branch created by `/speckit-specify`, never by hand. |
| **VII. Documentation Currency** | ✅ Phase 4 updates `CLAUDE.md` and `WORKFLOW-CREATION-AND-GENERATION.md` in the same PR. |
| **VIII. Secrets Hygiene** (NON-NEGOTIABLE) | ✅ **Strengthened, not merely preserved** — FR-005 forbids the proposer receiving a DSN or database handle at all, asserted against its own source. |

**Complexity deviations**: none. Nothing here requires justification under Article IV.

---

## Project Structure

### Documentation (this feature)

```
specs/20260827-053157-proposed-db-operations/
├── spec.md          # what and why
├── plan.md          # this file
├── tasks.md         # ← /speckit-tasks
└── contracts/
    └── operation-proposal.md   # the two response channels, verbatim
```

### Source Code

```
packages/server/src/
├── services/
│   ├── db-operation-proposal.service.ts   # NEW — the proposer. Imports schemaRepo +
│   │                                      #   dbOperationService.check + inference. Nothing else.
│   ├── db-operation.service.ts            # UNCHANGED (compiler, check, create)
│   ├── flow-generation.service.ts         # DRAFT_RULES + unknownRefs  (Phase 0)
│   └── flow-chat.service.ts               # one new response kind      (Phase 3)
└── routes/
    └── datasources.ts                     # POST /:dsId/operations/propose  (Phase 1)

packages/client/src/
├── components/data/
│   └── DbOperationsPanel.tsx              # the approval dialog          (Phase 2)
└── app/(app)/flows/new/page.tsx           # proposal offered from refusal (Phase 2)
```

**Structure Decision**: the proposer is its own module rather than a function inside
`db-operation.service.ts`, for the reason `flow-refine.service.ts` is its own module: **the compiler must
stay a file with no path to inference.** `db-operation.service.ts` not importing `inference` is currently
a greppable property of this codebase (see spec, "The gap"), and it must remain one.

---

## Decisions

### Decision 1 — The proposer fills in a form; it never writes SQL. (**D-169**)

The entire safety argument is that `compileOperation` — deterministic, existing, tested — is the only
thing that produces SQL, and it emits `SELECT` only.

Two properties survive **unchanged** because the proposer supplies none of the SQL's words:

* **Identifiers are metadata, never input.** Every table, column and join side is resolved against the
  introspected `schemas` rows. An unresolvable one is an `OperationCompileFinding` carrying `identifier`
  and `available[]` — not an interpolation and not a 500.
* **Values are positional parameters.** A filter binds to `$n` in `filters[]` order; `params_schema` is
  *derived* from the filters. A parameter cannot become SQL.

⚠ **Do not "simplify" this later by letting the proposer emit SQL and validating it with
`checkSqlShape`.** That inverts the argument: a shape check over model-authored SQL is a blocklist, and
this design's whole claim is that it is not one. It would also resurrect every consequence the spec lists
under "The gap".

### Decision 2 — Nothing is written until a person saves, and the save re-verifies. (**D-170**)

`proposeOperation` returns a value. It has no repo handle for writes.

The confirmation follows `verifyAcceptedTransform`'s rule exactly: **the submitted spec is re-run through
`check()` and `create()`**. A proposal id is not authorisation. An edited spec is evaluated as fresh input.

⚠ **Why re-verification is not paranoia here.** The dialog is editable *by design* (FR-012), so the spec
that arrives at save is frequently **not** the spec that was proposed. A server trusting "already
approved" would be trusting a client-side edit it never saw.

⚠ **And a proposal must not be persisted "so the person can come back to it."** A stored proposal is a
half-created ref with a lifecycle, and the review it is waiting on is exactly what makes it safe. If
resumability is wanted later, that is its own decision — do not add a table by reflex.

### Decision 3 — Two channels, and `insufficient_schema` is never retried. (**D-171**)

The fragment generator's shape, one subject along:

```json
{"status":"ok", "name":"overdue_invoices", "description":"…", "spec":{…}}
{"status":"insufficient_schema", "missing":["a due date column"], "reason":"…"}
```

**A parse that reads a status-less response as `ok` deletes the refusal channel** — that is
`parseFragmentResponse`'s own warning, and it applies verbatim.

The distinction that must not blur:

| | Retried? | Why |
| :--- | :--- | :--- |
| `check()` **findings** — unknown column, invalid join | ✅ Yes, bounded | Mechanical. The finding names the identifier *and* what was available; the correction is decidable. |
| `insufficient_schema` **refusal** | ❌ **Never** | §6.7. Re-asking is how *"there is no due date"* becomes a plausible-looking `created_at` on attempt 2 — the `period="2023-10"` failure with a column name instead of a date. |

### Decision 4 — The proposer's prompt is the schema, the need, and the taken names. Nothing else. (**D-172**)

Modelled on `buildFragmentPrompt`: what it *cannot see* is the value.

**In**: the introspected schema for **one** datasource (tables, columns, types, nullability, PKs, FKs);
one need statement; the operation and query names already taken on that datasource.

**Out, and each for its own reason**:

| Excluded | Why |
| :--- | :--- |
| DSN / connection string / any database handle | Article VIII, and there is nothing to connect *for* |
| **Any row of data** | ⚠ D-54's rule. Shown real rows to imitate, a proposal stops being derived from the schema and starts being derived from data somebody's automation will read back out |
| Other datasources' schemas | A spec is single-datasource by construction |
| The automation goal, the flow model, sibling steps | A reader is a function of the schema and the need. Widening is how a proposer starts optimising for a flow it cannot see |

The taken names are in for the same reason `EXISTING TRIGGERS` is in the draft catalogue: a name collision
is a 409 at save, and the cheapest place to avoid it is before the proposal is made.

⚠ **FR-006 asserts this against the module's own source**, the way `buildTablePrompt`'s isolation is
asserted (D-54) — because a behavioural test passes just as well when the field is present and merely
unused, and the next person to touch the function will use it.

### Decision 5 — The name is editable **before** creation and immutable after, and the surface says which. (**D-173**)

Clarification 2 said *"let AI name it and it should be editable."* Honoured as far as the data model
permits, and the constraint stated where it can still be acted on.

`dbOperationUpdateSchema` carries **no `name` field**; its docblock: *"rename is a delete plus a create
(the name IS the ref)."* A name is half of every `<datasource>.<operation>` ref.

* **Before save** — fully editable. Nothing references it. Free.
* **After save** — not renameable. Unchanged by this feature.

⚠ **The warning belongs in the dialog, not in a doc.** *"This name becomes part of every automation that
uses it and cannot be changed later"* is only useful at the moment the field is editable. A person who
learns it afterwards has learned it too late — and `ui-honesty-check.sh` is the right place to pin that
the sentence is present.

### Decision 6 — Ordering is propose → approve → regenerate. Never inline in `draftFlow`. (**D-174**)

Proposing during `draftFlow`'s redraft loop would mutate the catalogue **while the loop is running**:
attempt 2's prompt would describe a workspace attempt 1 did not see. That breaks the property the loop
depends on — *"a retry appends; it never rewrites"* — and it does so invisibly, because the model would
simply get a different, plausible answer.

It also breaks the cached prefix, which is the whole reason `GOAL` is last.

So the catalogue changes **between** generations, never inside one. Concretely: refuse → propose →
person approves → the person regenerates.

### Decision 7 — Chat gets a new **response kind**, not a bigger op. (**D-175**)

Clarification 3: creating a reader is setup and is not counted against one-op-per-turn. Achieved without
weakening the bound.

⚠ **The bound is not a prompt rule — it is `CHAT_TURN_MAX_TOKENS = 1024`, a hard output ceiling chosen so
a flow does not fit.** Widening the turn's response to carry an op *and* a `DbOperationSpec` would raise
that ceiling, and raising it is exactly how *"a turn cannot be a redesign"* stops being structural.

So: **a separate call with its own budget.** The turn stays one op. When a turn's op names an
unresolvable ref on a schema-bearing datasource with no readers, the turn path returns a **proposal**
response kind — not an applied op, not a bare refusal — and writes no revision. On approval, the original
op is re-attempted.

⚠ **The import surface is the thing to get right.** `flow-chat-imports.test.ts` reads the chat service off
disk and fails on any symbol from `flow-generation.service.js` outside a pinned allowlist. The proposer is
a *different* module, so that test would not see it — which is precisely why **FR-018 extends the test**
rather than relying on the existing one. And the proposer itself must not import from
`flow-generation.service.ts`, or the allowlist is routed around one module over.

### Decision 8 — Phase 0 moves `DRAFT_RULES`, so every draft measurement on record goes stale. (**D-176**)

`DRAFT_RULES` is the cached prefix. Changing it changes every draft prompt in every workspace, once, at
deploy. That is **accepted** — Phase 6's trigger block did the same deliberately — but it has a cost that
must be paid and not discovered:

⚠ **`kestra:refusal`, `outline:measure`, `draft:measure` and `chat:measure` were all taken against the old
text. They are stale for this path the moment Phase 0 lands.** Phase 4 re-takes them. Until it does, **no
number from any of them may be quoted for this path** — the same rule the 2026-08-21 chat prompt edits
were left under.

The new rule is one line, and its wording matters more than its length, because it is the half of the
I-118 pairing that has no check behind it:

> A table listed in the WORKSPACE MANIFEST is **not** callable. You can read a datasource's data only
> through a named query, a DB operation or a tool that appears in CALLABLE STEPS. If the data you need is
> visible in the manifest but nothing in CALLABLE STEPS reads it, that is `insufficient_catalogue` — name
> the datasource in `missing`.

### Decision 9 — What is logged, and what is not. (**D-177**)

Article V requires actionable context. The schema is **third-party content** — column and table names
read from a database nobody here controls — and it is already wrapped by `wrapUntrusted` when it reaches
the drafter. The same framing applies to the proposer's prompt.

* **Log**: the datasource id, the attempt count, the finding `code`s, the refusal `reason`.
* ⚠ **Do not log** the need statement or the proposed spec's identifiers verbatim at info level. That is
  `reportManifestWarnings`' rule — *"`itemName` + `field` name the row to open, which is what an operator
  needs"* — applied here. The full proposal is returned to the authenticated caller, which is where it
  belongs.

### Decision 10 — The review leads with a readback, not the SQL, and never with sample rows. (**D-178**)

⚠ **FR-011 originally led with the compiled SQL, and that was wrong for a reason the rest of this plan
should have caught.** Clarification 1 makes a person the gate. This feature's own user stories describe
somebody who has just onboarded a datasource. **Those are frequently not a person who reads SQL** — and a
gate that cannot refuse is not a gate. Leading with SQL made the approval unfalsifiable, which is the one
outcome this codebase treats as worse than no control at all (I-38).

**The rejected fix, and why — because it will be proposed again.** *"Show a synthetic table of what the
SQL would return, so a non-technical person can check it."*

* **It was built here and deleted.** `lib/mock-rows.ts` and `lib/mockdb.ts` are gone; the datasource
  page's docblock records them as *"invented values wearing a real table's column names."*
* **It cannot discriminate.** Data generated to satisfy the query looks plausible whether the query is
  right or wrong. `inner` vs `left` shows only if the sample holds an unmatched row; `lt` vs `lte` only at
  an exact boundary; a missing `COALESCE` only on a NULL; **units never.** Every one of those is a
  property of the generator, not of the tenant's data. That is the plausibility verdict
  `generation-audit.service.ts` was deleted for.
* ⚠ **It is worse than the SQL rather than better.** Unreadable SQL is *honestly* opaque — the person
  knows they did not verify it. Realistic-looking rows **feel** like verification, and convert *"I cannot
  check this"* into *"I checked it."* A control that manufactures false confidence is a net loss.

**What replaces it** (FR-022, FR-023): a readback rendered **from the spec by pure code**.

```
From        invoices, each matched to its customer
            — invoices with no matching customer are LEFT OUT
Kept when   due date is BEFORE the date you supply (as_of)
You get     invoice id · amount · due date · customer name
Ordered by  amount, largest first
At most     500 rows
```

⚠ **This beats synthetic rows on exactly the cases synthetic rows miss.** The join kind and the filter
operator are *decidable from the spec*, so they can be stated as sentences a non-technical person can
judge — where a sample only reveals them if it happens to contain the discriminating row. The readback
states the **decision**; a sample shows an **instance** that may not exercise it.

Three constraints on it:

1. **Pure code, never a model.** `flow-refine.service.ts`' rule — a model describing its own work is the
   deleted audit service renamed.
2. **One implementation, server-side, returned by `check()`.** A client-side renderer is a second
   definition of what a spec means, drifting toward a screen that disagrees with the SQL. Returning it
   from `check()` also means it **recomputes on every edit**, which the panel already round-trips for.
3. **Additive, and the existing panel renders it too** (FR-026). A readback that only proposals get is
   two review standards for one artefact, chosen by who authored it.

⚠ **And state the bound on screen** (FR-025). The readback cannot check **units** or **business
meaning** — both are properties of the data, not the spec. The gate that can is downstream and already
exists: a **test run plus an expectation**, which gate 1 requires to have held on a succeeded run against
real data. **A person who cannot read SQL can still say "I expect more than zero rows, and every amount
positive."** Approval here is a cheap honest check on intent; correctness is gate 1's job.

### Decision 11 — A proposal turn stores that a component was needed, never the proposal. (**D-179**)

`flow_chat_turns` has `refusalJson` so a terminal refusal is readable after the fact. The obvious move is
a matching `proposalJson` — and it is wrong twice.

* **D-170 forbids it.** A persisted proposal is a half-created ref with a lifecycle, and the review it
  waits on is exactly what makes it safe.
* **It would need a migration**, for a column whose contents the spec says are transient.

So the turn finishes **`status: "needs_component"`** with `findingsJson` carrying the human-readable
finding — *"billing_db has no readable components; a DB operation is needed for &lt;need&gt;"* — and the
**proposal is fetched by the client from the propose route.** The record explains itself, nothing
half-created is stored, and re-opening an old thread re-proposes rather than replaying a stale spec.

⚠ **`status` is `varchar(32)` with no database enum**, so this is a docblock edit and code. **A migration
in this feature is a signal that this decision was reversed without being rewritten.**

---

## Decisions taken during implementation

⚠ These four were **not** planning decisions. P0's code raised them, and each one contradicts something
this plan said before it was written. They are recorded here rather than only in the code so the
contradiction is visible in the place a reader looks for the argument.

### Decision 12 — `schemaRepo` enters `flow-generation.service.ts`. (**D-180**)

**Contradicts**: this plan's Phase 0 table, which said *"no new import"*.

That sentence was written about `datasourceRepo`, which is genuinely already there ([:7](../../packages/server/src/services/flow-generation.service.ts#L7)).
FR-002's first situation is *"a real datasource **holding an introspected schema** and zero readable
components"*, and the schema half is answerable from neither `refInterfaces` nor the `datasources` row.
So `schemaRepo` comes in — one line, no new dependency.

It is read **lazily and memoized, on the failure path only**: at most one query per datasource named by a
bad ref, typically one per draft attempt, and none at all on a draft that resolves. The alternative —
threading the manifest into `unknownRefs` — changes a signature four callers use to avoid one line.

⚠ Nothing about FR-018 changes. That rule constrains what the **proposer** may import; this is the
drafter, which already reads five repositories.

### Decision 13 — FR-002 has FOUR situations, not two. (**D-181**)

**Contradicts**: FR-002 as originally written, and tasks.md T02's *"Two situations, two sentences."*
**spec.md FR-002 has been widened to match** — the code and the spec do not stay different.

| Situation | Sentence |
| :--- | :--- |
| real datasource · schema · **no readers** | *"…IS a datasource in this workspace, with N introspected tables, but it has no readable components. A table is not callable: create a DB operation or a named query for it."* |
| real datasource · **has readers, not this one** | *"…IS a datasource in this workspace, but it has no readable component named "invoices". Its readable components are: …"* |
| real datasource · **nothing introspected** | *"…but nothing has been introspected from it and it has no readable components. Refresh its schema, then create a DB operation or a named query."* |
| prefix matches nothing | **unchanged** — *"…which does not exist in this workspace"* |

Rows 2 and 3 are not scope creep; **each keeps row 1 honest.**

* Without row 2, a **mistyped reader name** on a datasource with three readers is told it has none. That
  is a new false sentence standing where the old one stood, which is the whole defect FR-002 removes —
  and worse, because a redraft can fix a wrong reader name and could never fix *"does not exist"*.
* Without row 3, a datasource whose schema refresh failed is sent to the operation builder. That state is
  common, not exotic: `addDatasource` runs create → test → refreshSchema with the last two
  `.catch(() => null)`, so a datasource with no schema is a **successful** onboarding.

Row 2 costs no query — a ref is keyed `<datasource>.<name>`, so "has this datasource any reader?" is a
prefix scan of `interfaces`, which is already in hand.

### Decision 14 — a stated table count is DISTINCT ENTITIES, never rows. (**D-182**)

`schemas` holds **one row per column** ([db/schema.ts:331](../../packages/server/src/db/schema.ts#L331)),
with `columnName` NULL for entity-level metadata and `entitySchema` part of the unique key. `rows.length`
would tell a person with two tables and six columns that they have **six tables** — a number they can
check against their own database at a glance, delivered by the message written to stop misinforming them.
A worse failure than the sentence it replaced, because it is specific.

The count is `new Set(rows.map(r => `${r.entitySchema ?? ""}\0${r.entityName}`)).size`, and a 6-row /
2-entity fixture pins it. The singular is handled too: *"1 introspected table"*, not *"1 tables"*.

### Decision 15 — what P0's tests assert, and what they deliberately do not. (**D-183**)

*"Does the model refuse rather than invent a ref?"* is **not** a property of this code. With a stubbed
client the answer is whatever the stub was told to say, and a test asserting it asserts itself — the trap
`flow-generation.test.ts` already names for assertion 32. That half is **SC-001, a measurement**.

Three things ARE properties of this code, and all three were wrong before P0:

1. the rule reaches the prompt at all — the only mechanical check on T01, whose wording is otherwise
   load-bearing and unguarded (I-118's pairing);
2. `unknownRefs` picks the right one of four sentences — D-181;
3. `draftFlow` returns a refusal after **exactly one** call and never re-asks — FR-003.

⚠ **SC-001's measurement is deferred to T24** by decision, 2026-08-27, not forgotten. `kestra:refusal` is
the wrong harness for it (it measures the FRAGMENT channel), `draft:measure` is the right one but has no
reader-less-datasource case, and the **"before"** number is now obtainable only by temporarily reverting
T01. T24 re-takes all four measurements anyway. Until it lands, **no number from `kestra:refusal`,
`outline:measure`, `draft:measure` or `chat:measure` may be quoted for this path.**


### Decision 16 — the spec enums are exported; the readback still imports nothing at runtime. (**D-184**)

`AGGREGATES`, `FILTER_OPS`, `JOIN_KINDS`, `SORT_DIRS` were module-private in `db-operation.service.ts`.
SC-007 is a claim about **coverage**, so a test has to *enumerate* them — they are now exported.

The readback module takes **none of them as a value**. It derives the unions off the spec type
(`NonNullable<DbOperationSpecInput["filters"]>[number]["op"]`) with `import type`, which is erased at
compile time — so the module has **one import and zero runtime dependencies**. That division is what
makes both halves checkable:

* exhaustiveness is enforced at **compile** time by `Record<FilterOp, string>`;
* coverage is enforced at **test** time by iterating the arrays;
* purity is a statement about the **module**, not about the test's import list.

⚠ There is a **type-level import cycle** — `db-operation.service.ts` value-imports `readback`, the
readback type-imports the spec. It is erased at runtime and `tsc` is clean. **Do not "fix" it by copying
the enums into the readback module**; that is the drift this decision exists to prevent.

### Decision 17 — `outputColumns.type` is the SOURCE column's type, and `source` names the aggregate. (**D-185**)

`{alias, source, type}` is the shape tasks.md T06 specifies, and an aggregate does not fit it cleanly:
`count` returns `bigint` whatever it counts, `sum(integer)` → `bigint`, `avg` → `numeric`. Inferring that
would put a **second dialect model** into a module that has none.

So `source` becomes `count(invoices.id)` and `type` stays `uuid` — the type of the column that was
summarised, which is the fact a reviewer can check. ⚠ **T14 must not render `type` as the output's type.**
The field's docblock says so; this decision is the record of why the wording matters.

### Decision 18 — the readback states what the spec does NOT say. (**D-186**)

Three clauses beyond the plan's worked example, each for a named failure:

| Silence | Clause | The failure it names |
| :--- | :--- | :--- |
| no filters | *"EVERY row — this operation has no filter"* | silence under **Kept when** is indistinguishable on a screen from a section that failed to render, and the two mean opposite things |
| no sort | *"NOTHING — the database may return these rows in any order"*, with the note **escalated** when a `limit` exists | *"the first 500"* of an unordered result is an arbitrary 500 that can differ between two runs over identical data — a flow that passes its test run and is not stable |
| no limit | *"NO LIMIT — every matching row is returned"* | `compileOperation` emits no `LIMIT` and nothing downstream adds one; the response feeds a `query` step whose callback is capped at **5 MiB**, so it succeeds small and fails outright large |

⚠ A label may therefore **repeat** — one `From` clause per join, so each join carries its own note. The
contract's sample was an illustration until P1b and is now the real output.

### Decision 19 — the readback restates the compiler's GROUP BY rule, and that is only allowed because a test checks it. (**D-187**)

The row-count note (*"one row per distinct combination of …"* / *"ONE row in total"*) mirrors
`compileOperation`'s grouping rule. **Two implementations of one rule** is something this repo refuses.

It is permitted here **solely** because `compileOperation` is pure, so the test asserts the readback's
claim against the presence of `GROUP BY` **in the SQL actually emitted** — three cases: mixed,
all-aggregated, none. ⚠ **Delete that block and the comment in the readback module pointing at it becomes
a lie.** The note earns it: *"one row per invoice"* versus *"one row per customer"* is the single most
checkable thing a non-technical reviewer has.

### Decision 20 — every source-reading test scans CODE ONLY. (**D-188**)

The readback's purity test and the proposer's isolation test both read their module off disk. Both first
versions ran against the **raw file** and failed on the modules' own comments — the docblock saying *"no
`inference` import"* contains `inference`; the one saying *"a `default:` case here is how a new operator
ships with no sentence"* contains `default:`; the proposer's explains at length what a `connectionString`
would cost.

⚠ Those versions were not merely noisy: they were **satisfiable by deleting the explanation**, which is
the opposite of what they protect. Both strip block and line comments first, and both carry a control
that the stripper left the code behind rather than the file.
`flow-chat-imports.test.ts` records the same class of mistake from the other direction (a regex that
returned 30 "symbols", most of them comment prose).

### Decision 21 — FR-014's bound travels in the response and is enforced by the surfaces. (**D-189**)

**Contradicts nothing; settles what T09a left open.** `MAX_PROPOSALS_PER_REQUEST` is exported **and
returned as `maxPerRequest` on both channels** — a refusal spends one of the N too, so a surface counting
only proposals would offer N+1.

**It is not enforced server-side and cannot be.** One propose call has no notion of "this generation",
and the server holds **no proposal state at all**: D-170 forbids persisting a proposal, D-179 forbids a
turn storing one. A server-side counter would be that state under another name. So the bound is a UX
control over approval fatigue, not a security boundary — which is the honest description, and the reason
client-side enforcement is adequate here and would not be for anything else.

⚠ **The client must not hardcode `3`** — that is the second definition this decision avoids. ⚠ **T13
still has to decide** how the bound is stated *before* the first proposal, since `maxPerRequest` arrives
*with* one: either the surface holds the value from the session's first response, or the number moves to
the catalogue's `caps`, where `FLOW_CAPS` already reaches the client.

### Decision 22 — the 404 lives in the ROUTE, so the proposer never imports `datasourceRepo`. (**D-190**)

The proposer must refuse an unknown datasource before spending inference, and the obvious way is a
lookup of its own. `datasourceRepo.get` returns the **whole row, including `connectionString`** — which
would put FR-005's single most forbidden field one property access away from a prompt builder, and leave
FR-006 asserting only that it is *currently unused*. That is the assertion T10 explicitly rejects.

So the route does it, with `datasourceService.get` — `toPublic`, which **never returns the connection
string**. The proposer's import list stays: `schemaRepo`, `dbOperationRepo`, `datasourceQueryRepo`,
`dbOperationService`, `inference`, the envelope, `zod`. ⚠ The **409** (no introspected schema) stays in
the service, because the service is what reads the schema — two readers of one fact is how they come to
disagree.

### Decision 23 — the proposer imports the provenance envelope, a sixth module beyond T08's allowlist. (**D-191**)

**Contradicts** tasks.md T08's *"Imports … and nothing else"*.

Table and column names are **tenant-authored text reaching a prompt**, which is exactly what
`PROVENANCE_DECLARATION` + `wrapUntrusted` exist for — `buildDraftPrompt` wraps the manifest for the same
reason, and the manifest's content overlaps this schema almost entirely.

The allowlist's purpose is FR-018 — *the proposer cannot reach a draft, a flow model or the automation
goal* — and the envelope is a pure string wrapper with no path to any of those. T10 asserts FR-018 as the
**absence of `flow-generation.service`** and of `draftFlow`/`authorFlow`/`FlowModel`, which is the property
the list was standing in for. ⚠ Blast radius, stated: the wrapped block is inside the cached prefix, so
it costs prefill and not decode.

### Decision 24 — exhausting the attempts is a 422 FAILURE, and is not the refusal channel. (**D-192**)

The contract's error table had no row for *"three attempts and nothing compiled"*, and something has to
happen. It is **not** `insufficient_schema`: a refusal names a boundary in the schema and is a success;
this names three answers the compiler rejected, and the difference matters because **one of them must
never carry a Retry button and the other must never be logged as an error**.

422 with the `check()` findings attached — `error.middleware.ts`'s 4xx branch carries `findings`, which is
the only actionable part. ⚠ **No Retry button on this either**: the same three attempts against the same
schema and the same need is the identical call.

### Decision 25 — SC-002 is asserted on SQL CLAUSES plus an exact count, not on the word `SELECT`. (**D-193**)

The first version of the proposer's SC-002 test forbade the word `SELECT` in the module and failed — on
the **prompt line** that tells the model its form is *"compiled to a read-only SELECT by code"*, a
sentence whose entire job is to say that SQL is not the model's to write.

⚠ A test satisfiable by **deleting that line** is pointed the wrong way. It now forbids the clauses an
emitter cannot do without (` FROM `, ` WHERE `, ` GROUP BY `, ` ORDER BY `, ` JOIN `, `$1`), requires
**exactly one** occurrence of `SELECT` and requires it to be that disclaimer — so a second mention
anywhere in the module fails — and separately asserts the response schema offers **no field** a statement
could arrive in.

### Decision 26 — the bound is stated from the FIRST RESPONSE, and the catalogue's `caps` was rejected. (**D-194**)

T09a left T13 a choice: hold `maxPerRequest` from the session's first response, or move the number into
`GET /catalogue`'s `caps`, where `FLOW_CAPS` already reaches the client. **Held from the first response.**

`caps` is typed `typeof FLOW_CAPS`, and `FLOW_CAPS` is the **flow validator's** cap set — the same object
`writeRevision` enforces and `flowModelSchema.steps` mirrors. A proposal bound is not a flow cap, so it
would have to be bolted onto the catalogue response beside it; and `DbOperationsPanel` lives on the
datasource page and does not read the catalogue at all, so the panel would fetch a workspace-wide join
over every tool, query and operation to render one integer.

⚠ **The gap this leaves is real and is smaller than it looks.** Nothing numeric is on screen until the
first response arrives. But the affordance that can *exceed* the bound is **"Propose another"**, which by
construction only exists once a response has arrived — so the number is on screen at every point a person
could reach it, and nothing has been silently truncated before that. FR-014's failure mode is a surface
that stops offering without saying it has stopped; that is what is closed.

The client-side control is a source-read: `setCap(r.maxPerRequest)` must be present and
`/maxPerRequest\s*[:=]\s*\d/` must not match anywhere in the panel. Proven by perturbation — hardcoding
the cap turns 3 tests red.

### Decision 27 — the `insufficient_catalogue` panel LINKS to the datasource page; it does not embed a second proposer. (**D-195**)

T16 says the panel "offers propose". It offers a **link to the source's own page**, where the review dialog
already lives — the same shape as `policy_transform`'s confirm button, which is not the Retry §6.7 forbids
because it offers a *different action*.

Embedding the dialog in the flow wizard would be a second implementation of the readback rendering, the
editable-name warning and FR-025's caveat. Two review surfaces for one artefact is FR-026's argument
arriving from the other side, and the drift lands where approving means less.

⚠ **It reads `listConnections()`, not `catalogue.entries`, and the reason is the refusal it exists for.**
D-176's refusal fires when a datasource is registered, its schema **is** introspected, and nothing readable
exists for it — so it contributes **zero** catalogue entries by construction. Matching `missing[]` against
`entries[].datasource` would find nothing in exactly the case that matters.

⚠ A failed read renders **nothing**, and that is deliberate: the refusal above it is complete without this,
so silence withholds a shortcut rather than making a claim. This is not `PromptBoundaryWarnings`, whose
whole job is to report findings and which therefore must say when it could not run.

### Decision 28 — SC-003 is measured by a synthetic KEY, not by creating a row. (**D-196**)

T17a asks for the FR-015 measurement across every workspace. Creating a real operation in a workspace
holding armed flows, to find out whether creating one unarms them, is a measurement that **damages the
thing it is measuring when it fails** — the one shape a measurement must not have.

So the property is split, and each half is established where it can be established honestly:

1. *"A create adds exactly one key and moves no other"* — a property of `refFingerprints`' loop, which does
   not vary with a workspace's data. Pinned in `manifest-fingerprint.test.ts` with **two controls proving
   those fingerprints can move at all**, and proven to fail: folding a workspace-global count into the tool
   payload turns 2 red.
2. *"Adding a key moves no armed flow's aggregate"* — this DOES vary, with each flow's ref list and each
   workspace's rows. Measured by `pnpm --filter @foundry/server fingerprint:measure` over every workspace
   and every armed flow, appending `<datasource>.__fingerprint_probe__` to the real fingerprint map and
   re-running the real `aggregateFingerprint`. **Zero writes.**

⚠ **It reports INCONCLUSIVE and exits 2 over zero armed flows**, rather than printing "0 moved" — T17a says
so in as many words, and it is I-38: over an empty set, "nothing moved" is a control that cannot fail.
`backup-verify.sh`'s INCONCLUSIVE verdict is the precedent.

### Decision 29 — the chat service imports NOTHING from the proposer, and the gap travels on the error. (**D-197**)

**Contradicts**: this plan's own Phase-3 file table, which said *"Import `proposeOperation` (one symbol)"*,
and T20, which inherited that sentence.

**D-179 wins, and it was written later with the argument**: *"the proposal is **fetched by the client from
the propose route**"*. Two things follow, and both are stronger than the table's version:

* **No inference call is added to the turn path at all.** FR-016's *"a separate call with its own token
  budget"* becomes **structural** — a different HTTP request, made by the browser when a person clicks —
  rather than this module remembering to pass a different `maxTokens`. `CHAT_TURN_MAX_TOKENS` is not merely
  unchanged; there is no second call in the module to bound.
* **The absence is assertable.** `flow-chat-imports.test.ts` now pins it in **both** directions: the
  proposer imports nothing from `flow-generation.service.ts` (FR-018), and the chat service imports nothing
  from the proposer. That is `flow-refine.service.ts`'s own argument — *it cannot re-run a design because it
  has no path to one* — available here where an allowlist entry would have been.

**So how does the turn know?** The condition is *"a real, introspected datasource with nothing readable"*,
and there were three ways to tell it:

| | Why not |
| :--- | :--- |
| String-match the drafter's finding | Couples a control to prose. Reword FR-002's sentence and chat silently stops offering proposals for a case the server still reports, with nothing failing. |
| Re-derive it in `flow-chat.service.ts` | A second definition of the condition, plus three new repo imports into the module with the most controls per line in the codebase. |
| **Let it travel from the place that already computed it** | ✅ |

`unknownRefs` is now a thin wrapper over **`refFindings`**, which returns the findings *and* the structured
`ComponentGap[]` from the same pass; `FlowDraftError` carries them; `attemptOp` reads them off the error it
already catches. ⚠ **`unknownRefs`' signature, behaviour and all thirteen of its tests are untouched** —
every draft measurement on record was taken against it — and a test asserts the two agree byte-for-byte on
the findings, with a control that the comparison is not over two empty arrays.

⚠ **`correctable: false` on that branch is the half that costs something if it goes.** A component gap
produces findings that look exactly like the mechanical ones, so without it the corrective pass fires,
spends a second inference call, and the model answers the only way it can — by naming a **different** ref
that does resolve. A step reading the wrong data, with a green tick on it.

⚠ **A gap is emitted only when `introspectedTables > 0`.** With nothing introspected the fix is a re-scan,
and offering to propose there produces the 409 the propose route exists to give.

---

### Decision 30 — SC-006 is adjudicated against a PRE-DECLARED expectation, not by a reviewer. (**D-198**)

**Contradicts nothing; settles what SC-006 could not specify.** SC-006 asks how many proposals *a
reviewer* accepts unedited, edits and rejects. There is no reviewer, and the two available substitutes
are both worse than no number:

* **The implementer eyeballing the output.** The most biased reviewer obtainable, judging their own
  system, with the answer already on screen. Every borderline case resolves toward *fine*.
* **A model judging a model.** Two draws from one distribution; it agrees for the same reasons the
  proposal was made.

So `propose-measure.ts` declares, **in the commit that created it**, what a reviewer would need for
each need statement — base table, the joins the answer cannot be produced without, and **the operator
direction on each filter**, because `lt` and `gt` on one column are the plausible-but-wrong case
spec.md names and are indistinguishable in every other column of the report. The adjudication is dumb
code over that declaration. What makes it more than an opinion: the expectations cannot be quietly
relaxed to fit a bad result without the relaxation appearing in the diff.

⚠ **The number is agreement with a declared expectation, not acceptance.** The two come apart in both
directions, but unevenly: a real reviewer would accept several cases filed here as `edited` (an extra
column, a different alias), and would rarely reject one filed `unedited`. So **`edited` is an UPPER
bound and `unedited` a LOWER bound** — the safe direction for a figure that gates a reliability claim,
and the reason the harness is built this way round rather than the reverse.

**Three of seven cases must REFUSE**, and that arm is what makes the other one mean anything: without
it, *"proposes well"* and *"always proposes something"* produce the same score, and *always proposing
something* is precisely what the `insufficient_schema` channel exists to prevent. The arms are also
reported **separately**, because a correct refusal lands in `unedited` and pooling the two makes a
component that proposed badly and refused perfectly score the same as the reverse.

⚠ **`--rounds` defaults to 3, and that is a finding rather than a preference**: the first two runs of
the file disagreed (5/1/0 then 6/0/0) at n=6. A single-round figure is not wrong, it is
precision-free, and the version that could only produce one would have reported `6 / 0 / 0` with
nothing on screen to suggest a second run might not.

### Decision 31 — a cross-model comparison uses `--model=`, never the `generation_llm` row. (**D-199**)

⚠ **This one was forced by getting it wrong first.** CLAUDE.md records every generation measurement in
this repo as taken on gemma; this deployment resolves **`gpt-5.4-mini`** from a `/ai-provider`
override, so P4's re-takes are not re-takes of the same thing and the old numbers are not their
baseline.

The obvious way to compare is to change `generation_llm` and change it back — which **edits a live
deployment setting so a harness can read a number**, and leaves the model wrong if the run dies in the
middle. Rejected. `draft:measure --model=<name>` constructs a `GatewayInference` bound to the named
model and hands it to `draftFlow` as the client it **already accepts**.

⚠ **The credential is untouched, and that is the property not the convenience.** `baseUrl` and
`apiKey` come from `config.inference` and only from there — D-35: this seam gains a *model*, never a
credential — so the flag names a model string and can do nothing else. And the header prints **which
source** the model came from, because a number filed under a model the deployment is not using is only
honest if it says so.

⚠ **Two harnesses printed no model at all** (`refusal-verify.ts`, `outline-measure.ts`); both now print
the **resolved** one, never `config.inference.model`. The two disagree here, which is exactly the
condition `draft-measure.ts`'s own header comment was written for.

⚠ **And a down model produces something that looks like a measurement.** gemma was unreachable on
2026-08-27 and the run reported *"1 attempt, then a failure"* — the shape of a badly behaving model.
That reading was discarded, not recorded. A harness cannot tell these apart, so the person running it
must.

### Decision 32 — `draft:measure` gains a THIRD outcome, because two were hiding SC-001. (**D-200**)

**Contradicts nothing; fixes the harness SC-001 is measured with.** `draft-measure.ts` scored `ok` or
`FAILED`. An `insufficient_catalogue` refusal landed in `FAILED`, its reason landed in the `other`
reason bucket, and it counted against `N/M drafted` — so *"refused correctly on attempt 1"* and
*"burned three attempts and threw"* produced **identical output in every column**. That distinction is
the entire content of SC-001.

⚠ **`outline-measure.ts` already had this right** (*"a correct answer, not a drift"*), which is what
makes it a defect rather than an oversight: the same fact was modelled correctly one file over.

Three parts: `refused` is its own outcome; a case may **declare** `expectRefusal`, and declared rows
are **excluded from the drafted rate** rather than dragging it down for answering correctly; and the
SC-001 block reports **attempts**, because a refusal on attempt 3 prints green in the row above and is
still the failure the requirement exists for.

⚠ **`classify()` filed the refusal under `other` — the third time in that one function a real class
hid there, and the only one of the three that is not a defect at all.** A refusal spends one attempt
and spends it correctly; leaving it in the waste tally made the honest answer look like the thing to
fix next.

### Decision 33 — chat's `needs_component` is MEASURED as unreachable and deliberately NOT fixed here. (**D-201**)

⚠ **The finding, and the reason it is a decision rather than a bug report.** P3 recorded honestly that
US3 was proven client-side and by source-read, and that end-to-end behaviour was `chat:measure`'s to
confirm. Confirmed: it does not fire. On `gpt-5.4-mini` the turn answers **`too_structural`** while
naming the gap correctly in prose — *"depends on a specific hr_demo source that does not exist in the
available callable steps"* — so the op call self-refuses and `authorFlow`, the only place
`refFindings` runs, is never reached. Three phrasings, including one naming the datasource outright,
on an empty flow.

**The probe was wrong before the feature was.** The first version asked for a whole automation in one
sentence, which is `too_structural`'s legitimate job; that reading was discarded and re-taken with a
single-step message. Both phrasings are now probes, because the natural one missing is itself the
finding and a comment does not go red when somebody widens the op budget and believes they have fixed
it.

⚠ **This is the 2026-08-21 `too_structural` defect one level deeper**, and that entry's own warning is
why it went unnoticed: *"nothing server-side can know whether a request really was structural, so a
`too_structural` cannot be validated, only believed"* — the one rule in `CHAT_RULES` with no
mechanical second half (I-118's pairing has no partner here). `chat:measure --scenario=2` is now that
second half, as a **measurement** rather than a check.

**Not fixed, and the reason is the scope boundary rather than difficulty.** The fix is a prompt change
to the most controlled module in this feature, it would invalidate `chat:measure` for the fourth time,
and it needs its own decision about whether the op call gains a channel or `too_structural` reasons
naming a datasource get routed. **A measurement task must not quietly become a prompt change**, which
is how the thing being measured stops being the thing that shipped. Handed to the user with the
evidence.

⚠ **There is also a tension worth stating explicitly, because it is structural.** T01's rule makes the
drafter *refuse* rather than invent `<ds>.<table>` — and `needs_component` detection **depends on the
model having written that ref**, since `refFindings` finds the gap by inspecting it. P0 makes SC-001
better and US3's chat offer harder to reach, at the same time, by the same sentence. Neither half is
wrong; nobody had noticed they pull against each other.


### Decision 34 — Option A: teach `CHAT_RULES` that a missing READER is like a missing STEP. The schema is unchanged. (**D-202**)

⚠ **This contradicts D-201's "not fixed here" and supersedes it — by the user's decision, and the
reasoning D-201 gave still stands and is now the constraint this phase works under.** D-201 declined the
fix because a *measurement* task must not become a prompt change. Phase 5 is not a measurement task.

**The mechanism, stated once because every option below is a choice about where to put one sentence.**
A chat turn asks the model **twice**:

```
Question 1  "what ONE change should I make?"      ← CHAT_RULES + the catalogue
            answers: ok │ too_structural │ ambiguous_referent    ← THREE. That is the whole problem.
                │
                ├── too_structural ────────────────────► terminal. We land here.
                └── ok, add this step
                        │
Question 2  "now author that step"                ← authorFlow + DRAFT_RULES
                        │
                        └── refFindings → ComponentGap → needs_component
```

`needs_component` is **not** an answer question 1 may give — it is produced only downstream, by the pass
that inspects the ref an op already named. So the op call refusing is the op call skipping the only code
that can detect the gap.

**Chosen: extend the prompt, change nothing else.** `CHAT_RULES` already carries three sentences saying
a missing **step** is a reason to add it, never to refuse — added 2026-08-21 for this same class of
failure. They say nothing about a missing **reader**, and a missing reader genuinely *cannot* be fixed
by adding a step, so a model reasoning honestly from the current text reaches `too_structural` and is
not being careless. The rule gains the reader case; the op names the datasource; **Phase 3's machinery
runs unchanged.**

⚠ **Nothing about this is new capability. It is a prompt rule that lets already-shipped, already-tested
code execute.** No schema change, no new status, no new branch, no client change — which is why it is
the first thing to try and not the last.

**Rejected — Option B: give question 1 a fourth answer (`needs_component` in `chatTurnResponseSchema`).**
More robust in principle: the model gets somewhere correct to put an answer it is already producing in
prose. Rejected **for now, not on merit** — it is a wider change (schema, prompt, a new terminal branch,
and `ChatPanel` reads the datasource off `opJson.step.ref`, which would not exist), and it should not be
taken before the cheap option is *measured* to be insufficient. ⚠ **If Phase 5's measurement fails, B is
the answer** — do not iterate on prompt wording a third time.

**Rejected — Option C: re-file a `too_structural` server-side when the workspace has a reader-less
datasource.** Rejected on merit. Deciding *when* to overrule the model's own answer is guesswork, and
the failure direction is the bad one: a legitimate *"that is a redesign"* becomes a bogus proposal
offer. It also puts a second definition of "is this structural?" in the codebase, one of them a
heuristic — and D-197 rejected exactly that shape of duplication one phase earlier.

⚠ **The tension this decision resolves, and it is worth being explicit that it IS a resolution.** T01's
rule tells the drafter *"a table listed in the manifest is NOT callable"*, which is why the drafter now
**refuses** rather than naming `hr_demo.leave_requests`. But `refFindings` detects the gap **by
inspecting a ref the model wrote** — so the detection depends on the naming that T01 discourages. The
two rules live in different prompts (`DRAFT_RULES` vs `CHAT_RULES`), so this is not a contradiction to
fix but a boundary to state: **inside a chat turn, naming the unreachable datasource is the useful
thing to do, because a person is present and can be offered the missing component.** In a headless
draft there is nobody to ask, so refusing is right. Same fact, two answers, and the difference is
whether a human is in the loop.

⚠ **I-118 has no second half here, and that is the known cost.** *"Teach it in the prompt, catch it
with a check"* — nothing server-side can decide whether a request was really structural, so this rule
can only be **believed**. `CHAT_RULES`'s own docblock says so. The substitute is
`chat:measure --scenario=2`, which is a **measurement, not a check**: it will not fail a build, and it
must be re-run deliberately. ⚠ **And the control is not optional** (FR-028): a rule that turns
*every* `too_structural` into an `add_step` would satisfy SC-009 and have silently deleted the channel.



### Decision 35 — Option A needed prompt CONTENT, not just a prompt rule. (**D-203**)

⚠ **This corrects D-202 in the middle of implementing it, and the correction was found by reading the
code before writing the rule.**

D-202 described P5 as *"one `CHAT_RULES` rule"*. **A rule alone could not have worked, whatever it
said.** A chat turn's prompt is `CHAT_RULES` + the CALLABLE STEPS catalogue + the expression rules +
the current automation + recent turns + the message. **There is no manifest.** `catalogueText` renders
only what is *callable* — so a datasource with no readers appears **nowhere**, and the op call cannot
name `hr_demo` because it has no way to know `hr_demo` exists. The one measured run that named it did
so because the person's own message did.

And naming it is not optional: `refFindings` detects the gap **by matching a ref's prefix against a
real datasource name**. A guessed prefix produces *"does not exist in this workspace"* and **no**
component gap.

So P5 is a rule **and** a `DATASOURCES WITH NO READER YET` section. Still no schema change, no new
status, no new branch, no client change — the plan's own stop-list is intact.

**Where the list is computed, and why it is not in the chat service.** `readerlessDatasources()` lives
in `flow-generation.service.ts`, beside `refFindings`, and the condition is **byte-for-byte the one
the detection uses** — no ref keyed `<name>.` in `refInterfaces` (tools, named queries **and** DB
operations), and more than zero introspected entities. Two definitions would break US3 in one of two
silent ways: the prompt advertising a datasource that then produces no gap, or staying silent about one
that would. ⚠ Computing it in the chat service is the **exact** alternative D-197 rejected — three new
repo imports, a second definition of the condition — arriving one phase later wearing a different hat.
`flow-chat.service.ts` renders the list and branches on nothing in it.

⚠ **The allowlist grew from six symbols to eight**, and `readerlessDatasources` is the first
allowlisted symbol with a **database query** behind it. It is admitted because the query answers a
question this module must not answer for itself, and it returns **data, not a decision**.

⚠ **CHAT ONLY.** `DRAFT_RULES` deliberately tells the drafter a manifest table is not callable, so
advertising reader-less datasources there would invite the invented `<ds>.<table>` ref T01 exists to
stop — a headless draft has nobody to offer a component to. And it would move `catalogueText`'s bytes,
which every `kestra:refusal`, `outline:measure` and `draft:measure` number was taken against.

⚠ **Two prompt-authoring rules, both learned by getting them wrong and measuring:**

1. **State the reply SHAPE as a concrete example, never as "answer X".** Every other rule in
   `CHAT_RULES` says *"answer `too_structural`"* / *"answer `ambiguous_referent`"* — and those **are**
   status values. A rule saying *"answer `add_step`"* therefore reads as *"put `add_step` in
   `status`"*, and that is exactly what came back: `{"status":"add_step","op":{"op":"add_step",…}}`,
   rejected by the discriminated union, turn `failed`. The rule now shows the literal JSON.
2. **Never put an angle-bracket template in a prompt.** `<datasource>.<the reader you need>` produced
   the ref `hr_demo.<reader for approved leave requests by period>`. A concrete example
   (`sales_db.open_orders`) plus *"never anything in angle brackets"* fixed it.

### Decision 36 — chat's catalogue was missing `operations`, and that is a pre-existing bug fixed here. (**D-204**)

⚠ **Found while implementing P5, unrelated to P5's cause, and it would have broken US3's second half
regardless of which option was chosen.**

The drafter passes `{tools, queries, operations}` to `resolveSelection`. The chat turn passed
`{tools, queries}`. `operations` is **optional** on that signature and defaults to `[]`, so nothing
errored — the catalogue simply rendered no operation lines and **every saved DB operation was invisible
to every chat turn.** Build one visually on the datasource page, then ask chat to use it: chat could
not see it.

⚠ **This is I-127's shape a third time.** `expressionsBlock` was a five-line summary in chat while the
drafter had the full `EXPRESSION_RULES`, and the comment then argued the case. **A shared builder with
an OPTIONAL input is how one consumer silently gets less than another** — and the fix is not just this
call site but the posture: `buildChatPrompt`'s new `readerless` parameter is **required**, not
optional, for exactly this reason, and two existing tests were updated rather than the type loosened.

⚠ **It would have made US3 scenario 2 fail after a proposal was approved.** `refInterfaces` resolves
the new ref correctly, so the operation existed — the model was simply never told about it, so the
re-sent message could not name it. The offer would have worked and the retry would not.

---

## Required code and file changes

⚠ **No migration.** Head is `0041_approval_override`; a `0042` appearing in this feature means somebody
decided to persist a proposal without saying so, which D-170 forbids. Nothing touches
`packages/server/src/db/schema.ts` or `drizzle/`. `flow_chat_turns.status` is a plain `varchar(32)` with
no database-level enum, so Phase 3's new status is a docblock edit plus code — see D-179.

**No new dependency. No new service, port or container. No new secret. No new env var.**

### Phase 0 — the honest refusal · 2 files edited, 1 test file

| File | Change |
| :--- | :--- |
| `packages/server/src/services/flow-generation.service.ts` | **`DRAFT_RULES`** ([:214](../../packages/server/src/services/flow-generation.service.ts#L214)) gains D-176's rule, placed in the `RULES` block beside *"Reference only the tools, named queries and DB operations in the CALLABLE STEPS section."* ⚠ **This moves the cached prefix** — Decision 8. |
| ″ | **`unknownRefs()`** ([:1122](../../packages/server/src/services/flow-generation.service.ts#L1122)) — resolve `datasourceRepo.listByWorkspace` **once, before the step loop**, and emit the kind-aware finding (FR-002). ⚠ Wrap it with the existing `refInterfaces` await in a **single `Promise.all`**; today that is a bare `await`, and `draftFlow` calls this on every attempt. |
| `packages/server/src/services/flow-generation.test.ts` | Both finding shapes; FR-003's first-attempt refusal; a control that a workspace **with** a covering tool still drafts. |

`datasourceRepo` is already imported in that module. **`schemaRepo` is not, and P0 adds it** — one
line beside the other repositories. FR-002 says *"holding an **introspected schema**"*, and that half is
not answerable from `interfaces` or the datasource row. See Decision 12 (**D-180**).

### Phase 1 — the readback and the proposer · 2 new modules, 2 files edited

| File | Change |
| :--- | :--- |
| **NEW** `packages/server/src/services/db-operation-readback.ts` | `readback(spec: DbOperationSpecInput): ReadbackClause[]`. **Pure.** No zod, no repo, no `inference` import — the same shape `flow-model-findings.ts` and `flow-expression-rules.ts` already take. Owns the `kind`/`op` → English maps (FR-023). |
| `packages/server/src/services/db-operation.service.ts` | `CompiledOperation` ([:169](../../packages/server/src/services/db-operation.service.ts#L169)) gains **`outputColumns`**. `selected` ([:399](../../packages/server/src/services/db-operation.service.ts#L399)) already carries `owner` + `alias`, and `resolveColumn` ([:295](../../packages/server/src/services/db-operation.service.ts#L295)) already returns `columnType` — **thread that into `selected` and project it.** `check()` ([:664](../../packages/server/src/services/db-operation.service.ts#L664)) returns `readback` + `outputColumns` (FR-026). ⚠ **Additive only.** `compileOperation`'s SQL emission is untouched — the `SELECT`-only property is the whole safety argument (D-169). |
| **NEW** `packages/server/src/services/db-operation-proposal.service.ts` | `proposeOperation()`. Imports exactly: `schemaRepo`, `dbOperationRepo`, `datasourceQueryRepo`, `dbOperationService.check`, `inference`. ⚠ **Nothing from `flow-generation.service.ts`** (FR-018). Prompt builder + two-channel parse + bounded loop over `check()`. |
| `packages/server/src/routes/datasources.ts` | `POST /:dsId/operations/propose`, declared **immediately after `/operations/check`** ([:248](../../packages/server/src/routes/datasources.ts#L248)). ⚠ No shadowing today — there is no `POST /:dsId/operations/:name` — but a future one declared **above** these would swallow both. Say so in a comment, as `/generate/jobs` does. |
| **NEW** `…/db-operation-readback.test.ts` | Exhaustive over `JOIN_KINDS` × `FILTER_OPS` (SC-007), with the `inner`/`left` collapse control. |
| **NEW** `…/db-operation-proposal.service.test.ts` | Two channels · refusal spends one attempt · findings verbatim · **FR-006 source read** · **SC-004 nothing written**. |

### Phase 2 — the approval surface · 4 files edited, 1 new test

| File | Change |
| :--- | :--- |
| `packages/client/src/lib/foundry-client.ts` | `proposeOperation(ws, dsId, need)`. Types for `ReadbackClause` and `OutputColumn`. |
| `packages/client/src/lib/api.ts` | Thin wrapper, beside `checkOperation`/`createOperation`. |
| `packages/client/src/components/data/DbOperationsPanel.tsx` | "Propose one for me". Dialog ordered **readback → output columns → params → editable name → collapsed SQL** (FR-011). Decision 5's immutable-name sentence; FR-025's "not checked here" sentence. ⚠ **The existing human-driven builder renders the readback too** (FR-026) — the readback is not a proposal-only surface. |
| `packages/client/src/app/(app)/flows/new/page.tsx` | The `insufficient_catalogue` panel offers propose when `missing[]` names a datasource. ⚠ **Not a Retry** — the regenerate button's disabled-until-the-goal-changes rule is untouched. |
| `scripts/ui-honesty-check.sh` | Three assertions: the immutable-name sentence, the "not checked here" sentence, and **SC-008** — no surface renders a row that did not come from the tenant's database. |
| **NEW** `packages/client/src/components/data/DbOperationsPanel.test.tsx` | There is none today. Render tests for US2 4a/4b. |

### Phase 3 — chat · 3 files edited

| File | Change |
| :--- | :--- |
| `packages/server/src/services/flow-chat.service.ts` | ~~Import `proposeOperation` (one symbol).~~ In `attemptOp`'s refusal branch, detect *"unresolvable ref whose prefix is a schema-bearing datasource with no readers"* and finish the turn `needs_component` with **no revision** (FR-017). ⚠ **A separate call with its own budget** — `CHAT_TURN_MAX_TOKENS` stays 1024 (D-175). ⚠ **THE STRUCK-THROUGH HALF CONTRADICTED D-179 AND WAS NOT DONE** — see Decision 29 (**D-197**). D-179, written after this table, says the proposal is *"fetched by the client from the propose route"*, so the chat service imports **nothing** from the proposer and adds **no inference call** to the turn path. What it does import is `type ComponentGap`, which is erased at runtime. |
| `packages/server/src/db/schema.ts` | **Docblock only** — add `needs_component` to `flow_chat_turns.status`' documented list. ⚠ **No migration**; the column is `varchar(32)`. See D-179. |
| `packages/server/src/services/flow-chat-imports.test.ts` | Extend to pin the proposer import to an explicit allowlist entry, and to assert the **proposer** imports nothing from `flow-generation.service.js` (FR-018). |
| `packages/client/src/components/flow/ChatPanel.tsx` | Render the `needs_component` bubble → the same approval dialog. ⚠ Still **only computed fields** — no sentence a model wrote. |

### Files deliberately NOT touched

| File | Why |
| :--- | :--- |
| `db-operation.service.ts`'s `compileOperation` **SQL emission** | The `SELECT`-only property is the safety argument. Additive fields only. |
| `datasource-query.service.ts` | Named queries stay human-authored — a stated non-goal. It must keep having no path to `inference`. |
| `flow-compiler.service.ts` | No new step kind. A `query` step already calls an operation. |
| `db/schema.ts` tables, `drizzle/` | No migration. A proposal is transient. |
| `step-execution.service.ts` | An operation created here runs through the existing `query` handler unchanged. |
| `flow-chat-op.ts`, `packages/flow-edit` | **No ninth op.** A proposal is a turn *outcome*, not an edit. |

---

## Phases

### Phase 0 — the honest refusal *(no model authors anything)*

1. `DRAFT_RULES` gains Decision 8's rule.
2. `unknownRefs()` distinguishes *"that datasource exists and has no readers"* from *"that ref names
   nothing"*. ⚠ Needs `datasourceRepo.listByWorkspace`, which `unknownRefs` does not currently fetch — it
   has a single `await manifestBuilderService.refInterfaces(...)`. **Wrap the two in one `Promise.all`**
   so the sharper finding costs no extra round trip; `draftFlow` calls this on every attempt.
   ⚠ Resolve it **once per call, before the step loop** — never per step.
3. Tests: FR-002's two finding shapes; FR-003's first-attempt refusal.

**Exit**: SC-001 measured before and after on the same goal.

### Phase 1 — the proposer

1. `db-operation-proposal.service.ts` — prompt builder, two-channel parse, bounded feedback loop over
   `dbOperationService.check`.
1a. **`readback()` — a pure function from `DbOperationSpec` to labelled clauses**, and `check()` returns
   it plus `outputColumns` (D-178, FR-022/FR-026). ⚠ Additive to an existing response, so the
   human-driven panel gains it for free — which is the point, not a side effect.
2. `POST /api/workspaces/:ws/datasources/:dsId/operations/propose`.
3. `contracts/operation-proposal.md`.
4. Tests: two channels; refusal-never-retried; findings fed back verbatim; **FR-006 source assertion**;
   **SC-004 nothing written**; **SC-007 readback pinned over every join `kind` and filter `op`, with the
   `inner`/`left` control**.

**Exit**: US2 scenarios 1–3 green; SC-002 and SC-004 proven.

### Phase 2 — the approval surface

1. `DbOperationsPanel` gains "Propose one for me" → dialog **led by the readback and the output columns
   with provenance**, then params and the editable name **with Decision 5's sentence**, with the compiled
   SQL **collapsed behind a toggle** (D-178, FR-011).
1a. The dialog states what is **not** checked here — units, business meaning — and points at the test run
   and expectations (FR-025). ⚠ **No rows of data are rendered anywhere** (FR-024, SC-008).
2. `/flows/new`'s `insufficient_catalogue` panel offers the same, when `missing[]` names a datasource.
   ⚠ **It is not a Retry** — it offers a *different action*, exactly as the `policy_transform` confirm
   button does. The regenerate button's existing disabled-until-changed rule is untouched.
3. Tests: render tests; `ui-honesty-check.sh` assertions for the immutable-name sentence, for the
   "not checked here" sentence, and for **SC-008** — no surface renders a row that did not come from the
   tenant's database (the shape it already uses to pin the absence of a `createFlow`).

**Exit**: US2 scenarios 4–6 green; SC-003 measured.

### Phase 3 — chat

1. New response kind + the re-attempt path (Decision 7).
2. **FR-018**: extend `flow-chat-imports.test.ts`.
3. Tests: US3's four scenarios, including **SC-005** as a control.

**Exit**: US3 green; token ceiling unchanged.

### Phase 4 — measurement and documentation

1. Re-take `kestra:refusal`, `outline:measure`, `draft:measure`, `chat:measure` (Decision 8).
2. **SC-006** — the proposal-quality reading, with its sample size.
3. Update `CLAUDE.md` and `WORKFLOW-CREATION-AND-GENERATION.md` (Article VII).

---


### Phase 5 — the op call reaches Phase 3's machinery *(one prompt rule)*

1. **`CHAT_RULES`** gains the reader case, beside the three sentences that already handle a missing
   step. ⚠ **Do not rewrite those three** — they were added for a measured failure and a shorter
   combined version restates the general rule instead of the specific one (the defect they were written
   to fix).
2. **`flow-chat-op.test.ts` / the prompt test** asserts both halves are present: the missing-**step**
   sentences AND the missing-**reader** sentence. ⚠ A source-read test, because the prompt is the
   deliverable and there is no behavioural check that can stand in for it.
3. **`chat-measure.ts`** gains the FR-028 **control probe** — a genuinely structural message that must
   still return `too_structural`, in the same scenario as the `needs_component` probe so one run
   reports both.
4. **No schema change, no new branch, no client change.** ⚠ If any of those three turns out to be
   needed, **stop**: that is Option B, and it is a different decision (D-202).

**Exit**: SC-009 measured over ≥3 runs, with the control passing in the same runs, and the model
recorded beside the number. ⚠ **The before half already exists: 0 of 4 runs.**

## Risks

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| ⚠ **A plausible but wrong operation.** Valid SQL, wrong semantics — join direction, filter operator, a missing `COALESCE`, wrong units. | **High** | **Split by what is decidable.** Join kind and filter operator ARE decidable from the spec, so D-178's readback states them in words a non-technical person can judge. **Units and business meaning are not** — nothing in this feature catches those, and FR-025 makes the surface say so and point at gate 1, where a test run plus an expectation checks them against real data. FR-021 forbids any surface calling an approved operation correct; SC-006 requires a measured acceptance rate first. **Do not claim this validates a query — the sentence `CLAUDE.md` already requires for imports and gate-1 runs.** |
| ⚠ **A review nobody can actually perform.** The approver in Clarification 1 may not read SQL, making the gate unfalsifiable — worse than no gate (I-38). | **High** | D-178: the readback leads, the SQL is collapsed, and the bound is stated. ⚠ **Synthetic rows are the tempting fix and are refused** — they were built here, deleted, and cannot discriminate a right query from a wrong one. See the non-goal. |
| **Approval fatigue** — enough proposals and people stop reading | Medium | FR-014's bound, stated on screen. ⚠ Watch for it in Phase 4's reading; a high unedited-acceptance rate is **ambiguous** — it means the proposals are good *or* that nobody is reading them, and the two look identical in the data. |
| Phase 0 changes the cached prefix | Medium | Decision 8. Accepted, paid in Phase 4, and no stale number quoted meanwhile. |
| Proposer drifts toward seeing more | Medium | FR-006's source assertion, which fails on the field's *presence* rather than its use. |
| Chat's one-op bound eroded | **High** | Decision 7 — separate call, separate budget. SC-005 is a control, not a hope. |
| A collision, or a bad identifier, at save | Low | Taken names in the prompt; `create`'s 409 stays as the atomic backstop; the regex validates the edited name. |

### Decision 37 — the date check is TYPE-BLIND and pure, and a new module holds it. (**D-205**)

**The failure.** Execution `7cwL1ris`, 2026-08-28. A drafted flow read the proposed operation
`hr_demo.approved_leave_requests`, whose `period_start`/`period_end` filters are `type: date`. The person
gave a month — `{"period": "2026-06"}` — and the drafter bound the end of the range as
`"{{ inputs.period }}-31"`. June has 30 days. Postgres refused the read, the step answered 502, and the
execution failed 0.4 s in with `date/time field value out of range: "2026-06-31"`.

⚠ **The literal `2026-06-31` appears nowhere in the flow.** It is produced at render time from a template
and a two-character suffix — which is why the control is a check over the EXPRESSION and not a validation
of a value. By the time the bad date exists, the only thing left to do with it is fail.

**Why this feature owns it.** Before **D-204** the chat and draft catalogues could not reference a DB
operation at all, and a tool takes whatever its endpoint takes — so **no step in any workspace had ever
had a `type: date` parameter to bind.** The drafter met the problem for the first time because this
feature handed it the problem. Fixing it elsewhere would file the cause under the wrong feature.

**Three choices, and the reasoning for each.**

1. **Type-blind, not scoped to `date` parameters.** Scoping the check to parameters a ref declares as
   `type: date` would need the workspace's param schemas, which makes it impure and puts it out of reach
   of `flow-model-findings.ts` — the one list every path that accepts a model shares. It would then be
   enforced on generation and not on refine, which is **exactly I-119's gap**. Type-blindness costs
   nothing: a day pasted onto a template can only mean *"day 31 of a month I do not know"*, and a fully
   impossible literal is wrong in any position at all.
2. **In `SHAPE_CHECKS`, for `checkBulkToolInput`'s reason.** An impossible date is easier to introduce by
   editing one step's params than by drafting a whole flow, so refine and chat must run it too.
3. **A new module rather than `flow-output-shape.ts`.** That module's docblock is load-bearing and
   specific — *"How a step's output is REACHED, per kind"* — and its test asserts every expression in
   `OUTPUT_SHAPES` appears verbatim in `DRAFT_RULES`. A date literal has no upstream output in it and
   nothing to do with that table.

**What is deliberately NOT flagged**, and this half is the load-bearing one: a pasted day of **28 or
less**, because every month has 28 days and the expression is therefore correct. `-01` in particular is
the ordinary way to name the first of a month — the very same fixture's `period_start` uses it and is
right. February is checked at **29**, not 28, because a leap year makes `-02-29` legal and flagging it
would be wrong one year in four. **The check refuses only what is impossible, never what is unlikely.**

⚠ **`EXPRESSION_FIELDS` was extracted and exported** so the new check and `validateModelExpressions` read
one list. Its own docblock warns that a field missing from it *"is not checked at all — the omission is
silent"*; two copies would double precisely that (D-197).

---

## Phase 6 — the date a month cannot have (2026-08-28)

Added after the feature closed, because the first real use of P5's machinery produced a failure P5 made
reachable. One rule, one check, one shared constant. Build order:

1. **Extract `EXPRESSION_FIELDS`** from `validateModelExpressions`' inline literal and export it.
2. **`flow-date-params.ts`** — `checkConstructedDates`, pure, over the shared field list.
3. **Register in `SHAPE_CHECKS`** — a fixture is then mandatory or the registry guard fails (I-38).
4. **Append the rule to `EXPRESSION_RULES`** — one definition, three prompts (draft, refine, chat).
5. **Perturb.** A check that cannot fail is worse than none.

⚠ **This moves the prompt text**, so `chat:measure`, `draft:measure` and `outline:measure` are stale for
every path again. Marked stale rather than quoted; the re-take is owed before any number is used.

---

## Complexity Tracking

No Article IV deviation. No new dependency, no new abstraction, no new layer, **no migration**.

The one new module is justified by Structure Decision above: keeping `db-operation.service.ts` free of any
path to inference is a property that can be checked with `grep`, and this feature must not be the thing
that ends it.
