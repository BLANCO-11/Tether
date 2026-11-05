/**
 * The proposer's reply decoded to a strict schema DERIVED from its zod schema (P1-I2). The gateway is simulated exactly: a reply is
 * wrapped (`{"reply": …}`) and writes null for every absent optional property — and must still read back as the same proposal.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { enumCount, ENUM_BUDGET, schemaProblem, validate, type Schema } from "./builder/strict-schema.js";
import { PROPOSAL_STRICT, parseProposalResponse } from "./db-operation-proposal.service.js";
import { strictFromZod, stripNulls, unwrapRoot } from "./strict-from-zod.js";

type J = Record<string, unknown>;
/** What a strict gateway returns: every property present — an absent optional one as null — resolved through `$defs`. */
function asGateway(schema: J, v: unknown, defs: Record<string, J> = (schema.$defs as Record<string, J>) ?? {}): unknown {
  if (schema.$ref) return asGateway(defs[String(schema.$ref).slice("#/$defs/".length)]!, v, defs);
  if (Array.isArray(schema.anyOf)) {
    if (v === null || v === undefined) return null;
    const fits = (schema.anyOf as J[]).find((s) => s.type !== "null" && validate(s as Schema, asGateway(s, v, defs), "$", defs as never) === null);
    return fits ? asGateway(fits, v, defs) : v;
  }
  if (schema.type === "object" && v && typeof v === "object") {
    const props = schema.properties as Record<string, J>;
    return Object.fromEntries(Object.keys(props).map((k) => [k, asGateway(props[k]!, (v as J)[k] ?? null, defs)]));
  }
  if (schema.type === "array" && Array.isArray(v)) return v.map((x) => asGateway(schema.items as J, x, defs));
  return v;
}

const SPEC = {
  base: { table: "dept" },
  columns: [{ column: "name", alias: "department" }, { compute: { coalesce: [{ column: "sick_days" }, { number: 0 }] }, alias: "sick" }],
  joins: [{ table: "region", onLeft: "region_id", onRight: "id", kind: "left" }],
  aggregateJoins: [{ table: "absence", through: [{ table: "emp", onLeft: "emp_id", onRight: "id" }], groupBy: "emp.dept_id", onLeft: "id", kind: "left", aggregates: [{ aggregate: "sum", column: "days", alias: "sick_days" }], filters: [{ column: "kind", op: "eq", value: "Sick" }] }],
  filters: [{ column: "active", op: "eq", value: true }, { compute: { arith: { op: "multiply", left: { column: "x" }, right: { number: 2 } } }, op: "gt", param: "threshold" }],
  sort: [{ column: "name", dir: "asc" }],
  limit: 100,
};
const OK = { status: "ok", name: "dept_sick_days", spec: SPEC, values: [{ param: "threshold", words: "above 3" }], covers: ["each department"] };

describe("the proposer's strict schema, derived from its zod schema (P1-I2)", () => {
  const schema = PROPOSAL_STRICT.schema as J;
  it("is in the strict subset, recursive through $defs, and within the gateway's enum budget", () => {
    expect(schemaProblem(schema)).toBeNull();
    expect(Object.keys(schema.$defs as J).length).toBeGreaterThan(0);
    expect(enumCount(schema as Schema)).toBeLessThan(ENUM_BUDGET);
    expect(PROPOSAL_STRICT.wrapped).toBe(true); // the reply is a union, so its root is the wrapper object
  });
  it("a reply the gateway decodes — wrapped, absent optionals as null — validates and reads back as the same proposal", () => {
    const wire = asGateway(schema, { reply: OK });
    expect(validate(schema as Schema, wire)).toBeNull();
    expect(JSON.stringify(wire)).toContain("null"); // the simulation did write nulls
    const back = parseProposalResponse(JSON.stringify(wire));
    expect(back.status).toBe("ok");
    expect(back.status === "ok" && back.spec.aggregateJoins[0]!.through[0]!.table).toBe("emp");
    expect(back.status === "ok" && back.spec.filters[1]!.compute).toEqual(SPEC.filters[1]!.compute);
    // The refusal channel too.
    const no = parseProposalResponse(JSON.stringify(asGateway(schema, { reply: { status: "insufficient_schema", missing: ["salary"], reason: "no pay table" } })));
    expect(no).toEqual({ status: "insufficient_schema", missing: ["salary"], reason: "no pay table" });
  });
  it("CONTROL: the shape the gateway refuses to decode — no status, an unknown property, a wrong type — fails the schema", () => {
    expect(validate(schema as Schema, { reply: { name: "x" } })).not.toBeNull();
    expect(validate(schema as Schema, { reply: { ...(asGateway(schema, { reply: OK }) as { reply: J }).reply, extra: 1 } })).not.toBeNull();
    expect(validate(schema as Schema, { reply: { ...(asGateway(schema, { reply: OK }) as { reply: J }).reply, covers: "x" } })).not.toBeNull();
  });
  it("zod stays the authority: a reply the schema admits but a refinement refuses is still refused by zod, by field", () => {
    const both = { ...OK, spec: { ...SPEC, filters: [{ column: "active", op: "eq", value: true, param: "p" }] } };
    const wire = asGateway(schema, { reply: both });
    expect(validate(schema as Schema, wire)).toBeNull();
    expect(() => parseProposalResponse(JSON.stringify(wire))).toThrow(/spec\.filters\.0/);
  });
});

describe("strictFromZod", () => {
  it("follows the form: a new optional field appears, nullable and required; an unknown zod type throws rather than half-express", () => {
    const s = strictFromZod(z.object({ a: z.string(), b: z.number().int().optional() })).schema as { properties: J; required: string[] };
    expect(s.required).toEqual(["a", "b"]);
    expect(s.properties.b).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(() => strictFromZod(z.object({ m: z.map(z.string(), z.string()) }))).toThrow(/ZodMap has no strict JSON Schema form/);
  });
  it("stripNulls / unwrapRoot undo exactly what strict decoding adds", () => {
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] });
    expect(unwrapRoot({ reply: { x: 1 } }, true)).toEqual({ x: 1 });
    expect(unwrapRoot({ x: 1 }, true)).toEqual({ x: 1 }); // a client without strict decoding: unchanged
  });
});
