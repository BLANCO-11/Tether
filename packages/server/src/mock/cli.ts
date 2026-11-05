/**
 * Mock rebuild trigger — the re-onboard path for pre-existing datasources.
 *
 * No backfill job: existing DBs keep hard-refusing tests until they are
 * rebuilt, deliberately and announced (runbook), not as a surprise outage.
 *
 *   Single datasource:
 *     tsx src/mock/cli.ts --workspace=<id|name> --datasource=<id|name>
 *   Every datasource in one workspace:
 *     tsx src/mock/cli.ts --workspace=<id|name> --all
 *   Every datasource in every workspace (the deploy runbook step):
 *     tsx src/mock/cli.ts --all
 *
 * Each target gets a forced fresh version (`rebuildMockDataset`, bypassing the
 * already-has guard — rebuilding over synthetic rows is the point, not the
 * destructive case). Refusals land as loud `failed` fixtures rows and are
 * printed per datasource; the command exits 0 unless no target resolved or the
 * database itself was unreachable.
 */

import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { datasources, workspaces } from "../db/schema.js";
import { rebuildMockDataset } from "../services/mock-dataset.service.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface Target {
  workspaceId: string;
  workspaceName: string;
  datasourceId: string;
  datasourceName: string;
}

async function resolveTargets(): Promise<Target[]> {
  const wsArg = arg("workspace");
  const dsArg = arg("datasource");
  const all = hasFlag("all");

  if (!wsArg && !all) {
    throw new Error("pass --workspace=<id|name> with --datasource=<id|name>, or --all");
  }
  if (dsArg && all) {
    throw new Error("pass either --datasource=<id|name> or --all, not both");
  }

  const allWorkspaces = await db.select().from(workspaces);
  const wantedWorkspaces = wsArg
    ? allWorkspaces.filter((w) => w.id === wsArg || w.name === wsArg)
    : allWorkspaces;
  if (wsArg && wantedWorkspaces.length === 0) throw new Error(`workspace "${wsArg}" not found`);
  if (wantedWorkspaces.length === 0) throw new Error("no workspaces found");

  const targets: Target[] = [];
  for (const ws of wantedWorkspaces) {
    const list = await db
      .select()
      .from(datasources)
      .where(eq(datasources.workspaceId, ws.id));
    if (dsArg) {
      const ds = list.find((d) => d.id === dsArg || d.name === dsArg);
      if (!ds) throw new Error(`datasource "${dsArg}" not found in workspace "${ws.name}"`);
      targets.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        datasourceId: ds.id,
        datasourceName: ds.name,
      });
    } else {
      for (const ds of list) {
        targets.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          datasourceId: ds.id,
          datasourceName: ds.name,
        });
      }
    }
  }
  if (targets.length === 0) throw new Error("no datasources matched");
  return targets;
}

async function main() {
  const targets = await resolveTargets();
  let ready = 0;
  let refused = 0;
  for (const t of targets) {
    const outcome = await rebuildMockDataset(t.workspaceId, t.datasourceId).catch((e) => ({
      started: false as const,
      why: "build_failed" as const,
      detail: (e as Error).message,
    }));
    if (outcome.started) {
      ready++;
      console.log(`ok   ${t.workspaceName} / ${t.datasourceName} → ready (v${outcome.version})`);
    } else {
      refused++;
      console.log(
        `fail ${t.workspaceName} / ${t.datasourceName} → ${outcome.why}${outcome.detail ? `: ${outcome.detail}` : ""}`,
      );
    }
  }
  console.log(`\nmock rebuild: ${ready} ready, ${refused} refused, ${targets.length} total`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
