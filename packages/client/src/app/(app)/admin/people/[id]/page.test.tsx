// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const api = vi.hoisted(() => ({ getPeople: vi.fn(), assignPlatformRole: vi.fn(), unassignPlatformRole: vi.fn() }));
const lib = vi.hoisted(() => ({
  grantMember: vi.fn(),
  revokeMember: vi.fn(),
  grantLocalUserAccess: vi.fn(),
  revokeLocalUserAccess: vi.fn(),
  setLocalUserActive: vi.fn(),
  setLocalUserPassword: vi.fn(),
  deleteLocalUser: vi.fn(),
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));
vi.mock("@/lib/api", () => lib);
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));
vi.mock("@/components/access/Can", () => ({ useCanPlatform: () => ({ state: "allowed", allowed: true, denied: false, unreadable: false }) }));
vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return { useParams: () => routeParams.current, useRouter: () => router };
});

const { atRoute } = await import("@/lib/test-route-params");
const { default: PersonPage } = await import("./page");

const people = {
  people: [
    {
      subject: "oid-priya",
      email: "priya@x.example",
      name: "Priya Shah",
      signIn: "microsoft",
      lastSeenAt: null,
      superAdmin: false,
      platformRoles: [],
      workspaces: [
        { id: "fin", name: "Finance", role: "author", reach: "own", via: ["Creator"] },
        { id: "hr", name: "HR", role: "viewer", reach: "published", via: ["Observer"] },
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
  invitations: [],
  workspaces: [
    { id: "fin", name: "Finance", canAddPeople: true },
    { id: "hr", name: "HR", canAddPeople: false },
    { id: "ops", name: "Ops", canAddPeople: true },
  ],
  closedWorkspaces: [],
  platformRoles: [],
  can: { givePlatformRoles: false, createLocalAccounts: true },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a person", () => {
  it("shows each workspace with the role and what it lets them see; the role is changed in place", async () => {
    api.getPeople.mockResolvedValue(people);
    lib.grantMember.mockResolvedValue({});
    render(atRoute(encodeURIComponent("oid-priya"), <PersonPage />));
    const role = (await screen.findByLabelText("Role in Finance")) as HTMLSelectElement;
    expect(role.value).toBe("author");
    expect(screen.getByText("Builds their own; sees what is shared with them")).toBeTruthy();
    fireEvent.change(role, { target: { value: "approver" } });
    await vi.waitFor(() =>
      expect(lib.grantMember).toHaveBeenCalledWith("fin", { subject: "oid-priya", email: "priya@x.example", role: "approver" }),
    );
  });

  it("where the reader cannot add people, the role is read-only and there is no Remove", async () => {
    api.getPeople.mockResolvedValue(people);
    render(atRoute("oid-priya", <PersonPage />));
    await screen.findByLabelText("Role in Finance");
    expect(screen.queryByLabelText("Role in HR")).toBeNull();
    const hr = screen.getByText("HR").closest("li")!;
    expect(within(hr).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(hr.textContent).toContain("Observer");
  });

  it("removing asks first, then removes", async () => {
    api.getPeople.mockResolvedValue(people);
    lib.revokeMember.mockResolvedValue(undefined);
    render(atRoute("oid-priya", <PersonPage />));
    const fin = (await screen.findByText("Finance")).closest("li")!;
    fireEvent.click(within(fin).getByRole("button", { name: "Remove" }));
    expect(lib.revokeMember).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(lib.revokeMember).toHaveBeenCalledWith("fin", "oid-priya"));
  });

  it("adds them to another workspace the reader may add people to", async () => {
    api.getPeople.mockResolvedValue(people);
    lib.grantMember.mockResolvedValue({});
    render(atRoute("oid-priya", <PersonPage />));
    const add = (await screen.findByLabelText("Add to workspace")) as HTMLSelectElement;
    expect([...add.options].map((o) => o.textContent)).toEqual(["Add to a workspace…", "Ops"]);
    fireEvent.change(add, { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(lib.grantMember).toHaveBeenCalledWith("ops", { subject: "oid-priya", email: "priya@x.example", role: "author" }));
  });

  it("a local account uses its own access routes, and its account can be turned off", async () => {
    api.getPeople.mockResolvedValue(people);
    lib.grantLocalUserAccess.mockResolvedValue(undefined);
    lib.setLocalUserActive.mockResolvedValue({});
    render(atRoute(encodeURIComponent("local:9f2c"), <PersonPage />));
    fireEvent.change(await screen.findByLabelText("Role in Finance"), { target: { value: "author" } });
    await vi.waitFor(() => expect(lib.grantLocalUserAccess).toHaveBeenCalledWith("9f2c", "fin", "author"));
    expect(lib.grantMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await vi.waitFor(() => expect(lib.setLocalUserActive).toHaveBeenCalledWith("9f2c", false));
  });

  it("a local account is deleted only after confirming, then the page goes back to People", async () => {
    api.getPeople.mockResolvedValue(people);
    lib.deleteLocalUser.mockResolvedValue({});
    render(atRoute(encodeURIComponent("local:9f2c"), <PersonPage />));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(lib.deleteLocalUser).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(lib.deleteLocalUser).toHaveBeenCalledWith("9f2c"));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/people"));
  });

  it("an unknown id says so", async () => {
    api.getPeople.mockResolvedValue(people);
    render(atRoute("oid-nobody", <PersonPage />));
    expect(await screen.findByText("Not found")).toBeTruthy();
  });
});
