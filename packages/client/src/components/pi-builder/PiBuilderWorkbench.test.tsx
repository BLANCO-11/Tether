// @vitest-environment jsdom
/**
 * The test drawer asks for exactly what the WORKFLOW declares — read from the session's workflow state, never a list
 * kept beside it. Reported 2026-10-10: "the input options disappeared". Rendered end to end through the workbench.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: "ws" }), useResolvedWorkspace: () => "ws" }));
vi.mock("@/lib/api", () => ({ getFlowExecution: vi.fn(async () => null), flowReadSources: vi.fn(async () => []), getMe: vi.fn(async () => ({})) }));
vi.mock("./PiDagCanvas", async (orig) => ({ ...(await orig<typeof import("./PiDagCanvas")>()), PiDagCanvas: () => <div /> }));
vi.mock("./PiFlowCanvas", () => ({ PiFlowCanvas: () => <div /> }));
vi.mock("./PiSidePane", () => ({
  PiSidePane: ({ view, docked }: { view: unknown; docked?: boolean }) =>
    view ? <div data-testid="side-pane" data-docked={String(!!docked)} /> : null,
  CHAT_FILE: "chat:",
}));
let sessionMode: "workflow" | "agent" = "workflow";

const workflow = (inputs?: Record<string, unknown>) => ({
  name: "Monthly hours",
  ...(inputs ? { inputs } : {}),
  steps: [{ id: "load", entry: "steps/load/main.py", params: { month: "$input.month" }, outputs: ["rows"] }],
});
let current = workflow({ month: { type: "integer", description: "Which month?", default: 6 }, year: { type: "integer", description: "Which year?" } });
vi.mock("@/lib/pi-builder", async (orig) => ({
  // The `@` mention helpers are pure and the composer reads them as the caret moves; the picker's reads are empty.
  mentionAt: (await orig<typeof import("@/lib/pi-builder")>()).mentionAt,
  withoutMention: (await orig<typeof import("@/lib/pi-builder")>()).withoutMention,
  listReferences: vi.fn(async () => []), listReferenceable: vi.fn(async () => []), MAX_REFERENCES: 3,
  createPiSession: vi.fn(async () => ({
    id: "s1", workspaceId: "ws", flowId: null, draftKey: "k", status: "ready", goal: "", messages: [], liveActivities: [],
    workflow: current, questions: { status: "clear", questions: [] }, answers: {}, lastVerify: null, lastTestRun: null,
    lastRunId: null, acceptedSnapshotId: null, savedRevision: null, model: "m", createdAt: "", updatedAt: "", mode: sessionMode,
  })),
  destroyPiSession: vi.fn(async () => undefined),
  getPiSession: vi.fn(async () => ({ workflow: current })),
  openPiEventStream: vi.fn(() => () => undefined),
  sendPiMessage: vi.fn(), answerPiQuestions: vi.fn(), stopPiSession: vi.fn(), testRunPiSession: vi.fn(), savePiVersion: vi.fn(),
  // Chat attachments (ChatAttachments.tsx) — the composer reads the accepted kinds; nothing here uploads.
  ATTACH_ACCEPT: ".pdf", ATTACH_MAX_FILES: 10, attachRefusal: vi.fn(() => null), uploadPiAttachment: vi.fn(), removePiAttachment: vi.fn(),
  // Chat modes (ModeSwitch.tsx): this workspace does not offer Forge Agent, so the switch renders nothing.
  setPiMode: vi.fn(), setForgeDefaultMode: vi.fn(),
  removePiChatFile: vi.fn(),
  storageLevel: (st: { bytes: number; limit: number } | null) => (!st ? "ok" : st.bytes > st.limit ? "full" : st.bytes >= st.limit * 0.8 ? "near" : "ok"),
  errorText: (e: unknown) => String(e),
  MODE_LABEL: { workflow: "Workflow Builder", agent: "Forge Agent" }, MODE_BLURB: { workflow: "", agent: "" },
}));

// jsdom performs no layout and has no scrollTo; the chat auto-scroll calls it.
Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;
const { PiBuilderWorkbench, chatItems } = await import("./PiBuilderWorkbench");
const { PageHeaderProvider, usePageHeaderSlot } = await import("@/lib/page-header");

/** The shell's half: the builder's title and actions render in the ONE top bar, which this stands in for. */
function HeaderOut() {
  const h = usePageHeaderSlot();
  return <header data-testid="topbar">{h?.title}{h?.actions}</header>;
}
const inShell = (ui: React.ReactNode) => (
  <PageHeaderProvider>
    <HeaderOut />
    {ui}
  </PageHeaderProvider>
);
afterEach(() => {
  cleanup();
  sessionMode = "workflow";
});

describe("the Pi builder's test drawer", () => {
  it("asks for every input the workflow declares", async () => {
    render(inShell(<PiBuilderWorkbench />));
    fireEvent.click(await screen.findByTestId("builder-test"));
    await waitFor(() => expect(screen.getByLabelText("month")).toBeTruthy());
    expect(screen.getByLabelText("year")).toBeTruthy();
    expect(screen.getByText("2 inputs declared")).toBeTruthy();
  });

  it("reads the workflow FRESH when the drawer opens — a stale screen copy does not decide the fields", async () => {
    current = workflow();
    const { createPiSession } = await import("@/lib/pi-builder");
    render(inShell(<PiBuilderWorkbench />));
    await screen.findByTestId("builder-test");
    // the screen holds the no-input version; the server now has month added (the edit the stream never delivered)
    current = workflow({ month: { type: "integer", description: "Which month?", default: 6 } });
    fireEvent.click(screen.getByTestId("builder-test"));
    await waitFor(() => expect(screen.getByLabelText("month")).toBeTruthy());
    expect(vi.mocked(createPiSession)).toHaveBeenCalled();
  });

  it("takes the full-height workbench layout wherever it is mounted, and gives it back on unmount", async () => {
    const { unmount } = render(inShell(<PiBuilderWorkbench />));
    await screen.findByTestId("builder-test");
    expect(document.body.classList.contains("wb")).toBe(true);
    unmount();
    expect(document.body.classList.contains("wb")).toBe(false);
  });

  it("CONTROL: a workflow that declares none says so — the fields come from the workflow, not a fixed list", async () => {
    current = workflow();
    render(inShell(<PiBuilderWorkbench />));
    fireEvent.click(await screen.findByTestId("builder-test"));
    await waitFor(() => expect(screen.getByText(/declares no inputs/)).toBeTruthy());
    expect(screen.queryByLabelText("month")).toBeNull();
  });
});

describe("one header, and the chat as turns (2026-10-10)", () => {
  it("a chat's top bar names the CHAT and its mode — never \"New workflow\" (2026-10-30)", async () => {
    current = workflow();
    render(inShell(<PiBuilderWorkbench title="Hours for payroll" />));
    const bar = await screen.findByTestId("topbar");
    await waitFor(() => expect(bar.textContent).toContain("Hours for payroll"));
    expect(bar.textContent).toContain("Workflow Builder");
    expect(bar.textContent).not.toContain("New workflow");
  });

  it("the flow's name, ONE state sentence, Test and Save render in the top bar — and leave it on unmount", async () => {
    current = workflow();
    const { unmount } = render(inShell(<PiBuilderWorkbench flowId="f1" />));
    const bar = await screen.findByTestId("topbar");
    await waitFor(() => expect(bar.textContent).toContain("Monthly hours"));
    expect(bar.textContent).toContain("Ready");
    expect(bar.textContent).toContain("Test");
    expect(bar.textContent).toMatch(/Save/);
    // the old stacked heads are gone
    expect(screen.queryByText("Drafting")).toBeNull();
    expect(screen.queryByText("What you are building")).toBeNull();
    unmount();
  });

  it("groups messages into turns: a person's message and everything that answered it, until the next", () => {
    const m = (id: string, role: "user" | "assistant" | "system", extra = {}) => ({ id, role, text: id, at: "", ...extra });
    const items = chatItems([
      m("hi", "assistant", { welcome: true }),
      m("q1", "user"), m("a1", "assistant"), m("fix", "system"), m("a2", "assistant"),
      m("q2", "user"), m("a3", "assistant"),
      m("back", "assistant", { welcome: true }),
    ] as never);
    expect(items.map((i) => i.kind)).toEqual(["welcome", "turn", "turn", "welcome"]);
    expect((items[1] as { replies: Array<{ id: string }> }).replies.map((r) => r.id)).toEqual(["a1", "fix", "a2"]);
    // control: a system note with no turn to belong to stands alone
    expect(chatItems([m("note", "system")] as never).map((i) => i.kind)).toEqual(["note"]);
  });
});

describe("the Pi builder's live connection", () => {
  it("retries a dropped connection, says so meanwhile, and catches up from the session once it answers", async () => {
    current = workflow();
    const lib = await import("@/lib/pi-builder");
    const calls: Array<{ onError?: (e: Error) => void; onOpen?: () => void }> = [];
    vi.mocked(lib.openPiEventStream).mockImplementation(((_ws: string, _id: string, _on: unknown, onError?: (e: Error) => void, onOpen?: () => void) => {
      calls.push({ onError, onOpen });
      return () => undefined;
    }) as never);
    const full = { ...(await vi.mocked(lib.createPiSession)("ws")), status: "ready", messages: [{ id: "m1", role: "assistant", text: "Built while you were away", at: "" }] };
    vi.mocked(lib.getPiSession).mockResolvedValueOnce(full as never);

    render(inShell(<PiBuilderWorkbench />));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.onOpen?.();
    calls[0]!.onError?.(new Error("the live connection closed"));
    await screen.findByText("Reconnecting to the builder…");
    // the first retry comes after 1s
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    calls[1]!.onOpen?.();
    await screen.findByText("Built while you were away");
    expect(screen.queryByText("Reconnecting to the builder…")).toBeNull();
  });
});

describe("hiding the canvas", () => {
  it("gives the conversation the width, keeps a rail to bring it back, and never hides both panes", async () => {
    const { container } = render(inShell(<PiBuilderWorkbench />));
    fireEvent.click(await screen.findByLabelText("Hide canvas"));
    expect(container.querySelector(".workbench")!.className).toContain("canvas-closed");
    // Hiding the chat now brings the canvas back rather than leaving nothing.
    fireEvent.click(screen.getByLabelText("Hide chat"));
    const cls = container.querySelector(".workbench")!.className;
    expect(cls).toContain("chat-closed");
    expect(cls).not.toContain("canvas-closed");
    fireEvent.click(screen.getByLabelText("Expand Chat"));
    fireEvent.click(screen.getByLabelText("Hide canvas"));
    fireEvent.click(screen.getByLabelText("Expand Canvas"));
    expect(container.querySelector(".workbench")!.className).not.toContain("canvas-closed");
  });
});

describe("the composer hints that a saved workflow can be referenced (2026-10-25)", () => {
  const box = async () => (await screen.findByLabelText("Chat message")) as HTMLTextAreaElement;

  it("the placeholder mentions @ in Workflow Builder", async () => {
    render(inShell(<PiBuilderWorkbench />));
    expect((await box()).placeholder).toMatch(/type @ to learn from a saved workflow/);
  });

  it("an @ button in the toolbar puts an @ in the box, as typing it would", async () => {
    render(inShell(<PiBuilderWorkbench />));
    const ta = await box();
    fireEvent.click(screen.getByLabelText("Reference a saved workflow"));
    await waitFor(() => expect(ta.value).toBe("@"));
  });

  it("…after a space when there is already text, so the mention is recognised", async () => {
    render(inShell(<PiBuilderWorkbench />));
    const ta = await box();
    fireEvent.change(ta, { target: { value: "make a report" } });
    ta.setSelectionRange(13, 13);
    fireEvent.click(screen.getByLabelText("Reference a saved workflow"));
    await waitFor(() => expect(ta.value).toBe("make a report @"));
  });

  it("CONTROL: Forge Agent does not use references, so it gets neither the button nor the placeholder hint", async () => {
    const lib = await import("@/lib/pi-builder");
    const base = await (lib.createPiSession as unknown as () => Promise<Record<string, unknown>>)();
    (lib.createPiSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...base, mode: "agent", agentAllowed: true });
    render(inShell(<PiBuilderWorkbench />));
    const ta = await box();
    expect(ta.placeholder).not.toMatch(/@/);
    expect(screen.queryByLabelText("Reference a saved workflow")).toBeNull();
  });
});

describe("Forge Agent's header and files (2026-10-28)", () => {
  it("has no Test button — there is no workflow to test — and Workflow Builder still has one", async () => {
    sessionMode = "agent";
    render(inShell(<PiBuilderWorkbench />));
    await screen.findByRole("button", { name: /Files/ });
    expect(screen.queryByTestId("builder-test")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Save|Saved|Saving…)$/ })).toBeNull();
  });

  it("opens the files as the explorer in the canvas's column, without unfolding the canvas", async () => {
    sessionMode = "agent";
    const { container } = render(inShell(<PiBuilderWorkbench />));
    fireEvent.click(await screen.findByRole("button", { name: /Files/ }));
    const pane = await screen.findByTestId("side-pane");
    expect(pane.getAttribute("data-docked")).toBe("true");
    const wb = container.querySelector(".forge-wb")!;
    expect(wb.className).toContain("explorer-open");
    expect(wb.className).not.toContain("canvas-closed");
    // Closing it folds back to the canvas rail, still without a canvas.
    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    await waitFor(() => expect(screen.queryByTestId("side-pane")).toBeNull());
    expect(wb.className).toContain("canvas-closed");
  });

  it("CONTROL: in Workflow Builder the files slide over the open canvas, as before", async () => {
    render(inShell(<PiBuilderWorkbench />));
    fireEvent.click(await screen.findByRole("button", { name: /Files/ }));
    expect((await screen.findByTestId("side-pane")).getAttribute("data-docked")).toBe("false");
    expect(screen.getByTestId("builder-test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(Save|Saved)$/ })).toBeTruthy();
  });
});
