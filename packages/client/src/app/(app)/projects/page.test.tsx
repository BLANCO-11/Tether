// @vitest-environment jsdom
//
// Sharing boundaries phase 5 — the projects list. It shows what the server sent (the projects this person is in),
// says so when there are none, says the list could not be read when it could not, and makes a project with the
// person as its owner, then opens it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  listProjects: vi.fn(async (): Promise<unknown> => []),
  createProject: vi.fn(async (): Promise<unknown> => ({ id: "p9", name: "Payroll close" })),
}));
const push = vi.fn();
vi.mock("@/lib/api", () => api);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => "/projects" }));
vi.mock("@/lib/toast", () => ({ useToast: () => Object.assign(() => {}, { success: () => {}, error: () => {}, warn: () => {} }) }));

const { default: ProjectsPage } = await import("./page");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Projects", () => {
  it("lists the projects this person is in, with how many people are in each", async () => {
    api.listProjects.mockResolvedValue([
      { id: "p1", name: "Payroll close", description: "Month-end", members: 3, mine: true, owned: true },
      { id: "p2", name: "Hiring", description: null, members: 1, mine: false, owned: false },
    ]);
    render(<ProjectsPage />);
    expect(await screen.findByText("Payroll close")).toBeTruthy();
    expect(screen.getByText("3 members · yours")).toBeTruthy();
    expect(screen.getByText("1 member · you are not in it (Admin)")).toBeTruthy();
    expect(screen.getByText("Payroll close").closest("a")?.getAttribute("href")).toBe("/projects/p1");
  });
  it("none yet says so; unreadable says it could not be read — never an empty list", async () => {
    api.listProjects.mockResolvedValue([]);
    render(<ProjectsPage />);
    expect(await screen.findByText(/You are not in any project yet/)).toBeTruthy();
    cleanup();
    api.listProjects.mockRejectedValueOnce(new Error("500 internal_error"));
    render(<ProjectsPage />);
    expect(await screen.findByText("The projects could not be read")).toBeTruthy();
  });
  it("makes a project and opens it", async () => {
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  Payroll close " } });
    fireEvent.change(screen.getByLabelText("Shared instructions"), { target: { value: "Cite the pay period." } });
    fireEvent.click(screen.getByRole("button", { name: "Make project" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "Payroll close", description: null, instructions: "Cite the pay period." }));
    expect(push).toHaveBeenCalledWith("/projects/p9");
  });
});
