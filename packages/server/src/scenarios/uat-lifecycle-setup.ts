/**
 * UAT lifecycle probe — SETUP ONLY.
 *
 * Creates a throwaway workspace that reuses the EXISTING `support_demo`
 * database through its OWN registration of `support_ro`. This is deliberately
 * not "borrow Customer Support's rows": a tool row or a datasource row belongs
 * to one workspace, and D-45 is explicit that registering another tenant's
 * endpoints is a cross-tenant read no datasource boundary catches. Same data,
 * same read-only role, its own registration.
 *
 * It is `provisionDomain()` minus `seedDomainDatabase()` — the data is already
 * there and re-seeding it would drop and recreate a database another workspace
 * is pointed at, for no gain.
 *
 * Throwaway: `pnpm --filter @foundry/server uat:teardown` removes it.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { createToolSchema, toolService } from "../services/tool.service.js";
import { datasourceService } from "../services/datasource.service.js";
import { checkSqlShape } from "../services/datasource-query.service.js";
import { schemaIntrospectorService } from "../services/schema-introspector.service.js";
import { requestMockBuild } from "../services/mock-dataset.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { registerPlatformTools } from "../services/platform-tool-catalogue.js";
import { workspaceService } from "../services/workspace.service.js";
import { workspaceSecretService } from "../services/workspace-secret.service.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, opsServiceKey } from "../services/ops-client.service.js";
import { domainRoUrl, domainUrlForScripts, type DomainSpec } from "../demo/generic/domain.js";
import { genericToolCatalogue } from "../demo/generic/tools.js";
import { GENERIC_GENERATED_QUERIES } from "../demo/generic-generated.js";
import { SUPPORT_DOMAIN } from "../demo/generic/support.js";

export const UAT_WORKSPACE = "UAT lifecycle";

/** The support domain, addressed by a different tenant. Data untouched. */
const SPEC: DomainSpec = { ...SUPPORT_DOMAIN, workspaceName: UAT_WORKSPACE };

async function main() {
  const existing = (await workspaceRepo.list()).find((w) => w.name === UAT_WORKSPACE);
  let workspaceId: string;
  if (existing) {
    workspaceId = existing.id;
    console.log(`workspace: reused ${workspaceId}`);
  } else {
    const ws = await workspaceService.create({
      name: UAT_WORKSPACE,
      description:
        "Throwaway tenant for the UAT lifecycle probe. Reads the synthetic support_demo " +
        "database through its own support_ro registration. ALL DATA IS SYNTHETIC.",
    });
    workspaceId = ws.id;
    console.log(`workspace: created ${workspaceId}`);
  }

  const catalogue = genericToolCatalogue(SPEC);
  const byName = new Map((await toolRepo.listByWorkspace(workspaceId)).map((t) => [t.name, t]));
  for (const t of catalogue) {
    const found = byName.get(t.name);
    if (found) {
      await toolService.update(workspaceId, found.id, {
        url: t.url, method: t.method, description: t.description,
        paramsSchema: t.paramsSchema, secretEnvName: t.secretEnvName ?? null,
        authStyle: t.authStyle ?? null, authParamName: t.authParamName ?? null,
      });
    } else {
      await toolService.create(workspaceId, createToolSchema.parse(t));
    }
  }
  console.log(`tools: ${catalogue.length}`);

  for (const service of SPEC.opsServices) {
    await workspaceSecretService.put(
      workspaceId, OPS_SECRET_ENV[service], opsServiceKey(service),
      `ops-api ${service} credential (${OPS_AUTH_STYLE[service].style}; synthetic).`,
    );
  }
  console.log(`secrets: ${SPEC.opsServices.join(", ")}`);

  const verifyVia = domainRoUrl(SPEC);
  const dsExisting = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === SPEC.dbName);
  let datasourceId: string;
  if (dsExisting) {
    await datasourceService.update(workspaceId, dsExisting.id,
      { connectionString: domainUrlForScripts(SPEC), secretEnvName: SPEC.secretEnv }, { verifyVia });
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(workspaceId, {
      name: SPEC.dbName, type: "postgres",
      connectionString: domainUrlForScripts(SPEC), secretEnvName: SPEC.secretEnv,
    }, { verifyVia });
    datasourceId = ds.id;
  }
  console.log(`datasource: ${datasourceId}`);

  // The generated breach read only — the hand-written SUPPORT_DOMAIN queries
  // are retired with the named-query surfaces.
  const queries = GENERIC_GENERATED_QUERIES.filter((q) => q.name === "tickets_breaching_resolve");
  for (const q of queries) {
    const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
    if (problems.length) throw new Error(`${q.name}: ${problems.map((p) => p.message).join("; ")}`);
    await datasourceQueryRepo.upsertByName({
      datasourceId, name: q.name, description: q.description,
      sqlText: q.sqlText, paramOrder: q.paramOrder, paramsSchema: q.paramsSchema,
    });
  }
  console.log(`queries: ${queries.map((q) => q.name).join(", ")}`);

  const intro = await schemaIntrospectorService.refresh(datasourceId, "postgres", domainRoUrl(SPEC), {
    schemas: ["public"],
  });
  // Deterministic mock build for the just-introspected shape. Awaited so setup
  // leaves a ready fixtures row + JSON file; never fails setup — refusals land
  // as loud failed fixture rows.
  const mock = await requestMockBuild(workspaceId, datasourceId).catch((e) => ({
    started: false as const,
    why: "build_failed" as const,
    detail: (e as Error).message,
  }));
  console.log(`[mock] ${mock.started ? `ready (v${mock.version})` : `not built (${mock.why}${mock.detail ? `: ${mock.detail}` : ""})`}`);
  await registerPlatformTools(workspaceId, { rebuildManifest: false });
  const manifest = await manifestBuilderService.buildAndPersist(workspaceId);
  console.log(`introspected: ${intro.tables} tables / ${intro.columns} columns`);
  console.log(`manifest: v${manifest.version}, ${manifest.manifestXml.length} bytes`);
  console.log(`\nWORKSPACE_ID=${workspaceId}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
