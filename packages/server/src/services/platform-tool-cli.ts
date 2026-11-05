/**
 * `pnpm --filter @foundry/server mail:register` — backfill the platform tools.
 * email-send-tool · T033
 *
 * ── Why a script and not a migration ─────────────────────────────────────────
 *
 * Registering a tool is not a schema change: it writes rows through
 * `toolService`, whose validation (params-schema shape, auth-style rules,
 * secret-collision checks) is the thing that makes the row *correct*. A migration
 * writing the same rows in raw SQL would bypass all of it and drift the moment the
 * schema for a tool changes.
 *
 * `workspaceService.create` registers for every NEW workspace (T032). This is for
 * the ones that already existed — and for after a `PARENT_API_KEY` rotation, when
 * the derived `FOUNDRY_MAIL_KEY` changes and every stored copy has to be re-put or
 * every email step answers 401.
 *
 * Idempotent: safe to run any number of times, prints what it created versus
 * updated, and exits non-zero only if something actually failed.
 */
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { isNull } from "drizzle-orm";
import { config } from "../config/index.js";
import { registerPlatformTools } from "./platform-tool-catalogue.js";

async function main() {
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(isNull(workspaces.deletedAt));

  if (rows.length === 0) {
    console.log("[mail:register] no workspaces — nothing to do");
    return;
  }

  console.log(`[mail:register] ${rows.length} workspace(s)`);
  /**
   * Reported first, and reported whatever the outcome. Registration deliberately
   * succeeds on an unconfigured deployment (the tool answers `424` naming the
   * missing variables, which is more useful than not existing) — but an operator
   * running this should be told that is the state they are in, rather than reading
   * a clean run as "email works now".
   */
  if (!config.mail.configured) {
    console.log(
      `[mail:register] ⚠ Graph is NOT configured — missing: ${config.mail.missing.join(", ")}. ` +
        "The tool is still registered; it will answer 424 naming these until they are set.",
    );
  }
  if (!config.mail.enabled) {
    console.log("[mail:register] ⚠ MAIL_ENABLED=false — the tool will answer 409 until unset.");
  }

  let failures = 0;
  for (const ws of rows) {
    try {
      const r = await registerPlatformTools(ws.id);
      const what = [
        r.created.length ? `created ${r.created.join(", ")}` : null,
        r.updated.length ? `updated ${r.updated.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      console.log(
        `  ✓ ${ws.name} (${ws.id}) — ${what || "nothing to change"}; ` +
          `secret put; manifest v${r.manifestVersion ?? "?"}`,
      );
    } catch (e) {
      failures++;
      console.error(`  ✗ ${ws.name} (${ws.id}) — ${(e as Error).message}`);
    }
  }

  if (failures > 0) {
    console.error(`[mail:register] ${failures} workspace(s) failed`);
    process.exitCode = 1;
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
