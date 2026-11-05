import { sql } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { createToolSchema, toolService } from "../services/tool.service.js";
import { datasourceService } from "../services/datasource.service.js";
import { schemaIntrospectorService } from "../services/schema-introspector.service.js";
import { requestMockBuild } from "../services/mock-dataset.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { workspaceService } from "../services/workspace.service.js";
import { demoToolCatalogue } from "./tool-catalogue.js";
import { hrDbUrl, hrDbUrlForScripts, hrRoDbUrl, seedHrDatabase, type SeedReport } from "./seed-hr-db.js";
import { verifyReadOnlyRole } from "./hr-roles.js";
import { ensureOpsHrRole } from "./ops-hr-role.js";
import { expectedScreening } from "./hr-dataset.js";
import { workspaceSecretService } from "../services/workspace-secret.service.js";
import {
  OPS_AUTH_STYLE,
  OPS_SECRET_ENV,
  opsClient,
  opsServiceKey,
  type OpsService,
} from "../services/ops-client.service.js";
import { registerPlatformTools } from "../services/platform-tool-catalogue.js";

/** Every ops-api service, in a stable order. The five credentials seeded below. */
/**
 * Every ops-api service gets its credential seeded, derived from the table
 * rather than listed again.
 *
 * `probe` and `llm` have no tool in `demoToolCatalogue()` — the probe is
 * registered by `showcase:seed` and `retry-verify`, and the LLM tool is the
 * catalogue's fifteenth entry — but their secrets are seeded here anyway. A
 * credential that only appears when some other script has run is a workspace
 * that works or 424s depending on what someone did last, and `secrets/audit`
 * would report it as missing.
 */
const OPS_SERVICES = Object.keys(OPS_SECRET_ENV) as OpsService[];

/**
 * Provisions the HR demo workspace (plans/hr-demo-stub-services-plan.md §8).
 *
 * IDEMPOTENT: re-running reuses the existing workspace and upserts tools and the
 * datasource by name. It does NOT delete a workspace, script, trigger, or
 * anything the user created — see resetDemo() for what is and isn't destroyed.
 */

export const DEMO_WORKSPACE_NAME = "HR";

export interface ProvisionReport {
  workspaceId: string;
  workspaceCreated: boolean;
  seed: SeedReport;
  tools: { created: number; updated: number; total: number };
  datasource: {
    id: string;
    created: boolean;
    secretEnvName: string;
    tablesIntrospected: number;
    columnsIntrospected: number;
    /** WS-A.6: which credential the schema was read with. */
    introspectedAs: "read_only" | "owner";
  };
  manifest: { version: number; changed: boolean; bytes: number; summaryBytes: number };
  /** The read-only role ops-api reads `hr_demo` with — NOT `foundry_ro`. */
  opsHrRole: { role: string; created: boolean; database: string };
  /** WS-B: declared secrets, and any declared-but-unstored ones. */
  secrets: { stored: string[]; missing: { envName: string; neededBy: string }[]; collisions: string[] };
  /** The independently-computed correct answer for the flagship task. */
  oracle: ReturnType<typeof expectedScreening>;
}

export async function provisionDemo(): Promise<ProvisionReport> {

  // 1. Data first — the datasource test/introspect below needs a live schema.
  const seed = await seedHrDatabase();

  // 1b. ops-api's own read-only role. AFTER the DDL, always: `hr-schema.sql`
  // drops every table and table privileges die with the table, so granting
  // before this point grants on tables that no longer exist. A separate role
  // from `foundry_ro` on purpose — see `ops-hr-role.ts`.
  const opsHrRole = await ensureOpsHrRole();

  // 2. Workspace (reuse by name so repeat provisioning doesn't fork the demo).
  const existing = (await workspaceRepo.list()).find((w) => w.name === DEMO_WORKSPACE_NAME);
  let workspaceId: string;
  let workspaceCreated = false;
  if (existing) {
    workspaceId = existing.id;
  } else {
    const ws = await workspaceService.create({
      name: DEMO_WORKSPACE_NAME,
      description:
        "HR demo workspace. ALL DATA IS SYNTHETIC — invented people on RFC 2606 reserved " +
        "domains, backed by the hr_demo database. Not employee data.",
    });
    workspaceId = ws.id;
    workspaceCreated = true;
  }

  // 3. Tools — upsert by name.
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
        // WS-B.5: must be in the UPDATE path too, or re-provisioning an existing
        // demo silently leaves the ticket tools with no <auth> element and every
        // ticket call 401s.
        secretEnvName: spec.secretEnvName ?? null,
        authStyle: spec.authStyle ?? null,
        authParamName: spec.authParamName ?? null,
      });
      updated++;
    } else {
      // Parse through the schema so zod defaults (isActive, isDummy) are applied
      // exactly as they would be for a request coming in over the API.
      await toolService.create(workspaceId, createToolSchema.parse(spec));
      created++;
    }
  }

  // 4. Datasource. The connection string points at host.docker.internal:5433 —
  // NOT localhost and NOT the compose service name — because generated scripts
  // run in a sibling container (plan §12). WS-A: it carries the READ-ONLY role's
  // credential; the owner credential is never registered.
  const dsName = "hr_demo";
  const dsList = await datasourceRepo.listByWorkspace(workspaceId);
  const dsExisting = dsList.find((d) => d.name === dsName);
  const connectionString = hrDbUrlForScripts();
  // ⚠ `verifyVia` — the D-40 read-only gate connects from the process doing the
  // registering, and that is a HOST process for every `demo:*` command, where
  // `host.docker.internal` does not resolve on Linux. Without this, `demo:seed`
  // failed with "could not verify that this credential is read-only" on a
  // credential that is demonstrably read-only. Same credential, same database;
  // host and port only, and `assertSameCredential` enforces that.
  const verifyVia = hrRoDbUrl();
  let datasourceId: string;
  let dsCreated = false;
  if (dsExisting) {
    await datasourceService.update(
      workspaceId,
      dsExisting.id,
      { connectionString, secretEnvName: config.demo.dbSecretEnvName },
      { verifyVia },
    );
    datasourceId = dsExisting.id;
  } else {
    const ds = await datasourceService.create(
      workspaceId,
      {
        name: dsName,
        type: "postgres",
        connectionString,
        secretEnvName: config.demo.dbSecretEnvName,
      },
      { verifyVia },
    );
    datasourceId = ds.id;
    dsCreated = true;
  }

  // 4b. One credential per ops-api service, stored in `workspace_secrets` — so
  // the step executor injects each under the env-var name the tool's `<auth>`
  // element renders.
  //
  // It used to be one secret, for ticketing, because that was the only
  // authenticated service. The fourteen operational tools plus `llm_complete`
  // authenticate now (see `tool-catalogue.ts`), across all four auth styles, so
  // the credential path is exercised fifteen times per run instead of three.
  // `http_request` is the deliberate exception: a fixed-URL POST with no
  // credential (`authStyle: null`).
  //
  // ⚠ `LLM_TOOL_TOKEN` is in this set and the LLM PROVIDER key is not. The
  // former is what a flow presents to ops-api; the latter lives inside ops-api,
  // is operator-configured, and must never be seeded into a workspace secret —
  // anything running in a flow can read one of those.
  //
  // The values are DERIVED from `OPS_API_KEY` rather than generated, so nothing
  // is committed and the two processes cannot drift into disagreement — see
  // `opsServiceKey`. Re-running `demo:seed` therefore re-puts identical values;
  // rotating means rotating the root.
  const opsSecrets: string[] = [];
  for (const service of OPS_SERVICES) {
    const s = await workspaceSecretService.put(
      workspaceId,
      OPS_SECRET_ENV[service],
      opsServiceKey(service),
      `ops-api ${service} credential (${OPS_AUTH_STYLE[service].style}; synthetic, derived from OPS_API_KEY).`,
    );
    opsSecrets.push(s?.name ?? OPS_SECRET_ENV[service]);
  }

  // 5. Introspect. Note the connection string we STORE is the container-facing
  // one, but the parent process must introspect over its OWN network path —
  // localhost:5433 — or it cannot resolve host.docker.internal from the server
  // container's perspective in every setup. Use the parent-facing URL here.
  //
  // WS-A.6: introspect AS THE READ-ONLY ROLE, deliberately. Introspecting as the
  // owner would describe tables the script may not be able to read, producing a
  // manifest that promises data the credential refuses. Reading it with the same
  // credential the script gets makes the manifest exactly the script's visible
  // surface. §11 anticipates a restricted catalogue breaking this, so fall back
  // to the owner rather than failing provisioning — and say which was used,
  // because an owner-read manifest can over-promise.
  let introspectedAs: "read_only" | "owner" = "read_only";
  let introspected;
  try {
    introspected = await schemaIntrospectorService.refresh(datasourceId, "postgres", hrRoDbUrl(), {
      schemas: ["public"],
    });
  } catch (e) {
    console.warn(
      `[demo] introspection as ${config.demo.roRole} failed (${(e as Error).message}); ` +
        "falling back to the owner credential — the manifest may describe relations the " +
        "read-only role cannot actually read (production-substitution-plan.md §11)",
    );
    introspectedAs = "owner";
    introspected = await schemaIntrospectorService.refresh(datasourceId, "postgres", hrDbUrl(), {
      schemas: ["public"],
    });
  }
  // Deterministic mock build for the just-introspected shape (whichever
  // credential path above succeeded). Awaited so onboarding yields a ready
  // fixtures row + JSON file; never fails provisioning — refusals land as loud
  // failed fixture rows.
  const mock = await requestMockBuild(workspaceId, datasourceId).catch((e) => ({
    started: false as const,
    why: "build_failed" as const,
    detail: (e as Error).message,
  }));
  console.log(
    `[mock] ${mock.started ? `ready (v${mock.version})` : `not built (${mock.why}${mock.detail ? `: ${mock.detail}` : ""})`}`,
  );

  // 5b. Platform tools (email-send-tool T033). NOT demo data — `foundry_email_send`
  // is a product capability, so it must survive a reseed rather than being left
  // behind by one. `rebuildManifest: false` because step 6 below renders the
  // manifest once for everything; bumping the version here as well would make the
  // version a count of provisioning steps rather than of catalogue changes.
  await registerPlatformTools(workspaceId, { rebuildManifest: false });

  // 6. Rebuild the manifest so the new tools + schema are versioned.
  const manifest = await manifestBuilderService.buildAndPersist(workspaceId);

  return {
    workspaceId,
    workspaceCreated,
    seed,
    tools: { created, updated, total: catalogue.length },
    datasource: {
      id: datasourceId,
      created: dsCreated,
      secretEnvName: config.demo.dbSecretEnvName,
      tablesIntrospected: introspected.tables,
      columnsIntrospected: introspected.columns,
      introspectedAs,
    },
    opsHrRole,
    secrets: {
      stored: opsSecrets,
      ...(await workspaceSecretService.audit(workspaceId).then((a) => ({
        missing: a.missing,
        collisions: a.collisions,
      }))),
    },
    manifest: {
      version: manifest.version,
      changed: manifest.changed,
      bytes: manifest.manifestXml.length,
      summaryBytes: manifest.summaryXml.length,
    },
    oracle: expectedScreening(),
  };
}

/**
 * Resets the demo to its initial state.
 *
 * SCOPE IS DELIBERATELY NARROW. This reseeds `hr_demo` and truncates the four
 * stub_* capture tables — the side effects of demo runs. It does NOT touch
 * workspaces, tools, datasources, scripts, script_versions, test_results,
 * triggers or executions: a reset must never destroy an automation somebody
 * built. If you need that, delete the workspace explicitly.
 */
export async function resetDemo(): Promise<{
  seed: SeedReport;
  truncated: string[];
  preserved: string[];
  datasourceResynced: boolean;
}> {
  const seed = await seedHrDatabase();
  // Same ordering constraint as provisioning: the reseed just dropped every
  // table, taking ops-api's SELECT grants with them.
  await ensureOpsHrRole();

  // WS-A.3 rotation: seeding re-asserts the read-only role's password, so if
  // DEMO_DB_RO_PASSWORD changed, the DSN encrypted into `datasources` is now
  // stale and every generated script would fail to authenticate with nothing
  // reporting why. Re-register it. This overwrites one credential field; it does
  // not create, delete, or re-point the datasource, so the guarantee below holds.
  let datasourceResynced = false;
  const ws = (await workspaceRepo.list()).find((w) => w.name === DEMO_WORKSPACE_NAME);
  if (ws) {
    const ds = (await datasourceRepo.listByWorkspace(ws.id)).find((d) => d.name === "hr_demo");
    if (ds) {
      // `verifyVia` for the same reason as in provisioning above: `demo:reset`
      // is a host command and the stored hostname is container-facing.
      await datasourceService.update(
        ws.id,
        ds.id,
        { connectionString: hrDbUrlForScripts() },
        { verifyVia: hrRoDbUrl() },
      );
      datasourceResynced = true;
    }
  }

  // The four capture tables live in ops-api's database now, not this one, so
  // clearing them is an authenticated HTTP call rather than a TRUNCATE. The
  // parent holds no credential for that database — see `ops-client.service.ts`.
  //
  // It is NOT swallowed. `demo:reset` reporting success while the outbox still
  // holds the previous run's mail is the exact false green this migration keeps
  // finding: the next scenario then "sends 11 emails" into a table that already
  // had 11, and the count agrees with the oracle for the wrong reason.
  const truncated = (await opsClient.reset()).truncated;

  return {
    seed,
    truncated,
    datasourceResynced,
    preserved: [
      "workspaces",
      "tools",
      "datasources",
      "scripts",
      "script_versions",
      "test_results",
      "triggers",
      "execution_results",
    ],
  };
}

/** Non-destructive status. Safe on any deployment. */
export async function demoStatus() {
  const ws = (await workspaceRepo.list()).find((w) => w.name === DEMO_WORKSPACE_NAME);

  // Capture-table counts, over HTTP from ops-api.
  //
  // `-1` for a set it could not read, and it means something specific: not
  // "empty" but "not answered". Reporting 0 would make an unreachable tool layer
  // indistinguishable from a freshly reset one on the status pill, which is the
  // difference between "nothing has run yet" and "nothing CAN run".
  const counts: Record<string, number> = {
    mail_outbox: -1,
    chat_messages: -1,
    tickets: -1,
    api_call_log: -1,
  };
  const SETS = [
    ["mail", "mail_outbox"],
    ["chat", "chat_messages"],
    ["tickets", "tickets"],
    ["call-log", "api_call_log"],
  ] as const;
  for (const [set, table] of SETS) {
    try {
      counts[table] = (await opsClient.records(set, 1000)).length;
    } catch {
      /* leave at -1 */
    }
  }

  let hrDbReachable = false;
  let employeeCount = 0;
  // WS-A: report the read-only role's REAL privileges, re-derived from the
  // catalogue rather than from what we believe we granted.
  let readOnlyRole: {
    name: string;
    exists: boolean;
    selectableTables: number;
    problems: string[];
  } = { name: config.demo.roRole, exists: false, selectableTables: 0, problems: [] };
  try {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: hrDbUrl(), connectionTimeoutMillis: 3000 });
    await c.connect();
    const r = await c.query("SELECT count(*)::int AS n FROM employees");
    employeeCount = r.rows[0].n as number;
    hrDbReachable = true;
    const v = await verifyReadOnlyRole(c);
    readOnlyRole = {
      name: config.demo.roRole,
      exists: !v.problems.includes(`role ${config.demo.roRole} does not exist`),
      selectableTables: v.selectableTables.length,
      problems: v.problems,
    };
    await c.end();
  } catch {
    /* not seeded yet */
  }

  // Prove the script-facing DSN really is the read-only one. Comparing to the
  // role name is enough and — unlike echoing the DSN — cannot leak a password.
  const scriptsDsn = new URL(hrDbUrlForScripts());

  return {
    workspaceId: ws?.id ?? null,
    workspaceName: DEMO_WORKSPACE_NAME,
    provisioned: Boolean(ws),
    toolCount: ws ? (await toolRepo.listByWorkspace(ws.id)).length : 0,
    datasourceCount: ws ? (await datasourceRepo.listByWorkspace(ws.id)).length : 0,
    hrDatabase: {
      name: config.demo.dbName,
      reachable: hrDbReachable,
      employeeCount,
      connectionStringForScripts: hrDbUrlForScripts().replace(/:\/\/[^@]*@/, "://***:***@"),
      // The username in the DSN generated scripts receive. Must be the RO role.
      scriptsConnectAs: decodeURIComponent(scriptsDsn.username),
      scriptsUseReadOnlyRole: decodeURIComponent(scriptsDsn.username) === config.demo.roRole,
      readOnlyRole,
    },
    captureCounts: counts,
    dataProvenance:
      "ALL DEMO DATA IS SYNTHETIC. Invented names; emails on RFC 2606 reserved domains " +
      "(acme-hr.example / acme-hr-bounce.example) which cannot resolve or receive mail. " +
      "Nothing is ever transmitted.",
  };
}
