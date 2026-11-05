# Foundry → Kestra Migration

> **Status: PINNED — agreed design, 2026-07-28.** Not started. All design decisions are resolved;
> two facts await external verification (V1, V2 in [09](09-risks-and-verification.md)) and neither
> blocks Phase 0 or Phase 1.
> **Supersedes:** `airflow-integration-design.md` and the earlier `nodemation-*` drafts — both
> proposed a different engine and a different division of labour. Removed.
> **Spans three repos:** `foundry/` (parent app), `Foundry-Harness/` (Tether runtime), and a new
> Kestra deployment. **Tether requires zero code changes.**
>
> **Amend, don't rewrite.** If a decision changes, edit the relevant file and note it here. The
> §-numbering is referenced across files — see the map below.

## The one-paragraph version

An automation today is *prompt in, monolithic Python script out*, and it is measurably unreliable —
1 of 3 scenarios correct first-pass, with one script that emailed 0 of 11 people while reporting
`tests_passed=true`. This plan replaces the single generated script with a **flow of declared steps**,
where only the steps that genuinely need generation get generated, each from its own contract.
**Kestra** provides sequencing, per-step records, replay and scheduling; **Foundry** keeps tenancy,
credentials, the manifest and the client UI; **Tether** stays exactly as it is, reached by one step
kind.

## Read in this order

| # | File | What's in it |
| :--- | :--- | :--- |
| 1 | [01-rationale-and-decision.md](01-rationale-and-decision.md) | The measured problem; why Kestra and why every other engine was rejected |
| 2 | [02-rules.md](02-rules.md) | **R1–R9.** The invariants. Read these before anything else. |
| 3 | [03-architecture.md](03-architecture.md) | Topology, connectivity, concept mapping, Kestra capability inventory |
| 4 | [04-generation-model.md](04-generation-model.md) | Where code lives, per-step generation, the generation boundary, sharing |
| 5 | [05-lifecycle-and-flows.md](05-lifecycle-and-flows.md) | Request lifecycle, execution, agent steps, replay, approval |
| 6 | [06-failure-triage.md](06-failure-triage.md) | What happens when a step breaks; the step-boundary mitigation |
| 7 | [07-refactor-inventory.md](07-refactor-inventory.md) | Every file that changes, per service |
| 8 | [08-scale-and-phasing.md](08-scale-and-phasing.md) | Scale mitigations, capability ladder, phases, what retires |
| 9 | [09-risks-and-verification.md](09-risks-and-verification.md) | Risks, open questions, 36 assertions |
| 10 | [10-worked-example.md](10-worked-example.md) | One request, T0→T10, with real artifacts |

**Short on time?** [02-rules.md](02-rules.md) then [10-worked-example.md](10-worked-example.md).

### Section number → file

Section numbering is continuous across files, so a `§` reference resolves via this map:

| § | File |
| :--- | :--- |
| §1–2 | [01-rationale-and-decision.md](01-rationale-and-decision.md) |
| §3 (R1–R9) | [02-rules.md](02-rules.md) |
| §4, §5, §5.4 | [03-architecture.md](03-architecture.md) |
| §5.1–5.3.1 | [04-generation-model.md](04-generation-model.md) |
| §6.0–6.5 | [05-lifecycle-and-flows.md](05-lifecycle-and-flows.md) |
| §6.6–6.13 | [06-failure-triage.md](06-failure-triage.md) |
| §7 | [07-refactor-inventory.md](07-refactor-inventory.md) |
| §8–11 | [08-scale-and-phasing.md](08-scale-and-phasing.md) |
| §12–13 | [09-risks-and-verification.md](09-risks-and-verification.md) |
| §14 | [10-worked-example.md](10-worked-example.md) |

## The five load-bearing decisions

| | |
| :--- | :--- |
| **Kestra, Apache-2.0** | The only permissively-licensed engine with per-step records + replay-from-task. n8n and Windmill are licence-blocked for commercial resale. |
| **Maximise Kestra** (R2) | Foundry keeps exactly two things: credential custody and the client-facing surface. A step runs in Kestra **iff** it needs no tenant credential. |
| **Generated code is a pure transform** (R9) | All side effects live in pre-written step kinds. Generated code can compute a wrong value — never contact the wrong system. |
| **Neither the LLM nor clients emit YAML** (R8) | `flow-compiler.service.ts` is the sole emitter. Its allowlist is three task types. |
| **Approval binds to a revision** | A new schedule needs one human approval. The Kestra trigger does not exist until approved. |

## What this is worth, honestly

**It fixes wrong plumbing, not wrong judgement.** Hardcoded dates, invented field names, missing
defaults, wrong recipients — these become *inexpressible*, because a fragment with no I/O and a
declared contract cannot reach for what it wasn't given. Semantic errors survive; see
[06 §6.11](06-failure-triage.md).

**Kestra's own contribution is moderate, not immense.** The large win is the decomposition, which is
architecture we own. Kestra's value is that replay-with-rehydration, durable pause/resume, and an
operator debugging UI arrive already correct rather than needing to be designed. See
[03](03-architecture.md) §5.4 for the audit of what we take and what we can't.

## Start here — and be willing to stop

**Phase 1 is falsifiable, and it is the decision point for the entire plan.**

> Rebuild the three measured scenarios as flows and score them against `GET /api/demo/oracle`.
> **If per-step generation does not clearly beat 1-of-3, the thesis is wrong.**

That is roughly a week against a hypothesis you can kill. If it fails, the fallback is much smaller:
keep Tether's monolithic generation and adopt Kestra purely for per-step visibility on the
deterministic steps around it.

Do not stand Kestra up as an act of faith. Stand it up because the flow you built beat the script you
had.

## Scope guidance

The full plan is a multi-quarter programme. The **valuable core is Phases 0–4**; Phase 5 (client
authoring) is deliberately deferred — see [08](08-scale-and-phasing.md) §10.

Rationale: there are currently **zero flows in existence.** Building a flow editor plus
untrusted-input hardening before knowing what flows look like is backwards. Author the first ~10 flows
on clients' behalf, learn the real step vocabulary and contract shapes, then build the editor. R8's
hardening only becomes urgent once clients actually submit content.

## Decisions — all resolved

| Question | Decision |
| :--- | :--- |
| Engine | **Kestra**, Apache-2.0, unmodified, single instance behind Foundry |
| How much of Kestra to use | **Everything it can do** (R2). Foundry keeps only credential custody and the client surface |
| Where `code` steps execute | **In Kestra**, Docker task runner. Foundry runs no containers — `execution.service.ts` is deleted |
| Backward compatibility | **None owed.** R&D app, nothing in production — redundant components are deleted, not retained ([07](07-refactor-inventory.md) §7.0) |
| `datasource` steps | **Named queries, not generated SQL** — kills a measured failure mode and makes `generation-audit.service.ts` deletable |
| `code` step conventions | One **pinned base image**; stdin JSON → stdout JSON; large payloads by reference; no credentials ([04](04-generation-model.md) §5.3.2) |
| Per-flow concurrency | **Kestra's if available (V2), else built in Foundry** |
| Namespace grain | **Per workspace, tenant-prefixed, immutable slugs** — `acme.hr` + `acme.hr.draft`. Hierarchy: tenant ⊃ workspace ⊃ users |
| Schedule triggers | **Kestra's**, deployed at approval and removed on revoke |
| May a schedule run unattended | **Yes, once approved** — approval binds to a *revision* |
| Approver | **Workspace admin, and a different human than the author** (separation of duties) |
| Re-approval after regeneration | Structure change → human. Fragment body only → **automated re-test**, approval carries |
| Do clients author flows | **Yes**, but LLM drafts and the validator corrects; editing is an override. **Deferred to post-v1** |
| Who fixes a broken step | LLM for code and boundaries; **user only** for credentials, infra and tool-shape changes |
| Fragment generation path | **Reuse Tether's** existing generate → run → iterate loop |
| Revoking approval mid-execution | **In-flight completes**; only future firings suspend |
| Poll trigger entering mid-flow | **No.** Flows start at step 1; replay covers the legitimate case |

## Awaiting verification — not decisions

| # | To verify | When | Fallback |
| :--- | :--- | :--- | :--- |
| **V1** | Can Kestra's Docker task runner **disable network**? | Phase 4 | `code` steps run in Foundry's Docker runner; R9 enforced there |
| **V2** | Does the deployed Kestra support **flow-level `concurrency`**? | Phase 1 | Overlap control in Foundry; M3 unaffected |

Neither blocks Phase 0 or Phase 1.
