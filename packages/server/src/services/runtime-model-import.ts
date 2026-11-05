/**
 * One-off (2026-10-30): copy the runtime model settings ops-api held — gateway, key, enabled models, default — into
 * Foundry's own `runtime_model_provider`, so retiring ops-api keeps what was set on the AI models page.
 *
 *   pnpm --filter @foundry/server runtime-model:import
 *
 * Reads ops-api's `llm_provider` row from its database on the same Postgres (this process's DSN, database
 * `foundry_ops`) and opens the key the way ops-api sealed it (AES-256-GCM under a key derived from `OPS_API_KEY`).
 * Writes it encrypted under `CREDENTIAL_ENC_KEY`. Refuses to overwrite settings already saved here. Prints no key.
 */
import { createDecipheriv, createHash } from "node:crypto";
import pg from "pg";
import { eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { db, pool } from "../db/index.js";
import { runtimeModelProvider } from "../db/schema.js";
import { keyFingerprint, saveRuntimeProvider } from "./runtime-model.service.js";

function openOpsSealed(sealed: string, opsApiKey: string): string {
  const [iv, tag, enc] = sealed.split(":");
  if (!iv || !tag || !enc) throw new Error("the stored key is malformed");
  const key = createHash("sha256").update(`${opsApiKey}:ops-api:llm-provider:v1`).digest();
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

async function main() {
  const [existing] = await db.select({ id: runtimeModelProvider.id }).from(runtimeModelProvider).where(eq(runtimeModelProvider.id, 1));
  if (existing) {
    console.log("[runtime-model:import] settings are already saved here — nothing copied.");
    return;
  }
  const url = new URL(config.databaseUrl);
  url.pathname = "/foundry_ops";
  const ops = new pg.Client({ connectionString: url.toString() });
  await ops.connect();
  try {
    const r = await ops.query<{ base_url: string; api_key_enc: string | null; default_model: string; allowed_models: string[] }>(
      "SELECT base_url, api_key_enc, default_model, allowed_models FROM llm_provider WHERE id = 1",
    );
    const row = r.rows[0];
    if (!row) {
      console.log("[runtime-model:import] ops-api had no saved settings (it used the environment) — nothing copied.");
      return;
    }
    const apiKey = row.api_key_enc ? openOpsSealed(row.api_key_enc, config.opsApiKey) : undefined;
    const saved = await saveRuntimeProvider(
      { baseUrl: row.base_url, apiKey, defaultModel: row.default_model, allowedModels: Array.isArray(row.allowed_models) ? row.allowed_models : [] },
      "imported from ops-api",
    );
    console.log(
      `[runtime-model:import] copied: ${saved.baseUrl} · default ${saved.defaultModel || "(none)"} · ${saved.allowedModels.length} enabled · key ${apiKey ? keyFingerprint(saved.apiKey) : "(none stored; the environment's is used)"}`,
    );
  } finally {
    await ops.end();
  }
}

main()
  .catch((e) => {
    console.error(`[runtime-model:import] failed: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
