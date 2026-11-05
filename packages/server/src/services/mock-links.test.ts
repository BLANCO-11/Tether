/**
 * Links between tables that no schema declares, measured from the data — and only links that are really there.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "./sqlite-driver.js";
import { applyLinks, inferLinks, profileShape, weightByFrequency, type ColumnProfile } from "./mock-links.js";
import type { SandboxColumn, SandboxShape, SandboxTable } from "./sandbox-ddl.service.js";

const prof = (ref: string, values: string[], rows = values.length, integer = false): ColumnProfile => ({
  ref,
  integer,
  rows,
  distinct: new Set(values).size,
  values: new Set(values),
});
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

describe("inferLinks", () => {
  it("links a repeating column to the unique one holding the same values", () => {
    const links = inferLinks([
      prof("muster.User ID", ids(3000), 103_000),
      prof("headcount.Employee ID", ids(3387)),
    ]);
    expect(links).toEqual([{ child: "muster.User ID", parent: "headcount.Employee ID", shared: 3000 }]);
  });

  it("never links within one table, or two columns that barely overlap", () => {
    expect(inferLinks([prof("a.x", ids(100)), prof("a.y", ids(100))])).toEqual([]);
    expect(inferLinks([prof("a.x", ids(1000)), prof("b.y", ids(1000, 980))])).toEqual([]); // 21 shared of 1000
  });

  it("does not link two whole-number columns unless one is an ID", () => {
    const counts = (t: string) => prof(t, ids(500), 5000, true);
    expect(inferLinks([counts("a.amount"), counts("b.amount")])).toEqual([]);
    expect(inferLinks([prof("a.emp", ids(500), 5000, true), prof("b.id", ids(500), 500, true)])).toHaveLength(1);
  });

  it("does not link dates stored as text, or columns with too few values to mean anything", () => {
    const days = Array.from({ length: 60 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}`);
    expect(inferLinks([prof("a.day", days), prof("b.day", days)])).toEqual([]);
    expect(inferLinks([prof("a.flag", ids(5)), prof("b.flag", ids(5))])).toEqual([]);
  });
});

const col = (name: string, over: Partial<SandboxColumn> = {}): SandboxColumn =>
  ({ name, sqlType: "text", kind: "text", nullable: true, isPrimaryKey: false, references: null, maxLength: null, ...over }) as SandboxColumn;
const table = (name: string, columns: SandboxColumn[]): SandboxTable =>
  ({ schema: null, name, key: `main.${name}`, sourceKind: "table", columns }) as SandboxTable;

describe("applyLinks", () => {
  it("gives the child the parent's values, so a join finds rows; a child primary key keeps its own", () => {
    const shape = { tables: [table("muster", [col("User ID"), col("id", { isPrimaryKey: true })]), table("headcount", [col("Employee ID")])] } as SandboxShape;
    const rows = {
      "main.muster": [{ "User ID": "mock_U_1", id: "m1" }, { "User ID": "mock_U_2", id: "m2" }, { "User ID": "mock_U_3", id: "m3" }],
      "main.headcount": [{ "Employee ID": "mock_E_1" }, { "Employee ID": "mock_E_2" }],
    };
    applyLinks(shape, rows, [
      { child: "muster.User ID", parent: "headcount.Employee ID", shared: 100 },
      { child: "muster.id", parent: "headcount.Employee ID", shared: 100 },
    ]);
    expect(rows["main.muster"].map((r) => r["User ID"])).toEqual(["mock_E_1", "mock_E_2", "mock_E_1"]);
    expect(rows["main.muster"].map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("a chain of links", () => {
  it("shares one set: a manager ID that links to a person ID that links to an employee ID takes the employee IDs", () => {
    const shape = { tables: [table("hc", [col("Employee ID"), col("Manager ID")]), table("ta", [col("Person ID")])] } as SandboxShape;
    const rows = {
      "main.hc": [{ "Employee ID": "E1", "Manager ID": "m1" }, { "Employee ID": "E2", "Manager ID": "m2" }],
      "main.ta": [{ "Person ID": "p1" }, { "Person ID": "p2" }],
    };
    // Sorted as inferLinks returns them: the manager link comes first, before the link it depends on.
    applyLinks(shape, rows, [
      { child: "hc.Manager ID", parent: "ta.Person ID", shared: 40 },
      { child: "ta.Person ID", parent: "hc.Employee ID", shared: 40 },
    ]);
    expect(rows["main.ta"].map((r) => r["Person ID"])).toEqual(["E1", "E2"]);
    expect(rows["main.hc"].map((r) => r["Manager ID"])).toEqual(["E1", "E2"]);
  });
});

describe("profileShape, over a real SQLite file", () => {
  it("finds the link an uploaded file never declared", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec('CREATE TABLE muster ("User ID" TEXT, "Status" TEXT); CREATE TABLE headcount ("Employee ID" TEXT, "Band" TEXT)');
    const m = db.prepare("INSERT INTO muster VALUES (?, ?)");
    for (let i = 0; i < 600; i++) m.run(`E${(i % 50) + 1}`, i % 2 ? "Present" : "Absent");
    const h = db.prepare("INSERT INTO headcount VALUES (?, ?)");
    for (let i = 1; i <= 60; i++) h.run(`E${i}`, `P${i % 4}`);
    const shape = { tables: [table("muster", [col("User ID"), col("Status")]), table("headcount", [col("Employee ID"), col("Band")])] } as SandboxShape;
    const profiles = await profileShape(shape, async (sql) => db.prepare(sql).all() as Array<Record<string, unknown>>);
    expect(inferLinks(profiles)).toEqual([{ child: "muster.User ID", parent: "headcount.Employee ID", shared: 50 }]);
    db.close();
  });
});

describe("weightByFrequency", () => {
  it("lays test rows out in the real data's proportions, most common first, and still names every value", () => {
    const counts = new Map([["India", 9000], ["Canada", 600], ["Hungary", 400], ["Australia", 3]]);
    const out = weightByFrequency(["Australia", "Canada", "Hungary", "India"], counts, 10);
    expect(out.slice(0, 10)).toEqual(["India", "India", "India", "India", "India", "India", "India", "India", "India", "Canada"]);
    expect(out).toContain("Australia");
    expect(out).toContain("Hungary");
  });

  it("keeps the list as it was when nothing could be counted", () => {
    expect(weightByFrequency(["a", "b"], new Map(), 10)).toEqual(["a", "b"]);
  });
});
