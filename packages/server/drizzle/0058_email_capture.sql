-- A DRAFT run's email is CAPTURED, never delivered.
--
-- ⚠ Why a fourth outcome rather than reusing one of the three.
--
-- `email_sends.outcome` was `sent | refused | failed`, and the column's own
-- comment in `schema.ts` says the three are not interchangeable and that a
-- future writer must not invent a fourth value "that every reader then has to
-- guess about". This is that fourth value, arriving with the guess removed:
--
--   sent      Graph accepted it. A person received it.
--   refused   Foundry declined before contacting Microsoft. The fix is here.
--   failed    Graph was contacted and did not accept. The fix is at Microsoft.
--   captured  Foundry deliberately did not contact Microsoft, because the run
--             is a DRAFT run. Nothing was refused and nothing failed — the
--             message is complete, addressed, rendered, and held in the Email
--             box for whoever is testing.
--
-- Reusing `refused` would file a working automation under "declined", and
-- reusing `sent` would claim a delivery that did not happen — which is the
-- false green this whole area is about.
--
-- ⚠ VALID, not NOT VALID. Every existing row was checked first: only `sent`,
-- `refused` and `failed` are present, so there is nothing to grandfather in —
-- and a NOT VALID constraint would grandfather in exactly the rows a constraint
-- like this exists to prevent (0038's reasoning, applied again).
alter table email_sends drop constraint if exists ck_email_sends_outcome;
alter table email_sends
  add constraint ck_email_sends_outcome
  check (outcome in ('sent', 'refused', 'failed', 'captured'));

-- The rendered message, held ONLY for a captured send.
--
-- ⚠ This does not weaken the existing property. `failure_reason`'s rule —
-- never the body, never the credential — is about a column that is written on
-- every refusal and every failure, including for real deliveries. This column
-- is written on exactly one path: a draft run, whose recipients are a test
-- address and whose content is the thing the person testing needs to read. A
-- real send still stores no body at all, which is checkable by grepping the one
-- writer.
alter table email_sends add column if not exists captured_body text;

comment on column email_sends.captured_body is
  'The rendered HTML, stored ONLY when outcome = captured (a draft run). NULL for every delivered, refused or failed send — a real send stores no body.';
