# Phase 3 — Triggers, approval, and lifecycle

**Status:** ✅ **DONE** — exit criterion met and measured against the running engine
(`pnpm --filter @foundry/server kestra:phase3`, 39 assertions, two periods).
**Implements:** [08 §10 "Phase 3"](../08-scale-and-phasing.md) · [05 §6.5](../05-lifecycle-and-flows.md) · [03 §5.4](../03-architecture.md)

## Tasks

| # | Task | Status |
| :--- | :--- | :--- |
| 3.0 | **`flow-compiler.service.ts`** — not in the original list, and unavoidable here. See below (D-16). | ✅ |
| 3.1 | Two-namespace split — `<tenant>.<ws>` (live, approved only) + `<tenant>.<ws>.draft`. **Immutable slugs**, mandatory tenant prefix ([03 §5.0](../03-architecture.md)) | ✅ |
| 3.2 | `tenant-mapper.service.ts` — single source for both namespace names | ✅ |
| 3.3 | `services/flow-approval.service.ts` — approve → compile → deploy live → **deploy the Kestra Schedule trigger**; revoke/stale → **remove it from Kestra** | ✅ |
| 3.4 | `routes/approvals.ts` + `components/flow/ApprovalPanel.tsx` + `RevisionDiff.tsx` | ✅ |
| 3.5 | `manifest-builder.service.ts` — stable `manifest_refs` fingerprint per tool/datasource shape, so staleness is detectable | ✅ |
| 3.6 | `trigger.service.ts` — `fire()` starts a **Kestra execution**; `enableReadiness()` against flow executions. Keep the 409-rethrow and `trigger_fires`-written-first ordering. | ✅ |
| 3.7 | `trigger-scheduler.ts` — **shrinks to the poll loop only.** Cron/schedule handling moves to Kestra. | ✅ |
| 3.8 | DB: `flows`, `flow_revisions`, `flow_steps`, `flow_approvals` | ✅ migration `0011` |
| 3.9 | Repoint `app/(app)/triggers/page.tsx`; **surface approval state** — a trigger blocked on approval must say so, not present a dead switch | ✅ |
| — | **phase-2.md 2.5** — the flow detail page D-12 deferred until `flows` existed | ✅ shipped as `app/(app)/flows/[id]` |

## 3.0 — the compiler arrived a phase early, and had to

08 §10 schedules `flow-compiler.service.ts` with **Phase 5**, and that ordering is right for the half
of its job that is about untrusted input. The emitter itself cannot wait, for two reasons:

- **A Kestra Schedule trigger is part of the flow definition, not a separate API object.** "Approval
  deploys the trigger, revocation removes it" (§5.4) therefore means the live YAML and the draft YAML
  are *the same model compiled twice* — once with a `triggers:` block and once without. Storing one
  YAML blob per revision could only do that by string surgery, which is the ad-hoc emission R8 exists
  to forbid.
- **Approval binds to a revision**, so promotion has to deploy *that revision's* content. Something
  must turn a stored revision into deployable YAML.

What stays in Phase 5 is everything that assumes the model came from somewhere untrusted:
`flow-validator.service.ts` with its LLM-consumable findings, the bounded redraft loop, and the caps.
`paramsExpr` is opaque to the compiler on purpose — read **D-16** before accepting a model over a
client-facing route.

Three structural properties make the output safe, and none of them is a blocklist:

| | |
| :--- | :--- |
| **Task types are chosen by the compiler**, from a fixed set | Nothing in a model names a Kestra task type, so no model can introduce one. R8 in one line. |
| **Every URI is `{{ vars.foundry }}<path>`** | A model cannot name a host, so the one-host egress allowlist holds even for a hostile model |
| **Free text is re-indented into a block scalar** | Ending a block scalar requires *dedenting*, and nothing can emit less indentation than it is given — so an expression that looks like YAML stays a line of text |

23 unit tests in `flow-compiler.test.ts` pin those, including a hostile `expr` carrying a
`scripts.python.Script` task that comes out as text.

## What each piece became

| | |
| :--- | :--- |
| `services/flow-compiler.service.ts` | Model → YAML. Sole emitter (R8). `structureHash()` implements §6.5's structure/fragment asymmetry. |
| `services/flow.service.ts` | Flow CRUD, **immutable** revisions, draft deploys, draft test runs. **Has no live branch at all** — that is how "editing cannot change what the schedule runs" stays checkable by grepping. |
| `services/flow-approval.service.ts` | Gate 2. Approve → promote + arm; revoke/stale → remove the trigger; `assertMayRunLive()` for `begin`; `diff()` for the approver. The only module that writes to the live namespace. |
| `repositories/flow.repo.ts` | Insert-only revisions and steps; approvals closed by timestamp, never deleted. |
| `services/tenant-mapper.service.ts` | `namespacesFor(workspace)` → `{live, draft}` as a pair, with the nullable-slug trap turned into a 409 instead of a namespace that silently does not resolve. |
| `services/manifest-builder.service.ts` | `refFingerprints()` per ref + `aggregateFingerprint()`. Per **ref**, so a manifest bump touching nothing this flow uses has no effect (§6.5). |
| `routes/{flows,approvals}.ts` | Approvals is its own router because it is the one client-reachable path that can arm a schedule. |
| `routes/executions.ts` | `begin` now enforces gate 2 on the **live** namespace and records `flow_id` + `flow_revision`. |
| `services/trigger-scheduler.ts` | Cron handling deleted. Poll loop survives; gained the approval-staleness sweep. |

## The rule that is easiest to get wrong

**Approval binds to a *revision*, never to the flow.** If it bound to the flow, editing an approved
flow would silently repoint an already-armed schedule at different behaviour — approve-once becomes a
blank cheque over changing content. That is privilege escalation by editing (risk 1d).

**What invalidates an approval** ([05 §6.5](../05-lifecycle-and-flows.md)) — note the asymmetry, it
exists because at 1-of-3 first-pass accuracy every regeneration would otherwise become an approval
cycle, and that friction gets the gate disabled:

| Change | Requires |
| :--- | :--- |
| **Structure** — steps, tools, contracts, side effects | **Human re-approval** |
| **Fragment body only**, contract unchanged | **Automated re-test.** Approval carries over. |
| A referenced tool/datasource changes shape | Approval **stale** → schedule suspends |
| A referenced secret rotated | No effect — bound by env-var name, not value |

Three gates, none replacing another: `enableReadiness()` → **schedule approval** → step approval
(Kestra `Pause`, per execution). Do not conflate gates 2 and 3.

**Don't reproduce the H.1 bug** while rewriting triggers: a trigger created as *Email* currently
reloads as *Webhook* (a three-layer type inconsistency). It was deliberately left unfixed because
this rewrite touches exactly that code.

## Exit criterion

A new schedule cannot fire until a human approves it, **and** editing an armed flow does not change
what the schedule runs.

## Verification

10, 11 (approve → edit → next firing still runs the **approved** revision), 12 (tool shape change →
approval stale → schedule suspends), 13 (revoke → no further firings, in-flight completes), 25
(revoke → the Schedule trigger is **removed from Kestra**, not merely flagged).

## Work log — 2026-07-29

**The exit criterion is met, and it is measured rather than asserted.** `pnpm --filter @foundry/server
kestra:phase3` drives the real services against the real engine and reads the answers back out of
Kestra — 39 assertions, green at `2026-06` and `2026-05`:

```
P0  the COMPILED flow still beats the oracle
    flagged employees match the oracle        3,9,14,20,26,30,38,41,45,52,60
    emails actually sent (stub_mail_outbox)   10
10  a new schedule cannot fire until approved
    the draft namespace carries NO trigger    0
    nothing is deployed live yet              null
    an author cannot approve their own rev    409
    a Schedule trigger now exists in Kestra   io.kestra.plugin.core.trigger.Schedule
    …and is not merely disabled               false
    live YAML is exactly revision 1, recompiled   sha256:ad5e249e…
11  editing an armed flow changes nothing live
    the armed revision did not move           1
    live YAML is byte-identical after the edit    true
    …while the DRAFT namespace did change     true
12  tool changes shape → stale → suspends
    the sweep suspended one flow              1
    the Schedule trigger is gone from Kestra  null
    a manual live execution fails at begin    FAILED
    …and no flow_executions row was created   undefined
13/25  revoke
    triggers array is EMPTY, not disabled     0
    'Schedule' absent from the deployed YAML  true
    begin refuses a live run of a revoked flow    403
```

Three of those are worth pulling out.

**Assertion 11 is a byte comparison, not an inference.** Kestra serves the deployed source at
`?source=true`, so "editing an armed flow does not change what the schedule runs" is checked by
hashing what is actually live and comparing it to the approved revision recompiled — not by trusting
that nothing wrote to the live namespace.

**Assertion 12 checks the trigger is GONE, not flagged.** Kestra supports `disabled: true`, which is
precisely the "merely flagged" state assertion 25 forbids: a flag is one accidental redeploy away
from firing, and it leaves the engine holding a schedule nobody approved. Revoking redeploys the live
flow without its `triggers:` block. The flow itself stays — deleting it would also stop firing but
risks an execution in flight, and §6.5 wants *"no further firings, in-flight completes"*.

**P0 exists because the compiler arrived early.** A compiler that emits deployable YAML computing the
wrong answer would pass every other assertion in this phase, so the first thing checked is that a flow
compiled from `kestra/hr-screening.model.ts` still produces `expectedScreening`'s answer — the same
oracle the hand-written Phase 1 YAML beat.

### The bug it found — I-14

`flowRepo.listArmed()`, the staleness sweep's work list, selected `WHERE status = 'armed'`. But
editing an armed flow sets `status` to `draft_pending`, so the sweep's real work list was *"armed
flows nobody has edited"* — a set that empties over time and never refills, leaving armed revisions
firing against a manifest nobody re-checked.

It surfaced only because the script does 11 and then 12 **in that order**. A test that armed a flow
and immediately changed a tool would have passed; so would one calling `checkStaleness()` directly.
The general rule is in [ISSUES.md](ISSUES.md) I-14: **a sweep must select on the fact, never on a
status string that exists for display.**

### Two honest limits

- **The approver is not authenticated** ([ISSUES.md](ISSUES.md) **I-13**). Foundry has one shared
  `PARENT_API_KEY` and no user model, so `approver_user_id` is self-asserted. Self-approval is refused
  against the recorded author, which catches the honest mistake and nothing else. The real control in
  Phase 3 is the **revision binding** — an approval names one immutable revision — and that holds
  regardless of who claimed to make it. The `ApprovalPanel` says so on the form, in the product.
- **`2026-05` is the empty-data period** for this dataset, so the P0 oracle check there compares 0 to
  0. Its value is the empty case (the I-09 shape), not a second correctness data point. The
  correctness claim is `2026-06`; every approval assertion holds at both.

### Regression net, all green

```
pnpm typecheck                     3 projects clean
npx vitest run                     183 passed (10 files) — was 148; +23 compiler, +12 fingerprint
pnpm kestra:check                  10 / 10
pnpm kestra:verify                 all assertions (6, 7, 28, V2, O4)
pnpm kestra:prove --period=2026-06 3 of 3
pnpm kestra:prove --period=2026-05 3 of 3
pnpm --filter @foundry/server kestra:phase3               39 / 39
pnpm --filter @foundry/server kestra:phase3 --period=2026-05   39 / 39
pnpm demo:verify                   exit 0
swap-rehearsal (demo:rehearse)     30 / 30
next build                         compiled; /flows and /flows/[id] present
```

### Still open, deliberately

- **`flow-validator.service.ts`, the redraft loop and the caps are still Phase 5.** `paramsExpr` and
  `transform.expr` are opaque strings emitted verbatim. Safe while every model is Foundry-authored
  (which is what 08 §Phase 5 prescribes for the first ~10 flows) and **not safe for client-authored
  models**. Read **D-16** before putting a model behind a client-facing route.
- **`code` and `agent` steps are absent from the compiler's allowlist**, not stubbed. Phase 4 adds
  them, and the Docker `scripts` plugin has to be installed and pinned separately (D-01 AMENDED).
- **The sweep is single-node**, like `pollRun`. Two Foundry replicas would sweep twice. Phase 4 has to
  solve that once for both.
- **`flow_executions.flow_id` is nullable** so Phase 1's three hand-written flows keep recording real
  history. `begin` lets a flow Foundry does not own through and records a null — refusing it would
  break the falsifiability harness and grants nothing, since the execution still needs the callback
  secret and still spends the workspace's budget.
