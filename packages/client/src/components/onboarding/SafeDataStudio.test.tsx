// @vitest-environment jsdom
// src/components/onboarding/SafeDataStudio.test.tsx — S-51 Mock / masked data studio.
// Pack truth: `18-onboarding-safe-data.png` + `S-51.md` + `flows/08-datasource-onboarding.md § Step 6`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SafeDataStudio, EDGE_CASES, sampleForType, generateMockRows } from "./SafeDataStudio";

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("S-51 · SafeDataStudio — empty state verbatim", () => {
  it("renders the two-centred sentences verbatim", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    expect(screen.getByText("This resource needs mock data before it can be published.")).toBeTruthy();
    expect(screen.getByText("The AI never sees your real data.")).toBeTruthy();
  });

  it("renders Generate 25 mock rows verbatim, centred primary", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    const btn = screen.getByRole("button", { name: "Generate 25 mock rows" });
    expect(btn).toBeTruthy();
  });

  it("renders Back verbatim, bottom-left inside card", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("honest empty when already generated via storage is shown — else Generate", () => {
    // Not generated yet → Generate button present
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    expect(screen.getByText("Generate 25 mock rows")).toBeTruthy();

    cleanup();
    // Persist generated then re-render should show generated state
    localStorage.setItem(
      "onboarding:safeData",
      JSON.stringify({ generated: true, rowCount: 25, edgeCases: [], createdAt: new Date().toISOString() }),
    );
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    expect(screen.getByText("25 mock rows generated")).toBeTruthy();
  });
});

describe("S-51 · SafeDataStudio — after generating", () => {
  it("clicking Generate shows 25 mock rows generated", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    expect(screen.getByText("25 mock rows generated")).toBeTruthy();
    // Persists to localStorage
    const raw = localStorage.getItem("onboarding:safeData");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as { generated: boolean; rowCount: number };
    expect(parsed.generated).toBe(true);
    expect(parsed.rowCount).toBe(25);
  });

  it("renders Edge cases to include and six presets each with note verbatim", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    expect(screen.getByText("Edge cases to include")).toBeTruthy();
    for (const ec of EDGE_CASES) {
      expect(screen.getByText(ec.label)).toBeTruthy();
      expect(screen.getByText(ec.note)).toBeTruthy();
    }
  });

  it("edge case toggling persists", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    const cb = screen.getByLabelText("Missing swipe-out") as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect((screen.getByLabelText("Missing swipe-out") as HTMLInputElement).checked).toBe(true);
    const raw = JSON.parse(localStorage.getItem("onboarding:safeData") as string) as { edgeCases: string[] };
    expect(raw.edgeCases).toContain("missing-swipe-out");
    fireEvent.click(screen.getByLabelText("Missing swipe-out"));
    const raw2 = JSON.parse(localStorage.getItem("onboarding:safeData") as string) as { edgeCases: string[] };
    expect(raw2.edgeCases).not.toContain("missing-swipe-out");
  });

  it("renders Preview heading and honest empty when no mapping", () => {
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(screen.getByText(/Columns follow your mapping/)).toBeTruthy();
  });

  it("renders type-correct preview when mapping provided", () => {
    const cols = [
      { key: "employee_id", type: "text" },
      { key: "leave_date", type: "date" },
      { key: "swiped_at", type: "timestamp" },
      { key: "fte", type: "number" },
      { key: "approval_status", type: "boolean" },
      { key: "customFields", type: "object" },
      { key: "raw_payload", type: "binary" },
    ] as const;
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[...cols]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    // Column headers present
    for (const c of cols) {
      expect(screen.getByText(c.key)).toBeTruthy();
    }
    // Type-correct sample values appear — check at least one of each per spec table
    expect(screen.getAllByText("MOCK-A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-07-14").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-07-14T09:02:00+05:30").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("true").length).toBeGreaterThan(0);
    expect(screen.getAllByText("{}").length).toBeGreaterThan(0);
    expect(screen.getAllByText("<1 file>").length).toBeGreaterThan(0);
  });

  it("preview shows 3 of 25 mock rows (the spec says Generate 25 but preview is sample)", () => {
    const cols = [{ key: "employee_id", type: "text" }] as const;
    render(<SafeDataStudio onBack={vi.fn()} mappingOverride={[...cols]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    expect(screen.getByText(/Showing 3 of 25 mock rows/)).toBeTruthy();
  });

  it("Back and Continue to review are rendered in generated state", () => {
    const onBack = vi.fn();
    const onContinue = vi.fn();
    render(<SafeDataStudio onBack={onBack} onContinue={onContinue} mappingOverride={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate 25 mock rows" }));
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeTruthy();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
    const cont = screen.getByRole("button", { name: "Continue to review" });
    fireEvent.click(cont);
    expect(onContinue).toHaveBeenCalled();
  });
});

describe("S-51 · type-correct samples — the pack table", () => {
  it("text → MOCK-A, MOCK-B", () => {
    expect(sampleForType("text", 0)).toBe("MOCK-A");
    expect(sampleForType("text", 1)).toBe("MOCK-B");
  });
  it("date → 2026-07-14, 2026-07-21", () => {
    expect(sampleForType("date", 0)).toBe("2026-07-14");
    expect(sampleForType("date", 1)).toBe("2026-07-21");
  });
  it("timestamp → 2026-07-14T09:02:00+05:30, 2026-07-14T18:41:00+05:30", () => {
    expect(sampleForType("timestamp", 0)).toBe("2026-07-14T09:02:00+05:30");
    expect(sampleForType("timestamp", 1)).toBe("2026-07-14T18:41:00+05:30");
  });
  it("number → 1.0, 0.5", () => {
    expect(sampleForType("number", 0)).toBe("1.0");
    expect(sampleForType("number", 1)).toBe("0.5");
  });
  it("boolean → true, false", () => {
    expect(sampleForType("boolean", 0)).toBe("true");
    expect(sampleForType("boolean", 1)).toBe("false");
  });
  it("object → {}", () => {
    expect(sampleForType("object", 0)).toBe("{}");
    expect(sampleForType("object", 1)).toBe("{}");
  });
  it("binary → <1 file>, <0 files>", () => {
    expect(sampleForType("binary", 0)).toBe("<1 file>");
    expect(sampleForType("binary", 1)).toBe("<0 files>");
  });

  it("generateMockRows respects declared type per column", () => {
    const cols = [
      { key: "a", type: "text" },
      { key: "b", type: "date" },
      { key: "c", type: "number" },
    ];
    const rows = generateMockRows(cols, 2);
    expect(rows[0].a).toBe("MOCK-A");
    expect(rows[0].b).toBe("2026-07-14");
    expect(rows[0].c).toBe("1.0");
    expect(rows[1].a).toBe("MOCK-B");
    expect(rows[1].b).toBe("2026-07-21");
    expect(rows[1].c).toBe("0.5");
  });
});
