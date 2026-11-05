# Tasks: a newly onboarded datasource becomes callable without a person writing SQL

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) ·
**Contract**: [contracts/operation-proposal.md](./contracts/operation-proposal.md) ·
**Diagrams**: [workflow-diagrams.md](./workflow-diagrams.md)

Ordered so each phase ends somewhere shippable. `pnpm typecheck && pnpm test` after every phase.
⚠ **Node 22 or the client render layer silently does not run** — P2 and P3 touch client files, so this
matters here.

⚠ **This feature adds NO migration.** Head is `0041_approval_override`; a `0042` appearing here means
D-170 or D-179 was reversed without being rewritten. Nothing touches `db/schema.ts`'s tables or
`drizzle/` — T18 is a **docblock edit only**.

⚠ **Before starting**: repoint `.specify/feature.json` at this directory (it currently names
`specs/20260818-123807-tool-probe`), or the agent hooks and the pre-commit gate refuse every source
write — Constitution Article I.

⚠ **P0 moves the cached prefix and invalidates every draft measurement on record** (D-176). P4 re-takes
them. Between P0 and P4, no number from `kestra:refusal`, `outline:measure`, `draft:measure` or
`chat:measure` may be quoted for this path.

**Format**: `[ID] [P?] [Story]` — `[P]` = parallelisable (different files, no dependency).

---

## Status — T01…T34 all COMPLETE (P6 closed 2026-08-28)

| Phase | Tasks | State |
| :--- | :--- | :--- |
| **P0** · the honest refusal | T01–T03 | ✅ complete |
| **P1a** · the readback | T04–T05 | ✅ complete |
| **P1b** · the proposer + route | T06–T10 | ✅ complete |
| **P2** · the approval surface | T11–T17a | ✅ complete · `ui-honesty-check.sh` 196 → **206** |
| **P3** · chat as a setup step | T18–T22 | ✅ complete |
| **P4** · measurement + docs | T23–T26 | ✅ complete |
| **P5** · the op call reaches P3's machinery | T27–T30 | ✅ **complete** — `needs_component` **3 of 3**, was 0 of 4 |
| **P6** · the date a month cannot have | T31–T34 | ✅ **complete** — 5 perturbations, 5 red |

**Green**: 7/7 typechecks clean · server **1795 passed / 23 skipped** (1820 total, P6 added 16) ·
client **908** ·
`ui-honesty-check.sh` **206 PASS / 0 FAIL**.
⚠ **Failures are PRE-EXISTING or FLAKY, none this feature's.** `trigger-gate.test.ts` (staged-modified
by another feature) and `flow-replay.test.ts` fail deterministically. `datasource-target.test.ts` fails
on **5-second timeouts** against a live Postgres — **2 failures on one run and 1 on the next with
identical code**, and it imports nothing this feature touches. It is also the test that leaves
`ds-target-control-*` workspaces behind: **6 now, up from 4**, i.e. it died mid-run twice more.
**Do not fix any of them here.**

⚠ **Two things shipped that DO NOT work as the spec assumed**, both measured in P4:
1. **Chat's `needs_component` never fires** — the turn answers `too_structural` first (**D-201**).
   Every piece is built and unit-proven; the path is dead end-to-end on `gpt-5.4-mini`.
   ✅ **CLOSED by P5** — `needs_component` now reached **3 of 3 runs** (was 0 of 4), FR-028's control
   held `too_structural` **3 of 3**, and no revision is written (0 Kestra round trips). ⚠ It took a
   prompt **section** as well as a rule — **D-203** corrects D-202 on that.
2. **SC-001 shows no measurable difference** on this model — 3/3 refused on attempt 1 with T01's rule
   and without it. The gemma failure it was written for could not be re-taken: **gemma was down.**
   ⚠ **Still open. P5 does not address it** and must not be read as doing so.

---

## P0 — the honest refusal · US1 · no model authors anything

Ships alone, and it is most of the reported pain: today a datasource with no readers costs ~90 s of
inference and answers *"could not draft a valid flow in 3 attempts."*

### T01 · US1 · `packages/server/src/services/flow-generation.service.ts`

Add D-176's rule to **`DRAFT_RULES`** ([:214](../../packages/server/src/services/flow-generation.service.ts#L214)),
in the `RULES` block directly after *"Reference only the tools, named queries and DB operations in the
CALLABLE STEPS section. Do not invent one."*

```
  * A table listed in the WORKSPACE MANIFEST is NOT callable. You can read a datasource's
    data only through a named query, a DB operation or a tool that appears in CALLABLE
    STEPS. If the data you need is visible in the manifest but nothing in CALLABLE STEPS
    reads it, that is `insufficient_catalogue` — name the datasource in `missing`.
```

⚠ **Wording is load-bearing and this is the half with no check behind it** (I-118's pairing). Do not
compress it: the manifest/CALLABLE-STEPS distinction is the entire content.
⚠ This changes every draft prompt in every workspace once, at deploy. That is accepted — see T24.

### T02 · US1 · `packages/server/src/services/flow-generation.service.ts`

**`unknownRefs()`** ([:1122](../../packages/server/src/services/flow-generation.service.ts#L1122)) — FR-002.

Today it opens with a bare `await manifestBuilderService.refInterfaces(workspaceId)`. Make it:

```ts
const [interfaces, datasources] = await Promise.all([
  manifestBuilderService.refInterfaces(workspaceId),
  datasourceRepo.listByWorkspace(workspaceId),
]);
```

⚠ **One `Promise.all`, resolved ONCE before the step loop — never per step.** `draftFlow` calls this on
every attempt, and a per-step query turns a 12-step draft into 12 round trips.
⚠ `datasourceRepo` is **already imported** in this module. **`schemaRepo` is not — add it**, and read it
**lazily and memoized, on the failure path only** (D-180). FR-002's *"holding an introspected schema"* is
answerable from neither `interfaces` nor the datasource row.
⚠ A stated table count is **distinct entities**, not `rows.length` — `schemas` is one row per COLUMN
(D-182). Singular too: *"1 introspected table"*, never *"1 tables"*.

Then, in the `if (!iface)` branch, split the message **four ways** (D-181 — this was *"two situations, two
sentences"* until P0's code showed that two of them make the first one false):

| Prefix names | Sentence |
| :--- | :--- |
| a real datasource · schema · **no readers** | `step "fetch" references "billing_db.invoices" — "billing_db" IS a datasource in this workspace, with N introspected tables, but it has no readable components. A table is not callable: create a DB operation or a named query for it.` |
| a real datasource · **has readers, not this one** | `… — "billing_db" IS a datasource in this workspace, but it has no readable component named "invoices". Its readable components are: billing_db.by_customer, billing_db.open_invoices` |
| a real datasource · **nothing introspected** | `… — "billing_db" IS a datasource in this workspace, but nothing has been introspected from it and it has no readable components. Refresh its schema, then create a DB operation or a named query.` |
| **nothing at all** | **unchanged** — `step "x" references "ghost_tool", which does not exist in this workspace` |

⚠ Row 2 needs **no query** — a ref is keyed `<datasource>.<name>`, so "any readers?" is a prefix scan of
`interfaces`. Row 3 exists because `addDatasource` swallows a failed schema refresh (`.catch(() => null)`),
making "onboarded with no schema" a **successful** onboarding.

### T03 · US1 · `packages/server/src/services/flow-generation.test.ts`

⚠ **First**: this file mocks `./manifest-builder.service.js` with `refInterfaces` **only**. T02's new
reads mean the **three pre-existing `unknownRefs` tests** would open a real Postgres connection — and a
test whose failure mode is *"no database in CI"* is indistinguishable from the code being wrong. Mock
`datasource.repo.js` and `schema.repo.js`, and add `datasourceRepo.listByWorkspace → []` to the existing
`beforeEach`. `draftFlow`'s case needs five more (`tool`, `datasource-query`, `db-operation`, `trigger`,
`flow`) plus `buildAndPersist`.

⚠ **What is NOT testable here** (D-183): *"does the model refuse rather than invent?"* With a stubbed
client the answer is whatever the stub says. That is **SC-001, a measurement** — see the exit line.

**FR-002 · `unknownRefs` — one test per row of T02's table, plus two:**

1. no readers → names the datasource, `2 introspected tables` from a **6-row / 2-entity** fixture,
   *"A table is not callable"*, and **not** *"does not exist in this workspace"*.
2. `1 introspected table,` — the singular.
3. nothing introspected → *"nothing has been introspected from it"*, *"Refresh its schema"*, and **no**
   table count.
4. has other readers → *"no readable component named "invoices""*, lists them, and asserts
   `schemaRepo.listByDatasource` was **not** called (nothing a count would add on that path).
5. ⚠ **Control**: nonsense prefix → the generic sentence, and `not.toContain("IS a datasource")`.
6. ⚠ **Cost**: three bad refs on one datasource → `listByWorkspace` called **once**, `listByDatasource`
   **once**. `draftFlow` calls this on every attempt, and a read that slipped into the step loop would
   only ever look like *the model* being slower.

**FR-001 · `buildDraftPrompt` — the only mechanical check on T01:**

7. contains *"A table listed in the WORKSPACE MANIFEST is NOT callable"*.
8. contains *"that is `insufficient_catalogue` — name the datasource in `missing`"*. Half a rule is worse
   than none: *"not callable"* with no *"and here is what to do instead"* leaves the model choosing
   between inventing a ref and refusing with a `missing[]` nothing downstream can act on.
9. ⚠ **Control**: *"A TOOL that returns the data a goal needs satisfies that goal exactly as well"* still
   present. The new rule pushes toward refusing; this sentence is the counterweight, and losing it turns
   every tool-fed workspace into a false refusal **with no failing test of its own**.

**FR-003 · `draftFlow` — nobody asserted this anywhere before:**

10. a stub returning `insufficient_catalogue` → the refusal is returned, `missing[]` **verbatim**, and
    `client.count === 1`. `MAX_DRAFT_ATTEMPTS` is 3, and re-asking is exactly how a correct *"I cannot
    build this"* becomes an invented ref on attempt 2 — plus the ~90 s the person waits for it.

**Exit P0**: `pnpm typecheck` clean and `vitest run` green on this file. **SC-001's measurement is
DEFERRED to T24** — decided 2026-08-27, recorded in plan.md Decision 15. `kestra:refusal` is the wrong
harness (it measures the FRAGMENT channel); `draft:measure` is the right one but has no reader-less
case; and the **"before"** number now needs a temporary revert of T01. T24 re-takes all four anyway.

---

## P1 — the readback and the proposer · US2 · server only

### T04 · [P] · US2 · **NEW** `packages/server/src/services/db-operation-readback.ts`

`readback(spec: DbOperationSpecInput): ReadbackClause[]` — **pure**. No zod, no repo, and **no
`inference` import**, the same shape `flow-model-findings.ts` and `flow-expression-rules.ts` take.

```ts
export interface ReadbackClause {
  label: "From" | "Kept when" | "You get" | "Ordered by" | "At most";
  text: string;
  /** Where a join's CONSEQUENCE is stated. This is the field FR-023 exists for. */
  note?: string;
}
```

Owns the two English maps (FR-023):

| Spec value | Renders |
| :--- | :--- |
| `kind: "inner"` | note: *"rows with no matching &lt;table&gt; are **left out**"* |
| `kind: "left"` | note: *"rows with no matching &lt;table&gt; are **kept, with a blank &lt;table&gt;**"* |
| `op: "lt"` | *"is **before** the value you supply"* |
| `op: "lte"` | *"is **on or before** the value you supply"* |
| `op: "eq"` / `neq` / `gt` / `gte` / `in` / `like` | one distinct phrase each — **no two may collapse** |

⚠ **Exhaustive over the enums by construction** — a `Record<(typeof FILTER_OPS)[number], string>` so
adding an operator to `FILTER_OPS` fails to compile until it has words. A `default:` case here is how a
new operator ships with no sentence describing it.

### T05 · [P] · US2 · **NEW** `packages/server/src/services/db-operation-readback.test.ts`

Exhaustive over `JOIN_KINDS × FILTER_OPS` (SC-007), plus:

- ⚠ **the collapse control** — assert the suite **fails** if `inner` and `left` render the same note. The
  whole value of the readback is in that difference; a test that passes when they collapse is testing
  nothing (I-38).
- ⚠ **a purity control** — construct and call `readback()` in a test file that imports **no**
  `InferenceClient` at all (contract invariant 9).

### T06 · US2 · `packages/server/src/services/db-operation.service.ts`

`CompiledOperation` ([:169](../../packages/server/src/services/db-operation.service.ts#L169)) gains:

```ts
  /** `alias ← source (type)`, so a reviewer can check the columns with no SQL. FR-011. */
  outputColumns: Array<{ alias: string; source: string; type: string | null }>;
```

The data is **already resolved**: `resolveColumn` ([:295](../../packages/server/src/services/db-operation.service.ts#L295))
returns `columnType`, and `selected` ([:399](../../packages/server/src/services/db-operation.service.ts#L399))
already carries `owner` + `alias`. Thread `columnType` into `selected` and project it.

⚠ **`source` is the qualified table name, not the `t0`/`t1` SQL alias.** `t1.name` means nothing to a
reviewer; `customers.name` is the point.
⚠ **Do not touch the SQL emission.** The `SELECT`-only property is the whole safety argument (D-169).
Additive fields only.

### T07 · US2 · `packages/server/src/services/db-operation.service.ts`

`check()` ([:664](../../packages/server/src/services/db-operation.service.ts#L664)) returns `readback` and
`outputColumns` beside `compiledSql` (FR-026).

⚠ **Additive to an existing response, and the existing human-driven panel is a beneficiary, not a
bystander** (T14). A readback only *proposals* carried would be two review standards for one artefact,
chosen by who authored it.
⚠ The `ok: false` branch is **unchanged** — a spec that will not compile has no readback, and inventing
one from an invalid spec is a sentence describing something that cannot run.

### T08 · US2 · **NEW** `packages/server/src/services/db-operation-proposal.service.ts`

`proposeOperation({ workspaceId, dsId, need })`.

**Imports, and this list is the control** (FR-005/FR-018): `schemaRepo`, `dbOperationRepo`,
`datasourceQueryRepo`, `dbOperationService.check`, `inference`. **Nothing else**, and in particular
nothing from `flow-generation.service.ts`.

Prompt: the introspected schema for **one** datasource + the need + the names already taken. `TASK` last,
matching every other prompt builder here.

⚠ **No DSN, no connection string, no database handle, no datasource id usable to connect, and NO ROW OF
DATA** (FR-005). D-54's rule: shown real rows to imitate, the output stops being derived from the schema.
⚠ Two channels, and a **status-less response is rejected, never read as `ok`** — `parseFragmentResponse`'s
own warning (D-171).
⚠ `insufficient_schema` **returns immediately**. One attempt. Never retried (FR-008).
⚠ `check()` findings are fed back **verbatim**, nothing added (FR-009 · I-57, where 25 of 26 findings
were a scanner bug fed to a model as fact).

### T09 · US2 · `packages/server/src/routes/datasources.ts`

`POST /:dsId/operations/propose`, declared **immediately after `/operations/check`**
([:248](../../packages/server/src/routes/datasources.ts#L248)).

⚠ Comment the ordering, as `/generate/jobs` does: no `POST /:dsId/operations/:name` exists today, so
nothing shadows this — but one declared **above** these would swallow both `check` and `propose`, and the
symptom is a 404 that reads like a missing operation rather than a routing mistake.

Per the contract: `400` bad `need` · `404` unknown datasource · **`409` schema not introspected, and the
message must name re-scan as the fix** · `502` gateway unreachable, which **must not consume an attempt**
(infrastructure, not a bad proposal).

### T09a · US2 · `packages/server/src/services/db-operation-proposal.service.ts` + T13/T21 surfaces

**FR-014 — bound the number of proposals per generation and per turn**, and **state the bound on screen**.

`MAX_PROPOSALS_PER_REQUEST` beside the attempt bound. ⚠ **Never silently truncate** (`step-payload-bounds`
FR-012): a surface that stops offering proposals without saying it has stopped reads as *"there is nothing
more to propose."*

⚠ **DONE IN P1b, and not the way this task assumed.** The constant is exported **and travels on BOTH
response channels as `maxPerRequest`** — because FR-014 requires the bound to be *on screen*, and a
surface hardcoding `3` would be a second definition of it. **It is not enforced server-side and cannot
be**: one propose call has no notion of "this generation", and the server holds no proposal state at all
because D-170 forbids persisting a proposal and D-179 forbids a turn storing one. A server-side counter
would be that state under another name. See plan Decision 21 (**D-189**).

⚠ **What T13 still has to decide**: the bound has to be stated *before* the first proposal, and
`maxPerRequest` only arrives *with* one. Either the surface states "up to N" from the first response of
the session and holds it, or the number moves to the catalogue's `caps` (which is where `FLOW_CAPS`
already reaches the client). **Do not hardcode it in the client** — that is the second definition this
decision exists to avoid.

⚠ **This is the approval-fatigue control, and it is the one on this list most likely to be cut as
premature.** It is not: a person clicking through a queue of proposals is exactly the state where
SC-006's acceptance rate stops meaning anything.

### T10 · US2 · **NEW** `packages/server/src/services/db-operation-proposal.service.test.ts`

- both channels
- `insufficient_schema` spends exactly **one** attempt
- a `check()` finding is fed back verbatim
- ⚠ **FR-006 — read this module's own source** and assert it contains no DSN, connection string, database
  handle, row fetch, or read of another datasource's schema. A behavioural test passes just as well when
  a field is present and merely unused, and the next person to touch the function will use it (D-54's
  precedent).
- ⚠ **SC-004** — propose, then assert `dbOperationRepo.listByDatasource` is **unchanged**.

**Exit P1**: US2 scenarios 1–3 green · SC-002, SC-004, SC-007 proven.

---

## P2 — the approval surface · US2 · client

### T11 · [P] · US2 · `packages/client/src/lib/foundry-client.ts`
`proposeOperation(ws, dsId, need)` + `ReadbackClause` / `OutputColumn` types mirroring the contract.

### T12 · [P] · US2 · `packages/client/src/lib/api.ts`
Thin wrapper beside `checkOperation` / `createOperation`.

### T13 · US2 · `packages/client/src/components/data/DbOperationsPanel.tsx`

⚠ **The `maxPerRequest` question T09a left open is ANSWERED: held from the first response, and the
catalogue's `caps` was rejected** — plan Decision 26 (**D-194**). `caps` is typed `typeof FLOW_CAPS`, the
flow *validator's* cap set, and this panel does not read the catalogue at all, so the alternative was a
workspace-wide join fetched to render one integer. The residual gap is stated rather than papered over:
nothing numeric is on screen until the first response, and the affordance that can exceed the bound —
**"Propose another"** — only exists after one.

⚠ **The client-side control is a source-read**: `setCap(r.maxPerRequest)` must be present and
`/maxPerRequest\s*[:=]\s*\d/` must not match. Hardcoding the cap turns **3** tests red.

"Propose one for me" → the review dialog, ordered **exactly** (FR-011, D-178):

1. **the readback** — labelled clauses, `note` rendered beneath its clause
2. **output columns** — `alias ← source (type)`
3. params
4. the **editable name**, with Decision 5's sentence: *"This name becomes part of every automation that
   uses it and cannot be changed later."*
5. **the compiled SQL, collapsed behind a toggle**

⚠ **The SQL is collapsed, not removed.** Removing it loses a real reviewer.
⚠ **No rows of data anywhere** (FR-024). `lib/mock-rows.ts` was built here and deleted as *"invented
values wearing a real table's column names."*

### T14 · US2 · `packages/client/src/components/data/DbOperationsPanel.tsx`

The **existing human-driven builder** renders the readback and output columns too (FR-026) — same
component, from the same `check()` response it already fetches on Check.

⚠ Not a bonus: a readback only proposals get is two review standards for one artefact.

### T15 · US2 · `packages/client/src/components/data/DbOperationsPanel.tsx`

FR-025's sentence, beside the approve action:

> This checks **what the query asks for**, not whether the data is right. Units and business meaning are
> not checked here — test-run the automation and add an expectation.

⚠ Must not imply approving the readback verifies the data. It is the honest half of the gate.

### T16 · US2 · `packages/client/src/app/(app)/flows/new/page.tsx`

The `insufficient_catalogue` panel offers propose when `missing[]` names a datasource.

⚠ **Not a Retry.** It offers a *different action*, exactly as the `policy_transform` confirm button does.
The regenerate button's disabled-until-the-goal-changes rule is **untouched**.

⚠ **DONE, and it LINKS rather than embedding** — plan Decision 27 (**D-195**). A `MissingDatasources`
component offers the source's own page, where the review dialog already lives. Embedding it here would be
a second implementation of the readback rendering, the immutable-name warning and FR-025's caveat — two
review standards for one artefact, which is FR-026's argument arriving from the other side.

⚠ **It reads `listConnections()`, and this task's obvious implementation would have been WRONG.** Matching
`missing[]` against `catalogue.entries[].datasource` finds nothing in exactly the case that matters: the
refusal T01 added fires when the datasource is introspected and has **no readable components**, so it
contributes **zero** catalogue entries by construction. A failed read renders nothing — the refusal above it
is complete without the shortcut, so silence withholds a link rather than making a claim.

### T17 · US2 · `scripts/ui-honesty-check.sh` + **NEW** `…/DbOperationsPanel.test.tsx`

There is no test for this panel today. Add render tests for US2 4a/4b, and three script assertions:

1. the immutable-name sentence is present
2. FR-025's "not checked here" sentence is present
3. ⚠ **SC-008** — no surface renders a row of data that did not come from the tenant's database, in the
   shape the script already uses to pin the absence of a `createFlow`

### T17a · US2 · `packages/server/src/services/manifest-fingerprint.test.ts`
**Also**: `packages/server/src/scenarios/fingerprint-measure.ts` (new, `fingerprint:measure`) —
half B of the split D-196 records.

**FR-015 / SC-003** — creating an operation adds a **manifest version** and moves **zero existing ref
fingerprints**. Measure across every workspace on this deployment, and record the number.

⚠ **This is I-40's check, repeated for the same reason it was invented.** `refFingerprints()` hashes each
ref independently, so a new ref *should* be additive — but if it were not, the staleness sweep would
**unarm every armed flow in every workspace** on the next poll tick. The measurement is cheap; the failure
mode is not.
⚠ A test asserting "0 moved" over a workspace with **no** armed flows proves nothing. Run it where there
is something to lose.

⚠ **DONE IN TWO HALVES, AND THE SECOND IS INCONCLUSIVE ON THIS DEPLOYMENT** — plan Decision 28 (**D-196**).

| Half | Where | Result |
| :--- | :--- | :--- |
| *A create adds one key and moves no other* | `manifest-fingerprint.test.ts`, new `FR-015` block — 6 tests, **2 controls** that the fingerprints can move at all | ✅ green; **proven to fail** — folding a workspace-global count into the tool payload turns 2 red |
| *Adding a key moves no armed flow's aggregate* | **NEW** `pnpm --filter @foundry/server fingerprint:measure` — every workspace, every armed flow, real `aggregateFingerprint`, **zero writes** | ✅ **PASS — 0 moved**, exit 0 |

⚠ **It writes NOTHING.** The probe is a synthetic `<datasource>.__fingerprint_probe__` key appended to the
real fingerprint map, not a created row. Creating a real operation in a workspace holding armed flows, to
find out whether creating one unarms them, is a measurement that damages the thing it is measuring when it
fails.

**SC-003, measured 2026-08-27**: 8 workspaces · 45 refs · **2 armed flows** · 2 probes ·
**0 fingerprints moved** · 0 unstable across two reads · 0 flows already stale.

⚠ **It was INCONCLUSIVE on the first run and correctly said so** — the deployment held **zero** armed
flows and zero `db_operations`, so "0 moved" would have been a statement about an empty set (this task's
own warning, and I-38). `pnpm scenarios:seed` was run **with the user's authorisation** to create the
condition: 2 Finance flows armed with live cron schedules, the gated third paused at its gate and killed.
`scenarios:verify` afterwards: **13 passed / 0 failed**.

⚠ **The PASS is only meaningful because the script was shown able to FAIL over these same armed flows.**
Two perturbations: pointing the probe at an existing ref trips the collision guard (exit 2), and moving a
fingerprint the armed flow *itself references* reports **2 moved** and exit 1. ⚠ A third perturbation —
overwriting `Object.keys(current)[0]` — did **not** fire, and that was the perturbation being wrong, not
the control: it lands on `foundry_email_send`, which neither armed flow references, so the aggregate
correctly ignores it. That is §6.5 working, and it is a trap for the next person taking this measurement.

⚠ Four junk `ds-target-control-*` workspaces were also found, left behind by `datasource-target.test.ts`;
not this feature's to clean up.

**Exit P2**: US2 scenarios 4–6, 4a, 4b green · **SC-003 measured (0 fingerprints moved)** · SC-008 pinned.

---

## P3 — chat as a setup step · US3

### T18 · US3 · `packages/server/src/db/schema.ts` — **DOCBLOCK ONLY**

Add `needs_component` to `flow_chat_turns.status`' documented list
([:1848](../../packages/server/src/db/schema.ts#L1848)).

⚠ **No migration.** The column is `varchar(32)` with no database enum (D-179). **A `0042` in this feature
means D-179 was reversed without being rewritten.**

### T19 · US3 · `packages/server/src/services/flow-chat.service.ts` + `flow-generation.service.ts`

⚠ **DONE, and the detection mechanism is NOT what this task implied** — plan Decision 29 (**D-197**).
"Detect" was going to mean either string-matching the drafter's finding (couples a control to prose that
will be reworded, and fails silently) or re-deriving the condition here from three new repo imports (a
second definition, in the module with the most controls per line in the codebase).

Instead the fact **travels from the place that already computed it**: `unknownRefs` became a thin wrapper
over new **`refFindings`**, which returns the findings *and* `ComponentGap[]` from the same pass;
`FlowDraftError` carries them; `attemptOp` reads them off the error it already catches.

⚠ **`unknownRefs`' signature, behaviour and all thirteen of its tests are UNTOUCHED** — every draft
measurement on record was taken against it — and a test asserts the two agree byte-for-byte on the
findings, with a control that the comparison is not over two empty arrays.

⚠ **A gap is emitted only when `introspectedTables > 0`.** With nothing introspected the fix is a re-scan,
and proposing there produces the 409 the propose route exists to give.


In `attemptOp`'s `authorFlow` catch branch, detect *"unresolvable ref whose prefix is a schema-bearing
datasource with no readers"* and finish the turn `needs_component`:

- `findingsJson` carries the human-readable finding (D-179)
- **no revision is written** (FR-017)
- ⚠ **no proposal is persisted** — the client fetches it from T09's route

⚠ **A separate call with its own budget** (D-175). `CHAT_TURN_MAX_TOKENS` **stays 1024** and a turn still
carries at most one op. The bound is a hard output ceiling, not a prompt rule — raising it is how *"a turn
cannot be a redesign"* stops being structural.
⚠ **`correctable: false`.** This is not a validation finding a corrective pass can fix; the flow is
missing a component, and re-asking the model produces a different op nobody wanted.

### T20 · US3 · `packages/server/src/services/flow-chat-imports.test.ts`

~~Extend the pinned allowlist: the chat service may import `proposeOperation`~~, and **the proposer must
import nothing from `flow-generation.service.js`** (FR-018).

⚠ **THE STRUCK-THROUGH HALF WAS WRONG, and it inherited the error from plan.md's Phase-3 table.** D-179
says the proposal is *"fetched by the client from the propose route"*, so the chat service imports
**nothing** from the proposer — and that absence is asserted in **both** directions, which is stronger than
an allowlist entry. See plan Decision 29 (**D-197**).

The allowlist did grow by one: **`type ComponentGap`**, erased at runtime, so it grants the module no
capability. Six symbols now, not five.

⚠ The existing test reads only symbols **from `flow-generation.service.js`** in the chat file, so it
would not have seen a new module at all. That is exactly why this task exists rather than relying on it.

### T21 · US3 · `packages/client/src/components/flow/ChatPanel.tsx`
**Also**: `packages/client/src/components/data/OperationReview.tsx` (new) — the review surface was
**extracted** from `DbOperationsPanel.tsx` because `ChatPanel` is the third surface approving a spec.
⚠ The extraction turned `ui-honesty-check.sh`'s two positive assertions **red immediately** and left
`DbOperationsPanel.test.tsx`'s negative greps **green** — *"this file does not contain X" stays true
when X leaves*. Both now read the pair.
Render the `needs_component` bubble → the T13 dialog. On approve, re-attempt the original message.

⚠ **Computed fields only.** No sentence a model wrote — `ui-honesty-check.sh`'s ban on `turn.text` is not
satisfied by a different field name.

### T22 · US3 · `packages/client/src/components/flow/ChatPanel.test.tsx`
US3's four scenarios, plus **SC-005 as a control**: assert `CHAT_TURN_MAX_TOKENS` is still 1024 and a turn
still carries at most one op.

**Exit P3**: US3 green · SC-005 proven.

---

## P4 — measurement and documentation · not optional

### T23 · SC-006 — DONE
`packages/server/src/scenarios/propose-measure.ts` (new; registered as `propose:measure` in
`packages/server/package.json`), 7 need statements over `hr_demo`'s 7 tables.
⚠ The adjudicator lives in **`propose-adjudicate.ts`** — pure, asserted by
**`propose-measure.test.ts`** (13 tests, with a control that it does not return one verdict for
everything). Extracted because a scenario script's `main()` runs at import: the test loaded the repos
and the gateway client, and a live run would have fired the harness inside the suite.
**Records D-198.**

⚠ **SC-006 asks for a REVIEWER's split and there is no reviewer** — so it is adjudicated against an
expectation **declared before any proposal was seen**, in the commit that created the file. The two
alternatives were rejected as worse than no number: an implementer eyeballing their own system's
output, or a model judging a model. Consequence, stated in the output: `edited` is an **upper** bound
and `unedited` a **lower** bound on what a person would report.

**Reading, `gpt-5.4-mini`, 3 rounds** — proposing **9 unedited · 3 edited · 0 rejected** (n=12);
refusing **6 correct · 0 proposed anyway** (n=6). The two arms are reported **separately** because a
correct refusal lands in `unedited`, and pooling makes "proposed badly, refused perfectly" score the
same as the reverse.

⚠ **`--rounds` defaults to 3 and that is a finding**: the first two runs disagreed (5/1/0 then 6/0/0)
at n=6.

⚠ **The hard case fails, 3 of 3, and it is the most valuable case here.** *"Below their own
department's threshold"* needs a column-to-column comparison, which the form cannot express. It
proposed a compiling spec joining `attendance_monthly.employee_id` to
`policy_thresholds.department_id` — **an employee id equated to a department id** — and **the readback
stated it in plain English**: *"each row matched to policy_thresholds, by employee_id =
policy_thresholds.department_id"*. The strongest evidence in this feature that the readback is the
right review artefact, produced by the case designed to fail.

⚠ **Incidental, and stronger than SC-004's unit test**: ~35 live propose calls across 5 runs left
`hr_demo` with **0** `db_operations`.

⚠ **Out of scope, real**: `compileOperation` does not require a join to follow a declared FK — two
integer columns compile. Pre-existing (a person can build the same join visually), but a model can now
reach it, and the readback is the only thing standing there.

### T24 · D-176 — re-take what T01 invalidated — DONE
All four re-taken on **`gpt-5.4-mini`**, plus SC-001's before/after and the reader-less chat case.
**Records D-199, D-200, D-201.**

**Files**: `scenarios/draft-measure.ts` (the `refused` outcome, SC-001's case, `--model=`),
`scenarios/chat-measure.ts` (`expectStatus`, `SCENARIO_2`, `--scenario=`),
`scenarios/outline-measure.ts` and `kestra/refusal-verify.ts` (the resolved model in the header).
⚠ `services/flow-generation.service.ts` was reverted and **restored byte-identical** for SC-001's
"before" half — `diff -q` verified; it carries no P4 change.

⚠ **They are not re-takes of the same thing.** The old numbers were gemma; this deployment resolves
`gpt-5.4-mini` from a `/ai-provider` override, so **the old numbers are not a baseline for the new
ones.** `refusal-verify.ts` and `outline-measure.ts` printed **no model at all** and now print the
resolved one — a number filed under no model's name is read as the last one.

| Harness | Reading |
| :--- | :--- |
| `kestra:refusal` | **3 refused, 0 invented**; control clean 3 of 3 |
| `outline:measure` | kept **2 of 3** · drifted 0 · no parseable draft 1 (a step id over 63 chars) |
| `draft:measure` | goal **7/12, 1.1 attempts, 2.5 s** · outline **3/3, 2.0 attempts, 5.7 s** |
| `chat:measure` | 5 turns · applied 2 · refused 2 · failed 1 · steps reached 2 of 5 |

⚠ **`draft:measure`'s ordering INVERTED** — the complaint it was built for was *"goal mode takes
forever, stepwise is quick"*; outline mode is now the slower, more attempt-hungry arm.
⚠ **`chat:measure`'s 2 of 5 is one failure plus its consequences** — turn 1 failed on a nested `{{ }}`
(I-11), leaving the flow empty, so turns 2 and 3 correctly said *"the automation is empty"*.

**SC-001 — measured, and the answer is NO DIFFERENCE.** n=3 each half, same model, same goal, T01's
four rule lines deleted and restored (byte-identical restore verified with `diff -q`): **3/3 refused
on attempt 1 both ways.** `gpt-5.4-mini` already declines to call a table unprompted. The failure T01
was written for was measured on gemma — and **gemma was down**, so the improvement could not be shown
either way. ⚠ A gemma run reported *"1 attempt, then a failure"*, which is the shape of a badly
behaving model; that reading was **discarded, not recorded**.

⚠ **`draft:measure` could not measure SC-001 as it stood.** A refusal scored as `FAILED`, its reason
landed in `other`, and it counted against `N/M drafted` — so "refused correctly on attempt 1" and
"burned three attempts and threw" were identical in every column. Fixed (D-200): a third outcome, a
declarable `expectRefusal`, and the SC-001 block reports **attempts**. `outline-measure.ts` already
had this right, which is what makes it a defect rather than an oversight.

⚠ **HR was nearly the wrong fixture, and it looked right.** `hr_demo` is reader-less (7 tables, 0
queries, 0 operations) — but HR holds **16 tools**, four reading attendance, so every attendance goal
is served without the datasource being reached. The arm would have passed while measuring nothing.
Found by reading a **passing** run. The SC-001 case is over `leave_requests`, which no tool serves.

**The reader-less chat case — `chat:measure --scenario=2`, and it FAILS.** See D-201: the turn answers
`too_structural` while naming the gap in prose, so `authorFlow` never runs and `needs_component` never
fires. **Not fixed** — a measurement task must not quietly become a prompt change to the most
controlled module here. Handed to the user.

### T25 · Article VII — DONE
**`WORKFLOW-CREATION-AND-GENERATION.md`** — the *"SQL was generated"* row rewritten precisely rather
than deleted (*"No model emits SQL text, by any route"* + a model may fill in the **spec**, and the
form has no field a string of SQL could go into); DB operations described as visual **or** proposed;
the CALLABLE-STEPS quote gains T01's manifest-is-not-a-catalogue rule; `kestra:refusal`'s number now
carries **both models in a table**; and a new **§5 *Cross-cutting C*** covering the missing reader,
the proposal, its four properties, and the chat gap.

**`CLAUDE.md`** — a new section for the feature, plus the two inaccuracies this feature found:
* *"Every generation measurement was taken on gemma"* → the override, the resolved model, the two
  harnesses that printed none, and the down-model trap.
* *"The deployment holds THREE flows"* → **five, 2 armed**. Two `Untitled flow` drafts (08-24, 08-25)
  that nothing cleans up — **not deleted here**, they are somebody's working state. ⚠ And the claim
  was false in the **other** direction when P2 began: **zero** flows deployment-wide, restored only by
  re-running `scenarios:seed`.
* `ui-honesty-check.sh` recorded at **206**, not 196.

### T26 · Article I
`/speckit-comply`, CRITICAL findings resolved, before review. Restore `.specify/feature.json`.

---

## Dependencies

```
T01 → T02 → T03                    (P0, ships alone)
T04 → T05        [P with T06/T07]
T06 → T07 → T08 → T09 → T09a → T10 (T08 needs check()'s new fields)
T11 ‖ T12 → T13 → T14 → T15 → T16 → T17 → T17a
T18 → T19 → T20 → T21 → T22
T03 → T23/T24 → T25 → T26
T26 → T27 → T28 → T29 → T30          (P5, added after P4's measurement)
```

**Parallel-safe**: T04+T05 with T06+T07 · T11 with T12 · T14 with T15.
**Never parallel**: anything touching `db-operation.service.ts` (T06, T07) or
`DbOperationsPanel.tsx` (T13–T15, T17).

---

## Requirement coverage

Every `FR` in [spec.md](./spec.md) maps to a task, or is recorded here as already satisfied. **A blank
row is an unimplemented requirement.**

| FR | Task | Note |
| :--- | :--- | :--- |
| FR-001 · manifest table not callable | **T01** | |
| FR-002 · kind-aware ref finding | **T02** | |
| FR-003 · refuse, don't exhaust attempts | **T02**, T03 | |
| FR-004 · no surface calls a table readable | **T17** | script assertion |
| FR-005 · proposer's inputs, and nothing else | **T08** | |
| FR-006 · asserted against its own source | **T10** | |
| FR-007 · two channels | **T08** | |
| FR-008 · refusal never retried | **T08**, T10 | |
| FR-009 · findings verbatim | **T08**, T10 | |
| FR-010 · writes nothing | **T08**, T10 | SC-004 |
| FR-011 · readback leads, SQL collapsed | **T13** | |
| FR-012 · name editable before, immutable after | **T13** | |
| FR-013 · save re-verifies the submitted spec | — | ⚠ **Already satisfied, no code.** `dbOperationService.create` ([:617](../../packages/server/src/services/db-operation.service.ts#L617)) already calls `compileOperation(input.spec, …)` on the submitted spec, and `update` compiles the **merged** spec. **Do not add a second verification path** — assert the existing one in T10 instead. |
| FR-014 · bounded, stated on screen | **T09a** | |
| FR-015 · manifest version, 0 fingerprints moved | **T17a** | SC-003 |
| FR-016 · separate call, 1024 unchanged | **T19**, T22 | SC-005 |
| FR-017 · proposal turn writes no revision | **T19** | |
| FR-018 · import allowlist extended | **T20** | |
| FR-019 · declined proposal changes nothing | **T22** | |
| FR-020 · no path makes a model emit SQL | **T10** | SC-002 |
| FR-021 · nothing calls it *correct* | **T15**, T17 | |
| FR-022 · readback is pure code, from `check()` | **T04**, T07 | |
| FR-023 · the two decidable traps, in words | **T04**, T05 | SC-007 |
| FR-024 · no sample or synthetic rows | **T13**, T17 | SC-008 |
| FR-025 · states what it cannot check | **T15** | |
| FR-026 · additive; the human panel gains it | **T07**, T14 | |
| FR-027 · a missing reader is not structural | **T27**, T28 | ⚠ **P5.** Added because P4 measured US3 as not firing — the op call refuses before the detection runs. D-202. |
| FR-028 · `too_structural` still works | **T28**, T29 | ⚠ **The control.** Without it FR-027 is indistinguishable from deleting the channel. |

---

## The four assertions that must never be quietly dropped

If a task is cut under time pressure, these are the ones whose absence is invisible:

| # | Assertion | Task | Why its absence hides |
| :-- | :--- | :--- | :--- |
| 1 | `inner` and `left` render **different** notes | T05 | A readback that collapses them still *looks* like a readback |
| 2 | The proposer's **source** carries no DSN or row fetch | T10 | Behaviour passes with the field present and unused |
| 3 | Nothing is written by a propose call | T10 | A stray write only surfaces as a mystery ref weeks later |
| 4 | `CHAT_TURN_MAX_TOKENS` is still 1024 | T22 | Raising it weakens a structural control with no test failing |
| 5 | `too_structural` still refuses a genuine redesign | T28, T29 | ⚠ **P5's own risk.** A rule widened to "add_step whenever anything is missing" makes SC-009 pass and deletes the channel — and the prompt test stays green either way |

---

## P5 — the op call reaches P3's machinery · US3 · one prompt rule

⚠ **This phase exists because P4 measured P3 as not working.** It is not an extension; it is the
finding. Read **plan.md Decision 34 (D-202)** before touching anything — it states the mechanism, why
Option A was chosen, and the two options rejected.

⚠ **Re-point `.specify/feature.json` at this directory first** (it was restored to
`specs/20260818-123807-tool-probe` by T26), or every source write is refused — Constitution Article I.

⚠ **NO schema change, no new status, no new branch, no client change.** If any of those turns out to be
needed, **STOP and raise it**: that is Option B, and it is a different decision.

⚠ **This invalidates `chat:measure` for the fourth time.** Both scenarios must be re-taken in T30.

### T27 · US3 · `flow-chat.service.ts` + `flow-generation.service.ts` — DONE

⚠ **Three changes, not one. The extra two were found by reading the code before writing the rule,
and the phase would have failed without either.**

**T27a — `operations` was missing from chat's catalogue (D-204).** The drafter passes
`{tools, queries, operations}`; the chat turn passed `{tools, queries}`, and `operations` is
**optional** on `resolveSelection` so nothing errored. **Every saved DB operation was invisible to
every chat turn.** Pre-existing, unrelated to P5's cause, and it would have broken US3 scenario 2 after
a proposal was approved — the offer would work and the retry would not.

**T27b — the `DATASOURCES WITH NO READER YET` section (D-203).** A chat turn's prompt carries **no
manifest**, so a reader-less datasource appears nowhere and the op call cannot name it. A rule alone
could not have worked. `readerlessDatasources()` lives in `flow-generation.service.ts` beside
`refFindings`, using **byte-for-byte the same condition**; the allowlist grew **6 → 8**.
⚠ `countEntities()` was extracted so the table count has **one** implementation — the first draft of
`readerlessDatasources` had a second one that dropped the schema qualifier and depended on
entity-level rows existing. Caught by verifying its own comment.

**T27c — the rule itself**, beside the 2026-08-21 sentences, not instead of them.
⚠ **The first wording failed, measured:** *"answer `add_step`"* produced
`{"status":"add_step","op":{"op":"add_step",…}}` — because every other rule in this prompt says
*"answer `too_structural`"* and **those are status values**. And `<datasource>.<the reader you need>`
came back as the literal ref `hr_demo.<reader for approved leave requests by period>`. The rule now
carries the JSON verbatim and forbids angle brackets.

#### The original instruction, kept for the record

### T27-original · US3 · `packages/server/src/services/flow-chat.service.ts`

Add the reader case to **`CHAT_RULES`**, immediately after the three sentences that already handle a
missing step ([:235](../../packages/server/src/services/flow-chat.service.ts#L235)):

```
"too_structural" is NOT for a component the automation does not have yet.
If the message asks for something that is not there — send an email, write a
report, call a tool, read a query — ADD it with "add_step". That is a
one-component change and "add_step" is exactly the op for it. A step being
absent is the reason to add it, never a reason to refuse.
```

⚠ **DO NOT REWRITE THOSE FIVE LINES.** They were added 2026-08-21 for a measured failure, and a shorter
combined version restates the general rule instead of the specific one — which **is** the defect they
were written to fix. Add beside them, in the same register.

The new rule must say, in the prompt's own voice:
* A datasource whose tables you can see but which has **no query and no operation in CALLABLE STEPS**
  is a **missing component**, not a shape change.
* The op is still `add_step`, and its ref **names that datasource** (`<datasource>.<what you need>`),
  because a person is present and will be offered the missing component.
* ⚠ **The boundary, stated so the next reader does not "fix" it**: `DRAFT_RULES` tells the *drafter*
  the opposite — a manifest table is not callable, so refuse. Both are right. **A headless draft has
  nobody to ask; a chat turn does.** D-202 records this.

### T28 · US3 · `flow-chat.test.ts` + `flow-generation.test.ts` — DONE

`flow-chat.test.ts` **23 → 32**, `flow-generation.test.ts` **86 → 93**. The existing
`describe("an absent step is something to ADD…")` was **extended, not duplicated**, and its
`too_structural` control kept.

⚠ **The load-bearing test is in `flow-generation.test.ts`**: `readerlessDatasources` and `refFindings`
**agree datasource for datasource** — the prompt tells the model about exactly the datasources whose
refs the detection files as a gap. Two definitions of "reader-less" would break US3 in one of two
silent ways, and nothing else notices.

⚠ **The order assertion hit the fourth-time trap.** `indexOf("DATASOURCES WITH NO READER YET")` found
**the rule's own mention** inside `CHAT_RULES` (at 3339) rather than the section (3669) — the assertion
failed while the code was correct. Re-anchored on a sentence only the block has, with a control that
`CHAT_RULES` does not contain it. Same shape as the readback purity test (P1a),
`ui-honesty-check.sh`'s 13c (P2) and `OperationReview.tsx`'s docblock (P3): **when a rule and the thing
it describes share a name, anchor on the thing.**

#### The original instruction, kept for the record

### T28-original · US3 · `packages/server/src/services/flow-chat.test.ts`

Extend the existing `describe("an absent step is something to ADD, not a reason to refuse")`
([:287](../../packages/server/src/services/flow-chat.test.ts#L287)) — **do not add a second block**;
one place asserts this rule or the two drift.

1. The **missing-step** sentences are still present (the three existing assertions, untouched).
2. The **missing-reader** sentence is present.
3. ⚠ **FR-028's control, and it is the load-bearing one**: `too_structural` still names its real
   subject — *"reorder everything, split it in two, start again"*. Already asserted; **make sure T27
   did not weaken it.**
4. ⚠ **A control that the test can fail**: assert the new sentence's absence is detectable, in the
   manner `flow-expression-rules.test.ts` proves its scan can find anything. A prompt assertion that
   passes against any string is the shape this repo refuses.

**Perturbation to run and record**: delete the new sentence → T28 red. Delete one of the three old
sentences → T28 red. Widen the new rule to *"answer add_step whenever anything is missing"* → **T28
still green and FR-028's control still green**, which is the case T30's measurement has to catch, not
this test.

### T29 · US3 · `packages/server/src/scenarios/chat-measure.ts` — DONE

FR-028's control probe added **last** in `SCENARIO_2`, so it arrives against a flow with steps and is a
genuine restructure request rather than a redesign of an empty flow. It held `too_structural` **3 of
3**. ⚠ Without it, a rule widened one notch — *"add_step whenever anything is missing"* — would satisfy
SC-009 **and** have deleted the channel, with T28 green either way.

#### The original instruction, kept for the record

### T29-original · US3 · `packages/server/src/scenarios/chat-measure.ts`

`SCENARIO_2` gains **FR-028's control probe** — a genuinely structural message that must still come
back `too_structural`.

⚠ **In the same scenario as the `needs_component` probe**, so one run reports both. A rule that turned
*every* refusal into an `add_step` would satisfy SC-009 and have silently deleted the channel; the two
probes in one run are the only place that shows.

⚠ **Order matters and is already load-bearing** — `SCENARIO_2`'s probes run in sequence on one thread,
so the flow each probe sees is what the previous left. The `needs_component` probe must stay **first**,
on an empty flow. Put the control probe last.

⚠ The `expectStatus` note is **per-status** ([the fix P4's perturbation forced](./session-notes.md)) —
a probe declaring `too_structural` must not print *"a SUCCESS: a real gap, named"*. Check it still
reads correctly for the control probe.

### T30 · SC-009 — DONE. `needs_component` 3 of 3, control 3 of 3

**Model: `gpt-5.4-mini`. `pnpm chat:measure --scenario=2`, three runs.**

| | Before P5 | After |
| :--- | :--- | :--- |
| `needs_component` reached | **0 of 4** | **3 of 3** |
| FR-028 control still `too_structural` | — | **3 of 3** |
| Revision written on the gap turn | — | **none** — 0 Kestra round trips, 0 steps |

The finding the turn carries is the actionable one: *"step … references `hr_demo.read_approved_leave_requests`
— `hr_demo` IS a datasource in this workspace, with 7 introspected tables…"*

**Scenario 1 re-taken** (`CHAT_RULES` changed, so P4's reading was stale the moment T27 landed):
**5 turns · applied 4 · refused 1 · failed 0 · steps reached 4 of 5**, against P4's
*applied 2 · refused 2 · failed 1 · 2 of 5*. ⚠ **Do not attribute that to P5.** P4's turn 1 failed on a
nested `{{ }}` (I-11) and cascaded; this run's turn 1 succeeded. Run-to-run variance on this scenario is
large and the improvement is most likely chance.

⚠ **Probe 2's declared expectation was REMOVED, and that is a finding.** Before P5 the natural
multi-sentence phrasing reliably answered `too_structural` — the documented dead end. After P5 it comes
back `applied` three times in four and `needs_component` once. **Both are correct answers to an
ambiguous request** and neither is a dead end, so declaring either would make the harness red for a turn
that did nothing wrong. It stays a probe because the *sequence* matters: it leaves a step behind, which
is what makes the FR-028 control a genuine restructure request rather than a redesign of an empty flow.

#### The original instruction, kept for the record

### T30-original · SC-009 — measure it, ≥3 runs, and record the model

`pnpm chat:measure --scenario=2`, **three runs minimum**.

⚠ **Three, not one, and this is not caution.** The op call was already observed answering **two
different ways to one identical message** — `too_structural` on one run, `applied` on the next. A
one-run pass here is not evidence.

Record, beside the model name:
* `needs_component` reached — **n of 3**. ⚠ The **before** half already exists: **0 of 4** on
  `gpt-5.4-mini`.
* FR-028's control still `too_structural` — **n of 3**.
* That **no revision was written** on the `needs_component` turns (FR-017).

⚠ **Also re-take `chat:measure` scenario 1** — this edits `CHAT_RULES`, which every turn in every
workspace is given, so P4's *"5 turns · applied 2"* reading is stale the moment T27 lands.

⚠ **If `needs_component` is reached 0 or 1 of 3, STOP. Do not reword the prompt a second time.** D-202
says so explicitly: that outcome is the evidence that **Option B** (a fourth status on
`chatTurnResponseSchema`) is the answer, and it is a different decision to take with the user.

**Exit**: SC-009 measured with its control, both numbers and the model recorded in
[session-notes.md](./session-notes.md); `CLAUDE.md`'s feature section corrected — it currently states
*"Chat's `needs_component` does not fire"* as present-tense fact.


---

## Phase 6 — the date a month cannot have (added 2026-08-28, after the feature closed)

⚠ **Why this is in THIS feature and not a new one.** Execution `7cwL1ris` failed with
`date/time field value out of range: "2026-06-31"` on the first real use of P5's machinery. Before
**D-204** nothing could reference a DB operation, so no step in any workspace had ever had a `type: date`
parameter to bind — **this feature handed the drafter the problem.** See **D-205**.

### T31 — export `EXPRESSION_FIELDS` — DONE

`flow-expression.service.ts` held the six expression-field names as an inline literal inside
`validateModelExpressions`, under a docblock warning that a field missing from the list *"is not checked
at all — the omission is silent."* T32 needs the same list. **One definition, exported** (D-197); the
warning moved onto the constant, where it belongs.

**Done**: `EXPRESSION_FIELDS` exported and on `flowExpressionService`; the loop reads it.

### T32 — `checkConstructedDates` — DONE

New module `flow-date-params.ts`. Pure, `(steps) => string[]`, over `EXPRESSION_FIELDS`. Three patterns:

| Pattern | Example | Verdict |
| :--- | :--- | :--- |
| Fully literal date | `2026-06-31` | flagged — leap-year aware, so `2024-02-29` passes and `2026-02-29` does not |
| Day pasted on a template | `{{ inputs.period }}-31` | flagged when the day is **29, 30 or 31** |
| Month **and** day pasted | `{{ inputs.year }}-02-30` | flagged — decidable outright; `-12-31` passes |

⚠ **`-01` … `-28` are NOT flagged**, and that is the load-bearing half. Every month has 28 days, so the
expression is correct — the real failing step's own `period_start` was `"{{ inputs.period }}-01"` and
right. A control that fires on correct code gets switched off (I-38 from the other end).

The finding names **both** remedies (declare the input AS a date; compute the range in a `code` step) and
says **why** the expression cannot be fixed in place — `ALLOWED_CALLS` is `{json, jq, first, length}`, so
there is no date function to reach for. A finding naming one remedy moves the model to it.

**Done**: 16 tests in `flow-date-params.test.ts`, every positive assertion paired with a negative twin.

### T33 — register it, and teach it — DONE

* **`SHAPE_CHECKS`**, not `EXPRESSION_CHECKS` — `checkBulkToolInput`'s reason: **refine and chat must run
  it too**. An impossible date is easier to introduce by editing one step than by drafting a flow, and
  I-119 is the record of three checks enforced on a generated model and not on an edited one.
* **`EXPRESSION_RULES`** gains the rule — one definition, spliced into `DRAFT_RULES`, the refine prompt
  and the chat prompt. The consequence is attached and the incident named, because the lesson 20 lines
  above it in that file is that a rule the model can read past needs the failure written next to it.

**Done**: registry roster updated (the guard made it a deliberate edit, as designed); fixture added —
`period_start` deliberately omitted from it so the fixture trips exactly one check.

### T34 — perturb — DONE

| # | Perturbation | Result |
| :--- | :--- | :--- |
| 1 | Unregister `checkConstructedDates` | 🔴 4 tests, incl. the registry guard and the fixture guard |
| 2 | `ALWAYS_VALID_DAY` 28 → 31 (permissive) | 🔴 8 tests |
| 3 | `ALWAYS_VALID_DAY` 28 → 0 (over-eager) | 🔴 2, incl. *"leaves `-01` alone"* |
| 4 | Leap-blind — `day <= 29` always | 🔴 the leap-year test, by name |
| 5 | Weaken the prompt rule's wording | 🔴 `EXPRESSION_RULES` |

All five restored and verified with `diff -q`.

**Exit**: SC-010 met. ⚠ **`chat:measure`, `draft:measure` and `outline:measure` are STALE again** — this
moved the prompt text on every path. Marked stale, not quoted; the re-take is owed before any number
from them is used.
