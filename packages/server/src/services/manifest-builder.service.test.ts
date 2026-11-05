import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * T013 (US2, guardrail-port V4/V5/V8) — `buildAndPersist()`'s new `warnings`
 * field, and the byte-identity invariant that makes it safe (SC-003).
 *
 * `warnings` is metadata ABOUT the render, computed from the same
 * tools/datasources/entities already assembled while building the manifest
 * (research.md Decision 3) — it must never be mixed into `hashBody`, the
 * content hash `manifestRepo` versions on. A manifest with a planted
 * injection string and the same manifest with detection disabled must produce
 * byte-identical `manifestXml`/`summaryXml`/`hash`; only `warnings` may differ.
 */

const tools: Array<Record<string, unknown>> = [];
const queries: Array<{ query: Record<string, unknown>; datasource: Record<string, unknown> }> = [];

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: async () => tools },
}));
vi.mock("../repositories/datasource.repo.js", () => ({
  datasourceRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByWorkspace: async () => queries },
}));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/trigger.repo.js", () => ({
  triggerRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/manifest.repo.js", () => ({
  manifestRepo: { getLatest: async () => undefined, insert: async () => undefined },
}));
vi.mock("./schema-introspector.service.js", () => ({
  schemaIntrospectorService: { getStored: async () => [] },
}));

// Detection is exercised for real in prompt-boundary/detect.test.ts. Mocking it
// here lets this test isolate the ONE property T013 exists to pin: whatever
// detectInjection returns, manifestXml/summaryXml/hash must not move — proving
// `warnings` is metadata about the render, never mixed into the hashed content.
let mockDetectionResult: { items: unknown[]; truncated: boolean; total: number; cap: number } = {
  items: [],
  truncated: false,
  total: 0,
  cap: 50,
};
vi.mock("../prompt-boundary/detect.js", () => ({
  detectInjection: () => mockDetectionResult,
}));

const { manifestBuilderService } = await import("./manifest-builder.service.js");

const tool = (over: Record<string, unknown> = {}) => ({
  name: "mail_send",
  method: "POST",
  url: "http://stub/mail",
  description: "Sends an email to the given recipients",
  paramsSchema: { recipients: { type: "array", required: true } },
  authStyle: "bearer",
  authParamName: null,
  secretEnvName: "MAIL_KEY",
  ...over,
});

beforeEach(() => {
  tools.length = 0;
  queries.length = 0;
  mockDetectionResult = { items: [], truncated: false, total: 0, cap: 50 };
});

describe("buildAndPersist — warnings (FR-012/FR-013)", () => {
  it("surfaces whatever detectInjection reports on its return value", async () => {
    tools.push(tool());
    mockDetectionResult = {
      items: [
        {
          source: "tool",
          itemName: "mail_send",
          field: "description",
          pattern: "instruction_override",
          describes: "text telling the model to disregard the instructions it was given",
          excerpt: "Ignore all previous instructions",
        },
      ],
      truncated: false,
      total: 1,
      cap: 50,
    };
    const result = await manifestBuilderService.buildAndPersist("ws");
    expect(result.warnings.total).toBe(1);
    expect(result.warnings.items[0]).toMatchObject({ itemName: "mail_send" });
  });

  it("reports no warnings when detectInjection finds nothing", async () => {
    tools.push(tool());
    const result = await manifestBuilderService.buildAndPersist("ws");
    expect(result.warnings.items).toEqual([]);
    expect(result.warnings.total).toBe(0);
  });

  it("does NOT change manifestXml/summaryXml/hash based on the detection result (SC-003)", async () => {
    // Content is IDENTICAL across both calls — only what detectInjection
    // reports differs. If warnings were mixed into hashBody, the hash below
    // would move with it; it must not.
    tools.push(tool());

    mockDetectionResult = { items: [], truncated: false, total: 0, cap: 50 };
    const clean = await manifestBuilderService.buildAndPersist("ws");

    mockDetectionResult = {
      items: [
        {
          source: "tool",
          itemName: "mail_send",
          field: "description",
          pattern: "instruction_override",
          describes: "text telling the model to disregard the instructions it was given",
          excerpt: "Ignore all previous instructions",
        },
      ],
      truncated: false,
      total: 1,
      cap: 50,
    };
    const flagged = await manifestBuilderService.buildAndPersist("ws");

    expect(flagged.manifestXml).toBe(clean.manifestXml);
    expect(flagged.summaryXml).toBe(clean.summaryXml);
    expect(flagged.hash).toBe(clean.hash);
    expect(flagged.warnings.total).toBeGreaterThan(clean.warnings.total);
  });
});

/**
 * ── The detector's answer is not discarded ──────────────────────────────────
 *
 * `detectInjection` was once computed on every manifest build and read by
 * nothing — I-120's exact shape. The drafter logged it at its build sites; that
 * path went with the drafter (phase 8, D-333). The reader that remains is the
 * tools page's panel (`listPromptBoundaryWarnings`), which reads it off
 * `GET /workspaces/:id/manifest` — so this pins that the route serves the
 * WHOLE rendered manifest, `warnings` included, rather than a projection that
 * could silently drop it.
 *
 * ⚠ Read off disk on purpose, with a control that the route was found.
 */
describe("the injection detection is consumed, not just computed", () => {
  it("the manifest route returns buildAndPersist's result whole, warnings included", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../routes/workspaces.ts", import.meta.url), "utf8");
    const at = src.indexOf('"/:id/manifest"');
    expect(at, "CONTROL: the route was found").toBeGreaterThan(-1);
    const body = src.slice(at, at + 600);
    expect(body).toMatch(/const m = await manifestBuilderService\.buildAndPersist\(req\.params\.id\);/);
    expect(body).toMatch(/res\.json\(m\)/);
  });

  it("the client reads the warnings off that route", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../../client/src/lib/api.ts", import.meta.url), "utf8");
    const at = src.indexOf("export async function listPromptBoundaryWarnings(");
    expect(at, "CONTROL: the client reader was found").toBeGreaterThan(-1);
    expect(src.slice(at, at + 800)).toMatch(/manifest/i);
  });
});
