/**
 * Provisions the **Finance** workspace — the second real domain.
 *
 * Like `provision-alt.ts`, the point of this file is partly what it does NOT
 * contain: it registers a different database, a different tool set and a
 * different callable catalogue by calling exactly the same `toolService`,
 * `datasourceService`, `datasourceQueryRepo`, `schemaIntrospectorService` and
 * `manifestBuilderService` the HR workspace calls, with no branch and no "if
 * finance" anywhere in any of them. If a second tenant needed a code change in
 * a service, the change would have to appear here as a special case.
 *
 * IDEMPOTENT: re-running reuses the workspace and upserts by name. It creates no
 * flows and no triggers — authoring is Stage 3's job, done through the product.
 */
import { workspaceRepo } from "../../repositories/workspace.repo.js";
import { toolRepo } from "../../repositories/tool.repo.js";
import { datasourceRepo } from "../../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../../repositories/datasource-query.repo.js";
import { createToolSchema, toolService } from "../../services/tool.service.js";
import { datasourceService } from "../../services/datasource.service.js";
import { checkSqlShape } from "../../services/datasource-query.service.js";
import { schemaIntrospectorService } from "../../services/schema-introspector.service.js";
import { requestMockBuild } from "../../services/mock-dataset.service.js";
import { manifestBuilderService } from "../../services/manifest-builder.service.js";
import { workspaceService } from "../../services/workspace.service.js";
import { workspaceSecretService } from "../../services/workspace-secret.service.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, opsServiceKey } from "../../services/ops-client.service.js";
import { FINANCE_GENERATED_QUERIES } from "./finance-generated.js";
import { financeToolCatalogue } from "./finance-tools.js";
import { LEAN_OPS_SERVICES, leanToolCatalogue } from "../lean-catalogue.js";
import {
  FINANCE_DB_NAME,
  financeDbUrlForScripts,
  financeRoDbUrl,
  seedFinanceDatabase,
  type FinanceSeedReport,
} from "./seed-finance-db.js";
import { financeOracle } from "./finance-dataset.js";

export const FINANCE_WORKSPACE_NAME = "Finance";

/**
 * The env-var name the Finance datasource DSN is injected under.
 *
 * Deliberately NOT `HR_DB_URL`. The HR and alt workspaces share that name on
 * purpose — the swap rehearsal's claim is that only the data changes — but
 * Finance is a different tenant, and two tenants whose credentials arrive under
 * one name is how a copied step configuration silently reads the wrong
 * database.
 */
export const FINANCE_DB_SECRET_ENV = "FINANCE_DB_URL";

export interface FinanceProvisionReport {
  workspaceId: string;
  workspaceCreated: boolean;
  seed: FinanceSeedReport;
  tools: { created: number; updated: number; total: number };
  datasource: {
    id: string;
    created: boolean;
    secretEnvName: string;
    tablesIntrospected: number;
    columnsIntrospected: number;
  };
  queries: { name: string; params: number }[];
  secrets: { stored: string[]; missing: { envName: string; neededBy: string }[]; collisions: string[] };
  manifest: { version: number; changed: boolean; bytes: number; summaryBytes: number };
  oracle: ReturnType<typeof financeOracle>;
}

export async function provisionFinance(): Promise<FinanceProvisionReport> {
  // 1. Data first — registering the datasource introspects it.
  const seed = await seedFinanceDatabase();

  // 2. Workspace, reused by name.
  const existing = (await workspaceRepo.list()).find((w) => w.name === FINANCE_WORKSPACE_NAME);
  let workspaceId: string;
  let workspaceCreated = false;
  if (existing) {
    workspaceId = existing.id;
  } else {
    const ws = await workspaceService.create({
      name: FINANCE_WORKSPACE_NAME,
      description:
        "Finance demo workspace. ALL DATA IS SYNTHETIC — invented vendors and people on RFC " +
        "2606 reserved domains, backed by the finance_demo database. Not a real ledger. " +
        "⚠ Amounts are stored in MINOR units (cents) except budgets.amount, which is in " +
        "major units — that mismatch is deliberate and is what the oracle checks for.",
    });
    workspaceId = ws.id;
    workspaceCreated = true;
  }

  // 3. Tools — upsert by name. No `hr_*` tools here; see `finance-tools.ts`.
  // ⚠ THE LEAN CATALOGUE, not `financeToolCatalogue()`. See
  // `demo/lean-catalogue.ts` for the measured reason (85 tool rows against 1 DB
  // operation). The Finance catalogue is left in the tree, and unused, so
  // restoring a tool is a call site rather than a rewrite.
  void financeToolCatalogue;
  const catalogue = leanToolCatalogue("finance");
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

  // 4. One credential per ops-api service this workspace can reach. Derived from
  // `OPS_API_KEY` on both sides, so nothing is committed and the two processes
  // cannot drift into disagreement.
  //
  // ⚠ `HR_DIRECTORY_TOKEN` is deliberately absent. Finance holds no credential
  // for the HR directory service, so even a hand-written tool row pointing at
  // `/hr/employees` would 401 rather than read another tenant's people.
  const storedSecrets: string[] = [];
  for (const service of LEAN_OPS_SERVICES) {
    const s = await workspaceSecretService.put(
      workspaceId,
      OPS_SECRET_ENV[service],
      opsServiceKey(service),
      `ops-api ${service} credential (${OPS_AUTH_STYLE[service].style}; synthetic, derived from OPS_API_KEY).`,
    );
    storedSecrets.push(s?.name ?? OPS_SECRET_ENV[service]);
  }

  // 5. Datasource, carrying the READ-ONLY role's credential. The owner
  // credential stays parent-side and is never registered anywhere.
  const dsName = FINANCE_DB_NAME;
  const dsList = await datasourceRepo.listByWorkspace(workspaceId);
  const dsExisting = dsList.find((d) => d.name === dsName);
  let datasourceId: string;
  let dsCreated = false;
  // ⚠ `verifyVia` — the D-40 read-only gate connects from whoever is
  // registering, and that is a HOST process here, where `host.docker.internal`
  // does not resolve on Linux. Same role, same database; host and port only,
  // and `assertSameCredential` refuses anything else.
  const verifyVia = financeRoDbUrl();
  if (dsExisting) {
    await datasourceService.update(
      workspaceId,
      dsExisting.id,
      { connectionString: financeDbUrlForScripts(), secretEnvName: FINANCE_DB_SECRET_ENV },
      { verifyVia },
    );
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(
      workspaceId,
      {
        name: dsName,
        type: "postgres",
        connectionString: financeDbUrlForScripts(),
        secretEnvName: FINANCE_DB_SECRET_ENV,
      },
      { verifyVia },
    );
    datasourceId = ds.id;
    dsCreated = true;
  }

  // 6. Generated queries — INSTALLED.
  //
  // The five reads `finance_demo` needs, proposed by `POST …/queries/propose`
  // from need statements plus the introspected schema and frozen in
  // `finance-generated.ts` after oracle comparison (see that file's header).
  // Installed because a generated read IS the product path — seeding one
  // exercises nothing the product cannot do.
  const rejected: string[] = [];
  for (const q of FINANCE_GENERATED_QUERIES) {
    const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
    if (problems.length > 0) {
      rejected.push(`${q.name}: ${problems.map((p) => `${p.code} ${p.message}`).join("; ")}`);
    }
  }
  if (rejected.length > 0) {
    throw new Error(
      `${rejected.length} Finance generated quer(ies) would be refused by POST …/queries — fix the query, ` +
        `not the rule:\n  ${rejected.join("\n  ")}`,
    );
  }
  for (const q of FINANCE_GENERATED_QUERIES) {
    await datasourceQueryRepo.upsertByName({
      datasourceId,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
    });
  }
  // 7. Introspect AS THE READ-ONLY ROLE, over the parent-facing path. Reading
  // the schema with the same credential a query gets makes the manifest exactly
  // the visible surface — introspecting as the owner would promise relations the
  // credential cannot actually read.
  const introspected = await schemaIntrospectorService.refresh(
    datasourceId,
    "postgres",
    financeRoDbUrl(),
    { schemas: ["public"] },
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

  // 8. Manifest LAST — it hashes the tools, the schema and the queries, and a
  // flow's refs are fingerprinted against it.
  const manifest = await manifestBuilderService.buildAndPersist(workspaceId);

  const audit = await workspaceSecretService.audit(workspaceId);

  return {
    workspaceId,
    workspaceCreated,
    seed,
    tools: { created, updated, total: catalogue.length },
    datasource: {
      id: datasourceId,
      created: dsCreated,
      secretEnvName: FINANCE_DB_SECRET_ENV,
      tablesIntrospected: introspected.tables,
      columnsIntrospected: introspected.columns,
    },
    queries: FINANCE_GENERATED_QUERIES.map((q) => ({ name: q.name, params: q.paramOrder.length })),
    secrets: { stored: storedSecrets, missing: audit.missing, collisions: audit.collisions },
    manifest: {
      version: manifest.version,
      changed: manifest.changed,
      bytes: manifest.manifestXml.length,
      summaryBytes: manifest.summaryXml.length,
    },
    oracle: financeOracle(),
  };
}
