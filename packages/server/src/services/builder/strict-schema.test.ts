import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayDefect, parseStrict, S, schemaProblem, validate } from "./strict-schema.js";
import { GatewayInference } from "../inference.service.js";

const SPEC = S.obj({ kind: S.oneOf(["a", "b"]), n: S.int(), tags: S.arr(S.str(), 3), note: S.nullable(S.str()), v: S.any(S.lit("x"), S.obj({ y: S.bool() })) });

describe("strict schema (D-307)", () => {
  it("builders produce schemas strict mode accepts, and out-of-subset ones are refused before sending", () => {
    expect(schemaProblem(SPEC)).toBeNull();
    expect(schemaProblem({ type: "object", properties: { a: { type: "string" } }, required: [], additionalProperties: false })).toMatch(/every property/);
    expect(schemaProblem({ type: "string", pattern: "x" })).toMatch(/`pattern` is outside/);
    expect(schemaProblem({ type: "string", enum: ["a", "a"] })).toMatch(/distinct/);
  });
  it("validates exactly: enums, required, extra keys, nullables, anyOf, maxItems", () => {
    const ok = { kind: "a", n: 2, tags: ["t"], note: null, v: "x" };
    expect(validate(SPEC, ok)).toBeNull();
    expect(validate(SPEC, { ...ok, kind: "c" })).toMatch(/not one of/);
    expect(validate(SPEC, { ...ok, extra: 1 })).toMatch(/unexpected property/);
    const { n: _n, ...missing } = ok;
    expect(validate(SPEC, missing)).toMatch(/missing `n`/);
    expect(validate(SPEC, { ...ok, n: 1.5 })).toMatch(/integer/);
    expect(validate(SPEC, { ...ok, tags: ["a", "b", "c", "d"] })).toMatch(/more than 3/);
    expect(validate(SPEC, { ...ok, v: { y: true } })).toBeNull();
    expect(validate(SPEC, { ...ok, v: { y: 1 } })).toMatch(/none of 2/);
  });
  it("a bad reply is a GatewayDefect, never repaired", () => {
    expect(() => parseStrict(SPEC, "{not json", "l")).toThrow(GatewayDefect);
    expect(() => parseStrict(SPEC, JSON.stringify({ kind: "z" }), "l")).toThrow(/breaks the schema/);
  });
});

describe("GatewayInference sends the schema as strict response_format", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("with `schema`: response_format json_schema strict; without: no response_format (byte-identical for every old caller)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }), { status: 200 }); });
    const c = new GatewayInference("https://gw.example/v1", "k", "m");
    await c.complete("p", { label: "a", schema: { name: "spec", schema: SPEC as Record<string, unknown> } });
    await c.complete("p", { label: "b" });
    expect(sent[0]!.response_format).toEqual({ type: "json_schema", json_schema: { name: "spec", strict: true, schema: SPEC } });
    expect("response_format" in sent[1]!).toBe(false);
  });
});
