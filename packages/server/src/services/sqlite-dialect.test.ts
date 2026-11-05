/**
 * SQLite datasources run the SQL Foundry emits, which is Postgres-dialect.
 *
 * The property: a statement either runs on SQLite with the SAME meaning, or is
 * refused by name — never rewritten into something that runs and answers
 * differently. The second half of this file proves the first half against a
 * real SQLite database, using operations compiled by the real compiler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "./sqlite-driver.js";
import { bindValues, SqliteDialectError, toSqlite } from "./sqlite-dialect.js";
import { compileOperation } from "./db-operation.service.js";
import type { SchemaRow } from "../repositories/schema.repo.js";

describe("toSqlite — placeholders", () => {
  it("turns $n into ? and expands the bind list per occurrence, reusing a repeated number", () => {
    const s = toSqlite("SELECT * FROM t WHERE a = $2 OR b = $1 OR c = $2");
    expect(s.sql).toBe("SELECT * FROM t WHERE a = ? OR b = ? OR c = ?");
    expect(bindValues(s, ["one", "two"])).toEqual(["two", "one", "two"]);
  });

  it("leaves a $1 inside a string literal alone", () => {
    const s = toSqlite("SELECT '$1 off' AS promo, x FROM t WHERE y = $1");
    expect(s.sql).toBe("SELECT '$1 off' AS promo, x FROM t WHERE y = ?");
    expect(s.bindOrder).toEqual([0]);
  });

  it("binds booleans, dates and objects as values SQLite accepts", () => {
    const s = toSqlite("SELECT $1, $2, $3, $4");
    expect(bindValues(s, [true, new Date("2026-06-01T00:00:00Z"), { a: 1 }, undefined])).toEqual([
      1, "2026-06-01T00:00:00.000Z", '{"a":1}', null,
    ]);
  });

  it("a whole number binds as an INTEGER, so CAST to text and a TEXT comparison see '2026', not '2026.0'", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE d (work_date TEXT); INSERT INTO d VALUES ('2026-08-01'), ('2026-08-02')");
    const s = toSqlite("SELECT count(*) AS n, CAST($1 AS TEXT) AS y FROM d WHERE strftime('%Y', work_date) = CAST($1 AS TEXT) AND strftime('%m', work_date) = printf('%02d', $2)");
    expect({ ...(db.prepare(s.sql).get(...bindValues(s, [2026, 8])) as object) }).toEqual({ n: 2, y: "2026" });
    // control: a fractional number is still a REAL, never rounded into a different value
    expect({ ...(db.prepare("SELECT ? AS v").get(...bindValues(toSqlite("SELECT $1"), [4.75])) as object) }).toEqual({ v: 4.75 });
  });
});

describe("toSqlite — spellings with an exact equivalent", () => {
  it("ILIKE → LIKE", () => {
    expect(toSqlite(`SELECT * FROM t WHERE "n" ILIKE $1`).sql).toBe(`SELECT * FROM t WHERE "n" LIKE ?`);
  });
  it("= ANY($n) → IN (SELECT value FROM json_each(?))", () => {
    expect(toSqlite(`SELECT * FROM t WHERE "s" = ANY($1)`).sql).toBe(
      `SELECT * FROM t WHERE "s" IN (SELECT value FROM json_each(?))`,
    );
  });
  it("the compiler's month match by a DATE → strftime against the parameter's month; a text column by its own first seven", () => {
    expect(toSqlite(`SELECT * FROM t WHERE date_trunc('month', "t"."d"::date) = to_date(left($1::text, 7), 'YYYY-MM')`).sql).toBe(`SELECT * FROM t WHERE strftime('%Y-%m', "t"."d") = substr(?, 1, 7)`);
    expect(toSqlite(`SELECT * FROM t WHERE left("t"."p"::text, 7) = left($1::text, 7)`).sql).toBe(`SELECT * FROM t WHERE substr("t"."p", 1, 7) = substr(?, 1, 7)`);
  });
  it("the compiler's month match → strftime", () => {
    const s = toSqlite(`SELECT * FROM t WHERE date_trunc('month', "t"."d"::date) = to_date($1, 'YYYY-MM')`);
    expect(s.sql).toBe(`SELECT * FROM t WHERE strftime('%Y-%m', "t"."d") = ?`);
  });
});

describe("toSqlite — refuses what it cannot translate faithfully", () => {
  for (const [label, sql] of [
    ["a cast", `SELECT ("a"::date - "b"::date) FROM t`],
    ["EXTRACT", `SELECT EXTRACT(EPOCH FROM x) FROM t`],
    ["generate_series", `SELECT * FROM generate_series(1, 3)`],
    ["AT TIME ZONE", `SELECT x AT TIME ZONE 'UTC' FROM t`],
    ["interval", `SELECT now() + interval '1 day'`],
  ] as const) {
    it(`refuses ${label} rather than stripping it`, () => {
      expect(() => toSqlite(sql)).toThrow(SqliteDialectError);
    });
  }
  it("does not refuse a construct that only appears inside a literal", () => {
    expect(() => toSqlite(`SELECT 'a::b' AS x FROM t`)).not.toThrow();
  });
});

// ── Against a real database ─────────────────────────────────────────────────

function row(entityName: string, columnName: string | null, columnType: string | null): SchemaRow {
  return {
    id: `main.${entityName}.${columnName ?? ""}`,
    datasourceId: "ds",
    entityType: "table",
    entityName,
    entitySchema: "main",
    columnName,
    columnType,
    isPrimaryKey: false,
    isForeignKey: false,
    foreignKeyReference: null,
    nullable: true,
    characterMaximumLength: null,
    rowCountEstimate: null,
    nullPercentage: null,
    extractedAt: new Date("2026-10-01T00:00:00Z"),
  } as SchemaRow;
}

const SCHEMA: SchemaRow[] = [
  row("invoices", null, null),
  row("invoices", "id", "integer"),
  row("invoices", "customer_id", "integer"),
  row("invoices", "amount", "integer"),
  row("invoices", "status", "text"),
  row("invoices", "due_date", "text"),
  row("customers", null, null),
  row("customers", "id", "integer"),
  row("customers", "email", "text"),
  row("customers", "is_vip", "boolean"),
];

let dir: string;
let db: DatabaseSync;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-dialect-"));
  const file = path.join(dir, "t.db");
  const w = new DatabaseSync(file);
  w.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, is_vip INTEGER CHECK (is_vip IN (0,1)));
    CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                           amount INTEGER, status TEXT, due_date TEXT);
    INSERT INTO customers VALUES (1, 'a@x.example', 1), (2, 'b@x.example', 0);
    INSERT INTO invoices VALUES
      (10, 1, 500, 'Open', '2026-05-20'),
      (11, 1, 900, 'paid', '2026-06-02'),
      (12, 2, 300, 'open', '2026-06-15'),
      (13, 2, 700, 'void', '2026-07-01');
  `);
  w.close();
  db = new DatabaseSync(file, { readOnly: true });
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(spec: Parameters<typeof compileOperation>[0], params: Record<string, unknown>) {
  const c = compileOperation(spec, SCHEMA);
  const stmt = toSqlite(c.sql);
  const values = c.paramOrder.map((n) => (Array.isArray(params[n]) ? JSON.stringify(params[n]) : params[n]));
  return (db.prepare(stmt.sql).all(...bindValues(stmt, values)) as Record<string, unknown>[]).map((r) => ({ ...r }));
}

describe("compiled operations run on SQLite with the same meaning", () => {
  it("a join, a comparison filter and a sort", () => {
    const rows = run(
      {
        base: { table: "invoices" },
        columns: [{ column: "invoices.id", alias: "id" }, { column: "customers.email", alias: "email" }],
        joins: [{ table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" }],
        filters: [{ column: "due_date", op: "lt", param: "as_of" }],
        sort: [{ column: "amount", dir: "desc" }],
      },
      { as_of: "2026-06-30" },
    );
    expect(rows).toEqual([
      { id: 11, email: "a@x.example" },
      { id: 10, email: "a@x.example" },
      { id: 12, email: "b@x.example" },
    ]);
  });

  it("`in` over an array param", () => {
    const rows = run(
      { base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "status", op: "in", param: "s" }] },
      { s: ["paid", "void"] },
    );
    expect(rows.map((r) => r.id).sort()).toEqual([11, 13]);
  });

  it("`ilike` is case-insensitive", () => {
    const rows = run(
      { base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "status", op: "ilike", param: "s" }] },
      { s: "open" },
    );
    expect(rows.map((r) => r.id).sort()).toEqual([10, 12]);
  });

  it("`month` matches the month a person named", () => {
    const rows = run(
      { base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "due_date", op: "month", param: "period" }] },
      { period: "2026-06" },
    );
    expect(rows.map((r) => r.id).sort()).toEqual([11, 12]);
  });

  it("`month` given ANY DAY of the month matches that month — the same rows a `YYYY-MM` gives (one kind of time input)", () => {
    const spec = { base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "due_date", op: "month" as const, param: "period" }] };
    const ids = (period: string) => run(spec, { period }).map((r) => r.id).sort();
    expect(ids("2026-06-30")).toEqual([11, 12]);
    expect(ids("2026-06-01")).toEqual(ids("2026-06"));
    // CONTROL: the next month is a different answer, so the comparison is not vacuous.
    expect(ids("2026-07-01")).not.toEqual([11, 12]);
  });

  it("a fixed NUMBER compares on SQLite with the same meaning — and binds nothing", () => {
    const ids = run({ base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "amount", op: "gt" as const, value: 0 }] }, {}).map((r) => r.id).sort();
    // CONTROL: the same comparison through a parameter gives the same rows.
    expect(ids).toEqual(run({ base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "amount", op: "gt" as const, param: "min" }] }, { min: 0 }).map((r) => r.id).sort());
    expect(ids.length).toBeGreaterThan(0);
  });

  it("a true/false column is compared with TRUE/FALSE — a declared flag stored 1/0 on SQLite gives the same rows", () => {
    const vip = (value: boolean) => run({ base: { table: "customers" }, columns: [{ column: "id", alias: "id" }], filters: [{ column: "is_vip", op: "eq" as const, value }] }, {}).map((r) => r.id);
    expect(vip(true)).toEqual([1]);
    expect(vip(false)).toEqual([2]);
  });

  it("the engine refuses a write on a read-only handle", () => {
    expect(() => db.exec("DELETE FROM invoices")).toThrow(/readonly/);
  });
});
