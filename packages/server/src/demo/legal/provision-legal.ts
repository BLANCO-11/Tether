/**
 * Provisions the **Legal** workspace — the third real domain.
 *
 * Like `provision-finance.ts`, the point of this file is partly what it does NOT
 * contain: it registers a different database, a different tool set and a
 * different callable catalogue by calling exactly the same `toolService`,
 * `datasourceService`, `datasourceQueryRepo`, `schemaIntrospectorService` and
 * `manifestBuilderService` the HR and Finance workspaces call, with no branch and
 * no "if legal" anywhere in any of them.
 *
 * With two tenants that claim was arguable. With three it is checkable: if a
 * third tenant needed a code change inside a service, the change would have to
 * appear here as a special case, and `git diff --stat packages/server/src/services/`
 * would show it.
 *
 * IDEMPOTENT: re-running reuses the workspace and upserts by name. It creates no
 * flows and no triggers — authoring is done through the product, and a
 * hand-written flow proves nothing about a generator.
 */
import { columnTagsFor } from "../query-column-tags.js";
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
import { registerPlatformTools } from "../../services/platform-tool-catalogue.js";
import { workspaceService } from "../../services/workspace.service.js";
import { workspaceSecretService } from "../../services/workspace-secret.service.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, opsServiceKey } from "../../services/ops-client.service.js";
import { LEGAL_GENERATED_QUERIES } from "./legal-generated.js";
import { LEGAL_OPS_SERVICES, legalToolCatalogue } from "./legal-tools.js";
import {
  LEGAL_DB_NAME,
  legalDbUrlForScripts,
  legalRoDbUrl,
  seedLegalDatabase,
  type LegalSeedReport,
} from "./seed-legal-db.js";
import { legalOracle } from "./legal-dataset.js";

export const LEGAL_WORKSPACE_NAME = "Legal";

/**
 * The env-var name the Legal datasource DSN is injected under.
 *
 * Deliberately NOT `HR_DB_URL` or `FINANCE_DB_URL`. The HR and alt workspaces
 * share a name on purpose — the swap rehearsal's claim is that only the data
 * changes — but Legal is a different tenant, and two tenants whose credentials
 * arrive under one name is how a copied step configuration silently reads the
 * wrong database.
 */
export const LEGAL_DB_SECRET_ENV = "LEGAL_DB_URL";

export interface LegalProvisionReport {
  workspaceId: string;
  workspaceCreated: boolean;
  seed: LegalSeedReport;
  tools: { created: number; updated: number; total: number };
  /** Platform tools (`tether_email_send`) — reported separately so a reseed that
   *  restores a missing product capability says so, rather than doing it silently. */
  platformTools: { created: string[]; updated: string[] };
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
  oracle: ReturnType<typeof legalOracle>;
}

export async function provisionLegal(): Promise<LegalProvisionReport> {
  // 1. Data first — registering the datasource introspects it.
  const seed = await seedLegalDatabase();

  // 2. Workspace, reused by name.
  const existing = (await workspaceRepo.list()).find((w) => w.name === LEGAL_WORKSPACE_NAME);
  let workspaceId: string;
  let workspaceCreated = false;
  if (existing) {
    workspaceId = existing.id;
  } else {
    const ws = await workspaceService.create({
      name: LEGAL_WORKSPACE_NAME,
      description:
        "Legal demo workspace — contract lifecycle and obligations. ALL DATA IS SYNTHETIC: " +
        "invented counterparties and people on RFC 2606 reserved domains, backed by the " +
        "legal_demo database. Not a real contract register. ⚠ A notice deadline falling ON the " +
        "reporting date is still actionable here — the opposite of the finance_demo overdue rule " +
        "— and auto-renewing and fixed-term contracts have two separate named queries because a " +
        "missed deadline means opposite things for each.",
    });
    workspaceId = ws.id;
    workspaceCreated = true;
  }

  // 3. Tools — upsert by name. No `hr_*` tools here; see `legal-tools.ts`.
  const catalogue = legalToolCatalogue();
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
  // ⚠ `HR_DIRECTORY_TOKEN` is deliberately absent. Legal holds no credential for
  // the HR directory service, so even a hand-written tool row pointing at
  // `/hr/employees` would 401 rather than read another tenant's people.
  const storedSecrets: string[] = [];
  for (const service of LEGAL_OPS_SERVICES) {
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
  const dsName = LEGAL_DB_NAME;
  const dsList = await datasourceRepo.listByWorkspace(workspaceId);
  const dsExisting = dsList.find((d) => d.name === dsName);
  let datasourceId: string;
  let dsCreated = false;
  // ⚠ `verifyVia` — the D-40 read-only gate connects from whoever is
  // registering, and that is a HOST process here, where `host.docker.internal`
  // does not resolve on Linux. Same role, same database; host and port only,
  // and `assertSameCredential` refuses anything else.
  const verifyVia = legalRoDbUrl();
  if (dsExisting) {
    await datasourceService.update(
      workspaceId,
      dsExisting.id,
      { connectionString: legalDbUrlForScripts(), secretEnvName: LEGAL_DB_SECRET_ENV },
      { verifyVia },
    );
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(
      workspaceId,
      {
        name: dsName,
        type: "postgres",
        connectionString: legalDbUrlForScripts(),
        secretEnvName: LEGAL_DB_SECRET_ENV,
      },
      { verifyVia },
    );
    datasourceId = ds.id;
    dsCreated = true;
  }
  // 6. Generated queries — the callable catalogue a `datasource` step names.
  //
  // Proposed by `POST …/queries/propose` and frozen in `legal-generated.ts`
  // after FULL-ROW comparison against the hand-written queries they replace.
  // Installed under the ORIGINAL `legal_demo.*` refs.
  const rejected: string[] = [];
  for (const q of LEGAL_GENERATED_QUERIES) {
    const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
    if (problems.length > 0) {
      rejected.push(`${q.name}: ${problems.map((p) => `${p.code} ${p.message}`).join("; ")}`);
    }
  }
  if (rejected.length > 0) {
    throw new Error(
      `${rejected.length} Legal quer(ies) would be refused by POST …/queries — fix the query, ` +
        `not the rule:\n  ${rejected.join("\n  ")}`,
    );
  }
  for (const q of LEGAL_GENERATED_QUERIES) {
    await datasourceQueryRepo.upsertByName({
      datasourceId,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
      columnTags: columnTagsFor("legal_demo", q.name), // a computed address column, declared by its owner
    });
  }

  // 7. Introspect AS THE READ-ONLY ROLE, over the parent-facing path. Reading the
  // schema with the same credential a query gets makes the manifest exactly the
  // visible surface — introspecting as the owner would promise relations the
  // credential cannot actually read.
  const introspected = await schemaIntrospectorService.refresh(
    datasourceId,
    "postgres",
    legalRoDbUrl(),
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

  // 7b. Platform tools. NOT demo data — `tether_email_send` is a product
  // capability, so it must survive a reseed rather than being left behind by one.
  //
  // ⚠ This is NOT redundant with `workspaceService.create`, which also registers
  // them. That call fires once, only on the branch that creates the workspace, and
  // it deliberately SWALLOWS failure so a registration error cannot fail workspace
  // creation. Both properties mean a workspace can exist without the tool and no
  // amount of re-running `legal:seed` would put it back. Measured on this very
  // deployment: the Finance workspace carried its 8 demo tools for 74 minutes with
  // no `tether_email_send`, until an unrelated startup backfill happened to catch
  // it. Re-registering here is what makes the reseed self-healing, exactly as the
  // HR provisioner does at its step 5b.
  //
  // `rebuildManifest: false` because step 8 renders the manifest once for
  // everything; bumping the version here too would make the version a count of
  // provisioning steps rather than of catalogue changes.
  const platformTools = await registerPlatformTools(workspaceId, { rebuildManifest: false });

  // 8. Manifest LAST — it hashes the tools, the schema and the queries, and a
  // flow's refs are fingerprinted against it.
  const manifest = await manifestBuilderService.buildAndPersist(workspaceId);

  const audit = await workspaceSecretService.audit(workspaceId);

  return {
    workspaceId,
    workspaceCreated,
    seed,
    tools: { created, updated, total: catalogue.length },
    platformTools: { created: platformTools.created, updated: platformTools.updated },
    datasource: {
      id: datasourceId,
      created: dsCreated,
      secretEnvName: LEGAL_DB_SECRET_ENV,
      tablesIntrospected: introspected.tables,
      columnsIntrospected: introspected.columns,
    },
    queries: LEGAL_GENERATED_QUERIES.map((q) => ({ name: q.name, params: q.paramOrder.length })),
    secrets: { stored: storedSecrets, missing: audit.missing, collisions: audit.collisions },
    manifest: {
      version: manifest.version,
      changed: manifest.changed,
      bytes: manifest.manifestXml.length,
      summaryBytes: manifest.summaryXml.length,
    },
    oracle: legalOracle(),
  };
}
