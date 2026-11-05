import { config } from "../../config/index.js";
import { workspaceRepo } from "../../repositories/workspace.repo.js";
import { toolRepo } from "../../repositories/tool.repo.js";
import { datasourceRepo } from "../../repositories/datasource.repo.js";
import { createToolSchema, toolService } from "../../services/tool.service.js";
import { datasourceService } from "../../services/datasource.service.js";
import { schemaIntrospectorService } from "../../services/schema-introspector.service.js";
import { requestMockBuild } from "../../services/mock-dataset.service.js";
import { manifestBuilderService } from "../../services/manifest-builder.service.js";
import { workspaceService } from "../../services/workspace.service.js";
import { workspaceSecretService } from "../../services/workspace-secret.service.js";
import {
  OPS_AUTH_STYLE,
  OPS_SECRET_ENV,
  opsServiceKey,
  type OpsService,
} from "../../services/ops-client.service.js";
import { demoToolCatalogue } from "../tool-catalogue.js";
import {
  ALT_SCHEMA,
  altDbUrlForScripts,
  altRoDbUrl,
  seedAltDatabase,
  type AltSeedReport,
} from "./seed-alt-db.js";
import { altExpectedScreening } from "./alt-dataset.js";

/**
 * WS-E.2 — provisions the rehearsal workspace
 * (plans/production-substitution-plan.md §8.2).
 *
 * THE POINT OF THIS FILE IS WHAT IT DOES *NOT* CONTAIN.
 *
 * It registers a different database, in a named schema, with different table
 * names, different units and ~10x the rows — and to do so it calls exactly the
 * same `toolService`, `datasourceService`, `schemaIntrospectorService` and
 * `manifestBuilderService` the primary demo calls, with no branch, override, or
 * "if alt" anywhere. The tool catalogue is reused verbatim.
 *
 * If registering a differently-shaped datasource required a code change in any of
 * those services, that requirement would show up here as an extra argument or a
 * special case — and its absence is the evidence for P1. That is why this is a
 * provisioner rather than a script that hand-writes rows.
 */

export const ALT_WORKSPACE_NAME = "HR (alt — swap rehearsal)";

export interface AltProvisionReport {
  workspaceId: string;
  workspaceCreated: boolean;
  seed: AltSeedReport;
  tools: { created: number; updated: number; total: number };
  datasource: {
    id: string;
    schemaAllowlist: string[];
    entitiesIntrospected: number;
    viewsIntrospected: number;
    columnsIntrospected: number;
  };
  manifest: { version: number; bytes: number; summaryBytes: number };
  oracle: ReturnType<typeof altExpectedScreening>;
}

export async function provisionAltDemo(): Promise<AltProvisionReport> {

  const seed = await seedAltDatabase();

  const existing = (await workspaceRepo.list()).find((w) => w.name === ALT_WORKSPACE_NAME);
  let workspaceId: string;
  let workspaceCreated = false;
  if (existing) {
    workspaceId = existing.id;
  } else {
    const ws = await workspaceService.create({
      name: ALT_WORKSPACE_NAME,
      description:
        "WS-E swap-rehearsal workspace. ALL DATA IS SYNTHETIC — invented people on RFC 2606 " +
        "reserved domains, backed by the hr_demo_alt database, schema `hr`. Deliberately a " +
        "different shape from the HR workspace: different table names, rates as fractions " +
        "(0-1) not percentages, ~10x the rows, a different date window.",
    });
    workspaceId = ws.id;
    workspaceCreated = true;
  }

  // Same catalogue, same service, same stub instance. The tools are shape-identical
  // to the primary workspace's on purpose: if a task succeeds against hr_demo and
  // fails here, the tools are not the variable.
  const catalogue = demoToolCatalogue();
  const before = await toolRepo.listByWorkspace(workspaceId);
  const byName = new Map(before.map((t) => [t.name, t]));
  let created = 0;
  let updated = 0;
  for (const spec of catalogue) {
    const found = byName.get(spec.name);
    if (found) {
      await toolService.update(workspaceId, found.id, {
        url: spec.url,
        method: spec.method,
        description: spec.description,
        paramsSchema: spec.paramsSchema,
        secretEnvName: spec.secretEnvName ?? null,
        authStyle: spec.authStyle ?? null,
        authParamName: spec.authParamName ?? null,
      });
      updated++;
    } else {
      await toolService.create(workspaceId, createToolSchema.parse(spec));
      created++;
    }
  }

  // The same five ops-api credentials as the primary workspace, under the same
  // env-var NAMES. That sameness is part of the P1 claim: the rehearsal swaps the
  // DATA, not the tool layer, so a flow's `<auth env=…>` must be unchanged across
  // the swap and only the datasource behind it differs.
  for (const service of ["hr", "mail", "chat", "ticketing", "probe"] as OpsService[]) {
    await workspaceSecretService.put(
      workspaceId,
      OPS_SECRET_ENV[service],
      opsServiceKey(service),
      `ops-api ${service} credential (${OPS_AUTH_STYLE[service].style}; synthetic).`,
    );
  }

  // The datasource: same env-var NAME as the primary workspace, so a generated
  // script's `os.environ["HR_DB_URL"]` is unchanged across the swap. Only the
  // VALUE and the schema allowlist differ — which is precisely the P1 claim.
  const dsName = "hr_demo_alt";
  const dsList = await datasourceRepo.listByWorkspace(workspaceId);
  const dsExisting = dsList.find((d) => d.name === dsName);
  let datasourceId: string;
  // ⚠ `verifyVia` — the D-40 read-only gate connects from the registering
  // process, which is a HOST process here, and `host.docker.internal` does not
  // resolve on a Linux host. Same credential, host and port only.
  const verifyVia = altRoDbUrl();
  if (dsExisting) {
    await datasourceService.update(
      workspaceId,
      dsExisting.id,
      {
        connectionString: altDbUrlForScripts(),
        secretEnvName: config.demo.dbSecretEnvName,
        schemaAllowlist: [ALT_SCHEMA],
      },
      { verifyVia },
    );
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(
      workspaceId,
      {
        name: dsName,
        type: "postgres",
        connectionString: altDbUrlForScripts(),
        secretEnvName: config.demo.dbSecretEnvName,
        // WS-C.1 in anger: `hr`, not `public`. Before this workstream the
        // introspector could not see it at all.
        schemaAllowlist: [ALT_SCHEMA],
      },
      { verifyVia },
    );
    datasourceId = ds.id;
  }

  // Introspect as the read-only role (WS-A.6), over the parent-facing path.
  const introspected = await schemaIntrospectorService.refresh(
    datasourceId,
    "postgres",
    altRoDbUrl(),
    { schemas: [ALT_SCHEMA] },
  );
  // Deterministic mock build for the just-introspected shape. Awaited so the
  // seeder returns with a ready fixtures row + JSON file; never fails
  // provisioning — refusals land as loud failed fixture rows.
  const mock = await requestMockBuild(workspaceId, datasourceId).catch((e) => ({
    started: false as const,
    why: "build_failed" as const,
    detail: (e as Error).message,
  }));
  console.log(
    `[mock] ${mock.started ? `ready (v${mock.version})` : `not built (${mock.why}${mock.detail ? `: ${mock.detail}` : ""})`}`,
  );

  const manifest = await manifestBuilderService.buildAndPersist(workspaceId);

  return {
    workspaceId,
    workspaceCreated,
    seed,
    tools: { created, updated, total: catalogue.length },
    datasource: {
      id: datasourceId,
      schemaAllowlist: [ALT_SCHEMA],
      entitiesIntrospected: introspected.tables,
      viewsIntrospected: introspected.views,
      columnsIntrospected: introspected.columns,
    },
    manifest: {
      version: manifest.version,
      bytes: manifest.manifestXml.length,
      summaryBytes: manifest.summaryXml.length,
    },
    oracle: altExpectedScreening(),
  };
}
