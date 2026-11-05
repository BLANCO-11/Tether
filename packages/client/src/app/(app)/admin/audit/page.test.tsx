// @vitest-environment jsdom
// S-68 Audit explorer — tabs, filters via URL, table columns, empty states, disclosure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FDAuditEvent } from "@/lib/audit";
import { AUDIT_FIXTURE } from "@/lib/audit";

const listAuditEvents = vi.fn(async (_ws: string): Promise<FDAuditEvent[]> => []);
const getMe = vi.fn(async () => ({ subject: "oid-x", email: "x@x.test", superAdmin: true, superAdminConfigured: true }));
const listWorkspaces = vi.fn(async () => [{ id: "ws-1", name: "HR", createdAt: null, kind: null } as never]);
const listMembers = vi.fn(async () => []);
const listPlatformUsers = vi.fn(async () => ({ users: [], caveat: "c" }));

/**
 * The server, faked: `listAuditEvents` supplies the record, and this filters and pages it exactly as
 * `auditService.list` does (search over actor/operation/entity/description/where/id, an inclusive date range,
 * newest first is the fixture's order). The page now asks the server for one page; the tests keep reading as before.
 */
async function fakeAuditServer(ws: string, p: { q?: string; from?: string; to?: string; limit?: number; offset?: number }) {
  const all = await listAuditEvents(ws);
  const qq = (p.q ?? "").trim().toLowerCase();
  const fromTs = p.from ? new Date(p.from).getTime() : null;
  const toEnd = p.to ? new Date(p.to).getTime() + 24 * 60 * 60 * 1000 - 1 : null;
  const matched = all.filter((e) => {
    if (qq && ![e.actor, e.operation, e.description, e.where, e.id, e.entity].join(" ").toLowerCase().includes(qq)) return false;
    const t = new Date(e.time).getTime();
    if (fromTs !== null && t < fromTs) return false;
    if (toEnd !== null && t > toEnd) return false;
    return true;
  });
  const events = p.limit === undefined ? matched : matched.slice(p.offset ?? 0, (p.offset ?? 0) + p.limit);
  return { events, total: matched.length };
}

vi.mock("@/lib/api", () => ({
  getMe: () => getMe(),
  listWorkspaces: () => listWorkspaces(),
  listAuditPage: (ws: string, p: Parameters<typeof fakeAuditServer>[1]) => fakeAuditServer(ws, p),
  listMembers: () => listMembers(),
  listPlatformUsers: () => listPlatformUsers(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));

let currentSearch = "";
let currentPath = "/admin/audit";
const push = vi.fn();
const replace = vi.fn((url: string) => {
  const [p, qs] = url.split("?");
  currentPath = p;
  currentSearch = qs ?? "";
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
  useRouter: () => ({ push, replace }),
  usePathname: () => currentPath,
}));

import AuditPage from "./page";

function event(over: Partial<FDAuditEvent> = {}): FDAuditEvent {
  return {
    id: "evt-1",
    time: "2026-08-11T15:02:00.000Z",
    actor: "Devika Menon",
    operation: "update",
    entity: "workflow",
    description: "Changed how step 2 handles a failure on Monthly back-to-office compliance",
    where: "Monthly back-to-office compliance · v4 draft",
    ...over,
  } as FDAuditEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = "";
  currentPath = "/admin/audit";
  getMe.mockResolvedValue({ subject: "oid-x", email: "x@x.test", superAdmin: true, superAdminConfigured: true } as never);
  listWorkspaces.mockResolvedValue([{ id: "ws-1", name: "HR", createdAt: null, kind: null } as never]);
  listAuditEvents.mockResolvedValue([]);
});
afterEach(cleanup);

describe("S-68 · copy verbatim", () => {
  it("header title, subtitle and Download", async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    expect(screen.getByText("Every decision, run and credential change — who did it, and when.")).toBeTruthy();
    expect(screen.getByText("Download CSV")).toBeTruthy();
  });

  it("tabs Plain English and Raw events", async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Plain English" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Raw events" })).toBeTruthy();
  });

  it("perturbation: missing Download turns this red", async () => {
    const { container } = render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    expect(container.textContent).toContain("Download");
  });

  it("search placeholder verbatim", async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    expect(screen.getByPlaceholderText("Search actor, action or exact event id")).toBeTruthy();
    expect(screen.getByLabelText("Search actor, action or exact event id")).toBeTruthy();
  });

  it("two native date inputs", async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    expect(screen.getByLabelText("Start date").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("End date").getAttribute("type")).toBe("date");
  });
});

describe("S-68 · plain table columns (WHEN WHO WHAT HAPPENED WHERE + Raw)", () => {
  it("plain headers verbatim", async () => {
    listAuditEvents.mockResolvedValue([event()]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByTestId("audit-row")).toBeTruthy());
    expect(screen.getByText("When")).toBeTruthy();
    expect(screen.getByText("Who")).toBeTruthy();
    expect(screen.getByText("What happened")).toBeTruthy();
    expect(screen.getByText("Where")).toBeTruthy();
  });

  it("System appears as WHO with no distinction", async () => {
    listAuditEvents.mockResolvedValue([
      event({ id: "sys-1", actor: "System", description: "Contractor timesheet chase failed at step 4", where: "Contractor timesheet chase · RUN-2026-08-08-0714" }),
    ]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText("System")).toBeTruthy());
    // WHO column same treatment as person — no separate styling guard needed, just that it renders
    expect(screen.getByText("Contractor timesheet chase failed at step 4")).toBeTruthy();
  });

  it("every row carries a Raw disclosure button", async () => {
    listAuditEvents.mockResolvedValue([event({ id: "a" }), event({ id: "b" })]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(2));
    expect(screen.getByLabelText("Raw event a")).toBeTruthy();
    expect(screen.getByLabelText("Raw event b")).toBeTruthy();
  });

  it("Raw disclosure expands inline", async () => {
    listAuditEvents.mockResolvedValue([event({ id: "evt-001" })]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByLabelText("Raw event evt-001")).toBeTruthy());
    expect(screen.queryByTestId("audit-raw-detail")).toBeNull();
    fireEvent.click(screen.getByLabelText("Raw event evt-001"));
    await waitFor(() => expect(screen.getByTestId("audit-raw-detail")).toBeTruthy());
    expect(screen.getByTestId("audit-raw-detail").textContent).toContain("evt-001");
  });

  it("WHEN is mono and formatted 11 Aug, 15:02", async () => {
    listAuditEvents.mockResolvedValue([event({ time: "2026-08-11T15:02:00.000Z" })]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByTestId("audit-row")).toBeTruthy());
    // formatWhen produces "11 Aug, 15:02" (locale en-GB) — check prefix
    expect(screen.getByText(/11 Aug/)).toBeTruthy();
  });
});

describe("S-68 · raw events tab columns", () => {
  it("raw headers Event ID · Time · Actor · Operation · Entity · Description", async () => {
    listAuditEvents.mockResolvedValue([event()]);
    currentSearch = "view=raw";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByTestId("audit-raw-row")).toBeTruthy());
    expect(screen.getByText("Event ID")).toBeTruthy();
    expect(screen.getByText("Time")).toBeTruthy();
    expect(screen.getByText("Actor")).toBeTruthy();
    expect(screen.getByText("Operation")).toBeTruthy();
    expect(screen.getByText("Entity")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
  });

  it("raw tab reachable via ?view=raw", async () => {
    listAuditEvents.mockResolvedValue([event()]);
    currentSearch = "view=raw";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Raw events" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tab", { name: "Plain English" }).getAttribute("aria-selected")).toBe("false");
  });
});

describe("S-68 · filters via URL (?q, ?from, ?to, ?view)", () => {
  it("search via ?q filters actor/action/id", async () => {
    listAuditEvents.mockResolvedValue(AUDIT_FIXTURE as unknown as FDAuditEvent[]);
    currentSearch = "q=Devika";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBeGreaterThan(0));
    // All visible rows should be Devika
    for (const row of screen.getAllByTestId("audit-row")) {
      expect(row.textContent).toContain("Devika");
    }
    expect(screen.queryByText("Meera Iyer")).toBeNull();
  });

  it("typing search writes ?q via replace", async () => {
    listAuditEvents.mockResolvedValue([]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search actor, action or exact event id"), { target: { value: "Meera" } });
    // Once typing pauses — the server is not asked once per keystroke.
    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringContaining("q=Meera")));
    expect(push).not.toHaveBeenCalled();
  });

  it("date filter via ?from excludes earlier rows", async () => {
    listAuditEvents.mockResolvedValue(AUDIT_FIXTURE as unknown as FDAuditEvent[]);
    currentSearch = "from=2026-08-10";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBeGreaterThan(0));
    // 2 Aug row should be excluded
    expect(screen.queryByText(/Granted Christopher/)).toBeNull();
    // 11 Aug rows should remain
    expect(screen.getByText(/Changed how step 2/)).toBeTruthy();
  });

  it("view tab writes ?view=raw via replace and plain deletes it", async () => {
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Raw events" }));
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("view=raw"));
    replace.mockClear();
    currentSearch = "view=raw";
    cleanup();
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Raw events" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Plain English" }));
    expect(replace).toHaveBeenCalledWith("/admin/audit");
  });

  it("unrecognised ?view falls back to Plain English", async () => {
    listAuditEvents.mockResolvedValue([event()]);
    currentSearch = "view=bogus";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Plain English" }).getAttribute("aria-selected")).toBe("true"));
  });
});

describe("S-68 · empty states are different screens", () => {
  it("genuinely empty record shows No audit events yet", async () => {
    listAuditEvents.mockResolvedValue([]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText("No audit events yet.")).toBeTruthy());
    expect(screen.queryByText("No events match these filters.")).toBeNull();
  });

  it("filtered-empty shows two-sentence copy and Clear filters", async () => {
    listAuditEvents.mockResolvedValue([event()]);
    currentSearch = "q=no-such-thing-xyz";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText("No events match these filters.")).toBeTruthy());
    // ⚠ A claim, so it is checked: it appears once the unfiltered record has answered that it holds something.
    await waitFor(() =>
      expect(screen.getByText("The record itself is not empty — the current search and date range exclude everything in it.")).toBeTruthy(),
    );
    expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("No audit events yet.")).toBeNull();
  });

  it("perturbation: filtered-empty must not appear when truly empty", async () => {
    listAuditEvents.mockResolvedValue([]);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText("No audit events yet.")).toBeTruthy());
    expect(screen.queryByText("The record itself is not empty")).toBeNull();
  });

  it("Clear filters resets q/from/to via replace", async () => {
    listAuditEvents.mockResolvedValue([event()]);
    currentSearch = "q=zzz&from=2026-08-01&to=2026-08-02";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText("No events match these filters.")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(replace).toHaveBeenCalledWith("/admin/audit");
  });
});

describe("S-68 · access — four states (same as /admin/members)", () => {
  it("non-super-admin sees restricted", async () => {
    getMe.mockResolvedValue({ subject: "oid-x", email: "x@x.test", superAdmin: false, superAdminConfigured: true } as never);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText(/Restricted to a super admin/)).toBeTruthy());
  });

  it("no super admin configured names variable", async () => {
    getMe.mockResolvedValue({ subject: "oid-x", email: "x@x.test", superAdmin: false, superAdminConfigured: false } as never);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText(/SUPER_ADMIN_EMAILS/)).toBeTruthy());
  });

  it("failed check says could not be checked", async () => {
    getMe.mockRejectedValue(new Error("network down"));
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByText(/could not be checked/).length).toBeGreaterThan(0));
  });
});

describe("paging — the server sends one page at a time", () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    event({ id: `e-${i}`, description: `Event number ${i}`, time: new Date(Date.UTC(2026, 7, 11, 0, 120 - i)).toISOString() }),
  );

  it("shows the first 50 and says how many there are", async () => {
    listAuditEvents.mockResolvedValue(many);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(50));
    expect(screen.getByText("Showing 1–50 of 120")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Next writes the page into the URL", async () => {
    listAuditEvents.mockResolvedValue(many);
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(replace).toHaveBeenCalledWith("/admin/audit?page=2");
  });

  it("the last page holds the rest, and Next is off", async () => {
    listAuditEvents.mockResolvedValue(many);
    currentSearch = "page=3";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(20));
    expect(screen.getByText("Showing 101–120 of 120")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("changing a filter returns to page 1", async () => {
    listAuditEvents.mockResolvedValue(many);
    currentSearch = "page=2";
    render(<AuditPage />);
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(50));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-08-01" } });
    expect(replace).toHaveBeenCalledWith("/admin/audit?from=2026-08-01");
  });
});

