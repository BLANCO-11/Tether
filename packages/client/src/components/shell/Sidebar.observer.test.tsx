// @vitest-environment jsdom
// rbac-observability (2026-10-15): an Observer holds no `flows.write`, so the rail offers no "New chat".
// Both directions, plus unreadable — which still shows it, because the server decides.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let write: "allowed" | "denied" | "unreadable" = "unreadable";
vi.mock("@/lib/permissions", () => ({
  usePermissions: () => ({ can: (p: string) => (p === "flows.write" ? write : "unreadable"), canPlatform: () => "unreadable" }),
}));
vi.mock("@/lib/api", () => ({ getMe: vi.fn(), listPendingApprovals: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { name: "A", email: "a@x.test" }, signOut: vi.fn() }) }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: "ws-1" }) }));
vi.mock("@/lib/activity", () => ({ useActivityEpoch: () => 0 }));

const api = await import("@/lib/api");
const { Sidebar } = await import("./Sidebar");

beforeEach(() => {
  vi.mocked(api.listPendingApprovals).mockResolvedValue([]);
  vi.mocked(api.getMe).mockResolvedValue({ subject: "s", email: "a@x.test", superAdmin: false, superAdminConfigured: true } as never);
});
afterEach(() => {
  cleanup();
  write = "unreadable";
});

describe("Sidebar — New chat follows flows.write", () => {
  it("is hidden from someone who may not build", async () => {
    write = "denied";
    render(<Sidebar />);
    await waitFor(() => expect(api.getMe).toHaveBeenCalled());
    expect(screen.queryByLabelText("New chat")).toBeNull();
  });

  it("is shown to someone who may build", () => {
    write = "allowed";
    render(<Sidebar />);
    expect(screen.getByLabelText("New chat")).toBeTruthy();
  });

  it("is shown when the permission could not be read", () => {
    render(<Sidebar />);
    expect(screen.getByLabelText("New chat")).toBeTruthy();
  });
});
