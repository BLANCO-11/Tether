// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DashboardPage from "./page";

/**
 * The dashboard (2026-10-23): the greeting and the composer, then "Runs and health" — a period, live or test runs,
 * mine or everyone (only where the server says it is a choice), five figures and the recent runs.
 *
 * ⚠ The claims this file exists for:
 *   - **Partly done is neither a success nor a failure.** "Succeeded" divides by settled runs and counts full
 *     successes only; the partly-done runs have their own figure and their own word in the table.
 *   - **Nothing finished is "—", never 0%.** 0% would say every run failed.
 *   - **"Mine / Everyone" appears only when the server offers it** (`choosesScope`) — a toggle for a Creator would
 *     promise a wider view that does not exist.
 *   - **A choice re-reads, it does not re-filter what is on screen** — the figures are the server's.
 *   - **A refresh never blanks the page**, and what was typed in the composer survives the data arriving.
 *
 * ⚠ Node 22 or nothing: on Node 20 every jsdom file in this package fails to load
 * with `webidl.util.markAsUncloneable is not a function` and vitest still prints a
 * green file count. `vitest.config.ts` throws below 22 for exactly that reason.
 */

vi.mock("@/lib/api", () => ({
  // ⚠ A `vi.mock` of `@/lib/api` is a WHOLE-MODULE replacement: anything this
  // page or its children read must be listed here or it arrives `undefined` and
  // `useAsync` invokes it. Adding a read to this page means adding it here.
  dashboardSummary: vi.fn(),
}));
vi.mock("@/lib/activity", () => ({ useActivityEpoch: () => 0 }));
/** What the session names the person. Changed per test. */
let sessionName = "himanshu saini";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { name: sessionName, email: "h@x.test" } }) }));
// The composer (`HomeComposer`) navigates on Send, so the page reaches for the
// app router. Enumerated rather than proxied, the same reasoning
// `routes.smoke.test.tsx` gives: a page reaching for a hook not in this list is
// information, not noise.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

/** `flows.write` for the composer: unreadable by default (no provider), which shows it. */
let canWrite: "allowed" | "denied" | "unreadable" = "unreadable";
vi.mock("@/components/access/Can", () => ({
  useCan: () => ({ state: canWrite, allowed: canWrite === "allowed", denied: canWrite === "denied", unreadable: canWrite === "unreadable", why: [] }),
}));

const api = await import("@/lib/api");

const counts = (o: Partial<{ runs: number; succeeded: number; failed: number; partial: number }> = {}) => {
  const c = { runs: 0, succeeded: 0, failed: 0, partial: 0, ...o };
  return { ...c, settled: c.succeeded + c.failed + c.partial };
};

type Row = {
  id: string;
  automation: string;
  outcome: "done" | "partial" | "stopped" | "running";
  startedBy?: { kind: string; label: string; detail: string | null; cron?: string | null };
  startedAt?: string | null;
  durationMs?: number | null;
  items?: { done: number; total: number } | null;
};
const row = (r: Row) => ({
  startedBy: { kind: "person", label: "Kriti Gautam", detail: "manual" },
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  durationMs: 21_000,
  items: null,
  ...r,
});

/** The mockup's week: 142 runs, 128 of 140 settled succeeded, 9 failed across 4 automations, 3 partly done. */
const data = (over: Record<string, unknown> = {}) => ({
  env: "live",
  scope: "everyone",
  choosesScope: false,
  health: {
    range: "7d",
    current: counts({ runs: 142, succeeded: 128, failed: 9, partial: 3 }),
    previous: counts({ runs: 120, succeeded: 114, failed: 4, partial: 2 }),
    failedAutomations: 4,
    series: [3, 5, 4, 6].map((n, i) => ({ start: `2026-10-${17 + i}T00:00:00.000Z`, ...counts({ runs: n, succeeded: n - 1, failed: 1 }) })),
    bucket: "day",
    runningNow: 0,
    longestRunningMs: null,
    medianMs: 38_000,
  },
  recent: [],
  running: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionName = "himanshu saini";
});
afterEach(cleanup);

describe("dashboard — the header eyebrow", () => {
  it("carries a real date, not a greeting to nobody", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    const expected = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date());
    await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
    // The session carries the person's name now, so the greeting uses the first word of it.
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toMatch(/^Good (morning|afternoon|evening), Himanshu$/);
    expect(h1.textContent).not.toMatch(/@/);
  });

  it("stands alone — never `Good morning, ` with a blank — when the session has no name", async () => {
    sessionName = "";
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("Runs and health")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
  });
});

describe("dashboard — Runs and health figures", () => {
  it("shows the five figures with their change from the previous period", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("142")).toBeTruthy());
    expect(screen.getByText("▲ 18%")).toBeTruthy();
    expect(screen.getByText("vs previous 7 days (120)")).toBeTruthy();
    expect(screen.getByText("across 4 automations")).toBeTruthy();
    for (const label of ["Runs", "Succeeded", "Failed", "Partly done", "Running now"]) expect(screen.getByText(label)).toBeTruthy();
  });

  it("counts Succeeded over settled runs, full successes only — partly done is not a success", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    // 128 of 140 (9 failed + 3 partly done also settled) = 91%, not 131 of 140.
    await waitFor(() => expect(screen.getByText("128 of 140")).toBeTruthy());
    expect(screen.getByText("91%", { exact: false })).toBeTruthy();
    // Previous: 114 of 120 = 95% → 91% is ▼ 4 pts.
    expect(screen.getByText("▼ 4 pts")).toBeTruthy();
    expect(screen.getByText("was 95%")).toBeTruthy();
  });

  it("says — rather than 0% when nothing has finished", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(
      data({ health: { ...data().health, current: counts({ runs: 2 }), previous: counts(), series: [], runningNow: 2 } }) as never,
    );
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("nothing finished yet")).toBeTruthy());
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("draws a trend line only where there are two points to draw", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByTestId("sparkline")).toHaveLength(3));
  });
});

describe("dashboard — the toolbar", () => {
  it("offers Mine / Everyone only when the server says it is a choice", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    const { unmount } = render(<DashboardPage />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Period" })).toBeTruthy());
    expect(screen.queryByRole("group", { name: "Whose runs" })).toBeNull();
    unmount();
    vi.mocked(api.dashboardSummary).mockResolvedValue(data({ choosesScope: true }) as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByRole("group", { name: "Whose runs" })).toBeTruthy());
  });

  it("asks the SERVER again for a new choice — live or test, a period, mine", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data({ choosesScope: true }) as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Test runs" })).toBeTruthy());
    expect(vi.mocked(api.dashboardSummary)).toHaveBeenLastCalledWith({ range: "7d", env: "live", scope: "everyone" });
    fireEvent.click(screen.getByRole("button", { name: "Test runs" }));
    await waitFor(() => expect(vi.mocked(api.dashboardSummary)).toHaveBeenLastCalledWith({ range: "7d", env: "test", scope: "everyone" }));
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(vi.mocked(api.dashboardSummary)).toHaveBeenLastCalledWith({ range: "30d", env: "test", scope: "everyone" }));
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    await waitFor(() => expect(vi.mocked(api.dashboardSummary)).toHaveBeenLastCalledWith({ range: "30d", env: "test", scope: "mine" }));
    expect(screen.getByRole("button", { name: "Mine" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("dashboard — recent runs", () => {
  const rows = [
    row({ id: "r1", automation: "Invoice chase", outcome: "running", startedAt: new Date().toISOString(), durationMs: null, startedBy: { kind: "schedule", label: "Schedule", detail: null, cron: "0 9 * * 1-5" } }),
    row({ id: "r2", automation: "Expense policy check", outcome: "stopped", items: { done: 0, total: 3 }, startedBy: { kind: "trigger", label: "Webhook", detail: "expenses-in" } }),
    row({ id: "r3", automation: "Late order notices", outcome: "partial", items: { done: 6, total: 8 } }),
    row({ id: "r4", automation: "Open ticket digest", outcome: "done", items: { done: 1, total: 1 } }),
  ];

  it("lists each run with its outcome in words, what started it, linked to the run — and no Items column", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data({ recent: rows, running: [rows[0]] }) as never);
    render(<DashboardPage />);
    const table = await waitFor(() => screen.getByRole("table"));
    const t = within(table);
    expect(t.getByText("Invoice chase").closest("a")?.getAttribute("href")).toBe("/runs/r1");
    for (const word of ["Running", "Failed", "Partly done", "Succeeded"]) expect(t.getByText(word)).toBeTruthy();
    expect(t.getByText("Webhook")).toBeTruthy();
    expect(t.getByText("expenses-in")).toBeTruthy();
    expect(t.getAllByText("Kriti Gautam")).toHaveLength(2);
    expect(t.queryByText("Items")).toBeNull();
    expect(t.queryByText("6 of 8")).toBeNull();
    expect(t.getByText("Now")).toBeTruthy();
    expect(screen.getByRole("link", { name: "History" }).getAttribute("href")).toBe("/history");
  });

  it("shows a schedule in words — and one it cannot put into words as a custom schedule, never the raw cron", async () => {
    const weekly = row({ id: "r5", automation: "Budget digest", outcome: "done", startedBy: { kind: "schedule", label: "Schedule", detail: null, cron: "0 8 * * 1" } });
    vi.mocked(api.dashboardSummary).mockResolvedValue(data({ recent: [...rows, weekly] }) as never);
    render(<DashboardPage />);
    const t = within(await waitFor(() => screen.getByRole("table")));
    expect(t.getByText("Every Monday at 08:00")).toBeTruthy();
    expect(t.getByText("custom schedule")).toBeTruthy();
    expect(t.queryByText("0 9 * * 1-5")).toBeNull();
  });

  it("says there are no runs of the kind asked for, rather than drawing an empty table", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/No live runs yet/)).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("dashboard — the composer and the page around it", () => {
  it("renders the composer, and its Send hands the text to the chat builder without creating anything", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    const box = await waitFor(() => screen.getByPlaceholderText("Describe what you want to automate..."));
    // ⚠ Verbatim copy from S-01 § Copy — placeholder and button label both.
    fireEvent.change(box, { target: { value: "chase late invoices" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // Routes with the text; does NOT call any create/generate API. The person
    // presses Send again in the builder — auto-sending from a page they are
    // leaving would start a real generation nobody confirmed.
    expect(push).toHaveBeenCalledWith("/chats/new?q=chase%20late%20invoices");
  });

  it("Send is disabled until something is typed", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    const send = await waitFor(() => screen.getByRole("button", { name: "Send" }));
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it("⚠ a background refresh never blanks the page to its skeleton", async () => {
    // A run in flight starts the 5s re-read; the second read hangs, which is the moment the old page flashed.
    const running = row({ id: "r9", automation: "Nightly sync", outcome: "running", startedAt: new Date().toISOString(), durationMs: null });
    const withRun = data({ recent: [running], running: [running] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.dashboardSummary)
        .mockResolvedValueOnce(withRun as never)
        .mockImplementationOnce(() => new Promise(() => {}) as never);
      render(<DashboardPage />);
      await waitFor(() => expect(screen.getByText("142")).toBeTruthy());
      await act(async () => {
        vi.advanceTimersByTime(5100);
      });
      expect(vi.mocked(api.dashboardSummary)).toHaveBeenCalledTimes(2); // control: the refresh really is in flight
      expect(screen.getByText("142")).toBeTruthy();
      expect(screen.getByText("Nightly sync")).toBeTruthy();
      expect(screen.queryByTestId("skeleton")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps what was typed in the composer when the data arrives", async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(api.dashboardSummary).mockImplementationOnce(() => new Promise((r) => (resolve = r)) as never);
    render(<DashboardPage />);
    const box = screen.getByPlaceholderText("Describe what you want to automate...");
    fireEvent.change(box, { target: { value: "chase late invoices" } });
    await act(async () => resolve(data()));
    await waitFor(() => expect(screen.getByText("142")).toBeTruthy());
    expect((screen.getByPlaceholderText("Describe what you want to automate...") as HTMLTextAreaElement).value).toBe("chase late invoices");
  });

  it("does not duplicate the rail's heading — the only h1 is the greeting, never Dashboard or Home", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("Runs and health")).toBeTruthy());
    // ⚠ Perturbation: add <h1>Dashboard</h1> to the page and this fails on the
    // queryByText; add a second h1 and the length check fails.
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toMatch(/^Good (morning|afternoon|evening)(, \w+)?$/);
    expect(screen.queryByRole("heading", { name: /^Dashboard$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Home$/i })).toBeNull();
    // The page never renders the rail label as a title; the rail owns that.
    expect(screen.queryByText(/^Dashboard$/)).toBeNull();
    // ⚠ 8 absences — the three not pinned elsewhere are pinned here so the count
    // stays eight. Perturbation: re-add "Manage cards" to the header or
    // "Ordered by urgency" to the attention card and the query stops being null.
    expect(screen.queryByText("Manage cards")).toBeNull();
    expect(screen.queryByText("Ordered by urgency")).toBeNull();
    expect(screen.queryByText("Ask before changes")).toBeNull();
    // The composer carries no "+"/"@" picker buttons — S-04 is unbuilt (UX-002).
    // Perturbation: add a button named "+" or "@" to HomeComposer and this fails.
    expect(screen.queryByRole("button", { name: "+" })).toBeNull();
    expect(screen.queryByRole("button", { name: "@" })).toBeNull();
  });

  it("does not duplicate the topbar search — the only textbox is the composer, not the centred search", async () => {
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    const composer = await waitFor(() => screen.getByPlaceholderText("Describe what you want to automate..."));
    expect(composer).toBeTruthy();
    // ⚠ Perturbation: add <input placeholder="Search workflows, runs, resources">
    // to the page and the query below stops being null.
    expect(screen.queryByPlaceholderText("Search workflows, runs, resources")).toBeNull();
    expect(screen.queryByPlaceholderText(/Search workflows/)).toBeNull();
    expect(screen.queryByLabelText(/Switch workspace/)).toBeNull();
    // Exactly one textbox in the page (the composer textarea). The topbar's ⌘K
    // palette is shell-owned; a second searchbox here would scroll with content.
    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toBe(composer);
  });
});

describe("dashboard — an Observer (rbac-observability)", () => {
  it("is told what they may do instead of being offered the composer", async () => {
    canWrite = "denied";
    vi.mocked(api.dashboardSummary).mockResolvedValue(data() as never);
    render(<DashboardPage />);
    expect(await screen.findByText("You are an Observer in this workspace")).toBeTruthy();
    canWrite = "unreadable";
  });
});
