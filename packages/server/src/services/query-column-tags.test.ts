import { describe, expect, it } from "vitest";
import { withDeclaredTags } from "./query-column-tags.js";

const COLS = [
  { name: "incident_code", type: "text", nullable: true, tag: "key" },
  { name: "notify_email", type: "text", nullable: true, tag: null },
  { name: "consumed_mins", type: "integer", nullable: true, tag: null },
];

describe("a query's declared column tags (computed columns no comment reaches)", () => {
  it("fills a silence: a computed address column becomes an email", () => {
    const r = withDeclaredTags(COLS, { notify_email: "email" });
    expect(r.problems).toEqual([]);
    expect(r.columns.find((c) => c.name === "notify_email")!.tag).toBe("email");
  });
  it("never contradicts the schema, never tags a non-text or absent column, never an unknown tag — each refused by name", () => {
    const r = withDeclaredTags(COLS, { incident_code: "email", consumed_mins: "key", nope: "email", notify_email: "phone" });
    expect(r.problems).toEqual([
      expect.stringMatching(/`incident_code` is declared a email but its source column says key/),
      expect.stringMatching(/`consumed_mins` .* integer, not text/),
      expect.stringMatching(/`nope` .* no such column/),
      expect.stringMatching(/`notify_email`: “phone” is not a tag/),
    ]);
    expect(r.columns).toEqual(COLS); // nothing refused is applied
  });
  it("with nothing declared, the columns are the database's", () => {
    expect(withDeclaredTags(COLS, {}).columns).toEqual(COLS);
    expect(withDeclaredTags(COLS, null).columns).toEqual(COLS);
  });
});

describe("minor_units — an amount in minor units is a NUMBER's tag, as an address is text's (2026-10-01)", () => {
  const C = [{ name: "budget_cents", type: "bigint", nullable: false }, { name: "code", type: "character varying", nullable: false }] as never;
  it("a number declared in minor units carries it; the engine reads it as an amount in minor units", async () => {
    const r = withDeclaredTags(C, { budget_cents: "minor_units" });
    expect(r.problems).toEqual([]);
    expect(r.columns.find((c) => c.name === "budget_cents")?.tag).toBe("minor_units");
    const { tyOfColumn, renderType } = await import("@foundry/flow-edit");
    expect(renderType(tyOfColumn("bigint", false, "minor_units"))).toBe("Int<minor units>");
  });
  it("CONTROLS: minor units on text, and an address on a number, are refused by name — each tag refines its own kind", () => {
    expect(withDeclaredTags(C, { code: "minor_units" }).problems).toEqual(["`code` is declared a minor_units but it is character varying, not a number"]);
    expect(withDeclaredTags(C, { budget_cents: "email" }).problems).toEqual(["`budget_cents` is declared a email but it is bigint, not text"]);
  });
});
