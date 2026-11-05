# Phase 4 — Code and agent steps

**Status:** 🟢 ALL TASKS DONE — runtime, generation and the deletions. **One claim is unmeasured; see "What is proven and what is not" below.**
**Implements:** [08 §10 "Phase 4"](../08-scale-and-phasing.md) · [02 R9](../02-rules.md) · [04 §5.3–5.3.2](../04-generation-model.md) · [05 §6.2](../05-lifecycle-and-flows.md) · [06](../06-failure-triage.md)

This is where per-step generation actually lands, and where R9 stops being a claim.

## Hard dependency from another repo

**Tether boot reconciliation must be done before this phase can be trusted.**
`agent-backend/server.js:1500` keeps `activeRuns` in memory with no boot reconciliation; a Tether
restart leaves a run at `status:"running"` forever and the agent-step poller would poll it forever.
Tracked out of scope in [phase-0.md](phase-0.md); it becomes blocking here.

## Tasks

| # | Task | Status |
| :--- | :--- | :--- |
| 4.1 | **O2 — pin the `code` step base image.** One image across all fragments; a bump is a deliberate versioned change. | ✅ `foundry/fragment-base:py3.12-pandas2.2.3`, digest-pinned base |
| 4.2 | `services/step-contract.service.ts` — declare/enforce input+output shape; generate the per-fragment prompt **from the contract alone**; assert conformance after execution | ✅ 28 tests |
| 4.3 | **The `insufficient_contract` refusal** ([06 §6.7](../06-failure-triage.md)) — see below. Highest-value single item in this phase. | ✅ both channels, parser refuses a status-less response |
| 4.4 | `POST /api/steps/code` — emitted as `io.kestra.plugin.scripts.python.Script`, **Docker task runner, never `Process`** | ✅ **no such route** — see below |
| 4.5 | `POST /api/steps/agent` — Tether + Kestra `Pause`/resume (M2) | ✅ verified live |
| 4.6 | Agent-run poller modelled on the old `pollRun`, **including its boot re-attach** — else a Foundry restart pauses a Kestra execution forever | ✅ `reattachAll()`, wired in `index.ts` |
| 4.7 | `flow_step_runs.tether_run_id` **unique index** — the only join key between Foundry and Tether | ✅ already present since Phase 0; now actually used |
| 4.8 | `services/failure-triage.service.ts` — the [06 §6.9](../06-failure-triage.md) classification table + routing | ✅ 18 tests |
| 4.9 | `flow_step_runs.failure_class`, `triage_route`, `attempt` | ✅ migration `0012` (+ `resume_task_id`, `resumed_at`) |
| 4.10 | Rewrite `script-generation.service.ts` → flow drafting + per-fragment generation. **Preserve `TASK`-last prompt order.** | ✅ `flow-generation.service.ts` + `inference.service.ts` + `flow-expression.service.ts`; 22 tests, falsified |
| 4.11 | **Deletions** — see below | ✅ 9 server modules, 4 tables, 3 client pages, 1 WS channel |
| 4.12 | **V1** — can network be disabled on Kestra's Docker task runner? | ✅ **YES, at the task level. Measured.** |

### 4.4 has no route, and that is the answer rather than an omission

The task list says `POST /api/steps/code`. There is no such endpoint and there must not be: a `code`
step needs **no tenant credential**, so under R2's credential test it runs **in Kestra** and never
calls back into Foundry. Adding the route would mean shipping the fragment's data to Foundry and back
for no reason, and it would put a fragment's payload on a path that carries execution tokens.

What exists instead is the compiler emitting a `scripts.python.Script` task directly. `routes/steps.ts`
gained `/agent` only — and `agent` is there not because it needs a credential in the `tool` sense but
because **Tether is unreachable from Kestra's network and must stay that way**.

## V1 — settle it here, do not let it slide

> Can network be disabled on Kestra's Docker task runner **at the task level**?

[09](../09-risks-and-verification.md) is explicit that the fallback is **not** "run fragments in
Foundry's runner" — it is to enforce isolation at the **Docker network level**: attach the runner to
an internal-only bridge with no egress.

> Task-level config is preferred; Docker-network level is an acceptable equivalent;
> **nothing is not acceptable.**

If neither works, R9 weakens from "cannot reach the network" to "should not", and that is a real
security delta, not a documentation nit. Settle it with a test that asserts a fragment's outbound
socket **fails**.

## The `insufficient_contract` refusal

The worst measured failure was a fragment that hardcoded `period="2023-10"` and emailed 0 of 11. It
hardcoded a date **because it needed a period, the period was not in its inputs, and it had no way to
say so.** One output channel plus an unsatisfiable contract equals an invented value.

So give it a second channel:

```json
{ "status": "insufficient_contract",
  "missing": ["period"],
  "reason": "cannot compute a monthly window; no date field in declared input" }
```

A refusal is a **first-class successful response**, not an error. It surfaces at *generation* time,
before anything executes, and it names the fix. **Any fragment prompt that offers only "produce code"
is misconfigured** — that is exactly the condition under which a model invents a value.

A refusal triggers a **flow-level redraft** (triage level 0), not a fragment regeneration.

## Deletions (4.11) — [07 §7.0.1](../07-refactor-inventory.md)

No backward compatibility is owed; nothing is in production. Delete, do not branch — dual-mode code
is the only thing that would keep the old failure modes alive.

| Delete | Replaced by |
| :--- | :--- |
| `services/execution.service.ts` | Kestra's Docker task runner |
| `services/generation-audit.service.ts` + its ~18 tests | Structural manifest compliance + R9 |
| `routes/scripts.ts` | `routes/flows.ts` |
| Monolithic path in `script-generation.service.ts` | Fragment generation from step contracts |
| `requirements.txt` generation | One pinned base image |
| Tables `scripts`, `script_versions`, `execution_results`, `test_results` | `flows`, `flow_revisions`, `flow_executions`, `flow_step_runs` |

**Kept deliberately:** the HR demo dataset, `hr_demo_alt`, `/api/demo/oracle`, `stub_*` tables,
`stub_call_log`. That is the regression net, not legacy.

`generation-audit.service.ts` is deletable **only because** `datasource` steps use named queries
rather than generated SQL. If a generated-SQL `query` step kind is ever introduced, resurrect the
audit for that kind alone — and keep its `attempted_write` negative tests, which exist because
ordinary prose (`"Rows to insert into the spreadsheet"`) otherwise matches.

## Exit criterion

Kill Foundry mid-agent-step, restart, and the Kestra execution still resumes.

## Verification

18 (three `code` steps → **three separate inference calls**, no fragment's prompt containing the
automation goal, the manifest, or a sibling step), 19 (regenerate B → **A and C byte-identical**),
20, 21, 22, 23 (Docker runner never `Process` — a compiler test), 24, 29, 30, 31, and 32–36 from
[06 §6.13](../06-failure-triage.md) — 32 being the direct regression test for the hardcoded-date
failure.

## Work log

### 2026-07-29 — the runtime half. V1 answered YES.

`pnpm --filter @foundry/server kestra:phase4` — **26 live assertions, all green.**

```
20  a fragment runs against its contract     2 flagged, contract_ok, threshold from the INPUT
21/24  V1 — the fragment CANNOT reach out    server:4000 gaierror · 1.1.1.1:53 OSError
                                             169.254.169.254 OSError · postgres:5432 gaierror
    CONTROL (networkMode: bridge)            public_dns CONNECTED
22  no credential enters the container       0 leaking values · 12 env vars, all from the image
W   a bad fragment fails AT its own step     contract_violation "missing declared field(s): count"
26  flow_step_runs duplicates nothing        a code step writes no Foundry row at all
M2  the agent step pauses and resumes        PAUSED → re-attach found it → resume → SUCCESS
```

**V1 is answered, and at the level the design preferred.** `networkMode` is a task-level property of
Kestra's Docker runner, so R9 moves from *"a fragment should not reach the network"* to *"a fragment
cannot"*. The positive control is the part that makes the claim worth anything: the same probe on
`networkMode: bridge` connects, so the four failures are the network mode and not a broken probe, a
missing image or a typo in a hostname.

The whole boundary, measured rather than argued:

| | |
| :--- | :--- |
| Network | none. No interfaces at all, so DNS fails before a socket is attempted. |
| Credentials | none. 12 env vars, every one from `python:3.12-slim` or the script plugin. |
| Volumes | none. The runner's `volume-enabled` is false by default, so a task cannot mount a host path even if a model asked. |
| Lifetime | ephemeral, `delete: true`. |
| Registry | `pullPolicy: NEVER` — a pull is the one thing that would reach out, and O2 exists to stop the tag drifting anyway. |

**The fragment container runs as root, and that is forced.** A non-root user was tried and every
fragment died with `[Errno 13] Permission denied`: Kestra stages the script with the JVM's
`Files.createTempFile` (mode 600, owned by root) and copies it in with ownership preserved. Nothing on
our side of the boundary can widen it. The residual exposure is a container escape from a
network-less throwaway container — real, and not larger than what this phase removes, since
`execution.service.ts` gave the same daemon the same access per generated script.

**One issue, and it cost an hour by pointing at the wrong subsystem: [I-15].** The first `code` step
failed with `EACCES` on a script Kestra had just written, which reads as a uid problem — and removing
the non-root user made it pass, *confirming the wrong diagnosis*. The real cause was path identity:
a `code` step's container is a **sibling** on the host daemon, `/tmp/kestra-wd` was a named volume
that exists nowhere on the host, and Docker's response to a missing bind source is to create it **as
a directory**. `python <a directory>` reports `EACCES`, not `EISDIR`. Snap Docker made it worse
twice over — its daemon has a private `/tmp`, so Kestra's own DinD instructions silently bind the
wrong directory, and it remaps `$HOME`, so comparing the two path strings would not have caught it
either. `pnpm kestra:check` now asserts it **by round trip**: Kestra writes a marker, a sibling
container must read it back.

**One bug in my own emitter, caught by running it: the agent step's body was invalid JSON.**
`promptExpr` is free text and I interpolated it raw, producing `"prompt": Reply with the single
word: acknowledged.`. This is [I-11] wearing a different hat — *never interpolate a rendered string
into a JSON body* — and it is now stated on the field itself, because a field called `promptExpr`
sitting beside a prompt-shaped string is an invitation to do it again.

**One design question settled by hitting it: how does a fragment receive its input?** §5.3.2 asks
for stdin, and Kestra's script tasks have no stdin. Pinned in [D-19]: `inputFiles["input.json"]` in,
the output marker out, and — the part that matters more — the fragment is a **function body**, not a
program. A fixed compiler-emitted wrapper owns every byte of I/O, checks the declared output keys
before the value crosses back, and enforces the size cap. So a fragment cannot pick an output
channel, cannot half-write one, and cannot declare its own contract satisfied. [D-20] pins the size
cap as a named failure rather than adding the second channel §5.3.2 also asks for.

**M2 works end to end.** An `agent` step compiles to `<id>` (start the Tether run, return in
milliseconds) plus `<id>_await` (`core.flow.Pause`). The execution reached `PAUSED`, `reattachAll()`
rebuilt the watch list **from a query over `flow_step_runs`** rather than from anything in memory,
and a resume with `onResume` inputs carried the answer back into the flow. That query —
`tether_run_id IS NOT NULL AND resumed_at IS NULL` — is I-14's lesson applied before it could bite a
second time. See [D-21], including why `onResume` must be posted as multipart: Kestra accepts a JSON
body with a 2xx and silently drops the inputs.

### What is NOT done, and what that means

**4.10 (per-fragment generation) and 4.11 (the deletions) are not started.** Everything a generated
fragment needs in order to run, be judged and be triaged exists and is verified; **nothing generates
one yet.** Concretely:

- `buildFragmentPrompt` is tested for what it contains and excludes, but **no code calls an LLM with
  it.** Assertions 18 and 19 — *three code steps produce three separate inference calls*, and
  *regenerating B leaves A and C byte-identical* — are therefore **unproven**. What is proven is the
  weaker precondition that makes them possible: sibling prompts share a byte-identical prefix and
  differ only in their final `TASK` block.
- Assertion 32 is half-proven. A generator **can** refuse, the refusal parses, and it routes to a
  flow redraft (level 0). Whether the model actually refuses instead of inventing a value is a
  measurement that needs 4.10.
- `execution.service.ts`, `generation-audit.service.ts`, `routes/scripts.ts` and the `scripts` /
  `script_versions` / `execution_results` / `test_results` tables are all still present. They are on
  the deletion list and **still should not be invested in**.

**The exit criterion is met in mechanism, not yet in a full round trip.** "Kill Foundry
mid-agent-step, restart, the Kestra execution still resumes" is demonstrated by the pause surviving
in Kestra's database and `reattachAll()` finding it by query. What has not been done is killing the
process mid-run against a *real* multi-minute agent run — the verification resumes by hand, because
a real round trip would make the script unusable as a gate.

**Tether's boot reconciliation is still missing** (`agent-backend/server.js:1500`) and is still
tracked in that repo. Its consequence here is bounded rather than fixed: `AGENT_RUN_DEADLINE_MS`
resumes the execution with a failure, so an orphaned Tether run costs one execution rather than an
M3 budget slot held until a human notices.

### 2026-07-29 (later) — 4.10 and 4.11. The phase's tasks are all done.

#### 4.10 — generation is now two stages with deliberately different visibility

```
draftFlow()          ONE call.  goal + manifest + callable catalogue → a flow of
                                DECLARED steps, and for each `code` step a
                                CONTRACT rather than code.
generateFragments()  ONE call PER code step.  Each sees its own contract and
                                nothing else.
```

**Most steps are never generated.** A `tool` step is a named tool and its params; a `datasource`
step is a named query whose SQL is already written and reviewed. The five-step reference flow costs
**three** inference calls, and the two steps that touch a credential contain no generated code at
all. That is the migration's claim expressed as a number rather than as a paragraph.

**`POST /api/workspaces/:ws/flows/generate`** is the route that replaced `POST /api/scripts`. Its
`insufficient_contract` arm returns **200**, not 4xx — a fragment naming the input it is missing is
the single most useful thing this system produces, and filing it under "error" is how a client ends
up rendering it as a failure and retrying it. `POST …/flows/:id/steps/:stepId/regenerate` is triage
level 1 as a route: one fragment, one new revision.

**Three things were found while building it, and each changed the design:**

- **Tether has no completion endpoint** — `POST /api/run` is an agent run and that is the only
  inference surface there is. That forced `InferenceClient` into existence, and the seam turned out
  to be what makes assertions 18 and 19 checkable at all (D-23). It also forced the question of
  session reuse, where Foundry's standing rule is exactly wrong.
- **The drafter authors expressions, so D-16's precondition was false** — and had been false since
  Phase 3, because `POST /flows` already accepted a client-supplied model. `flow-expression.service.ts`
  is the allowlist that closes it, in `writeRevision` so no route can forget it (D-22).
- **`outputKeys` must be DERIVED from the contract, not accepted from the drafter.** Accepting both
  lets a draft declare one contract and enforce another, and the mismatch surfaces as a
  `contract_violation` blaming the fragment for obeying the contract it was handed.

#### 4.11 — deleted, not disabled

| Gone | Replaced by |
| :--- | :--- |
| `services/script-generation.service.ts` (975 lines) | `flow-generation.service.ts` |
| `services/execution.service.ts` | Kestra's Docker task runner |
| `services/generation-audit.service.ts` + its tests | Structural manifest compliance + R9 |
| `services/generation-events.ts`, `/ws/generation` | — (see below) |
| `routes/scripts.ts`, its three repositories | `routes/flows.ts` |
| Tables `scripts`, `script_versions`, `execution_results`, `test_results` | `flows`, `flow_revisions`, `flow_executions`, `flow_step_runs` |
| The script branch of `trigger.service.ts` | Flow-bound triggers only |
| `app/(app)/automations/**` (1,232 lines) + the script half of `lib/api.ts` | `/flows` |

**`/ws/generation` deserves naming separately.** It streamed a generation's stage events and it was
authorised by **nothing** — `?scriptId=<uuid>` and you were subscribed. That is precisely the shape
D-15 refuses for flow progress: knowing an id is not the same as being allowed to watch it. It was
never made safe; it survived until the thing it streamed was deleted.

**Migration `0014` had to be hand-edited.** drizzle-kit emitted the four `DROP TABLE … CASCADE`
statements *before* the dependent `ALTER TABLE … DROP CONSTRAINT` ones. CASCADE has already removed
those constraints by then, so every follow-up fails `constraint … does not exist` and the migration
dies **half-applied** — tables gone, `triggers.script_id` still there. Dependants are now detached
first and every drop is `IF EXISTS`, so a partial run is repeatable.

**Two test files were rewritten rather than deleted, and that was the whole judgement call in 4.11.**

- `trigger-gate.test.ts` — its subject (`scripts`, `execution_results`) is gone, but every property
  it asserted is still a property of the product and each exists because it was once wrong:
  `enabled` defaults false, one *succeeded* run is required, a FAILED run is not a run, disabling is
  always allowed. Now asserted against flows, plus one new case: gate 2 is reported **alongside**
  gate 1, never folded into it.
- `swap-rehearsal.test.ts` **P2** — "no generated artifact carries a dataset-specific literal". The
  old block iterated `scripts`; leaving it would have gone on passing over an empty table, which is
  the most expensive kind of green. Re-asked of the fragment, the answer is **structural**: there is
  no DSN to embed because `psycopg2` is not importable and the container has no network; no invented
  host because there is no HTTP client and a flow model contains no URL at all.

  Writing it found a real defect **in the new test**: `ALT_SCHEMA` is the two characters `"hr"`, and
  `expect(prompt).not.toContain(ALT_SCHEMA)` matched inside the word **"threshold"** in its own
  fixture. A needle that short is a coin flip, not an assertion. Now schema-qualified — `hr.staff` —
  which is also the form a real leak would take.

#### Full regression net, after the deletions

```
typecheck          3 projects clean          vitest        227 tests / 12 files
kestra:check       13/13                     kestra:verify all
kestra:prove       3 of 3 at 2026-06 AND 2026-05
kestra:phase3      all, at both periods      kestra:phase4 all green (M2 re-attach included)
demo:verify        exit 0 — 186 rollups agree with 4019 daily rows
```

Test count went 246 → 227: 18 `generation-audit` tests were deleted with the service, 11 trigger-gate
tests were rewritten to 12, and 22 generation tests were added.

## What is proven and what is not

**Proven.** That three `code` steps produce three separate inference calls, that no fragment's prompt
contains the goal / manifest / a sibling / a tool name, that regenerating one fragment leaves the
others byte-identical, that a refusal is returned after **one** call and routed to a flow redraft,
and that the expression allowlist rejects `secret()` — and rejects `fileURI`, a name that appears
nowhere else in this codebase, which is the point of an allowlist.

These were **falsified before being trusted**: injecting a sibling's contract into the fragment
prompt failed 10 of the 22 tests. A test suite that has never been made to fail is a suite of
unknown value.

**Not proven, and it is the phase's headline caveat.** *Does a real model refuse rather than invent?*
Assertion 32's other half needs a live generation against a deliberately insufficient contract,
scored by the oracle, and **that has not been run.** Everything around it exists — the second
channel, the parser that refuses a status-less response, the triage route — but the measured
"1 of 3 → n of 3" comparison for *generated* fragments does not yet exist. Phase 1's 3-of-3 was
hand-written flows with zero `code` steps, and that caveat still travels with the number.

**A capability gap, stated plainly.** There is **no UI for typing a goal and getting a flow.** The
automations wizard was deleted and `POST …/flows/generate` is reachable only by an API client. That
is a real regression in reach, chosen over leaving 1,232 lines of page whose every call is wrapped
in `faFallback` — a 404 from a deleted route falls through to the browser's local mock store, and
the page renders fabricated automations indistinguishable from real ones. For a product whose thesis
is that a silent wrong answer is the expensive failure, that was not a option.
