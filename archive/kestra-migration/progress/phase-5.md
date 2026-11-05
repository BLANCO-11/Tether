# Phase 5 — Client authoring

**Status:** ⏸ **PARTLY SPENT.** Stage 7 of *away from demo mode* built **5.2** and an authoring
surface, and left **5.4 deferred on purpose**. Read [`DECISIONS.md`](DECISIONS.md) **D-37/D-38** and
[`ISSUES.md`](ISSUES.md) **I-31** before this file; where they disagree, those are newer. (They
replace `docs/away-from-demo-mode/VERIFICATION.md` "Stage 7 — VERIFIED", **deleted 2026-08-04**.)

| Task | Now |
| :--- | :--- |
| 5.1 compiler | ✅ landed a phase early (D-16) |
| 5.2 validator | ✅ **built in Stage 7** — `flow-validator.service.ts`, D-37. Two of its four listed caps are deliberately elsewhere or absent; the decision says which and why. |
| 5.3 redraft loop | ✅ `MAX_DRAFT_ATTEMPTS`/`MAX_FRAGMENT_ATTEMPTS` in Phase 4 |
| 5.4 `FlowEditor`/`StepPalette` | ❌ **still deferred, and the un-defer condition below is only half met.** Stage 7 built a *review* surface (`FlowReview.tsx`) and four narrow edits instead. |
| 5.5 immutability + promotion | ✅ Phase 3 |
| 5.6 `planFromPrompt` | n/a — `lib/plan.ts` went with the mock layer in Stage 1 |

⚠ **The condition below is met for the step VOCABULARY and not for the variety of client goals.** Six
kinds, closed; ~10 flows — but all written by an engineer against one synthetic dataset. That is why
Stage 7 built the surface where *the drafter writes the model and a human reviews it*, and not a
general step editor: building one before knowing which edits people make would be this deferral's own
mistake in a new place. Un-defer 5.4 when real goals have produced edits a review surface cannot make.

---

**Original status:** ⏸ **DEFERRED — deliberately not in v1.**
**Implements:** [08 §10 "Phase 5"](../08-scale-and-phasing.md) · [02 R8](../02-rules.md) · [05 §6.4](../05-lifecycle-and-flows.md)

> **Do not build this yet.** There are currently **zero flows in existence.** Building a flow editor
> plus untrusted-input hardening before knowing what flows look like is backwards.
>
> **Instead:** author the first ~10 flows on clients' behalf. Learn the real step vocabulary, the
> contract shapes that recur, and which caps actually bind. R8's hardening becomes urgent only once
> clients genuinely submit content — and by then you will know what to validate.

The ruling that clients *will* author flows stands. Just not first.

## Un-defer when

Roughly ten flows exist, authored on clients' behalf, and the recurring step vocabulary is known.

## Tasks (for when that time comes)

| # | Task |
| :--- | :--- |
| 5.1 | `services/flow-compiler.service.ts` — **the sole YAML emitter in the system.** Allowlist is exactly three task types. |
| 5.2 | `services/flow-validator.service.ts` — tenant-scoped ref validation; step / fan-out / agent-run / subflow-depth caps; **structured LLM-consumable findings** |
| 5.3 | `services/flow-draft.service.ts` — the bounded redraft loop, capped at 3 attempts, then escalate |
| 5.4 | `FlowEditor.tsx`, `StepPalette.tsx`, `ValidationPanel.tsx` |
| 5.5 | `flow_revisions` immutability; draft/live promotion wired to Phase 3's approval |
| 5.6 | `lib/plan.ts` — `planFromPrompt` stops being a local simulation |

## The compiler's allowlist — nothing else is emittable (R8)

| Emitted type | For | Constraint |
| :--- | :--- | :--- |
| `io.kestra.plugin.core.http.Request` → Foundry | `tool`, `datasource`, `agent`, `notify` | Target host is **always** Foundry |
| `io.kestra.plugin.scripts.python.Script` | `code` | Docker task runner only, network off (R9) |
| `io.kestra.plugin.core.flow.*` | `ForEach`, `Pause`, `If`, `Subflow` | Control flow, no I/O |

If clients could submit YAML they could write **any** Kestra task type: a script task is arbitrary
code execution inside Kestra's container; an `http.Request` to `169.254.169.254` is cloud-metadata
credential theft; a request to Foundry's admin routes or Kestra's own API is SSRF into the trust zone
R2/R4 establish; a filesystem-reading task lifts Kestra's Foundry credential.

## The validator's two jobs, and the first is bigger

Framing it as a security control against malicious clients is a **misread**. Its primary job is
catching **LLM error** — in the [worked example](../10-worked-example.md) both findings are LLM
mistakes, not client mistakes. The security case is the rarer one.

Two load-bearing requirements:

1. **Findings must be LLM-consumable, not human prose.** A finding carries the offending step, the
   rule, and *the facts needed to fix it* — `unknown tool "list-approved-leave"; available in this
   workspace: [...]`. A bare "invalid tool" wastes a redraft cycle.
2. **The loop is bounded.** Cap at 3, then escalate to a human with accumulated findings rather than
   looping on tokens.

## Exit criteria — three, and the first is the product

1. **A client types a sentence and gets a valid flow without touching structure.** Validator findings
   are resolved by the LLM, not surfaced as work for the user.
2. A hand-crafted malicious model (foreign tool ref, script task, 1M-item fan-out, self-referencing
   subflow) is rejected at validation with a readable reason.
3. A deliberately unsatisfiable prompt exhausts 3 attempts and **escalates** rather than looping.

## Verification

14, 15, 16, 17 (**no client-facing route accepts YAML on any path** — a grep-level test plus a
request test).

## Work log

*(empty)*
