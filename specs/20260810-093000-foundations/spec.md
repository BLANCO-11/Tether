# Foundations for a three-mode automation builder

⚠ **This directory exists to satisfy the agent-facing spec gate, and it is NOT the plan.**

The authoritative specification, findings, phase task lists, decisions, issues and evidence for this
work live in **[`plans/foundations-2026-08-10/`](../../plans/foundations-2026-08-10/plan.md)**, and
the programme records it builds on live in **`docs/programmes/`**.

**Why this file is thin, deliberately.** The user chose not to run the spec-kit workflow for this
work (recorded in `plans/foundations-2026-08-10/plan.md` § "Operational constraints"). The documented
escape is `SPECKIT_ENFORCE=0`, which cannot be set from inside an agent session — the hook subprocess
inherits the harness's startup environment. `.specify/feature.json` is the gate's own next resolution
step (`scripts/spec-gate-core.sh:56-83`) and both `specs/**` and `.specify/**` are always editable
(`ci/spec-policy.sh:is_always_editable`). So this is the gate's documented mechanism rather than a
loophole, and it leaves the content secret-scan armed — which `SPECKIT_ENFORCE=0` would have disarmed.

Neither `.githooks/pre-commit` nor `ci/check-spec-compliance.sh` exists in this working copy and
`core.hooksPath` is unset, so no commit-time or CI spec gate is bypassed by this. Verified
2026-08-10.

**To restore the gate:** delete `.specify/feature.json`. This directory can stay as the record.

## What is being built

A Zapier/n8n-shaped automation platform with three ways to build a workflow — "design it for me",
chat, and an advanced drag-and-drop builder — on foundations that mostly already exist. Two of the
three modes are built and all three authoring paths already converge on one pipeline
(`runGeneration`), where `authorFlow` is `draftFlow` minus the inference call, so **a hand-authored
model cannot reach a weaker path than a generated one**. That property is what every phase below must
preserve.

## Requirements, by phase

Full task lists are in each phase's `checkpoint.md`. These are the acceptance statements.

| Phase | Requirement |
| :--- | :--- |
| **I-120** | A tool step is refused **409** when its resolved secret name is declared elsewhere in the workspace at a **different** value — and **succeeds** when declared at the same value. Today `resolveForExecution` has no production caller, so the control `CLAUDE.md` and two docblocks describe does not run. |
| 0 | Every `docs/` and source reference resolves to a file that exists; `CLAUDE.md`'s plugin count and D-35 sentence match the code; the three newest programmes are named with their record locations; a fresh gate baseline is written down. |
| 1 | A tool created **in the browser** authenticates; the `/keys` audit `missing` banner fires and the step fails **424** not 401; a datasource registered in the browser can name a non-`public` schema and a refused widen renders its findings; the wizard offers nothing that cannot work; a named query's parameter descriptions reach the drafter with **0 ref fingerprints moved**. |
| 2 | A conversation builds and edits a flow one component at a time and says which component it changed — gated on task 2.0's spike. |
| 3 | `If` — "do not email an empty report" is expressible in all three modes. |
| 4 | An admin-gated capability catalogue whose credentials stay encrypted. ⚠ Not "the six plugin groups become usable". |
| 5 | A datasource can be written to through reviewed parameterised write objects. ⚠ Blocked on two product answers. |
| 6 | The three modes read as one product with one vocabulary. |

## Non-negotiable invariants

These are pre-existing properties of the system that this work must not break. Each is load-bearing
and each has a stated reason in `CLAUDE.md` or the phase directories.

- **A refusal ends the loop and is never retried** (§6.7, D-38, D-112). Re-asking is how a correct
  `insufficient_contract` becomes an invented `period="2023-10"` — the measured failure that emailed
  0 of 11 people and exited 0 with `tests_passed=true`.
- **The compiler is the sole YAML emitter** (R8), and `FOUNDRY_EMITS` mirrors it, pinned by a test
  that reads the compiler's source off disk.
- **A secret never appears in a flow definition**, and `code` fragments keep `networkMode: none`.
- **Approval binds to a revision, never to the flow.** Revisions and steps are insert-only.
- **A `code` step gets a contract, never code**, and `outputKeys` is derived from `contract.output`.
- **Nothing here is separation of duties** — anything holding `RUNTIME_JWT_SECRET` mints an identity.

## Out of scope

Writable DSNs (a reviewed named-write capability instead), refine-with-history chat, a fourth branch
of `runGeneration`, loops (`ForEach` per item), a `createFlow` route, vault-sourced datasource
credentials (refused, D-117), and `POST /tools/:id/test`.
