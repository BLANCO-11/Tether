/**
 * A SQLite TEXT column every value of which is an ISO date is typed a date (2026-10-01) — read from the data by one count, never
 * from the column's name. One non-date, or a number stored in it, and it stays text.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "../sqlite-driver.js";
import { dateShapeOf, dateShapeSql } from "./sqlite.introspector.js";

const shapeOf = (values: Array<string | number | null>) => {
  const db = new DatabaseSync(":memory:");
  db.exec('CREATE TABLE t ("when" TEXT)');
  const ins = db.prepare('INSERT INTO t ("when") VALUES (?)');
  for (const v of values) ins.run(v);
  const all = db.prepare('SELECT count("when") AS n FROM t').get() as { n: number };
  const r = db.prepare(dateShapeSql("t", "when")).get() as { n: number; d: number | null; ts: number | null };
  db.close();
  return dateShapeOf(r, Number(all.n));
};

describe("the shape of a TEXT column's values", () => {
  it("all ISO dates (nulls aside) → date; all ISO date-times → timestamp", () => {
    expect(shapeOf(["2026-08-01", "2026-08-14", null])).toBe("date");
    expect(shapeOf(["2026-04-01T14:40:45.240+00:00", "2026-09-11 09:04:00"])).toBe("timestamp without time zone");
  });
  it("CONTROL: one value of another shape, a mix of dates and date-times, a number, or no values — the declared text stands", () => {
    expect(shapeOf(["2026-08-01", "1 August"])).toBeNull();
    expect(shapeOf(["2026-08-01", "2026-08-01T10:00:00"])).toBeNull();
    expect(shapeOf(["2026-08-01", 20260801])).toBeNull();
    expect(shapeOf([null, null])).toBeNull();
    expect(shapeOf(["full_day", "first_half"])).toBeNull();
  });
});

describe("an observed set of choices", async () => {
  const { isChoiceSet } = await import("./postgres.introspector.js");
  it("few recurring values are a set; an address among them is not (it records who, and would reach every prompt)", () => {
    expect(isChoiceSet(["Active", "Terminated"], 6800)).toBe(true);
    expect(isChoiceSet(["ML_INT", "someone@example.com"], 2700)).toBe(false);
    expect(isChoiceSet(["a", "b", "c"], 4)).toBe(false); // not recurring
  });
});

describe("a view's column carries its table column's foreign key (2026-10-01)", async () => {
  const { viewKeys } = await import("./sqlite.introspector.js");
  it("an origin column's key is the view column's; a computed column declares nothing", () => {
    const db = new DatabaseSync(":memory:");
    db.exec('CREATE TABLE kind (code TEXT PRIMARY KEY, name TEXT); CREATE TABLE acct (id INTEGER PRIMARY KEY, code TEXT REFERENCES kind(code), n REAL); CREATE VIEW v_acct AS SELECT id, code, n * 2 AS twice FROM acct');
    const col = (name: string, o: Record<string, unknown> = {}) => ({ name, type: "text", nullable: true, isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, characterMaximumLength: null, ...o });
    const entities = [
      { entityType: "table" as const, name: "acct", schema: "main", rowCountEstimate: 0, columns: [col("id"), col("code", { isForeignKey: true, foreignKeyReference: "kind.code" }), col("n")] },
      { entityType: "view" as const, name: "v_acct", schema: "main", rowCountEstimate: null, columns: [col("id"), col("code"), col("twice")] },
    ];
    viewKeys(db, entities);
    db.close();
    expect(entities[1]!.columns.find((c) => c.name === "code")).toMatchObject({ isForeignKey: true, foreignKeyReference: "kind.code" });
    expect(entities[1]!.columns.find((c) => c.name === "twice")).toMatchObject({ isForeignKey: false });
    expect(entities[1]!.columns.find((c) => c.name === "id")).toMatchObject({ isForeignKey: false });
  });
});

describe("a view's column records its origin, so an owner's declaration on the table reaches it (P5-I11)", async () => {
  const { viewKeys } = await import("./sqlite.introspector.js");
  const { applyColumnTags } = await import("../datasource-column-tags.js");
  it("through a real SQLite view, a declared table column's tag reaches the view column selected from it — not a computed one", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, mail TEXT, boss INTEGER); CREATE VIEW vp AS SELECT a.id, b.mail AS boss_mail, a.mail || '' AS copied FROM p a LEFT JOIN p b ON b.id = a.boss");
    const col = (name: string) => ({ name, type: "text", nullable: true, isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, characterMaximumLength: null });
    const entities = [
      { entityType: "table" as const, name: "p", schema: "main", rowCountEstimate: 0, columns: [col("id"), col("mail"), col("boss")] },
      { entityType: "view" as const, name: "vp", schema: "main", rowCountEstimate: null, columns: [col("id"), col("boss_mail"), col("copied")] },
    ];
    viewKeys(db, entities);
    db.close();
    expect(entities[1]!.columns[1]).toMatchObject({ origin: { table: "p", column: "mail" } });
    expect(applyColumnTags(entities, { "main.p.mail": "email" })).toEqual([]);
    expect(entities[1]!.columns.map((c) => (c as { tag?: string }).tag ?? null)).toEqual([null, "email", null]);
  });
});
