/**
 * `pnpm --filter @foundry/server sandbox:{status,provision,rebuild,teardown}`
 * DECISIONS.md D-52…D-54 · ISSUES.md I-54…I-56
 *
 * ── Why provisioning is a command and not a button ───────────────────────────
 *
 * It generates rows with a model (minutes), drops and recreates a database, and
 * creates a login role. That is exactly the shape of `POST /api/demo/provision`,
 * which Stage 1 deleted for being "a destructive reseed from one authenticated
 * request" — and the flag that used to gate it had to be ON wherever the danger
 * was real. Running a command in the repo is the opt-in that flag was standing
 * in for. The HTTP surface is `GET …/datasources/:id/sandbox`, and it reads.
 */
import { and, eq } from "drizzle-orm";
import { config } from "../config/index.js";
import { db, pool } from "../db/index.js";
import { datasources, workspaces } from "../db/schema.js";
import { inference } from "../services/inference.service.js";
import { SandboxError, sandboxService } from "../services/sandbox.service.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/** Resolve `--workspace` (id or name) and `--datasource` (id or name) to ids. */
async function resolveTarget(): Promise<{ workspaceId: string; datasourceId: string; label: string }> {
  const wsArg = arg("workspace");
  const dsArg = arg("datasource");
  if (!wsArg) throw new Error("--workspace=<id|name> is required");

  const all = await db.select().from(workspaces);
  const ws = all.find((w) => w.id === wsArg || w.name === wsArg);
  if (!ws) {
    throw new Error(
      `no workspace "${wsArg}". Known: ${all.map((w) => `${w.name} (${w.id})`).join(", ")}`,
    );
  }
  const list = await db.select().from(datasources).where(eq(datasources.workspaceId, ws.id));
  if (list.length === 0) throw new Error(`workspace "${ws.name}" has no datasources`);
  const ds = dsArg ? list.find((d) => d.id === dsArg || d.name === dsArg) : list[0];
  if (!ds) {
    throw new Error(
      `no datasource "${dsArg}" in "${ws.name}". Known: ${list.map((d) => d.name).join(", ")}`,
    );
  }
  return { workspaceId: ws.id, datasourceId: ds.id, label: `${ws.name} / ${ds.name}` };
}

function printStatus(s: Awaited<ReturnType<typeof sandboxService.status>>): void {
  if (!s) return;
  if (!s.hasSandbox) {
    console.log(`✗ ${s.datasourceName}: NO SANDBOX`);
    console.log(`  ${s.exposure}`);
    return;
  }
  console.log(`✓ ${s.datasourceName}: sandbox ${s.dbName}, fixture v${s.fixtureVersion}`);
  console.log(
    `  frozen ${s.frozenAt?.toISOString()} · written by ${s.generatedBy}` +
      (s.model ? ` (${s.model})` : ""),
  );
  for (const i of s.taxonomy?.items ?? []) {
    console.log(`  ${i.satisfied ? "✓" : "✗"} ${i.id.padEnd(17)} ${i.evidence ?? i.title}`);
  }
  if (s.drift) {
    console.log(
      `  ⚠ SCHEMA DRIFT: the fixture was written for ${s.drift.was}, the source is now ` +
        `${s.drift.now}. This sandbox is testing a shape production no longer has — regenerate it.`,
    );
  }
}

async function main() {
  const cmd = process.argv[2] ?? "status";

  if (cmd === "status" && !arg("workspace")) {
    // No target: report EVERY datasource, because the interesting answer is the
    // list of the ones with no sandbox, and asking one at a time never surfaces it.
    const rows = await db.select().from(datasources);
    const wss = await db.select().from(workspaces);
    let exposed = 0;
    for (const d of rows) {
      const ws = wss.find((w) => w.id === d.workspaceId);
      const s = await sandboxService.status(d.workspaceId, d.id);
      console.log(`\n── ${ws?.name ?? d.workspaceId} / ${d.name} ──`);
      printStatus(s);
      if (s && !s.hasSandbox) exposed++;
    }
    console.log(
      `\n${rows.length - exposed} of ${rows.length} datasource(s) have a sandbox; ` +
        `${exposed} would have a DRAFT run read production.`,
    );
    return;
  }

  const target = await resolveTarget();
  switch (cmd) {
    case "status":
      printStatus(await sandboxService.status(target.workspaceId, target.datasourceId));
      break;

    case "provision": {
      const rows = arg("rows") ? Number(arg("rows")) : undefined;
      console.log(`provisioning a sandbox for ${target.label}`);
      console.log(`  the model writes rows from the SCHEMA ONLY — it is never shown real data`);
      const t0 = Date.now();
      const { status, shape, taxonomy } = await sandboxService.provision({
        ...target,
        inference,
        rows,
        modelName: config.inference.model || null,
        onProgress: (m) => console.log(`  · ${m}`),
      });
      console.log(
        `\n✓ ${shape.tables.length} table(s) materialised in ${Math.round((Date.now() - t0) / 1000)}s, ` +
          `${taxonomy.items.filter((i) => i.satisfied).length}/${taxonomy.items.length} edge cases present`,
      );
      printStatus(status);
      break;
    }

    case "rebuild": {
      // Proves the freeze is real: no inference, rows replayed from the parent DB.
      const report = await sandboxService.rematerialise(target.workspaceId, target.datasourceId);
      console.log(
        `✓ rebuilt from the frozen fixture — ${report.items.filter((i) => i.satisfied).length}/` +
          `${report.items.length} edge cases still present, integrity ${report.integrity.ok ? "ok" : "BROKEN"}`,
      );
      break;
    }

    case "teardown":
      await sandboxService.teardown(target.workspaceId, target.datasourceId);
      console.log(
        `✓ dropped the sandbox for ${target.label}. The frozen fixture is KEPT — ` +
          `\`sandbox:rebuild\` restores it without asking a model again.`,
      );
      break;

    default:
      console.error(`unknown command "${cmd}"; use status | provision | rebuild | teardown`);
      process.exit(2);
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    if (e instanceof SandboxError) {
      console.error(`\n✗ ${e.message}`);
      for (const d of (e.detail as string[] | undefined) ?? []) console.error(`  - ${d}`);
    } else {
      console.error(e);
    }
    await pool.end().catch(() => {});
    process.exit(1);
  });
