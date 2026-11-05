# Phase 6 — Replay, sharing, migration

**Status:** 🟢 **ALL TASKS DONE** — exit criterion met, **with a negative control**, at two periods.
**Implements:** [08 §10 "Phase 6"](../08-scale-and-phasing.md) · [04 §5.2](../04-generation-model.md) · [05 §6.3](../05-lifecycle-and-flows.md)

## Tasks

| # | Task | Status |
| :--- | :--- | :--- |
| 6.1 | `components/flow/ReplayControl.tsx` + replay authz (does this tenant own this execution?) | ✅ |
| 6.2 | Flow export in **Foundry's model format** — never Kestra YAML | ✅ |
| 6.3 | Flow import — Foundry's model only; every ref revalidated against the **importing** tenant's manifest | ✅ |
| 6.4 | Per-tenant template library | ✅ |
| 6.5 | Fragment-promotion tracking — surface `code` steps recurring across flows as tool candidates | ✅ |

~~Migrate existing `scripts` rows~~ — **dropped.** Those tables are deleted outright in Phase 4
([07 §7.0](../07-refactor-inventory.md)); nothing is in production, so there is no history worth
preserving and no migration to write.

```bash
pnpm --filter @foundry/server kestra:phase6                 # 69 assertions against the running engine
pnpm --filter @foundry/server kestra:phase6 --period=2026-05
pnpm --filter @foundry/server kestra:phase6 --live          # route fragment generation through Tether
```

## What travels and what does not

| Component | Exported? |
| :--- | :--- |
| Step declarations, inputs, branching, retry config | **Yes** |
| Tool / datasource refs (by name) | Yes — **revalidated against the importing tenant's manifest** |
| Secret references | **Names only**, and only for the tools this flow calls. Values never leave `workspace_secrets`. |
| **`code` step CONTRACTS** | **Yes** — see D-24. This is what makes an import regenerable at all. |
| **Generated code in `code` steps** | **No.** Stripped; the step imports as `needs_regeneration`. |
| The cron | Yes, and **inert on arrival** — a Schedule trigger is only emitted for an approved revision, and an imported flow has no approval. |
| Execution history, step runs, approvals, armed state | No |

`bundleStep` is an **allowlist per kind**, not a filter that deletes `code`. A deny-list would carry the
next field added to `CodeStep` by default, and the first time that mattered would be the first time
something sensitive was added.

## The exit criterion — met, and the control is the result

> Export a flow from the HR workspace, import into `hr_demo_alt`, regenerate its code steps, and assert
> it produces the **alt** oracle's answer. **The 0–100 vs 0–1 rate difference is the assertion that
> matters.**

Proving only the positive case would have been worthless: a harness that cannot detect a wrong answer
produces the same green as one that can. So the same bundle is imported into the rehearsal tenant
**twice**, against two named queries differing in exactly one respect — whether the rate is converted
to the percentage the travelling contract declares.

```
NEGATIVE CONTROL — the alt's native 0-1 fractions
  imports with ZERO blocking findings                          0
  …and runs green                                              SUCCESS
  …flagged_count is still right — a count does not scale away  9
  …but worst_shortfall is WRONG, and plausible                 true
      reported 0.2 · truth 20.00 — no error, no empty result

POSITIVE — the same query, rates converted to the contract's units
  imports with ZERO blocking findings                          0
  …and runs green                                              SUCCESS
  …flagged_count matches the ALT oracle                        9
  …and worst_shortfall matches the ALT oracle                  20.00
  both arms imported identically — the check could not tell them apart
```

**That pair is the phase's real finding, and it is a limit as much as a success.** An import is a
**structural** check: it proves every ref exists here and every call signature matches. It cannot tell
whether this tenant's query returns the same columns in the same units, and nothing short of running
the flow against the importing tenant's oracle can. See [DECISIONS.md](DECISIONS.md) D-24.

### Why `worst_shortfall` and not a count

A count of flagged rows is identical under either unit — the comparison is rate-vs-threshold and both
sides scale together — so a flow that only counted would pass against both datasets and **detect
nothing**. A shortfall does not scale away: `85 − 62.5 = 22.5` becomes `0.85 − 0.625 = 0.225`. No
exception, no empty result, no failed step. It is the measured failure class of this whole migration,
reproduced deliberately so the harness can be shown to catch it.

### The flow that travels is not the Phase 3 one

`hr-screening.model.ts` has **no `code` step**, so it would satisfy "regenerate its code steps"
vacuously — proving only that a `datasource` ref can be remapped. `hr-screening-portable.model.ts` adds
one, positioned exactly where the two datasets disagree, and the origin flow is created **through
generation** so that there is a first fitting to refit.

The scripted fragment is deliberately **unit-agnostic**: it subtracts the two fields it was given and
assumes no scale. So the whole difference between the two arms is attributable to the importing
tenant's query. A fragment that "helpfully" normalised would have hidden the thing being measured.

## Replay — one operation in the design, two in reality

[DECISIONS.md](DECISIONS.md) **D-26**. Building 6.1 produced a measured fact that splits §6.3's single
`replay` into two operations:

> **A partial replay does not execute `begin`.** Its taskrun is copied like any other upstream step,
> so the replay's Foundry row holds **zero** execution credentials of its own.

`begin` is the approval gate, the credential mint and the row creation. Skipping it means a partial
replay would bypass the gate, reuse a possibly-dead credential, spend no budget, be invisible in
history, and **hang** if an agent step is downstream (I-18). So:

- **full replay** is the default and is unconditionally safe — `begin` re-runs and everything re-applies
  on its normal path.
- **replay from a step** has Foundry re-apply the gate, charge the budget and write the row itself, and
  **refuse** where it cannot compensate. Every refusal names the alternative.

Measured, in `kestra:phase6`:

```
a SUCCEEDED run cannot be resumed mid-way, and says why       true
a FAILED run still holds its credential, so it CAN be resumed true
`screen` was REHYDRATED — it never called Foundry a second time   1
…while `notify`, downstream of the replay point, genuinely re-ran 2
`begin` did NOT execute — the replay row has no credential of its own  0
a replayed step writes NO pointer row under the replay's own id (I-18) 0
a purged execution is 410 GONE, naming the retention window   410
a partial replay reaching an agent step is REFUSED            409
```

**A succeeded run can never be partially replayed**, and that is correct rather than a limitation:
`complete` burns the credential on the way out, and a partial replay reuses it. The refusal distinguishes
"this run completed" from "the credential expired", because the second reads as a defect when it is the
design. Resuming mid-way is for a run that **failed** — which is §6.3's scenario exactly.

**The client names a STEP, never a taskrun.** §6.3's diagram ends `{taskRunId}`, which is a Kestra
identifier; the API takes `{ fromStepId }` from Foundry's model and resolves it server-side (R5).
`downstreamOf` is computed from `dependsOn`, never from ordinal position — ordinals agree with
dependencies until a flow branches, and on a branching flow an ordinal version would both refuse safe
replays and permit hanging ones.

## Three issues, and two of them were bad tests

- **[I-18]** a partial replay past an `agent` step would pause for ever. Found by reading the resume
  path *before* writing the feature, and closed by refusing it rather than by rewriting step-run
  attribution — the credential is rehydrated by the engine, so it cannot be made to name the replay.
  The mis-attribution is left in place and **asserted**, so a change to it is noticed.
- **[I-19]** *"did this step re-run?"* is invisible in both of the obvious signals. Task **state** is
  copied along with the taskrun, so `begin` reads `SUCCESS` in a replay that never ran it. Taskrun
  **ids** are regenerated for the copies too, so "the id changed" is true for everything. The
  discriminator is the trace a run would have left in Foundry — pointer rows, and credential rows.
- **[I-20]** the HR dataset flags nobody outside its reporting month, so `Math.max(...[])` gave an
  expectation of `-Infinity` at `2026-05`. The third time *"run it at more than one period"* has paid
  for itself. A period with nothing to report is now its own assertion: `max()` over an empty sequence
  **raises** in Python, so a fragment that does not seed its accumulator fails on exactly the period
  nobody demos.

## Fragment promotion — a surfacing heuristic, and it says so in the payload

04 §5.1: *"a fragment appearing across many flows is a candidate to become a pre-written tool… each one
promoted removes a class of generation error permanently."* That last clause is why it is worth
building: promoting a recurring fragment does not make it *more likely* to be right, it takes it out of
the generated set.

`code` steps are grouped by their contract's **interface** (input and output field names and types,
sorted; descriptions excluded, because they are model-written prose that would never match). Three
things it reports and one it refuses to:

| | |
| :--- | :--- |
| `flowCount` | **distinct flows**, at each flow's current **draft** revision only. Scanning all revisions would make the most-iterated flow look like the most reusable one. |
| `distinctBodies` | `1` across several flows is the strong signal and needs no interpretation. |
| `purposes` | every one, **verbatim and unmerged** — the only evidence of intent, and a human judges it. |
| `shapeOnly` | set when the interface matched and the purposes did not. |

It never reports a score. `{rows: array<object>} → {result: array<object>}` is the shape of an enormous
number of unrelated steps, and the failure mode here is a coincidence that reads as certainty — so the
`caveat` is served **with the data** and rendered, not tucked into a doc.

Duplication *within* one flow is deliberately not reported: it is a real smell and a different one, and
counting it the same way would put it at the top of a list titled "candidates to become tools".

## What was built

| | |
| :--- | :--- |
| `services/flow-portability.service.ts` | export / `planImport` / `importFlow`. The bundle schema, and the allowlists. |
| `services/flow-replay.service.ts` | `replayPlan` / `replay` / `downstreamOf`. Every obstacle computed in one place, so the plan and the enforcement cannot disagree. |
| `services/flow-template.service.ts` + `repositories/flow-template.repo.ts` | the library. Thin over portability on purpose. |
| `services/fragment-promotion.service.ts` | the graduation loop. |
| `manifestBuilderService.refInterfaces()` | D-25 — the portable call signature, deliberately not the fingerprint. |
| `executionTokenService.hasLiveToken()` | a liveness boolean. There is no variant that returns the token. |
| `config.kestra.retentionDays` | read from the same variable the retention flow uses, because replay's refusal quotes it. |
| `flow_templates`, `flow_executions.replay_of_id` / `replay_from_step` | migration `0015`. |
| `routes/flow-templates.ts`, `+ /flows/:id/export`, `/flows/import{,/plan}`, `/flow-executions/:id/replay` | |
| `components/flow/{ReplayControl,SharePanel,FlowLibrary}.tsx` | |
| `kestra/{alt-screening.queries,hr-screening-portable.model,phase6-verify}.ts` | |

**`GET /fragment-candidates` is mounted separately, not on `flowsRouter`.** `GET /promotion-candidates`
there would be shadowed by `GET /:flowId` — a collision that presents as "the endpoint 404s for a valid
workspace".

`POST /flow-executions/:id/replay` **revises a Phase 2 comment** that said this router has no write verb
because replaying "belongs with the flow". A replay's subject is an execution: its authorisation question
is the one `get()` already answers, and an execution may have no flow at all (`flow_id` is nullable —
Phase 1's hand-written flows still produce real history). The sentence was updated rather than deleted.

## Regression net

```
typecheck      3 projects clean        vitest         268 tests / 15 files
kestra:check   13/13                  kestra:verify  all
kestra:prove   3 of 3 at 2026-06 AND 2026-05
kestra:phase3  all, at both periods    kestra:phase4  all green
kestra:phase6  all green at 2026-06 AND 2026-05
demo:verify    exit 0 — 186 rollups agree with 4019 daily rows
demo:rehearse  28/28
```

227 → 268 tests: 41 added (`flow-portability` 22, `flow-replay` 8, `fragment-promotion` 11).

**All three suites were falsified before being trusted.** Injecting a `code` field into the bundle
schema failed 3 of 22; adding fuzzy ref-matching plus a fingerprint comparison failed 6 of 22; scanning
all revisions, counting occurrences instead of distinct flows and including descriptions in the shape
key failed 4 of 11. A suite that has never been made to fail is a suite of unknown value.

## What Phase 6 does NOT establish

**Whether a real model produces the fragment from the travelled contract.** `kestra:phase6` scripts the
`InferenceClient` by default, and that is stated in its own output rather than buried: with a script,
*"the fragment refitted"* is not being proven — the script wrote it. What IS proven deterministically is
that the code did not travel, the contract did, refs were revalidated, generation ran before deploy, and
the same recipe scores differently against two tenants' queries. `--live` routes generation through
Tether and additionally exercises the real thing; it has **not** been run as part of the net, for the
same reason Phase 4's assertion-32 half has not.

**Import cannot check units, columns or semantics.** Stated above, measured by the control, and it is a
property of the design rather than a gap to close: the only thing that closes it is the importing
tenant's oracle. Both arms of the exit criterion import with zero findings.

**A hand-written `code` step cannot travel at all.** It has no contract, so the importing tenant would
have nothing to regenerate it from, and `flowCompiler` rejects the placeholder — the flow would import
to a permanently dead step. Export refuses it with a 409 naming the fix. Correct, and a real
restriction.

**No UI for authoring a flow from a goal** — unchanged from Phase 4, and unchanged by this phase.
`POST …/flows/generate` is still API-only. Phase 6 adds import, templates and replay to the UI; it does
not add generation.

## Work log

**2026-07-29.** All five tasks, in one pass, against the running stack.

Started from the pinned §5.2 table and hit the D-24 question immediately: §5.2 says strip the code and
does not say what replaces it, and "nothing" makes an imported flow permanently un-runnable. Following
that through showed §5.2's *stated reason* for stripping is false after Phase 4 — a fragment never sees
a schema — while the conclusion survives for a better reason, and that reframing is what produced the
negative control. Schema coupling moved into the named query and the contract, so the honest way to test
an import is to vary the query and hold everything else fixed.

D-25 came out of the first import attempt: comparing `refFingerprints` reported "every ref changed" for
two correctly-configured workspaces, because a query's SQL is *in* the fingerprint by D-17's design and
is exactly what must differ across tenants. Two concepts, one data source; the docblock on each names
the other.

6.1 was the largest surprise. Reading the resume path before writing the feature found I-18, and
measuring what a replay actually does found that `begin` never executes — which is where D-26's two
modes came from. Two attempts to *assert* that fact were wrong for instructive reasons (I-19), and the
second would have passed vacuously if written with the comparison the other way round.

Three false starts in the harness, all found by running it rather than reading it: a partial replay of a
**successful** run is refused (correct — `complete` burns the credential), a contrived
`flow_executions` row for the agent test hit the unique constraint and would have exercised the "no
model" branch anyway, and `Math.max(...[])` at `2026-05` (I-20).
