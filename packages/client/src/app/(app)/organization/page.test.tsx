// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrganizationPage from "./page";
import { SEEN_USERS_TITLE } from "@/lib/workspace-access-copy";

/**
 * Manage Workspaces is super-admin-only, and this asserts the FOUR states.
 *
 * ⚠ **The gate here is not the control** — every route this page calls refuses a
 * non-super-admin server-side. What is being tested is that a person gets one
 * honest sentence instead of a page whose every button 403s, and that the four
 * answers stay four:
 *
 *   1. super admin  → the real page
 *   2. signed in, not one  → ask whoever administers it
 *   3. nobody configured  → set SUPER_ADMIN_EMAILS (a different fix)
 *   4. `/api/me` failed  → we could not check (NEITHER of the above)
 *
 * State 4 is the one that would be got wrong, and it is the same rule
 * `PromptBoundaryWarnings` follows: unreadable renders as unreadable.
 */

vi.mock("@/lib/api", () => ({
  getMe: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspaceSetup: vi.fn(),
  renameWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  // Restricted workspaces (phase 4): the closed list, the switch, and emergency access.
  listClosedWorkspaces: vi.fn(async () => []),
  startEmergencyAccess: vi.fn(),
  setWorkspaceRestricted: vi.fn(),
  listEmergencyAccess: vi.fn(async () => []),
  endEmergencyAccess: vi.fn(),
  listMembers: vi.fn(),
  grantMember: vi.fn(),
  revokeMember: vi.fn(),
  listPlatformUsers: vi.fn(),
  // ⚠ `vi.mock` is a WHOLE-MODULE replacement, so every `@/lib/api` call any
  // component on this page makes must be listed. An omitted one comes back
  // `undefined`, `useAsync` invokes it, and the page crashes in every test
  // here. Added with `LocalAccountsPanel` — the third time this exact trap has
  // bitten in one day.
  listLocalUsers: vi.fn(),
  createLocalUser: vi.fn(),
  setLocalUserPassword: vi.fn(),
  setLocalUserActive: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/organization" }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));

const api = await import("@/lib/api");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listWorkspaces).mockResolvedValue([
    { id: "ws-1", name: "HR", createdAt: null, kind: null } as never,
  ]);
  vi.mocked(api.listMembers).mockResolvedValue([]);
  vi.mocked(api.listPlatformUsers).mockResolvedValue({ users: [], caveat: "c" });
  vi.mocked(api.listLocalUsers).mockResolvedValue([]);
});
afterEach(cleanup);

const me = (over: Partial<{ superAdmin: boolean; superAdminConfigured: boolean }>) => ({
  subject: "oid-x",
  email: "x@x.test",
  superAdmin: false,
  superAdminConfigured: true,
  ...over,
});

describe("Manage Workspaces access", () => {
  it("a super admin gets the real page", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: true }));
    render(<OrganizationPage />);
    // The workspace list is the page's own content; a refusal renders none of it.
    // `getAllBy`: the name is also the badge on the members and people panes.
    await waitFor(() => expect(screen.getAllByText("HR").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
  });

  it("a non-super-admin gets the workspaces they are in, each linking to its page, and no New workspace", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: false }));
    render(<OrganizationPage />);
    const link = await screen.findByRole("link", { name: "HR" });
    expect(link.getAttribute("href")).toBe("/admin/workspaces/ws-1");
    expect(screen.queryByRole("button", { name: /New workspace/ })).toBeNull();
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
  });

  it("a signed-in non-super-admin in no workspace is told to ask, and sees no workspace actions", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: false }));
    vi.mocked(api.listWorkspaces).mockResolvedValue([]);
    render(<OrganizationPage />);
    await waitFor(() => expect(screen.getByText(/Restricted to a super admin/)).toBeTruthy());
    // ⚠ No New workspace button, no members pane — offering controls that all
    // 403 is worse than the sentence.
    expect(screen.queryByRole("button", { name: /New workspace/ })).toBeNull();
    expect(screen.queryByText("Members")).toBeNull();
  });

  it("⚠ when NO super admin is configured, it names the variable instead", async () => {
    // A different problem with a different fix. This is the cost of removing the
    // self-claim path, and it must not read as a permission problem.
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: false, superAdminConfigured: false }));
    render(<OrganizationPage />);
    await waitFor(() => expect(screen.getByText(/SUPER_ADMIN_EMAILS/)).toBeTruthy());
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
  });

  it("⚠ a FAILED access check says so — it is not read as either answer", async () => {
    vi.mocked(api.getMe).mockRejectedValue(new Error("network down"));
    render(<OrganizationPage />);
    // `getAllBy`: the Notice puts it in its title and its body.
    await waitFor(() => expect(screen.getAllByText(/could not be checked/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Restricted to a super admin/)).toBeNull();
    expect(screen.queryByText(/SUPER_ADMIN_EMAILS/)).toBeNull();
    // And it does not silently render the page either.
    expect(screen.queryAllByText("HR")).toEqual([]);
  });
});

/**
 * ⚠ **THE "DOORS" BLOCK WAS HERE AND IS REPLACED BY ITS OPPOSITE.**
 *
 * It asserted that `/organization` linked to the roles and platform-roles pages, and it
 * was written for a real reason: the platform tier shipped seeded, enforced and measured
 * — and unreachable, because nothing linked to it and nothing called its four client
 * methods. *A page with no door is a page the product does not have.*
 *
 * Since admin simplify (2026-10-30) custom roles are under Advanced on `/admin/roles`, and platform roles are
 * listed there and given on a person's page. So the door is still there; it is somewhere else, and the Roles page's
 * own test holds it open. What this block asserts now is that the DUPLICATES are gone from here —
 * two places to manage the same thing is two places to look for the one that is already
 * correct.
 */
describe("a workspace card says what the workspace holds", () => {
  beforeEach(() => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: true, superAdminConfigured: true }));
  });

  it("shows its counts and live workflows, and asks the server for them", async () => {
    vi.mocked(api.listWorkspaces).mockResolvedValue([
      { id: "ws-1", name: "HR", kind: null, counts: { workflows: 4, live: 1, datasources: 2, members: 3, lastRunAt: null } } as never,
    ]);
    render(<OrganizationPage />);
    expect(await screen.findByText("1 live")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(vi.mocked(api.listWorkspaces)).toHaveBeenCalledWith({ counts: true });
  });

  it("an absent count reads as unknown, never as zero", async () => {
    render(<OrganizationPage />);
    await screen.findByRole("heading", { name: "Workspaces" });
    await waitFor(() => expect(screen.getAllByText("—").length).toBe(3));
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("the page is about workspaces, and nothing else", () => {
  beforeEach(() => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: true, superAdminConfigured: true }));
  });

  it("CONTROL: the workspace surface itself is still here", async () => {
    // Without this, a page that rendered nothing at all would pass every assertion
    // below — the I-38 shape, and the one that matters most when the subject is a
    // deletion.
    render(<OrganizationPage />);
    expect(await screen.findByRole("heading", { name: "Workspaces" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New workspace/ })).toBeTruthy();
  });

  it("has no members panel and no signed-in panel", async () => {
    render(<OrganizationPage />);
    await screen.findByRole("heading", { name: "Workspaces" });
    // A card's "Members" button links to People & access; what must be gone is a members PANEL here.
    expect(screen.queryByRole("heading", { name: /Members/ })).toBeNull();
    expect(screen.queryByText(SEEN_USERS_TITLE)).toBeNull();
  });

  it("has no role links — they are on /admin/roles now", async () => {
    render(<OrganizationPage />);
    await screen.findByRole("heading", { name: "Workspaces" });
    expect(screen.queryByText("Roles and permissions")).toBeNull();
    expect(screen.queryByText("Platform roles")).toBeNull();
  });
});

describe("a workspace's purpose and what Forge does in it", () => {
  beforeEach(() => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: true, superAdminConfigured: true }));
  });

  it("a new workspace needs a purpose, and everyday tasks are off unless allowed", async () => {
    vi.mocked(api.createWorkspace).mockResolvedValue({ id: "ws-2", name: "Finance" } as never);
    render(<OrganizationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /New workspace/ }));
    fireEvent.change(screen.getByLabelText("New workspace name"), { target: { value: "Finance" } });
    const create = screen.getByRole("button", { name: /Create workspace/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Workspace purpose"), { target: { value: "Invoice chasing and month-end checks." } });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/Also offer Forge Agent/));
    fireEvent.click(create);
    await waitFor(() =>
      expect(vi.mocked(api.createWorkspace)).toHaveBeenCalledWith({ name: "Finance", purpose: "Invoice chasing and month-end checks.", assistant: true, restricted: false }),
    );
  });

  it("a workspace allowing everyday tasks says so, and its card opens its own page (settings live there now)", async () => {
    vi.mocked(api.listWorkspaces).mockResolvedValue([
      { id: "ws-1", name: "HR", kind: null, purpose: "Attendance and leave for HR.", assistant: true } as never,
    ]);
    render(<OrganizationPage />);
    expect(await screen.findByText("Forge Agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: "HR" }).getAttribute("href")).toBe("/admin/workspaces/ws-1");
    // Rename, purpose and delete are on the workspace's Settings tab: one place for each (admin simplify phase 4).
    expect(screen.queryByRole("button", { name: /More actions/i })).toBeNull();
  });
});

describe("restricted workspaces (phase 4)", () => {
  beforeEach(() => {
    vi.mocked(api.getMe).mockResolvedValue(me({ superAdmin: true, superAdminConfigured: true }));
    vi.mocked(api.listWorkspaces).mockResolvedValue([
      { id: "ws-1", name: "HR", kind: null, purpose: "Attendance and leave for HR.", restricted: true } as never,
    ]);
    vi.mocked(api.listClosedWorkspaces).mockResolvedValue([]);
  });

  it("a new workspace can be created restricted", async () => {
    vi.mocked(api.createWorkspace).mockResolvedValue({ id: "ws-2", name: "Payroll" } as never);
    render(<OrganizationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /New workspace/ }));
    fireEvent.change(screen.getByLabelText("New workspace name"), { target: { value: "Payroll" } });
    fireEvent.change(screen.getByLabelText("Workspace purpose"), { target: { value: "Payroll runs and approvals." } });
    fireEvent.click(screen.getByLabelText("Restricted"));
    fireEvent.click(screen.getByRole("button", { name: /Create workspace/ }));
    await waitFor(() =>
      expect(vi.mocked(api.createWorkspace)).toHaveBeenCalledWith({ name: "Payroll", purpose: "Payroll runs and approvals.", assistant: false, restricted: true }),
    );
  });

  it("a restricted workspace you are in carries the badge", async () => {
    render(<OrganizationPage />);
    const card = (await screen.findByText("HR")).closest("li")!;
    expect(card.textContent).toContain("Restricted");
  });

  it("one you are not in shows its name and admins, and emergency access needs a real reason", async () => {
    vi.mocked(api.listClosedWorkspaces).mockResolvedValue([{ id: "ws-9", name: "Board", admins: ["ada@acme.example"] }]);
    vi.mocked(api.startEmergencyAccess).mockResolvedValue({ notified: "emailed 1 admin", expiresAt: new Date(Date.now() + 7_200_000).toISOString() });
    render(<OrganizationPage />);
    const section = await screen.findByRole("region", { name: "Restricted workspaces you are not in" });
    expect(section.textContent).toContain("Board");
    expect(section.textContent).toContain("ada@acme.example");
    fireEvent.click(screen.getByRole("button", { name: "Emergency access" }));
    const go = screen.getByRole("button", { name: "Get in" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "need in" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Payroll run failing, admins unreachable" } });
    fireEvent.change(screen.getByLabelText("For how long"), { target: { value: "2" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() =>
      expect(vi.mocked(api.startEmergencyAccess)).toHaveBeenCalledWith({ workspaceId: "ws-9", reason: "Payroll run failing, admins unreachable", hours: 2 }),
    );
  });

  it("an unreadable restricted list says the check did not run — it is not read as none", async () => {
    vi.mocked(api.listClosedWorkspaces).mockRejectedValue(new Error("boom"));
    render(<OrganizationPage />);
    expect(await screen.findByText(/Restricted workspaces could not be checked/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Restricted workspaces you are not in" })).toBeNull();
  });
});
