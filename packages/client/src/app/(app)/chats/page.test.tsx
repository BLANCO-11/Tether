// @vitest-environment jsdom
//
// Saved chats: listed for the workspace, opened where they belong, and deletable or renamable only where the server
// said so — one at a time from the ⋮ menu, or several at once after "Select".

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PiChatSummary } from "@/lib/pi-builder";

const chat = (over: Partial<PiChatSummary> = {}): PiChatSummary => ({
  id: "c-1",
  title: "Email me the weekly attendance report",
  flowId: null,
  flowName: null,
  createdBy: { subject: "u-1", name: "Asha" },
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T11:00:00.000Z",
  messageCount: 4,
  canDelete: true,
  canRename: true,
  ...over,
});

const openSelect = () => {
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
};

const listPiChats = vi.fn(async (): Promise<PiChatSummary[]> => [chat()]);
const deletePiChat = vi.fn(async (_id: string): Promise<void> => undefined);
const renamePiChat = vi.fn(async (id: string, title: string) => ({ id, title }));
const push = vi.fn();
const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });

vi.mock("@/lib/pi-builder", async (orig) => ({
  ...(await orig<typeof import("@/lib/pi-builder")>()),
  listPiChats: () => listPiChats(),
  deletePiChat: (_ws: string, id: string) => deletePiChat(id),
  renamePiChat: (_ws: string, id: string, title: string) => renamePiChat(id, title),
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  listWorkspaces: async () => [{ id: "ws-1", name: "Finance Ops", kind: "standard" }],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }), useResolvedWorkspace: () => "ws-1" }));

import ChatsPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Chats", () => {
  it("opens every chat at its own address — a draft and one that built a workflow alike", async () => {
    listPiChats.mockResolvedValueOnce([chat(), chat({ id: "c-2", title: "Overdue chase", flowId: "f-9", flowName: "Overdue chase" })]);
    render(<ChatsPage />);
    const draft = await screen.findByText("Email me the weekly attendance report");
    expect(draft.closest("a")?.getAttribute("href")).toBe("/chats/c-1");
    const built = screen.getAllByText("Overdue chase")[0]!;
    expect(built.closest("a")?.getAttribute("href")).toBe("/chats/c-2");
  });

  it("offers the ⋮ menu only where the server allows it, and deletes on confirm", async () => {
    listPiChats.mockResolvedValueOnce([chat(), chat({ id: "c-2", title: "Someone else's", canDelete: false, canRename: false })]);
    render(<ChatsPage />);
    await screen.findByText("Someone else's");
    expect(screen.queryByLabelText("Actions for Someone else's")).toBeNull();
    fireEvent.click(screen.getByLabelText("Actions for Email me the weekly attendance report"));
    expect(screen.getByRole("menuitem", { name: /Change name/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deletePiChat).toHaveBeenCalledWith("c-1"));
  });

  it("renames a chat from the menu, and keeps the dialog open with the server's reason when refused", async () => {
    listPiChats.mockResolvedValue([chat()]);
    render(<ChatsPage />);
    fireEvent.click(await screen.findByLabelText("Actions for Email me the weekly attendance report"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Change name/ }));
    const box = screen.getByLabelText("Chat name") as HTMLInputElement;
    expect(box.value).toBe("Email me the weekly attendance report");
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true); // unchanged
    fireEvent.change(box, { target: { value: "   " } });
    expect(save().disabled).toBe(true); // empty
    renamePiChat.mockRejectedValueOnce(new Error('403 {"message":"Only the person who started this chat or a workspace admin can rename it."}'));
    fireEvent.change(box, { target: { value: "  Weekly   attendance " } });
    fireEvent.click(save());
    expect(await screen.findByText(/workspace admin can rename it/)).toBeTruthy();
    fireEvent.click(save());
    await waitFor(() => expect(renamePiChat).toHaveBeenLastCalledWith("c-1", "Weekly attendance"));
    await waitFor(() => expect(screen.queryByLabelText("Chat name")).toBeNull());
    listPiChats.mockReset();
    listPiChats.mockImplementation(async () => [chat()]);
  });

  it("Select all picks only the deletable chats the search shows, and Delete selected deletes each", async () => {
    listPiChats.mockResolvedValue([
      chat(),
      chat({ id: "c-2", title: "Overdue chase" }),
      chat({ id: "c-3", title: "Someone else's", canDelete: false }),
    ]);
    render(<ChatsPage />);
    await screen.findByText("Someone else's");
    expect(screen.queryByLabelText("Select all chats shown")).toBeNull();
    openSelect();
    expect(screen.queryByLabelText("Select Someone else's")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "overdue" } });
    fireEvent.click(screen.getByLabelText("Select all chats shown"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Select Email me the weekly attendance report"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete \(\d+\)$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    await waitFor(() => expect(deletePiChat).toHaveBeenCalledTimes(2));
    expect(deletePiChat.mock.calls.map((c) => c[0]).sort()).toEqual(["c-1", "c-2"]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Deleted 2 chats."));
    listPiChats.mockReset();
    listPiChats.mockImplementation(async () => [chat()]);
  });

  it("a partly failed Delete selected says which could not go and keeps them selected", async () => {
    listPiChats.mockResolvedValue([chat(), chat({ id: "c-2", title: "Overdue chase" })]);
    deletePiChat.mockImplementation(async (id: string) => {
      if (id === "c-2") throw new Error('403 {"message":"Only the person who started this chat or a workspace admin can delete it."}');
    });
    render(<ChatsPage />);
    await screen.findByText("Overdue chase");
    openSelect();
    fireEvent.click(screen.getByLabelText("Select all chats shown"));
    fireEvent.click(screen.getByRole("button", { name: /^Delete \(\d+\)$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Deleted 1 of 2 chats. 1 could not be: Only the person who started this chat or a workspace admin can delete it.",
      ),
    );
    expect(await screen.findByText("1 selected")).toBeTruthy();
    expect((screen.getByLabelText("Select Overdue chase") as HTMLInputElement).checked).toBe(true);
    deletePiChat.mockReset();
    deletePiChat.mockImplementation(async () => undefined);
    listPiChats.mockReset();
    listPiChats.mockImplementation(async () => [chat()]);
  });

  it("checkboxes are hidden until Select chats; Delete is disabled with nothing ticked; Clear all and Esc leave", async () => {
    listPiChats.mockResolvedValue([chat(), chat({ id: "c-2", title: "Overdue chase" })]);
    render(<ChatsPage />);
    await screen.findByText("Overdue chase");
    expect(screen.queryByLabelText("Select Overdue chase")).toBeNull();
    openSelect();
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Select Overdue chase"));
    expect((screen.getByRole("button", { name: "Delete (1)" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByLabelText("Select Overdue chase")).toBeNull();
    openSelect();
    expect((screen.getByLabelText("Select Overdue chase") as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Select Overdue chase")).toBeNull();
    listPiChats.mockReset();
    listPiChats.mockImplementation(async () => [chat()]);
  });

  it("no Select button when no listed chat can be deleted", async () => {
    listPiChats.mockResolvedValue([chat({ canDelete: false })]);
    render(<ChatsPage />);
    await screen.findByText("Email me the weekly attendance report");
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    listPiChats.mockReset();
    listPiChats.mockImplementation(async () => [chat()]);
  });

  it("previews a chat by its goal, or by its message count when it has none", async () => {
    listPiChats.mockResolvedValueOnce([chat({ goal: "Chase overdue invoices every Monday" }), chat({ id: "c-2", title: "Plain", messageCount: 7 })]);
    render(<ChatsPage />);
    expect(await screen.findByText("Chase overdue invoices every Monday")).toBeTruthy();
    expect(screen.getByText(/7 messages/)).toBeTruthy();
    expect(screen.queryByText(/4 messages/)).toBeNull();
  });

  it("says when there are none, and when the list could not be read", async () => {
    listPiChats.mockResolvedValueOnce([]);
    render(<ChatsPage />);
    expect(await screen.findByText(/No chats yet/)).toBeTruthy();
    cleanup();
    listPiChats.mockRejectedValueOnce(new Error("503 down"));
    render(<ChatsPage />);
    expect(await screen.findByText("The chats could not be read")).toBeTruthy();
  });
});

describe("Chats — composer and search", () => {
  it("Enter in the New chat box goes to /chats/new with the text as ?q=", async () => {
    render(<ChatsPage />);
    await screen.findByText("Email me the weekly attendance report");
    const box = screen.getByLabelText("New chat");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Chase invoices & more" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(push).toHaveBeenCalledWith(`/chats/new?q=${encodeURIComponent("Chase invoices & more")}`);
  });

  it("the search field filters the list as you type", async () => {
    listPiChats.mockResolvedValueOnce([chat(), chat({ id: "c-2", title: "Overdue chase" })]);
    render(<ChatsPage />);
    await screen.findByText("Overdue chase");
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "overdue" } });
    expect(screen.queryByText("Email me the weekly attendance report")).toBeNull();
    expect(screen.getByText("Overdue chase")).toBeTruthy();
  });
});

describe("Chats — whose (rbac-observability)", () => {
  it("an Admin listed somebody else's chat can narrow to their own; their own read as You", async () => {
    listPiChats.mockResolvedValueOnce([
      chat({ id: "c-1", title: "Mine", mine: true }),
      chat({ id: "c-2", title: "Theirs", mine: false, createdBy: { subject: "u-2", name: "Ravi" } }),
    ]);
    render(<ChatsPage />);
    await screen.findByText("Theirs");
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Ravi")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Mine" }));
    expect(screen.queryByText("Theirs")).toBeNull();
    expect(screen.getByText("Mine", { selector: "span" })).toBeTruthy();
  });

  it("someone listed only their own chats is not offered the choice", async () => {
    listPiChats.mockResolvedValueOnce([chat({ mine: true })]);
    render(<ChatsPage />);
    await screen.findByText("Email me the weekly attendance report");
    expect(screen.queryByRole("radiogroup", { name: "Whose chats" })).toBeNull();
  });
});

describe("where a chat lives (sharing-boundaries phases 5–6)", () => {
  it("every chat says where it lives in the three words; a chat in a project names it", async () => {
    listPiChats.mockResolvedValueOnce([
      chat({ id: "c-1", title: "Mine", canChange: true }),
      chat({ id: "c-2", title: "In payroll", projectId: "p1", projectName: "Payroll close", canChange: true }),
      chat({ id: "c-3", title: "Everyone's", visibility: "public", canChange: false }),
    ]);
    render(<ChatsPage />);
    // The filter chips say the same words: the pills are told apart by what they say about who sees it.
    expect(await screen.findByTitle("Only its owner (and Admins) see it.")).toBeTruthy();
    expect(screen.getByTitle("The members of Payroll close (and Admins) see it.")).toBeTruthy();
    expect(screen.getByTitle("Everyone in this workspace sees it.")).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.queryByText(/Shared/)).toBeNull();
  });
  it("narrows to where it lives", async () => {
    listPiChats.mockResolvedValueOnce([
      chat({ id: "c-1", title: "Mine", canChange: true }),
      chat({ id: "c-2", title: "In payroll", projectId: "p1", projectName: "Payroll close", canChange: true }),
    ]);
    render(<ChatsPage />);
    await screen.findByText("In payroll");
    fireEvent.click(screen.getByRole("radio", { name: "Projects" }));
    expect(screen.queryByText("Mine", { selector: "span" })).toBeNull();
    expect(screen.getByText("In payroll")).toBeTruthy();
  });
  it("⚠ Move is the one action for where it lives — no Share to read, no Make private (P6-D4)", async () => {
    listPiChats.mockResolvedValueOnce([chat({ canChange: true, visibility: "public" })]);
    render(<ChatsPage />);
    fireEvent.click(await screen.findByLabelText("Actions for Email me the weekly attendance report"));
    expect(screen.getByText("Move…")).toBeTruthy();
    expect(screen.queryByText("Share to read")).toBeNull();
    expect(screen.queryByText("Make private")).toBeNull();
  });

  it("is a single-line pill until the text has a newline, then a multi-line box", async () => {
    render(<ChatsPage />);
    const box = await screen.findByLabelText("New chat");
    const form = box.closest("form")!;
    fireEvent.change(box, { target: { value: "short" } });
    expect(form.getAttribute("data-multiline")).toBe("false");
    fireEvent.change(box, { target: { value: "a\nb" } });
    expect(form.getAttribute("data-multiline")).toBe("true");
  });
});
