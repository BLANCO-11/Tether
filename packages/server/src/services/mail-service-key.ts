/**
 * The credential the mail endpoint accepts — derived, never distributed.
 * email-send-tool · plan.md Decision 5
 *
 * ── Why the endpoint has a credential of its own ─────────────────────────────
 *
 * `POST /api/mail/send` is called by the step executor like any other tool, which
 * means whatever credential it presents is stored in `workspace_secrets` and rides
 * along on **every email step in every flow**. So it must not be
 * `PARENT_API_KEY`: that key authorises the whole parent API, and putting it in a
 * workspace secret would make the master credential readable by anything that can
 * read a workspace's secrets, and present on every email step for the rest of
 * time.
 *
 * ── Derived, exactly as `opsServiceKey` is ───────────────────────────────────
 *
 * `HMAC_SHA256(PARENT_API_KEY, "foundry-mail:v1")`, first 40 hex chars. Same
 * construction as the five ops-api service keys, for the same three reasons:
 * nothing new to generate, nothing new to commit, and rotation follows
 * `PARENT_API_KEY` without a second procedure to remember.
 *
 * ⚠ It is derived from the parent key but is **not** the parent key, and that is
 * the whole point: holding it buys `POST /api/mail/send` and nothing else. The
 * derivation is one-way, so a leaked mail key does not yield `PARENT_API_KEY`.
 *
 * ⚠ **Rotating `PARENT_API_KEY` changes this value**, so the stored
 * `FOUNDRY_MAIL_KEY` workspace secret must be re-put — `mail:register` is
 * idempotent and does exactly that. Until it is re-run, email steps answer `401`.
 * Same operational property the ops-api keys already have; stated here so it is
 * not discovered during an incident.
 */
import { createHmac } from "node:crypto";
import { config } from "../config/index.js";

/**
 * The env-var name the tool row points at, and the key in `workspace_secrets`.
 *
 * ⚠ Deliberately **not** `MAIL_API_KEY` — that name is already taken by the
 * *simulated* mail service's workspace secret. A collision there would trip
 * `shadowedSecretCollisions` and fail the step with a confusing `409` about a
 * secret the author never touched.
 */
export const MAIL_SECRET_ENV = "FOUNDRY_MAIL_KEY";

/** The header the endpoint reads it from. Never `Authorization` — that is the parent API's. */
export const MAIL_KEY_HEADER = "X-Foundry-Mail-Key";

export function mailServiceKey(root = config.parentApiKey): string {
  return createHmac("sha256", root).update("foundry-mail:v1").digest("hex").slice(0, 40);
}
