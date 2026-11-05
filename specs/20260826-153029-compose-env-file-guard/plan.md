# Implementation Plan: A build that cannot reach its dependencies says so

**Feature**: `20260826-153029-compose-env-file-guard`
**Created**: 2026-08-26

⚠ **THIS FILE CURRENTLY COVERS ONLY THE BACKFILLED `.env.example` CHANGE.**
The feature's own work — the build-time guard and the six missing `--env-file`
flags — is **not planned here**. It still needs `/speckit-plan` proper. This file
exists because `/speckit-backfill` must record a change that was already made, and
a backfill cannot invent a plan for work nobody has done.

⚠ **A CONSEQUENCE WORTH KNOWING**: the spec gate requires `plan.md` **and**
`tasks.md` to exist. Creating them here satisfies that gate for the whole branch —
so source edits are now unblocked for work whose plan is not yet written. That is a
side effect of the backfill, not a licence. **Run `/speckit-plan` before
implementing anything in the Deferred section.**

---

## Backfilled 2026-08-26 — `.env.example` values emptied

### Technical context, as actually implemented

| | |
| :--- | :--- |
| Files changed | `.env.example` only |
| Change size | 22 insertions, 22 deletions |
| Languages / dependencies added | none |
| Tests added | none |
| Migrations | none |
| Runtime impact | **none** — see below |

### Structure of the change

A single mechanical edit repeated 22 times: the right-hand side of an assignment is
replaced with nothing. Keys, ordering, blank lines and every explanatory comment are
untouched.

The file now holds 29 keys, all with empty values — the 22 changed here plus 7
(`RUNTIME_JWT_SECRET`, `SUPER_ADMIN_EMAILS`, and the five `MAIL_*`) that were
already empty before it.

### Why there is no runtime or build impact

`.env.example` is **not consumed programmatically anywhere**. Verified by searching
`scripts/`, `ci/`, `infra/`, `.githooks/` and `packages/server/src`: the six hits
are all error-message *text* naming the file as the place to add a placeholder —
`spec-gate-core.sh:133`, `check-secrets.sh:35,48`, `secret-policy.sh:13,56`,
`pre-commit:22`. Compose loads `.env` via `env_file`, never the example.

So the change is documentation-only. Nothing to test at runtime, which is why no
test accompanies it — recorded here rather than left as an unexplained gap
(Constitution II asks for the justification, not for a test that would assert
nothing).

### Constitution check

| Article | Status | Note |
| :--- | :--- | :--- |
| I — Spec-First | **violated, now regularized** | Changed outside the workflow; this backfill is the remedy the article names. |
| II — Test-First | satisfied by exemption | No behaviour changed; nothing to assert. Justified above. |
| IV — Simplicity | satisfied | One file, no new abstraction. |
| V — Observability | n/a | No failure path added. |
| VII — Documentation Currency | ⚠ **at risk** | The comments now describe values that are gone — see F2. |
| VIII — Secrets Hygiene | **satisfied, and improved** | No removed value matched any `SECRET_CONTENT_PATTERNS` entry, so nothing needs rotating. The file moves further from ever carrying a usable value. |

### Complexity tracking

None. There is no new dependency, layer or abstraction.

### The open question this plan cannot answer

⚠ **Whether blanking the NON-secret defaults was intended.** The stated intent was
*"removed all dummy secrets"*, and roughly half the 22 edits are not secrets:
`PORT`, `WS_PORT`, `NODE_ENV`, `TETHER_BASE_URL`, `KESTRA_RETENTION_DAYS`,
`KESTRA_PURGE_CRON`, `KESTRA_FRAGMENT_IMAGE`, `KESTRA_NAMESPACE_PREFIX`,
`BUDGET_DEFAULT_*`, `LLM_FAST_MODEL`, `LLM_REASONING_MODEL`. Their comments still
describe the removed values, so the file contradicts itself in at least two places.

Two coherent end states, and this plan does not choose between them:

- **A — values are documentation.** Restore the non-secret defaults; blank only the
  credential-shaped keys. The comments become true again and a reader learns the
  expected shape.
- **B — the example is a checklist of names.** Leave every value empty and fix the
  comments that name specific values, so nothing contradicts anything.

Both satisfy Article VIII. **B is the current state minus the comment fix**, so it
is the cheaper of the two and needs one follow-up edit rather than a revert. See
task T-B4.

---

## Deferred — the feature's own work, NOT planned here

Requires `/speckit-plan`. Named so its absence is visible rather than implied:

- **US1** — the build-time guard (FR-001…FR-005). The unresolved design decision is
  whether reachability is **detected** at build time or **declared** by a variable;
  the spec deliberately constrains only the outcome. Assumption 1 argues for
  detection.
- **US2** — the six missing `--env-file` flags plus the check that keeps a seventh
  from appearing (FR-006, FR-007).
- **US3** — preserving the un-intercepted build path (FR-003), measured with the
  previous feature's `verify-fr003.sh`.
