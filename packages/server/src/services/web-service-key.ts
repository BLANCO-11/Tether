/**
 * The key the built-in `web_fetch` tool presents to Foundry's own `/api/web/fetch` (2026-10-30). Derived from
 * `PARENT_API_KEY` like the mail key (`mail-service-key.ts`), so no new secret exists — and it is not the parent key,
 * which must never ride on a tool row. `platform:tools` re-puts it after a rotation.
 */
import { createHmac } from "node:crypto";
import { config } from "../config/index.js";

export const WEB_SECRET_ENV = "FOUNDRY_WEB_KEY";

/** The header the endpoint reads it from. Never `Authorization` — that is the parent API's. */
export const WEB_KEY_HEADER = "X-Foundry-Web-Key";

export function webServiceKey(root = config.parentApiKey): string {
  return createHmac("sha256", root).update("foundry-web:v1").digest("hex").slice(0, 40);
}
