import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { apply, emptyFlow, legalMoves, type CatalogueSnapshot, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { compilerRenderInputs, toolSig } from "./flow-typecheck.js";
import { platformToolCatalogue } from "./platform-tool-catalogue.js";
import type { RefInterface } from "./manifest-builder.service.js";

/**
 * The email tool's attachment ports, as the STEP ENGINE sees them.
 *
 * `attachments` was declared `array` and typed "a list of anything" (I-287's hole): a reader's rows fitted it,
 * every check was green, and the mail route refused each row at run time. And nothing the engine can build
 * produces its `{name, format, rows}` records at all — so `attach_rows` / `attach_name` / `attach_format`
 * exist: a step's output as text (the one way the engine hands a port a whole output) and two literals.
 *
 * The email tool's signature is DERIVED here from `platformToolCatalogue()` through the production `toolSig`,
 * not read from the committed catalogue fixture — so this pins what the next deploy will serve.
 */
type Fixture = { workspace: string; cat: CatalogueSnapshot };
const CATALOGUES: Fixture[] = JSON.parse(readFileSync(new URL("./__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));
const support = CATALOGUES.find((f) => f.workspace === "Customer Support")!;

const email = platformToolCatalogue().find((t) => t.name === "tether_email_send")!;
const iface = {
  kind: "tool",
  signature: "",
  params: Object.entries(email.paramsSchema as Record<string, { type: string; required?: boolean; format?: string }>).map(
    ([name, p]) => ({ name, type: p.type, required: p.required === true, ...(p.format ? { format: p.format } : {}) }),
  ),
} as unknown as RefInterface;
const cat: CatalogueSnapshot = {
  ...support.cat,
  refs: { ...support.cat.refs, tether_email_send: toolSig("tether_email_send", iface) },
  renderInputs: compilerRenderInputs,
};
const port = (name: string) => cat.refs.tether_email_send!.params.find((p) => p.name === name)!;

function build(ops: EngineOp[]): EFlow {
  return ops.reduce<EFlow>((g, op) => {
    const r = apply(g, op, cat);
    if (!r.ok) throw new Error(`${op.op}: ${r.error}`);
    return r.flow;
  }, emptyFlow("t"));
}
const READ: EngineOp[] = [
  { op: "add_reader", id: "read", ref: "support_demo.tickets_opened_since" },
  { op: "bind", stepId: "read", port: "since", source: { from: "literal", value: "2026-06-30", provenance: "goal" } },
  { op: "add_call", id: "mail", ref: "tether_email_send" },
];

describe("the email tool's attachment ports", () => {
  it("are optional, so they open no hole and the solver's email behaviour does not move", () => {
    for (const p of ["attachments", "attach_rows", "attach_name", "attach_format"]) expect(port(p).required).toBe(false);
    expect(port("attach_rows").data).toBeUndefined();
    expect(port("body").message).toBe(true);
  });

  it("`attachments` carries the route's record shape, so a row with no `name` does not fit it", () => {
    expect(port("attachments").ty).toMatchObject({ t: "List", of: { t: "Record", fields: { name: { t: "Text" } } } });
  });

  it("⚠ a reader's rows can no longer be wired into `attachments` — no binding source the engine offers fits it", () => {
    const f = build(READ);
    const move = legalMoves(f, cat).find((m) => m.op === "bind" && (m as { stepId?: string }).stepId === "mail" && (m as { port?: string }).port === "attachments") as { sources?: Array<{ from: string; stepId?: string }> } | undefined;
    const fromReader = (move?.sources ?? []).filter((s) => "stepId" in s && s.stepId === "read");
    expect(fromReader).toEqual([]);
  });

  it("a reader's whole output binds to `attach_rows`, with a name and a format, and compiles into the call", () => {
    const f = build([
      ...READ,
      { op: "bind", stepId: "mail", port: "attach_rows", source: { from: "text", stepId: "read" } },
      { op: "bind", stepId: "mail", port: "attach_name", source: { from: "literal", value: "open tickets", provenance: "person" } },
      { op: "bind", stepId: "mail", port: "attach_format", source: { from: "literal", value: "xlsx", provenance: "person" } },
    ]);
    const call = f.steps.find((s) => s.id === "mail")!;
    const rendered = compilerRenderInputs(call as never, f.steps as never);
    expect(rendered).toContain("attach_rows");
    expect(rendered).toContain("outputs.read");
    expect(rendered).toContain("open tickets");
  });

  it("refuses a format that is not csv or xlsx", () => {
    const f = build(READ);
    const r = apply(f, { op: "bind", stepId: "mail", port: "attach_format", source: { from: "literal", value: "pdf", provenance: "person" } }, cat);
    expect(r.ok).toBe(false);
  });
});
