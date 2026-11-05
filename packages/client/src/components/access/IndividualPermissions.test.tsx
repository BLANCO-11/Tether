// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const lib = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock("@/lib/api", () => lib);
vi.mock("@/components/admin/MemberDrawer", () => ({
  MemberDrawer: ({ member, workspaceId }: { member: { email: string } | null; workspaceId: string }) =>
    member ? <p>drawer for {member.email} in {workspaceId}</p> : null,
}));
const { IndividualPermissions } = await import("./IndividualPermissions");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("individual permissions", () => {
  it("opens nobody until a member is chosen, then that member, in that workspace", async () => {
    lib.listMembers.mockResolvedValue([
      { id: "1", subject: "oid-a", email: "a@x.example", role: "author", grantedBy: "x" },
      { id: "2", subject: "oid-b", email: "b@x.example", role: "viewer", grantedBy: "x" },
    ]);
    render(<IndividualPermissions workspaceId="hr" />);
    const pick = await screen.findByLabelText("Individual permissions for");
    expect(screen.queryByText(/drawer for/)).toBeNull();
    fireEvent.change(pick, { target: { value: "oid-b" } });
    expect(screen.getByText("drawer for b@x.example in hr")).toBeTruthy();
    expect(lib.listMembers).toHaveBeenCalledWith("hr");
  });

  it("an empty workspace and an unreadable list are told apart", async () => {
    lib.listMembers.mockResolvedValue([]);
    render(<IndividualPermissions workspaceId="hr" />);
    expect(await screen.findByText("Nobody is in this workspace yet.")).toBeTruthy();
    cleanup();
    lib.listMembers.mockRejectedValue(new Error("boom"));
    render(<IndividualPermissions workspaceId="hr" />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });
});
