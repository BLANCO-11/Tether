/**
 * Phase 2 exit criterion: a planted type error is refused through EVERY builder
 * path, with a control that a clean flow saves.
 *
 * Two halves, because the paths share one chokepoint by construction:
 *  1. Behaviour — `writeRevision` refuses when the checker reports an error
 *     (400, structured `diagnostics`, before anything compiles or is stored),
 *     and proceeds when it reports none. The checker's own rules have their own
 *     suites (flow-edit `check.test.ts`, one planted case per FT code).
 *  2. Structure — every builder (chat, canvas, import and template
 *     instantiate) reaches a revision ONLY through `flowService.create` /
 *     `saveRevision` / `writeRevision` — never `flowRepo.insertRevision`.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as FlowTypecheck from "./flow-typecheck.js";

const blocking = vi.fn();
const insertRevision = vi.fn();
const compile = vi.fn();

vi.mock("../db/index.js", () => ({ db: {}, pool: {}, schema: {} }));
vi.mock("./flow-typecheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof FlowTypecheck>()),
  // The gate calls blockingOf (blockingDiagnostics was its old name); the mock must hit what the gate calls.
  blockingOf: (...a: unknown[]) => blocking(...a),
}));
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { insertRevision: (...a: unknown[]) => insertRevision(...a), latestRevision: vi.fn(async () => null), nextRevision: vi.fn(async () => 1), getRevision: vi.fn(async () => null) },
}));
vi.mock("../repositories/workspace.repo.js", () => ({ workspaceRepo: { get: vi.fn(async () => ({ id: "w1", slug: "w", tenantSlug: "t" })) } }));
// writeRevision reads datasource types through the gate (post-phase-2 addition); this test never touches real datasources.
vi.mock("../repositories/datasource.repo.js", () => ({ datasourceRepo: { listByWorkspace: vi.fn(async () => []) } }));
// …and the catalogue snapshot pulls the operation catalogue the same way.
vi.mock("../repositories/db-operation.repo.js", () => ({ dbOperationRepo: { listByWorkspace: vi.fn(async () => []) } }));
vi.mock("./manifest-builder.service.js", () => ({
  manifestBuilderService: {
    refFingerprints: vi.fn(async () => ({ "hr.lookup": "fp" })),
    refInterfaces: vi.fn(async () => ({ "hr.lookup": { kind: "tool", signature: "", params: [] } })),
  },
}));
vi.mock("./generation-provider.service.js", () => ({ resolveGenerationProvider: vi.fn(async () => ({ allowedModels: [] })) }));
vi.mock("./kestra-client.service.js", () => ({
  kestra: {},
  KestraError: class extends Error {},
  namespaceFor: () => "foundry.t.w",
}));
vi.mock("./tenant-mapper.service.js", () => ({ tenantMapper: { namespacesFor: vi.fn(async () => ({ draft: "foundry.t.w.draft", live: "foundry.t.w" })) } }));

const { flowService } = await import("./flow.service.js");
const { flowCompiler } = await import("./flow-compiler.service.js");

const flow = { id: "f1", workspaceId: "w1", name: "n", status: "draft", armedRevision: null, draftRevision: 0 } as never;
const model = { id: "gate", steps: [{ id: "t", kind: "transform", expr: "{{ 1 }}" }] } as never;
const author = { name: "system:test", kind: "system" } as never;

describe("writeRevision — the gate every builder passes (behaviour)", () => {
  beforeEach(() => {
    blocking.mockReset();
    insertRevision.mockReset();
    compile.mockReset();
    vi.spyOn(flowCompiler, "compile").mockImplementation((...a: unknown[]) => {
      compile(...a);
      throw new Error("STOP: reached compile");
    });
  });

  it("a planted error is refused: 400, structured diagnostics, nothing compiled or stored", async () => {
    const d = { code: "FT0202", severity: "error", span: { stepId: "t", port: "x" }, message: "Text is not Date", owner: "wiring" };
    blocking.mockReturnValue([d]);
    const e = (await flowService.writeRevision("w1", flow, model, author).catch((x) => x)) as Error & { statusCode?: number; diagnostics?: unknown };
    expect(e.statusCode).toBe(400);
    expect(e.diagnostics).toEqual([d]);
    expect(e.message).toContain("FT0202");
    expect(compile).not.toHaveBeenCalled();
    expect(insertRevision).not.toHaveBeenCalled();
  });

  it("CONTROL: a clean answer passes the gate and reaches compile", async () => {
    blocking.mockReturnValue([]);
    const e = (await flowService.writeRevision("w1", flow, model, author).catch((x) => x)) as Error;
    expect(e.message).toContain("STOP: reached compile");
    expect(compile).toHaveBeenCalledTimes(1);
  });
});

describe("every builder reaches a revision only through create / saveRevision (structure)", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  const BUILDERS: Record<string, string> = {
    canvas: "./builder/canvas.service.ts",
    "chat + goal builder": "./builder/builder.service.ts",
    "import + template instantiate": "./flow-portability.service.ts",
  };
  for (const [name, file] of Object.entries(BUILDERS)) {
    it(`${name}: writes via flowService.create/saveRevision, never flowRepo.insertRevision`, () => {
      const src = read(file);
      expect(src.length, "CONTROL: the file was read").toBeGreaterThan(1000);
      expect(src).toMatch(/flowService\.(create|saveRevision|writeRevision)\(/);
      expect(src).not.toMatch(/flowRepo\.insertRevision\(/);
    });
  }
  it("create and saveRevision both end in writeRevision", () => {
    const src = read("./flow.service.ts");
    expect((src.match(/this\.writeRevision\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/flowRepo\.insertRevision\(/g) ?? []).length).toBe(1);
  });
});

describe("D-242 — a model-written revision may not introduce an unsafe block (behaviour)", () => {
  // One hand-written template and no typed inputs: FT0602's whole-step form.
  const unsafe = {
    id: "gate",
    inputs: [{ id: "who", type: "STRING" }],
    steps: [{ id: "call", kind: "tool", ref: "hr.lookup", paramsExpr: "{{ inputs.who }}" }],
  } as never;
  beforeEach(() => {
    blocking.mockReset();
    blocking.mockReturnValue([]);
    vi.spyOn(flowCompiler, "compile").mockImplementation(() => {
      throw new Error("STOP: reached compile");
    });
  });
  it("origin chat: a NEW unsafe step is refused (400, FT0602) before compile", async () => {
    const e = (await flowService.writeRevision("w1", flow, unsafe, author, {}, false, { origin: "chat" }).catch((x) => x)) as Error & { statusCode?: number };
    expect(e.message).not.toContain("STOP");
    expect(e.statusCode).toBe(400);
    expect(e.message).toContain("FT0602");
  });
  it("CONTROL: no origin (a harness, a seed, an import) is not refused by this rule", async () => {
    const e = (await flowService.writeRevision("w1", flow, unsafe, author).catch((x) => x)) as Error;
    expect(e.message).toContain("STOP: reached compile");
  });
});
