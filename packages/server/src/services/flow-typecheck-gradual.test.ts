import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normaliseModel } from "@foundry/flow-edit";
import { introducedUnsafeSteps, MODEL_ORIGINS, unsafeStepIds } from "./flow-typecheck.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * D-242 — gradual typing for legacy. A MODEL (drafter, chat) may not introduce
 * a whole-step unsafe block (FT0602, "one hand-written template"); one the
 * previous revision already had is inherited, and a person's save is never
 * held to this at all.
 *
 * ⚠ The models are NORMALISED before judging, exactly as `writeRevision` does:
 * a template the normaliser could lift into typed bindings is not unsafe, and a
 * test over a raw model would be testing a state no revision is judged in.
 */
const TEMPLATE = "{{ outputs.read.value | jq('[.[] | {to: .vendor_email}]') | first }}";
const read = { id: "read", kind: "datasource", ref: "fin.overdue", inputs: [] };
const unsafe = (id = "send") => ({ id, kind: "tool", ref: "tether_email_send", dependsOn: ["read"], inputs: [], paramsExpr: TEMPLATE });
const typed = (id = "send") => ({ id, kind: "tool", ref: "tether_email_send", dependsOn: ["read"], inputs: [] });
const model = (...steps: unknown[]): FlowModel =>
  normaliseModel({ id: "f", inputs: [], steps } as never) as unknown as FlowModel;

describe("the fixture really is the unsafe block after normalising", () => {
  it("CONTROL: a whole-template step survives normalisation as FT0602 with no port", () => {
    expect([...unsafeStepIds(model(read, unsafe()))]).toEqual(["send"]);
  });
  it("CONTROL: the same step without the template is not unsafe", () => {
    expect([...unsafeStepIds(model(read, typed()))]).toEqual([]);
  });
});

describe("introducedUnsafeSteps (D-242)", () => {
  it("refuses an unsafe block on a first revision — nothing to inherit it from", () => {
    const ds = introducedUnsafeSteps(model(read, unsafe()), undefined);
    expect(ds.map((d) => [d.code, d.severity, d.span.stepId])).toEqual([["FT0602", "error", "send"]]);
  });

  it("refuses an unsafe block the previous revision did not have", () => {
    const ds = introducedUnsafeSteps(model(read, unsafe()), model(read, typed()));
    expect(ds.map((d) => d.span.stepId)).toEqual(["send"]);
  });

  it("refuses a NEW unsafe step beside an inherited one, and names only the new one", () => {
    const ds = introducedUnsafeSteps(model(read, unsafe("send"), unsafe("nudge")), model(read, unsafe("send")));
    expect(ds.map((d) => d.span.stepId)).toEqual(["nudge"]);
  });

  it("⚠ CONTROL: a legacy unsafe step already in the previous revision is still allowed", () => {
    expect(introducedUnsafeSteps(model(read, unsafe()), model(read, unsafe()))).toEqual([]);
  });

  it("CONTROL: the previous revision is normalised too — a raw stored v1 row compares like for like", () => {
    const rawPrevious = { id: "f", inputs: [], steps: [read, unsafe()] } as unknown as FlowModel;
    expect(introducedUnsafeSteps(model(read, unsafe()), rawPrevious)).toEqual([]);
  });

  it("a model with no unsafe block introduces nothing", () => {
    expect(introducedUnsafeSteps(model(read, typed()), undefined)).toEqual([]);
  });
});

describe("only a MODEL origin is held to it", () => {
  // `builder` joined 2026-09-26 (compiled-builder phase 4): its moves are a model's choices, so it is held like the two it
  // replaces. A canvas edit, an import or a seed is still not.
  it("drafter, chat and the one builder, and nothing else", () => {
    expect([...MODEL_ORIGINS].sort()).toEqual(["builder", "chat", "drafter"]);
  });
});

describe("the refusal is WIRED — a correct diff nothing calls is I-120", () => {
  const svc = readFileSync(new URL("./flow.service.ts", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("./builder/canvas.service.ts", import.meta.url), "utf8");

  it("CONTROL: the files were read", () => {
    for (const s of [svc, canvas]) expect(s.length).toBeGreaterThan(1000);
  });

  it("writeRevision refuses on it, gated on a MODEL origin, against the previous revision", () => {
    const body = svc.slice(svc.indexOf("async writeRevision("));
    const at = body.indexOf("introducedUnsafeSteps(model,");
    expect(at).toBeGreaterThan(0);
    expect(body.slice(0, at)).toMatch(/opts\.origin && MODEL_ORIGINS\.has\(opts\.origin\)/);
    expect(body.slice(0, at)).toMatch(/flowRepo\.getRevision\(flow\.id, flow\.draftRevision\)/);
  });

  it("create (both its paths: a named id, and a fresh uuid id) and saveRevision pass the origin through", () => {
    expect(svc.match(/this\.writeRevision\([^)]*, hidden, opts\)/g)?.length).toBe(3);
  });

  it("the canvas says canvas — a person's hand-built flow, not a model origin", () => {
    expect(canvas).toMatch(/origin: "canvas"/);
  });
});
