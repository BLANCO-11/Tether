// src/lib/schema-allowlist.test.ts — the "schemas to read" field. I-123,
// foundations Phase 1.5.
//
// The field itself is new; what it feeds is not. `createDatasourceInputSchema` has
// accepted `schemaAllowlist` since WS-C.1 and the browser sent it never, so every
// UI-registered datasource introspected `public` alone — a datasource that
// registers cleanly and can answer nothing about any named schema.
//
// ⚠ These assertions are about REPORTING, not about permission. The control is
// `schemaAllowlistSchema` on the server, and beyond it `assertReadOnly` re-running
// over whatever list arrives. What is tested here is that a name the server would
// refuse is named beside the box, and — the half that matters — that nothing is
// silently dropped: a parser that quietly discards `hr-payroll` registers a
// datasource reading fewer schemas than the person asked for and says nothing.
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEMAS, parseSchemaList } from "@/lib/schema-allowlist";

describe("parseSchemaList", () => {
  it("splits on commas, spaces and newlines, because people paste all three", () => {
    expect(parseSchemaList("public, hr\nfinance  ops").schemas).toEqual([
      "public",
      "hr",
      "finance",
      "ops",
    ]);
  });

  it("keeps the typed order and de-duplicates", () => {
    const p = parseSchemaList("hr, public, hr");
    expect(p.schemas).toEqual(["hr", "public"]);
    expect(p.ok).toBe(true);
  });

  it("⚠ REPORTS an unusable name rather than dropping it", () => {
    const p = parseSchemaList("public, hr-payroll");
    expect(p.schemas).toEqual(["public"]);
    expect(p.rejected).toHaveLength(1);
    expect(p.rejected[0].token).toBe("hr-payroll");
    expect(p.ok).toBe(false); // ⚠ not "ok with a footnote" — the form must block
  });

  it("refuses a name that does not start a plain identifier", () => {
    expect(parseSchemaList("2023_archive").ok).toBe(false);
    expect(parseSchemaList("_archive").ok).toBe(true); // leading underscore is legal
    expect(parseSchemaList("cost$centre").ok).toBe(true); // `$` is legal in the server's regex
  });

  it("is not ok when empty — the server would default to public and disagree with the screen", () => {
    const p = parseSchemaList("   ");
    expect(p.schemas).toEqual([]);
    expect(p.ok).toBe(false);
  });

  it("refuses more than the server accepts", () => {
    const many = Array.from({ length: 21 }, (_, i) => `s${i}`).join(",");
    const p = parseSchemaList(many);
    expect(p.ok).toBe(false);
    expect(p.rejected.some((r) => /more than 20/.test(r.why))).toBe(true);
    expect(parseSchemaList(Array.from({ length: 20 }, (_, i) => `s${i}`).join(",")).ok).toBe(true);
  });

  it("accepts the default, so the wizard opens valid", () => {
    const p = parseSchemaList(DEFAULT_SCHEMAS.join(", "));
    expect(p.schemas).toEqual(DEFAULT_SCHEMAS);
    expect(p.ok).toBe(true);
  });
});
