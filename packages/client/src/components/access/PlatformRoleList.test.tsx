// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ listPlatformRoles: vi.fn(), getPeople: vi.fn() }));
vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));
const { PlatformRoleList } = await import("./PlatformRoleList");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("platform roles", () => {
  it("each role with who holds it, linking to their page; read-only", async () => {
    api.listPlatformRoles.mockResolvedValue({
      roles: [
        { key: "auditor", name: "Auditor", description: "Reads the record.", permissions: [], builtin: true },
        { key: "platform-admin", name: "Platform admin", description: null, permissions: [], builtin: true },
      ],
    });
    api.getPeople.mockResolvedValue({
      people: [{ subject: "oid-a", name: "Asha Rao", email: "asha@x.example", platformRoles: ["auditor"] }],
    });
    render(<PlatformRoleList />);
    const link = await screen.findByRole("link", { name: "Asha Rao" });
    expect(link.getAttribute("href")).toBe("/admin/people/oid-a");
    expect(screen.getByText("Nobody")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an unreadable list says so", async () => {
    api.listPlatformRoles.mockRejectedValue(new Error("boom"));
    api.getPeople.mockResolvedValue({ people: [] });
    render(<PlatformRoleList />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });
});
