/**
 * A SQLite column is TRUE/FALSE when its declaration says so — never from its values, never from its name.
 * Against a real database file, with the controls that make the rule mean something: a column holding only 0 and 1 with no
 * declaration, and a quantity whose two values both lie in [0,1], are NOT flags.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../sqlite-driver.js";
import { asFlags, checksZeroOne, flagResults, sqliteFlagColumns } from "./sqlite-flags.js";

let dir: string;
let db: DatabaseSync;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-flags-"));
  const file = path.join(dir, "f.db");
  const w = new DatabaseSync(file);
  w.exec(`
    CREATE TABLE day_kind (id INTEGER PRIMARY KEY, name TEXT, is_open INTEGER NOT NULL CHECK (is_open IN (0,1)));
    CREATE TABLE person (id INTEGER PRIMARY KEY, active BOOLEAN, "full time" INTEGER, CHECK ("full time" IN (1, 0)));
    CREATE TABLE absence (id INTEGER PRIMARY KEY, days REAL, seen INTEGER, level INTEGER CHECK (level IN (0,1,2)));
    INSERT INTO day_kind VALUES (1, 'weekday', 1), (2, 'rest', 0);
    INSERT INTO person VALUES (1, 1, 0), (2, 0, 1);
    INSERT INTO absence VALUES (1, 0.5, 0, 0), (2, 1, 1, 1);
    CREATE VIEW v_day AS SELECT name, is_open, id + 0 AS n FROM day_kind;
  `);
  w.close();
  db = new DatabaseSync(file, { readOnly: true });
});
afterAll(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("a flag is what the schema DECLARES", () => {
  it("a CHECK to 0/1 (column or table constraint, any quoting, either order) and a declared BOOLEAN", () => {
    expect([...sqliteFlagColumns(db)].sort()).toEqual(["day_kind.is_open", "person.active", "person.full time"]);
  });
  it("CONTROL: values that happen to be 0/1, a quantity in [0,1], and a CHECK allowing a third value are not flags", () => {
    const f = sqliteFlagColumns(db);
    for (const c of ["absence.seen", "absence.days", "absence.level"]) expect(f.has(c)).toBe(false);
    expect(checksZeroOne("CHECK (x IN (0,1,2))", "x")).toBe(false);
    expect(checksZeroOne("CHECK (x IN (1,1))", "x")).toBe(false);
    // The CHECK is about ITS column: another column's constraint does not make this one a flag.
    expect(checksZeroOne("a INTEGER, b INTEGER CHECK (b IN (0,1))", "a")).toBe(false);
  });
});

describe("a flag read back is true/false — through a view, never for a computed column", () => {
  it("a view's column whose origin is a flag is a flag; a computed column is not", () => {
    const stmt = db.prepare("SELECT * FROM v_day ORDER BY n");
    const named = flagResults(stmt.columns() as never, sqliteFlagColumns(db));
    expect(named).toEqual(["is_open"]);
    const rows = (stmt.all() as Record<string, unknown>[]).map((r) => asFlags({ ...r }, named));
    expect(rows).toEqual([{ name: "weekday", is_open: true, n: 1 }, { name: "rest", is_open: false, n: 2 }]);
  });
  it("only 1 and 0 are turned: a NULL or any other value is left as it is", () => {
    expect(asFlags({ a: null, b: 2, c: 1 }, ["a", "b", "c"])).toEqual({ a: null, b: 2, c: true });
    // CONTROL: no named fields → the row is returned untouched.
    expect(asFlags({ a: 1 }, [])).toEqual({ a: 1 });
  });
});
