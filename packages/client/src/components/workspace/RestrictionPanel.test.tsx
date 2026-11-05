// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  listEmergencyAccess: vi.fn(),
  endEmergencyAccess: vi.fn(),
  setWorkspaceRestricted: vi.fn(),
}));
const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));

import * as api from "@/lib/api";
import { RestrictionPanel } from "./RestrictionPanel";

/**
 * Restricted workspaces, phase 4: the panel a workspace's own people see. Each state: restricted or not, may change
 * it or not, an open emergency access (a banner with "End it now"), earlier ones, and an UNREADABLE list — which says
 * the check did not run rather than reading as "nobody has come in".
 */
const access = (over: Record<string, unknown> = {}) => ({
  id: "ea-1",
  workspaceId: "ws-1",
  subject: "oid-sam",
  email: "sam@acme.example",
  reason: "Payroll run failing, admins unreachable",
  startedAt: new Date(Date.now() - 600_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_000_000).toISOString(),
  endedAt: null,
  endedBy: null,
  open: true,
  ...over,
});

const panel = (props: Partial<Parameters<typeof RestrictionPanel>[0]> = {}) =>
  render(<RestrictionPanel workspaceId="ws-1" workspaceName="Payroll" restricted canChange onChanged={() => {}} {...props} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listEmergencyAccess).mockResolvedValue([]);
  toast.mockReset();
});
afterEach(cleanup);

describe("the restriction panel", () => {
  it("restricted, for its admin: says so and offers to open it up", async () => {
    panel();
    expect(await screen.findByText("Restricted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open it up" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open it up" }).at(-1)!);
    await waitFor(() => expect(vi.mocked(api.setWorkspaceRestricted)).toHaveBeenCalledWith("ws-1", false));
  });

  it("open, for its admin: offers to restrict it, behind a confirmation", async () => {
    panel({ restricted: false });
    fireEvent.click(await screen.findByRole("button", { name: "Restrict this workspace" }));
    expect(vi.mocked(api.setWorkspaceRestricted)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restrict it" }));
    await waitFor(() => expect(vi.mocked(api.setWorkspaceRestricted)).toHaveBeenCalledWith("ws-1", true));
  });

  it("someone who may not change it gets no switch", async () => {
    panel({ canChange: false });
    await screen.findByText("Restricted");
    expect(screen.queryByRole("button", { name: /Open it up|Restrict this workspace/ })).toBeNull();
  });

  it("an open emergency access is a banner naming who and why, and can be ended", async () => {
    vi.mocked(api.listEmergencyAccess).mockResolvedValue([access()] as never);
    panel();
    expect(await screen.findByText(/sam@acme.example has emergency access until/)).toBeTruthy();
    expect(screen.getByText(/Payroll run failing, admins unreachable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End it now" }));
    await waitFor(() => expect(vi.mocked(api.endEmergencyAccess)).toHaveBeenCalledWith("ws-1", "ea-1"));
  });

  it("an ended one is listed as earlier, with no banner", async () => {
    vi.mocked(api.listEmergencyAccess).mockResolvedValue([access({ open: false, endedAt: new Date().toISOString(), endedBy: "ada@acme.example" })] as never);
    panel();
    expect(await screen.findByText(/ended by ada@acme.example/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End it now" })).toBeNull();
  });

  it("⚠ an unreadable list says the check did not run", async () => {
    vi.mocked(api.listEmergencyAccess).mockRejectedValue(new Error("boom"));
    panel();
    expect(await screen.findByText(/Emergency access could not be checked/)).toBeTruthy();
  });
});
