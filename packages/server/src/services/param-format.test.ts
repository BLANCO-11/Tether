/**
 * Tool param `format` — the machine-readable value shape (`month` | `date` |
 * `datetime` | `text`) that lets a compatibility check tell a YYYY-MM feeder
 * from unconstrained prose without parsing descriptions.
 *
 * ── What these tests hold ────────────────────────────────────────────────────
 *
 *  1. The strict descriptor schema ACCEPTS `format` (the `.strict()` change is
 *     load-bearing: before it, a seeded `format` died at parse) and still
 *     refuses anything else.
 *  2. Absent stays absent: no default is invented (I-39's lesson — a default
 *     would move the tool fingerprint on a no-change save), and absent means
 *     unconstrained prose, never a block.
 *  3. `format` survives create/update parsing verbatim into the stored shape
 *     (`tool.service.ts` writes `paramsSchema` untouched to
 *     `tools.params_schema`) and renders into the manifest prompt.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  PARAM_FORMATS,
  queryParamDescriptor,
  toolParamDescriptor,
  toolParamsSchema,
} from "./param-descriptor.js";
import { createToolSchema, updateToolSchema } from "./tool.service.js";

const TOOL = { name: "t", url: "http://x.local/a", method: "GET" as const };

describe("tool param format is accepted, and nothing else new is", () => {
  it("accepts each documented format on a tool descriptor", () => {
    expect([...PARAM_FORMATS]).toEqual(["month", "date", "datetime", "text"]);
    for (const format of PARAM_FORMATS) {
      const r = toolParamsSchema.safeParse({
        period: { type: "string", required: false, description: "YYYY-MM", format },
      });
      expect(r.success).toBe(true);
    }
  });

  it("refuses an unknown format at the `format` key rather than dropping it", () => {
    const r = toolParamsSchema.safeParse({
      p: { type: "string", required: true, format: "currency" },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    // The format key itself is the refusal site, so a form can place it, and
    // the message names the allowed values rather than reporting a bad shape.
    expect(r.error.issues[0]!.path).toEqual(["p", "format"]);
    expect(r.error.issues.map((i) => i.message).join(" ")).toContain("month");
  });

  it("still refuses a genuinely unknown key beside `format`", () => {
    const r = toolParamDescriptor.safeParse({
      type: "string",
      required: true,
      format: "month",
      example: "2026-06",
    });
    expect(r.success).toBe(false);
  });

  it("a named query's descriptor may declare a format too — and is otherwise exactly as it was", () => {
    // It said "no `format` there": formats then described tool feeders only. A query is a reader the builder types from
    // `format` (the database's own type already sets it, G13), and its SQL is what enforces a month — so an undeclared one let
    // "monthly" type-check and fail at run time (2026-09-29, flow d3c79698). Still strict, still defaulted, never a format by default.
    expect(queryParamDescriptor.parse({ type: "string", required: true, format: "month" })).toEqual({ type: "string", required: true, format: "month" });
    expect(queryParamDescriptor.safeParse({ type: "string", format: "monthly" }).success).toBe(false);
    expect(queryParamDescriptor.safeParse({ type: "string", example: "2026-06" }).success).toBe(false);
    expect(queryParamDescriptor.parse({})).toEqual({ type: "string", required: true });
  });
});

describe("absent format stays absent — unconstrained prose is never invented", () => {
  it("parses without adding a `format` key", () => {
    const r = toolParamDescriptor.safeParse({ type: "string", required: true });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ type: "string", required: true });
  });

  it("round-trips through create and update parsing verbatim, format included", () => {
    // `tool.service.ts` writes `paramsSchema` untouched to `tools.params_schema`,
    // so parse-output identity IS the storage contract at this boundary.
    const paramsSchema = {
      period: { type: "string", required: false, description: "YYYY-MM", format: "month" },
      q: { type: "string", required: false },
    };
    const created = createToolSchema.safeParse({ ...TOOL, paramsSchema });
    expect(created.success).toBe(true);
    expect(created.success && created.data.paramsSchema).toEqual(paramsSchema);
    const updated = updateToolSchema.safeParse({ paramsSchema });
    expect(updated.success).toBe(true);
    expect(updated.success && updated.data.paramsSchema).toEqual(paramsSchema);
  });
});

// ── Manifest rendering ───────────────────────────────────────────────────────
// Same mock harness as `manifest-builder.service.test.ts`: the repos behind the
// builder are replaced, so the render is exercised for real against an
// in-memory tool row.
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
vi.mock("../prompt-boundary/detect.js", () => ({
  detectInjection: () => ({ items: [], truncated: false, total: 0, cap: 50 }),
}));

const { manifestBuilderService } = await import("./manifest-builder.service.js");

beforeEach(() => {
  tools.length = 0;
  queries.length = 0;
});

describe("the manifest renders `format` when present and nothing when absent", () => {
  it("emits format=\"month\" on the seeded attendance param", async () => {
    tools.push({
      name: "hr_attendance_summary",
      method: "GET",
      url: "http://ops/hr/attendance/summary",
      description: "Monthly attendance",
      paramsSchema: {
        period: { type: "string", required: false, description: "YYYY-MM", format: "month" },
      },
      authStyle: "bearer",
      authParamName: null,
      secretEnvName: "HR_KEY",
    });
    const result = await manifestBuilderService.buildAndPersist("ws");
    expect(result.manifestXml).toContain(
      '<param name="period" type="string" required="false" format="month">YYYY-MM</param>',
    );
  });

  it("renders no format attribute for unconstrained params — existing manifests stay byte-identical", async () => {
    tools.push({
      name: "hr_list_employees",
      method: "GET",
      url: "http://ops/hr/employees",
      description: "List employees",
      paramsSchema: {
        department: { type: "string", required: false, description: "Department code" },
      },
      authStyle: "bearer",
      authParamName: null,
      secretEnvName: "HR_KEY",
    });
    const result = await manifestBuilderService.buildAndPersist("ws");
    expect(result.manifestXml).toContain(
      '<param name="department" type="string" required="false">Department code</param>',
    );
    expect(result.manifestXml).not.toContain("format=");
  });
});
