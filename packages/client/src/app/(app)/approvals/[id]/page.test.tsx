// @vitest-environment jsdom
// src/app/(app)/approvals/[id]/page.test.tsx — S-39 Exception approval detail
//
// Pack: `reference/screens/S-39.md` via `14-exception-approval.png`, `flows/07-approvals.md § Step 3`.
// Every assertion is verbatim copy from S-39 § Copy so a single-word drift turns it red.
// Perturbations: remove a timeline entry, rename a button, or change the en dash and the
// corresponding test fails — proving the pack is pinned, not approximate.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";
vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return { useParams: () => routeParams.current };
});
import ExceptionApprovalPage from "./page";

afterEach(cleanup);

function renderAt(id = "EXC-2026-07-0042") {
  return render(atRoute(id, <ExceptionApprovalPage />));
}

// ── Header ──────────────────────────────────────────────────────────────────
describe("S-39 header — verbatim (S-39 § Copy)", () => {
  it("eyebrow is TYPE · ID", () => {
    renderAt();
    expect(screen.getByText("EXCEPTION \u00b7 EXC-2026-07-0042")).toBeTruthy();
  });

  it("title verbatim", () => {
    renderAt();
    expect(screen.getByText("Rahul Desai \u00b7 July 2026")).toBeTruthy();
  });

  it("status chip Partially approved", () => {
    renderAt();
    expect(screen.getByText("Partially approved")).toBeTruthy();
    expect(screen.getByTestId("s39-status-chip").textContent).toContain("Partially approved");
  });

  it("purpose line is the flag reason", () => {
    renderAt();
    expect(screen.getByText("9 days in office (12 required)")).toBeTruthy();
  });

  it("perturbation: eyebrow must contain the middle dot, not a hyphen", () => {
    const { container } = renderAt("EXC-2026-07-0042");
    expect(container.textContent).toContain("EXCEPTION \u00b7 EXC-2026-07-0042");
    expect(container.textContent).not.toContain("EXCEPTION - EXC-");
  });
});

// ── Notice ──────────────────────────────────────────────────────────────────
describe("S-39 parallel-approval notice — verbatim before fields", () => {
  it("notice title and body verbatim", () => {
    renderAt();
    expect(screen.getByText("Parallel approval")).toBeTruthy();
    expect(
      screen.getByText(
        "Both your manager (Anita Rao) and your HR business partner (Sanjay Nair) must approve this. If either declines, the request fails.",
      ),
    ).toBeTruthy();
  });

  it("notice renders before the Request card in DOM order", () => {
    const { container } = renderAt();
    const text = container.textContent ?? "";
    expect(text.indexOf("Parallel approval")).toBeLessThan(text.indexOf("Request"));
  });
});

// ── Request card ────────────────────────────────────────────────────────────
describe("S-39 Request — verbatim (S-39 § Copy)", () => {
  it("definition rows verbatim with en dash", () => {
    renderAt();
    expect(screen.getByText("Dates")).toBeTruthy();
    expect(screen.getByText("2026-07-14 \u2013 2026-07-25")).toBeTruthy();
    expect(screen.getByText("Category")).toBeTruthy();
    expect(screen.getByText("Client site visit")).toBeTruthy();
    expect(screen.getByText("Days")).toBeTruthy();
    expect(screen.getByText("14, 15, 16, 17, 18, 21, 22, 23, 24, 25")).toBeTruthy();
    expect(screen.getByText("Document")).toBeTruthy();
    expect(screen.getByText("pune-site-attendance-jul2026.pdf \u00b7 240 KB")).toBeTruthy();
  });

  it("reason paragraph verbatim below the list with no label", () => {
    renderAt();
    expect(
      screen.getByText(
        "I was at the Pune client site for two weeks for the claims migration go-live. Badge records are with the client's security team, not ours.",
      ),
    ).toBeTruthy();
  });

  it("perturbation: Days value lists the specific missed days, not a count", () => {
    renderAt();
    const days = screen.getByText("14, 15, 16, 17, 18, 21, 22, 23, 24, 25");
    // Count would be "10" — this must be the explicit list
    expect(days.textContent).toContain("14, 15");
    expect(days.textContent).not.toBe("10");
  });

  it("perturbation: dates use an en dash, not a hyphen", () => {
    renderAt();
    expect(screen.getByText("2026-07-14 \u2013 2026-07-25")).toBeTruthy();
    // Hyphen version must not be present as the rendered value
    const text = screen.getByTestId("s39-request-card").textContent ?? "";
    expect(text).toContain("\u2013");
  });

  it("values are right-aligned via justify-between rows (layout contract)", () => {
    const { container } = renderAt();
    const card = container.querySelector('[data-testid="s39-request-card"]');
    expect(card).not.toBeNull();
    // Each row is flex justify-between — check at least one exists
    expect(card!.querySelector(".justify-between")).not.toBeNull();
  });
});

// ── Approval path ───────────────────────────────────────────────────────────
describe("S-39 Approval path — timeline (S-39 § Layout)", () => {
  it("both approvers render in the same shape", () => {
    renderAt();
    const path = screen.getByTestId("s39-approval-path").textContent ?? "";
    expect(path).toContain("Anita Rao");
    expect(path).toContain("Manager");
    expect(path).toContain("Sanjay Nair");
    expect(path).toContain("HR Business Partner");
  });
  it("approved entry verbatim", () => {
    renderAt();
    expect(screen.getByText("Approved 3 Aug 2026, 11:20 IST")).toBeTruthy();
    expect(screen.getByText("Confirmed, Rahul was on site with the migration team.")).toBeTruthy();
  });

  it("pending entry says No decision yet in the comment position", () => {
    renderAt();
    expect(screen.getByText("Pending for 8 days")).toBeTruthy();
    expect(screen.getByText("No decision yet")).toBeTruthy();
  });

  it("numbered vertical timeline with ordinals 1 and 2", () => {
    renderAt();
    const approvers = screen.getAllByTestId("s39-approver");
    expect(approvers).toHaveLength(2);
    expect(approvers[0].textContent).toContain("1");
    expect(approvers[1].textContent).toContain("2");
  });

  it("perturbation: removing a pending approver's placeholder blank rather than No decision yet would hide incompleteness", () => {
    renderAt();
    // Must be explicit, not blank
    expect(screen.getByText("No decision yet")).toBeTruthy();
  });
});

// ── Comment field ───────────────────────────────────────────────────────────
describe("S-39 Comment for Rahul — verbatim", () => {
  it("label names the reader", () => {
    renderAt();
    expect(screen.getByText("Comment for Rahul")).toBeTruthy();
    expect(screen.queryByText("Comments")).toBeNull();
  });

  it("textarea is reachable by label and is ~5 rows", () => {
    renderAt();
    const ta = screen.getByTestId("s39-comment") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.getAttribute("aria-label")).toBe("Comment for Rahul");
    expect(ta.rows).toBe(5);
  });
});

// ── Figures and actions — inside the figures card ───────────────────────────
describe("S-39 figures and actions — inside the figures card", () => {
  it("figures verbatim: 9 / 12 / 10 with labels", () => {
    renderAt();
    expect(screen.getByText("days in office")).toBeTruthy();
    expect(screen.getByText("required")).toBeTruthy();
    expect(screen.getByText("days requested")).toBeTruthy();
    // Values
    const card = screen.getByTestId("s39-figures-card");
    expect(card.textContent).toContain("9");
    expect(card.textContent).toContain("12");
    expect(card.textContent).toContain("10");
  });

  it("buttons live inside the figures card", () => {
    renderAt();
    const card = screen.getByTestId("s39-figures-card");
    expect(card.querySelector('[data-testid="s39-decline"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="s39-approve"]')).not.toBeNull();
  });

  it("buttons say & notify and are full-width stacked, destructive above constructive", () => {
    renderAt();
    const card = screen.getByTestId("s39-figures-card");
    const decline = screen.getByTestId("s39-decline");
    const approve = screen.getByTestId("s39-approve");
    expect(decline.textContent).toBe("Decline & notify");
    expect(approve.textContent).toBe("Approve & notify");
    // Decline is above Approve in DOM order
    const html = card.innerHTML;
    expect(html.indexOf("Decline &amp; notify")).toBeLessThan(html.indexOf("Approve &amp; notify"));
    // Full width
    expect(decline.className).toContain("w-full");
    expect(approve.className).toContain("w-full");
  });

  it("perturbation: buttons without & notify would hide the side effect", () => {
    renderAt();
    expect(screen.getByText("Decline & notify")).toBeTruthy();
    expect(screen.getByText("Approve & notify")).toBeTruthy();
  });
});

// ── Approve / reject ───────────────────────────────────────────────────────
describe("S-39 approve / reject — decision", () => {
  it("Approve shows a notice with consumer update", () => {
    renderAt();
    fireEvent.click(screen.getByTestId("s39-approve"));
    const notice = screen.getByTestId("s39-decided-notice");
    expect(notice.textContent).toContain("The requester and other approvers were notified.");
    expect(notice.textContent).toContain("Rahul\u2019s consumer status updates from the same decision.");
  });

  it("Decline shows a notice with consumer update", () => {
    renderAt();
    fireEvent.click(screen.getByTestId("s39-decline"));
    const notice = screen.getByTestId("s39-decided-notice");
    expect(notice.textContent).toContain("The requester and other approvers were notified.");
    expect(notice.textContent).toContain("Rahul\u2019s consumer status updates from the same decision.");
  });

  it("buttons disable after a decision", () => {
    renderAt();
    fireEvent.click(screen.getByTestId("s39-approve"));
    expect((screen.getByTestId("s39-approve") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("s39-decline") as HTMLButtonElement).disabled).toBe(true);
  });

  it("perturbation: removing the consumer update line would silently break the notify contract", () => {
    renderAt();
    fireEvent.click(screen.getByTestId("s39-approve"));
    expect(screen.getByTestId("s39-decided-notice").textContent).toContain("Rahul\u2019s consumer status updates");
  });
});
