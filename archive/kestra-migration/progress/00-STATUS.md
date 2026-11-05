# Kestra migration — master status

> **This file is the entry point for resuming the migration.** Read it first, then the phase file
> for whatever is `IN PROGRESS`.
>
> Branch: **`kestra-migration`** (forked from `working_foundry_app` @ `d33825e`).
> Design docs: [`../README.md`](../README.md) and files 01–10 — **those are pinned and are not
> edited by implementation work.** Everything implementation-side lives in this `progress/` folder.

## How this folder is organised

| File | What it holds |
| :--- | :--- |
| `00-STATUS.md` | This file — phase table, current position, resumption instructions |
| `ISSUES.md` | **Every issue hit and the mitigation applied.** Append-only, numbered `I-nn`. |
| `DECISIONS.md` | Implementation decisions that deviate from or refine the pinned design |
| `phase-0.md` … `phase-6.md` | One per phase: task checklist, exit criterion, work log |

⚠ **Two sibling programme records were DELETED on 2026-08-04**, deliberately, as superseded by the
implementation: `docs/away-from-demo-mode/VERIFICATION.md` and `docs/canvas-and-sandbox/VERIFICATION.md`.
What they held lives on here: the second programme in `DECISIONS.md` **D-30…D-45** / `ISSUES.md`
**I-24…I-41**, the third in **D-46…D-59** / **I-42…I-60**. Recovering either file is
`git show bc72cc4:<path>`.

**Every reference to them as a FILE has been repointed** — thirteen source docblocks and
[`phase-5.md`](phase-5.md) now name the `DECISIONS.md` / `ISSUES.md` entries instead. ⚠ **What
survives, and must, is the programme NAMES**: `**Stage:** away-from-demo-mode 6b` in `ISSUES.md`,
`| **Stage** | away-from-demo-mode 9.2 |` in `DECISIONS.md`, *"deleted in away-from-demo-mode Stage 1"*
in a comment. Those are not stale paths. With the two directories gone, the stage label on an entry is
the **only** remaining index of which work belonged to which programme, and rewriting them to match a
deleted directory would destroy it.

**Granularity note:** progress files are per **phase**, not per design doc. The design docs 01–10 are
organised by *topic* (rules, architecture, generation model); the work is organised by *phase*
([08 §10](../08-scale-and-phasing.md)). Each phase file names the design sections it implements, so
a `§` reference still resolves in both directions.

## Phase table

| Phase | File | Scope | Status |
| :--- | :--- | :--- | :--- |
| **0** | [phase-0.md](phase-0.md) | Prerequisites — `tenant_budgets`, no Kestra yet | ✅ DONE |
| **1** | [phase-1.md](phase-1.md) | **Prove the loop** — Kestra up, step API, hand-written flows, beat the oracle | ✅ DONE — **3 of 3 scenarios** at three periods |
| **2** | [phase-2.md](phase-2.md) | Visibility — `StepGraph`, `StepDetail`, repoint history/dashboard | ✅ DONE — exit criterion met; 2.5 landed in Phase 3 as `/flows/[id]` |
| **3** | [phase-3.md](phase-3.md) | Triggers, approval, two-namespace lifecycle | ✅ DONE — exit criterion met, **39 assertions** at two periods |
| **4** | [phase-4.md](phase-4.md) | `code` + `agent` steps; per-step generation; V1; the deletions | ✅ **ALL TASKS DONE** — **26 live assertions**; the monolithic path is deleted. One claim unmeasured — see below |
| **5** | [phase-5.md](phase-5.md) | Client authoring — **deferred, not in v1** | ⏸ DEFERRED |
| **6** | [phase-6.md](phase-6.md) | Replay, sharing, export/import | ✅ **ALL TASKS DONE** — exit criterion met **with a negative control**, at two periods |

Status values: ⬜ NOT STARTED · 🟡 IN PROGRESS · ✅ DONE · ⏸ DEFERRED · ❌ BLOCKED

## Current position

**Phases 0–4 and 6 are CLOSED. Phase 5 is deliberately deferred and is the only thing left.**
Read [phase-5.md](phase-5.md) — it says *"do not build this yet"* and names the condition for
un-deferring it (roughly ten flows authored on clients' behalf, so the recurring step vocabulary is
known). Nothing is in progress.

**Deployment prep is done (2026-07-30).** The stack now builds and runs on one contiguous port block,
the API server no longer holds the host Docker socket, and the fragment base image is built by the
stack rather than by a comment. See *Deployment prep* below, `DECISIONS.md` D-28/D-29 and
`ISSUES.md` I-21.

**A UI-path journey test exists and is the newest source of findings.** `pnpm --filter @foundry/server
e2e:ui` drives every call the client makes to author, dry-run and production-run a flow, restricted to
the HTTP surface `packages/client` uses, and writes [`e2e-ui-journey.md`](e2e-ui-journey.md) with
**intended behaviour beside real behaviour** per step. It found I-22 and I-23 on its first two runs.

**Both of the previously-unmeasured claims are now MEASURED (2026-07-31), and one of them was broken.**

*Does a real model refuse rather than invent?* — `pnpm --filter @foundry/server kestra:refusal`.
**5 refused, 0 invented**, against a control contract that produced clean code 5 of 5 (without which
"refuses everything" scores 100%). But the first measurement, through Tether, saw **0 refusals and 5
unparseable responses**: the model was refusing every time and the `script-gen` protocol's extra turns
meant `finalMessage` never carried the JSON. Read **I-24** before quoting the number — the mechanism
was correct at every layer that had a test and was defeated by the transport underneath them.

*Does a real model produce a fragment from a travelled contract?* — `kestra:phase6 --live`, **69/69**.

⚠ Both are readings, not properties of the design: a handful of rounds, one model, one contract shape.
Re-run them when the model, the prompt or the contract changes.

### Phase 1 is CLOSED. The gate PASSED: 3 of 3 scenarios, scored, at three periods (2026-07-29).

```
A  screening   fan-out    11 flagged → 10 mailed + 1 unmailable + 1 bounce
B  escalation  fan-IN     11 flagged → 10 tickets   (fan-in is the point: M < N)
C  roll-up     aggregate  7 departments → 1 message, the empty one present as null

3 of 3 at 2026-04 · 2026-05 · 2026-06
```

Each scenario is a different **shape** aimed at a different measured failure mode, and each is scored
against an oracle written independently of the flow **and** against the `stub_*` side-effect tables —
so a flow cannot grade its own homework. See [DECISIONS.md](DECISIONS.md) D-08.

**Read before quoting the number.** [ISSUES.md](ISSUES.md) **I-08**: the original three prompts are
unrecoverable, so "3 of 3 vs 1 of 3" is **not like-for-like**. And all three flows are hand-written
with zero `code` steps — per-step *generation* is Phase 4's claim, not this one. See
[phase-1.md](phase-1.md) "What this still does NOT establish".

**Five issues found here, four of them only because the first green run was not treated as the answer.**
**I-07** is the one to know: `begin` trusted the namespace in the request body, so a flow in one
workspace could claim another and receive its execution token. The obvious version of that test passed.

Regression net, all green:

```bash
pnpm test                 # 268 passed
pnpm demo:verify          # exit 0
pnpm demo:rehearse        # 28 / 28
pnpm kestra:check         # 15 / 15 boundary assertions — run after ANY infra change
pnpm kestra:ui            # UI url + credentials (internal engineers only)
pnpm --filter @foundry/server kestra:prove    # deploy 3 flows, execute, score vs oracle
pnpm --filter @foundry/server kestra:verify   # assertions 6, 7, 28, V2, O4
pnpm --filter @foundry/server kestra:phase3   # assertions 10, 11, 12, 13, 25 + the compiler's oracle
pnpm --filter @foundry/server kestra:phase4   # assertions 20, 21, 22, 24 (V1), 26 + M2 pause/resume
pnpm --filter @foundry/server kestra:phase6   # replay + export/import, 69 assertions, WITH a negative control
pnpm --filter @foundry/server kestra:system   # deploy foundry.system/retention (O4)
pnpm --filter @foundry/server e2e:ui          # the UI's journey over HTTP → e2e-ui-journey.md
pnpm --filter @foundry/server kestra:hitl     # gate 3: pause, approve, reject-kills
pnpm --filter @foundry/server kestra:retry    # runtime retry, 22 assertions, with the no-retry control
pnpm --filter @foundry/server kestra:refusal  # does a real model refuse rather than invent? (measurement)
pnpm --filter @foundry/server showcase:seed   # the six clickable flows
pnpm --filter @foundry/server showcase:verify # every showcase description, checked against the engine
```

`e2e:ui` is the one that does **not** gate on its own findings. MISMATCH and GAP are its output, not a
failure; only a hard FAIL (unreachable API, 5xx, a run that never settles) exits non-zero. Run it at
more than one period like the others — `--period=2026-05` is the empty case, where the oracle expects
0 mailed and the run must still succeed.

## Phase 2 — the exit criterion is MET (2026-07-29)

A deliberately broken step was deployed, run, and diagnosed **from the Foundry API alone** — no
`kestra-ui`, no `stub_call_log`:

```
notify   FAILED  96ms  http=502  POST /api/steps/tool
   tool "mail_send": all 1 call(s) failed
   → HTTP 422 "invalid recipient address(es)" ["not-an-email"]
never_runs — declared in the graph, absent from the run
```

Built: `services/flow-visibility.service.ts` (the read model), `routes/flow-executions.ts`,
`utils/redact.ts` + 7 tests, `components/flow/{StepGraph,StepDetail}.tsx`, `app/(app)/runs/[id]`, and
the `types → adapters → api → foundry-client` seam. History is re-pointed and became step-aware
**without its rendering changing at all** — `Run.steps` had always existed and had always held one
synthetic entry.

Two rules that came out of it, both easy to undo by accident:

- **[D-13] read `engineStatus`, never Foundry's `status`.** They legitimately disagree: Foundry's is
  written by the flow's own `complete` task, so a failed run stays `running` for ever (I-10).
- **[D-07] redaction is server-side and must stay there.** Doing it in the browser would be theatre —
  the token would already have crossed the wire. Do not add a "show raw output" path.

### Phase 2 is now CLOSED (2026-07-29, second pass)

2.6, 2.7 and 2.8 are done. Two of them were more than the plan implied:

- **2.6 was a wrong number, not an unverified one.** `Run.outcome` had no value for "still running",
  so every in-flight run was reported as **stopped** — counted as a failure in the success rate, drawn
  red in the trend, offered *Fix & retry* in History. Hidden today because Phase 1 flows finish in ~1s;
  permanent from Phase 4. Rates now divide by **settled** runs (**D-14**). The simulated "running now"
  strip (`lib/runstream.ts`) is gated on the rows actually being mock — fabricated live runs beside
  real aggregates is worse than either.
- **2.8's design question was authorisation, not transport.** The browser never holds
  `PARENT_API_KEY` (a same-origin Next route injects it) and a WebSocket cannot use that proxy, so an
  id-only socket would have been the only unauthenticated read path in the product. Watching is now a
  handshake: an authenticated `POST …/:id/watch` mints a single-use 60s ticket bound to one
  (workspace, execution) (**D-15**). One poll per execution serves every watcher; **polling survives as
  the fallback**, and both paths read the same server-side assembly.
- **2.7** — the ladder markup is shared (`components/ui/Strip.tsx`) and step ordering moved to
  `lib/flow-graph.ts`, so the strip cannot disagree with the graph beside it.

Verified against the live stack, not just in unit tests: unauthenticated and forged tickets get 1008
with no data, a slowed flow streamed `snapshot → 9 step diffs → execution → end`, ticket replay was
refused, a cross-workspace mint 404'd, and `begin`'s body arrived `[redacted]` — D-07 holds on the new
channel too.

**One bug found, and only because 2.8 needed a live row: [I-12].** Every row from
`GET …/flow-executions` had `engineStatus: null`. Kestra's execution search defaults to **oldest
first**, so the join was against the oldest 50 of 60 executions — no overlap with the page being
rendered. It worked on a fresh instance and broke silently once the instance outgrew the page size;
the empty catch that made it survivable also made it invisible, and now logs.

## Phase 3 is CLOSED (2026-07-29)

**The exit criterion is met and measured**, not asserted: `pnpm --filter @foundry/server kestra:phase3`
drives the real services against the running engine and reads the answers back out of Kestra. 39
assertions, green at `2026-06` and `2026-05`.

```
a new schedule cannot fire until approved   live namespace EMPTY before approval,
                                            Schedule trigger present after, cron 0 6 * * 1
editing an armed flow changes nothing live  live YAML byte-identical after the edit,
                                            while the DRAFT namespace changed
a tool changes shape → suspended            the sweep removes the trigger; a manual live
                                            start then FAILS at begin with no row written
revoke → the trigger is REMOVED             triggers: [] — never `disabled: true`
```

**The compiler arrived a phase early, and that was forced** ([DECISIONS.md](DECISIONS.md) **D-16**). A
Kestra Schedule trigger is part of the flow definition, so "approval deploys the trigger" means the
live and draft YAML are the same model compiled twice. Only the *emitter* moved; `flow-validator`, the
redraft loop and the caps are still Phase 5, and **`paramsExpr` is an opaque string** — read D-16
before putting a model behind a client-facing route.

**One bug found, and only by running two assertions in the right order: [I-14].** The staleness sweep
selected `WHERE status = 'armed'`, but editing an armed flow sets `status` to `draft_pending` — so its
real work list was *"armed flows nobody has edited"*, a set that empties over time and never refills.
The rule that came out of it: **a sweep must select on the fact, never on a status string that exists
for display.**

**Read before quoting the gate.** [ISSUES.md](ISSUES.md) **I-13**: Foundry has one shared
`PARENT_API_KEY` and no user model, so the approver identity is **self-asserted**. Do not describe
Phase 3 as enforcing separation of duties. The control that does hold is the **revision binding**.

## Phase 4 — the runtime half is DONE, and V1 is answered (2026-07-29)

`pnpm --filter @foundry/server kestra:phase4` — **26 assertions against the running engine, green.**

```
20  a fragment runs against its contract     2 flagged · contract_ok · threshold from the INPUT
21/24  V1 — a fragment CANNOT reach out      server:4000 gaierror · 1.1.1.1:53 OSError
                                             169.254.169.254 OSError · postgres:5432 gaierror
    CONTROL (networkMode: bridge)            public_dns CONNECTED
22  no credential enters the container       0 leaking values · 12 env vars, all from the image
26  flow_step_runs duplicates nothing        a code step writes no Foundry row at all
M2  the agent step pauses and resumes        PAUSED → re-attach by query → resume → SUCCESS
```

**V1 is YES, at the task level — the option the design preferred.** `networkMode: none` on Kestra's
Docker task runner, so R9 moves from *"a fragment should not reach the network"* to *"a fragment
cannot"*. The positive control is what makes that worth stating: the same probe on `bridge`
connects, so the four failures are the network mode and not a broken probe.

**A `code` step is a function BODY, not a program** (D-19). The generated fragment defines
`run(payload)`; a fixed compiler-emitted wrapper owns every byte of I/O, checks the declared output
keys **in the container** before the value crosses back, and enforces the size cap. A fragment
therefore cannot pick an output channel, half-write one, or declare its own contract satisfied —
and the R9 guarantees are checkable by reading one function instead of every fragment.

**One issue, and it pointed at the wrong subsystem for an hour: [I-15].** A `code` step failed with
`[Errno 13] Permission denied` on a script Kestra had just written. That reads as a uid problem, and
removing the image's non-root user made it pass — *confirming the wrong diagnosis*. The real cause
was path identity: the step's container is a **sibling** on the host daemon, `/tmp/kestra-wd` was a
named volume existing nowhere on the host, and Docker creates a missing bind source **as a
directory**. `python <a directory>` reports `EACCES`. `pnpm kestra:check` now asserts it **by round
trip** — a string comparison would have passed, because snap Docker remaps `$HOME`.

**Tether's missing boot reconciliation** (`agent-backend/server.js:1500`) is bounded rather than
fixed: `AGENT_RUN_DEADLINE_MS` resumes the execution with a failure, so an orphaned Tether run costs
one execution rather than an M3 slot held until a human notices. Still tracked in `Foundry-Harness/`.

## Phase 4 — generation and the deletions (4.10, 4.11) are DONE too (2026-07-29)

**Generation is two stages with deliberately different visibility.** `draftFlow()` makes ONE call
seeing the goal, the manifest and the callable catalogue, and returns a flow of *declared* steps —
with a CONTRACT, not code, for each `code` step. `generateFragments()` then makes **one call per
`code` step**, and each sees its contract and nothing else.

Most steps are never generated. The five-step reference flow costs **three** inference calls, and
the two steps that touch a credential contain no generated code at all — a `tool` step is a named
tool, a `datasource` step is a named query with reviewed SQL behind it.

**The monolithic path is gone, not disabled.** 9 server modules (including `script-generation`,
`execution.service` and `generation-audit`), 4 tables, 3 client pages, 1,232 lines of authoring UI,
and the `/ws/generation` socket — which was authorised by **nothing**, `?scriptId=<uuid>` and you
were subscribed, the exact unauthenticated-read shape D-15 refuses.

**Two decisions, both about things that turned out to be already broken:**

- **D-22** — the drafter authors expressions, so D-16's precondition ("safe only while models are
  Foundry-authored") is false. It had in fact been false since Phase 3: `POST /flows` accepts a
  client-supplied model, and with one shared `PARENT_API_KEY` "client" means the tenant.
  `{{ secret('FOUNDRY_CALLBACK') }}` in a `paramsExpr` posts Kestra's callback secret to a tool
  endpoint. `flow-expression.service.ts` is an **allowlist** — five roots, seven functions,
  everything else fails by name — checked in `writeRevision`, the one function every revision passes
  through.
- **D-23** — one Tether session per fragment, never a reused one. Foundry's rule is *session =
  automation, run = version*; here that is exactly wrong, because a session carries its history and
  fragment B's context would contain fragment A's code. `InferenceClient.complete()` has no
  `sessionId` parameter, so statelessness is a property of the interface rather than a discipline.

**Two issues.** [I-16] drizzle-kit emitted `DROP TABLE … CASCADE` **before** the dependants it
cascades away, which fails half-applied — tables gone, `triggers.script_id` still there.
[I-17] a two-character needle (`ALT_SCHEMA` is `"hr"`) matched inside the word "threshold" in a new
test's own fixture, producing a false positive that read as a real leak.

**Two test files were rewritten rather than deleted** — `trigger-gate.test.ts` against flows, and the
swap rehearsal's P2 block against fragments. Both had subjects that no longer exist and properties
that still matter; leaving either to iterate an empty table would have been the most expensive kind
of green.

### What Phase 4 does NOT establish

**Whether a real model refuses rather than invents.** Assertion 32's other half needs a live
generation against a deliberately insufficient contract, scored by the oracle, and **that has not
been run.** Every mechanism around it is in place and tested. The `1 of 3 → n of 3` comparison for
*generated* fragments does not yet exist, and Phase 1's 3-of-3 was hand-written flows with zero
`code` steps.

**There is no UI for typing a goal and getting a flow.** `POST …/flows/generate` is reachable only
by an API client. A real regression in reach, taken deliberately over leaving an authoring wizard
whose every call is wrapped in `faFallback` — where a 404 from a deleted route falls through to the
browser's mock store and renders fabricated automations indistinguishable from real ones.

## Phase 6 is DONE — and the negative control IS the result (2026-07-29)

`pnpm --filter @foundry/server kestra:phase6` — **69 assertions against the running engine, green at
`2026-06` and `2026-05`.**

The exit criterion is *"export a flow from HR, import into `hr_demo_alt`, regenerate its code steps, and
assert it produces the alt oracle's answer."* Proving only that would have been worthless — a harness
that cannot detect a wrong answer produces the same green as one that can. So the same bundle is
imported **twice**, against two named queries differing in exactly one `×100`:

```
NEGATIVE  the alt's native 0-1 fractions   → 0 findings, SUCCESS, shortfall 0.2  (truth 20.00)
POSITIVE  rates converted to the contract  → 0 findings, SUCCESS, shortfall 20.00
          both arms imported identically — the check could not tell them apart
```

**So an import is a STRUCTURAL check, not a correctness one.** It proves every ref exists in the
importing tenant and every call signature matches; it cannot tell whether that tenant's query returns
the same columns in the same units. Only the importing tenant's oracle can. That is the phase's finding
and its limit in one sentence.

**[D-24] the CONTRACT travels; the code does not.** §5.2 says strip the code and does not say what
replaces it — and "nothing" makes an imported flow permanently un-runnable, because `regenerateStep`
refuses a step with no contract and the compiler rejects the placeholder. Following that through also
showed §5.2's *stated reason* for stripping is false after Phase 4 (a fragment never sees a schema), while
the conclusion survives for a better one: schema coupling **moved** into the named query and the
contract, both tenant-local. That reframing is what produced the control above.

**[D-25] a ref's portable INTERFACE is not its fingerprint.** `refFingerprints` includes a query's SQL
by D-17's design, and across tenants the SQL is exactly what must differ — so comparing fingerprints at
import reported "every ref changed" for two correctly-configured workspaces. `refInterfaces()` compares
the **call signature** and nothing else.

**[D-26] replay is two operations, because a partial replay does not run `begin`.** Measured: the
replay's Foundry row holds **zero** execution credentials of its own. `begin` is the approval gate, the
credential mint and the row creation, so skipping it would bypass the gate, reuse a possibly-dead
credential, spend no budget and hang on an agent step. `full` replay is the safe default; `from a step`
has Foundry re-apply all three itself and **refuse** where it cannot. A **succeeded** run can never be
partially replayed — `complete` burns the credential — and the refusal says that rather than "expired".

**[D-27] a template is a snapshot, and instantiating one is an import** — the same path, with the same
checks. No second instantiation path, because the second path is the one that misses a check.

**Two of the three issues were bad TESTS, not bad code.** [I-19] *"did this step re-run?"* is invisible
in both obvious signals: task **state** is copied with the taskrun, and taskrun **ids** are regenerated
for the copies too — so one attempt failed misleadingly and the other would have passed vacuously if
written the other way round. The discriminator is the trace a run would have left in Foundry.
[I-20] `Math.max(...[])` is `-Infinity`, and the HR dataset flags nobody outside its reporting month —
the third time *"run it at more than one period"* has paid for itself. [I-18] is the real defect, closed
structurally: a partial replay past an `agent` step would pause for ever, so it is refused.

### What Phase 6 does NOT establish

**Whether a real model produces the fragment from the travelled contract.** `kestra:phase6` scripts the
`InferenceClient` by default and says so in its own output: with a script, *"the fragment refitted"* is
not being proven. `--live` exercises the real thing and **has not been run** as part of the net — the
same standing caveat as Phase 4's assertion-32 half.

**Import cannot check units, columns or semantics.** By design, and measured. Both arms of the exit
criterion import with zero findings.

**No UI for authoring a flow from a goal** — unchanged. Phase 6 adds import, templates and replay to the
UI; it does not add generation.

## Deployment prep — the stack builds, and three dead things are gone (2026-07-30)

Not a phase. The work between "Phase 6 is closed" and "this can be deployed", done in one pass and
recorded here because two of the four items were **live paths with no remaining caller** and the third
was a build artefact nothing built.

**Ports are one block now.** `4000` API · `4001` WS · `4002` web · `4003` mcp-bridge (was `3015`)
· `4004` ops-api (added in *away from demo mode* Stage 5). Postgres keeps its `+1` offset (`5433`)
and that is load-bearing rather than conventional: registered datasources hold an **encrypted** DSN
naming `host.docker.internal:5433`, and `demo:reset` reseeds without re-registering — so renumbering
Postgres would invalidate every stored credential with no reseed path back. Kestra still publishes
**nothing** and cannot: its only network is `internal: true`, so Docker accepts a `ports:` stanza and
silently discards it (`pnpm kestra:ui`).

⚠ **Redis and `6380` are gone as of 2026-08-03** (`docs/GAPS.md` 6.4). It was provisioned for
BullMQ-at-scale and never acquired one: `DBSIZE` 0, no `redis`/`ioredis` dependency in any
`package.json`, `config.redisUrl` read by nothing. The paragraph above used to say "Postgres and
Redis keep their `+1` offsets"; only Postgres's is a constraint. Removed rather than left, because a
healthy container is the most convincing possible evidence of a working dependency — it answered
`PING`, `depends_on` made the server wait for it, and `REDIS_URL` sat in the server's environment,
so every signal said "in use".

**The API server no longer holds `/var/run/docker.sock`, and the Docker CLI is out of its image**
(D-28). Both existed for `execution.service.ts`, which Phase 4 deleted; nothing in `packages/server`
spawns a subprocess of any kind now. Kestra is the sole holder, exactly as the Phase 4 compose note
predicted. `kestra:check` asserts the absence, because "nobody re-adds a volume mount" is not a control.

**`foundry/fragment-base` is built by the stack** (D-29, I-21). It had existed only as a `docker build`
line in a comment. The failure that justifies the entry is its shape: a fresh host came up **entirely
green** — compose healthy, `kestra:check` passing, the engine serving — and then every `code` step died
at execution with an image-not-found, after approval, mid-run. Now a one-shot compose service, so `up`
fails at deploy time, `kestra` depends on it, and `kestra:check` asserts the image is on the host daemon.

**Env files document what the code actually reads.** `KESTRA_CALLBACK_SECRET`,
`KESTRA_RETENTION_DAYS`, `KESTRA_PURGE_CRON` and `KESTRA_FRAGMENT_IMAGE` were live config keys that no
example file mentioned; `NEXT_PUBLIC_WS_URL` pointed at the deleted `/ws/generation` and is gone,
replaced by `FOUNDRY_WS_URL` + `FOUNDRY_WORKSPACE`. `KESTRA_FRAGMENT_NETWORK_MODE` is deliberately
documented as **not** a setting — it exists so `kestra:phase4` can flip it for the positive control.

**Zero changes to the Tether harness, across every phase.** `../Foundry-Harness/` has no modified
tracked file and its last commit (2026-07-25) predates Phase 0 (2026-07-28). The known Tether defect —
`activeRuns` in memory with no boot reconciliation, so a restart orphans runs at `status:"running"` —
is unchanged and remains its own item in that repo, not coupled to this migration.

---

## The UI-path journey test (2026-07-30)

`pnpm --filter @foundry/server e2e:ui` → [`e2e-ui-journey.md`](e2e-ui-journey.md). **31 MATCH · 2
MISMATCH · 4 GAP · 3 NOTE · 0 FAIL**, green at `2026-06` and `2026-05`.

Its method is the point, and it is one rule: **the journey may only use the HTTP surface
`packages/client` uses.** The `kestra:phaseN` harnesses import services directly, which is right for
proving engine properties and wrong for this question — a script that can call a repo silently grants
itself access no browser has. So every step names the `foundryApi.*` method it stands for, and a step
with no such method is recorded as a **GAP** rather than routed around. One exception, marked SETUP:
seeding named queries, because there is no route for them at all.

What it found, and what each finding cost to discover:

| | |
| :--- | :--- |
| **I-23** | `flowId` on an execution is the Kestra slug, not Foundry's uuid. Found by filtering the runs list the obvious way and getting **zero rows on runs that had succeeded**. |
| **I-22** | `test-run` and `fire` return `kestraExecutionId` (and `test-run` also `namespace`) — engine addressing handed to a client, against an invariant `ExecutionView`'s own docblock states. |
| **4 GAPs** | no route for named queries at all; no `createFlow` on the client; `generateFlow` exists with **no caller** (there is still no screen for typing a goal); the trigger-fire audit trail is API-only. |
| **3 NOTEs** | the Next proxy answers an unauthenticated API request with a 307 to `/login` rather than a 401; `llmConnected:true` is a possible false green; "Fire now" works on a disabled trigger *by design* — `enabled` governs unattended firing, and the approval gate still applies. |

**Two of its own early verdicts were wrong, and fixing them is where the value was.** It called
`engineStatus` a MISMATCH because it compared against `"succeeded"` while the engine says `"success"` —
so the report now records that the two fields use different vocabularies for the same outcome, which is
a real trap for a client poller. And it called revoke a MISMATCH for leaving `armedRevision` set — but
that is deliberate (the sweep selects on `armed_revision IS NOT NULL`, never on `status` — I-14), and
the control that stops firing is the **closed approval**. The step now **re-fires the trigger and
requires a 403**, which is the property a reader cares about and cannot pass for the wrong reason.

---

## The falsifiability gate — do not skip it

[README §"Start here"](../README.md): **Phase 1 is the decision point for the entire plan.**

> Rebuild the three measured scenarios as flows and score them against `GET /api/demo/oracle`.
> If per-step generation does not clearly beat 1-of-3, the thesis is wrong.

If Phase 1 fails that bar, **stop and report** rather than proceeding to Phase 2. The fallback is
much smaller: keep Tether's monolithic generation, adopt Kestra only for per-step visibility on the
deterministic steps.

## Pinned versions (O1, O2)

| What | Pin | Why pinned |
| :--- | :--- | :--- |
| Kestra image | `foundry/kestra:v1.3.29-scripts`, built **FROM `kestra/kestra:v1.3.29-no-plugins`** | O1. **`-no-plugins` is not optional** — the full image's 1404 plugins OOM'd the engine (I-05, D-01 amended). `infra/kestra/Dockerfile` adds back exactly one. |
| Kestra plugin | `io.kestra.plugin:plugin-script-python:1.3.1` | Plugin artefacts do **not** track the engine's patch version — `…:1.3.29` is a 404 on Maven Central; 1.3.1 is the newest on the engine's minor line. The Docker task RUNNER is already in core. |
| `code` step base image | `foundry/fragment-base:py3.12-pandas2.2.3` | O2. Stdlib + pandas, digest-pinned base. The tag names both versions because **every existing fragment was generated against this import set** — re-tagging in place would invalidate fragments nobody re-tested. |

## Resuming after a break

1. Read this file's **Current position**.
2. Read `ISSUES.md` for anything left `OPEN`.
3. Open the phase file that is `IN PROGRESS`; its **Work log** ends with the last thing done.
4. `git log --oneline main..kestra-migration` shows what actually landed.

## Ground rules carried from `CLAUDE.md`

These survive the migration and are easy to break by accident:

- **Do not touch the demo dataset or `demo/hr-roles.ts`.** `pnpm demo:verify` and `pnpm demo:rehearse`
  are the regression net for this migration.
- **Prompt block order is load-bearing** — `TASK` stays last in any generation prompt.
- **Never validate a Tether key by prefix** (`tth_live_` and `orb_live_` both valid).
- `MIGRATION_FIX_PLAN.md` and `gen-prompt-tracker/gen-prompt-tracker-plan.md` are historical records with
  do-not-rewrite headers — never include them in a global find-and-replace.

---

## Away from demo mode — Stages 1–7 and 9 (2026-07-30 → 2026-07-31)

A separate programme on the same branch. ⚠ Its `VERIFICATION.md` was **deleted on 2026-08-04** as
superseded; [`DECISIONS.md`](DECISIONS.md) **D-30…D-45** and [`ISSUES.md`](ISSUES.md) **I-24…I-41**
are the record now. It took the
product from *demonstrates itself through three layers of pretend* to *every screen shows real server
state or an honest error, tools are authenticated services in their own process, and the gates, the
loops and HITL exist*.

| Stage | What | Status |
| :--- | :--- | :--- |
| **1** | Kill the mock layer — `mockdb`, `faFallback`, the dead dummy-tool server | ✅ D-30 · guard `ui-honesty-check.sh` (21) |
| **2** | Named-query routes, showcase data, one flow per capability | ✅ closed the first `e2e:ui` GAP by building the route |
| **3** | HITL — the `approval` step kind, gate 3 for real | ✅ D-31 · `kestra:hitl` |
| **4** | Runtime retry — the one genuinely missing loop | ✅ D-32 · `kestra:retry` (22) |
| **5** | The tool layer leaves the control plane — `packages/ops-api` on :4004 | ✅ D-33 · I-26, I-27, I-28, I-29 |
| **6a** | An LLM text tool a flow can call, and a provider you can configure | ✅ D-34 |
| **6b** | Tether reachable — and the claim nobody had measured | ✅ D-35, D-36 · **I-24**, I-25 |
| **7** | A flow can be authored from a browser — the caps, `/flows/new`, the review surface | ✅ D-37, D-38 · I-31 · `e2e:ui` 46/2/4/4/0 |
| **9** | Identity stopped being discarded; a tenant datasource must be read-only | ✅ D-39, D-40 · I-32, I-33 · `e2e:ui` 48/2/4/4/0 |
| **8.1–8.3** | An agent's question reaches a person; one Tether tenant per workspace | ✅ D-41, D-42 · **I-34** · `e2e:ui` 51/2/4/5/0 |

| **8.4A** | The agent's answer stops being overwritten by a turn Tether adds after it | ✅ **I-34 round 3** · `../Foundry-Harness/agent-backend/server.js` |

⚠ **Stage 8.4 B/C and Stage 10 (production readiness) are still SCOPED, not built.** 9 ran before 8
on purpose — 8.1 routes an agent's question to *a person*, and "which person?" being unverifiable is
most acute exactly there.

⚠ **8.3's premise was measured twice and did not hold either time — read I-34, including round 3.**
"6.6 s versus minutes" is wrong (the default profile is *seconds*, and the chat profile is marginally
slower), **and so is the fallback reading that the profile at least buys the answer channel.**
Instrumented, the contaminating turn fires **27 of 27** runs in both arms and the refusal lands once
in each; 8/8 was a six-run arm on a ~10% coin. `profileId` stays, but as an honest declaration, never
as protection.

⚠ **`../Foundry-Harness/` is NO LONGER unmodified.** One change, defect A of 8.4, taken deliberately
and on its own: `finalMessage` is captured before any post-hoc turn, and the nudge is recorded as a
turn so `_ensureAssistant()` cannot overwrite the answer in place. **B and C remain unbuilt** and
both change `POST /api/run`. Sequencing is load-bearing — **C must never ship before B**.

⚠ **Stage 7 partly spends Phase 5's deferral** — it built task **5.2** (the validator, D-37) and an
authoring surface, and left **5.4** (`FlowEditor`/`StepPalette`) deferred on purpose. `phase-5.md`
carries the per-task state; the un-defer condition is met for the step vocabulary and not for the
variety of client goals.

**Four bugs found by running things, all of the same family — something reported success while doing
nothing, or did the right thing where nobody was looking.**

- **I-24** — the generator refused correctly every time and Foundry saw none of it. The transport
  worked whenever the answer was *yes* and mangled it whenever the answer was *no*, and the
  downstream retry is precisely what §6.7 forbids.
- **I-25** — an agent run that did not complete resumed the flow, posted its error message as the
  answer, and settled SUCCESS.
- **I-26** — a correct credential in the correct header 401ing, because one code path was
  case-sensitive about a case-insensitive protocol.
- **The UI's retry badge could never fire** — `tr.attempt ?? 1` against a scalar Kestra does not
  publish. The fallback was the only branch that had ever run.

**Two harnesses are new and both are honesty-shaped rather than gate-shaped.**

`showcase:verify` (22 assertions, two periods) checks the CLAIM each showcase flow's description makes
— the oracle's list rather than a green run, gate 1 asserted satisfied before the 403 so it is
genuinely gate 2 refusing, and two independent witnesses for "attempt 2".

`kestra:refusal` is a **measurement, not a gate**: it exits non-zero only if the harness could not run
or the control failed, because a refusal rate is a number to read and argue with.

`e2e:ui` grew phases 5a and 5b — **52 steps: 42 MATCH · 2 MISMATCH · 5 GAP · 3 NOTE · 0 FAIL** at both
periods. Two new GAPs, and they are the same one: `foundryApi` has **no create-flow method**, so
neither an `approval` step nor a `retry` can be declared from a browser at all.

**What is still open, stated plainly.** There is no UI for typing a goal and getting a flow
(`foundryApi.generateFlow` exists with no caller) and no `createFlow` at all — Phase 5's territory,
still deferred. A datasource registered by hand through the API still carries whatever credential the
caller supplies; the read-only work is wired through `demo/` only.

---

## Real email delivery — `foundry_email_send` (2026-08-18)

Feature `specs/20260818-084135-email-send-tool/`, decisions **D-74**.

**The tool inventory changes shape here, and the number was already load-bearing.** There are still
**15 simulated tools** — `demo/tool-catalogue.test.ts` asserts that count and still passes, correctly,
because it is a test about the *demo* catalogue. `foundry_email_send` is a **sixteenth tool that is
not demo data**: it is registered from `services/platform-tool-catalogue.ts` by
`workspaceService.create`, so it exists in every workspace whether or not a seed was ever run, and it
is the only tool in the product that does **not** point at ops-api.

It calls Foundry's own `POST /api/mail/send`, which delivers for real through Microsoft Graph
`sendMail`. That endpoint — not the tool's URL — is where the recipient policy lives, because Graph
delivers to whatever the body names and a tool aimed at Microsoft would have handed the model the
destination (D-74.1).

**What a reader resuming here most needs to know:**

- **The default is the requester, and it carries no address.** "Email me the result" compiles to a
  step with `subject` and `body` and no recipient at all; the address comes from
  `flow_executions.requested_by`. A named recipient must pass an allowlist, and one bad address sends
  **nothing** — `mail-end-to-end.test.ts` asserts zero transport calls on every refusal path.
- **A scheduled or triggered run has no person and refuses loudly.** No fallback to the flow's author
  or a configured operator address; that is how a nightly job starts emailing whoever last touched
  the flow.
- **`ToolActivity` now renders two sections.** The original reads `api_call_log` through ops-api (the
  simulation); the new one reads `email_sends` (real delivery). Merging them would put simulated calls
  and real deliveries in the same rows, and "did this actually reach anyone?" is the distinction a
  reader is there to make. Without the second panel a real send appeared **nowhere** on the run page.
- **`foundry_email_send` cannot be edited or deleted** from the tools page or the API — a reserved-name
  guard in `tool.service.ts`, restored by `pnpm --filter @foundry/server mail:register`.
- **Health reports `mail` as a config check, never a probe.** `up` means the four Graph variables are
  set. It cannot see the two most likely failures — missing tenant admin consent on the `Mail.Send`
  application permission, and a missing Exchange application access policy for `MAIL_SENDER_UPN` —
  because seeing either means sending a message.

⚠ **The Graph credential lives in `.env`, not Key Vault** — a deliberate deviation from
`FOUNDRY_SECRET_SOURCE`, asked for explicitly and recorded in D-74.4 so it does not become permanent
by going unwritten. It is read in exactly one module, enforced by a grep test, which is what keeps the
move cheap.
