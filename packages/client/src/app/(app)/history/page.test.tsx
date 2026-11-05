// @vitest-environment jsdom
//
// src/app/(app)/history/page.test.tsx — History's column split and status
// relabel (flow-history-name-snapshot, User Stories 3/4/6).
//
// ⚠ Node 22 or nothing — see vitest.config.ts's own docblock. On Node 20 this
// file fails to load with `webidl.util.markAsUncloneable is not a function`
// while vitest still prints a green file count.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Run } from "@/lib/types";

// The automation-filter <select> below the table also renders each run's
// automation name as an <option>, so a bare `getByText` collides with it.
// Scope name/id assertions to the table itself.
const table = () => within(screen.getByRole("table"));

const listRuns = vi.fn(async (): Promise<Run[]> => []);

/**
 * The page reads one PAGE at a time (2026-10-11), filtered by the server. This stands in for the server: it filters
 * `listRuns`'s rows by the search as the server does (the workflow name, the run's id, the workflow's id) and serves
 * them as one page — so the tests below still describe what a person sees, and `listRunsPage` records what was asked.
 */
const listRunsPage = vi.fn(async (p: { q?: string; before?: string } = {}) => {
  const needle = (p.q ?? "").toLowerCase();
  const runs = (await listRuns()).filter(
    (r) => !needle || [r.automation, r.id, r.flowId ?? "", r.flowIdSnapshot ?? ""].some((v) => v.toLowerCase().includes(needle)),
  );
  return { runs, next: null as string | null };
});
vi.mock("@/lib/api", () => ({
  listRunsPage: (p: { q?: string; before?: string }) => listRunsPage(p),
}));

import HistoryPage from "./page";

afterEach(() => {
  cleanup();
  listRuns.mockReset();
  listRunsPage.mockClear();
});

const baseRun: Run = {
  id: "e8a82948-431f-4eaf-89bf-a731448f0746",
  when: "10:47 today",
  automation: "pending status",
  flowId: "3f2b9a4c-0000-4000-8000-000000000001",
  outcome: "done",
  text: "ran and completed",
  timeTaken: "6 sec",
  action: "Details",
};

describe("History's Workflow name / Workflow ID / Run ID columns", () => {
  it("shows three separate columns instead of one combined 'Automation' cell", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);

    expect(await screen.findByText("Workflow name")).toBeTruthy();
    expect(screen.getByText("Workflow ID")).toBeTruthy();
    expect(screen.getByText("Run ID")).toBeTruthy();
    // ⚠ The regression this guards: the old single "Automation" header must be
    // gone, not just supplemented.
    expect(screen.queryByText("Automation")).toBeNull();

    expect(table().getByText("pending status")).toBeTruthy();
    // Truncated to 5 chars + ellipsis, per CopyableId — the full uuid is never
    // rendered inline in either id column.
    expect(table().getByText("3f2b9…")).toBeTruthy();
    expect(table().getByText("e8a82…")).toBeTruthy();
    expect(table().queryByText(baseRun.flowId as string)).toBeNull();
    expect(table().queryByText(baseRun.id)).toBeNull();
  });

  it("gives every id column its own copy button", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    // One row, two ids (Workflow ID + Run ID) → two copy buttons.
    expect(table().getAllByRole("button", { name: "Copy id" })).toHaveLength(2);
  });

  it("renders a placeholder Workflow ID for an orphaned run (flow deleted) instead of blank", async () => {
    listRuns.mockResolvedValue([{ ...baseRun, flowId: null }]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    // CopyableId's null case: "—", no copy button for that column — leaving
    // exactly one copy button (Run ID's) on this row.
    expect(table().getAllByRole("button", { name: "Copy id" })).toHaveLength(1);
  });

  it("shows the FROZEN id, not '—', for a deleted flow whose run captured a snapshot (User Story 5)", async () => {
    // ⚠ The regression this guards is the one this session actually wrote and
    // then fixed: the Workflow ID cell rendering `r.flowId` directly instead
    // of `runWorkflowId(r)`. A row with `flowId: null` alone (the case
    // above) can't tell the two implementations apart — both render "—" —
    // so this case supplies a snapshot too, which only the fallback chain
    // would find.
    listRuns.mockResolvedValue([
      { ...baseRun, flowId: null, flowIdSnapshot: "9e9e9e9e-0000-4000-8000-000000000009" },
    ]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    expect(table().getByText("9e9e9…")).toBeTruthy();
    expect(table().getAllByRole("button", { name: "Copy id" })).toHaveLength(2);
  });
});

describe("Workflow ID and Run ID link to their detail pages (User Story 7)", () => {
  it("links the Workflow ID to /flows/:id, using runWorkflowId — not the bare flowId", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    const link = table().getByRole("link", { name: "3f2b9…" });
    expect(link.getAttribute("href")).toBe(`/flows/${baseRun.flowId}`);
  });

  it("prefers the SNAPSHOT id as the link target when the flow has been deleted", async () => {
    // Same regression class as T035's discriminating render test above: a
    // link built from `r.flowId` instead of `runWorkflowId(r)` would point
    // nowhere (or at `/flows/null`) for exactly the row this feature exists
    // to keep working.
    listRuns.mockResolvedValue([
      { ...baseRun, flowId: null, flowIdSnapshot: "9e9e9e9e-0000-4000-8000-000000000009" },
    ]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    const link = table().getByRole("link", { name: "9e9e9…" });
    expect(link.getAttribute("href")).toBe("/flows/9e9e9e9e-0000-4000-8000-000000000009");
  });

  it("links the Run ID to /runs/:id", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    const link = table().getByRole("link", { name: "e8a82…" });
    expect(link.getAttribute("href")).toBe(`/runs/${baseRun.id}`);
  });

  it("an orphaned run with no id at all (predates the snapshot AND the flow is deleted) has no Workflow ID link", async () => {
    listRuns.mockResolvedValue([{ ...baseRun, flowId: null, flowIdSnapshot: null }]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    // Exactly one link on the row — Run ID's. The Workflow ID cell has
    // nothing to point at, so it renders "—" with neither a link nor a copy
    // button, per CopyableId's own null case.
    expect(table().getAllByRole("link")).toHaveLength(1);
  });

  it("the copy buttons still work and do not navigate — independent of the links", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    const [workflowCopy, runCopy] = table().getAllByRole("button", { name: "Copy id" });
    // Neither button is nested inside a link — the accessibility hazard a
    // naive "wrap the cell in a Link" implementation would introduce.
    for (const link of table().getAllByRole("link")) {
      expect(link.contains(workflowCopy)).toBe(false);
      expect(link.contains(runCopy)).toBe(false);
    }
  });
});

describe("History's Status column", () => {
  it("labels the header 'Status', not 'Action'", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);
    expect(await screen.findByText("Status")).toBeTruthy();
    expect(screen.queryByText("Action")).toBeNull();
  });

  it.each([
    ["done", "completed"],
    ["stopped", "stopped"],
    ["running", "running"],
  ] as const)("outcome %s renders the plain word %s, not the run.* spelling", async (outcome, word) => {
    listRuns.mockResolvedValue([{ ...baseRun, outcome }]);
    render(<HistoryPage />);
    expect(await screen.findByText(word)).toBeTruthy();
    expect(screen.queryByText(`run.${word === "completed" ? "completed" : word}`)).toBeNull();
  });
});

describe("History has no control that edits a run's or a workflow's name (User Story 3)", () => {
  it("offers no rename affordance anywhere on the page", async () => {
    listRuns.mockResolvedValue([baseRun]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");

    expect(screen.queryByRole("button", { name: /rename/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /workflow name|automation name/i })).toBeNull();
  });
});

describe("History's search also matches the Workflow ID (User Story 4 follow-on)", () => {
  it("finds a run by a leading fragment of its workflow id", async () => {
    listRuns.mockResolvedValue([
      baseRun,
      { ...baseRun, id: "other-run-id", automation: "unrelated automation", flowId: "aaaaaaaa-0000-0000-0000-000000000000" },
    ]);
    render(<HistoryPage />);
    await screen.findByText("Workflow name");
    expect(table().getByText("unrelated automation")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search history…"), { target: { value: "3f2b9a4c" } });

    // The search goes to the SERVER (over every run, not the loaded page), once typing pauses.
    await waitFor(() => expect(table().queryByText("unrelated automation")).toBeNull());
    expect(table().getByText("pending status")).toBeTruthy();
    expect(listRunsPage).toHaveBeenLastCalledWith(expect.objectContaining({ q: "3f2b9a4c" }));
  });
});

describe("History pages through runs (2026-10-11)", () => {
  it("loads the next page with the cursor the server gave, and says when every run is shown", async () => {
    listRunsPage
      .mockResolvedValueOnce({ runs: [baseRun], next: "cursor-1" })
      .mockResolvedValueOnce({ runs: [{ ...baseRun, id: "older-run", automation: "older automation" }], next: null });
    render(<HistoryPage />);
    await screen.findByText("Workflow name");
    expect(table().queryByText("older automation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(table().getByText("older automation")).toBeTruthy());
    expect(listRunsPage).toHaveBeenLastCalledWith(expect.objectContaining({ before: "cursor-1" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByText("That is every run.")).toBeTruthy();
  });
});
