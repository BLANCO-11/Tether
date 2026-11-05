// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const api = vi.hoisted(() => ({ getPeople: vi.fn(), revokeInvitation: vi.fn(), invite: vi.fn(), assignPlatformRole: vi.fn() }));
const lib = vi.hoisted(() => ({ createLocalUser: vi.fn(), grantLocalUserAccess: vi.fn() }));
const can = vi.hoisted(() => ({ state: "allowed" as "allowed" | "denied" | "unreadable" }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));
vi.mock("@/lib/api", () => lib);
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/access/Can", () => ({
  useCanPlatform: () => ({ state: can.state, allowed: can.state === "allowed", denied: can.state === "denied", unreadable: can.state === "unreadable" }),
}));

const { default: PeoplePage } = await import("./page");

const view = (over: Record<string, unknown> = {}) => ({
  people: [
    {
      subject: "oid-priya-123",
      email: "priya@x.example",
      name: "Priya Shah",
      signIn: "microsoft",
      lastSeenAt: new Date().toISOString(),
      superAdmin: false,
      platformRoles: [],
      workspaces: [
        { id: "fin", name: "Finance", role: "admin", reach: "everything", via: ["Admin"] },
        { id: "hr", name: "HR", role: "author", reach: "own", via: ["Creator"] },
      ],
      localAccount: null,
    },
    {
      subject: "local:9f2c",
      email: "",
      name: "ravi",
      signIn: "local",
      lastSeenAt: null,
      superAdmin: false,
      platformRoles: [],
      workspaces: [{ id: "fin", name: "Finance", role: "viewer", reach: "published", via: ["Observer"] }],
      localAccount: { id: "9f2c", username: "ravi", active: true },
    },
  ],
  invitations: [
    {
      id: "inv-1",
      email: "sam@x.example",
      workspaces: [{ workspaceId: "fin", workspaceName: "Finance", role: "author" }],
      platformRole: null,
      invitedBy: "priya@x.example",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 28.5 * 86_400_000).toISOString(),
      expired: false,
    },
  ],
  workspaces: [
    { id: "fin", name: "Finance", canAddPeople: true },
    { id: "hr", name: "HR", canAddPeople: false },
  ],
  closedWorkspaces: [],
  platformRoles: [{ key: "auditor", name: "Auditor" }],
  can: { givePlatformRoles: false, createLocalAccounts: true },
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  can.state = "allowed";
});

describe("People", () => {
  it("one row per person, each workspace with the role in words, and the invited below", async () => {
    api.getPeople.mockResolvedValue(view());
    render(<PeoplePage />);
    const priya = (await screen.findByText("Priya Shah")).closest("tr")!;
    expect(priya.textContent).toContain("Finance·Admin");
    expect(priya.textContent).toContain("HR·Creator");
    expect(screen.getByText("ravi").closest("tr")!.textContent).toContain("Local");
    expect(screen.getByText("sam@x.example").closest("tr")!.textContent).toContain("Pending invitation");
    expect(screen.getByText("sam@x.example").closest("tr")!.textContent).toContain("Expires in 28 days");
  });

  it("never shows an id: no sign-in id appears anywhere on the page", async () => {
    api.getPeople.mockResolvedValue(view());
    const { container } = render(<PeoplePage />);
    await screen.findByText("Priya Shah");
    expect(container.textContent).not.toContain("oid-priya-123");
    expect(container.textContent).not.toContain("local:9f2c");
    expect(container.textContent).toContain("priya@x.example"); // CONTROL: the page did render the person
  });

  it("filters by workspace and role together", async () => {
    api.getPeople.mockResolvedValue(view());
    render(<PeoplePage />);
    await screen.findByText("Priya Shah");
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "hr" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    expect(screen.queryByText("Priya Shah")).toBeNull();
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "author" } });
    expect(screen.getByText("Priya Shah")).toBeTruthy();
  });

  it("Add person offers only workspaces the reader may add people to, and invites with the chosen role", async () => {
    api.getPeople.mockResolvedValue(view());
    api.invite.mockResolvedValue({ applied: false, invitation: {} });
    render(<PeoplePage />);
    await screen.findByText("Priya Shah");
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    const dialog = screen.getByRole("dialog");
    const options = [...(within(dialog).getByLabelText("Workspace") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toContain("Finance");
    expect(options).not.toContain("HR");
    expect(within(dialog).queryByLabelText("Platform role")).toBeNull(); // the reader cannot give one
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@x.example" } });
    expect(within(dialog).getByText(/ready when they first sign in/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Role"), { target: { value: "approver" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add person" }));
    await vi.waitFor(() =>
      expect(api.invite).toHaveBeenCalledWith({ email: "new@x.example", workspaces: [{ workspaceId: "fin", role: "approver" }], platformRole: null }),
    );
  });

  it("a local account is created with the same workspaces, and no invitation", async () => {
    api.getPeople.mockResolvedValue(view());
    lib.createLocalUser.mockResolvedValue({ id: "acc-1", subject: "local:acc-1", username: "kim", email: null });
    render(<PeoplePage />);
    await screen.findByText("Priya Shah");
    fireEvent.click(screen.getByRole("button", { name: /Add person/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByLabelText("Username"), { target: { value: "kim" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add person" }));
    await vi.waitFor(() => expect(lib.grantLocalUserAccess).toHaveBeenCalledWith("acc-1", "fin", "author"));
    expect(api.invite).not.toHaveBeenCalled();
  });

  it("withdraws an invitation from its row", async () => {
    api.getPeople.mockResolvedValue(view());
    api.revokeInvitation.mockResolvedValue({ revoked: true });
    render(<PeoplePage />);
    const row = (await screen.findByText("sam@x.example")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Actions for sam@x.example/ }));
    fireEvent.click(await screen.findByText("Withdraw"));
    await vi.waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith("inv-1"));
  });

  it("without the permission it says so, and asks for nothing", async () => {
    can.state = "denied";
    render(<PeoplePage />);
    expect(await screen.findByText("This needs permission to see the deployment's people")).toBeTruthy();
    expect(api.getPeople).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Add person/ })).toBeNull();
  });
});
