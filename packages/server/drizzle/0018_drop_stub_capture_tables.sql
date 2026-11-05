-- Stage 5: the tool layer moved to `packages/ops-api`, and its four capture
-- tables moved with it — into that service's OWN database, as `mail_outbox`,
-- `chat_messages`, `tickets` and `api_call_log`.
--
-- ⚠ THIS DROPS DATA, and there is no back-fill. What is lost is synthetic
-- capture history: mail nobody received, chat nobody read, tickets nobody
-- worked, and the call log of demo runs. `demo:reset` truncated all four
-- routinely, so nothing here was ever treated as durable. A back-fill would
-- also have to cross a boundary this migration exists to create.
--
-- Nothing in `packages/server` references these tables after this migration:
--
--   grep -rn "stub_mail_outbox\|stub_chat_messages\|stub_tickets\|stub_call_log" packages/server/src

DROP TABLE "stub_call_log" CASCADE;--> statement-breakpoint
DROP TABLE "stub_chat_messages" CASCADE;--> statement-breakpoint
DROP TABLE "stub_mail_outbox" CASCADE;--> statement-breakpoint
DROP TABLE "stub_tickets" CASCADE;