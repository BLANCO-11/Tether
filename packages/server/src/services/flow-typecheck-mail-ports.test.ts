import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { apply, emptyFlow, type CatalogueSnapshot, type EFlow, type EngineOp } from "@foundry/flow-edit";
import { compilerRenderInputs } from "./flow-typecheck.js";

/**
 * I-287 — a declared `array`/`object` param was typed `Json`, so ANY value fit it. Found by reading one compiled flow the
 * property test had passed: `mail_send_template.recipients ← .plan` (a plan name), which ops-api's `parseMailBody` refuses
 * with a 422 at run time while every check was green. The fuzz could not see it either — its stub of a `Json` port accepts
 * anything, so it is only ever as strong as the declared type.
 *
 * Asserted against the committed fixture, which the PRODUCTION derivation (`buildCatalogueSnapshot`) writes and
 * `scenarios/engine-catalogues.ts` drift-checks against the deployment — so this pins what the real catalogue says.
 */
type Fixture = { workspace: string; cat: CatalogueSnapshot };
const CATALOGUES: Fixture[] = JSON.parse(readFileSync(new URL("./__fixtures__/engine-catalogues.json", import.meta.url), "utf8"));
const support = CATALOGUES.find((f) => f.workspace === "Customer Support")!;
const cat: CatalogueSnapshot = { ...support.cat, renderInputs: compilerRenderInputs };
const port = (ref: string, name: string) => cat.refs[ref]!.params.find((p) => p.name === name)!;

describe("mail ports carry the service's own contract (I-287)", () => {
  it("an ops-api mail tool's `recipients`/`cc` are address lists that take one address, as `asArray` does", () => {
    expect(port("mail_send_template", "recipients")).toMatchObject({ ty: { t: "List", of: { t: "Address" } }, liftsScalar: true, required: true });
    expect(port("mail_send_template", "cc")).toMatchObject({ ty: { t: "List", of: { t: "Address" } }, liftsScalar: true });
    expect(port("mail_send_template", "variables").ty).toEqual({ t: "Record", fields: {} });
  });

  it("only `foundry_email_send`'s `to` falls back to the requester — never a `cc`, never another tool", () => {
    expect(port("foundry_email_send", "to").fallsBackToRequester).toBe(true);
    const others = Object.entries(cat.refs).flatMap(([ref, r]) => r.params.filter((p) => p.fallsBackToRequester).map((p) => `${ref}.${p.name}`));
    expect(others).toEqual(["foundry_email_send.to"]);
  });

  it("⚠ the engine now refuses the call it built before: a plan name into `recipients`", () => {
    const ops: EngineOp[] = [
      { op: "add_reader", id: "read", ref: "support_demo.tickets_opened_since" },
      { op: "bind", stepId: "read", port: "since", source: { from: "literal", value: "2026-06-30", provenance: "goal" } },
      { op: "add_transform", id: "some", from: "read", pipeline: [{ op: "limit", n: { value: 33, from: "goal" } }] },
    ];
    const f = ops.reduce<EFlow>((g, op) => { const r = apply(g, op, cat); if (!r.ok) throw new Error(`${op.op}: ${r.error}`); return r.flow; }, emptyFlow("t"));
    const call: EngineOp = { op: "add_call", id: "mail", ref: "mail_send_template", over: "some", row: { port: "recipients", field: "plan" } };
    const plan = apply(f, call, cat);
    expect(plan.ok ? "" : plan.error).toMatch(/Text is not List<Address>/);
    // CONTROL: the SAME op, with only `plan` retyped Address, fits — the refusal is the type and nothing else.
    const reader = cat.refs["support_demo.tickets_opened_since"]!;
    const rows = reader.payload as { t: "Rows"; of: { t: "Record"; fields: Record<string, unknown> } };
    const retyped = { ...cat, refs: { ...cat.refs, "support_demo.tickets_opened_since": { ...reader, payload: { ...rows, of: { ...rows.of, fields: { ...rows.of.fields, plan: { t: "Address" } } } } } } } as CatalogueSnapshot;
    const g = ops.reduce<EFlow>((h, op) => (apply(h, op, retyped) as { flow: EFlow }).flow, emptyFlow("t"));
    expect(apply(g, call, retyped).ok).toBe(true);
  });
});
