-- Per-flow chat configurability (Phase 5) — what the chat column remembers.
--
-- Until now a conversation ran on the deployment's resolved default with the
-- code-owned `CHAT_RULES` and nothing else; there was nowhere to keep "draft
-- this flow on model X" or "always call requisitions 'reqs'".
--
-- ⚠ **It is stored on the FLOW, not on the thread and not on a revision.**
-- The thread is the conversation; the flow is the thing the settings describe,
-- and a scope/model/instructions choice made today must still govern tomorrow's
-- thread. A revision is an immutable snapshot of the MODEL — approval binds to
-- it (§6.5) — and this is design-time intent about the conversation, not part
-- of what runs: it does not compile to YAML, it is not in
-- `refFingerprints()`, and editing it moves no fingerprint and suspends
-- nothing. Same seat as `design_selection` (0030), same NULL contract.
--
-- ⚠ **NULL is a real value and is not "the default was chosen".** It means
-- nobody configured the chat, and the read path (`parseChatConfig`) treats an
-- unparseable row the same way: a turn never crashes on a value an older build
-- or a hand edit left behind.
--
-- Shape: {"model": "…"/null, "instructions": "…"/null, "suggestions": bool}

ALTER TABLE "flows"
  ADD COLUMN IF NOT EXISTS "chat_config" jsonb;
