// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoleHolders } from "./RoleHolders";
import type { WorkspaceRoleSummary } from "@/lib/types";

/**
 * ⚠ **A ROLE NOBODY CAN BE GIVEN IS A ROLE THE PRODUCT DOES NOT HAVE.**
 *
 * The roles surface (`/organization/roles` then, the Roles tab on `/admin/members` now)
 * could compose a custom role while `assignWorkspaceRole` existed with no callers, so a
 * composed role could never reach a person. These assertions are
 * mostly about the *existence* of the path, plus the one modelling rule that makes it
 * correct: a custom role is held ALONGSIDE the preset, never instead of it.
 */

const listWorkspaceRoleMembers = vi.fn();
const listMembers = vi.fn();
const assignWorkspaceRole = vi.fn();
const unassignWorkspaceRole = vi.fn();

vi.mock("@/lib/foundry-client", () => ({
  foundryApi: {
    listWorkspaceRoleMembers: (w: string, r: string) => listWorkspaceRoleMembers(w, r),
    listMembers: (w: string) => listMembers(w),
    assignWorkspaceRole: (w: string, r: string, s: string) => assignWorkspaceRole(w, r, s),
    unassignWorkspaceRole: (w: string, r: string, s: string) => unassignWorkspaceRole(w, r, s),
  },
}));

const grantState = { value: "allowed" as "allowed" | "denied" | "unreadable" };
vi.mock("@/components/access/Can", () => ({
  useCan: () => ({
    state: grantState.value,
    allowed: grantState.value === "allowed",
    denied: grantState.value === "denied",
    unreadable: grantState.value === "unreadable",
    why: [],
  }),
}));

vi.mock("@/lib/toast", () => ({ useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); } }));

const ROLE: WorkspaceRoleSummary = {
  id: "role-1",
  name: "Release manager",
  description: null,
  permissions: ["flows.approve"],
  builtin: false,
  retiredAt: null,
  assignees: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  grantState.value = "allowed";
  listWorkspaceRoleMembers.mockResolvedValue({ members: [] });
  listMembers.mockResolvedValue([
    { subject: "oid-1", email: "ada@example.com", role: "author" },
    { subject: "oid-2", email: "grace@example.com", role: "approver" },
  ]);
});
afterEach(cleanup);

describe("a custom role can actually be given to somebody", () => {
  it("assigns the chosen person to this role", async () => {
    assignWorkspaceRole.mockResolvedValue({ assigned: true });
    const onChanged = vi.fn();
    render(<RoleHolders workspaceId="ws-1" role={ROLE} onChanged={onChanged} />);

    await waitFor(() => expect(screen.getByLabelText(/Add somebody to Release manager/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Add somebody to Release manager/), {
      target: { value: "oid-2" },
    });
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() =>
      expect(assignWorkspaceRole).toHaveBeenCalledWith("ws-1", "role-1", "oid-2"),
    );
    // The parent's assignee count is re-read, so the two cannot drift.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("lists holders by email and removes one", async () => {
    listWorkspaceRoleMembers.mockResolvedValue({
      members: [{ subject: "oid-1", grantedBy: "x", createdAt: "" }],
    });
    unassignWorkspaceRole.mockResolvedValue({ assigned: false });
    render(<RoleHolders workspaceId="ws-1" role={ROLE} />);

    await waitFor(() => expect(screen.getByTestId("holder-list")).toBeTruthy());
    expect(screen.getByText("ada@example.com")).toBeTruthy();

    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() =>
      expect(unassignWorkspaceRole).toHaveBeenCalledWith("ws-1", "role-1", "oid-1"),
    );
  });

  it("already-holding people are not offered again", async () => {
    listWorkspaceRoleMembers.mockResolvedValue({
      members: [{ subject: "oid-1", grantedBy: "x", createdAt: "" }],
    });
    render(<RoleHolders workspaceId="ws-1" role={ROLE} />);
    await waitFor(() => expect(screen.getByTestId("holder-list")).toBeTruthy());

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("grace@example.com");
    expect(options).not.toContain("ada@example.com");
  });
});

/**
 * ⚠ A built-in preset has no assignment row — membership carries it. Offering an "add"
 * here would be a second writer of the same fact, able to disagree with the first.
 */
describe("it refuses to be a second way to write a preset", () => {
  it("renders NOTHING for a built-in role", async () => {
    const preset: WorkspaceRoleSummary = { ...ROLE, id: null, name: "admin", builtin: true };
    const { container } = render(<RoleHolders workspaceId="ws-1" role={preset} />);
    expect(container.textContent).toBe("");
    expect(listWorkspaceRoleMembers).not.toHaveBeenCalled();
  });

  it("a retired role keeps its holders visible but takes no new ones", async () => {
    listWorkspaceRoleMembers.mockResolvedValue({
      members: [{ subject: "oid-1", grantedBy: "x", createdAt: "" }],
    });
    render(<RoleHolders workspaceId="ws-1" role={{ ...ROLE, retiredAt: "2026-01-01" }} />);
    await waitFor(() => expect(screen.getByTestId("holder-list")).toBeTruthy());
    expect(screen.getByText(/retired, so nobody new/)).toBeTruthy();
    expect(screen.queryByText("Add")).toBeNull();
    // ⚠ Still removable. Retiring is not a reason to trap people in a role.
    expect(screen.getByText("Remove")).toBeTruthy();
  });
});

describe("the three states", () => {
  it("an unreadable holder read says the check did not run, not that nobody holds it", async () => {
    listWorkspaceRoleMembers.mockRejectedValue(new Error("down"));
    render(<RoleHolders workspaceId="ws-1" role={ROLE} />);
    await waitFor(() => expect(screen.getByTestId("holders-unreadable")).toBeTruthy());
    expect(screen.queryByText(/Nobody holds this role yet/)).toBeNull();
  });

  it("an empty SUCCESSFUL read does say nobody holds it", async () => {
    render(<RoleHolders workspaceId="ws-1" role={ROLE} />);
    await waitFor(() => expect(screen.getByText(/Nobody holds this role yet/)).toBeTruthy());
  });

  it("explains rather than hiding when the caller may not grant", async () => {
    grantState.value = "denied";
    listWorkspaceRoleMembers.mockResolvedValue({
      members: [{ subject: "oid-1", grantedBy: "x", createdAt: "" }],
    });
    render(<RoleHolders workspaceId="ws-1" role={ROLE} />);
    await waitFor(() => expect(screen.getByText(/need/)).toBeTruthy());
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Add")).toBeNull();
  });
});
