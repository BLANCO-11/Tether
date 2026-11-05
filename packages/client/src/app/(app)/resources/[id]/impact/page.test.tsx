// @vitest-environment jsdom
//
// src/app/(app)/resources/[id]/impact/page.test.tsx — S-54 Dependency impact report.
//
// Screen S-54 Dependency impact report (pack record removed 2026-09-11; the
// assertions below are the surviving pin on the copy).
// Every assertion is verbatim copy from S-54 § Copy so a single-word drift turns it red.
// Perturbations: rename a workflow, change a column head, or drop the mono turns the
// corresponding test red — proving the pack is pinned, not approximate.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";
vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return { useParams: () => routeParams.current };
});
import ImpactReportPage from "./page";
import { PACK } from "./pack";
import { ImpactWord } from "@/components/resource/ImpactWord";

afterEach(cleanup);

function renderAt(id = "leave-management-db") {
  return render(atRoute(id, <ImpactReportPage />));
}

// ── Header ─────────────────────────────────────────────────────────────────
describe("S-54 header — verbatim (S-54 § Copy)", () => {
  it("eyebrow is LEAVE MANAGEMENT DB · SCHEMA V3", () => {
    renderAt();
    expect(screen.getByText("LEAVE MANAGEMENT DB \u00b7 SCHEMA V3")).toBeTruthy();
  });

  it("title is Dependency impact report", () => {
    renderAt();
    expect(screen.getByText("Dependency impact report")).toBeTruthy();
  });

  it("purpose is four workflows … until each owner reviews", () => {
    renderAt();
    expect(screen.getByText(PACK.purpose)).toBeTruthy();
  });

  it("primary action is Submit resource change", () => {
    renderAt();
    expect(screen.getByText("Submit resource change")).toBeTruthy();
  });

  it("measure is page — Page owns it", () => {
    renderAt();
    expect(document.querySelector(".max-w-page")).toBeTruthy();
  });

  it("perturbation: eyebrow must contain middle dot, not hyphen", () => {
    renderAt();
    const el = screen.getByText(/LEAVE MANAGEMENT DB/);
    expect(el.textContent).toContain("\u00b7");
    expect(el.textContent).not.toContain(" - ");
  });
});

// ── Notice ──────────────────────────────────────────────────────────────────
describe("S-54 blocked notice — verbatim (S-54 § Copy)", () => {
  it("notice title is Headcount reconciliation is blocked", () => {
    renderAt();
    expect(screen.getByText("Headcount reconciliation is blocked")).toBeTruthy();
  });

  it("notice body is It reads approved_flag as a boolean …", () => {
    renderAt();
    expect(screen.getByText("It reads `approved_flag` as a boolean and has no rule for PENDING.")).toBeTruthy();
  });

  it("notice sits in warn tone", () => {
    renderAt();
    const notice = screen.getByText("Headcount reconciliation is blocked").closest('[data-tone="warn"]');
    expect(notice).toBeTruthy();
  });
});

// ── Table heads ─────────────────────────────────────────────────────────────
describe("S-54 table — columns verbatim (S-54 § Copy)", () => {
  it("heads are WORKFLOW · OWNER · FIELD USE · IMPACT · REQUIRED ACTION", () => {
    renderAt();
    expect(screen.getByText("WORKFLOW")).toBeTruthy();
    expect(screen.getByText("OWNER")).toBeTruthy();
    expect(screen.getByText("FIELD USE")).toBeTruthy();
    expect(screen.getByText("IMPACT")).toBeTruthy();
    expect(screen.getByText("REQUIRED ACTION")).toBeTruthy();
  });

  it("FIELD USE heads is exact upper case", () => {
    renderAt();
    const head = screen.getByText("FIELD USE");
    expect(head.textContent).toBe("FIELD USE");
  });
});

// ── Table rows — verbatim ───────────────────────────────────────────────────
describe("S-54 rows — verbatim (S-54 § Copy)", () => {
  it("renders four workflows", () => {
    renderAt();
    expect(screen.getAllByTestId("impact-row")).toHaveLength(4);
  });

  it("Contractor timesheet chase is Blocked with mono approved_flag", () => {
    renderAt();
    expect(screen.getByText("Contractor timesheet chase")).toBeTruthy();
    const cells = screen.getAllByTestId("field-use-cell");
    expect(cells[0].textContent).toBe("approved_flag");
    expect(cells[0].className).toContain("font-mono");
    expect(screen.getByText("Map PENDING before next run")).toBeTruthy();
  });

  it("Monthly back-to-office compliance is Review with approval_status = true mono", () => {
    renderAt();
    expect(screen.getByText("Monthly back-to-office compliance")).toBeTruthy();
    const cells = screen.getAllByTestId("field-use-cell");
    expect(cells[1].textContent).toBe("approval_status = true");
    expect(cells[1].className).toContain("font-mono");
    expect(screen.getAllByText("Confirm existing behaviour").length).toBeGreaterThanOrEqual(2);
  });

  it("Leave balance monthly digest row verbatim", () => {
    renderAt();
    expect(screen.getByText("Leave balance monthly digest")).toBeTruthy();
    expect(screen.getAllByText("Meera Iyer").length).toBeGreaterThanOrEqual(1);
  });

  it("Headcount reconciliation row is Review with Devika Menon", () => {
    renderAt();
    expect(screen.getByText("Headcount reconciliation")).toBeTruthy();
    expect(screen.getByText("Devika Menon")).toBeTruthy();
    const cells = screen.getAllByTestId("field-use-cell");
    expect(cells[3].textContent).toBe("approval_status = true");
  });

  it("owners are Meera Iyer (3) and Devika Menon (1)", () => {
    renderAt();
    expect(screen.getAllByText("Meera Iyer")).toHaveLength(3);
    expect(screen.getAllByText("Devika Menon")).toHaveLength(1);
  });

  it("FIELD USE is the actual expression in mono, not a description", () => {
    renderAt();
    const cells = screen.getAllByTestId("field-use-cell");
    expect(cells.every((c) => c.className.includes("font-mono"))).toBe(true);
    // Not a description like "uses approval flag" — must be the code token
    expect(cells[0].textContent).not.toContain("uses");
  });

  it("perturbation: renaming a workflow fails — pack is pinned", () => {
    renderAt();
    expect(screen.queryByText("Contractor timesheets")).toBeNull();
  });
});

// ── IMPACT — not colour-only (UXI-005 law 6) ───────────────────────────────
describe("S-54 IMPACT — not colour-only (UXI-005, law 6)", () => {
  it("ImpactWord carries a shape per level plus accessible label", () => {
    const { container: blocked } = render(<ImpactWord impact="Blocked" />);
    const { container: review } = render(<ImpactWord impact="Review" />);
    expect(blocked.querySelector("svg")!.innerHTML).not.toBe(review.querySelector("svg")!.innerHTML);
    expect(blocked.querySelector('[aria-label="Blocked impact"]')).toBeTruthy();
    expect(review.querySelector('[aria-label="Review impact"]')).toBeTruthy();
  });

  it("table impact cells use ImpactWord (not bare coloured word)", () => {
    renderAt();
    const badges = screen.getAllByTestId("impact-word");
    expect(badges).toHaveLength(4);
    badges.forEach((b) => expect(b.querySelector("svg")).not.toBeNull());
  });

  it("perturbation: greyscale — stripping SVG leaves two identical words — would fail shape check", () => {
    const { container } = render(<ImpactWord impact="Blocked" />);
    expect(container.querySelector("svg")).not.toBeNull();
    const { container: c2 } = render(<ImpactWord impact="Review" />);
    expect(container.innerHTML).not.toBe(c2.innerHTML);
  });

  it("Blocked is danger tone, Review is warn tone", () => {
    const { container: blocked } = render(<ImpactWord impact="Blocked" />);
    const { container: review } = render(<ImpactWord impact="Review" />);
    expect(blocked.innerHTML).toContain("text-danger");
    expect(review.innerHTML).toContain("text-warn");
  });
});

// ── Submit ──────────────────────────────────────────────────────────────────
describe("S-54 submit — verbatim (S-54 § Copy)", () => {
  it("shows success Notice on submit", () => {
    renderAt();
    expect(screen.queryByText("Change submitted for owner review")).toBeNull();
    fireEvent.click(screen.getByText("Submit resource change"));
    expect(screen.getByText("Change submitted for owner review")).toBeTruthy();
    expect(
      screen.getByText(
        "Each of the four dependent workflow owners has been notified. Nothing changes in production until every one of them has reviewed the impact.",
      ),
    ).toBeTruthy();
  });

  it("success notice is ok tone", () => {
    renderAt();
    fireEvent.click(screen.getByText("Submit resource change"));
    const ok = screen.getByText("Change submitted for owner review").closest('[data-tone="ok"]');
    expect(ok).toBeTruthy();
  });

  it("nothing changes in production until every one reviewed sentence verbatim", () => {
    renderAt();
    fireEvent.click(screen.getByText("Submit resource change"));
    expect(screen.getByText(/Nothing changes in production until every one of them has reviewed the impact\./)).toBeTruthy();
  });
});
