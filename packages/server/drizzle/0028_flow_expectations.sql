-- docs/GAPS.md §2.3 — a flow declares what its own output should look like, and
-- gate 1 stops certifying "it ran".
--
-- The expectations themselves are NOT here. They live on the revision's
-- `model_json`, which is the one thing every path (`POST /flows`, an import, a
-- seed, the drafter, the canvas) already funnels through `writeRevision` — the
-- same argument that put D-22's expression allowlist and D-37's caps there. A
-- second table for them would be a second way to declare one, reachable without
-- the caps.
--
-- What IS here is the RESULT of evaluating them against one run.

CREATE TABLE IF NOT EXISTS "flow_expectation_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "flow_execution_id" uuid NOT NULL
    REFERENCES "flow_executions"("id") ON DELETE CASCADE,

  -- Denormalised so gate 1 is one query. Nullable for the same reason
  -- `flow_executions.flow_id` is: a deleted flow leaves its history behind.
  "flow_id" uuid REFERENCES "flows"("id") ON DELETE SET NULL,

  -- The author's own name for this expectation, from the model.
  "expectation_id" varchar(63) NOT NULL,

  -- ⚠ The load-bearing column, and the reason gate 1 does not simply ask "did
  -- the last run pass". It is a hash over (stepId, select, assert) — WHAT was
  -- claimed, not which revision claimed it.
  --
  -- Gate 1 has always been per FLOW and not per revision, deliberately: asking
  -- it per revision re-blocks arming after a one-line edit, and a gate that is
  -- friction is a gate that gets switched off. But "any succeeded run" cannot be
  -- right either once a flow can declare a claim, because a run that predates
  -- the claim never tested it.
  --
  -- Keying on the claim's CONTENT is the middle: editing a step, renaming the
  -- flow or adding an unrelated expectation leaves every other key untouched, so
  -- nothing re-blocks; adding or changing a claim produces a key no run has
  -- satisfied, so that one does.
  "expectation_key" varchar(64) NOT NULL,

  "step_id" varchar(255) NOT NULL,

  -- passed | failed | unevaluable.
  --
  -- ⚠ `unevaluable` is a real state and it does NOT satisfy the gate. A step
  -- whose output could not be read as rows is a claim nobody checked, and the
  -- one thing it must not read as is a claim that held. Recorded rather than
  -- retried for ever because its causes are structural — a `select` naming a key
  -- that is not there does not get better on the next read.
  "status" varchar(16) NOT NULL,

  -- ⚠ Populated on a PASS as well, and that is not decoration. `verifyTaxonomy`
  -- earned this rule in Stage 4: a "yes" with no values behind it is
  -- unfalsifiable, and the reader cannot tell a check that ran from a check that
  -- found nothing to look at.
  "detail" text NOT NULL,

  -- What was actually compared, bounded. The failure message names the fix; this
  -- is the evidence for it.
  "observed_json" jsonb,

  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One result per (run, expectation). Evaluation is idempotent and first-write-
-- wins: a run's outputs are immutable, so a second answer to the same question
-- would mean one of the two is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS "flow_expectation_results_run_expectation_idx"
  ON "flow_expectation_results" ("flow_execution_id", "expectation_id");

-- Gate 1's query: every current key, satisfied by some succeeded run of this flow.
CREATE INDEX IF NOT EXISTS "flow_expectation_results_gate_idx"
  ON "flow_expectation_results" ("flow_id", "expectation_key", "status");
