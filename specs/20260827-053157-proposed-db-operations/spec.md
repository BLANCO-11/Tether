# Feature Specification: a newly onboarded datasource becomes callable without a person writing SQL

**Feature Branch**: `20260827-053157-proposed-db-operations` (not started — branch is created by `/speckit-specify` when work begins)

**Created**: 2026-08-27

**Status**: Draft — specified and planned, not started.

**Input**: User question — *"if a user onboards a new data source and then uses the chat builder to
generate some automation, can the required data be fetched from the new data source which doesn't have
named queries? can it be done?"*

The answer today is **no**, and the way it fails is the reason this is a feature and not a bug report.
See "The gap" below.

---

## The gap

Onboarding a datasource through the UI runs three calls
([`lib/api.ts:1007-1020`](../../packages/client/src/lib/api.ts#L1007)): `createDatasource` →
`testDatasource` → `refreshSchema`. The schema is introspected and stored. **Zero callable refs are
created.**

That produces an asymmetry inside a single draft prompt, verified by reading the two builders:

| Built from | Includes the new datasource? |
| :--- | :--- |
| **Manifest XML** — `manifestBuilderService.buildAndPersist` | ✅ Renders `<datasource><schema><table><column>` for **every** datasource, whether or not it has queries ([manifest-builder.service.ts:257-327](../../packages/server/src/services/manifest-builder.service.ts#L257)) |
| **CALLABLE STEPS** — `callableCatalogue` | ❌ Built only from `toolRepo` + `datasourceQueryRepo` + `dbOperationRepo` ([flow-generation.service.ts:453](../../packages/server/src/services/flow-generation.service.ts#L453)) |
| **`refFingerprints()` / `refInterfaces()`** | ❌ Same three sources |

So the drafting model is handed every table and column of the new datasource, immediately followed by:

```
CALLABLE STEPS — the complete set. Anything not listed does not exist.
```

…listing nothing that can read any of it. **Nothing in the prompt joins those two facts**, and the
`DRAFT_RULES` refusal guidance — *"Refuse ONLY when NEITHER a tool NOR a named query NOR a DB operation
can provide it"* — never says that a manifest table is not one of those three.

### The two outcomes, and the bad one is the likely one

* **Correct**: the drafter answers `insufficient_catalogue`. Actionable, names the boundary, HTTP 200.
* **Likely**: the drafter saw the schema, so it emits `ref: "newds.customers"`. `unknownRefs()` refuses
  it — *`step "fetch" references "newds.customers", which does not exist in this workspace`* — the
  finding is fed back, three attempts burn, and the caller gets `FlowDraftError`:
  *"could not draft a valid flow in 3 attempts."* **No `missing[]`, no boundary named, nothing a person
  can act on** — and the finding text is actively misleading, because the datasource *does* exist.

⚠ **Chat cannot dig itself out.** The eight ops in `packages/flow-edit/src/ops.ts` are all flow-model
edits. There is no op — and no route reachable by any model — that creates a named query or a DB
operation. Verified by grep: **neither `datasource-query.service.ts` nor `db-operation.service.ts`
imports `inference`.** No model authors a query anywhere in this system, by any route.

### Why the fix is a spec, not raw generated SQL

`CLAUDE.md`: *"`generation-audit.service.ts` was deletable **ONLY** because `datasource` steps run named
queries rather than generated SQL. If a generated-SQL step kind is ever introduced, resurrect the audit
for that kind alone."* Generated SQL also breaks the file-review gate and the fingerprint model — a
query's `sql_text` is inside its ref fingerprint by design (D-17), so regenerated SQL would move
fingerprints and the staleness sweep would keep unarming working flows.

**A `DbOperationSpec` has none of those problems.** It is already pure JSON
(`base`/`columns`/`joins`/`filters`/`sort`/`limit`), `POST …/operations/check` already compiles it
without saving and returns structured findings carrying `identifier` + `available[]`, and
`compileOperation` **only ever emits `SELECT`**. The two safety properties survive unchanged:

1. **Identifiers are metadata, never input.** Every table, column and join side resolves against the
   introspected `schemas` rows; an unresolvable one is a structured finding naming what *was* available.
   The proposer supplies none of the SQL's words.
2. **Values are positional parameters.** A filter binds to `$n` in spec order; `params_schema` is
   *derived* from the filters. A parameter can never become SQL.

So the thing to generate is **the form a person already fills in**, not the SQL.

---

## Clarifications

Answered 2026-08-27 by the requester; each was blocking.

| # | Question | Decision |
| :-- | :--- | :--- |
| 1 | Does a person approve a proposed operation before it becomes a ref? | **Yes.** The proposer writes nothing. A person reviews and saves. |
| 2 | Who names it, and is the name editable? | **The model proposes a name; it is editable.** ⚠ See FR-012 — editable **at proposal time only**. |
| 3 | Does creating a reader break chat's one-op-per-turn bound? | **No — it is a setup step and is not counted.** ⚠ See FR-016 for how that is achieved without weakening the bound. |

⚠ **Decision 2 has a constraint the answer could not have known.** `dbOperationUpdateSchema` has **no
`name` field**, and its docblock states the reason: *"rename is a delete plus a create (the name IS the
ref)."* An operation's name is half of every `<datasource>.<operation>` ref, so renaming after save
breaks every flow referencing it. "Editable" is therefore honoured **before creation, where it is free**,
and the surface must say so at the moment of editing. Rename-after-save is out of scope (see Non-goals).

---

## User Scenarios & Testing

### User Story 1 — The refusal names the real gap (Priority: **P1**)

A person onboards `billing_db` and asks for an automation over it. Today they get *"could not draft a
valid flow in 3 attempts"* after ~90 seconds of inference. They should get, on the **first** attempt and
before any redraft is spent, a refusal that names the datasource, states that its tables are visible but
not readable, and says what to do.

**Why this priority**: it is the whole of the reported confusion, it ships value with **no model
generating anything**, and it is the cheapest half of the I-118 pairing — *teach it in the prompt, catch
it with a check*. The check (`unknownRefs`) already exists; only the prompt half and the finding's
wording are missing.

**Independent Test**: onboard a datasource with an introspected schema and zero queries/operations; run
`POST …/flows/generate` with a goal naming its data. Assert the outcome is `insufficient_catalogue` whose
`missing[]` names the datasource, **not** a `FlowDraftError`.

**Acceptance Scenarios**:

1. **Given** a workspace whose only datasource has an introspected schema and no named queries and no DB
   operations, **When** a goal requiring that data is drafted, **Then** the outcome is
   `insufficient_catalogue`, `missing[]` names the datasource, and `reason` states that its tables are in
   the manifest but nothing callable reads them.
2. **Given** the drafter emits `ref: "billing_db.invoices"` anyway, **When** `unknownRefs()` evaluates it,
   **Then** the finding distinguishes *"`billing_db` is a datasource in this workspace with N introspected
   tables and no readable components — a table is not callable; create a DB operation for it"* from the
   existing generic *"does not exist in this workspace"*.
   ⚠ **And** from the two neighbouring situations FR-002 also names: a datasource that has readers but
   not this one (which lists the ones it has), and a datasource nothing was introspected from (which
   asks for a schema refresh). A single message covering all of them would be the same defect in a new
   direction.
3. **Given** the same workspace also holds a tool whose description covers the need, **When** the goal is
   drafted, **Then** it drafts normally and does **not** refuse — the existing rule that a tool satisfies
   a goal as well as a query does is unchanged.

---

### User Story 2 — A proposed operation, reviewed and saved by a person (Priority: **P2**)

From the refusal, the person asks Foundry to propose the missing reader. A model fills in a
`DbOperationSpec` against that datasource's introspected schema **and nothing else**. The person is shown
the plain-English description, the **compiled SQL**, the derived parameters, and the tables and columns
it touches — and edits the name if they want. Saving creates the operation. Nothing is written until
they save.

**Why this priority**: this is the feature, but it is worthless without US1 — a proposal offered from a
failure nobody could interpret is a second thing to misread.

**Independent Test**: `POST …/datasources/:dsId/operations/propose` with a need statement. Assert the
response contains a compiled SQL string, a `paramsSchema`, and a spec — and assert
`dbOperationRepo.listByDatasource` is **unchanged** afterwards.

**Acceptance Scenarios**:

1. **Given** an introspected schema, **When** a need statement is proposed against it, **Then** the
   response carries `{name, description, spec, compiledSql, paramsSchema}` and **no row is created**.
2. **Given** the model emits a spec naming a column that does not exist, **When** `check()` refuses it,
   **Then** the structured finding (`identifier` + `available[]`) is fed back and the proposal is
   re-attempted, bounded.
3. **Given** the schema genuinely cannot satisfy the need — no date column anywhere, say — **When** the
   proposer answers `insufficient_schema`, **Then** that is returned as a **success** naming what is
   missing, the loop **ends immediately**, and it is never retried.
4. **Given** a proposal is shown, **When** the person edits the name and saves, **Then** the server
   **re-runs `check()` and `create()` on the submitted spec** rather than trusting that it was already
   approved.
4a. **Given** a proposal whose join is `inner`, **When** the review surface renders, **Then** the
   readback states that unmatched rows are **left out** — and the same spec with `left` states they are
   **kept, with a blank customer**. The person needs no SQL to tell those apart.
4b. **Given** the review surface, **When** it renders, **Then** it shows **no rows of data at all**, and
   it states that units and business meaning are **not** checked here.
5. **Given** a proposal is shown, **When** the person abandons it, **Then** nothing exists — no row, no
   manifest version, no ref.
6. **Given** an operation is created, **When** `refFingerprints()` is recomputed, **Then** the manifest
   gains a version and **no existing ref fingerprint moves**.

---

### User Story 3 — Chat proposes the reader mid-conversation (Priority: **P3**)

In chat, *"email me last month's overdue invoices"* against a datasource with no readers currently dead-
ends. Instead the turn should surface a proposal, the person approves it, and the original edit is then
re-attempted.

**Why this priority**: it is the requested entry point, and it is last because it is the only one that
touches the turn path — the module with the most controls per line in the codebase.

**Independent Test**: drive a chat turn whose `add_step` names an unresolvable ref on a schema-bearing
datasource; assert the turn's response kind is a **proposal**, that no revision was written, and that
`CHAT_TURN_MAX_TOKENS` is unchanged.

**Acceptance Scenarios**:

1. **Given** a turn's op names a ref on a datasource with a schema and no readers, **When** the turn is
   evaluated, **Then** the response is a proposal, **not** an applied op and **not** a bare refusal.
2. **Given** the proposal is approved, **When** the original op is re-attempted, **Then** it resolves and
   writes exactly one revision.
3. **Given** the proposal is declined, **When** the conversation continues, **Then** no revision was
   written and the thread is unchanged.
4. **Given** any turn, **When** its response is parsed, **Then** it still carries **at most one op** and
   the 1024-token output ceiling is unchanged.

✅ **CLOSED BY PHASE 5, 2026-08-28** — `needs_component` is reached **3 of 3 runs** (was 0 of 4), with
FR-028's control holding `too_structural` 3 of 3 and no revision written. ⚠ It took a prompt **section**
as well as a rule: a chat turn's prompt carries **no manifest**, so the op call could not name a
reader-less datasource because it had no way to know one existed (**D-203**). The record of the failure
follows, because the shape of it is the reusable part.

⚠ **MEASURED 2026-08-27: scenario 1's PRECONDITION was never established, so none of this fired.**
Scenario 1 begins *"Given a turn's op names a ref on a datasource with a schema and no readers"* — and
the op call **never produces that op.** It answers `too_structural` first, while stating the gap
correctly in prose:

> *"The requested step depends on a specific hr_demo source that does not exist in the available
> callable steps, and there is no single valid one-component change…"*

4 of 4 runs, three phrasings, one naming the datasource outright, on an empty flow
(`chat:measure --scenario=2`). Everything downstream of the op call is built and unit-proven; the op
call is where it stops. **Phase 5 closes this**, and its scenario is:

5. **Given** a chat message asking to read data that only a reader-less datasource holds, **When** the
   turn's op call is evaluated, **Then** it returns an `add_step` whose ref names that datasource —
   **not** `too_structural` — so the missing-reader pass runs and the turn ends `needs_component`.

---

### Edge Cases

* **Datasource not yet introspected** (`create` does not introspect; only `refreshSchema` does). The
  builder already refuses to open with no schema — the proposer must refuse the same way, naming
  re-scan as the fix. It must **never** propose against an empty schema.
* **Name collision.** `create` answers 409 on a duplicate name. The proposer must be handed the existing
  operation and query names for that datasource so it does not propose one that is taken — the same
  treatment `EXISTING TRIGGERS` already gets in the draft catalogue.
* **The name is not a plain identifier.** `dbOperationBodySchema` enforces `IDENTIFIER`; a proposed or
  person-edited name must be validated against the same regex before the dialog will save.
* **Multiple datasources.** A `DbOperationSpec` is scoped to **one** datasource; joins resolve within it.
  Combining across datasources stays a flow-level concern — several steps plus a `code` step. The
  proposer must never be asked to span two.
* **A plausible but wrong operation.** The compiled SQL is valid and the semantics are wrong (join
  direction, filter operator, a missing `COALESCE`). See SC-006 and Non-goals — **nothing in this feature
  validates correctness**, and the surface must not imply it does.
* **A view.** Introspection records a view's columns, not its definition; a view is selectable like a
  table. No special handling, but the proposal must not claim more than introspection knows.
* **Proposal storm.** A single generation must not propose an unbounded number of operations.

---

## Requirements

### Functional Requirements

**The honest refusal (US1)**

* **FR-001** `DRAFT_RULES` MUST state that a table appearing in the WORKSPACE MANIFEST is **not** callable,
  and that data is readable only through a named query, a DB operation or a tool listed in CALLABLE STEPS.
* **FR-002** `unknownRefs()` MUST say WHICH situation a ref it cannot resolve is in. There are **four**,
  and each gets its own sentence:
  1. the ref's `<datasource>` prefix names a **real datasource holding an introspected schema with zero
     readable components** — the situation this feature exists for. Its finding MUST name the datasource,
     state that a table is not callable, and say that a DB operation or a named query is what makes it so.
  2. the prefix names a real datasource that **has readable components, just not this one**. Its finding
     MUST name the ones it does have.
  3. the prefix names a real datasource that **nothing has been introspected from**. Its finding MUST send
     the reader to a schema refresh, not to the operation builder.
  4. the prefix names **nothing at all**. This MUST keep the existing generic finding, **unchanged**.

  ⚠ 2 and 3 are not decoration — each one keeps 1 honest. Without 2, a **mistyped reader name** on a
  datasource with three readers is told it has none: a fresh false sentence in place of the one this
  requirement removes. Without 3, a datasource whose schema refresh failed — which `addDatasource`
  swallows with `.catch(() => null)`, so it is a common real state — is sent to build an operation
  against a schema that is not there.

  ⚠ Where a finding states a table count, it MUST be the number of **distinct entities**. `schemas` holds
  one row per **column**, so a row count would tell a person their datasource has six tables when it has
  two — a number they can check against their own database at a glance, from the message written to stop
  misinforming them.
* **FR-003** The drafter MUST refuse with `insufficient_catalogue` — naming the datasource in `missing[]`
  — rather than exhausting `MAX_DRAFT_ATTEMPTS`, when the goal needs data from such a datasource and no
  tool covers it.
* **FR-004** No surface may describe a manifest table as something an automation can read.

**The proposer (US2)**

* **FR-005** A new service MUST produce a `DbOperationSpec` from (a) one datasource's stored introspected
  schema, (b) a need statement, and (c) the names already taken on that datasource — **and nothing else**.
  It MUST NOT receive a DSN, a database handle, a datasource id usable for connection, any row of data,
  any other datasource's schema, the automation goal, or the flow model.
* **FR-006** FR-005's isolation MUST be asserted **against the proposer's own source**, in the manner
  `buildTablePrompt` is (D-54), not only against its behaviour.
* **FR-007** The proposer MUST have exactly two response channels: a spec, or
  `{"status":"insufficient_schema","missing":[…],"reason":"…"}`.
* **FR-008** A `insufficient_schema` refusal MUST end the loop **immediately**, MUST be returned as a
  success, and MUST NEVER be retried (§6.7).
* **FR-009** A spec refused by `dbOperationService.check()` MUST have its structured findings
  (`code`, `message`, `identifier`, `available[]`) fed back verbatim, bounded by a maximum attempt count.
  Nothing may be added to a finding (I-57).
* **FR-010** The proposer MUST write nothing. No `db_operations` row, no manifest version, no ref.
* **FR-011** The review surface MUST lead with a **plain-English readback** of the spec and the
  **output columns with their provenance** (`customer_name ← customers.name (text)`). The **compiled SQL**
  MUST remain available — collapsed, not removed — and MUST NOT be the primary artefact.
  ⚠ **The original version of this requirement led with the SQL, and that was a review surface written
  for a reviewer this feature's own user stories do not have.** A person who cannot read SQL cannot
  refuse a bad proposal, so leading with it makes the approval in Clarification 1 unfalsifiable. See
  plan Decision 10.
* **FR-012** The proposed `name` MUST be editable **before creation**, MUST be validated against
  `dbOperationBodySchema`'s identifier regex, and the surface MUST state at that point that the name
  **cannot be changed after saving** because it is half of every step ref.
* **FR-013** Saving MUST re-run `check()` and `create()` **on the submitted spec**. An approval token, id
  or "already confirmed" flag MUST NOT be sufficient on its own — an edited spec is evaluated as fresh
  input (the `verifyAcceptedTransform` rule).
* **FR-014** The number of operations proposed per generation or per turn MUST be bounded, and the bound
  MUST be stated on screen rather than silently truncating (FR-012 of `step-payload-bounds`).
* **FR-015** Creating an operation MUST add a manifest version and MUST move **no existing ref
  fingerprint**. This MUST be measured across every workspace, as I-40's change was.

**Chat (US3)**

* **FR-016** A proposal MUST be produced by a **separate inference call with its own token budget**, never
  by widening the turn's response. `CHAT_TURN_MAX_TOKENS` MUST remain 1024 and a turn MUST still carry at
  most one op.
* **FR-017** A turn that surfaces a proposal MUST write no revision.
* **FR-018** The proposer module MUST NOT import from `flow-generation.service.ts`, and
  `flow-chat-imports.test.ts` MUST be extended to pin the chat service's import of the proposer to an
  explicit allowlist entry.
* **FR-019** A declined proposal MUST leave the thread, the flow and the datasource unchanged.

**Everywhere**

* **FR-020** No path in this feature may cause an LLM to emit SQL text. The only SQL produced remains
  `compileOperation`'s output, which is `SELECT`-only and already passes `checkSqlShape`.
* **FR-021** No surface may present an approved operation as *correct*. Approval is a review of intent.

**The readback (US2, and the answer to FR-011)**

* **FR-022** The readback MUST be rendered from the **spec** by **deterministic code**, server-side, and
  returned by `dbOperationService.check()` beside `compiledSql`. It MUST NOT be written by a model.
  ⚠ A model describing its own work is `generation-audit.service.ts` with a new name — the rule
  `flow-refine.service.ts` already states: *"The model returns an edited flow and says nothing about what
  it changed."*
  ⚠ It MUST be **one implementation**. A client-side renderer would be a second definition of what a
  spec means, and the two would drift in the direction where the screen and the SQL disagree.
* **FR-023** The readback MUST state **in words** the two traps that are decidable from the spec alone,
  and this MUST be pinned by a test over every `kind` and every `op`:
  * **join `kind`** — `inner` renders *"invoices with no matching customer are **left out**"*;
    `left` renders *"kept, with a blank customer"*.
  * **filter `op`** — `lt` renders *"**before** the date"*; `lte` renders *"**on or before** the date"*.
* **FR-024** No surface may present **sample, synthetic or generated rows** as what the operation
  returns. See Non-goals for the recorded reason.
* **FR-025** The review surface MUST state what the readback **cannot** check — units and business
  meaning — and MUST point at the test run and **expectations** as the gate that can. It MUST NOT imply
  that approving the readback verifies the data.
* **FR-027** *(Phase 5)* A chat turn asked for data that **only a reader-less datasource holds** MUST
  return an `add_step` naming that datasource, **not** `too_structural`. A missing **reader** is not a
  structural change: it is a component the workspace has not been given yet, and the surface's whole
  purpose is to offer it.
  ⚠ **`CHAT_RULES` already draws this distinction for a missing STEP** — *"a step being absent is the
  reason to add it, never a reason to refuse"* (added 2026-08-21 for the same class of failure). FR-027
  extends it to a missing **reader**, which cannot be fixed by adding a step and therefore reads as
  structural to a model reasoning honestly from the current text.
* **FR-028** *(Phase 5)* The `too_structural` channel MUST keep working for what it is for — a
  redesign, a reorder, a split. ⚠ **A control is required**: a message that genuinely asks to restructure
  an automation must still return `too_structural` after FR-027 lands. Without it, FR-027 is
  indistinguishable from deleting the channel.
* **FR-029** *(Phase 6)* A `date` parameter MUST NOT be bound to a date **built by concatenation**. The
  drafter, refine and chat MUST all be taught this from one definition, and the teaching MUST name the
  consequence rather than state a preference: the day pasted on renders a real date for some inputs and
  an impossible one for others, so a flow built that way **passes the run it is tested with**.
  ⚠ **The rule can be categorical because `ALLOWED_CALLS` is `{json, jq, first, length}`** — there is no
  date function and no arithmetic, so *"the last day of the month a person named"* is not expressible in
  an expression at all. The two remedies (declare the input AS a date; or compute the range in a `code`
  step) are therefore the complete set, not a choice of style.
* **FR-030** *(Phase 6)* A mechanical check MUST refuse an impossible date before a run reaches the
  database, and it MUST run on **every** path that accepts a model — drafted, refined or chat-edited.
  ⚠ **A rule alone is insufficient and this is I-118, not caution**: the prompt is what the model obeys,
  the check is what catches it when the model does not. ⚠ **And a check alone is insufficient**: without
  the rule the model learns the constraint one refusal at a time, which is what `flow-expression-rules
  .ts` exists to record.
  ⚠ **The check MUST NOT fire on a day every month has.** `-01` is the ordinary, correct way to name the
  first of a month; a control that fires on correct code gets switched off, which is I-38 from the other
  end.
* **FR-026** Adding `readback` and `outputColumns` to `check()`'s response is **additive**, and the
  existing human-driven `DbOperationsPanel` MUST render them too. A readback only proposals get would be
  a second review standard for the same artefact, depending on who authored it.

### Key Entities

* **`DbOperationSpec`** — existing. `base{schema?,table}`, `columns[]{column,aggregate?,alias}`,
  `joins[]{table,onLeft,onRight,kind}`, `filters[]{column,op,param}`, `sort[]{column,dir}`, `limit?`.
  Unchanged by this feature.
* **Operation proposal** — new, **transient**. `{name, description, spec, readback, outputColumns,
  compiledSql, paramsSchema, attempts}` or `{status:"insufficient_schema", missing[], reason}`. Never
  persisted.
* **Readback** — new, derived, **never persisted and never model-authored**. An ordered list of labelled
  clauses (`From` / `Kept when` / `You get` / `Ordered by` / `At most`), each optionally carrying a
  `note` — which is where the join-kind consequence is stated. Computed from the spec by pure code, so
  it is a function of the spec and recomputes on every `check()`.
* **Need statement** — new, transient. One sentence describing the data required, derived from the
  drafter's `missing[]` or from the chat message. The proposer's only non-schema input.

---

## Success Criteria

* **SC-001** A datasource onboarded with a schema and no readers, given a goal over its data, yields an
  actionable `insufficient_catalogue` on the **first** draft attempt — not a three-attempt
  `FlowDraftError`. Measured before and after on the same goal.
* **SC-002** Zero code paths cause a model to emit SQL text. Asserted by the proposer's own source test
  (FR-006) plus the existing absence of `inference` in `db-operation.service.ts` and
  `datasource-query.service.ts`.
* **SC-003** Across every workspace, creating a proposed operation moves **0** existing ref fingerprints.
* **SC-004** No `db_operations` row exists after any proposal that was not explicitly saved. Proven by a
  test that proposes and then asserts the repo is unchanged.
* **SC-005** A chat turn's response still carries at most one op, and `CHAT_TURN_MAX_TOKENS` is 1024,
  after the feature ships.
* **SC-006** ⚠ **Proposal quality is measured and reported, never assumed.** Against a fixed set of need
  statements over a known schema, record how many proposals a reviewer accepts unedited, edit, and
  reject. **A number is required before any surface describes this as reliable**, and the figure must
  travel with its sample size — the standard every measurement in this repo is held to.
* **SC-007** The readback is **exhaustively pinned**: a test asserts its rendering for every join
  `kind` and every filter `op` in the schema's enums, so a new operator cannot be added with no words to
  describe it. ⚠ A control asserts the test would **fail** if `inner` and `left` rendered the same
  sentence — the whole value is in that difference.
* **SC-008** No surface renders a row of data that did not come from the tenant's database. Asserted by
  `ui-honesty-check.sh`, in the manner it already pins the absence of a `createFlow`.
* **SC-009** *(Phase 5)* `needs_component` is reached **end to end, measured, not asserted** — a real
  turn over a real reader-less datasource ends in that status with the datasource named and **no
  revision written**. ⚠ **Measured over ≥3 runs**, because the op call was already observed answering
  two different ways to one message (`too_structural` on one run, `applied` on the next). ⚠ **And the
  control is measured in the same run**: a genuinely structural message still returns `too_structural`.
  A one-run pass is not evidence here.
  ⚠ **Recording the model beside the number.** ✅ **MET, `gpt-5.4-mini`, 2026-08-28**:
  `needs_component` **3 of 3** (before: **0 of 4**), FR-028's control `too_structural` **3 of 3**, and
  **0 Kestra round trips** on the gap turns — no revision written.
  ⚠ **SC-006's reading is ambiguous on its own.** A high unedited-acceptance rate means the
  proposals are good **or** that nobody is reading them, and the two are identical in the data. Report it
  beside SC-007's evidence and the readback's own bound (FR-025), never as a quality score.
* **SC-010** *(Phase 6)* An impossible date is refused **before** a run, on every path that accepts a
  model, and the refusal names both remedies. Asserted by `flow-date-params.test.ts` (16 tests) plus the
  registry guard in `flow-model-findings.test.ts`, and **verified by perturbation**: 5 edits — unregister
  the check, make it permissive, make it over-eager, make it leap-blind, weaken the rule — each turned a
  named test red.
  ⚠ **This is the one success criterion in the feature that measures a failure the feature ITSELF made
  reachable.** Before D-204 no step could reference a DB operation, so nothing in any workspace had a
  `date` parameter to bind and this class of bug had nowhere to occur.

---

## Assumptions

* The datasource is Postgres or MySQL — the two types `schema-introspector.service.ts` supports.
* The schema has been introspected. A datasource created over HTTP without `refreshSchema` has none.
* Both safety properties of `compileOperation` hold as documented; this feature adds no SQL emitter and
  changes none of its rules.
* The person approving can read the compiled SQL, or can judge the plain-English description. Where they
  can judge neither, the honest outcome is that they should not approve it.

---

## Non-goals

* **LLM-generated raw SQL**, and LLM-authored **named queries**. Both reopen the deleted audit service,
  the file-review gate and the fingerprint model. See "The gap".
* **Renaming an operation after it is saved.** The name is the ref; a rename is a delete plus a create.
  Out of scope, and FR-012 makes the constraint visible where a person can still act on it.
* **Cross-datasource operations.** A spec is scoped to one datasource. Combining stays flow-level.
* **Writes of any kind.** `compileOperation` emits `SELECT` only, and this feature does not widen it.
* **Auto-approval, or any "trusted" mode that skips the person.** That is Clarification 1 answered.
* **Correctness validation of a proposal.** Nothing here can check units, join direction or business
  meaning. See FR-021 and SC-006.
* ⚠ **Sample, synthetic or generated rows at approval time** — *"show the non-technical user a table of
  data the SQL would produce, so they can check it against their requirement."* **Declined, and the
  reason is recorded so it is not re-proposed from the wrong premise.**
  * **It was built here and deleted.** `lib/mock-rows.ts` and `lib/mockdb.ts` no longer exist. The
    datasource page's own docblock: *"those rows were generated by `lib/mock-rows.ts` from the column
    types — **invented values wearing a real table's column names**, labelled 'synthetic sample' in a
    pill most people would not read as 'none of this is your data'."*
  * **It cannot discriminate.** Synthetic data generated to satisfy a query shows a plausible table
    whether the query is right or wrong. A wrong `inner`/`left` shows only if the sample happens to hold
    an unmatched row; `lt` vs `lte` only if a row sits exactly on the boundary; a missing `COALESCE` only
    if a NULL lands in that column; **units never**. Each is a property of the generator, not of the
    tenant's data.
  * **It is worse than the SQL, not better.** SQL a person cannot read is *honestly opaque* — they know
    they did not verify it. A table of realistic-looking rows **feels** like verification, converting
    *"I cannot check this"* into *"I checked it."*
  * ⚠ **The underlying request is legitimate and is answered elsewhere**: FR-022's readback states the
    decisions in words (which catches join kind and filter operator, both of which synthetic rows miss),
    and a **bounded, redacted preview against REAL rows** is the honest form of "show me what it
    produces" — see the next entry.
* **A live preview against real rows at approval time.** The only mechanism that can catch a units bug,
  and deliberately **not** in this feature. It puts production data on a review screen (needing the
  server-side redaction `flow-visibility.service.ts` gives step output), it reverses
  `DbOperationsPanel`'s stated *"rows are never fetched and never previewed"* design, it requires
  executing a not-yet-saved spec, and it needs a sandbox story. **Its own spec, its own exposure
  analysis** — recorded here so it reads as deferred rather than unconsidered.
* **Proposing an operation during `draftFlow`'s own loop.** Ordering is propose → approve → regenerate.
  Mutating the catalogue mid-draft would change the prompt under a running redraft loop.
