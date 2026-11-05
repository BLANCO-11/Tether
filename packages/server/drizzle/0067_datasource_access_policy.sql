-- Datasource access policy — what a datasource is ALLOWED to do, declared at
-- onboarding and enforced at execution.
--
-- ⚠ THIS REPLACES A REFUSAL WITH A CONTROL, and the distinction is the point.
-- Until now `datasource.service.ts` refused any credential that could write
-- (D-40, Stage 9.2). That is a strong gate and it has one failure mode: a
-- tenant whose only credential is an administrator cannot onboard at all, so
-- the workaround is to create a role — and the people who cannot do that route
-- around the product instead.
--
-- The policy is enforced where it cannot be argued with: a `read` datasource
-- runs its statements inside `BEGIN READ ONLY`, and Postgres refuses every
-- write itself, regardless of what the credential is granted. So an admin
-- credential on a `read` datasource is safe in a way a declaration alone never
-- is.
--
-- ⚠ DEFAULT 'read', NOT NULL. Every existing row is a datasource registered
-- under the old gate, which means it was PROVEN read-only at registration —
-- 'read' is not a guess about them, it is what was verified. And a new column
-- that defaulted to anything wider would silently widen every datasource on
-- the deployment at migration time.
ALTER TABLE "datasources"
  ADD COLUMN IF NOT EXISTS "access_policy" varchar(16) NOT NULL DEFAULT 'read';
--> statement-breakpoint

-- ⚠ VALID, not NOT VALID — the same call as `0038_expectation_status_check`.
-- Every existing row carries the default, so there is nothing to grandfather;
-- a NOT VALID constraint would exempt exactly the rows a future bug would
-- write. The gate reads this column to decide whether to open a read-only
-- transaction, so a value outside the set is neither a policy nor a refusal.
ALTER TABLE "datasources"
  ADD CONSTRAINT "datasources_access_policy_check"
  CHECK ("access_policy" IN ('read', 'read_write', 'full'));
--> statement-breakpoint

-- What the CREDENTIAL was measured to be able to do at registration, as
-- against what the policy ALLOWS. Two different facts, deliberately two
-- columns: the policy is a decision and this is an observation, and collapsing
-- them would lose the case this feature exists for — an administrator
-- credential on a read-only datasource, where they disagree and that is fine.
-- Nullable: unknown for rows registered before this column, and for a target
-- that could not be probed.
ALTER TABLE "datasources"
  ADD COLUMN IF NOT EXISTS "credential_can_write" boolean;
