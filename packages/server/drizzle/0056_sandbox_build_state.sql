-- Sandbox provisioning becomes automatic at onboarding, so it needs a state a
-- person and a poller can read while it is happening.
--
-- ⚠ A COLUMN AND NOT AN IN-MEMORY JOB. Generation takes ~100s per datasource.
-- Held in memory, a server restart mid-build loses the job: the build never
-- resumes and the panel reverts to "no sandbox", which is TRUE but silently
-- drops work somebody is waiting for. A row survives the restart and can say
-- "started at, and nothing has touched it since".
--
-- ⚠ `failed` IS A STATE AND MUST NOT COLLAPSE INTO `none`. They mean different
-- things and need different actions: `none` is "nobody has asked", `failed` is
-- "we asked and it did not work, here is why". Rendering the second as the
-- first is the faFallback mistake — an absence standing in for an error.
-- Neither satisfies `hasSandbox`, so a draft run still reads production and
-- still says so in both cases.
ALTER TABLE datasources
  ADD COLUMN IF NOT EXISTS sandbox_build_status varchar(16),
  ADD COLUMN IF NOT EXISTS sandbox_build_error text,
  ADD COLUMN IF NOT EXISTS sandbox_build_started_at timestamptz;

-- The same discipline as workspace_members.role and
-- flow_expectation_results.status: the union is enforced in the DATABASE, not
-- only in TypeScript. A typo'd value is otherwise a state nothing can ever
-- reach and nothing reports — VALID rather than NOT VALID because every
-- existing row is NULL, so there is nothing to grandfather in.
ALTER TABLE datasources
  DROP CONSTRAINT IF EXISTS datasources_sandbox_build_status_check;
ALTER TABLE datasources
  ADD CONSTRAINT datasources_sandbox_build_status_check
  CHECK (sandbox_build_status IS NULL
      OR sandbox_build_status IN ('building', 'ready', 'failed'));
