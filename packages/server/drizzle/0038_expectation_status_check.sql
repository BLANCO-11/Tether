-- The three states an expectation can be in, enforced by the database.
-- docs/GAPS.md §2.3 · D-68 · guardrail remediation F6
--
-- `flow_expectation_results.status` is a `varchar(16)` and the union it is
-- documented as holding — `passed` | `failed` | `unevaluable` — lived only in
-- TypeScript (`flow-expectation.service.ts`'s `ExpectationStatus`). The gate is
-- `status = 'passed'`, so the failure mode of a typo is silent and it points the
-- wrong way: a row written as `'pass'` never satisfies gate 1 and never says why,
-- and a row written as anything else is neither a pass, a failure, nor the
-- deliberate third state that must NOT satisfy the gate.
--
-- `workspace_members.role` is already constrained this way and `schema.ts` says
-- so in its own comment ("CHECK-constrained in the migration"); this is the same
-- discipline applied to the column a gate actually reads.
--
-- ⚠ VALID, not NOT VALID. Every existing row is already in the union (checked
-- before writing this: `passed` and `failed` only), and a NOT VALID constraint
-- would leave exactly the pre-existing bad rows this is meant to make impossible.
ALTER TABLE "flow_expectation_results"
  ADD CONSTRAINT "flow_expectation_results_status_check"
  CHECK ("status" IN ('passed', 'failed', 'unevaluable'));
