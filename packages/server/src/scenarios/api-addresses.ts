/**
 * `pnpm api:addresses` — every workflow has an API address.
 *
 * ── Why this script exists ──────────────────────────────────────────────────
 *
 * Asked for directly: *"every workfow ever that is published should be able to
 * be called using api"*.
 *
 * An address in Foundry is a `triggers` row of type `api`; the URL is
 * `/api/triggers/<token>/api`. `ensureApiAddress` now runs at flow creation and
 * again at publish, so every flow made from 2026-09-08 onward has one. This
 * script is for the flows that already existed — measured at the time, **14 of
 * them, none with an api trigger**, every one of which showed *"This automation
 * has no API trigger, so there is no URL to call it on"* on its API tab.
 *
 * ── ⚠ WHAT IT DOES AND DOES NOT DO ─────────────────────────────────────────
 *
 * ⚠ **It creates DISABLED rows and enables nothing.** An `api` trigger's
 * receiver checks `enabled` and answers 404, so nothing this script writes can
 * fire. Enabling stays where it was: publishing does it, through
 * `_armDeclaredCapacity`, which asks gate 1 — one succeeded run — and obeys it.
 * A script that enabled them would be the way round that gate, and the gate's
 * reason is a measured script that reported `tests_passed=true` and emailed 0
 * of 11 people.
 *
 * ⚠ **It is IDEMPOTENT and safe to re-run.** `ensureApiAddress` is idempotent
 * by type, so a second run creates nothing. It is also therefore not a
 * migration: nothing is altered, only added, and undoing it is deleting the
 * rows it names.
 *
 * ⚠ **It touches no armed flow's behaviour.** Adding an address changes no
 * step, no revision and no fingerprint — `refFingerprints` hashes tools,
 * queries and operations, and a trigger row is none of those. The staleness
 * sweep therefore cannot see this.
 *
 * ⚠ It does NOT skip soft-deleted flows explicitly, because `flowRepo.list`
 * does not return them.
 */
import { pool } from "../db/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { ensureApiAddress } from "../services/flow-api-address.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const workspaces = await workspaceRepo.list();
  let created = 0;
  let already = 0;

  for (const ws of workspaces) {
    const flows = await flowRepo.listByWorkspace(ws.id);
    for (const flow of flows) {
      if (dryRun) {
        // Read-only: report what WOULD happen. The check is the same one
        // `ensureApiAddress` makes, and it is deliberately not shared with it —
        // this arm must not be able to write.
        const { triggerRepo } = await import("../repositories/trigger.repo.js");
        const has = (await triggerRepo.listByFlow(flow.id)).some((t) => t.type === "api");
        console.log(`${has ? "has    " : "WOULD  "} ${ws.name} / ${flow.name}`);
        has ? already++ : created++;
        continue;
      }
      const { trigger, created: made } = await ensureApiAddress(ws.id, flow);
      if (made) {
        created++;
        console.log(`created  ${ws.name} / ${flow.name}  ->  "${trigger.name}" (disabled)`);
      } else {
        already++;
      }
    }
  }

  console.log(
    `\n${dryRun ? "DRY RUN — " : ""}${created} address${created === 1 ? "" : "es"} ` +
      `${dryRun ? "would be created" : "created"}, ${already} already had one.`,
  );
  if (!dryRun && created > 0) {
    console.log(
      "⚠ All created DISABLED — the receiver answers 404 until publishing enables them, " +
        "which requires one succeeded run (gate 1).",
    );
  }
  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
