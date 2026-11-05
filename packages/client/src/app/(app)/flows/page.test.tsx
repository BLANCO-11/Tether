// @vitest-environment jsdom
//
// src/app/(app)/flows/page.test.tsx — the rebuilt Workflows list (S-28).
//
// ⚠ THE DEBT THIS FILE REPAYS. The `/dashboard` rebuild shipped with 13 tests;
// `/flows` shipped with none, because the session's usage ran out there. An
// untested rebuild of the highest-traffic page is precisely what I-38 (a control
// that cannot fail is worse than none) warns about, and every one of these
// assertions has a perturbation that turns it red.
//
// ⚠ THE ONE CLAIM THIS FILE EXISTS FOR: **the two empty states are different
// screens on purpose, and each is pinned.** `S-28 § States` keeps the empty
// WORKSPACE ("No workflows in this workspace yet") separate from the empty
// FILTER result ("No workflows match your search. Clear a filter to return to
// all N workflows") — the second names the total so the list does not read as
// broken. Reverting either branch to the other's copy turns its test red.
//
// It also holds the SECOND claim: **the STATUS chip carries the armed version**
// (`Published · v3`), never the draft's, because the armed revision is the number
// a person is accountable for.
//
// ⚠ Node 22 or nothing: on Node 20 every jsdom file fails with
// `webidl.util.markAsUncloneable is not a function` while vitest still prints a
// green file count. `vitest.config.ts` throws below 22 for exactly that reason.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FlowSummary } from "@/lib/types";
import { ToastProvider } from "@/lib/toast";
import { VIEWS, viewCounts } from "@/lib/flow-views";
// ⚠ Static: `vi.mock("@/lib/foundry-client")` below is hoisted, so this binds
// the mock's `FoundryApiError` — the class the page's `instanceof` reads.
import { FoundryApiError } from "@/lib/foundry-client";

const listFlows = vi.fn(async (): Promise<FlowSummary[]> => []);
const listFlowsWithLastExecution = vi.fn(async (): Promise<FlowSummary[]> => listFlows());
const revokeFlowApproval = vi.fn(async (_id: string, _reason: string) => {});
const rearmFlowApproval = vi.fn(async (_id: string) => null);
const deleteFlow = vi.fn(async (_id: string) => {});
const duplicateFlow = vi.fn(async (_id: string) => ({ flow: { id: "copy-1", name: "X (copy)" } as FlowSummary, revision: 1 }));
const getMe = vi.fn(async (..._args: unknown[]): Promise<{ subject: string; email: string; capabilities?: string[] } | null> => null);
const listResources = vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []);
const pushMock = vi.fn();
// The page renders `FlowLibrary` in zone 5, which reads `foundry-client`. Whole-
// module replacement: every read the component makes must be here or the render
// crashes. Omitted reads arrive `undefined` and `useAsync` invokes them.
vi.mock("@/lib/api", () => ({
  listFlows: () => listFlows(),
  listFlowsWithLastExecution: () => listFlowsWithLastExecution(),
  revokeFlowApproval: (id: string, reason: string) => revokeFlowApproval(id, reason),
  rearmFlowApproval: (id: string) => rearmFlowApproval(id),
  deleteFlow: (id: string) => deleteFlow(id),
  duplicateFlow: (id: string) => duplicateFlow(id),
  getMe: (...a: unknown[]) => (getMe as (...args: unknown[]) => unknown)(...a),
  listResources: () => listResources(),
}));

// The page renders `FlowLibrary` in zone 5, which reads `foundry-client`. Whole-
// module replacement: every read the component makes must be here or the render
// crashes. Omitted reads arrive `undefined` and `useAsync` invokes them.
vi.mock("@/lib/foundry-client", () => ({
  foundryApi: {
    listFlowTemplates: async () => [],
    listFACandidates: async () => [],
  },
  activeFoundryWorkspaceId: () => "w1",
  resolveWorkspaceId: async () => "w1",
  FoundryApiError: class FoundryApiError extends Error {},
}));

// Saved chats: an unsaved build in one is listed under All and Drafts. Default: none.
const listPiChats = vi.fn(async (): Promise<PiChatSummary[]> => []);
vi.mock("@/lib/pi-builder", async (orig) => ({
  ...(await orig<typeof import("@/lib/pi-builder")>()),
  listPiChats: () => listPiChats(),
}));

// `flows.write` decides whether the selection column shows. Default: unreadable (no provider), which shows it.
let flowsWrite: "allowed" | "denied" | "unreadable" = "unreadable";
vi.mock("@/components/access/Can", () => ({
  useCan: () => ({ state: flowsWrite, allowed: flowsWrite === "allowed", denied: flowsWrite === "denied", unreadable: flowsWrite === "unreadable", why: [] }),
}));

// `useActivityEpoch` drives the refetch; the page calls it, so it must exist.
vi.mock("@/lib/activity", () => ({ useActivityEpoch: () => 0 }));

// ⚠ `push` is module-level (not a fresh `vi.fn()` per call) so a test can assert
// the 409 → workflow-page routing. `replace` stays per-call: the view tabs use it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => pushMock(...a), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/flows",
  useSearchParams: () => new URLSearchParams(searchView.value ? `view=${searchView.value}` : ""),
}));
/** The `?view=` the page reads. Default: none (All). */
const searchView: { value: string | null } = { value: null };

import FlowsPage from "./page";
import type { PiChatSummary } from "@/lib/pi-builder";

/**
 * A minimal flow. Defaults to a draft with nothing armed; tests override only the
 * field they are about so one predicate cannot be masked by another's helper.
 */
function flow(over: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id: "f1",
    name: "Invoice chase",
    description: null,
    kestraFlowId: "k1",
    draftRevision: 1,
    armedRevision: null,
    status: "draft",
    schedule: "",
    draftAhead: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFlows).mockResolvedValue([]);
});
afterEach(cleanup);

// ── Pure lib/flow-views: nine predicates + viewCounts + Scheduled rule ─────────
// ⚠ Perturbation (I-38): removing any predicate body or changing `viewCounts` to
// `flows.length` turns its test red. The pure suite exists because a predicate
// that always returns true still lets the tab row render — the count is wrong but
// nothing crashes, so only a predicate-level assertion catches it.

describe("flows — pure view predicates (S-28 § flow-views, nine views)", () => {
  it("All matches every flow", () => {
    // ⚠ Perturbation: `All: () => false` fails.
    const m = VIEWS.find((v) => v.key === "all")!.match;
    expect(m(flow())).toBe(true);
    expect(m(flow({ status: "armed", armedRevision: 3, schedule: "0 7 * * 1" }))).toBe(true);
    expect(m(flow({ status: "suspended" }))).toBe(true);
  });

  it("Live matches only when the flow can fire unattended", () => {
    // ⚠ Perturbation: `isRunningUnattended` → `armedRevision != null` makes a
    // REVOKED flow count as Live, which is the defect this predicate replaced.
    const m = VIEWS.find((v) => v.key === "live")!.match;
    expect(m(flow({ armedRevision: null }))).toBe(false);
    expect(m(flow({ armedRevision: 1, status: "armed" }))).toBe(true);
    expect(m(flow({ armedRevision: 0, status: "armed" }))).toBe(true);
    expect(m(flow({ armedRevision: 1, status: "suspended" }))).toBe(false);
  });

  it("Scheduled matches running-unattended AND a non-empty cron", () => {
    // ⚠ Perturbation: `&& (schedule ?? "").trim() !== ""` removed → a live flow
    // with no schedule incorrectly counts as Scheduled.
    //
    // ⚠ **`status` IS NOW LOAD-BEARING IN THESE FIXTURES AND USED TO BE OMITTED.**
    // They passed `armedRevision` alone and inherited the helper's `status:
    // "draft"` — armed-revision-with-status-draft, which `writeRevision` cannot
    // produce (it writes `draft_pending` whenever a revision is armed). The
    // predicate reads `status` now, because `revoke` leaves `armed_revision` set
    // on a flow it has just stopped.
    const m = VIEWS.find((v) => v.key === "scheduled")!.match;
    expect(m(flow({ status: "armed", armedRevision: 1, schedule: "0 7 * * 1" }))).toBe(true);
    expect(m(flow({ status: "armed", armedRevision: 1, schedule: "  0 7 * * 1  " }))).toBe(true);
    expect(m(flow({ status: "armed", armedRevision: 2, schedule: "" }))).toBe(false);
    expect(m(flow({ status: "armed", armedRevision: 2, schedule: "   " }))).toBe(false);
    // ⚠ And the case the whole change is about: revoked, cron still on the
    // model, `armed_revision` still set — nothing fires it.
    expect(m(flow({ status: "suspended", armedRevision: 2, schedule: "0 7 * * 1" }))).toBe(false);
  });

  it("Scheduled rejects the three false positives (I-38: armed alone is not scheduled)", () => {
    // ⚠ Perturbation: `armedRevision != null &&` removed → an unarmed draft
    // with a cron string would count as Scheduled, which is false by S-28.
    const m = VIEWS.find((v) => v.key === "scheduled")!.match;
    expect(m(flow({ armedRevision: null, schedule: "0 7 * * 1" }))).toBe(false);
    expect(m(flow({ armedRevision: null, schedule: "" }))).toBe(false);
    expect(m(flow({ armedRevision: null, schedule: null }))).toBe(false);
    expect(m(flow({ armedRevision: 1, schedule: null }))).toBe(false);
  });

  /**
   * ⚠ **THE FIXTURE HERE IS UNREACHABLE, AND THAT IS THE POINT OF THE `DEFECT`
   * TEST IN `lib/flow-views.test.ts`.** `approve` sets `status: "approved"` and
   * `armedRevision` in the same `update`, so `approved && armedRevision == null`
   * describes no flow that has ever existed. Kept as-is because redefining what
   * the tab MEANS is a product decision, not a side effect of this change.
   */
  it("Awaiting approval matches a workflow whose owner asked for approval (sharing-boundaries 2026-10-30)", () => {
    const m = VIEWS.find((v) => v.key === "awaiting")!.match;
    expect(m(flow({ status: "draft", reviewRequestedRevision: 1 }))).toBe(true);
    expect(m(flow({ status: "draft", reviewRequestedRevision: null }))).toBe(false);
    // the old predicate's subject alone no longer counts
    expect(m(flow({ status: "approved", armedRevision: null }))).toBe(false);
  });

  it("Drafts matches draft and draft_pending only", () => {
    // ⚠ Perturbation: `|| status === "draft_pending"` removed → pending drafts vanish.
    const m = VIEWS.find((v) => v.key === "drafts")!.match;
    expect(m(flow({ status: "draft" }))).toBe(true);
    expect(m(flow({ status: "draft_pending" }))).toBe(true);
    expect(m(flow({ status: "approved", armedRevision: null }))).toBe(false);
    expect(m(flow({ status: "armed", armedRevision: 1 }))).toBe(false);
    expect(m(flow({ status: "suspended" }))).toBe(false);
  });

  it("Suspended matches suspended only", () => {
    // ⚠ Perturbation: `status === "suspended"` → `true` makes every flow suspended.
    const m = VIEWS.find((v) => v.key === "suspended")!.match;
    expect(m(flow({ status: "suspended" }))).toBe(true);
    expect(m(flow({ status: "draft" }))).toBe(false);
    expect(m(flow({ status: "approved", armedRevision: null }))).toBe(false);
  });

  it("Running matches last run live (status running or engineStatus live)", () => {
    const m = VIEWS.find((v) => v.key === "running")!.match;
    expect(m(flow({ lastExecution: { id: "e1", status: "running", engineStatus: null } }))).toBe(true);
    expect(m(flow({ lastExecution: { id: "e2", status: "succeeded", engineStatus: "running" } }))).toBe(true);
    expect(m(flow({ lastExecution: { id: "e3", status: "succeeded", engineStatus: "failed" } }))).toBe(false);
    expect(m(flow())).toBe(false);
  });

  it("Failed matches last run failed or stopped", () => {
    const m = VIEWS.find((v) => v.key === "failed")!.match;
    expect(m(flow({ lastExecution: { id: "e1", status: "failed", engineStatus: null } }))).toBe(true);
    expect(m(flow({ lastExecution: { id: "e2", status: "succeeded", engineStatus: "failed" } }))).toBe(true);
    expect(m(flow({ lastRun: { outcome: "stopped" } }))).toBe(true);
    expect(m(flow({ lastExecution: { id: "e3", status: "succeeded", engineStatus: "success" } }))).toBe(false);
    expect(m(flow())).toBe(false);
  });

  it("My drafts matches draft with ownerSubject present (owner data gate)", () => {
    const m = VIEWS.find((v) => v.key === "mydrafts")!.match;
    expect(m(flow({ status: "draft", ownerSubject: "sub-1" }))).toBe(true);
    expect(m(flow({ status: "draft_pending", ownerSubject: "sub-1" }))).toBe(true);
    // Draft without owner → not counted for My drafts (disabled until owner exists)
    expect(m(flow({ status: "draft", ownerSubject: null }))).toBe(false);
    expect(m(flow({ status: "draft" }))).toBe(false);
    // Non-draft with owner should not count
    expect(m(flow({ status: "armed", armedRevision: 1, ownerSubject: "sub-1" }))).toBe(false);
  });

  it("viewCounts aggregates each predicate over the same array", () => {
    // ⚠ Perturbation: `flows.filter(v.match).length` → `flows.length` makes
    // every tab show All's count.
    const flows: FlowSummary[] = [
      flow({ id: "a", status: "armed", armedRevision: 1, schedule: "0 7 * * 1" }),
      flow({ id: "b", status: "approved", armedRevision: 4 }),
      flow({ id: "c", status: "draft", armedRevision: null }),
      // ⚠ Armed AND edited since: it keeps firing revision 2, so it is live.
      flow({ id: "d", status: "draft_pending", armedRevision: 2, draftAhead: true }),
      // ⚠ REVOKED, and `armed_revision` survives on purpose.
      flow({ id: "e", status: "suspended", armedRevision: 5 }),
      flow({ id: "f", status: "armed", armedRevision: 2, schedule: "" }),
    ];
    const c = viewCounts(flows);
    expect(c.all).toBe(6);
    // armed(a) + approved(b) + draft_pending(d) + armed(f) = 4. The revoked one
    // is excluded despite carrying an `armed_revision`.
    expect(c.live).toBe(4);
    expect(c.scheduled).toBe(1);
    // ⚠ 0, not 1: `approved && armedRevision == null` is unreachable — `approve`
    // writes both together. See the DEFECT test in `lib/flow-views.test.ts`.
    expect(c.awaiting).toBe(0);
    expect(c.drafts).toBe(2);
    expect(c.mydrafts).toBe(0);
    expect(c.suspended).toBe(1);
    expect(c.running).toBe(0);
    expect(c.failed).toBe(0);
  });
});

describe("flows — the title and the vocabulary", () => {
  it("is titled Workflows, not My Automations (UX-001)", async () => {
    // ⚠ Perturbation: title "Workflows" → "My Automations" fails.
    vi.mocked(listFlows).mockResolvedValue([flow()]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Workflows");
    expect(screen.queryByText("My Automations")).toBeNull();
  });

  it("shows the nine view tabs with their counts, a zero rendered not hidden", async () => {
    // ⚠ Perturbation: hiding zero counts (`count || ""`) fails on Suspended 0.
    vi.mocked(listFlows).mockResolvedValue([
      flow({ status: "armed", armedRevision: 1, schedule: "0 7 * * 1" }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\s*\d+$/, ""));
    expect(tabs).toEqual(["All", "Mine", "Awaiting approval", "Live", "Scheduled", "Drafts", "Suspended", "Running", "Failed"]);
    expect(screen.getByRole("tab", { name: /Suspended/ }).textContent).toContain("0");
    for (const t of screen.getAllByRole("tab")) expect(/\d/.test(t.textContent ?? "")).toBe(true);
  });

  it("⚠ shows Awaiting approval (asked for approval) and hides My drafts (no owner data)", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow()]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    expect(screen.getByRole("tab", { name: /Awaiting approval/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /My drafts/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");

  });
});

describe("flows — the two empty states are different screens (S-28 § States)", () => {
  it("an empty WORKSPACE says so, and points at the two doors that exist", async () => {
    // ⚠ Perturbation: workspace empty copy replaced by filtered copy → fails
    // because filtered copy names "all 0 workflows" which is wrong for zero rows.
    vi.mocked(listFlows).mockResolvedValue([]);
    render(<FlowsPage />);
    await waitFor(() =>
      expect(screen.getByText(/No workflows in this workspace yet\./)).toBeTruthy(),
    );
    // ⚠ NOT the filtered copy.
    expect(screen.queryByText(/No workflows match your search/)).toBeNull();
    expect(screen.getByText("Describe one")).toBeTruthy();
  });

  it("a FILTERED empty names the total, so the list does not read as broken", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ name: "Invoice chase" }), flow({ id: "f2", name: "Expense policy" })]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search workflows"), {
      target: { value: "no-such-thing" },
    });
    // ⚠ The filtered copy NAMES THE TOTAL. Pinned string guarded by ui-honesty-check.sh.
    // Perturbation: `all.length` → `visible.length` would say "all 0 workflows".
    await waitFor(() =>
      expect(
        screen.getByText(/No workflows match your search\. Clear a filter to return to all 2 workflows\./),
      ).toBeTruthy(),
    );
    // ⚠ NOT the empty-workspace copy: this list has workflows; the search hid them.
    expect(screen.queryByText(/No workflows in this workspace yet\./)).toBeNull();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
  });

  it("Clear filters restores the full list", async () => {
    // ⚠ Perturbation: Clear filters only clearing `query` but not `view` still
    // passes this, but filtered-by-view empty would stay empty — covered by naming-total test.
    vi.mocked(listFlows).mockResolvedValue([flow()]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search workflows"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/No workflows match your search/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ THE STATUS CHIP CARRIES THE VERSION — AND A VERSION IS AN APPROVAL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This block used to assert the chip printed `v{armedRevision}`, with a
 * `v{draftRevision} draft` fallback. Both are REVISION numbers, written on every
 * edit, and the fallback therefore climbed while somebody was still drafting —
 * reported from use, twice, ending in *"increment revision only on approval,
 * without that there won't be any versioning."*
 *
 * `FlowSummary.version` is the count of approvals (`flowRepo.approvalCountsFor`),
 * so it moves only when a person approves. The fixtures below deliberately give
 * `version` a number that agrees with NEITHER revision, because that is the only
 * arrangement in which the test can tell the three apart.
 */
describe("flows — the STATUS chip carries the version, not a revision", () => {
  it("shows the APPROVAL count, and neither revision number", async () => {
    // ⚠ Perturbation: `flow.version` → `flow.armedRevision` fails (2 vs 3), and
    // → `flow.draftRevision` fails (2 vs 5).
    vi.mocked(listFlows).mockResolvedValue([
      flow({ status: "armed", draftRevision: 5, armedRevision: 3, version: 2 }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.queryByText("v3")).toBeNull();
    expect(screen.queryByText("v5")).toBeNull();
  });

  it("⚠ an unapproved flow gets NO number at all, and no second tag repeating `Draft`", async () => {
    /**
     * The defect in one assertion. The old chip read `v2 draft` off
     * `draftRevision`, so it said `v3 draft` after the next chat turn and `v4`
     * after the one after. A version is an approval; there is nothing to number
     * yet.
     *
     * ⚠ There used to be a second tag here too, a bare `draft` beside the
     * status pill's own `Draft` — two pills, one row, same fact twice in
     * different case. The version tag now renders only when there is a
     * version to name.
     */
    vi.mocked(listFlows).mockResolvedValue([
      flow({ draftRevision: 7, armedRevision: null, version: null, status: "draft" }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.queryByText("draft")).toBeNull();
    expect(screen.queryByText(/^v7/)).toBeNull();
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });
});

describe("flows — sort, count and columns (S-28 § Layout, UXI-004)", () => {
  it("shows the N of M count with what it is sorted by, search is ~280px", async () => {
    // ⚠ Perturbation: sort sentence removed fails; N of M `visible.length` → `all.length` fails after filter.
    // Geometry §10: search ≈280px (sm:w-[280px]).
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Invoice chase" }),
      flow({ id: "f2", name: "Expense policy" }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    expect(screen.getByText("2 of 2 workflows · last updated first")).toBeTruthy();
    // Search input exists and its wrapper is the 280px control.
    const search = screen.getByLabelText("Search workflows");
    expect(search).toBeTruthy();
    expect((search as HTMLInputElement).placeholder).toBe("Search workflows");
    const wrapper = search.closest("div");
    expect(wrapper?.className).toContain("sm:w-[280px]");
    // N of M updates when filtered.
    fireEvent.change(search, { target: { value: "Invoice" } });
    await waitFor(() => expect(screen.getByText("1 of 2 workflows · last updated first")).toBeTruthy());
  });

  it("renders NAME & PURPOSE / STATUS / OWNER / LAST RUN / SCHEDULE — no Resources, which the server never sends", async () => {
    vi.mocked(listFlows).mockResolvedValue([
      flow({ status: "armed", armedRevision: 1, version: 1, schedule: "0 7 * * 1", description: "Routes disputes to the owning buyer." }),
      flow({ id: "f2", name: "Expense policy", status: "armed", armedRevision: 2, schedule: "" }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    for (const h of ["Name & purpose", "Status", "Owner", "Last run", "Schedule"]) expect(screen.getByText(h)).toBeTruthy();
    expect(screen.queryByText("Resources")).toBeNull();
    expect(screen.queryByText("Health")).toBeNull();
    expect(screen.getByText("Routes disputes to the owning buyer.")).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    // SCHEDULE: words for cron, "Not scheduled" for blank, never empty.
    expect(screen.getByText(/Every Monday|Every day/)).toBeTruthy();
    expect(screen.getByText("Not scheduled")).toBeTruthy();
    // LAST RUN: said rather than blank when it never ran.
    expect(screen.getAllByText("Never run")).toHaveLength(2);
  });

  it("LAST RUN shows the outcome in words and links to that run", async () => {
    vi.mocked(listFlows).mockResolvedValue([
      flow({ lastExecution: { id: "x1", status: "failed", engineStatus: "FAILED", startedAt: new Date().toISOString() } }),
    ]);
    render(<FlowsPage />);
    const word = await waitFor(() => screen.getByText("Failed", { selector: "span" }));
    expect(word.closest("a")?.getAttribute("href")).toBe("/runs/x1");
  });

  it("a DRAFT's cron is said to fire only once live — it is not a running schedule", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ status: "draft", armedRevision: null, schedule: "0 7 * * 1" })]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText(/once live/)).toBeTruthy());
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ TURNING A FLOW OFF — THE ROW MUST AGREE WITH THE ENGINE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reported from use as *"the buttons for switching off flows is not working"*,
 * and the server half was working the whole time: `revoke` removes the Schedule
 * trigger from Kestra and closes every approval row, then writes
 * `status: "suspended"` and **deliberately leaves `armed_revision` set** — it is
 * the record of which revision was live, which re-approval and the diff both
 * need.
 *
 * The row decided everything from `armedRevision != null`, so after a successful
 * turn-off it kept the green ON toggle, stayed in the `Live` view, and said
 * nothing. Pressing it again revoked again, to the same invisible effect.
 * Measured on the deployment: three flows at `status = suspended` with
 * `armed_revision` set and ZERO open approvals, every one rendering as live and
 * on.
 */
describe("flows — a revoked flow reads as OFF (the turn-off defect)", () => {
  it("renders the one-click ON button, not the armed toggle, once revoked with nothing changed", async () => {
    // ⚠ Perturbation: `isRunningUnattended` → `armedRevision != null` in
    // `ArmSwitch` restores the green button and turns this red.
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "suspended", armedRevision: 1, schedule: "0 7 * * 1" }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    // The draft is still exactly the armed revision, so the server can re-arm
    // it with no review — a button, never a door to one (decision 5, amended).
    const on = screen.getByLabelText(/turn on chase overdue invoices again/i);
    expect(on.tagName).toBe("BUTTON");
    expect(on.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByLabelText("Turn off Chase overdue invoices")).toBeNull();
    expect(screen.queryByLabelText(/is not running — review and approve it/i)).toBeNull();
  });

  it("one-clicks back on even when the draft moved on — the draft keeps its own review", async () => {
    // Suspend/resume is orthogonal to drafts: the switch resumes the APPROVED
    // revision and must never arm the unreviewed draft, nor demand its review
    // first. Only never-approved flows route to the workflow page, where Approve lives.
    vi.mocked(listFlows).mockResolvedValue([
      flow({
        name: "Chase overdue invoices",
        status: "suspended",
        armedRevision: 1,
        draftRevision: 2,
        draftAhead: true,
        schedule: "0 7 * * 1",
      }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    const on = screen.getByLabelText(/turn on chase overdue invoices again/i);
    expect(on.tagName).toBe("BUTTON");
    expect(screen.queryByLabelText(/is not running — review and approve it/i)).toBeNull();
  });

  it("routes to review when the flow was never approved", async () => {
    vi.mocked(listFlows).mockResolvedValue([
      flow({
        name: "Chase overdue invoices",
        status: "suspended",
        armedRevision: null,
        schedule: "0 7 * * 1",
      }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    // ⚠ The label changed on 2026-09-08 and the PROPERTY did not: it used to
    // read *"needs an approved revision"*, which was the right sentence
    // pointing at the wrong place — the link went to `/flows/{id}`, where
    // nothing approves anything. It now names the destination it actually has.
    const off = screen.getByLabelText(/is not running — review and approve it/i);
    expect(off).toBeTruthy();
    expect(off.getAttribute("href")).toBe("/flows/f1");
    expect(screen.queryByLabelText(/turn on chase overdue invoices again/i)).toBeNull();
  });

  it("off is a sunken well with a dim knob; on is green with a white knob", async () => {
    // ⚠ At a glance, across a table of rows: the old off track differed from
    // on only in hue and knob position, so off read as on. jsdom performs no
    // layout, so this asserts the classes that carry the distinction.
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "suspended", armedRevision: 1 }),
      flow({ id: "f2", name: "Expense policy", status: "armed", armedRevision: 2 }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    const on = screen.getByLabelText(/turn on chase overdue invoices again/i);
    expect(on.className).toContain("bg-sunken");
    expect(on.className).not.toContain("bg-ok");
    expect(on.querySelector("span")?.className).toContain("bg-dim");
    const off = screen.getByLabelText("Turn off Expense policy");
    expect(off.className).toContain("bg-ok");
    expect(off.querySelector("span")?.className).toContain("bg-white");
  });

  it("says it was TURNED OFF, and does not report it as a fault", async () => {
    /**
     * ⚠ `revoke` writes no `staleReason` — only the staleness sweep does — so
     * the row's old `status === "suspended" && !!staleReason` was false and a
     * revoked flow got no warn ground, no `Review` and no explanation at all.
     */
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "suspended", armedRevision: 1, staleReason: null }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    expect(screen.getByText(/turned off/i)).toBeTruthy();
    // A deliberate act must not be dressed as a fault.
    expect(screen.queryByText(/suspended —/i)).toBeNull();
  });

  it("reports the SWEEP's reason when the sweep is what suspended it", async () => {
    // ⚠ The other cause. One string for both would report a fault as a choice.
    vi.mocked(listFlows).mockResolvedValue([
      flow({
        name: "Chase overdue invoices",
        status: "suspended",
        armedRevision: 1,
        staleReason: "a referenced tool changed shape since approval",
      }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    expect(screen.getByText(/suspended — a referenced tool changed shape since approval/i)).toBeTruthy();
    expect(screen.queryByText(/turned off/i)).toBeNull();
  });

  it("an armed-and-edited flow still reads as ON — it is firing the approved revision", async () => {
    /**
     * ⚠ The dangerous direction, and the reason the predicate is not
     * `status === "armed"`. A `draft_pending` flow keeps firing its APPROVED
     * revision; rendering it OFF would tell somebody an automation is stopped
     * while it fires at 09:00.
     */
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "draft_pending", armedRevision: 2, draftAhead: true }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    expect(screen.getByLabelText("Turn off Chase overdue invoices")).toBeTruthy();
    expect(screen.getByText("a newer draft is not approved")).toBeTruthy();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ ONE CLICK BACK ON — THE REAL SERVER PATH, NOT A CLIENT PRETENSE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The button above is a promise: the revision is unchanged, so `POST
 * …/approvals/rearm` re-arms it with no review. These tests hold the page to
 * that promise — success toasts and reloads, the server's 409 (draft moved
 * on, dependency changed shape) routes to the workflow page, and anything else is
 * said out loud rather than swallowed.
 */
describe("flows — turning back on with nothing changed", () => {
  it("re-arms in one click and says so", async () => {
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "suspended", armedRevision: 1 }),
    ]);
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/turn on chase overdue invoices again/i));
    await waitFor(() => expect(rearmFlowApproval).toHaveBeenCalledWith("f1"));
    await waitFor(() =>
      expect(screen.getByText(/is running again — same approved revision/i)).toBeTruthy(),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });
  it("a 409 from rearm routes to review instead of reporting failure", async () => {
    // ⚠ THE CONTRACT. The endpoint answers 409 exactly when a person needs to
    // look; the page must not toast that as a failure and leave the flow off.
    const conflict = new FoundryApiError("changed since turn-off", 409);
    // The mock's error drops ctor args; the page reads `e.status`, so the test
    // sets what the real transport would have carried.
    const withStatus = conflict as unknown as { status: number };
    withStatus.status = 409;
    vi.mocked(rearmFlowApproval).mockRejectedValueOnce(conflict);
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "suspended", armedRevision: 1 }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/turn on chase overdue invoices again/i));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/flows/f1"));
  });

  it("any other failure is said out loud, and goes nowhere", async () => {
    vi.mocked(rearmFlowApproval).mockRejectedValueOnce(new Error("engine unreachable"));
    vi.mocked(listFlows).mockResolvedValue([
      flow({ name: "Chase overdue invoices", status: "suspended", armedRevision: 1 }),
    ]);
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Chase overdue invoices")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/turn on chase overdue invoices again/i));
    await waitFor(() => expect(screen.getByText(/engine unreachable/i)).toBeTruthy());
    expect(pushMock).not.toHaveBeenCalled();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ THE PURPOSE SENTENCE — WHY THE TABLE USED TO SCROLL SIDEWAYS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The description is rendered with `truncate`, which sets
 * `white-space: nowrap`. Under `table-layout: auto` a cell's min-content width
 * is then the WHOLE string — so `truncate` was WIDENING the column, not clipping
 * it, and real descriptions here run to 221 characters. The last column, holding
 * the arm switch and the row menu, was pushed off the right edge.
 *
 * `table-fixed` is what makes the declared widths authoritative, and it is the
 * only arrangement in which `truncate` or `line-clamp` mean anything inside a
 * cell.
 */
describe("flows — the purpose sentence is clamped, and expandable", () => {
  const LONG =
    "Monthly: compare each cost centre's spend against its budget, rank the overspends, " +
    "and email the finance owner a ranked digest with the three largest variances called out.";

  it("uses table-fixed so a long sentence cannot widen the table", async () => {
    // ⚠ Perturbation: drop `table-fixed` and this goes red — and the page
    // scrolls right again, which no assertion over jsdom could catch (jsdom
    // performs no layout, so an assertion on scrollWidth would pass for ever).
    vi.mocked(listFlows).mockResolvedValue([flow({ description: LONG })]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    const table = document.querySelector("table");
    expect(table?.className).toContain("table-fixed");
    // ⚠ And the scroll container is gone: it would hide a regression rather
    // than prevent one.
    expect(table?.closest("div")?.className ?? "").not.toContain("overflow-x-auto");
  });

  it("clamps the sentence until asked, then shows all of it", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ description: LONG })]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    const sentence = screen.getByText(LONG);
    expect(sentence.className).toContain("truncate");
    const toggle = screen.getByLabelText(/Read the full purpose of Invoice chase/i);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(sentence.id);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(LONG).className).not.toContain("truncate"));
    expect(screen.getByLabelText(/Collapse the purpose of Invoice chase/i).getAttribute("aria-expanded")).toBe("true");
  });

  it("offers NO disclosure when there is no sentence to reveal", async () => {
    /**
     * ⚠ I-94's inert-control shape. The fallback second line is the Kestra slug
     * — one short token with no hidden remainder — so a chevron there would
     * expand nothing and teach people the row's controls do not mean anything.
     */
    vi.mocked(listFlows).mockResolvedValue([flow({ description: null, kestraFlowId: "invoice-chase" })]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    expect(screen.getByText("invoice-chase")).toBeTruthy();
    expect(screen.queryByLabelText(/purpose of Invoice chase/i)).toBeNull();
  });

  it("the disclosure is not nested inside the row's link", async () => {
    /**
     * ⚠ A `<button>` inside an `<a>` is invalid markup whose click target the
     * browser decides — the first version put the chevron inside the name link
     * and pressing it navigated to the flow about as often as it expanded the
     * row.
     */
    vi.mocked(listFlows).mockResolvedValue([flow({ description: LONG })]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    expect(screen.getByLabelText(/Read the full purpose/i).closest("a")).toBeNull();
  });
});

describe("flows — Duplicate in the row menu", () => {
  it("offers Duplicate beside Delete and navigates to the copy", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true })]);
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("More actions"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy());
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(duplicateFlow).toHaveBeenCalledWith("f1"));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/flows/copy-1"));
  });

  it("⚠ somebody else's shared workflow: Duplicate, never Delete — deleting is its owner's (sharing-boundaries phase 2)", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: false, visibility: "public" })]);
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByText("Invoice chase")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("More actions"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });
});

describe("flows — a build nobody has saved yet", () => {
  const chat = (over: Partial<PiChatSummary> = {}): PiChatSummary => ({
    id: "c1",
    title: "Email me the attendance gaps",
    flowId: null,
    flowName: null,
    createdBy: { subject: "u", name: "Asha" },
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    messageCount: 3,
    draftSteps: 2,
    draftName: "Attendance gaps",
    canDelete: true,
    ...over,
  });

  it("is listed as Unsaved, counted under All and Drafts, and opens its chat; talk alone and saved builds are not", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow()]);
    listPiChats.mockResolvedValueOnce([
      chat(),
      chat({ id: "c2", title: "hello", draftSteps: 0, draftName: null }),
      chat({ id: "c3", flowId: "f1", flowName: "Invoice chase", draftSteps: 0 }),
    ]);
    render(<FlowsPage />);
    const name = await screen.findByText("Attendance gaps");
    expect(name.closest("a")?.getAttribute("href")).toBe("/chats/c1");
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.queryByText("hello")).toBeNull();
    expect(screen.getByRole("tab", { name: /All/ }).textContent).toContain("2");
    expect(screen.getByRole("tab", { name: /Drafts/ }).textContent).toContain("2");
  });

  it("a chat list that cannot be read leaves the workflows as they are", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow()]);
    listPiChats.mockRejectedValueOnce(new Error("503"));
    render(<FlowsPage />);
    expect(await screen.findByText("Invoice chase")).toBeTruthy();
    expect(screen.queryByText("Unsaved")).toBeNull();
  });
});

describe("flows — Delete selected", () => {
  // Deleting is managing (sharing-boundaries phase 2): these are the tester's own workflows (`mine: true`); a row that
  // is not theirs gets no checkbox and no Delete — see the last test in this block.
  const toastText = () => document.body.textContent ?? "";
  const live = flow({ mine: true,  id: "f2", name: "Payroll reminder", status: "armed", armedRevision: 1 });

  afterEach(() => {
    flowsWrite = "unreadable";
  });

  it("Select all picks the workflows shown, the confirmation counts the live ones, and each is deleted", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true }), live, flow({ mine: true,  id: "f3", name: "Other thing" })]);
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    await screen.findByText("Payroll reminder");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.change(screen.getByLabelText("Search workflows"), { target: { value: "chase" } });
    fireEvent.click(screen.getByLabelText("Select all workflows shown"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search workflows"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Select Payroll reminder"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete \(\d+\)$/ }));
    expect(screen.getByText(/1 of them is live and will stop running/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    await waitFor(() => expect(deleteFlow).toHaveBeenCalledTimes(2));
    expect(deleteFlow.mock.calls.map((c) => c[0]).sort()).toEqual(["f1", "f2"]);
    await waitFor(() => expect(toastText()).toContain("Deleted 2 workflows."));
  });

  it("a partly failed delete names the reason and keeps the failed one selected", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true }), live]);
    deleteFlow.mockImplementation(async (id: string) => {
      if (id === "f2") throw new Error("You need flows.write in this workspace.");
    });
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByLabelText("Select all workflows shown"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete \(\d+\)$/ }));
    expect(screen.getByText(/1 of them is live and will stop running/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    await waitFor(() => expect(toastText()).toContain("Deleted 1 of 2 workflows. 1 could not be: You need flows.write in this workspace."));
    expect((screen.getByLabelText("Select Payroll reminder") as HTMLInputElement).checked).toBe(true);
    deleteFlow.mockReset();
    deleteFlow.mockImplementation(async () => {});
  });

  it("an unsaved build (a chat) gets no checkbox", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true })]);
    listPiChats.mockResolvedValueOnce([
      {
        id: "c1", title: "Email me the attendance gaps", flowId: null, flowName: null,
        createdBy: { subject: "u", name: "Asha" }, createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z",
        messageCount: 3, draftSteps: 2, draftName: "Attendance gaps", canDelete: true,
      },
    ]);
    render(<FlowsPage />);
    await screen.findByText("Attendance gaps");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.queryByLabelText("Select Attendance gaps")).toBeNull();
    expect(screen.getByLabelText("Select Invoice chase")).toBeTruthy();
  });

  it("no selection column for someone known not to hold flows.write", async () => {
    flowsWrite = "denied";
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true })]);
    render(<FlowsPage />);
    await screen.findByText("Invoice chase");
    expect(screen.queryByLabelText("Select all workflows shown")).toBeNull();
    expect(screen.queryByLabelText("Select Invoice chase")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
  });

  it("checkboxes are hidden until Select; Delete is disabled with nothing ticked; Clear all and Esc leave", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true }), live]);
    render(<FlowsPage />);
    await screen.findByText("Payroll reminder");
    expect(screen.queryByLabelText("Select Invoice chase")).toBeNull();
    expect(screen.queryByLabelText("Select all workflows shown")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Select Invoice chase"));
    expect((screen.getByRole("button", { name: "Delete (1)" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByLabelText("Select Invoice chase")).toBeNull();
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect((screen.getByLabelText("Select Invoice chase") as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Select Invoice chase")).toBeNull();
  });

  it("a fully successful delete leaves select mode", async () => {
    vi.mocked(listFlows).mockResolvedValue([flow({ mine: true })]);
    render(
      <ToastProvider>
        <FlowsPage />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByLabelText("Select Invoice chase"));
    fireEvent.click(screen.getByRole("button", { name: "Delete (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1" }));
    await waitFor(() => expect(deleteFlow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Select" })).toBeTruthy());
  });
});

describe("flows — owner and Observer (rbac-observability)", () => {
  afterEach(() => {
    flowsWrite = "unreadable";
  });

  it("says whose each workflow is — You for the person asking — and where it lives", async () => {
    vi.mocked(listFlows).mockResolvedValue([
      flow({ id: "a", name: "Mine one", mine: true, ownerSubject: "me", ownerName: "me@x.example" }),
      flow({ id: "b", name: "Theirs", status: "armed", armedRevision: 1, visibility: "public", ownerSubject: "ada", ownerName: "ada@x.example" }),
      flow({ id: "c", name: "Old one", ownerSubject: null }),
      // Switched on and still private (plugins phase 9): approving no longer publishes.
      flow({ id: "d", name: "On, private", status: "approved", armedRevision: 2, visibility: "private", ownerSubject: "bo", ownerName: "bo@x.example" }),
    ]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Mine one")).toBeTruthy());
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("ada@x.example")).toBeTruthy();
    expect(screen.getByText("Admins")).toBeTruthy();
    // Where it lives, in the three words (sharing-boundaries phase 6) — never "Public"/"Private".
    expect(screen.getAllByTitle("Everyone in this workspace sees it.")).toHaveLength(1);
    expect(screen.getAllByTitle("Only its owner (and Admins) see it.")).toHaveLength(3);
    expect(screen.queryByText("Public")).toBeNull();
    expect(screen.queryByText("Private")).toBeNull();
    expect(screen.getByRole("tab", { name: /Mine/ }).textContent).toContain("1");
  });

  it("narrows any tab to where it lives: My space, the projects, or the Workspace (phase 6)", async () => {
    vi.mocked(listFlows).mockResolvedValue([
      flow({ id: "a", name: "In my space", ownerSubject: "me" }),
      flow({ id: "b", name: "For everyone", visibility: "public", ownerSubject: "me" }),
      flow({ id: "c", name: "In payroll", projectId: "p1", projectName: "Payroll close", ownerSubject: "me" }),
    ]);
    render(<FlowsPage />);
    await screen.findByText("In payroll");
    expect(screen.getByTitle("The members of Payroll close (and Admins) see it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Projects" }));
    expect(screen.queryByText("In my space")).toBeNull();
    expect(screen.queryByText("For everyone")).toBeNull();
    expect(screen.getByText("In payroll")).toBeTruthy();
    // ⚠ The tab counts count within the filter (P6-I1): "All 3" would sit over one row.
    expect(screen.getByRole("tab", { name: /All/ }).textContent).toMatch(/1$/);
    fireEvent.click(screen.getByRole("radio", { name: "My space" }));
    expect(screen.getByText("In my space")).toBeTruthy();
    expect(screen.queryByText("In payroll")).toBeNull();
  });

  it("offers no New workflow to someone who may not build (an Observer)", async () => {
    flowsWrite = "denied";
    vi.mocked(listFlows).mockResolvedValue([]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText(/Nothing shared with you yet/)).toBeTruthy());
    expect(screen.queryByText("New workflow")).toBeNull();
    expect(screen.queryByText("Describe one")).toBeNull();
  });

  it("does offer New workflow when the permission could not be read — the server decides", async () => {
    vi.mocked(listFlows).mockResolvedValue([]);
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("Describe one")).toBeTruthy());
    expect(screen.getByText("New workflow")).toBeTruthy();
  });
});

describe("flows — an unsaved build is the chat's (rbac-observability)", () => {
  it("counts and lists one in my own chat under Mine, and not somebody else's", async () => {
    vi.mocked(listFlows).mockResolvedValue([]);
    listPiChats.mockResolvedValueOnce([
      { id: "c1", title: "mine", flowId: null, flowName: null, createdBy: { subject: "me", name: "Me" }, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z", messageCount: 2, draftSteps: 2, draftName: "My build", canDelete: true, mine: true },
      { id: "c2", title: "theirs", flowId: null, flowName: null, createdBy: { subject: "u2", name: "Ravi" }, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z", messageCount: 2, draftSteps: 3, draftName: "Their build", canDelete: true, mine: false },
    ] as PiChatSummary[]);
    searchView.value = "mine";
    render(<FlowsPage />);
    await waitFor(() => expect(screen.getByText("My build")).toBeTruthy());
    expect(screen.queryByText("Their build")).toBeNull();
    expect(screen.getByRole("tab", { name: /Mine/ }).textContent).toContain("1");
    searchView.value = null;
  });
});
