/**
 * `heldout:seed` — compiled-builder phase 1 (D-311, D-313).
 *
 *   pnpm --filter @foundry/server heldout:seed
 *
 * 1. The HELD-OUT workspace `Fleet Telemetry` on `fleet_demo`: schema-only, no sandbox (its rows would be
 *    model-generated), the deterministic mock built and awaited.
 * 2. SCHEMA-ONLY TWINS of two tuned workspaces: the SAME databases (`orders_demo`, `support_demo`) registered in
 *    NEW workspaces with no saved readers, so curated vs schema-only is measured on identical data. The demo
 *    workspaces are not touched, and nothing is deleted.
 * 3. Asserts, from the database, that each of the three workspaces holds ZERO named queries and ZERO saved DB
 *    operations. A "schema-only" claim nobody checked is how a reader leaks in.
 * 4. The isolation pass, last (seeding one domain changes what the others can reach).
 */
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { provisionDomain } from "../generic/provision.js";
import { checkRoleIsolation } from "../generic/domain.js";
import { ORDERS_DOMAIN, SUPPORT_DOMAIN } from "../generic/index.js";
import { FLEET_DOMAIN } from "./fleet.js";

import { SCHEMA_ONLY_TWINS } from "./seal.js";
import { workspaceRepo } from "../../repositories/workspace.repo.js";
import { toolRepo } from "../../repositories/tool.repo.js";
import { createToolSchema, toolService } from "../../services/tool.service.js";
import { manifestBuilderService } from "../../services/manifest-builder.service.js";

/**
 * A twin must differ from its curated workspace in READERS ONLY. The lean catalogue gives it 5 tools, and the curated
 * workspace carries 5 older ones as well, so the curated workspace's exact tool rows are copied across. Without this,
 * curated vs schema-only would also measure a different tool set.
 */
async function matchTools(twinId: string, sourceName: string): Promise<{ copied: string[]; equal: boolean }> {
  const source = (await workspaceRepo.list()).find((w) => w.name === sourceName && !w.deletedAt);
  if (!source) throw new Error(`curated workspace "${sourceName}" not found`);
  const want = await toolRepo.listByWorkspace(source.id);
  const have = new Set((await toolRepo.listByWorkspace(twinId)).map((t) => t.name));
  const copied: string[] = [];
  for (const t of want) {
    if (have.has(t.name)) continue;
    await toolService.create(twinId, createToolSchema.parse({
      name: t.name, description: t.description ?? undefined, url: t.url ?? undefined, method: t.method ?? undefined,
      paramsSchema: t.paramsSchema ?? undefined, secretEnvName: t.secretEnvName ?? null, authStyle: t.authStyle ?? null,
      authParamName: t.authParamName ?? null,
    }));
    copied.push(t.name);
  }
  if (copied.length) await manifestBuilderService.buildAndPersist(twinId);
  const after = new Set((await toolRepo.listByWorkspace(twinId)).map((t) => t.name));
  const equal = after.size === want.length && want.every((t) => after.has(t.name));
  return { copied, equal };
}
const TWINS = [
  { spec: ORDERS_DOMAIN, workspaceName: SCHEMA_ONLY_TWINS[0]!, seed: false },
  { spec: SUPPORT_DOMAIN, workspaceName: SCHEMA_ONLY_TWINS[1]!, seed: false },
];

async function readerCount(workspaceId: string): Promise<{ queries: number; operations: number }> {
  const q = await db.execute(sql`select count(*)::int as n from datasource_queries x join datasources d on d.id = x.datasource_id where d.workspace_id = ${workspaceId}`);
  const o = await db.execute(sql`select count(*)::int as n from datasource_operations where workspace_id = ${workspaceId}`);
  const n = (r: unknown) => Number(((r as { rows?: Array<{ n: number }> }).rows ?? (r as Array<{ n: number }>))[0]!.n);
  return { queries: n(q), operations: n(o) };
}

async function main() {
  let failures = 0;
  const targets = [{ spec: FLEET_DOMAIN, workspaceName: FLEET_DOMAIN.workspaceName, seed: true }, ...TWINS];
  for (const t of targets) {
    const r = await provisionDomain(t.spec, { workspaceName: t.workspaceName, sandbox: false, seed: t.seed });
    const match = t.seed ? null : await matchTools(r.workspaceId, t.spec.workspaceName);
    if (match) console.log(`   tools matched to "${t.spec.workspaceName}": copied ${match.copied.join(", ") || "none"} → ${match.equal ? "IDENTICAL" : "DIFFERENT"}`);
    if (match && !match.equal) failures++;
    const readers = await readerCount(r.workspaceId);
    const schemaOnly = readers.queries === 0 && readers.operations === 0;
    const role = r.seed.role;
    const roleOk = role.canSelect && role.writeGrants.length === 0;
    console.log(
      `${t.workspaceName.padEnd(36)} ${r.workspaceId} ${r.workspaceCreated ? "(created)" : "(reused)"}\n` +
        `   tables ${r.datasource.tables} · columns ${r.datasource.columns} · tools ${r.tools.total} · ` +
        `readers ${readers.queries} queries / ${readers.operations} operations → ${schemaOnly ? "SCHEMA-ONLY" : "NOT SCHEMA-ONLY"} · ` +
        `role ${role.name} ${roleOk ? "read-only" : "PROBLEM"}${r.secrets.missing.length ? ` · MISSING SECRETS ${r.secrets.missing.join(",")}` : ""}`,
    );
    if (!schemaOnly || !roleOk || r.secrets.missing.length) failures++;
  }
  const iso = await checkRoleIsolation(FLEET_DOMAIN);
  console.log(`isolation ${FLEET_DOMAIN.roRole}: ${iso.reachable.length === 0 ? "isolated" : `REACHES ${iso.reachable.join(", ")}`}${iso.notChecked.length ? ` (not present: ${iso.notChecked.join(", ")})` : ""}`);
  if (iso.reachable.length) failures++;
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
