/**
 * Provisions any `DomainSpec` — workspace, tools, credentials, datasource,
 * named queries, introspection, manifest.
 *
 * ⚠ **This is `provision-itops.ts`'s sequence with the domain lifted out into a
 * parameter, and every step calls exactly the same service it does.** The claim
 * those four files make — that registering a tenant needs no branch and no
 * "if <domain>" anywhere in any service — is what makes the parameterisation
 * possible at all. If a service ever needed a per-domain branch, that claim
 * would already have been false and this file could not exist.
 *
 * ⚠ **The tool catalogue is GENERIC here, and that is a real difference from the
 * four older domains.** HR has `hr_*` tools and IT Operations has `page_oncall`,
 * because those are capabilities their ops-api services expose. These three have
 * no service of their own: they get mail, chat, ticketing and `llm_complete`,
 * which is exactly the arrangement Finance and Legal already have. A domain
 * whose interesting behaviour lives in its DATA rather than in a new endpoint
 * needs no new endpoint.
 *
 * IDEMPOTENT: re-running reuses the workspace and upserts by name. It creates no
 * flows and no triggers — authoring is done through the product.
 */
import { workspaceRepo } from "../../repositories/workspace.repo.js";
import { toolRepo } from "../../repositories/tool.repo.js";
import { datasourceRepo } from "../../repositories/datasource.repo.js";
import { createToolSchema, toolService } from "../../services/tool.service.js";
import { datasourceService } from "../../services/datasource.service.js";
import { checkSqlShape } from "../../services/datasource-query.service.js";
import {
  provisionIfAbsent,
  type AutoProvisionOutcome,
} from "../../services/sandbox-autoprovision.service.js";
import { schemaIntrospectorService } from "../../services/schema-introspector.service.js";
import { requestMockBuild } from "../../services/mock-dataset.service.js";
import { manifestBuilderService } from "../../services/manifest-builder.service.js";
import { registerPlatformTools } from "../../services/platform-tool-catalogue.js";
import { workspaceService } from "../../services/workspace.service.js";
import { workspaceSecretService } from "../../services/workspace-secret.service.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, opsServiceKey } from "../../services/ops-client.service.js";
import {
  domainRoUrl,
  domainUrlForScripts,
  seedDomainDatabase,
  type DomainSeedReport,
  type DomainSpec,
} from "./domain.js";
import { LEAN_OPS_SERVICES, leanToolCatalogue } from "../lean-catalogue.js";

export interface DomainProvisionReport {
  workspaceId: string;
  workspaceName: string;
  workspaceCreated: boolean;
  seed: DomainSeedReport;
  tools: { created: number; updated: number; total: number };
  platformTools: { created: string[]; updated: string[] };
  datasource: { id: string; created: boolean; tables: number; columns: number };
  /**
   * What the automatic sandbox build decided. Reported rather than swallowed:
   * `started: false` with `why: "already_has_fixture"` is the ordinary reseed
   * and `why: "too_many_tables"` is a datasource that will read PRODUCTION on
   * every draft run until someone provisions it deliberately — two very
   * different facts, and a seeder that printed neither would leave the second
   * to be discovered by a flow reading real rows.
   */
  sandbox: AutoProvisionOutcome;
  queries: Array<{ name: string; params: number }>;
  secrets: { stored: string[]; missing: string[] };
  manifest: { version: number; changed: boolean; bytes: number };
}

/**
 * Options added for the compiled-builder programme's phase 1 (D-311, D-313). Both default to what this function always
 * did, so every existing caller is unchanged.
 *  - `workspaceName`: provision under a different workspace, so a SCHEMA-ONLY TWIN registers an existing database in a
 *    new workspace with no saved readers. The demo workspace is not touched.
 *  - `sandbox: false`: skip `provisionIfAbsent`, which generates sandbox rows with a MODEL (one call per table,
 *    detached). Draft runs read the deterministic mock, which is still built (awaited) below.
 */
export interface ProvisionOptions {
  workspaceName?: string;
  sandbox?: boolean;
  /**
   * `false`: do NOT (re)seed the database. A twin registers a database another workspace already uses, and
   * `seedDomainDatabase` runs `DROP TABLE … CASCADE`, so a twin must never reseed, even with identical rows.
   */
  seed?: boolean;
}

export async function provisionDomain(spec: DomainSpec, opts: ProvisionOptions = {}): Promise<DomainProvisionReport> {
  // 1. Data first — registering the datasource introspects it.
  const seed: DomainSeedReport = opts.seed === false
    ? { dbName: spec.dbName, created: false, tables: [], role: { name: spec.roRole, canSelect: true, writeGrants: [], reachableOtherDatabases: [], notChecked: ["not reseeded (ProvisionOptions.seed = false)"] } }
    : await seedDomainDatabase(spec);
  const workspaceName = opts.workspaceName ?? spec.workspaceName;

  // 2. Workspace, reused by name.
  const existing = (await workspaceRepo.list()).find((w) => w.name === workspaceName);
  let workspaceId: string;
  let workspaceCreated = false;
  if (existing) {
    workspaceId = existing.id;
  } else {
    const ws = await workspaceService.create({
      name: workspaceName,
      description: `${spec.description} ALL DATA IS SYNTHETIC — invented names on RFC 2606 reserved .example domains.`,
    });
    workspaceId = ws.id;
    workspaceCreated = true;
  }

  // 3. Tools — upsert by name.
  const catalogue = leanToolCatalogue(spec.key);
  const before = await toolRepo.listByWorkspace(workspaceId);
  const byName = new Map(before.map((t) => [t.name, t]));
  let created = 0;
  let updated = 0;
  for (const t of catalogue) {
    const found = byName.get(t.name);
    if (found) {
      await toolService.update(workspaceId, found.id, {
        url: t.url,
        method: t.method,
        description: t.description,
        paramsSchema: t.paramsSchema,
        secretEnvName: t.secretEnvName ?? null,
        authStyle: t.authStyle ?? null,
        authParamName: t.authParamName ?? null,
      });
      updated++;
    } else {
      await toolService.create(workspaceId, createToolSchema.parse(t));
      created++;
    }
  }

  // 4. One credential per ops-api service this workspace may reach.
  //
  // ⚠ `paging` is deliberately ABSENT from all three of these domains, exactly
  // as it is from Finance and Legal. Only IT Operations holds
  // `PAGING_API_TOKEN`, so these workspaces cannot wake anybody even with a
  // hand-written tool row — the endpoint 401s. The refusal is at the service,
  // not at the catalogue, which is what makes it a control rather than a
  // convention. `HR_DIRECTORY_TOKEN` is absent for the same reason.
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
  //
  // ⚠ `verifyVia` — D-40's read-only gate connects from whoever is REGISTERING,
  // and that is a host or sibling-container process here, where the stored
  // hostname does not resolve. Same role, same database; host and port differ
  // and `assertSameCredential` refuses anything else. It is a function argument
  // and must never become a field on the schema, which would turn the gate off
  // from outside.
  const dsList = await datasourceRepo.listByWorkspace(workspaceId);
  const dsExisting = dsList.find((d) => d.name === spec.dbName);
  const verifyVia = domainRoUrl(spec);
  let datasourceId: string;
  let dsCreated = false;
  if (dsExisting) {
    await datasourceService.update(
      workspaceId,
      dsExisting.id,
      { connectionString: domainUrlForScripts(spec), secretEnvName: spec.secretEnv },
      { verifyVia },
    );
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(
      workspaceId,
      {
        name: spec.dbName,
        type: "postgres",
        connectionString: domainUrlForScripts(spec),
        secretEnvName: spec.secretEnv,
      },
      { verifyVia },
    );
    datasourceId = ds.id;
    dsCreated = true;
  }

  // 6. Named queries — DELIBERATELY NONE.
  //
  // ⚠ **THE DATASOURCE ARRIVES WITH NO READER, AND THAT IS THE POINT.** A
  // reader-less datasource appears in the manifest in full (its schema renders)
  // and in CALLABLE STEPS not at all, which is exactly the state `needs_component`
  // (D-179) and the DB-operation proposer were built for: a person asks for an
  // automation, the turn answers that the reader does not exist yet, proposes a
  // `DbOperationSpec` as a FORM, and a person approves it by reading plain
  // English. Seeding hand-written SQL here would route straight past all of it.
  //
  // ⚠ It is also the harsher test. `spec.queries` is still populated and still
  // shape-checked below, so the queries remain in the tree as the record of what
  // each domain's useful reads ARE — they are simply not installed. If the
  // proposer cannot reach them, that is a finding rather than something the seed
  // should paper over.
  const rejected: string[] = [];
  for (const q of spec.queries) {
    const problems = checkSqlShape(q.sqlText, q.paramOrder, q.paramsSchema);
    if (problems.length > 0) {
      rejected.push(`${q.name}: ${problems.map((p) => `${p.code} ${p.message}`).join("; ")}`);
    }
  }
  if (rejected.length > 0) {
    throw new Error(
      `${rejected.length} ${spec.workspaceName} quer(ies) would be refused by POST …/queries — ` +
        `fix the query, not the rule:\n  ${rejected.join("\n  ")}`,
    );
  }

  // 7. Introspect AS THE READ-ONLY ROLE. Reading the schema with the same
  // credential a query gets makes the manifest exactly the visible surface;
  // introspecting as the owner would promise relations the credential cannot read.
  const introspected = await schemaIntrospectorService.refresh(
    datasourceId,
    "postgres",
    domainRoUrl(spec),
    { schemas: ["public"] },
  );

  /**
   * 7a. START A SANDBOX BUILD, so a DRAFT run of any flow reading this
   * datasource reads FIXTURES rather than the seeded rows.
   *
   * WARNING **Why this is here and NOT in `schemaIntrospectorService.refresh`.**
   * The hook that fires automatically lives in `datasourceService.refreshSchema`
   * — the route the onboarding wizard calls — and every seeder in this repo
   * calls the introspector DIRECTLY, one layer below it. So a datasource added
   * through the product came up sandboxed and a seeded one did not, silently:
   * measured on this deployment, all four demo datasources had
   * `sandbox_build_status` NULL and a draft run of every flow read production.
   *
   * WARNING **AND THE OTHER FOUR SEEDERS DELIBERATELY DO NOT DO THIS.** It is not
   * an omission to be tidied up: `demo:verify`, `showcase:verify` and
   * `scenarios:verify` score a DRAFT run against an oracle computed from the
   * REAL dataset, so turning fixtures on under HR, Finance, Legal or IT
   * Operations makes them fail for a correct reason. The three generic domains
   * have no oracle harness and no draft-run assertion, which is exactly why the
   * hook is safe here and nowhere else. `sandbox-autoprovision.test.ts` pins
   * that asymmetry rather than leaving it to be re-derived.
   *
   * Detached and unawaited, the same as the route: a build is ~100s (measured)
   * and `provisionIfAbsent` refuses rather than throwing, so a sandbox problem
   * can never turn a successful seed into a failed one. The seed prints the
   * decision; the outcome lands on the datasource row.
   */
  const sandbox: AutoProvisionOutcome = opts.sandbox === false
    ? { started: false, why: "no_schema", detail: "skipped (ProvisionOptions.sandbox = false): draft runs read the mock" }
    : await provisionIfAbsent(workspaceId, datasourceId);
  // Deterministic mock twin of the sandbox hook above: same post-introspection
  // position, awaited here (not fire-and-forget) so the seeder returns with a
  // ready fixtures row + JSON file. Never fails provisioning — a refusal lands
  // as a loud failed fixture row, and an unexpected throw is caught below.
  const mock = await requestMockBuild(workspaceId, datasourceId).catch((e) => ({
    started: false as const,
    why: "build_failed" as const,
    detail: (e as Error).message,
  }));
  console.log(
    `[mock] ${mock.started ? `ready (v${mock.version})` : `not built (${mock.why}${mock.detail ? `: ${mock.detail}` : ""})`}`,
  );

  // 7b. Platform tools. NOT demo data — `foundry_email_send` is a product
  // capability, so it must survive a reseed. `workspaceService.create` also
  // registers them, but only on the creating branch and it SWALLOWS failure, so
  // a workspace can exist without the tool and no amount of reseeding would put
  // it back.
  const platformTools = await registerPlatformTools(workspaceId, { rebuildManifest: false });

  // 8. Manifest LAST — it hashes the tools, the schema and the queries, and a
  // flow's refs are fingerprinted against it.
  const manifest = await manifestBuilderService.buildAndPersist(workspaceId);
  const audit = await workspaceSecretService.audit(workspaceId);

  return {
    workspaceId,
    workspaceName,
    workspaceCreated,
    seed,
    tools: { created, updated, total: catalogue.length },
    platformTools: { created: platformTools.created, updated: platformTools.updated },
    datasource: {
      id: datasourceId,
      created: dsCreated,
      tables: introspected.tables,
      columns: introspected.columns,
    },
    sandbox,
    queries: [],
    secrets: { stored: storedSecrets, missing: audit.missing.map((m) => m.envName) },
    manifest: { version: manifest.version, changed: manifest.changed, bytes: manifest.manifestXml.length },
  };
}
