import { describe, it, expect } from "vitest";
import { TEMPORAL_CONVERSIONS, checkFlow, type CatalogueSnapshot } from "@foundry/flow-edit";
import { PURE_MODEL_CHECKS } from "./flow-model-findings.js";
import { PURE_CHECK_CODE, compilerRenderInputs, wrappedDiagnostics } from "./flow-typecheck.js";
import { CONVERSIONS } from "./flow-input-compat.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * The wrap (D-249): existing checks become diagnostics under stable FT codes.
 * ⚠ These are the guards against the wrap silently going stale — a new check
 * reported as the catch-all FT0999, or the typed conversions drifting from the
 * table the server's own compat check uses.
 */
describe("every registered pure check has an FT code", () => {
  it("names each one — a new check must be given a code, not fall into FT0999", () => {
    const unmapped = PURE_MODEL_CHECKS.map((c) => c.name).filter((n) => !PURE_CHECK_CODE[n]);
    expect(unmapped).toEqual([]);
  });
  it("CONTROL: the scan sees the registry at all", () => expect(PURE_MODEL_CHECKS.length).toBeGreaterThan(5));
});

describe("the typed temporal conversions ARE the server's CONVERSIONS", () => {
  it("same pairs, both directions (D-197: one table, not two)", () => {
    const norm = (s: string) => s.toLowerCase();
    const server = CONVERSIONS.map((c) => `${norm(c.from)}→${norm(c.to)}`).sort();
    const typed = TEMPORAL_CONVERSIONS.map((c) => `${norm(c.from)}→${norm(c.to)}`).sort();
    expect(typed).toEqual(server);
  });
});

describe("wrappedDiagnostics maps real findings", () => {
  const model = (steps: unknown[]): FlowModel => ({ id: "f", inputs: [], steps } as unknown as FlowModel);

  it("an unknown column read off an operation is FT0301", () => {
    const m = model([
      { id: "centres", kind: "datasource", ref: "fin.active_cost_centres", inputs: [] },
      { id: "active", kind: "transform", dependsOn: ["centres"], expr: "{{ json(outputs.centres.body).results[0].data | jq('[.[] | select(.active)]') | first }}" },
    ]);
    const ds = wrappedDiagnostics(m, { "fin.active_cost_centres": { kind: "operation", signature: "", params: [], columns: ["id", "code", "name"] } });
    expect(ds.map((d) => d.code)).toContain("FT0301");
  });

  it("CONTROL: reading a column the operation returns is not FT0301", () => {
    const m = model([
      { id: "centres", kind: "datasource", ref: "fin.active_cost_centres", inputs: [] },
      { id: "active", kind: "transform", dependsOn: ["centres"], expr: "{{ json(outputs.centres.body).results[0].data | jq('[.[] | select(.code)]') | first }}" },
    ]);
    const ds = wrappedDiagnostics(m, { "fin.active_cost_centres": { kind: "operation", signature: "", params: [], columns: ["id", "code", "name"] } });
    expect(ds.map((d) => d.code)).not.toContain("FT0301");
  });
});

describe("the gate (phase 2, D-239)", () => {
  it("⚠ is NOT a code list — every error blocks (D-264's interim list is gone)", async () => {
    const mod = await import("./flow-typecheck.js");
    expect("INTERIM_BLOCKING" in mod).toBe(false);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./flow-typecheck.ts", import.meta.url), "utf8");
    const at = src.indexOf("export function blockingOf(");
    expect(at).toBeGreaterThan(0); // CONTROL: the rule was found
    const fn = src.slice(at);
    expect(fn.slice(0, 600)).toMatch(/filter\(\(d\) => d\.severity === "error"\)/);
  });

  it("⚠ writeRevision CALLS it — a correct check nothing calls is I-120", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./flow.service.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(1000); // CONTROL: the file was read
    // Two hops since D-318: writeRevision → gateRevisionModel (its pure half, also the property test's oracle) → blockingOf.
    const w = src.indexOf("async writeRevision("), gStart = src.indexOf("export async function gateRevisionModel(");
    expect(w).toBeGreaterThan(0);
    expect(gStart).toBeGreaterThan(w);
    const writeBody = src.slice(w, src.indexOf("\n  async ", w + 10) > 0 ? src.indexOf("\n  async ", w + 10) : gStart);
    expect(writeBody).toMatch(/await gateRevisionModel\(model, \{/);
    expect(src.slice(gStart)).toMatch(/blockingOf\(model, await g\.catalogue\(model\)\)/);
  });
});

describe("FT0206 compares the blob against the COMPILER's render (I-204)", () => {
  const steps = (paramsExpr?: string) => [
    { id: "read", kind: "datasource", ref: "fin.overdue", inputs: [{ name: "as_of", source: { from: "input", inputId: "as_of" } }] },
    {
      id: "send", kind: "tool", ref: "tether_email_send", dependsOn: ["read"], over: { stepId: "read", field: "" },
      inputs: [{ name: "to", source: { from: "step", stepId: "read", field: "email" } }],
      ...(paramsExpr !== undefined ? { paramsExpr } : {}),
    },
  ];
  const cat: CatalogueSnapshot = { refs: {}, renderInputs: compilerRenderInputs };
  const ft0206 = (s: unknown[]) => checkFlow({ id: "f", inputs: [{ id: "as_of", type: "DATE" }], steps: s } as never, cat).filter((d) => d.code === "FT0206");
  const rendered = () => compilerRenderInputs(steps()[1] as never, steps() as never)!;

  it("CONTROL: the compiler's own render of a fan-out, stored as the blob, is clean", () => {
    expect(rendered()).toContain("jq(");
    expect(ft0206(steps(rendered()))).toEqual([]);
  });
  it("a blob passing a DIFFERENT field than the binding is refused as FT0206", () => {
    expect(rendered()).toContain(".email");
    expect(ft0206(steps(rendered().replace(".email", ".manager_email")))).toHaveLength(1);
  });
  it("the snapshot the gate uses injects this render (a detector nothing calls is I-120)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./flow-typecheck.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function buildCatalogueSnapshot("));
    expect(fn.indexOf("export async function buildCatalogueSnapshot(")).toBe(0); // CONTROL
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/renderInputs: compilerRenderInputs/);
  });
});

describe("paramsSelecting — an equality filter's input selects the field its column is returned as (2026-10-01)", () => {
  const p = { name: "status", ty: { t: "Text" } as never, required: true };
  const at = { status: { schema: "public", table: "tickets", column: "status" } };
  it("from the operation's own filter and projection, whatever the names", async () => {
    const { paramsSelecting } = await import("./flow-typecheck.js");
    expect(paramsSelecting([p], at, [{ alias: "ticket_status", source: "public.tickets.status" }, { alias: "subject", source: "public.tickets.subject" }], { status: "eq" })[0]!.selects).toBe("ticket_status");
    expect(paramsSelecting([p], at, [{ alias: "ticket_status", source: "tickets.status" }], { status: "eq" })[0]!.selects).toBe("ticket_status");
  });
  it("CONTROLS: not an equality, not returned, or returned twice — none", async () => {
    const { paramsSelecting } = await import("./flow-typecheck.js");
    expect(paramsSelecting([p], at, [{ alias: "ticket_status", source: "public.tickets.status" }], { status: "neq" })[0]!.selects).toBeUndefined();
    expect(paramsSelecting([p], at, [{ alias: "subject", source: "public.tickets.subject" }], { status: "eq" })[0]!.selects).toBeUndefined();
    expect(paramsSelecting([p], at, [{ alias: "a", source: "public.tickets.status" }, { alias: "b", source: "public.tickets.status" }], { status: "eq" })[0]!.selects).toBeUndefined();
    // another table's column of the same name is not this one
    expect(paramsSelecting([p], at, [{ alias: "team_status", source: "public.teams.status" }], { status: "eq" })[0]!.selects).toBeUndefined();
  });
});
