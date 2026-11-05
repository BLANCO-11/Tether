# Session notes — implementation log

**Purpose.** This file is the handover. If a session dies mid-feature, a fresh session (or a
different account) reads *this file only* and can resume without re-deriving anything. Append to
it at the end of every phase, before asking for confirmation to continue.

**Read these first, in this order**: [spec.md](./spec.md) → [plan.md](./plan.md) §Required code and
file changes → [tasks.md](./tasks.md) → this file's *Current position*.

---

## Current position

| | |
| :--- | :--- |
| **Phase** | **P5 — the op call reaches P3's machinery. ✅ COMPLETE. THE FEATURE IS DONE.** |
| **Status** | **T01…T30 all done. `needs_component` 3 of 3, was 0 of 4.** 7/7 typechecks · server **1778 passed / 23 skipped** (1804) · client **908** · `ui-honesty-check.sh` **206 PASS / 0 FAIL**. **3 failures, none ours**: `trigger-gate.test.ts` and `flow-replay.test.ts` (deterministic, pre-existing) and `datasource-target.test.ts` (**flaky** — live-DB timeouts, 2 then 1 with identical code). **Do not fix any of them here.** |
| **Last completed task** | T30 |
| **Next task** | — none. T01…T30 all done. |
| **Awaiting the user** | **The branch** — this shipped on **someone else's** branch (Article VI) and nothing is committed. Also still open, NOT addressed by P5: **SC-001 shows no measurable difference** from T01's rule on this model (gemma was down). |
| **⚠ P5 was the user's call, and it overrides mine** | I recorded D-201 as *"a separate feature"*; the user decided **Option A, in this feature**. **D-202** supersedes that half of D-201; D-201's *reasoning* is still the constraint P5 works under. |
| **⚠ `.specify/feature.json` points HERE again** | Re-pointed for T27. **Restore it to `specs/20260818-123807-tool-probe`** at close — backup at `<scratchpad>/feature.json.bak`. |

✅ **RESOLVED 2026-08-27, and nothing was installed.** Node **22.23.2 was already on this machine** at
`~/.local/share/node-versions/v22.23.2` — put there in an earlier session, checksum-verified against
nodejs.org's `SHASUMS256.txt` (CLAUDE.md records it). It had simply **never been put on `PATH`**, so
`node -v` reported the system's v20.20.2 and the client suite refused to run.

**Fix**: symlinks in `~/.local/bin` (already first on `PATH`) → `node`, `npm`, `npx`, `corepack`.

```bash
V=~/.local/share/node-versions/v22.23.2
for b in node npm npx corepack; do ln -sfn "$V/bin/$b" ~/.local/bin/"$b"; done
# to revert:  rm ~/.local/bin/{node,npm,npx,corepack}
```

⚠ **`/usr/bin/node` is untouched and still v20.20.2** — the system default is unchanged, matching the
posture CLAUDE.md records. `.nvmrc` and `.node-version` both already said `22`, so the requirement was
written down in **four** places (two `engines`, two pin files) and the host honoured none of them. That
is the argument for `vitest.config.ts`'s throw, which is the only one of the five that is a control.

⚠ **`pnpm` looked like it downgraded and did not.** `pnpm -v` reports **10.22.0** outside the repo and
**10.29.2** inside it: `/usr/local/bin/pnpm` is 10.22.0, and pnpm 10 self-manages to the
`packageManager: pnpm@10.29.2` pin when run in the project. Identical under both Node versions —
verified by invoking the same script with each binary. Not a regression.

**Both directions verified**:

| | |
| :--- | :--- |
| Node 20 · client suite | **refuses at config load**, with `vitest.config.ts`'s own message naming the version, the jsdom/undici cause and the 21 files at stake |
| Node 22 · client suite | **60 files / 862 tests, all passing** — the render layer runs for the first time in this session |

---

## Pre-flight state, verified 2026-08-27

Facts established by reading the repo, not assumed. A resuming session can trust these without
re-checking, **except** where a line says to re-check.

### Repo and branch

| | |
| :--- | :--- |
| Repo root | `/home/mayank/Foundary_kestra_migration/foundry` (a git repo; the parent dir is not) |
| Branch | `20260819-080932-legal-contract-demo-domain` — **someone else's feature** |
| Working tree | **dirty before this feature started**: 122 staged `A`, 50 staged `M`, 3 untracked. None of it is ours. |
| HEAD | `82cba6e tool probing added and errors fixes` |

⚠ **Do not commit, stash, reset or branch.** The pre-existing 122 staged files are not this
feature's and would be swept into any commit. Branch creation is the user's call — raised with
them, not decided here. `ci/check-spec-compliance.sh` resolves the feature **from the diff, not
the branch name** (see its comment at :59), and the current branch already matches
`FEATURE_BRANCH_REGEX`, so the branch name is not what blocks us.

### The spec gate — how it actually resolves

`.claude/settings.json` wires `PreToolUse` on `Edit|Write|NotebookEdit|Bash` to
`.claude/hooks/spec-gate.sh`, which delegates to `scripts/spec-gate-core.sh`. Resolution order for
the active feature (mirrors spec-kit's own):

1. `SPECIFY_FEATURE_DIRECTORY` env
2. `SPECIFY_FEATURE` env
3. `.specify/feature.json`
4. current branch name matching `specs/<branch>`

**Done in this session**: `.specify/feature.json` repointed from `specs/20260818-123807-tool-probe`
to `specs/20260827-053157-proposed-db-operations`. Backup of the old file:
`<scratchpad>/feature.json.bak`. Restore it when the feature is finished, or the next feature
inherits our pointer.

The gate needs `spec.md` **and** `plan.md` **and** `tasks.md` present in the feature dir — all
three exist. A second, independent gate checks the *content* being written for hardcoded secrets
(`ci/check-secrets.sh`) and fires even inside a valid feature.

`is_always_editable` (`ci/spec-policy.sh:26`) exempts: `specs/*`, `.specify/*`, `docs/*`,
`.claude/skills/*`, `.agents/skills/*`, `.cursor/skills/*`, `.gemini/commands/*`, `.gitignore`,
`LICENSE*`, **and any `*.md`**.

⚠ Never set `SPECKIT_ENFORCE=0`, never create `.speckit-template-dev`, never
`git commit --no-verify`. Constitution Article I is NON-NEGOTIABLE.

### Source facts P0 depends on

| Fact | Where | Why it matters |
| :--- | :--- | :--- |
| `DRAFT_RULES` is a `string[]` joined with `\n` | [flow-generation.service.ts:214](../../packages/server/src/services/flow-generation.service.ts#L214) | T01 inserts array elements, not a text block. |
| The anchor line — *"Reference only the tools, named queries and DB operations…"* | same file **:329** | T01 inserts **directly after** this. The `RULES` block opens at :319. |
| `unknownRefs()` opens with a **bare** `await manifestBuilderService.refInterfaces(workspaceId)` | same file **:1122** | T02 wraps it in one `Promise.all`. There is no existing `Promise.all` to join, despite an earlier draft of the plan saying so. |
| `datasourceRepo` already imported | same file **:7**; `listByWorkspace` already used at **:1220** | T02 adds no import. |
| `datasourceRepo.listByWorkspace(workspaceId)` → `Datasource[]`, ordered by `createdAt desc` | [datasource.repo.ts:9](../../packages/server/src/repositories/datasource.repo.ts#L9) | |
| Refs are keyed `` `${datasource.name}.${query.name}` `` and `` `${datasource.name}.${operation.name}` `` | [manifest-builder.service.ts:569,588](../../packages/server/src/services/manifest-builder.service.ts#L569) | Lets "has this datasource any readers?" be answered from `interfaces` alone — **no extra query**. |
| `DATASOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/` | [datasource.service.ts:28](../../packages/server/src/services/datasource.service.ts#L28) | **No dots in a datasource name** ⇒ "the prefix before the first `.`" is exact, not a heuristic. |
| `schemas` is **one row per column**; `columnName` is NULL for entity-level metadata; unique key includes `entitySchema` | [db/schema.ts:331](../../packages/server/src/db/schema.ts#L331) | "N introspected tables" = count of distinct `entitySchema`⋮`entityName`, **not** `rows.length`. |
| `schemaRepo` exposes only `listByDatasource` and `replaceForDatasource` | [schema.repo.ts:9](../../packages/server/src/repositories/schema.repo.ts#L9) | No count helper. Read lazily and memoize. |
| `flow-generation.test.ts` mocks `./manifest-builder.service.js` with **`refInterfaces` only** | [flow-generation.test.ts:54](../../packages/server/src/services/flow-generation.test.ts#L54) | ⚠ Any new repo call inside `unknownRefs` **must** be added to that mock or the existing `unknownRefs` tests hit a real database. |
| Existing `unknownRefs` describe block | same file **:981–1026** | Three tests. Case 3 (*"refuses a ref that exists nowhere"*, `ghost_tool`) is the control T03 case 3 extends. |

---

## Decisions taken during implementation

Recorded here when the code forced a choice the plan did not settle. A decision here that
contradicts plan.md means **plan.md is now wrong** — say so rather than leaving both.

### D-180 (P0) · `schemaRepo` is a new import in `flow-generation.service.ts`

plan.md says P0 adds no import, and that was written about `datasourceRepo` (already imported at
:7). FR-002 says *"a real datasource holding an **introspected schema** and zero readable
components"* — the schema half is not answerable from `interfaces` or the datasource row, so
`schemaRepo` had to come in. One line, beside the other repositories, no new dependency and no
isolation rule touched (FR-018 constrains the **proposer**, not this module).

### D-181 (P0) · FR-002 emits THREE sentences, not two

FR-002 names two situations. A third is reachable and the code has to handle it, because otherwise
one of the two sentences becomes false:

| Situation | Sentence |
| :--- | :--- |
| prefix is a real datasource · schema · **no readers** | *"…IS a datasource in this workspace, with N introspected tables, but it has no readable components. A table is not callable…"* |
| prefix is a real datasource · **has readers, not this one** | *"…IS a datasource in this workspace, but it has no readable component named "invoices". Its readable components are: …"* |
| prefix is a real datasource · **nothing introspected** | *"…but nothing has been introspected from it and it has no readable components. Refresh its schema, then…"* |
| prefix matches nothing | **unchanged** — *"…which does not exist in this workspace"* |

Row 2 is not scope creep, it is what keeps row 1 honest: without it, a **mistyped reader name** on a
datasource that has readers would be told it has none. Row 3 likewise — `addDatasource` swallows a
failed schema refresh (`.catch(() => null)`), so "0 introspected tables" is a common real state and
would send the person to build an operation against a schema that is not there.

✅ **Closed 2026-08-27, before P1 started** — the user chose to fix the drift first. `spec.md` FR-002 now
states **four** situations (a fourth appeared while writing it: *has readers, but not this one* and
*nothing introspected* are separate, and the generic case is the fourth). US1 acceptance scenario 2
extended. `plan.md` carries this as **Decision 13**; `tasks.md` T02 carries the four-row table;
`workflow-diagrams.md` diagram 2 fans `unknownRefs` out four ways. **The code was not changed** — it
already did this; the documents had not caught up.

### D-182 (P0) · the table count is DISTINCT ENTITIES, not rows

`schemas` holds one row per **column**. `rows.length` would tell a person their datasource has 6
tables when it has 2 — a number they can check against their own database in one glance, from the
message written to stop misinforming them. A test pins this with a 6-row / 2-entity fixture.

### D-183 (P0) · what T03 does and does not assert

*"Does the model refuse rather than invent?"* is **not** testable here: with a stubbed client the
answer is whatever the stub says. That is the trap `flow-generation.test.ts` already names for
assertion 32, and it is why SC-001 is a **measurement**. T03 asserts the three things that ARE
properties of this code — the rule reaches the prompt, `unknownRefs` picks the right sentence, and
`draftFlow` returns a refusal after exactly one call.

---

## Phase log

*(appended at the end of each phase)*

### P0 — the honest refusal · complete (code + tests)

**Diff**: `flow-generation.service.ts` +91 · `flow-generation.test.ts` +255 · `.specify/feature.json`
repointed. Nothing else touched. **No migration.** Head is still `0041_approval_override`.

| Task | What landed |
| :--- | :--- |
| **T01** | D-176's four-line rule in `DRAFT_RULES`, inserted directly after the *"Reference only the tools…"* line (now [:330](../../packages/server/src/services/flow-generation.service.ts#L330)), with the comment block recording why the existing rule was not enough. |
| **T02** | `unknownRefs()` — one `Promise.all` (`refInterfaces` + `datasourceRepo.listByWorkspace`) resolved once before the step loop; a lazy, memoized `schemaRepo.listByDatasource` on the failure path only; three new sentences (D-181). |
| **T03** | 10 new tests in 3 describes. The pre-existing `unknownRefs` describe gained the `datasourceRepo` stub it now needs. |

**Verification actually run** (not inferred):

| Command | Result |
| :--- | :--- |
| `npx vitest run src/services/flow-generation.test.ts` | **79 passed**, 0 failed — 69 pre-existing + 10 new |
| `npx tsc --noEmit` (packages/server) | **clean, exit 0** |
| `npx vitest run` (whole server package) | **1682 passed, 23 skipped, 2 failed** |

⚠ **The 2 failures are pre-existing and not ours.** `src/services/trigger-gate.test.ts` and
`src/services/flow-replay.test.ts` are live-database integration tests (`import { db, pool }`,
`beforeAll` seeding). Neither imports `flow-generation.service.ts` — directly or transitively via
`trigger.service.ts`, `flow-replay.service.ts` or `retention.ts`, all checked. `trigger-gate.test.ts`
is staged-modified by the in-progress `legal-contract-demo-domain` work. **Do not "fix" them under
this feature.**

### Open at the end of P0

**SC-001 is not measured.** T03's exit line asks for it *"before and after on the same goal, both
numbers recorded"*, and three facts about it were established rather than assumed:

1. `kestra:refusal` is **not** the right harness — it measures the FRAGMENT channel
   (`insufficient_contract`), not the draft's `insufficient_catalogue`.
2. `draft:measure` ([src/scenarios/draft-measure.ts:38](../../packages/server/src/scenarios/draft-measure.ts#L38))
   **does** call `draftFlow` in-process against live inference, so it would exercise this change —
   but it has no reader-less-datasource case, and adding one edits a source file P0's plan does not list.
3. **The fixture already exists.** Live DB, verified: `hr_demo` (workspace *HR*) has **7 introspected
   tables, 0 named queries, 0 DB operations**; `hr_demo_alt` likewise. So the measurement is runnable
   without provisioning — but the goal has to be chosen so no TOOL covers it, or the correct answer
   is *not* a refusal and the number means nothing (that is T03 case 4, the control).

⚠ The **"before"** number is now obtainable only by temporarily reverting T01's insertion. That is
safe and reversible, but it is a deliberate act and costs a second live run.

**✅ DECIDED 2026-08-27 — deferred to T24.** Recorded in plan.md Decision 15 and in tasks.md's Exit P0
line, so it is a decision on the record rather than a gap. T24 re-takes `kestra:refusal` ·
`outline:measure` · `draft:measure` · `chat:measure` anyway, because T01 invalidated all four.

⚠ **Until T24 lands, no number from any of those four may be quoted for this path.** A resuming session
that finds one quoted somewhere should treat it as stale, not as evidence.

⚠ T24 will need a **new case in `draft:measure`** (a reader-less datasource — `hr_demo` is the fixture,
with a goal no TOOL covers) and, for the *before* half, a **temporary revert of T01's insertion**.

### P0 artefact reconciliation — done in the same session

| File | Change |
| :--- | :--- |
| `spec.md` | FR-002 widened to four situations, with the two "why" warnings and the distinct-entities rule. US1 acceptance scenario 2 extended. |
| `plan.md` | Reserves → **D-169…D-183**. New `## Decisions taken during implementation` with **Decisions 12–15**. Phase 0's *"no new import"* line corrected to name `schemaRepo`. |
| `tasks.md` | T02 rewritten with the four-row sentence table; T03 rewritten as the 10 tests actually written, with the mock warning; Exit P0 records the T24 deferral. |
| `workflow-diagrams.md` | Diagram 2's `unknownRefs` node fans out four ways, with `S1`–`S4` and a feed-back node. **All 8 mermaid blocks re-validated** (mermaid 11 + jsdom, 8 ok / 0 bad). |

⚠ **D-numbering checked, not assumed.** Highest D in use outside this feature is **D-168** (the D-176
hits a grep finds are P0's own new code comments). D-169…D-183 are free.

### P1a — the readback · complete (T04–T07)

**Diff**: `db-operation-readback.ts` **NEW** · `db-operation-readback.test.ts` **NEW** ·
`db-operation.service.ts` edited. **No migration. No new dependency.**

| Task | What landed |
| :--- | :--- |
| **T04** | `readback(spec): ReadbackClause[]` — pure, and a **true leaf**: its only import is `import type`, erased at compile time, so it has **zero runtime dependencies**. Owns `FILTER_PHRASE`, `JOIN_NOTE`, `SORT_PHRASE`, `AGGREGATE_PHRASE`, each a `Record<Union, …>` so a new enum member fails to compile. |
| **T05** | 24 tests: exhaustive over `FILTER_OPS` × `JOIN_KINDS` × `SORT_DIRS` × `AGGREGATES`, both collapse controls, the compiler-agreement block, FR-011's provenance, and the source-read purity control. |
| **T06** | `CompiledOperation.outputColumns`. `columnType` threaded into `selected` from the `resolveColumn` call that was already there — **no second resolution pass**, so a column in `outputColumns` is in the SQL by construction. |
| **T07** | `check()` returns `readback` + `outputColumns` beside `compiledSql`. `ok: false` branch **untouched**. |

**Verification actually run:**

| Command | Result |
| :--- | :--- |
| `vitest run src/services/db-operation-readback.test.ts` | **24 passed** |
| `vitest run src/services/db-operation.test.ts` | **20 passed** — the pre-existing suite, unbroken by `outputColumns` |
| `vitest run` (whole server package) | **1706 passed** (was 1682), 23 skipped, **the same 2 pre-existing failures** |
| `pnpm -r typecheck` | **all 7 packages clean** |

⚠ **Both collapse controls were PROVEN, not assumed.** The module was deliberately broken twice and
the suite re-run each time, then restored and `diff`-confirmed byte-identical:

| Deliberate break | Result |
| :--- | :--- |
| `left`'s note made identical to `inner`'s | **1 failed** — *"renders a note for every join kind, and the two notes DIFFER"* |
| `lte`'s phrase made identical to `lt`'s | **2 failed** — the eight-operator distinctness test **and** FR-023's named-pair test |
| restored | **24 passed**, file byte-identical to the original |

A collapse control that has never been observed to fail is I-38. These have been.

### Decisions taken during P1a — **full arguments in [plan.md](./plan.md) Decisions 16–20**

Kept as pointers, not copies. plan.md is the decision register; a decision whose argument lives only in
a session log is the drift this feature keeps flagging.

| # | | Contradicts |
| :--- | :--- | :--- |
| **D-184** | The spec enums are **exported** so a test can enumerate them; the readback still imports **nothing at runtime** (`import type` only, erased at compile time). ⚠ There is a type-level import cycle — do not "fix" it by copying the enums. | — |
| **D-185** | `outputColumns.type` is the **source column's** type; `source` names the aggregate (`count(invoices.id)`). ⚠ **T14 must not render it as the output's type.** | — |
| **D-186** | The readback emits a clause for what the spec does **not** say — no filter, no order, no limit. A label may therefore **repeat**. | the contract's readback sample, now corrected to the real output |
| **D-187** | The row-count note restates `compileOperation`'s GROUP BY rule — **two implementations of one rule**, permitted only because a test checks the claim against the SQL actually emitted. ⚠ Delete that test and the module's comment becomes a lie. | this repo's default refusal of duplicated rules |
| **D-188** | Every source-reading test scans **code only**. Both first versions failed on their own modules' comments and were **satisfiable by deleting the explanation**. | — |

### P1b — the proposer · complete (T08, T09, T09a, T10)

**Diff**: `db-operation-proposal.service.ts` **NEW** · `db-operation-proposal.service.test.ts` **NEW** ·
`routes/datasources.ts` edited. **No migration. No new dependency.**

| Task | What landed |
| :--- | :--- |
| **T08** | `proposeOperation({workspaceId, dsId, need})`. Two channels; refusal returns after one call; `check()` findings fed back verbatim; prompt with the enum lines rendered **from** the exported arrays and the NEED **last**; schema wrapped in the provenance envelope. |
| **T09** | `POST /:dsId/operations/propose`, declared immediately after `/operations/check`. 404 in the route via `datasourceService.get`; 409/502/422 from the service through the error middleware. |
| **T09a** | `MAX_PROPOSALS_PER_REQUEST` exported **and returned as `maxPerRequest` on both channels** — see D-189 for why it cannot be enforced server-side. |
| **T10** | **27 tests**, including four the plan did not ask for: the 409-spends-zero-calls control, the prefix-stability check, the enum-rendering check, and a **control for T09's route-ordering hazard** (which was a comment with nothing behind it). |

**Verification actually run:**

| Command | Result |
| :--- | :--- |
| `vitest run src/services/db-operation-proposal.service.test.ts` | **27 passed** |
| `vitest run` (whole server package) | **1729 passed** (P0: 1682 → P1a: 1706 → P1b: 1729), 23 skipped, **the same 2 pre-existing failures** |
| `npx tsc --noEmit` (server) | **clean** |
| the shadowing regex, checked against a synthetic POST and a synthetic GET | matches the POST, not the GET — the control is not vacuous |

### Decisions taken during P1b — **full arguments in [plan.md](./plan.md) Decisions 21–25**

| # | | Contradicts |
| :--- | :--- | :--- |
| **D-189** | FR-014's bound travels as `maxPerRequest` on **both** channels and is enforced by the **surfaces**. It cannot be enforced server-side: the server holds no proposal state, because D-170 and D-179 forbid it. ⚠ The client must not hardcode `3`; **T13 still has to decide** how the bound is stated before the first proposal. | settles what T09a left open |
| **D-190** | The **404 lives in the route**, so the proposer never imports `datasourceRepo` — `.get` returns the row *including* `connectionString`, which would leave FR-006 asserting only that the field is currently unused. The **409 stays in the service**, which is what reads the schema. | — |
| **D-191** | The proposer imports the **provenance envelope** — a sixth module beyond T08's *"and nothing else"*. Column names are tenant-authored text reaching a prompt; FR-018's real property is the absence of `flow-generation.service`, which T10 asserts directly. | **tasks.md T08's import list** |
| **D-192** | Exhausting the attempts is a **422 failure**, not the refusal channel, and carries the findings. ⚠ No Retry button on either. | the contract's error table, which had no row for it — now added |
| **D-193** | SC-002 is asserted on SQL **clauses** plus an exact count of `SELECT`, not on the word. The first version failed on the prompt's own *"compiled to a read-only SELECT by code"* disclaimer and was **satisfiable by deleting it**. | — |

### Artefacts updated in the same session

| File | Change |
| :--- | :--- |
| `plan.md` | Reserves → **D-169…D-193**. **Decisions 16–25** added (P1a's five, P1b's five). |
| `contracts/operation-proposal.md` | `maxPerRequest` on both channels · a **422** row · the readback sample replaced with the **actual output** of `readback()` · invariants **11–16** added. |
| `tasks.md` | T09a records that the bound travels in the response and names what T13 must still decide. |
| `session-notes.md` | P1a's decision bodies replaced by pointers into plan.md — one home for each argument. |

### ⚠ Open at the end of P1

1. **P2 is blocked on Node 22.** Still `v20.20.2`; `packages/client/vitest.config.ts:52` throws at
   config load below 22. Nothing in P0/P1 is affected.
2. **SC-001's measurement** is deferred to T24 by decision (plan Decision 15).
3. **T13 owes a decision** on stating `maxPerRequest` before the first proposal (D-189).
4. **The 2 pre-existing test failures** (`trigger-gate.test.ts`, `flow-replay.test.ts`) are live-DB
   integration tests belonging to the in-progress `legal-contract-demo-domain` work. **Not ours; do not
   "fix" them under this feature.**
5. ⚠ **Nothing has been committed or branched.** The working tree still carries the 122 staged
   additions and 50 staged modifications that were there before this feature started.

---

## Baseline under Node 22 — taken 2026-08-27, after P1 closed

This is the number P2 is measured against. Taken with `pnpm -r test`, `pnpm -r typecheck` and
`scripts/ui-honesty-check.sh`.

| Package | Files | Tests |
| :--- | --: | :--- |
| `packages/server` | 108 | **1732 passed** · 23 skipped · **3 failed** (see below) |
| `packages/client` | 60 | **862 passed** |
| `packages/shared` | 8 | 106 passed |
| `packages/flow-edit` | 3 | 88 passed |
| `packages/ops-api` | 4 | 20 passed |
| `packages/mcp-bridge` | 2 | 9 passed |
| `packages/redact` | 1 | 7 passed |

`pnpm -r typecheck` — **all 7 packages clean.**
`scripts/ui-honesty-check.sh` — **203 PASS / 0 FAIL**, exit 0.

⚠ The server's 23 skips are `swap-rehearsal.test.ts`, whose guard prints its own fix
(`pnpm demo:seed-alt`). Deliberate and loud, not the old dead-layer problem.

### ⚠ CORRECTION — there are THREE pre-existing failures, not two

P0's and P1's logs in this file say *"the same 2 pre-existing failures"*. That was **incomplete**, and
it was luck rather than a property:

| File | Why it fails | Ours? |
| :--- | :--- | :--- |
| `src/services/trigger-gate.test.ts` | live-DB integration; assertion failure. Staged-modified by the in-progress `legal-contract-demo-domain` work. | no |
| `src/services/flow-replay.test.ts` | live-DB integration; assertion failure. | no |
| `src/services/datasource-target.test.ts` | **TIMING-FLAKY.** 2 tests exceed the 5 s timeout; both are the gaps-1.3 sweep, which dials every stored datasource for real. Not assertion failures — timeouts. | no |

⚠ **`datasource-target.test.ts` is NOT a Node 22 regression**, and it looked like one. Measured
directly, same file, same vitest, two runs each: **Node 20 failed 2 of 2; Node 22 failed 1 of 2.** So it
is flaky under both, and the earlier two-failure baseline simply caught a lucky run. Recorded because
the obvious reading — *"the Node upgrade broke a test"* — is wrong and would have sent the next person
into the egress classifier.

**Do not "fix" any of the three under this feature.** None imports anything this feature touches.

---

### P2 — the approval surface · complete (T11–T17, T17a)

| Task | File | What landed |
| :--- | :--- | :--- |
| T11 | `packages/client/src/lib/foundry-client.ts` | `FAReadbackClause`, `FAOutputColumn`, `FAOperationProposal`, `FAOperationProposalRefusal`, `FAOperationProposalResult`; `readback`/`outputColumns` added to `FADbOperationCheck`'s **`ok: true` branch only**; `proposeOperation(wsId, dsId, need)` |
| T12 | `packages/client/src/lib/api.ts` | `proposeOperation(datasourceId, need)` beside `checkOperation` |
| T13 | `.../components/data/DbOperationsPanel.tsx` | `ProposalFlow` — need box → review dialog in FR-011's order → approve/discard. Refusal, 409, 422 branches, **no Retry on any of them** |
| T14 | same file | `Readback` + `OutputColumns` + `CollapsedSql` render for the **hand-built** spec too, from the `check()` response the panel already fetched |
| T15 | same file | `REVIEW_CAVEAT` exported, rendered beside **both** approve actions |
| T16 | `.../app/(app)/flows/new/page.tsx` | `MissingDatasources` — links to the source's page when `missing[]` names one |
| T17 | `scripts/ui-honesty-check.sh` + **NEW** `DbOperationsPanel.test.tsx` | 3 script assertions (13a/13b/13c) + **32 render tests** |
| T17a | `manifest-fingerprint.test.ts` + **NEW** `src/scenarios/fingerprint-measure.ts` | 6 fingerprint tests with 2 controls; a read-only deployment-wide measurement |

**Decisions taken during P2 — full arguments in [plan.md](./plan.md) Decisions 26–28**

| # | Decision | The thing it settles |
| :-- | :--- | :--- |
| **D-194** | `maxPerRequest` is held from the **first response**; the catalogue's `caps` was rejected | T09a left this open. `caps` is `typeof FLOW_CAPS` — the *validator's* cap set — and this panel never reads the catalogue |
| **D-195** | T16 **links** to the datasource page; it does not embed a second proposer | Two review surfaces for one artefact is FR-026's argument from the other side |
| **D-196** | SC-003 is measured with a synthetic **key**, not a created row | A measurement must not damage the thing it measures when it fails |

#### ⚠ Three things in P2 were not what the task assumed

1. **T16's obvious implementation was wrong.** Matching `missing[]` against
   `catalogue.entries[].datasource` finds **nothing** in exactly the case T01 added the refusal for — a
   datasource with no readable components contributes **zero** catalogue entries by construction. It
   reads `listConnections()` instead.
2. **`ui-honesty-check.sh`'s SC-008 assertion fired on its own test.** `DbOperationsPanel.test.tsx`
   asserts the same absence, so the grep matched it. Fixed by excluding `*.test.tsx?`, with the
   reasoning the browser-storage check already states at line 332 — a check that goes red because
   somebody wrote the matching test teaches people to delete the test (**I-62**).
3. **A report column of mine was mislabelled.** `fingerprint-measure`'s `ops` counted keys prefixed
   with a datasource name — but a named query is keyed `<datasource>.<query>` too, so Finance and Legal
   read **5 operations** when they have **0**. Corrected to read `dbOperationRepo` directly. Caught
   before it was quoted anywhere.

#### Every P2 control is proven by perturbation

**13 perturbations, 13 red runs.** Ten against the panel (drop the readback `note`; hardcode the cap;
drop the readback from the hand-built builder; un-collapse the SQL; drop FR-025's caveat; count only
proposals against the bound; add an invented sample-value cell; put the SQL above the readback; add a
Retry to the refusal; drop the no-schema guard). Three against the script (state the immutable-name
sentence on one path only; drop the pointer to expectations; add a sample-row builder). Plus one against
`manifest-builder.service.ts` — folding a workspace-global count into the tool fingerprint payload turns
**2** of T17a's assertions red, which is what makes "0 moved" mean something.

⚠ `manifest-builder.service.ts` was restored byte-identically after that last one (`diff -q` clean).
**It is not modified by this feature.**

### Baseline after P2 — 2026-08-27

| Package | Files | Tests | Δ from the P1 baseline |
| :--- | --: | :--- | :--- |
| `packages/server` | 108 | **1739 passed** · 23 skipped · **2 failed** | +6 (T17a) +1 (the flaky one passed this run) |
| `packages/client` | **61** | **894 passed** | +1 file, +32 tests (T17) |
| the other five | 18 | 230 passed | unchanged |

`pnpm -r typecheck` — **all 7 clean.** `scripts/ui-honesty-check.sh` — **206 PASS / 0 FAIL**, exit 0
(was 203).

⚠ **Two failures, not three, and it is the same three files.** `datasource-target.test.ts` passed this
run — which is the flakiness the correction above documents, arriving from the other side. `trigger-gate`
and `flow-replay` still fail; `git status` confirms `trigger-gate.test.ts` is **staged-modified by the
in-progress `legal-contract-demo-domain` work** (`M ` — index only, clean tree) and `flow-replay.test.ts`
is untouched. Neither is ours.

### ⚠ Open at the end of P2

| # | What | Who decides |
| :-- | :--- | :--- |
| 1 | ✅ **CLOSED — SC-003 is measured.** See *SC-003 closed* directly below. | — |
| 2 | **`CLAUDE.md` was out of date and is now true again by accident.** It says Finance holds three flows with two armed; when P2 started there were **zero flows anywhere**. `scenarios:seed` restored exactly the state it describes. ⚠ **Still an Article VII item**: the doc was wrong for however long the slate was clear, and nothing detects that. T25's job. | T25 |
| 3 | **Four junk workspaces** — `ds-target-control-1787831002357`, `…063932`, `…092263`, `…107908` — left behind by `datasource-target.test.ts`, the flaky one. Zero refs, zero flows. Not this feature's to clean up, but somebody should. | not us |
| 4 | **SC-001's measurement is still deferred to T24** (plan Decision 15) — needs a reader-less case in `draft:measure` and a temporary revert of T01 for the "before" half. `hr_demo` is the live fixture: 7 tables, 0 queries, **0 operations** (re-confirmed by `fingerprint:measure`). | T24 |
| 5 | **`.specify/feature.json` still points at this feature.** Restore from `<scratchpad>/feature.json.bak` when the feature closes. | T26 |

### What P3 inherits

* **T18 is a DOCBLOCK EDIT ONLY** — add `needs_component` to `flow_chat_turns.status`' documented list.
  ⚠ **No migration.** The column is `varchar(32)`; head is still `0041_approval_override`.
* **T19** must make a **separate inference call with its own budget** — `CHAT_TURN_MAX_TOKENS` stays
  **1024** and a turn still carries at most one op (FR-016, D-175). SC-005 is a control, not a hope.
* **T21** renders the `needs_component` bubble → the same approval dialog. ⚠ `ui-honesty-check.sh` has
  five ChatPanel assertions including the ban on `turn.text`; **only computed fields**, and the dialog
  components (`Readback`, `OutputColumns`, `CollapsedSql`, `REVIEW_CAVEAT`) are already exported from
  `DbOperationsPanel.tsx` and must be reused rather than reimplemented — that is D-195's argument again.
  T21 also inherits **D-194**: read the bound from the response, never a literal.
* ⚠ **Chat gets no Retry and no confirm button.** `flow-chat`'s turn endpoint has no `acceptedProposal`
  parameter — CLAUDE.md's record of why `policy_transform`'s button exists on `/flows/new` and
  deliberately not in chat applies here unchanged.

### SC-003 closed — measured 2026-08-27, with the user's authorisation to seed

`fingerprint:measure` was **INCONCLUSIVE (exit 2)** on its first run: zero armed flows on the deployment,
so "0 moved" would have been a statement about an empty set. `pnpm --filter @foundry/server scenarios:seed`
was run to create the condition. It behaved exactly as its docblock says:

| Flow | Draft run | Result |
| :--- | :--- | :--- |
| `finance-invoice-chase` | SUCCESS | **armed** — schedule `0 7 * * 1` deployed live |
| `finance-expense-policy` | **PAUSED** at `notify_gate_await` | **not armed, by design** — a gated flow cannot satisfy gate 1 unattended; the paused execution was **killed** (a pause holds an M3 slot) |
| `finance-budget-variance` | SUCCESS | **armed** — schedule `0 8 1 * *` deployed live |

⚠ **Two live cron schedules now exist on this deployment** that did not before: Mondays 07:00 and the 1st
of the month 08:00, Europe/London. Neither sends real mail — the flows call `mail_send` / `ticket_create`
(ops-api's simulated layer, verified: `foundry_email_send` appears **0** times in `finance-flows.ts`) — but
`finance-budget-variance` makes a real billable `llm_complete` call per fire (30 calls were logged on the
seed run).

`scenarios:verify` afterwards: **13 passed · 0 failed** at `2026-06`.

**The measurement:**

```
8 workspace(s) · 45 ref(s) · 2 armed flow(s) · 2 probe(s)
ref fingerprints that moved when an operation key was added: 0
fingerprints that differed between two reads:               0
armed flows the sweep would suspend right now:              0
PASS — 0 moved, across every workspace and every armed flow.
```

#### ⚠ The PASS is only worth something because the script was shown able to FAIL over these flows

| Perturbation | Result |
| :--- | :--- |
| Point the probe at a ref that already exists | ✅ collision guard fires — *"could not measure: `foundry_email_send` already exists in Legal"*, exit 2 |
| Move a fingerprint **the armed flow itself references** (`refs[0]`) | ✅ **2 moved**, exit 1, with *"Do NOT create an operation in these workspaces"* |
| Overwrite `Object.keys(current)[0]` | ❌ **did not fire — and the perturbation was wrong, not the control** |

⚠ **That third one is a trap worth knowing.** `Object.keys(current)[0]` lands on `foundry_email_send`,
which **neither armed flow references**, so `aggregateFingerprint` correctly ignores it — staleness is per
REF (§6.5), and a manifest change touching nothing a flow uses must have no effect. A person taking this
measurement again and perturbing the "first ref" will conclude the control is broken when it is the
perturbation that is. Perturb a ref the flow actually names.

---

### P3 — chat as a setup step · complete (T18–T22)

| Task | File | What landed |
| :--- | :--- | :--- |
| T18 | `packages/server/src/db/schema.ts` | **Docblock only.** `needs_component` added to `flow_chat_turns.status`' documented list, with why there is no `proposalJson` and no migration. ⚠ Head is still **`0041_approval_override`** — verified. |
| T19 | `flow-generation.service.ts` | `unknownRefs` became a thin wrapper over new **`refFindings`**, which returns findings **and** `ComponentGap[]`; `FlowDraftError` carries them; `authorFlow` populates them |
| T19 | `flow-chat.service.ts` | `attemptOp`'s catch branch reads `err.componentGaps` → `correctable: false` → the turn finishes **`needs_component`**, no revision |
| T20 | `flow-chat-imports.test.ts` | Allowlist → **6** symbols (`type ComponentGap`); **two new absences** asserted in opposite directions; +4 tests |
| T21 | `ChatPanel.tsx` | `TONE.needs_component` (**warn**, not danger), `refFromOp`, a `NeedsComponent` bubble that offers propose → the shared dialog → re-attempts the original message |
| T21 | **NEW** `components/data/OperationReview.tsx` | The review surface **extracted** so three surfaces share one implementation |
| T22 | `ChatPanel.test.tsx` | US3's four scenarios + SC-005's client half; +14 tests |

**Decision taken during P3 — full argument in [plan.md](./plan.md) Decision 29**

| # | Decision | The thing it settles |
| :-- | :--- | :--- |
| **D-197** | The chat service imports **nothing** from the proposer; the gap travels on the error | plan.md's own Phase-3 table said *"Import `proposeOperation`"*, contradicting **D-179** |

#### ⚠ Three things in P3 were not what the tasks assumed

1. **plan.md contradicted itself, and T20 inherited the error.** The Phase-3 file table said the chat
   service imports `proposeOperation`; **D-179**, written later, says the proposal is *"fetched by the
   client from the propose route"*. D-179 won. The result is stronger: **no inference call is added to
   the turn path at all**, so FR-016's *"separate call with its own budget"* is a different HTTP request
   rather than a `maxTokens` this module has to remember. Both the table line and the T20 bullet are now
   struck through in place rather than rewritten — the contradiction stays legible.
2. **"Detect the gap" had three implementations and two were traps.** String-matching the drafter's
   finding couples a control to prose that will be reworded, and it fails **silently**; re-deriving the
   condition in the chat service is a second definition plus three new repo imports into the most
   controlled module in the codebase. The fact now travels from the pass that already computed it.
   ⚠ `unknownRefs`' signature and its thirteen tests are untouched, and a test asserts the two agree
   byte-for-byte with a control that the comparison is not over two empty arrays.
3. **The review surface had to be EXTRACTED, and that broke two of my own greps.** `ChatPanel` is the
   third surface asking a person to approve a spec, so `Readback`/`OutputColumns`/`CollapsedSql`/
   `Params`/`REVIEW_CAVEAT`/`ProposalReview`/`ProposalRefusal` moved to `OperationReview.tsx`.
   ⚠ **`ui-honesty-check.sh`'s two assertions went RED immediately** — which is what a check that names
   its subject is supposed to do — and both were widened to the pair of files. ⚠ **`DbOperationsPanel.test.tsx`'s
   source-read greps did NOT go red**, because *"this file does not contain X"* stays true when X leaves.
   They now read both files. **That asymmetry is worth remembering: a positive assertion notices a move,
   a negative one does not.**

#### ⚠ A fourth trap fired, for the third time in this feature

`OperationReview.tsx`'s docblock names `lib/mock-rows.ts` in the sentence explaining why it was
deleted — so the SC-008 grep matched **its own justification**, and the test was satisfiable by
removing the explanation. Fixed with **D-188**'s comment-stripper, plus a control that the stripper
left code behind.

⚠ **Three occurrences in one feature** (the readback purity test in P1a, the script's 13c in P2, this).
The pattern is always the same: a grep for a forbidden *name* matches the prose about why it is
forbidden. **I-62's rule is the one to apply — state what is forbidden, not a pattern that resembles
it** — and where that is impractical, strip comments and control the stripper.

#### Every P3 control is proven by perturbation

**16 perturbations, 16 red runs.**

*Server (9)*: emit a gap with nothing introspected · emit a gap when the datasource has other readers ·
count schema ROWS instead of distinct entities · drop the memoization · make `unknownRefs` recompute ·
treat a gap as `correctable` · file a gap as `failed` · chat imports the proposer · the proposer imports
from the generation module.

*Client (7)*: remove `TONE.needs_component` · parse the datasource out of the finding prose · re-send the
message without creating the operation · hardcode the bound in the chat bubble · lead with the SQL in the
shared dialog · drop FR-025's caveat · render the SQL expanded.

⚠ **One perturbation of mine was WRONG and the control was right** — worth recording because the next
person will make the same mistake. Overwriting `Object.keys(current)[0]` in `fingerprint-measure` did not
move any aggregate, and that is **§6.5 working**: it lands on `foundry_email_send`, which neither armed
flow references, so `aggregateFingerprint` correctly ignores it. **Perturb a ref the flow actually
names** (`refs[0]`) — that reports 2 moved and exit 1.

### Baseline after P3 — 2026-08-27

| Package | Files | Tests | Δ from the P2 baseline |
| :--- | --: | :--- | :--- |
| `packages/server` | 108 | **1750 passed** · 23 skipped · **2 failed** | +7 (T19 facts) +4 (T20 absences) |
| `packages/client` | 61 | **908 passed** | +14 (T22) |
| the other five | 18 | 230 passed | unchanged |

`pnpm -r typecheck` — **all 7 clean.** `scripts/ui-honesty-check.sh` — **206 PASS / 0 FAIL**, exit 0.
The two failures are still `trigger-gate.test.ts` (staged-modified by the in-progress
`legal-contract-demo-domain` work) and `flow-replay.test.ts` (untouched). Neither is ours.

### ⚠ Open at the end of P3

| # | What | Who decides |
| :-- | :--- | :--- |
| 1 | **P4 is NOT optional** (plan Decision 8). P0 moved `DRAFT_RULES`, so `kestra:refusal`, `outline:measure`, `draft:measure` and `chat:measure` are all **stale for this path**. ⚠ **No number from any of them may be quoted** until T24 re-takes them. P3 also edited nothing in `CHAT_RULES`, so chat's staleness is P0's alone. | T23/T24 |
| 2 | **SC-001's measurement** — needs a reader-less case added to `draft:measure` and a temporary revert of T01 for the "before" half. `hr_demo` is the fixture: 7 tables, 0 queries, 0 operations. | T24 |
| 3 | **US3 scenarios 1–3 are proven CLIENT-side and by source-read on the server.** The turn engine needs a database and a model — `flow-chat.test.ts` says so in its own docblock — so end-to-end `needs_component` behaviour is `chat:measure`'s to confirm. **T24 should add a reader-less chat case.** | T24 |
| 4 | **Two live cron schedules now exist** from `scenarios:seed` (Mondays 07:00, 1st of month 08:00). Not this feature's to remove, but they were not there before P2. | user |
| 5 | **`.specify/feature.json` still points here.** Restore from `<scratchpad>/feature.json.bak` at close. | T26 |
| 6 | Four junk `ds-target-control-*` workspaces from `datasource-target.test.ts`. Not ours. | not us |

### What P4 inherits

* **T23 (SC-006)** — the acceptance-rate measurement. ⚠ Read plan Decision 21 (**D-189**) first: a
  person clicking through a queue of proposals is the state where acceptance rate stops meaning
  anything, which is why `MAX_PROPOSALS_PER_REQUEST` exists.
* **T24** — re-take everything P0 invalidated, **recording the model beside each number** (CLAUDE.md:
  every generation measurement in this repo was taken on gemma, and the model is a ~4× lever).
* **T25 (Article VII)** — `CLAUDE.md` and `WORKFLOW-CREATION-AND-GENERATION.md`. ⚠ Two known
  inaccuracies to fix beyond this feature's own additions: the armed-flow claim was **false** when P2
  started (zero flows deployment-wide) and is true again only because `scenarios:seed` was re-run; and
  `ui-honesty-check.sh` is **206** assertions, not 196.
* **T26 (Article I)** — restore `.specify/feature.json`.


---

## P4 — measurement and documentation (2026-08-27)

**T23, T24, T25, T26. The phase whose whole job is to find out whether the previous four worked — and
it found that one of them does not.**

### The two findings that matter more than the numbers

**1. Chat's `needs_component` never fires (D-201).** Every piece is built and unit-proven — the gap
travels on `FlowDraftError` from the pass that already computed it, the client renders the offer, 14
tests cover it. End to end on `gpt-5.4-mini` the turn answers **`too_structural`** *first*, and the
model states the gap correctly **in prose** while filing it under the wrong status:

> *"The requested step depends on a specific hr_demo source that does not exist in the available
> callable steps, and there is no single valid one-component change…"*

The op call self-refuses, so `authorFlow` — the only place `refFindings` runs — is never reached.
**4 of 4 runs**, three phrasings, including one naming the datasource outright, on an empty flow.

* ⚠ **My first probe was wrong before the feature was.** It asked for a whole automation in one
  sentence, which is `too_structural`'s legitimate job. That reading was discarded and re-taken with a
  single-step message. Both phrasings are probes now, because the natural one missing **is** the
  finding.
* ⚠ **This is the 2026-08-21 `too_structural` defect one level deeper**, and that entry's own warning
  is why nobody caught it: *"nothing server-side can know whether a request really was structural, so
  a `too_structural` cannot be validated, only believed"* — the one rule in `CHAT_RULES` with no
  mechanical half. `chat:measure --scenario=2` is now that half, as a measurement.
* ⚠ **A structural tension nobody had noticed**: T01's rule makes the drafter *refuse* rather than
  invent `<ds>.<table>`, and `needs_component` detection **depends on the model having written that
  ref**. P0 makes SC-001 better and US3's chat offer harder to reach, by the same sentence.
* **NOT FIXED, deliberately.** A measurement task must not quietly become a prompt change to the most
  controlled module here — that is how the thing measured stops being the thing that shipped.

**2. SC-001 shows no measurable difference on this model.** n=3 each half, same model, same goal,
T01's four rule lines deleted and **restored byte-identical** (`diff -q` verified): **3/3 refused on
attempt 1 both ways.** `gpt-5.4-mini` already declines to call a table unprompted. The failure T01 was
written for was measured on gemma — and **gemma was down**, so it could not be shown either way.

### ⚠ Four traps, and three of them nearly produced a wrong number

1. **A DOWN MODEL LOOKS LIKE A BAD MODEL.** The gemma run reported *"1 attempt, then a failure"* — the
   exact shape of a model behaving badly. It was a gateway failure. **Discarded, not recorded.** A
   harness cannot tell these apart; the person running it must. *(The user said gemma was down; that
   is how it was caught.)*
2. **HR WAS NEARLY THE WRONG FIXTURE, AND IT LOOKED RIGHT.** `hr_demo` is genuinely reader-less (7
   tables, 0 queries, 0 operations) — but HR holds **16 tools**, four reading attendance, so every
   attendance goal is served *without the datasource being reached*. The SC-001 arm would have passed
   while measuring nothing. **Found by reading a PASSING run.** The case is over `leave_requests`,
   which no tool serves.
3. **`draft:measure` COULD NOT MEASURE SC-001.** A refusal scored `FAILED`, its reason landed in
   `other`, and it counted against `N/M drafted` — so *"refused correctly on attempt 1"* and *"burned
   three attempts and threw"* were **identical in every column**. That distinction is SC-001's entire
   content. Fixed (D-200). ⚠ `outline-measure.ts` **already had this right**, which makes it a defect
   rather than an oversight.
4. **A SCENARIO SCRIPT'S `main()` RUNS AT IMPORT.** `propose-measure.test.ts` imported the harness to
   reach its adjudicator and silently loaded the repos, the config and the gateway client; a live run
   would have fired ~7 model calls and `process.exit` **inside the test suite**. Symptom: vitest's
   `collect` was **903 ms** for a 13-test file and **72 ms** after. The adjudicator moved to
   `propose-adjudicate.ts`. ⚠ **Never import a `scenarios/*.ts` or `kestra/*.ts` script from a test.**

### T23 — how SC-006 was measured, given there is no reviewer

`propose-measure.ts` + `propose-adjudicate.ts`, 7 need statements over `hr_demo`. **D-198.**

SC-006 asks for a **reviewer's** three-way split. Both substitutes were rejected as worse than no
number: an implementer eyeballing their own system's output with the answer on screen, or a model
judging a model (two draws from one distribution). So it adjudicates against an expectation **declared
before any proposal was seen** — the expectations cannot be relaxed to fit a bad result without the
relaxation being in the diff.

⚠ **`edited` is an UPPER bound and `unedited` a LOWER bound** on what a person would report — the safe
direction for a figure that gates a reliability claim.

**Reading, 3 rounds, all three agreeing** — proposing **9 unedited · 3 edited · 0 rejected** (n=12);
refusing **6 correct · 0 proposed anyway** (n=6). Reported by **arm**, because a correct refusal lands
in `unedited` and pooling makes "proposed badly, refused perfectly" score the same as the reverse.
⚠ `--rounds` defaults to **3 because the first two runs disagreed** (5/1/0 then 6/0/0) at n=6.

**⚠ The hard case fails 3 of 3, and it is the most valuable case in the feature.** *"Below their own
department's threshold"* needs a column-to-column comparison the form cannot express. It proposed a
**compiling** spec joining `attendance_monthly.employee_id` to `policy_thresholds.department_id` — an
employee id equated to a department id — and **the readback said so in plain English**: *"each row
matched to policy_thresholds, by employee_id = policy_thresholds.department_id"*. The strongest
evidence in this feature that the readback is the right review artefact, produced by the case designed
to fail.

⚠ **Out of scope, real, and worth someone's time**: `compileOperation` does not require a join to
follow a declared FK — two integer columns compile. Pre-existing (a person can build the same join
visually), but a *model* can now reach it, and the readback is the only thing standing there.

### T24 — the numbers, all `gpt-5.4-mini`, all 2026-08-27

⚠ **These are NOT re-takes of the same thing.** The old numbers were gemma; this deployment resolves
`gpt-5.4-mini` from a `/ai-provider` override, so **the old numbers are not their baseline.**

| Harness | Reading |
| :--- | :--- |
| `kestra:refusal` | **3 refused, 0 invented**; control clean 3 of 3 |
| `outline:measure` | kept **2 of 3** · drifted 0 · no parseable draft 1 (a step id over 63 chars) |
| `draft:measure` | goal **7/12, 1.1 attempts, 2.5 s** · outline **3/3, 2.0 attempts, 5.7 s** |
| `chat:measure` | 5 turns · applied 2 · refused 2 · failed 1 · steps reached 2 of 5 |
| `propose:measure` | see T23 |
| `fingerprint:measure` | **0 moved**, 8 workspaces / 45 refs / 2 armed (P2's number, unchanged) |

* ⚠ **`draft:measure`'s ordering INVERTED.** The complaint it was built for was *"goal mode takes
  forever, stepwise is quick"*; outline mode is now the slower, more attempt-hungry arm. **Do not quote
  the old reading as current.**
* ⚠ **`chat:measure`'s `2 of 5` is one failure plus its consequences.** Turn 1 failed on a nested
  `{{ }}` (I-11), leaving the flow empty, so turns 2 and 3 correctly said *"the automation is empty"*.
  A cascade reads as a 40% success rate.
* ⚠ **`refusal-verify.ts` and `outline-measure.ts` printed NO MODEL AT ALL.** Both now print the
  **resolved** one, never `config.inference.model` — the two disagree here, which is exactly the
  condition `draft-measure.ts`'s own header comment was written for.
* **`draft:measure --model=<name>`** (D-199) compares models **without touching `generation_llm`**. The
  credential still comes from `config.inference` alone — D-35: this seam gains a *model*, never a
  credential.

### T25 — the docs

`WORKFLOW-CREATION-AND-GENERATION.md`: the *"SQL was generated"* row **rewritten precisely rather than
deleted**; DB operations described as visual **or** proposed; the CALLABLE-STEPS quote gains T01's
rule; `kestra:refusal`'s number now carries **both models in a table**; new **§5 *Cross-cutting C***.

`CLAUDE.md`: a section for the feature, plus the two inaccuracies this feature found — the gemma claim,
and *"the deployment holds THREE flows"* (it holds **five, 2 armed**; two `Untitled flow` drafts from
08-24 and 08-25 that nothing cleans up — ⚠ **not deleted, they are somebody's working state**). And the
claim was false in the **other** direction when P2 began: zero flows deployment-wide.

⚠ **I nearly attributed those two flows to my own `chat:measure` runs.** Their `createdAt` is 08-24 and
08-25; today is 08-27. `chat:measure` deletes the flow it creates **by id** — verified. Check
timestamps before blaming your own harness.

### T26 — compliance

`/speckit-comply` run. **Two findings acted on, both real:**
* **Check A** — `draft-measure.ts`, `chat-measure.ts`, `fingerprint-measure.ts`, `OperationReview.tsx`
  and `packages/server/package.json` were changed but **named nowhere in tasks.md**. Added, plus a
  status block, because tasks.md had **no completion markers at all** — a reader could not tell which
  of 26 tasks were done.
* **Check B / Article II** — `adjudicate()` **is** SC-006's number and had no automated test. Now 13
  tests with a control that it does not return one verdict for everything. Perturbation-proved by hand
  first (an expectation's `ops` flipped to `["gt"]` → *"used `lt`, wanted gt"*).

**Open for the user** — **Article VI**: one feature = one timestamp branch. This shipped on
`20260819-080932-legal-contract-demo-domain`, **someone else's**, whose 122 staged additions and 50
staged modifications are still in the tree. Raised, never acted on: branch creation is the user's call.

### Perturbations — P4

| # | Perturbation | Result |
| :-- | :--- | :--- |
| 1 | An expectation's `mustFilter.ops` flipped to `["gt"]` | **red** — *"used `lt`, wanted gt — this one changes the ANSWER"* |
| 2 | Scenario 2's `expectStatus` set to the status actually returned | **green** — proving the match path, which no real run had reached |
| 3 | T01's four `DRAFT_RULES` lines deleted (SC-001's "before") | **no change** — the finding itself; restored byte-identical |

⚠ **Perturbation 2 exposed a defect in my own output**: the note *"(a SUCCESS: a real gap, named…)"*
printed for **any** matched status, including a probe declaring `too_structural` *because it is
expected to miss*. Now per-status. It was only visible in the one run where declared and actual agree.

---

## P5 defined (2026-08-28) — the user chose Option A

**No code written.** The artefacts now specify it; T27 is the first source change and the standing
instruction is one phase at a time.

### What changed in the artefacts

| File | What |
| :--- | :--- |
| `spec.md` | **FR-027** (a missing reader is not structural) · **FR-028** (the `too_structural` control) · **SC-009** (measured end to end, ≥3 runs, with its control) · US3 gains **scenario 5** and a note recording that **scenario 1's precondition was never established** |
| `plan.md` | Phase table → **five** phases · **Decision 34 / D-202** · a Phase 5 build order |
| `tasks.md` | **T27–T30** · deps `T26 → T27 → T28 → T29 → T30` · FR-027/FR-028 in the coverage table · a **fifth** entry in *the assertions that must never be quietly dropped* |

### The one thing to understand before writing T27

The turn asks the model **twice**, and `needs_component` is only an answer to the *second* question:

```
Q1  "what ONE change?"   ← CHAT_RULES     answers: ok │ too_structural │ ambiguous_referent
      └── too_structural ──────────► terminal. We land here. Nothing downstream runs.
      └── ok ──► Q2  "author it"   ← authorFlow → refFindings → needs_component
```

So the op call refusing **is** the op call skipping the only code that can detect the gap. Option A does
not add a capability; it lets already-shipped, already-tested code execute.

### ⚠ Three things P5 must not become

1. **A schema change.** No fourth status on `chatTurnResponseSchema`, no new terminal branch, no client
   change. If one seems needed, **stop** — that is Option B and a different decision.
2. **A rewrite of the 2026-08-21 sentences.** Those five lines in `CHAT_RULES` were added for a measured
   failure; a shorter combined version restates the general rule instead of the specific one, **which is
   the defect they fix.** Add beside them.
3. **A rule that turns every refusal into an `add_step`.** That satisfies SC-009 and silently deletes the
   `too_structural` channel — and **T28 stays green either way.** FR-028's control probe in the same
   measurement run is the only place it shows.

### ⚠ The boundary P5 is deciding, stated so nobody "fixes" it later

`DRAFT_RULES` tells the drafter *"a manifest table is NOT callable — refuse"* (T01). `CHAT_RULES` will
now tell the op call *"name that datasource"*. **Both are right, and the difference is whether a person
is present**: a headless draft has nobody to offer the missing component to; a chat turn does.
`refFindings` detects the gap **by inspecting a ref the model wrote**, so the detection depends on the
naming T01 discourages — which is why this is a boundary to state rather than a contradiction to fix.

### What T30 is measuring against

**The "before" half already exists**: `needs_component` reached **0 of 4 runs** on `gpt-5.4-mini`, three
phrasings, one naming the datasource outright, on an empty flow. ⚠ **Three runs minimum** for the
after — the op call was observed answering *two different ways to one identical message*
(`too_structural` then `applied`). ⚠ **0 or 1 of 3 means STOP, not reword** — that is Option B's
evidence.

⚠ **P5 does NOT address SC-001** (no measurable difference from T01's rule on this model, gemma down).
Still open, and must not be read as closed by P5 shipping.

---

## P5 — implemented (2026-08-28). `needs_component` 0 of 4 → 3 of 3

**T27–T30. Option A, by the user's decision. It worked — and it was NOT one prompt rule.**

### ⚠ Two blockers found by reading the code BEFORE writing the rule

Both would have sunk the phase, and neither is visible from the plan.

**1. `operations` was missing from chat's catalogue (D-204). A live bug, older than this feature.**
The drafter passes `{tools, queries, operations}` to `resolveSelection`; the chat turn passed
`{tools, queries}`. `operations` is **optional** on that signature and defaults to `[]`, so nothing
errored — **every saved DB operation was invisible to every chat turn.** Build one visually, then ask
chat to use it: chat could not see it. ⚠ It would have broken US3 scenario 2 *after* a proposal was
approved — `refInterfaces` resolves the new ref fine, so the operation existed; the model was simply
never told. **The offer would have worked and the retry would not.**

**2. A prompt rule alone could not have worked, whatever it said (D-203).** A chat turn's prompt is
`CHAT_RULES` + CALLABLE STEPS + expression rules + the current automation + recent turns + the message.
**No manifest.** `catalogueText` renders only what is *callable*, so a reader-less datasource appears
**nowhere** — the op call cannot name `hr_demo` because it has no way to know it exists. (The earlier
run that named it did so because my probe message did.) And naming it is not optional: `refFindings`
matches a ref's **prefix against a real datasource name**; a guess yields *"does not exist"* and no gap.

### What was built

| | |
| :--- | :--- |
| `readerlessDatasources()` + `readerlessBlock()` | in `flow-generation.service.ts`, **beside `refFindings`**, using byte-for-byte the same condition. Allowlist **6 → 8**; first allowlisted symbol with a **query** behind it, admitted because it returns **data, not a decision** |
| `DATASOURCES WITH NO READER YET` | a chat-prompt section, **chat only** — never the drafter's, which is deliberately told the opposite, and whose bytes every generation measurement was taken against |
| The `CHAT_RULES` rule | beside the 2026-08-21 sentences, **not instead of them** |
| `buildChatPrompt`'s `readerless` | **required**, not optional — D-204's lesson applied in the same commit; two existing tests updated rather than the type loosened |

### ⚠ The first rule wording FAILED, and it looked like the model failing

Raw reply, captured rather than guessed:

```json
{"status":"add_step","op":{"op":"add_step","step":{
  "ref":"hr_demo.<reader for approved leave requests by period>", ...
```

Two authoring bugs, both mine:

1. **`"answer add_step"` collided with the prompt's own convention.** Every other rule says *"answer
   `too_structural`"* / *"answer `ambiguous_referent`"* — and **those are status values**. So the model
   put `add_step` in `status`, the discriminated union rejected it, and the turn came back `failed`.
   ➡ **State the reply shape as literal JSON, never as "answer X".**
2. **The angle-bracket template came back literally.** `<datasource>.<the reader you need>` produced
   `hr_demo.<reader for approved leave requests by period>`.
   ➡ **Never put an angle-bracket template in a prompt.** A concrete example (`sales_db.open_orders`)
   plus *"never anything in angle brackets"* fixed it.

### T30 — the numbers, `gpt-5.4-mini`

| | Before | After |
| :--- | :--- | :--- |
| `needs_component` reached | **0 of 4** | **3 of 3** |
| FR-028 control still `too_structural` | — | **3 of 3** |
| Revision written on the gap turn | — | **none** (0 Kestra round trips, 0 steps) |
| `chat:measure` scenario 1 | applied 2 · refused 2 · failed 1 · 2 of 5 | applied 4 · refused 1 · failed 0 · **4 of 5** |

⚠ **Do NOT attribute scenario 1's improvement to P5.** Its turn 1 previously failed on a nested `{{ }}`
(I-11) and cascaded; this run's turn 1 succeeded. Variance there is large.

⚠ **Probe 2's declared expectation was REMOVED, and that is a finding.** Before P5 the natural
multi-sentence phrasing reliably answered `too_structural` — the documented dead end. After P5 it comes
back `applied` three times in four and `needs_component` once. **Both are correct answers to an
ambiguous request** and neither is a dead end, so declaring either would fail the harness for a turn
that did nothing wrong.

### Perturbations — 7 run, 7 red, and one of them found a missing test

| # | Perturbation | Result |
| :-- | :--- | :--- |
| 1 | `readerlessDatasources` drops the `tables > 0` gate | **2 red** |
| 2 | `countEntities` reverted to the buggy count I nearly shipped | **8 red** |
| 3 | chat drops `operations` again | ⚠ **GREEN — see below** |
| 4 | the reader rule deleted from `CHAT_RULES` | **3 red** |
| 5 | the rule's scoping sentence deleted (widened) | **3 red** |
| 6 | `readerlessBlock([])` returns text | **1 red** |
| 7 | the reader check dropped — agreement broken | **3 red**, the agreement test by name |

⚠ **Perturbation 3 exposed that D-204's fix had NO TEST** — reverting it left the entire suite green,
which is the same silence that let the bug live. Fixed with a **catalogue-parity** test: both
`flow-chat.service.ts` and `flow-generation.service.ts` are read off disk and each must pass
`operations` into `resolveSelection`, with a control that the scan reads real modules. Re-perturbed →
**red, by name.** *An untested fix to a silent bug is the bug waiting to come back.*

### ⚠ Traps that fired again

* **The fourth-time trap.** `indexOf("DATASOURCES WITH NO READER YET")` found **the rule's own mention**
  inside `CHAT_RULES` (3339) rather than the section (3669) — the assertion failed while the code was
  correct. Re-anchored on a sentence only the block has, plus a control that `CHAT_RULES` lacks it.
  Same shape as P1a's readback purity test, P2's script check, P3's `OperationReview.tsx` docblock:
  **when a rule and the thing it describes share a name, anchor on the thing.**
* **Two table-count implementations, mine.** My first `readerlessDatasources` counted distinct
  `entityName` among rows with `columnName === null`; the existing one counts
  `entitySchema\0entityName` over **all** rows. Mine would have merged same-named tables in different
  schemas and **silently omitted** a datasource with no entity-level rows. Extracted `countEntities()`
  so there is one. ⚠ **Caught by checking whether my own comment was true**, not by a test.
* **cwd drift, twice more.** A `cd packages/server` persisted and broke two restores mid-perturbation,
  leaving a file perturbed. Always restore with an absolute path and `diff -q`.

### Final state

7/7 typechecks clean · server **1778 passed / 23 skipped** (1804) · client **908** ·
`ui-honesty-check.sh` **206 PASS / 0 FAIL**.

⚠ **3 failures, none this feature's.** `trigger-gate.test.ts` and `flow-replay.test.ts` are the
deterministic pre-existing pair. `datasource-target.test.ts` is **flaky**: 5-second timeouts against a
live Postgres, **2 failures on one run and 1 on the next with identical code**, it imports nothing this
feature touches, and its own stderr reports *"password authentication failed for user u"*. It is also
the test leaving `ds-target-control-*` workspaces behind — **6 now, up from 4.**


---

# Phase 6 — the date a month cannot have (2026-08-28)

## Where it came from

Not from the plan. The user ran the feature for real in the app: added a proposed operation to `hr_demo`
via *"Propose one for me"*, then asked chat for *"Generate a report for employees approved leaves and send
it to my email"* — and reported it failing.

**The diagnosis took four hops and none of them was the obvious one:**

1. `flow_chat_turns` showed mostly `applied` turns and two `failed` — so chat authoring was mostly fine.
2. `flow_step_runs` showed `fetch_leave_requests` with **`kind = query`** — the DB operation *was* wired
   in correctly. Not a catalogue problem, not a P5 problem.
3. `flow_executions` said `running`, still, an hour later. **Kestra said `FAILED`** — 0.4 s in.
4. The Kestra log had it:

```
502 {"error":"operation \"hr_demo.approved_leave_requests\" (read from production):
      all 1 execution(s) failed",
     "detail":{"results":[{"ok":false,
      "error":"date/time field value out of range: \"2026-06-31\""}]}}
```

**June has 30 days.** Input was `{"period": "2026-06"}`; the drafter had bound `period_end` as
`"{{ inputs.period }}-31"`.

⚠ **Do not skip hop 3.** Foundry's own status said `running` while the truth was `FAILED`. Reading the
parent DB alone would have produced *"the run is slow"*, which is not a diagnosis — it is a wrong one.

## Why the feature owns it

Before **D-204**, chat's and the drafter's catalogues could not reference a DB operation at all, and a
tool takes whatever its endpoint takes. **No step in any workspace had ever had a `type: date` parameter
to bind.** The drafter met the problem for the first time because P5 handed it the problem. See **D-205**.

## What was built

| Half | Where | Why there |
| :--- | :--- | :--- |
| The rule | `EXPRESSION_RULES` | One definition, three prompts — draft, refine, chat |
| The check | `flow-date-params.ts` → `SHAPE_CHECKS` | Pure, so refine and chat run it too |
| The shared list | `EXPRESSION_FIELDS`, exported | Two copies would double a silent omission (D-197) |

**The rule can be categorical**, and that is the interesting part: `ALLOWED_CALLS` is
`{json, jq, first, length}`. There is no date function, no date filter, no arithmetic — so *"the last day
of the month a person named"* is **not expressible in an expression at all**. I checked this before
writing the rule, because teaching a filter the engine does not have is I-118's original failure and the
temptation here was strong.

## The trap I nearly walked into

My first instinct was to check for the literal `2026-06-31`. **That check would not have caught this
bug** — the literal appears nowhere in the flow. It is produced at render time from
`{{ inputs.period }}` plus two characters. The check has to catch the *construction*, not the value.

## The half that took the most thought

**What NOT to flag.** The same failing step's `period_start` was `"{{ inputs.period }}-01"` — the
identical concatenation, and correct, because every month has a first. A check that flagged both would
have no signal in it, and a finding a reader learns to scroll past is worse than no finding (I-38 from the
other end). So: days **29, 30, 31** flagged; **01–28** left alone; **February checked at 29**, because a
leap year makes `-02-29` legal and flagging it would be wrong one year in four.

## Perturbations — 5 run, 5 red

Unregister the check → 4 red. Permissive (28→31) → 8 red. Over-eager (28→0) → 2 red, including *"leaves
`-01` alone"*, which is the control that matters. Leap-blind → the leap test by name. Weakened rule
wording → `EXPRESSION_RULES`. All restored with `diff -q`.

⚠ **cwd drift bit again** — a persisted `cd packages/server` sent a `python3` edit to a path that did not
exist. Third time this session. Absolute paths only, in every script, always.

## What is now true, and what is not

* **Fixed, robustly**: even if the model ignores the rule, the check refuses the flow *before* a run and
  hands the model a finding naming both remedies. The failure mode moved from *"a run dies in Postgres"*
  to *"a draft is refused with an explanation"*.
* **NOT verified against a live model.** The rule's effect on `gpt-5.4-mini` is unmeasured. The check
  does not depend on it.
* ⚠ **`chat:measure`, `draft:measure`, `outline:measure` are STALE again** — the prompt text moved on
  every path. Marked stale, not quoted.
* **Still open, and not P6's**: `flow_executions.status` stayed `running` on a run Kestra had `FAILED`.
  The flow was deleted from Kestra afterwards (`404`), so the terminal callback may have been lost with
  it — **not asserted, not diagnosed**. It means the UI spins forever on a run that died in under a
  second. Worth its own look.
