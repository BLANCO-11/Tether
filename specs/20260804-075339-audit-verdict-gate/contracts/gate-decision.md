# Contract — the gate decision

Invariants the implementation must hold. Each is written so it can be read
directly as a test name; `tasks.md` references them by ID.

## G — Gating (the asymmetry)

- **G1** — A script whose most recent audit verdict is `fail` is **not ready** to
  arm a `schedule`, `poll` or `webhook` trigger.
- **G2** — `create({ enabled: true })` is subject to G1. Creating an armed trigger
  is arming a trigger.
- **G3** — A `warn` verdict does **not** refuse.
- **G4** — A `null`/absent verdict does **not** refuse.
- **G5** — An unrecognised verdict value **does** refuse, and logs.
- **G6** — **A `clean` verdict causes no other condition to be skipped,
  shortened or weakened.** Specifically: a `clean` script that is not `completed`
  is still refused; a `clean` script with no succeeded execution is still refused.
- **G7** — The verdict is read from the **most recent** `test_results` row for the
  script. An older `clean` never outranks a newer `fail`.
- **G8** — The gate never writes. No script status, trigger `enabled` flag, or
  test-result field changes as a result of evaluating it.
- **G9** — Manual execution of a `fail`-verdict script is unaffected.
- **G10** — `manual` triggers are not gated (spec Q2 resolution A). The gate is on
  unattended execution, and gating `manual` would make the succeeded execution
  that G6's second clause requires unreachable for a manual-only script.

### The deletion check for G6

G6 cannot be proved by assertion alone, because the failure it guards against is
a *permit* that the verdict enables somewhere else. The check is: **delete the
verdict condition entirely; every case refused before must still be refused, for
the same reason.** If deleting it makes some other case start passing, the
verdict was load-bearing for a permit, and the asymmetry is broken.

## O — Override

- **O1** — An override with a reason of one or more non-whitespace characters is
  accepted; the trigger can then be armed.
- **O2** — An override with an empty or whitespace-only reason is refused, at the
  service **and** by a database constraint.
- **O3** — An override applies only to the `test_results` row it was recorded
  against. After regeneration, a fresh `fail` blocks again.
- **O4** — An override is never implicit. No code path creates one as a
  side effect of any other action.
- **O5** — An override covers every trigger bound to the same audited code
  (spec Q3 resolution A).
- **O6** — The existence of an override, its reason and its time are visible on
  the surfaces where the trigger and the automation are viewed.
- **O7** — An override never widens a credential, a role, or a scope. It permits
  one action that a finding refused; it grants no authority.

## S — Surfaces

- **S1** — A blocked enable names the finding codes that caused it.
- **S2** — The refusal reason for an *earlier* condition wins. A script that has
  never run is told it has never run, not told about findings.
- **S3** — No surface renders `clean` as a pass, a score, a green check, or a
  correctness claim. The copy states what the check did.
- **S4** — The deterministic audit and the agent's self-reported checks
  (`buildVerdictFromTests`) are distinguishable on screen: which one is the
  parent's independent check is stated, not implied by placement.
- **S5** — Findings are rendered from the audit report itself, not from a derived
  summary, so a refusal is explicable from the UI alone.
- **S6** — The client branches on `blockedBy`, never on the text of `reason`.

## R — Regression

- **R1** — Every request that succeeds before this feature still succeeds after
  it, except arming a `schedule`/`poll`/`webhook` trigger for a `fail`-verdict
  script without an override.
- **R2** — The pre-feature suite passes unchanged, other than tests that
  deliberately encode the new refusal.
- **R3** — Each new wiring point, deleted individually, makes the suite fail.
