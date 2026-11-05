import { workspaceFileService } from "../services/workspace-file.service.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { CATALOGUE_ROOT } from "./paths.js";
import { flowCatalogueService } from "../services/flow-catalogue.service.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import { sandboxDir } from "./sandbox-fs.js";
import { datasourceFixtureRepo } from "../repositories/datasource-fixture.repo.js";
import { profileFixture, type TableProfile } from "./test-data-profile.js";

type TableSummary = {
  schema: string;
  name: string;
  /** `required`: the database refuses a blank (NOT NULL). Absent, real data may have blanks even when the test data has none. */
  columns: Array<{ name: string; type: string | null; required?: true }>;
  /** What the TEST data holds for this table (its ready mock fixture) — absent when it has none. */
  test_data?: TableProfile;
};

/**
 * Workspace catalogue lives once under `.pi-sandboxes/_catalog/<ws>/catalogue.json`.
 * Each Pi sandbox gets a symlink at `sandbox/catalogue.json` — Pi reads that path;
 * we refresh the single file when a session starts (and on demand).
 *
 * ⚠ `entries` alone is only CALLABLE refs (tools / queries / ops). HR often has
 * a datasource with schema but zero DB operations — Pi then reports "no database"
 * even when Attendance_DB is right there. `datasources` closes that gap.
 */
export async function refreshWorkspaceCatalogue(workspaceId: string): Promise<string> {
  const dir = join(CATALOGUE_ROOT, workspaceId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "catalogue.json");
  const [cat, datasources, operations, queries, files] = await Promise.all([
    flowCatalogueService.forWorkspace(workspaceId),
    datasourceRepo.listByWorkspace(workspaceId),
    dbOperationRepo.listByWorkspace(workspaceId),
    datasourceQueryRepo.listByWorkspace(workspaceId),
    workspaceFileService.list(workspaceId),
  ]);

  const opsByDs = new Map<string, string[]>();
  for (const { operation, datasource } of operations) {
    const list = opsByDs.get(datasource.id) ?? [];
    list.push(`${datasource.name}.${operation.name}`);
    opsByDs.set(datasource.id, list);
  }
  const queriesByDs = new Map<string, string[]>();
  for (const { query, datasource } of queries) {
    const list = queriesByDs.get(datasource.id) ?? [];
    list.push(`${datasource.name}.${query.name}`);
    queriesByDs.set(datasource.id, list);
  }

  const dsPayload = [];
  for (const ds of datasources) {
    const rows = await schemaRepo.listByDatasource(ds.id);
    const tables = new Map<string, TableSummary>();
    for (const r of rows) {
      if (!r.entityName) continue;
      const schema = r.entitySchema ?? "public";
      const key = `${schema}.${r.entityName}`;
      let t = tables.get(key);
      if (!t) {
        t = { schema, name: r.entityName, columns: [] };
        tables.set(key, t);
      }
      if (r.columnName) {
        t.columns.push({ name: r.columnName, type: r.columnType ?? null, ...(r.nullable === false ? { required: true as const } : {}) });
      }
    }
    // Test runs read the READY mock fixture; profile that (synthetic rows), never production.
    const fixture = await datasourceFixtureRepo.latestReady(ds.id);
    const profile = fixture ? profileFixture(fixture.rowsJson) : null;
    if (profile) {
      for (const t of tables.values()) {
        const p = profile[`${t.schema}.${t.name}`] ?? Object.entries(profile).find(([k]) => k.split(".").pop() === t.name)?.[1];
        if (p) t.test_data = p;
      }
    }
    dsPayload.push({
      id: ds.id,
      name: ds.name,
      type: ds.type,
      readers: {
        operations: opsByDs.get(ds.id) ?? [],
        queries: queriesByDs.get(ds.id) ?? [],
      },
      tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
      test_data: profile
        ? "Test runs read this datasource's TEST data, profiled per table under tables[].test_data (row count; per column: empty count, min/max of dates and numbers, the values of a column with few). Pick input defaults that select rows that exist there. It is INVENTED from the tables' shape, not a sample of the real data: never doubt or ask about a value the person gave because it is missing here."
        : "No test data for this datasource yet: a test run that reads it is refused until its mock data is built. Nothing about its contents is described here.",
      note:
        (opsByDs.get(ds.id)?.length ?? 0) === 0 && (queriesByDs.get(ds.id)?.length ?? 0) === 0
          ? "No DB operation or named query yet — schema is visible; prefer a matching tool in entries, or propose a new DB operation naming real columns from tables[]."
          : null,
    });
  }

  // ⚠ Only what a Pi step can USE (pi-runtime P2). The flow catalogue's `expressions` (the jq/Pebble allowlist),
  // `caps`, `outputs`, `models`, `triggers`, `tryable` and `drift` describe the Kestra compiler's vocabulary — a
  // Python step reaches none of it, and an expression allowlist in front of an agent writing Python is an
  // instruction to write the wrong language.
  const payload = {
    refreshedAt: new Date().toISOString(),
    workspaceId,
    entries: cat.entries.map((e) => ({
      ref: e.ref,
      kind: e.kind,
      description: e.description,
      params: e.params,
      ...(e.datasource ? { datasource: e.datasource } : {}),
      ...(e.sql ? { sql: e.sql } : {}),
    })),
    datasources: dsPayload,
    // Resources → Files: what a step can open while it RUNS — list "file:<name>" in its uses, then foundry.file("<name>").
    files: files.map((f) => ({ name: f.name, type: f.contentType, size_bytes: f.sizeBytes })),
    note:
      "Read-only description of this workspace for Forge, the workflow builder. " +
      "`datasources` = the workspace's databases with their real tables and columns, and the saved readers each has. " +
      "`entries` = everything a step can call: saved reads (kind operation/query — use as a read `ref`) and tools " +
      "(kind tool — use with foundry.call). `files` = the workspace's Files: a step opens one when it runs " +
      "(uses \"file:<name>\", then foundry.file(\"<name>\") gives its path), and you can open one while you build or to make a changed copy (tools/open-file.mjs). Never invent a name that is not here. " +
      "A column marked `required: true` is never blank; any other column may be blank in real data, " +
      "even where `test_data` shows no blanks.",
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

export function linkCatalogueIntoSandbox(workspaceId: string, sessionId: string): void {
  const target = join(CATALOGUE_ROOT, workspaceId, "catalogue.json");
  if (!existsSync(target)) return;
  const linkPath = join(sandboxDir(workspaceId, sessionId), "catalogue.json");
  try {
    if (existsSync(linkPath) || lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
  } catch {
    /* no prior */
  }
  try {
    symlinkSync(target, linkPath);
  } catch {
    writeFileSync(linkPath, readFileSync(target));
  }
}
