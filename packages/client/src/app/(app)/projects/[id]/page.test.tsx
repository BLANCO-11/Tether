// @vitest-environment jsdom
//
// Sharing boundaries phase 5 — one project (laid out from the 2026-10-30 mock). ⚠ What is pinned: only whoever
// manages it (the server's `manages`) is offered Remove, Make owner, Add and Delete; removing someone says first that they lose everything in it at once and
// that what they own passes to its owner; a member who does not manage it can only leave; a project this person is
// not in reads as "not here, or you are not in it".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectDetail } from "@/lib/foundry-client";

const api = vi.hoisted(() => ({
  getProject: vi.fn(),
  listMembers: vi.fn(async (): Promise<unknown> => [
    { id: "m1", subject: "ada", email: "ada@x.example", role: "author" },
    { id: "m2", subject: "bob", email: "bob@x.example", role: "author" },
    { id: "m3", subject: "cy", email: "cy@x.example", role: "author" },
  ]),
  addProjectMember: vi.fn(async (): Promise<unknown> => ({})),
  removeProjectMember: vi.fn(async (): Promise<unknown> => ({ handedOver: 0 })),
  setProjectOwner: vi.fn(async (): Promise<unknown> => ({})),
  updateProject: vi.fn(async (): Promise<unknown> => ({})),
  deleteProject: vi.fn(async (): Promise<unknown> => ({ returned: 2 })),
}));
const files = vi.hoisted(() => ({
  listProjectFiles: vi.fn(async (): Promise<unknown> => []),
  addProjectFile: vi.fn(async (): Promise<unknown> => ({})),
  removeProjectFile: vi.fn(async (): Promise<unknown> => undefined),
  projectFileUrl: vi.fn(async (): Promise<string> => "/x"),
}));
const push = vi.fn();
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/project-files", async (orig) => ({ ...(await orig<typeof import("@/lib/project-files")>()), ...files }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "p1" }), useRouter: () => ({ push, replace: vi.fn() }), usePathname: () => "/projects/p1" }));
vi.mock("@/lib/toast", () => ({ useToast: () => Object.assign(() => {}, { success: () => {}, error: () => {}, warn: () => {} }) }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: "ws-1" }), useResolvedWorkspace: () => "ws-1" }));

const { default: ProjectPage } = await import("./page");

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1",
  name: "Payroll close",
  description: null,
  instructions: "Cite the pay period.",
  ownerSubject: "ada",
  ownerName: "ada@x.example",
  manages: true,
  mine: true,
  members: [
    { subject: "ada", name: "ada@x.example", owner: true, you: true, addedAt: "2026-10-30" },
    { subject: "bob", name: "bob@x.example", owner: false, you: false, addedAt: "2026-10-30" },
  ],
  items: {
    flows: [{ id: "f1", name: "Month-end check", ownerSubject: "bob", ownerName: "bob@x.example" }],
    chats: [{ id: "c1", title: "Bob's notes", createdBySubject: "bob", flowId: null, ownerName: "bob@x.example", canChange: false }],
  },
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a project, for whoever manages it", () => {
  it("⚠ removing a member says first what they lose and where their things go, then removes them", async () => {
    api.getProject.mockResolvedValue(project());
    render(<ProjectPage />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for bob@x.example" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    expect(screen.getByText(/They stop seeing everything in “Payroll close” at once. What they own here passes to ada@x.example/)).toBeTruthy();
    expect(api.removeProjectMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
    await waitFor(() => expect(api.removeProjectMember).toHaveBeenCalledWith("p1", "bob"));
  });
  it("adds only workspace members not already in it", async () => {
    api.getProject.mockResolvedValue(project());
    render(<ProjectPage />);
    const pick = (await screen.findByLabelText("Add a member")) as HTMLSelectElement;
    await waitFor(() => expect([...pick.options].map((o) => o.value)).toEqual(["", "cy"]));
    fireEvent.change(pick, { target: { value: "cy" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.addProjectMember).toHaveBeenCalledWith("p1", "cy"));
  });
  it("lists what lives in it; somebody else's chat opens to read", async () => {
    api.getProject.mockResolvedValue(project());
    render(<ProjectPage />);
    expect((await screen.findByText("Month-end check")).closest("a")?.getAttribute("href")).toBe("/flows/f1");
    expect(screen.getByText("Bob's notes").closest("a")?.getAttribute("href")).toBe("/chats/c1");
    // A chat started from here lives here (phase 6, P5-I2).
    expect(screen.getByRole("link", { name: /New chat/ }).getAttribute("href")).toBe("/chats/new?project=p1");
  });
});

describe("a project, for a member who does not manage it", () => {
  it("⚠ offers no Remove, Add or Delete — only leaving, which names who gets their things", async () => {
    api.getProject.mockResolvedValue(
      project({
        manages: false,
        members: [
          { subject: "ada", name: "ada@x.example", owner: true, you: false, addedAt: "2026-10-30" },
          { subject: "bob", name: "bob@x.example", owner: false, you: true, addedAt: "2026-10-30" },
        ],
      }),
    );
    render(<ProjectPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave this project" }));
    expect(screen.queryByRole("button", { name: /More actions for/ })).toBeNull();
    expect(screen.queryByLabelText("Add a member")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
    expect(screen.getByText("Cite the pay period.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(api.removeProjectMember).toHaveBeenCalledWith("p1", "bob"));
    expect(push).toHaveBeenCalledWith("/projects");
  });
  it("a project they are not in reads as not here, or not theirs", async () => {
    api.getProject.mockRejectedValue(new Error('404 {"error":"not_found"}'));
    render(<ProjectPage />);
    expect(await screen.findByText("It is not here, or you are not in it.")).toBeTruthy();
  });
});

describe("a project's files", () => {
  const file = (over = {}) => ({
    id: "pf1", name: "Project brief.pdf", contentType: "application/pdf", sizeBytes: 1200000,
    uploadedBy: "bob", uploadedByEmail: "bob@x.example", createdAt: "2026-10-30T10:00:00Z", canRemove: false, ...over,
  });

  it("lists them with size and who added them; removing is offered only where the server allows it", async () => {
    api.getProject.mockResolvedValue(project());
    files.listProjectFiles.mockResolvedValue([file(), file({ id: "pf2", name: "Notes.txt", canRemove: true })]);
    render(<ProjectPage />);
    expect(await screen.findByText("Project brief.pdf")).toBeTruthy();
    expect(screen.getAllByText(/Added by bob@x.example/).length).toBe(2);
    expect(screen.getByText("· 2 files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Project brief.pdf" }));
    expect(screen.queryByRole("menuitem", { name: /Remove/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Notes.txt" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    expect(files.removeProjectFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
    await waitFor(() => expect(files.removeProjectFile).toHaveBeenCalledWith("p1", "pf2"));
  });

  it("adds the files picked", async () => {
    api.getProject.mockResolvedValue(project());
    render(<ProjectPage />);
    const input = (await screen.findByLabelText("Choose project files")) as HTMLInputElement;
    const f = new File(["x"], "Budget.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fireEvent.change(input, { target: { files: [f] } });
    await waitFor(() => expect(files.addProjectFile).toHaveBeenCalledWith("p1", f));
  });

  it("an unreadable list says so, and the delete warning counts the files it deletes", async () => {
    api.getProject.mockResolvedValue(project());
    files.listProjectFiles.mockRejectedValue(new Error("boom"));
    render(<ProjectPage />);
    expect(await screen.findByText(/The files could not be read/)).toBeTruthy();
    cleanup();
    files.listProjectFiles.mockResolvedValue([file()]);
    render(<ProjectPage />);
    await screen.findByText("Project brief.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    expect(screen.getByText(/Its file is deleted\./)).toBeTruthy();
  });
});
