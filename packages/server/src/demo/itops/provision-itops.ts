/**
 * Provisions the **IT Operations** workspace — the fourth real domain.
 *
 * Like `provision-finance.ts` and `provision-legal.ts`, the point of this file
 * is partly what it does NOT contain: it registers a different database, a
 * different tool set and a different callable catalogue by calling exactly the
 * same `toolService`, `datasourceService`, `datasourceQueryRepo`,
 * `schemaIntrospectorService` and `manifestBuilderService` the other three call,
 * with no branch and no "if itops" anywhere in any of them.
 *
 * With two tenants that claim was arguable and with three it was checkable. With
 * FOUR it has now survived the one thing that could have broken it: this domain
 * introduced a new ops-api service (`paging`), which is the first genuinely new
 * capability any tenant has added since the tool layer left the parent process.
 * It needed no change to `toolService` or to any other service — only a row in
 * two tables that already existed. `git diff --stat packages/server/src/services/`
 * across this feature is the evidence.
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
import { ITOPS_GENERATED_QUERIES } from "./itops-generated.js";
import { ITOPS_OPS_SERVICES, itopsToolCatalogue } from "./itops-tools.js";
import {
  ITOPS_DB_NAME,
  itopsDbUrlForScripts,
  itopsRoDbUrl,
  seedItopsDatabase,
  type ItopsSeedReport,
} from "./seed-itops-db.js";
import { itopsOracle } from "./itops-dataset.js";

export const ITOPS_WORKSPACE_NAME = "IT Operations";

/**
 * The env-var name the IT Operations datasource DSN is injected under.
 *
 * Deliberately its own, exactly as `LEGAL_DB_URL` is. The HR and alt workspaces
 * share a name on purpose — the swap rehearsal's claim is that only the data
 * changes — but this is a different tenant, and two tenants whose credentials
 * arrive under one name is how a copied step configuration silently reads the
 * wrong database.
 */
export const ITOPS_DB_SECRET_ENV = "ITOPS_DB_URL";

export interface ItopsProvisionReport {
  workspaceId: string;
  workspaceCreated: boolean;
  seed: ItopsSeedReport;
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
  oracle: ReturnType<typeof itopsOracle>;
}

export async function provisionItops(): Promise<ItopsProvisionReport> {
  // 1. Data first — registering the datasource introspects it.
  const seed = await seedItopsDatabase();

  // 2. Workspace, reused by name.
  const existing = (await workspaceRepo.list()).find((w) => w.name === ITOPS_WORKSPACE_NAME);
  let workspaceId: string;
  let workspaceCreated = false;
  if (existing) {
    workspaceId = existing.id;
  } else {
    const ws = await workspaceService.create({
      name: ITOPS_WORKSPACE_NAME,
      description:
        "IT operations demo workspace — incidents, SLAs and vulnerability remediation. ALL DATA " +
        "IS SYNTHETIC: invented hostnames and people on RFC 2606 reserved domains, and an " +
        "invented CVE-2026-9xxxx block that is not a real advisory range, backed by the " +
        "itops_demo database. ⚠ An SLA clock here is NOT `resolved_at - opened_at`: for a " +
        "business-hours service it runs 09:00-17:00 Mon-Fri, and time awaiting the customer is " +
        "excluded. The named queries do both corrections; a step that subtracts timestamps " +
        "itself will report breaches that never happened. ⚠ The SLA budget is keyed on (tier, " +
        "priority) — neither column identifies a policy alone. ⚠ page_oncall wakes a person and " +
        "is for a BREACH only; an incident merely at risk gets a ticket.",
    });
    workspaceId = ws.id;
    workspaceCreated = true;
  }

  // 3. Tools — upsert by name. No `hr_*` tools here; see `itops-tools.ts`.
  const catalogue = itopsToolCatalogue();
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
  // ⚠ `HR_DIRECTORY_TOKEN` is deliberately absent, as in Finance and Legal.
  //
  // ⚠ `PAGING_API_TOKEN` is deliberately PRESENT and is present ONLY here. That
  // asymmetry is the control on the one capability in this product that costs a
  // person their sleep: Finance and Legal cannot wake anybody even with a
  // hand-written tool row, because the endpoint 401s on a credential they do not
  // hold. `itops-tools.test.ts` asserts it in both directions.
  const storedSecrets: string[] = [];
  for (const service of ITOPS_OPS_SERVICES) {
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
  const dsName = ITOPS_DB_NAME;
  const dsList = await datasourceRepo.listByWorkspace(workspaceId);
  const dsExisting = dsList.find((d) => d.name === dsName);
  let datasourceId: string;
  let dsCreated = false;
  // ⚠ `verifyVia` — the D-40 read-only gate connects from whoever is
  // registering, and that is a HOST process here, where `host.docker.internal`
  // does not resolve on Linux. Same role, same database; host and port only,
  // and `assertSameCredential` refuses anything else.
  const verifyVia = itopsRoDbUrl();
  if (dsExisting) {
    await datasourceService.update(
      workspaceId,
      dsExisting.id,
      { connectionString: itopsDbUrlForScripts(), secretEnvName: ITOPS_DB_SECRET_ENV },
      { verifyVia },
    );
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(
      workspaceId,
      {
        name: dsName,
        type: "postgres",
        connectionString: itopsDbUrlForScripts(),
        secretEnvName: ITOPS_DB_SECRET_ENV,
      },
      { verifyVia },
    );
    datasourceId = ds.id;
    dsCreated = true;
  }
  // 6. Generated queries — the callable catalogue a `datasource` step names.
  //
  // Proposed by `POST …/queries/propose` and frozen in `itops-generated.ts`
  // after oracle comparison at all four as-of instants. Installed under the
  // ORIGINAL `itops_demo.*` refs so flow seeds keep working.
  const rejected: string[] = [];
  for (const q of ITOPS_GENERATED_QUERIES) {
    const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
    if (problems.length > 0) {
      rejected.push(`${q.name}: ${problems.map((p) => `${p.code} ${p.message}`).join("; ")}`);
    }
  }
  if (rejected.length > 0) {
    throw new Error(
      `${rejected.length} IT Operations quer(ies) would be refused by POST …/queries — fix the ` +
        `query, not the rule:\n  ${rejected.join("\n  ")}`,
    );
  }
  for (const q of ITOPS_GENERATED_QUERIES) {
    await datasourceQueryRepo.upsertByName({
      datasourceId,
      name: q.name,
      description: q.description,
      sqlText: q.sqlText,
      paramOrder: q.paramOrder,
      paramsSchema: q.paramsSchema,
      columnTags: columnTagsFor("itops_demo", q.name), // a computed address column, declared by its owner
    });
  }

  // 7. Introspect AS THE READ-ONLY ROLE, over the parent-facing path. Reading the
  // schema with the same credential a query gets makes the manifest exactly the
  // visible surface — introspecting as the owner would promise relations the
  // credential cannot actually read.
  const introspected = await schemaIntrospectorService.refresh(
    datasourceId,
    "postgres",
    itopsRoDbUrl(),
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
  // amount of re-running `itops:seed` would put it back — measured on this
  // deployment, where the Finance workspace carried its 8 demo tools for 74
  // minutes with no `tether_email_send`.
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
      secretEnvName: ITOPS_DB_SECRET_ENV,
      tablesIntrospected: introspected.tables,
      columnsIntrospected: introspected.columns,
    },
    queries: ITOPS_GENERATED_QUERIES.map((q) => ({ name: q.name, params: q.paramOrder.length })),
    secrets: { stored: storedSecrets, missing: audit.missing, collisions: audit.collisions },
    manifest: {
      version: manifest.version,
      changed: manifest.changed,
      bytes: manifest.manifestXml.length,
      summaryBytes: manifest.summaryXml.length,
    },
    oracle: itopsOracle(),
  };
}
