/**
 * The HR attendance params carry machine-readable formats: `period` is a
 * YYYY-MM month, `from`/`to` are YYYY-MM-DD dates — the shapes `periodParam`
 * and `dateParam` in `packages/ops-api/src/routes/ops.ts` enforce.
 *
 * ── What these tests hold ────────────────────────────────────────────────────
 *
 *  1. The three grounded params declare exactly those formats, so a
 *     compatibility check can join a declared input's type against what the
 *     reader requires.
 *  2. Everything else stays absent: prose-only params are unconstrained, never
 *     blocked, and a guessed format is a wrong contract.
 *  3. The whole catalogue still passes the strict `toolParamsSchema` — the
 *     `p()` → schema leg of the round-trip (schema → storage → manifest is
 *     covered in `services/param-format.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { demoToolCatalogue } from "./tool-catalogue.js";
import { toolParamsSchema } from "../services/param-descriptor.js";

const catalogue = demoToolCatalogue();
const byName = (name: string) => catalogue.find((t) => t.name === name)!;

describe("the attendance params declare their enforced shapes", () => {
  it("seeds period as month", () => {
    const params = byName("hr_attendance_summary").paramsSchema as Record<string, unknown>;
    expect(params?.period).toMatchObject({ type: "string", format: "month" });
  });

  it("seeds the daily range bounds as dates", () => {
    const params = byName("hr_attendance_daily").paramsSchema as Record<string, unknown>;
    expect(params?.from).toMatchObject({ type: "string", format: "date" });
    expect(params?.to).toMatchObject({ type: "string", format: "date" });
  });
});

describe("prose-only params stay format-free", () => {
  it("declares a format only where an ops-api reader enforces the shape", () => {
    const formatted: string[] = [];
    for (const tool of catalogue) {
      const params = (tool.paramsSchema ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, descriptor] of Object.entries(params)) {
        if ("format" in descriptor) formatted.push(`${tool.name}.${name}=${descriptor.format}`);
      }
    }
    expect(formatted.sort()).toEqual([
      "hr_attendance_daily.from=date",
      "hr_attendance_daily.to=date",
      "hr_attendance_summary.period=month",
    ]);
  });
});

describe("the seeded catalogue passes the strict schema", () => {
  it("every tool's paramsSchema parses — p() output is schema-legal", () => {
    for (const tool of catalogue) {
      const r = toolParamsSchema.safeParse(tool.paramsSchema ?? {});
      expect(r.success, tool.name).toBe(true);
    }
  });
});
