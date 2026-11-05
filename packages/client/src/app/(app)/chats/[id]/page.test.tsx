// @vitest-environment jsdom
// A chat's one address (2026-10-30): live for whoever may continue it; READ, not opened, for anyone it is shared with
// (sharing-boundaries P1-I5 "A") — the stored conversation and nothing to act on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";

const getPiChat = vi.fn();
vi.mock("@/lib/pi-builder", async () => {
  const real = await vi.importActual<typeof import("@/lib/pi-builder")>("@/lib/pi-builder");
  return { ...real, getPiChat: (...a: unknown[]) => getPiChat(...a) };
});
// The diagram renderer pulls in `mermaid`, which is not what this page is about (and is not installed on every host).
vi.mock("@/components/pi-builder/ChatWorkbench", () => ({
  ChatWorkbench: (p: { chatId: string; title: string }) => <div data-testid="live-chat">{`${p.chatId}|${p.title}`}</div>,
}));
vi.mock("@/components/pi-builder/MermaidDiagram", () => ({ MermaidDiagram: () => null, isDiagram: () => false }));
vi.mock("@/lib/workspace", () => ({ useResolvedWorkspace: () => "ws1", useWorkspace: () => ({ workspaceId: "ws1" }) }));
vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return {
    useParams: () => routeParams.current,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/chats/c1",
    useSearchParams: () => new URLSearchParams(),
  };
});

const { default: ReadChatPage } = await import("./page");

const transcript = (over: { canChange: boolean; mine: boolean }) => ({
  chat: {
    id: "c1",
    title: "Payroll check",
    mode: "workflow",
    flowId: null,
    visibility: "public",
    createdBy: { subject: "alice", name: "Alice" },
    updatedAt: "2026-10-30T10:00:00Z",
    messages: [
      { id: "m1", role: "user", text: "List late timesheets", at: "2026-10-30T09:00:00Z" },
      {
        id: "m2",
        role: "assistant",
        text: "Here they are.",
        at: "2026-10-30T09:00:05Z",
        proposals: [{ id: "p1", title: "Connect Jira", summary: "Add a Jira connection", status: "pending" }],
      },
    ],
  },
  ...over,
});

afterEach(() => {
  cleanup();
  getPiChat.mockReset();
});

describe("reading a shared chat", () => {
  it("shows the conversation, says whose it is and that only they continue it, and offers nothing to act on", async () => {
    getPiChat.mockResolvedValue(transcript({ canChange: false, mine: false }));
    render(atRoute("c1", <ReadChatPage />));
    await waitFor(() => expect(screen.getByText("List late timesheets")).toBeTruthy());
    expect(getPiChat).toHaveBeenCalledWith("ws1", "c1");
    expect(screen.getByText("Here they are.")).toBeTruthy();
    expect(screen.getByText("Shared with you to read")).toBeTruthy();
    expect(screen.getByText(/Only they can continue it/)).toBeTruthy();
    expect(screen.queryByText(/Open it to continue/)).toBeNull();
    // ⚠ A proposal is something to DECIDE: a reader must not be offered it.
    expect(screen.queryByText("Connect Jira")).toBeNull();
  });

  it("whoever may continue it gets the live conversation here, whatever it built", async () => {
    getPiChat.mockResolvedValue({ ...transcript({ canChange: true, mine: true }), chat: { ...transcript({ canChange: true, mine: true }).chat, flowId: "f1" } });
    render(atRoute("c1", <ReadChatPage />));
    await waitFor(() => expect(screen.getByTestId("live-chat").textContent).toBe("c1|Payroll check"));
    expect(screen.queryByText("Shared with you to read")).toBeNull();
  });

  it("an unreadable chat says so, rather than drawing an empty conversation", async () => {
    getPiChat.mockRejectedValue(new Error("404 not found"));
    render(atRoute("c1", <ReadChatPage />));
    await waitFor(() => expect(screen.getByText("This chat could not be read")).toBeTruthy());
  });
});
