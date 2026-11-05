/**
 * A SQLite datasource's file: what an upload must be before anything is
 * stored, that the stored copy is the uploaded one, that a workspace can only
 * register its own file, and that introspection reads the real structure.
 *
 * The repository is replaced with an in-memory map; everything else —
 * validation, encryption, materialisation, the introspector — is the real code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const rows = new Map<string, Record<string, unknown>>();
vi.mock("../repositories/datasource-file.repo.js", () => ({
  datasourceFileRepo: {
    async create(r: Record<string, unknown>) {
      const id = crypto.randomUUID();
      const row: Record<string, unknown> = { id, datasourceId: null, createdAt: new Date(), ...r };
      rows.set(id, row);
      const { contentEnc: _drop, ...meta } = row;
      return meta;
    },
    async getMeta(id: string) {
      const r = rows.get(id);
      if (!r) return undefined;
      const { contentEnc: _drop, ...meta } = r;
      return meta;
    },
    async getWithContent(id: string) {
      return rows.get(id);
    },
    async claim() {},
    async sweepUnclaimed() {},
    async removeOthers() {},
  },
}));

const { sqliteFileService, dsnFor, fileIdOf, MAX_SQLITE_BYTES } = await import("./sqlite-file.service.js");
const { sqliteIntrospector, describeSqliteQuery } = await import("./introspect/sqlite.introspector.js");
const { DatabaseSync } = await import("./sqlite-driver.js");

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
let dir: string;

function buildDb(sql: string, wal = false): Buffer {
  const file = path.join(dir, `${crypto.randomUUID()}.db`);
  const w = new DatabaseSync(file);
  if (wal) w.exec("PRAGMA journal_mode = WAL");
  w.exec(sql);
  if (wal) w.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  w.close();
  return fs.readFileSync(file);
}

const HR = `
  CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT,
                          department_id INTEGER REFERENCES departments(id));
  CREATE VIEW engineering AS SELECT e.* FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.name = 'Engineering';
  INSERT INTO departments VALUES (1, 'Engineering'), (2, 'Sales');
  INSERT INTO employees VALUES (1, 'Ada', 'ada@acme.example', 1), (2, 'Bo', NULL, 2), (3, 'Cy', 'cy@acme.example', 1);
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-file-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("an upload is refused before anything is stored", () => {
  it("refuses an empty body", async () => {
    await expect(sqliteFileService.store(WS, Buffer.alloc(0))).rejects.toThrow(/no file/);
  });
  it("refuses a file that is not SQLite", async () => {
    await expect(sqliteFileService.store(WS, Buffer.from("id,name\n1,Ada\n".repeat(20)))).rejects.toThrow(/not a SQLite database/);
  });
  it("refuses a file over 50 MB, by size, with a 413", async () => {
    const big = Buffer.alloc(MAX_SQLITE_BYTES + 1);
    await expect(sqliteFileService.store(WS, big)).rejects.toMatchObject({ statusCode: 413 });
  });
  it("refuses a database with nothing to read", async () => {
    await expect(sqliteFileService.store(WS, buildDb("PRAGMA user_version = 1"))).rejects.toThrow(/no tables or views/);
  });
  it("refuses a truncated file that still carries the header", async () => {
    const good = buildDb(HR + "CREATE TABLE pad (x BLOB); INSERT INTO pad VALUES (randomblob(20000));");
    await expect(sqliteFileService.store(WS, good.subarray(0, 4096 + 100))).rejects.toThrow(/SQLite/);
  });
  it("stores nothing on refusal", () => {
    expect(rows.size).toBe(0);
  });
});

describe("a valid upload", () => {
  it("is stored encrypted, and the materialised copy is byte-identical", async () => {
    const bytes = buildDb(HR);
    const f = await sqliteFileService.store(WS, bytes, "hr.db");
    expect(f).toMatchObject({ tables: 2, views: 1, sizeBytes: bytes.length, filename: "hr.db" });
    const stored = rows.get(f.id)!.contentEnc as Buffer;
    expect(stored.includes(Buffer.from("ada@acme.example"))).toBe(false);
    const p = await sqliteFileService.pathFor(dsnFor(f.id));
    expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    expect(fs.statSync(p).mode & 0o077).toBe(0);
  });

  it("a WAL-mode file is switched to a rollback journal so it opens read-only", async () => {
    const bytes = buildDb(HR, true);
    expect(bytes[18]).toBe(2);
    const f = await sqliteFileService.store(WS, bytes);
    const ok = await sqliteIntrospector.testConnection(dsnFor(f.id));
    expect(ok).toEqual({ ok: true });
  });
});

describe("registration can only point at this workspace's own file", () => {
  it("accepts the owner and refuses another workspace", async () => {
    const f = await sqliteFileService.store(WS, buildDb(HR));
    await expect(sqliteFileService.assertOwned(WS, f.id)).resolves.toMatchObject({ id: f.id });
    await expect(sqliteFileService.assertOwned(OTHER_WS, f.id)).rejects.toThrow(/not uploaded to this workspace/);
    await expect(sqliteFileService.assertOwned(WS, "not-a-uuid")).rejects.toThrow();
  });
  it("parses only its own DSN shape", () => {
    const id = crypto.randomUUID();
    expect(fileIdOf(dsnFor(id))).toBe(id);
    expect(fileIdOf("sqlite:file/../../etc/passwd")).toBeNull();
    expect(fileIdOf("postgres://h/db")).toBeNull();
  });
});

describe("introspection", () => {
  it("reports tables, a view, keys, nullability and exact counts under `main`", async () => {
    const f = await sqliteFileService.store(WS, buildDb(HR));
    const r = await sqliteIntrospector.introspect(dsnFor(f.id));
    const byName = Object.fromEntries(r.entities.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(["departments", "employees", "engineering"]);
    expect(byName.engineering.entityType).toBe("view");
    expect(byName.employees).toMatchObject({ schema: "main", rowCountEstimate: 3 });
    const cols = Object.fromEntries(byName.employees.columns.map((c) => [c.name, c]));
    expect(cols.id).toMatchObject({ isPrimaryKey: true, nullable: false });
    expect(cols.name).toMatchObject({ nullable: false, type: "text" });
    expect(cols.email.nullable).toBe(true);
    expect(cols.department_id).toMatchObject({ isForeignKey: true, foreignKeyReference: "departments.id" });
  });

  it("describes a named query's result columns without reading a row", async () => {
    const f = await sqliteFileService.store(WS, buildDb(HR));
    const d = await describeSqliteQuery(dsnFor(f.id), `SELECT name, email FROM "main"."employees" WHERE department_id = $1`, ["dept"]);
    expect(d?.columns.map((c) => c.name)).toEqual(["name", "email"]);
    expect(d?.params).toEqual([{ name: "dept", type: "unknown" }]);
  });
});

describe("declared types are read as the names the rest of Foundry understands", () => {
  it("follows SQLite's affinity rules, plus the date/boolean/json names", async () => {
    const { normaliseSqliteType } = await import("./introspect/sqlite.introspector.js");
    const t = (d: string) => normaliseSqliteType(d);
    expect(t("INTEGER")).toEqual({ type: "integer", maxLength: null });
    expect(t("BIGINT")).toEqual({ type: "bigint", maxLength: null });
    expect(t("VARCHAR(40)")).toEqual({ type: "character varying", maxLength: 40 });
    expect(t("nvarchar")).toEqual({ type: "text", maxLength: null });
    expect(t("DATETIME").type).toBe("timestamp without time zone");
    expect(t("DATE").type).toBe("date");
    expect(t("BOOLEAN").type).toBe("boolean");
    expect(t("DECIMAL(10,2)").type).toBe("numeric");
    expect(t("REAL").type).toBe("double precision");
    // Words that merely CONTAIN "int" are not integers.
    expect(t("POINT").type).toBe("point");
    // Nothing declared, or nothing placeable, is kept as-is rather than widened to text.
    expect(t("").type).toBe("any");
    expect(t("BLOB").type).toBe("blob");
  });
});

describe("mock data for a SQLite datasource", () => {
  it("builds from the introspected schema and answers a query in SQLite, not from the upload", async () => {
    const { deriveShape } = await import("./sandbox-ddl.service.js");
    const { generateMockRows } = await import("./mock-dataset.service.js");
    const { sqliteMockDriver } = await import("./mock-engine/sqlite.driver.js");
    const { driverFor } = await import("./mock-engine/registry.js");
    expect(driverFor("sqlite")).toBe(sqliteMockDriver);

    const f = await sqliteFileService.store(WS, buildDb(HR));
    const { entities } = await sqliteIntrospector.introspect(dsnFor(f.id));
    const shape = deriveShape(entities, { allowlist: ["main"] });
    expect(shape.unsupported).toEqual([]);
    const rows = generateMockRows(shape);
    const tables = shape.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({ name: c.name, type: c.sqlType })),
      rows: rows[t.key] ?? [],
    }));

    const h = await sqliteMockDriver.prepare(WS, "ds", shape.fingerprint, tables);
    try {
      const r = await sqliteMockDriver.query(
        h,
        `SELECT e."name", d."name" AS dept FROM "main"."employees" e JOIN "main"."departments" d ON d."id" = e."department_id" WHERE e."name" ILIKE $1`,
        ["%"],
      );
      expect(r.rows.length).toBeGreaterThan(0);
      // Mock rows, never the uploaded ones.
      expect(r.rows.map((x) => x.name)).not.toContain("Ada");
      await expect(sqliteMockDriver.query(h, `DELETE FROM "main"."employees"`, [])).rejects.toThrow(/refused/);
    } finally {
      await sqliteMockDriver.destroy(h);
    }
  });

  it("stops at the row cap while stepping", async () => {
    const { createSqliteMockDriver } = await import("./mock-engine/sqlite.driver.js");
    const d = createSqliteMockDriver({ maxRows: 7 });
    const h = await d.prepare(WS, "ds", "fp", [
      { name: "t", columns: [{ name: "n", type: "integer" }], rows: Array.from({ length: 10 }, (_, i) => ({ n: i })) },
    ]);
    const r = await d.query(h, `SELECT a.n FROM t a, t b, t c`, []);
    expect(r.rows).toHaveLength(7);
    await d.destroy(h);
  });
});

describe("a reader is asked whether it RUNS on SQLite before it is saved", () => {
  it("passes a statement SQLite runs, including ones the translator rewrites", async () => {
    const f = await sqliteFileService.store(WS, buildDb(HR));
    const dsn = dsnFor(f.id);
    expect(await sqliteFileService.statementProblem(dsn, `SELECT "name" FROM "main"."employees" WHERE "email" ILIKE $1`)).toBeNull();
    expect(await sqliteFileService.statementProblem(dsn, `SELECT "name" FROM "employees" WHERE "id" = ANY($1)`)).toBeNull();
  });

  it("refuses what would only fail at run time: Postgres-only syntax, unknown functions and columns", async () => {
    const f = await sqliteFileService.store(WS, buildDb(HR));
    const dsn = dsnFor(f.id);
    expect(await sqliteFileService.statementProblem(dsn, `SELECT "id"::text FROM "employees"`)).toMatch(/cast/);
    expect(await sqliteFileService.statementProblem(dsn, `SELECT now() FROM "employees"`)).toMatch(/no such function/);
    expect(await sqliteFileService.statementProblem(dsn, `SELECT "salary" FROM "employees"`)).toMatch(/no such column/);
  });
});
