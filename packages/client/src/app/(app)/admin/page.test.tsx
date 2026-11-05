// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as api from "@/lib/api";
import AdminOverviewPage from "./page";
vi.mock("@/lib/api", () => ({
  // ⚠ Whole-module replacement — every `@/lib/api` call any component on this
  // page makes must be listed, including SignalsPanel's listSignals.
  getMe: vi.fn(),
  listWorkspaces: vi.fn(),
  listIncidents: vi.fn(),
  activeBreakGlass: vi.fn(),
  getApprovalFigures: vi.fn(),
  getBudget: vi.fn(),
  setBudget: vi.fn(),
  clearBudget: vi.fn(),
  listSignals: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));


beforeEach(() => {
  vi.mocked(api.listWorkspaces).mockResolvedValue([{ id: "ws-1", name: "HR", createdAt: null, kind: null } as never]);
  vi.mocked(api.listIncidents).mockResolvedValue([]);
  vi.mocked(api.activeBreakGlass).mockResolvedValue([]);
  vi.mocked(api.getApprovalFigures).mockResolvedValue({ pendingYourApproval: 0, inFlight: 0 });
  vi.mocked(api.getBudget).mockResolvedValue({
    workspaceId: "ws-1",
    maxConcurrentExecutions: 5,
    maxTokensPerDay: null,
    configured: false,
  });
  vi.mocked(api.listSignals).mockResolvedValue({ state: "ok", checkedAt: new Date().toISOString(), signals: [] });
});
afterEach(cleanup);

const me = (over: Partial<{ superAdmin: boolean; superAdminConfigured: boolean }>) => ({
  subject: "oid-x",
  email: "x@x.test",
  superAdmin: false,
  superAdminConfigured: true,
  ...over,
});

describe("/admin overview access — four states", () => {
  it("super admin sees the figures and signals; the budget is on each workspace's page now", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: true }));
    render(<AdminOverviewPage />);
    await waitFor(() => expect(screen.getAllByText("Open incidents").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Active break-glass").length).toBeGreaterThan(0);
    expect(screen.getByText("Pending approvals")).toBeTruthy();
    expect(screen.getByText("Deployment signals")).toBeTruthy();
    expect(screen.queryByText("Execution budget")).toBeNull(); // moved to the workspace's Limits tab (admin simplify phase 4)
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
  });

  it("non-super-admin sees restricted and no figures", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: false }));
    render(<AdminOverviewPage />);
    await waitFor(() => expect(screen.getByText(/Restricted to a super admin/)).toBeTruthy());
    expect(screen.queryAllByText("Open incidents")).toEqual([]);
    expect(screen.queryByText("Deployment signals")).toBeNull();
  });

  it("no super admin configured names variable", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: false, superAdminConfigured: false }));
    render(<AdminOverviewPage />);
    await waitFor(() => expect(screen.getByText(/SUPER_ADMIN_EMAILS/)).toBeTruthy());
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
  });

  it("a failed access check says so and renders no content", async () => {
    vi.mocked(api.getMe).mockRejectedValue(new Error("network down"));
    render(<AdminOverviewPage />);
    await waitFor(() => expect(screen.getAllByText(/could not be checked/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
    expect(screen.queryByText(/SUPER_ADMIN_EMAILS/)).toBeNull();
    expect(screen.queryAllByText("Open incidents")).toEqual([]);
  });
});
