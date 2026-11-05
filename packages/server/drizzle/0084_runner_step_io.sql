-- pi-runtime P4 (plans/pi-runtime-2026-10-09): a step's record says what it was GIVEN and what it PRINTED, not only
-- what it returned. Without them a run page shows an output with no way to see why it is what it is (a test default
-- outside the data, a filter that matched nothing). Both are redacted before they are written, like output_json.
alter table runner_step_results add column if not exists input_json jsonb;
alter table runner_step_results add column if not exists logs text;
