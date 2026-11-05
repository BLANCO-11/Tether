// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const api = vi.hoisted(() => ({ myPermissions: vi.fn(), listInvitations: vi.fn(), invite: vi.fn(), removeInvitationWorkspace: vi.fn() }));
const lib = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listMembers: vi.fn(),
  grantMember: vi.fn(),
  revokeMember: vi.fn(),
  renameWorkspace: vi.fn(),
  updateWorkspaceSetup: vi.fn(),
  deleteWorkspace: vi.fn(),
  getBudget: vi.fn(),
  setBudget: vi.fn(),
  clearBudget: vi.fn(),
  listEmergencyAccess: vi.fn(),
  endEmergencyAccess: vi.fn(),
  setWorkspaceRestricted: vi.fn(),
}));
const nav = vi.hoisted(() => ({ tab: "members", replace: vi.fn(), switchWorkspace: vi.fn(), current: "ws-1" }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));
vi.mock("@/lib/api", () => lib);
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: nav.current, switchWorkspace: nav.switchWorkspace }) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "ws-1" }),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`tab=${nav.tab}`),
}));

const { default: WorkspacePage } = await import("./page");

const ws = (over = {}) => ({ id: "ws-1", name: "Finance", purpose: "Invoices and expense checks.", assistant: true, agentChanges: false, selfEnable: true, restricted: false, ...over });
const perms = (permissions: string[], platformPermissions: string[] = [], memberRole: string | null = "admin") => ({ permissions, platformPermissions, memberRole });
const ADMIN = ["members.read", "members.grant", "budget.read", "budget.write"];

beforeEach(() => {
  lib.listWorkspaces.mockResolvedValue([ws(), { id: "ws-2", name: "HR" }]);
  lib.listMembers.mockResolvedValue([{ id: "m1", subject: "oid-ada", email: "ada@x.example", role: "author", grantedBy: "t" }]);
  api.listInvitations.mockResolvedValue({
    invitations: [
      { id: "inv-1", email: "sam@x.example", workspaces: [{ workspaceId: "ws-1", workspaceName: "Finance", role: "viewer" }], expired: false, expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      { id: "inv-2", email: "zoe@x.example", workspaces: [{ workspaceId: "ws-2", workspaceName: "HR", role: "author" }], expired: false, expiresAt: new Date().toISOString() },
    ],
  });
  lib.getBudget.mockResolvedValue({ maxConcurrentExecutions: 5, maxTokensPerDay: null, configured: false });
  lib.listEmergencyAccess.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  nav.tab = "members";
  nav.current = "ws-1";
});

describe("a workspace's page", () => {
  it("is named in its title, not by the top-bar workspace", async () => {
    nav.current = "ws-2";
    api.myPermissions.mockResolvedValue(perms(ADMIN));
    render(<WorkspacePage />);
    expect(await screen.findByRole("heading", { name: "Finance" })).toBeTruthy();
    expect(api.myPermissions).toHaveBeenCalledWith("ws-1");
  });

  it("Members: its people with the role changed in place, and only ITS invitations", async () => {
    api.myPermissions.mockResolvedValue(perms(ADMIN));
    lib.grantMember.mockResolvedValue({});
    render(<WorkspacePage />);
    const role = (await screen.findByLabelText("Role of ada@x.example")) as HTMLSelectElement;
    fireEvent.change(role, { target: { value: "approver" } });
    await vi.waitFor(() => expect(lib.grantMember).toHaveBeenCalledWith("ws-1", { subject: "oid-ada", email: "ada@x.example", role: "approver" }));
    expect(await screen.findByText("sam@x.example")).toBeTruthy();
    expect(screen.queryByText("zoe@x.example")).toBeNull(); // invited to HR, not here
  });

  it("Add people invites to THIS workspace with the chosen role", async () => {
    api.myPermissions.mockResolvedValue(perms(ADMIN));
    api.invite.mockResolvedValue({ applied: false, invitation: {} });
    render(<WorkspacePage />);
    const add = await screen.findByRole("region", { name: "Add people" });
    fireEvent.change(within(add).getByLabelText("Email"), { target: { value: "kim@x.example" } });
    fireEvent.change(within(add).getByLabelText("Role"), { target: { value: "viewer" } });
    fireEvent.click(within(add).getByRole("button", { name: "Add people" }));
    await vi.waitFor(() => expect(api.invite).toHaveBeenCalledWith({ email: "kim@x.example", workspaces: [{ workspaceId: "ws-1", role: "viewer" }] }));
  });

  it("a Creator sees who is here and changes nothing", async () => {
    api.myPermissions.mockResolvedValue(perms(["members.read"], [], "author"));
    render(<WorkspacePage />);
    expect(await screen.findByText("ada@x.example")).toBeTruthy();
    expect(screen.queryByLabelText("Role of ada@x.example")).toBeNull();
    expect(screen.queryByRole("region", { name: "Add people" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("Settings: saves only what changed", async () => {
    nav.tab = "settings";
    api.myPermissions.mockResolvedValue(perms(ADMIN, ["platform.workspaces.write"]));
    lib.updateWorkspaceSetup.mockResolvedValue(undefined);
    render(<WorkspacePage />);
    fireEvent.click(await screen.findByLabelText(/Also offer Forge Agent/));
    const purpose = screen.getByRole("region", { name: "Purpose and Forge" });
    fireEvent.click(within(purpose).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(lib.updateWorkspaceSetup).toHaveBeenCalledWith("ws-1", { assistant: false }));
  });

  it("Settings: web access is on unless switched off, and switching it off saves only that", async () => {
    nav.tab = "settings";
    api.myPermissions.mockResolvedValue(perms(ADMIN, ["platform.workspaces.write"]));
    lib.updateWorkspaceSetup.mockResolvedValue(undefined);
    render(<WorkspacePage />);
    const web = (await screen.findByLabelText("Workflows and Forge may read the web")) as HTMLInputElement;
    expect(web.checked).toBe(true); // `webAccess` absent from the workspace: on
    fireEvent.click(web);
    const purpose = screen.getByRole("region", { name: "Purpose and Forge" });
    fireEvent.click(within(purpose).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(lib.updateWorkspaceSetup).toHaveBeenCalledWith("ws-1", { webAccess: false }));
  });

  it("Settings of a RESTRICTED workspace are offered only to its own admin", async () => {
    nav.tab = "settings";
    lib.listWorkspaces.mockResolvedValue([ws({ restricted: true })]);
    api.myPermissions.mockResolvedValue(perms([], ["platform.workspaces.write"], null));
    render(<WorkspacePage />);
    expect(await screen.findByRole("region", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).disabled).toBe(true);
  });

  it("Settings: deleting the workspace you are in moves you to another one", async () => {
    nav.tab = "settings";
    api.myPermissions.mockResolvedValue(perms(ADMIN, ["platform.workspaces.write"]));
    lib.deleteWorkspace.mockResolvedValue(undefined);
    render(<WorkspacePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete workspace" }));
    await vi.waitFor(() => expect(lib.deleteWorkspace).toHaveBeenCalledWith("ws-1"));
    await vi.waitFor(() => expect(nav.switchWorkspace).toHaveBeenCalledWith("ws-2"));
    expect(nav.replace).toHaveBeenCalledWith("/organization");
  });

  it("Limits: the budget lives here", async () => {
    nav.tab = "limits";
    api.myPermissions.mockResolvedValue(perms(ADMIN));
    render(<WorkspacePage />);
    expect(((await screen.findByLabelText("Runs at once")) as HTMLInputElement).value).toBe("5");
  });
});
