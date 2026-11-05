/**
 * The key the built-in `llm_complete` tool presents to Foundry's own `/api/llm/complete` (2026-10-30; it presented an
 * ops-api service key before). Derived from `PARENT_API_KEY` like the mail and web keys, so no new secret exists — and
 * it is not the parent key, which must never ride on a tool row. `platform:tools` re-puts it after a rotation.
 */
import { createHmac } from "node:crypto";
import { config } from "../config/index.js";

export const LLM_SECRET_ENV = "FOUNDRY_LLM_KEY";

/** The header the endpoint reads it from. Never `Authorization` — that is the parent API's. */
export const LLM_KEY_HEADER = "X-Foundry-Llm-Key";

export function llmServiceKey(root = config.parentApiKey): string {
  return createHmac("sha256", root).update("foundry-llm:v1").digest("hex").slice(0, 40);
}
