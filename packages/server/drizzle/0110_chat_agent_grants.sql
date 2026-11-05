-- Actions of a connected service switched on for ONE chat only (pi-builder/agent-grants.ts): Forge Agent may use them in
-- that conversation, and no automation or other chat gains them. A list of {piece, action, tool, via, grantedBy, at}.
ALTER TABLE "pi_chats" ADD COLUMN IF NOT EXISTS "agent_grants" jsonb NOT NULL DEFAULT '[]'::jsonb;
