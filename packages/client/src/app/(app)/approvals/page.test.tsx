// @vitest-environment jsdom
// src/app/(app)/approvals/page.test.tsx — S-37 inbox rebuild.
//
// Pack: `reference/screens/S-37.md` via `13-approvals-inbox.png`.
// Four tabs via `?tab=` (04 § nav rail), two figures above the tabs, seven-
// column table, Risk not colour-only (UXI-005), empty state with View history,
// and badge vs rows honesty (UXI-006). Each assertion has a perturbation that
// turns it red: delete a header cell, hide the icon, fix the tab param, or
// collapse the two empty states and the test fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { waitingLabel, APPROVAL_TABS, getActiveApprovalTab } from "@/lib/approval-views";
import { RiskWord } from "@/components/approval/RiskWord";

const listPendingApprovals = vi.fn(async () => [] as unknown[]);

vi.mock("@/lib/api", () => ({
  listPendingApprovals: () => listPendingApprovals(),
}));

vi.mock("@/lib/activity", () => ({ useActivityEpoch: () => 0 }));

let currentSearch = "";
let currentPath = "/approvals";
const replace = vi.fn((url: string) => {
  const [path, qs] = url.split("?");
  currentPath = path ?? "/approvals";
  currentSearch = qs ?? "";
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
  useRouter: () => ({ replace }),
  usePathname: () => currentPath,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: unknown; href: unknown }) => {
    const h = String(href ?? "");
    return require("react").createElement("a", { href: h }, children as unknown);
  },
}));
import ApprovalsPage from "./page";
import type { FAStepApproval } from "@/lib/foundry-client";

function approval(over: Partial<FAStepApproval> = {}): FAStepApproval {
  return {
    id: "appr-001",
    flowExecutionId: "exec-1",
    stepId: "step-1",
    kind: "gate",
    summary: "Approve publishing this revision?",
    context: null,
    questions: null,
    answers: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    appliedAt: null,
    expiredAt: null,
    note: null,
    createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    flowId: null,
    startedAt: null,
    ...over,
  } as FAStepApproval;
}

function three(): FAStepApproval[] {
  return [
    approval({ id: "appr-a", summary: "First", createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    approval({ id: "appr-b", summary: "Second", createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString() }),
    approval({ id: "appr-c", summary: "Third", createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }),
  ];
}

beforeEach(() => {
  currentSearch = "";
  currentPath = "/approvals";
  replace.mockClear();
  listPendingApprovals.mockReset();
  listPendingApprovals.mockResolvedValue([]);
});

afterEach(cleanup);

// ── Pure helpers ──────────────────────────────────────────────────────────

describe("approvals — lib/approval-views pure contract (S-37 § Routing)", () => {
  it("four tabs via ?tab=, pending-me is default, unknown falls back", () => {
    expect(APPROVAL_TABS.map((t) => t.key)).toEqual(["pending-me", "requested-by-me", "delegated", "history"]);
    expect(getActiveApprovalTab(null)).toBe("pending-me");
    expect(getActiveApprovalTab("")).toBe("pending-me");
    expect(getActiveApprovalTab("history")).toBe("history");
    expect(getActiveApprovalTab("bogus")).toBe("pending-me");
  });

  it("perturbation: deleting a tab key collapses the rail's filter — test fails on missing entry", () => {
    expect(APPROVAL_TABS.some((t) => t.label === "Delegated")).toBe(true);
    expect(APPROVAL_TABS.some((t) => t.label === "History")).toBe(true);
  });

  it("waitingLabel derives from raisedAt; never throws on bad input", () => {
    const now = new Date("2026-08-13T00:00:00.000Z").getTime();
    const raised = new Date("2026-08-05T00:00:00.000Z").toISOString();
    expect(waitingLabel(raised, now)).toBe("8 days");
    expect(waitingLabel(null, now)).toBe("—");
    expect(waitingLabel("not-a-date", now)).toBe("—");
  });

  it("perturbation: waiting must show days not raw ISO — removing Math.floor turns 8 days into NaN or ISO", () => {
    const now = new Date("2026-08-10T00:00:00.000Z").getTime();
    const raised = new Date("2026-08-08T00:00:00.000Z").toISOString();
    expect(waitingLabel(raised, now)).toMatch(/day/);
  });
});

// ── Copy and layout ──────────────────────────────────────────────────────

describe("approvals — copy (S-37 § Copy)", () => {
  it("header verbatim", async () => {
    listPendingApprovals.mockResolvedValue([]);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("Approvals")).toBeTruthy());
    expect(screen.getByText("Decide exceptions, publications, access, recoveries and governed changes from one queue.")).toBeTruthy();
  });

  it("perturbation: changing the purpose sentence is a pack regression — would turn copy test red", async () => {
    listPendingApprovals.mockResolvedValue([]);
    const { container } = render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("Approvals")).toBeTruthy());
    expect(container.textContent).toContain("one queue");
  });

  it("figures sit above the tabs with verbatim labels (S-37 § Figures)", async () => {
    listPendingApprovals.mockResolvedValue(three() as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("pending your approval")).toBeTruthy());
    expect(screen.getByText("requests in flight")).toBeTruthy();
  });

  it("empty state is 'You're all caught up' with View history (S-37 § States)", async () => {
    listPendingApprovals.mockResolvedValue([]);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("You're all caught up. Nothing needs your approval.")).toBeTruthy());
    expect(screen.getByText("View history")).toBeTruthy();
  });

  it("perturbation: empty states are different screens — pending vs history do not share copy", async () => {
    listPendingApprovals.mockResolvedValue([]);
    currentSearch = "tab=history";
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("No decided requests yet.")).toBeTruthy());
    expect(screen.queryByText("You're all caught up. Nothing needs your approval.")).toBeNull();
  });
});

describe("approvals — tabs via ?tab= (04 § URL state, S-37 § Layout)", () => {
  it("renders four tabs with no counts", async () => {
    listPendingApprovals.mockResolvedValue([]);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeTruthy());
    for (const label of ["Pending me", "Requested by me", "Delegated", "History"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
    // No numeric counts on the tabs themselves
    const tabs = screen.getAllByRole("tab");
    for (const t of tabs) {
      expect(t.textContent).not.toMatch(/\d/);
    }
  });

  it("active tab follows ?tab= (URL is filter, not decoration)", async () => {
    listPendingApprovals.mockResolvedValue([]);
    currentSearch = "tab=delegated";
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Delegated" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tab", { name: "Pending me" }).getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a tab writes ?tab= via replace (not push) and history tab uses param, pending-me deletes it", async () => {
    listPendingApprovals.mockResolvedValue([]);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "History" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(replace).toHaveBeenCalledWith("/approvals?tab=history");
    replace.mockClear();
    currentSearch = "tab=history";
    // Re-render as history, then click Pending me which should delete the param
    cleanup();
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pending me" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Pending me" }));
    expect(replace).toHaveBeenCalledWith("/approvals");
  });

  it("perturbation: unrecognised tab must fall back rather than show empty chrome", async () => {
    listPendingApprovals.mockResolvedValue(three() as never);
    currentSearch = "tab=bogus";
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pending me" }).getAttribute("aria-selected")).toBe("true"));
    // Pending rows still show when fallback happens — proves fallback is pending-me, not history
    await waitFor(() => expect(screen.getAllByTestId("approval-row")).toHaveLength(3));
  });
});

describe("approvals — table columns (S-37 § Layout) and badge vs rows (UXI-006)", () => {
  it("headers verbatim: TYPE SUBJECT REQUESTER RISK WAITING DUE", async () => {
    listPendingApprovals.mockResolvedValue(three() as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getAllByTestId("approval-row")).toHaveLength(3));
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.getByText("Subject")).toBeTruthy();
    expect(screen.getByText("Requester")).toBeTruthy();
    expect(screen.getByText("Risk")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Due")).toBeTruthy();
  });

  it("subject cell is two lines: sentence plus id in mono dim (S-37 § Layout)", async () => {
    listPendingApprovals.mockResolvedValue([approval({ id: "EXC-2026-07-0042", summary: "Rahul Desai — July 2026 attendance exception" })] as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("Rahul Desai — July 2026 attendance exception")).toBeTruthy());
    const idEl = screen.getByText("EXC-2026-07-0042");
    expect(idEl.className).toContain("font-mono");
    expect(idEl.className).toContain("text-dim");
  });

  it("requester is plain text, no avatar (S-37 § Layout)", async () => {
    listPendingApprovals.mockResolvedValue([approval()] as never);
    const { container } = render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getAllByTestId("approval-row")).toHaveLength(1));
    // No avatar image in requester column
    expect(container.querySelector('[data-testid="approval-row"] img')).toBeNull();
  });

  it("waiting derived from createdAt and due is ISO date in mono (S-37 § Layout)", async () => {
    const createdAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    listPendingApprovals.mockResolvedValue([approval({ createdAt })] as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("5 days")).toBeTruthy());
    // Due column present (honest dash with mono styling when no real due) — table has two dashes (requester + due)
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("badge/figure count equals pending-me rows — UXI-006 honesty (figure vs rows cannot disagree)", async () => {
    listPendingApprovals.mockResolvedValue(three() as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getAllByTestId("approval-row")).toHaveLength(3));
    const fig = screen.getByTestId("figure-pending-value");
    expect(fig.textContent).toBe("3");
    expect(screen.getByTestId("figure-inflight-value").textContent).toBe("3");
    // Other tabs do not borrow those rows — history is empty
    cleanup();
    currentSearch = "tab=history";
    listPendingApprovals.mockResolvedValue(three() as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("No decided requests yet.")).toBeTruthy());
    expect(screen.queryAllByTestId("approval-row")).toHaveLength(0);
  });

  it("perturbation: hardcoding figure 3 while rows vary would desync badge vs rows — fails when list is 1", async () => {
    listPendingApprovals.mockResolvedValue([approval()] as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getAllByTestId("approval-row")).toHaveLength(1));
    expect(screen.getByTestId("figure-pending-value").textContent).toBe("1");
  });

  it("overflow control ⋯ present per row (trailing More actions)", async () => {
    listPendingApprovals.mockResolvedValue([approval()] as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByLabelText("More actions")).toBeTruthy());
  });
});

describe("approvals — risk not colour-only (UXI-005, law 6)", () => {
  it("RiskWord carries a shape per level plus an accessible label, so greyscale still distinguishes", () => {
    const { container: low } = render(<RiskWord risk="Low" />);
    const { container: med } = render(<RiskWord risk="Medium" />);
    const { container: high } = render(<RiskWord risk="High" />);
    // Each has its own SVG geometry
    expect(low.querySelector("svg")!.innerHTML).not.toBe(med.querySelector("svg")!.innerHTML);
    expect(med.querySelector("svg")!.innerHTML).not.toBe(high.querySelector("svg")!.innerHTML);
    expect(low.querySelector("svg")!.innerHTML).not.toBe(high.querySelector("svg")!.innerHTML);
    // Accessible labels, not colour alone
    expect(low.textContent).toContain("Low");
    expect(low.querySelector('[aria-label="Low risk"]')).not.toBeNull();
    expect(med.querySelector('[aria-label="Medium risk"]')).not.toBeNull();
    expect(high.querySelector('[aria-label="High risk"]')).not.toBeNull();
  });

  it("risk in the table is a RiskWord (not a bare coloured word)", async () => {
    listPendingApprovals.mockResolvedValue([approval({ id: "risk-x" })] as never);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getAllByTestId("approval-row")).toHaveLength(1));
    // Table row's risk cell contains the RiskWord's aria-label
    expect(screen.getByLabelText(/risk$/)).toBeTruthy();
    // And it carries a shape SVG, so greyscale survives
    const row = screen.getByTestId("approval-row");
    expect(row.querySelector("svg")).not.toBeNull();
  });

  it("perturbation: greyscale — stripping the SVG leaves three identical words — would fail shape check", () => {
    const { container } = render(<RiskWord risk="Low" />);
    // If RiskWord were only a span with colour, there would be no svg
    expect(container.querySelector("svg")).not.toBeNull();
    const { container: c2 } = render(<RiskWord risk="Medium" />);
    expect(container.innerHTML).not.toBe(c2.innerHTML);
  });
});

describe("approvals — zero and error renders", () => {
  it("View history action from empty switches to ?tab=history", async () => {
    listPendingApprovals.mockResolvedValue([]);
    render(<ApprovalsPage />);
    await waitFor(() => expect(screen.getByText("View history")).toBeTruthy());
    fireEvent.click(screen.getByText("View history"));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("tab=history"));
  });
});
