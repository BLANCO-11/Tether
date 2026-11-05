/** An owner's column declarations on a datasource (P5-I11). Name-free: `t`, `v`, `c`. */
import { describe, expect, it } from "vitest";
import { applyColumnTags, columnKey, columnTagProblems } from "./datasource-column-tags.js";
import type { IntrospectedColumn, IntrospectedEntity } from "./introspect/types.js";

const col = (name: string, type: string, extra: Partial<IntrospectedColumn> = {}): IntrospectedColumn =>
  ({ name, type, nullable: true, isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, characterMaximumLength: null, ...extra });
const entities = (): IntrospectedEntity[] => [
  { name: "t", entityType: "table", columns: [col("a", "text"), col("n", "integer"), col("s", "text", { tag: "key" })] },
  { name: "v", entityType: "view", columns: [col("a2", "text", { origin: { table: "t", column: "a" } }), col("b", "text")] },
] as IntrospectedEntity[];

describe("applyColumnTags — a declaration fills a silence", () => {
  it("a declared text column becomes an email, and a view column selected from it does too", () => {
    const e = entities();
    expect(applyColumnTags(e, { "t.a": "email" })).toEqual([]);
    expect(e[0]!.columns[0]!.tag).toBe("email");
    expect(e[1]!.columns[0]!.tag).toBe("email");
    expect(e[1]!.columns[1]!.tag).toBeUndefined();
  });
  it("a view column can be declared on its own", () => {
    const e = entities();
    applyColumnTags(e, { "v.b": "email" });
    expect(e[1]!.columns[1]!.tag).toBe("email");
  });
  it("CONTROL: a column that is not there, of the wrong kind, or tagged otherwise by the schema is refused by name and left as it is", () => {
    const e = entities();
    const p = applyColumnTags(e, { "t.zz": "email", "t.n": "email", "t.s": "email", "t.a": "phone" });
    expect(p.join("\n")).toMatch(/`t.zz`.*no such column/);
    expect(p.join("\n")).toMatch(/`t.n`.*integer, not text/);
    expect(p.join("\n")).toMatch(/`t.s`.*says key/);
    expect(p.join("\n")).toMatch(/`t.a`: “phone” is not a tag/);
    expect(e[0]!.columns.map((c) => c.tag ?? null)).toEqual([null, null, "key"]);
  });
  it("CONTROL: no declarations change nothing", () => {
    const e = entities();
    expect(applyColumnTags(e, {})).toEqual([]);
    expect(e).toEqual(entities());
  });
});

describe("columnKey / columnTagProblems", () => {
  it("a schema-qualified entity keys with its schema", () => {
    expect(columnKey({ name: "t", schema: "public" }, "a")).toBe("public.t.a");
    expect(columnKey({ name: "t" }, "a")).toBe("t.a");
  });
  it("problems are the named query's own checks", () => {
    expect(columnTagProblems([{ key: "t.a", type: "text", tag: null }], { "t.a": "email" })).toEqual([]);
    expect(columnTagProblems([{ key: "t.a", type: "integer", tag: null }], { "t.a": "email" })).toHaveLength(1);
  });
});
