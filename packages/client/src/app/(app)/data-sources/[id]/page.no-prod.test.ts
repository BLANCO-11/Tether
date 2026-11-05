// src/app/(app)/data-sources/[id]/page.no-prod.test.ts
//
// The detail route must never fetch production rows. There is no prod-preview
// endpoint, and this surface must never grow the call that would use one.
//
// ⚠ Comments are stripped before scanning (house rule): prose may name the
// forbidden thing, code may not.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function code(rel: string): string {
  const raw = read(rel);
  expect(raw.length).toBeGreaterThan(1000);
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const PAGE = "./page.tsx";
const VIEWER = "../../../../components/data/MockViewer.tsx";
const PANEL = "../../../../components/data/MockPanel.tsx";

describe("detail routes fetch mock rows only — never production", () => {
  it("the detail page shows mock surfaces and calls no row-fetching API itself", () => {
    const src = code(PAGE);
    expect(src).toContain("<MockViewer");
    expect(src).toContain("<MockPanel");
    expect(src).toContain("setDatasourceCredentialName");
    expect(src).not.toMatch(/getFlowExecution|tryStep|listFlowExecutions|testRunFlow/);
    expect(src).not.toMatch(/previewRows|prodRows|productionRows|getDatasourceMockRows/);
  });

  it("the mock viewer reads one endpoint — the paged mock one", () => {
    const src = code(VIEWER);
    expect(src).toContain("getDatasourceMockRows");
    // The banner names production in WORDS (that is its job); no CALL here
    // may touch it. Ban the calls, not the word.
    expect(src).not.toMatch(/tryStep|getFlowExecution|testRunFlow|previewRows|prodRows/);
  });

  it("the mock panel reads readiness only — no rows at all", () => {
    const src = code(PANEL);
    expect(src).toContain("getDatasourceMock(");
    expect(src).not.toContain("getDatasourceMockRows");
    expect(src).not.toMatch(/tryStep|getFlowExecution|testRunFlow/);
  });
});
