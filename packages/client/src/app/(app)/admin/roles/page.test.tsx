// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The four built-in roles as the server sends them (a fixture: the web image has no server source; the rows are
// checked against the real presets in packages/server/src/auth/role-matrix.test.ts).
const VIEWER = ["bootstrap.read", "flows.read", "members.read", "runs.read", "search.read"];
const AUTHOR = [...VIEWER, "approvals.read", "approvals.decide", "datasources.write", "datasources.query.write", "flows.run", "flows.write", "plugins.read"];
const APPROVER = [...AUTHOR, "flows.approve", "flows.arm", "runs.replay"];
const ADMIN = [...APPROVER, "plugins.enable", "members.grant", "content.read.others", "reports.read", "secrets.write", "tools.write", "budget.write", "audit.read"];
const ROLE_PRESETS: Record<string, string[]> = { viewer: VIEWER, author: AUTHOR, approver: APPROVER, admin: ADMIN };

const lib = vi.hoisted(() => ({ listWorkspaces: vi.fn(), listWorkspaceRoles: vi.fn() }));
const nav = vi.hoisted(() => ({ search: new URLSearchParams(), replace: vi.fn() }));
vi.mock("@/lib/api", () => lib);
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: nav.replace }), useSearchParams: () => nav.search }));
const platform = vi.hoisted(() => ({ denied: false }));
vi.mock("@/components/access/Can", () => ({
  useCanPlatform: () => ({ denied: platform.denied, allowed: !platform.denied, unreadable: false }),
}));
vi.mock("@/components/access/PlatformRoleList", () => ({ PlatformRoleList: () => <p>platform roles</p> }));
vi.mock("@/components/access/IndividualPermissions", () => ({
  IndividualPermissions: ({ workspaceId }: { workspaceId: string }) => <p>individual permissions in {workspaceId}</p>,
}));
vi.mock("@/components/access/WorkspaceRolesPanel", () => ({
  WorkspaceRolesPanel: ({ workspaceId }: { workspaceId: string }) => <p>custom roles in {workspaceId}</p>,
}));

const { default: RolesPage } = await import("./page");

const builtins = (over: Partial<Record<string, readonly string[]>> = {}) =>
  (["viewer", "author", "approver", "admin"] as const).map((name) => ({
    id: null, name, description: null, builtin: true, retiredAt: null, assignees: 0,
    permissions: over[name] ?? ROLE_PRESETS[name],
  }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  nav.search = new URLSearchParams();
  platform.denied = false;
});

const cell = (role: string, row: string) => {
  const tr = screen.getByText(row).closest("tr")!;
  return [...tr.querySelectorAll("td")].find((td) => td.getAttribute("aria-label")?.startsWith(`${role}:`))!.getAttribute("aria-label");
};

describe("what each role can do", () => {
  it("ticks each row from the permissions the server says each role holds", async () => {
    lib.listWorkspaces.mockResolvedValue([{ id: "fin", name: "Finance" }]);
    lib.listWorkspaceRoles.mockResolvedValue(builtins());
    render(<RolesPage />);
    await screen.findByText("See who is in the workspace");
    expect(cell("Observer", "Build and test their own workflows")).toBe("Observer: No");
    expect(cell("Creator", "Connect their own account to a service and switch on actions for themselves")).toBe("Creator: Yes");
    expect(screen.getByText("Unless an Admin has turned personal use off for that service.")).toBeTruthy();
    expect(cell("Creator", "Connect a service for the whole workspace and choose its actions")).toBe("Creator: No");
    expect(cell("Admin", "Connect a service for the whole workspace and choose its actions")).toBe("Admin: Yes");
  });

  it("follows the server, not a copy: a role the server answers differently reads differently, and a part is 'Partly'", async () => {
    lib.listWorkspaces.mockResolvedValue([{ id: "fin", name: "Finance" }]);
    lib.listWorkspaceRoles.mockResolvedValue(
      builtins({ author: ROLE_PRESETS.author.filter((p: string) => p !== "plugins.read" && p !== "flows.run") }),
    );
    render(<RolesPage />);
    await screen.findByText("See who is in the workspace");
    expect(cell("Creator", "Connect their own account to a service and switch on actions for themselves")).toBe("Creator: No");
    expect(cell("Creator", "Build and test their own workflows")).toBe("Creator: Partly");
  });

  it("an unreadable list says so in one line", async () => {
    lib.listWorkspaces.mockResolvedValue([{ id: "fin", name: "Finance" }]);
    lib.listWorkspaceRoles.mockRejectedValue(new Error("boom"));
    render(<RolesPage />);
    expect(await screen.findByText(/The roles could not be read/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("custom roles are under Advanced, for the workspace named in the URL", async () => {
    nav.search = new URLSearchParams("workspace=hr");
    lib.listWorkspaces.mockResolvedValue([{ id: "fin", name: "Finance" }, { id: "hr", name: "HR" }]);
    lib.listWorkspaceRoles.mockResolvedValue(builtins());
    render(<RolesPage />);
    expect(await screen.findByText("custom roles in hr")).toBeTruthy();
    expect(lib.listWorkspaceRoles).toHaveBeenCalledWith("hr");
    expect(screen.getByText("individual permissions in hr")).toBeTruthy();
    expect(screen.getByText("Advanced: custom roles and individual permissions")).toBeTruthy();
  });

  it("platform roles are listed for a reader of the people list, and not otherwise", async () => {
    lib.listWorkspaces.mockResolvedValue([{ id: "fin", name: "Finance" }]);
    lib.listWorkspaceRoles.mockResolvedValue(builtins());
    render(<RolesPage />);
    expect(await screen.findByText("platform roles")).toBeTruthy();
    cleanup();
    platform.denied = true;
    render(<RolesPage />);
    await screen.findByText("See who is in the workspace");
    expect(screen.queryByText("platform roles")).toBeNull();
  });
});
