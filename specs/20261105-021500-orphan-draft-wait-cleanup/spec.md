# Orphan draft wait cleanup

## Problem
Unsaved Forge draft tests (`flow_id` null, engine slug `pi-adhoc`) pause at approval gates that never appear in Approvals (inbox requires a flow). When the Forge session ends or the server restarts, those waits stay `waiting` and Activity shows them under RUNNING NOW forever.

## Requirements
1. Cancel the stranded waiting draft run already present (ops).
2. On API process boot, cancel every waiting runner execution with null `flow_id` (same claim as orphaned sandbox trees: sessions from the prior process are gone).
3. Hourly expiry sweep: unsaved draft waits older than `FLOW_DRAFT_ORPHAN_WAIT_MS` (default 2h) are cancelled; saved-flow waits keep the existing 7-day expire-as-`expired` path.
4. When a Forge session is destroyed, cancel its last test run if still waiting.
5. Starting a new test cancels a prior waiting test on that session.

## Out of scope
Changing Approvals to list flowless gates; Kestra-backed waits.

## Follow-on (same feature): edge background chat
1. Do not dump background edge job stdout into the chat transcript — the Approve card already shows the result.
2. When an edge job settles, automatically continue Forge with the result so the person does not have to say "okay".
3. While an edge Approve card is pending (or the job is running on the device), the header must not say Ready.
