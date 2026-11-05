// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReportRun, ReportSummary } from "@/lib/reports";

const group = (id: string, name: string, costUsd: number, extra: object = {}) => ({
  id, name, costUsd, tokens: 1500, runs: 4, workflows: 2, people: 2, workspaces: 1, share: costUsd / 10, ...extra,
});
const summary = (over: Partial<ReportSummary> = {}): ReportSummary => ({
  window: { fromDay: "2026-09-27", toDay: "2026-10-26" },
  tiles: { costUsd: 10, tokens: 4500, runs: 12, workspaces: 2, workflows: 3, people: 2 },
  byDay: [
    { day: "2026-10-25", costUsd: 4, live: 1, test: 1, building: 2 },
    { day: "2026-10-26", costUsd: 6, live: 5, test: 0, building: 1 },
  ],
  byPurpose: [{ purpose: "live", costUsd: 6, runs: 6 }, { purpose: "test", costUsd: 3, runs: 4 }, { purpose: "building", costUsd: 1, runs: 2 }],
  byOutcome: [
    { outcome: "succeeded", costUsd: 8, runs: 9 },
    { outcome: "failed", costUsd: 1, runs: 2 },
    { outcome: "stopped", costUsd: 0.5, runs: 1 },
  ],
  withoutOutcome: 3,
  lenses: {
    workspaces: [group("w1", "Finance", 7), group("w2", "HR", 3)],
    workflows: [group("f1", "Invoice chase", 6, { workspaceId: "w1", workspaceName: "Finance" })],
    people: [group("s1", "Priya Raman", 5)],
  },
  workspaces: [{ id: "w1", name: "Finance", costUsd: 7 }, { id: "w2", name: "HR", costUsd: 3 }],
  selected: ["w1", "w2"],
  ...over,
});
const run = (i: number): ReportRun => ({
  key: `k${i}`, workspaceId: "w1", workspaceName: "Finance", flowId: "f1", flowName: "Invoice chase", subject: "s1", person: "Priya Raman",
  purpose: "live", status: "succeeded", at: "2026-10-25T10:00:00.000Z", tokens: 100, costUsd: 0.5,
});

const FORECAST = {
  month: "2026-10", daysInMonth: 31, today: 20, soFar: 40, enough: true, completeDays: 19, basisDays: 7, avgDaily: 2, projected: 62, low: 55, high: 70,
  series: Array.from({ length: 31 }, (_, i) => ({ day: i + 1, actual: i < 20 ? (i + 1) * 2 : null, projected: i >= 19 ? 40 + (22 * (i - 19)) / 11 : null })),
};
const getReportSummary = vi.fn();
const getReportRuns = vi.fn();
const downloadReport = vi.fn();
const emailReport = vi.fn();
const getReportForecast = vi.fn();
vi.mock("@/lib/api", () => ({
  getReportSummary: (...a: unknown[]) => getReportSummary(...a),
  getReportRuns: (...a: unknown[]) => getReportRuns(...a),
  downloadReport: (...a: unknown[]) => downloadReport(...a),
  emailReport: (...a: unknown[]) => emailReport(...a),
  getReportForecast: (...a: unknown[]) => getReportForecast(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/reports", useSearchParams: () => new URLSearchParams() }));

import ReportsPage from "./page";
import { FoundryApiError } from "@/lib/foundry-client";
import { ToastProvider } from "@/lib/toast";

const renderPage = () => render(<ToastProvider><ReportsPage /></ToastProvider>);
const lastQuery = () => getReportSummary.mock.calls.at(-1)![0];

describe("Cost & usage", () => {
  beforeEach(() => {
    getReportSummary.mockReset().mockResolvedValue(summary());
    getReportRuns.mockReset().mockResolvedValue({ total: 2, rows: [run(1), run(2)] });
    downloadReport.mockReset();
    getReportForecast.mockReset().mockResolvedValue(FORECAST);
    emailReport.mockReset();
  });
  afterEach(cleanup);

  it("⚠ loads ONCE and then stays still: a fresh response object each time must not trigger another fetch", async () => {
    // The real API returns brand-new arrays on every call. A mock that hands back the SAME object hid a loop that
    // re-fetched for ever and redrew the page continuously; this one returns a fresh copy per call, like the wire does.
    getReportSummary.mockReset().mockImplementation(async () => summary());
    renderPage();
    await waitFor(() => expect(screen.getByText("Total cost")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 400));
    expect(getReportSummary).toHaveBeenCalledTimes(1);
  });

  it("shows the totals, the counts and the workspaces lens first", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Total cost")).toBeTruthy());
    expect(screen.getByText("Total cost").parentElement?.textContent).toContain("$10.00");
    expect(screen.getByRole("button", { name: "Open workspace Finance" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Workspaces/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a workspace drills into it: the trail gains a chip, the lens moves on, the query narrows", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open workspace Finance" }));
    await waitFor(() => expect(lastQuery().workspaces).toEqual(["w1"]));
    expect(screen.getByLabelText("Remove Workspace filter")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Workflows/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("a workflow opens its runs, and removing the chip widens the report again", async () => {
    getReportSummary.mockResolvedValue(summary());
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Workflows/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open workflow Invoice chase" }));
    await waitFor(() => expect(lastQuery().flowId).toBe("f1"));
    await waitFor(() => expect(getReportRuns).toHaveBeenCalled());
    expect(await screen.findByText(/Showing 2 of 2 runs/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove Workflow filter"));
    await waitFor(() => expect(lastQuery().flowId).toBeUndefined());
  });

  it("the runs lens pages: 'Load more' asks for the next slice and appends", async () => {
    getReportRuns.mockResolvedValueOnce({ total: 3, rows: [run(1), run(2)] }).mockResolvedValueOnce({ total: 3, rows: [run(3)] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /Runs/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText(/Showing 3 of 3 runs/)).toBeTruthy());
    expect(getReportRuns.mock.calls[1][1]).toMatchObject({ offset: 2 });
  });

  it("the period buttons re-ask for that many days", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(lastQuery().days).toBe(7));
  });

  it("somebody who is not an Admin gets the refusal, no figures and no way to download or email", async () => {
    getReportSummary.mockRejectedValue(new FoundryApiError("Cost reports are available to workspace Admins and super admins.", 403));
    renderPage();
    expect(await screen.findByText("Cost reports are for Admins")).toBeTruthy();
    expect(screen.queryByText("Total cost")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download report" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Email report" })).toBeNull();
  });

  it("a failed read says so and shows no figures: unreadable is never rendered as zero", async () => {
    getReportSummary.mockRejectedValue(new FoundryApiError("upstream down", 502));
    renderPage();
    expect(await screen.findByText("The report could not be read")).toBeTruthy();
    expect(screen.queryByText("$0.000")).toBeNull();
  });

  it("Download and Email are separate buttons that open different dialogs", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Download report" }));
    expect(await screen.findByRole("button", { name: "Download both (zip)" })).toBeTruthy();
    expect(screen.queryByLabelText("Send to")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Email report" }));
    expect(await screen.findByLabelText("Send to")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send email" })).toBeTruthy();
  });

  it("emailing sends the typed addresses with the on-screen scope, and a bad address blocks the button", async () => {
    emailReport.mockResolvedValue({ status: "sent", filename: "cost-report.xlsx", recipients: ["a@microland.com"] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Email report" }));
    const dialog = await screen.findByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send email" }) as HTMLButtonElement;
    await waitFor(() => expect(within(dialog).getByText(/12 runs/)).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText("Send to"), { target: { value: "not-an-address" } });
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Send to"), { target: { value: "A@Microland.com" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(emailReport).toHaveBeenCalled());
    expect(emailReport.mock.calls[0][1]).toEqual({ recipients: ["a@microland.com"], note: undefined, formats: ["pdf", "xlsx"] });
    expect(emailReport.mock.calls[0][0]).toMatchObject({ days: 30 });
  });

  it("a refusal from the server stays in the dialog in the server's own words", async () => {
    emailReport.mockRejectedValue(new FoundryApiError("Reports can only be sent to @microland.com addresses.", 422));
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Email report" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/12 runs/)).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText("Send to"), { target: { value: "x@gmail.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send email" }));
    expect(await within(dialog).findByText(/Reports can only be sent to @microland.com/)).toBeTruthy();
  });

  it("the download asks for the same selection the page is showing", async () => {
    downloadReport.mockResolvedValue({ blob: new Blob(["x"]), filename: "cost-report.xlsx" });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(lastQuery().days).toBe(7));
    fireEvent.click(screen.getByRole("button", { name: "Download report" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/12 runs/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Download both (zip)" }));
    await waitFor(() => expect(downloadReport).toHaveBeenCalled());
    // 7 days is not one of the dialog's presets, so it opens as the same period written as a range.
    const sent = downloadReport.mock.calls[0][0];
    expect(typeof sent.to).toBe("string");
    expect(sent).toHaveProperty("from");
  });

  it("the download dialog has two check boxes, Report (PDF) and Excel (raw data), and the button follows them", async () => {
    downloadReport.mockResolvedValue({ blob: new Blob(["x"]), filename: "cost-report.pdf" });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Download report" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/12 runs/)).toBeTruthy());
    const report = within(dialog).getByRole("checkbox", { name: "Report (PDF)" }) as HTMLInputElement;
    const excel = within(dialog).getByRole("checkbox", { name: "Excel (raw data)" }) as HTMLInputElement;
    expect([report.checked, excel.checked]).toEqual([true, true]);
    expect(within(dialog).getByRole("button", { name: "Download both (zip)" })).toBeTruthy();
    fireEvent.click(excel);
    fireEvent.click(within(dialog).getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(downloadReport).toHaveBeenCalled());
    expect(downloadReport.mock.calls[0][1]).toBe("pdf");
  });

  it("only Excel downloads the workbook", async () => {
    downloadReport.mockResolvedValue({ blob: new Blob(["x"]), filename: "cost-report.xlsx" });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Download report" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/12 runs/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Report (PDF)" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Download workbook" }));
    await waitFor(() => expect(downloadReport).toHaveBeenCalled());
    expect(downloadReport.mock.calls[0][1]).toBe("xlsx");
  });

  it("with neither ticked there is nothing to send, and it says so", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Finance")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Download report" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/12 runs/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Report (PDF)" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Excel (raw data)" }));
    expect(within(dialog).getByText("Choose at least one.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: /Download/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the month-end forecast beside the lens, for the current month, and says it is screen only", async () => {
    renderPage();
    const card = await screen.findByRole("region", { name: "Month-end forecast" });
    await waitFor(() => expect(within(card).getByText("$62.00")).toBeTruthy());
    expect(within(card).getByText(/Likely between \$55\.00 and \$70\.00/)).toBeTruthy();
    expect(within(card).getByText(/not in downloads/)).toBeTruthy();
    // It is asked for with the filters only: the period picker does not reach it.
    expect(getReportForecast.mock.calls[0][0]).not.toHaveProperty("days");
  });

  it("a forecast that cannot be read says so, and one with too few days says that instead of guessing", async () => {
    getReportForecast.mockReset().mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByText(/could not be worked out/)).toBeTruthy();
    cleanup();
    getReportForecast.mockReset().mockResolvedValue({ ...FORECAST, enough: false, completeDays: 2, projected: null, low: null, high: null, avgDaily: null });
    renderPage();
    expect(await screen.findByText(/Not enough days yet/)).toBeTruthy();
    expect(screen.queryByText("$62.00")).toBeNull();
  });

  it("is ONE page: there is no Advanced tab and no tab strip above the report", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Total cost")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Advanced" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Overview" })).toBeNull();
  });

  it("lays the report out as asked: cost per day first, then cost by workspace", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Total cost")).toBeTruthy());
    const day = screen.getByLabelText("Cost per day", { selector: "section" });
    const ws = screen.getByLabelText("Cost by workspace", { selector: "section" });
    const order = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order(day, ws)).toBe(true);
    expect(screen.queryByLabelText("Cost by outcome", { selector: "section" })).toBeNull();
    // The old "where the cost came from" panel is gone: its split now lives in the chart's legend.
    expect(screen.queryByText("Where the cost came from")).toBeNull();
  });

  it("has no 'Show table' toggle: the ranked bars carry the numbers", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Total cost")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /show table/i })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
