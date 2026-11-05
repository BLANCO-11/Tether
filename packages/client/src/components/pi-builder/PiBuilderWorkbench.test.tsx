// @vitest-environment jsdom
/**
 * The test drawer asks for exactly what the WORKFLOW declares — read from the session's workflow state, never a list
 * kept beside it. Reported 2026-10-10: "the input options disappeared". Rendered end to end through the workbench.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  setPiModel: vi.fn(), steerPiMessage: vi.fn(), setPiThinking: vi.fn(),
  storageLevel: (st: { bytes: number; limit: number } | null) => (!st ? "ok" : st.bytes > st.limit ? "full" : st.bytes >= st.limit * 0.8 ? "near" : "ok"),
  errorText: (e: unknown) => String(e),
  MODE_LABEL: { workflow: "Workflow Builder", agent: "Forge Agent" }, MODE_BLURB: { workflow: "", agent: "" },
}));

// jsdom performs no layout and has no scrollTo; the chat auto-scroll calls it.
Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;
const { PiBuilderWorkbench, chatItems, runStatePill, RUN_STATE_LABELS } = await import("./PiBuilderWorkbench");
const { PageHeaderProvider, usePageHeaderSlot } = await import("@/lib/page-header");

/** The shell's half: the builder's title and actions render in the ONE top bar, which this stands in for. */
function HeaderOut() {
  const h = usePageHeaderSlot();
  return <header data-testid="topbar">{h?.title}{h?.actions}{h?.endActions}</header>;
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
  it("a chat's top bar names the CHAT only — never \"New workflow\" (2026-10-30)", async () => {
    current = workflow();
    render(inShell(<PiBuilderWorkbench title="Hours for payroll" />));
    const bar = await screen.findByTestId("topbar");
    await waitFor(() => expect(bar.textContent).toContain("Hours for payroll"));
    expect(bar.textContent).not.toContain("Workflow Builder");
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

describe("Forge Agent's header and tools drawer", () => {
  it("has no Test button — there is no workflow to test — and Workflow Builder still has one", async () => {
    sessionMode = "agent";
    render(inShell(<PiBuilderWorkbench />));
    await screen.findByRole("button", { name: "Tools" });
    expect(screen.queryByTestId("builder-test")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Save|Saved|Saving…)$/ })).toBeNull();
  });

  it("gives chat the full width (no canvas rail) and opens Files in the tools drawer", async () => {
    sessionMode = "agent";
    const { container } = render(inShell(<PiBuilderWorkbench />));
    await waitFor(() => expect(container.querySelector(".forge-wb")!.className).toContain("agent-full"));
    expect(screen.queryByLabelText("Expand Canvas")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
    const tools = await screen.findByLabelText("Chat tools");
    expect(within(tools).getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    const pane = await screen.findByTestId("side-pane");
    expect(pane.getAttribute("data-docked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    await waitFor(() => expect(screen.queryByLabelText("Chat tools")).toBeNull());
    expect(container.querySelector(".forge-wb")!.className).toContain("agent-full");
  });

  it("CONTROL: in Workflow Builder Tools opens Files (canvas stays in its column — no twin)", async () => {
    render(inShell(<PiBuilderWorkbench />));
    fireEvent.click(await screen.findByRole("button", { name: "Tools" }));
    const tools = await screen.findByLabelText("Chat tools");
    expect(within(tools).getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tools).queryByRole("tab", { name: "Canvas" })).toBeNull();
    expect(screen.getByTestId("builder-test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(Save|Saved)$/ })).toBeTruthy();
  });
});

describe("the header's run state (2026-11-03)", () => {
  it("is one short word on one line, never truncated to a fragment", async () => {
    current = workflow();
    render(inShell(<PiBuilderWorkbench flowId="f1" />));
    const btn = within(await screen.findByTestId("topbar")).getByTestId("run-state");
    expect(btn.className).toContain("whitespace-nowrap");
    expect(btn.className).toContain("shrink-0");
    expect(btn.querySelector(".truncate")).toBeNull();
    expect(btn.textContent).toBe("Ready");
  });

  it("a test that needs real data says so in the header and the banner, and a non-admin is told to ask", async () => {
    current = workflow();
    const lib = await import("@/lib/pi-builder");
    let emit: ((ev: unknown) => void) | undefined;
    vi.mocked(lib.openPiEventStream).mockImplementation(((_ws: string, _id: string, on: (ev: unknown) => void) => {
      emit = on;
      return () => undefined;
    }) as never);
    render(inShell(<PiBuilderWorkbench flowId="f1" />));
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => emit!({ type: "test_run", ok: false, detail: "raw", summary: "The test needs real data.", runId: "r1", needsRealData: true }));
    const bar = await screen.findByTestId("topbar");
    await waitFor(() => expect(bar.textContent).toContain("Needs real data"));
    expect(screen.getAllByText("The test needs real data.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ask an admin to run it on real data.").length).toBeGreaterThan(0);
  });
});

describe("the run state pill's one word (2026-11-03)", () => {
  async function emitter() {
    current = workflow();
    const lib = await import("@/lib/pi-builder");
    let emit: ((ev: unknown) => void) | undefined;
    vi.mocked(lib.openPiEventStream).mockImplementation(((_ws: string, _id: string, on: (ev: unknown) => void) => {
      emit = on;
      return () => undefined;
    }) as never);
    return () => emit;
  }

  it('a failed test reads "Test failed", and the label is always one of the defined words with no separator', async () => {
    const get = await emitter();
    render(inShell(<PiBuilderWorkbench flowId="f1" />));
    await waitFor(() => expect(get()).toBeTruthy());
    const emit = get();
    act(() => emit!({ type: "test_run", ok: false, detail: "raw", summary: "It broke.", runId: "r2" }));
    const bar = await screen.findByTestId("topbar");
    await waitFor(() => expect(within(bar).getByTestId("run-state-label").textContent).toBe("Test failed"));
    expect(RUN_STATE_LABELS as readonly string[]).toContain(within(bar).getByTestId("run-state-label").textContent);
    expect(within(bar).getByTestId("run-state").textContent).not.toContain("·");
  });

  it("runStatePill: what Forge is doing wins, then the last test, then Ready", () => {
    expect(runStatePill("running", null).label).toBe("Working…");
    expect(runStatePill("awaiting_answers", null).label).toBe("Needs your answer");
    expect(runStatePill("failed", null).label).toBe("Stopped");
    expect(runStatePill("failed", "failed").label).toBe("Test failed");
    expect(runStatePill("failed", "passed").label).toBe("Stopped");
    expect(runStatePill("ready", "passed")).toEqual({ label: "Test passed", dot: "bg-ok" });
    expect(runStatePill("ready", "refused").label).toBe("Checks refused");
    expect(runStatePill("ready", "needs real data").dot).toBe("bg-warn");
    expect(runStatePill("running", "failed").label).toBe("Working…");
    expect(runStatePill("ready", null).label).toBe("Ready");
  });

  it("the workflow link lives in the run state's details, not in the bar", async () => {
    const get = await emitter();
    render(inShell(<PiBuilderWorkbench title="Hours" />));
    await waitFor(() => expect(get()).toBeTruthy());
    const emit = get();
    act(() => emit!({ type: "saved", flowId: "f9", revision: 1 }));
    const bar = await screen.findByTestId("topbar");
    expect(within(bar).queryByText(/Workflow:/)).toBeNull();
    const btn = within(bar).getByTestId("run-state");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole("link", { name: "Monthly hours" }).getAttribute("href")).toBe("/flows/f9"));
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("messages queue while Forge works (2026-11-03)", () => {
  async function setup() {
    current = workflow();
    const lib = await import("@/lib/pi-builder");
    let emit: ((ev: unknown) => void) | undefined;
    vi.mocked(lib.openPiEventStream).mockImplementation(((_ws: string, _id: string, on: (ev: unknown) => void) => {
      emit = on;
      return () => undefined;
    }) as never);
    const session = await vi.mocked(lib.createPiSession)("ws");
    vi.mocked(lib.sendPiMessage).mockReset();
    vi.mocked(lib.sendPiMessage).mockResolvedValue(session as never);
    vi.mocked(lib.steerPiMessage).mockReset();
    render(inShell(<PiBuilderWorkbench />));
    await waitFor(() => expect(emit).toBeTruthy());
    const box = (await screen.findByLabelText("Chat message")) as HTMLTextAreaElement;
    const say = (text: string, label: string) => {
      fireEvent.change(box, { target: { value: text } });
      fireEvent.click(screen.getByLabelText(label));
    };
    return { lib, box, say, done: () => act(() => emit!({ type: "done" })) };
  }

  it("a second message waits under Queued messages, then goes when the turn is done", async () => {
    const { lib, box, say, done } = await setup();
    say("first", "Send");
    await waitFor(() => expect(screen.getByLabelText("Add to queue")).toBeTruthy());
    expect(lib.sendPiMessage).toHaveBeenCalledTimes(1);
    say("second", "Add to queue");
    const strip = await screen.findByLabelText("Queued messages");
    expect(within(strip).getByText("second")).toBeTruthy();
    expect(box.value).toBe("");
    expect(lib.sendPiMessage).toHaveBeenCalledTimes(1);

    done();
    await waitFor(() => expect(lib.sendPiMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(lib.sendPiMessage).mock.calls[1]![2]).toBe("second");
    await waitFor(() => expect(screen.queryByLabelText("Queued messages")).toBeNull());
  });

  it("a removed message is never sent", async () => {
    const { lib, say, done } = await setup();
    say("first", "Send");
    await screen.findByLabelText("Add to queue");
    say("second", "Add to queue");
    fireEvent.click(await screen.findByLabelText("Remove from queue"));
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
    done();
    await new Promise((r) => setTimeout(r, 20));
    expect(lib.sendPiMessage).toHaveBeenCalledTimes(1);
  });

  it("Send now steers the running turn, and a failure keeps the message with its error", async () => {
    const { lib, say } = await setup();
    say("first", "Send");
    await screen.findByLabelText("Add to queue");
    say("steer me", "Add to queue");
    vi.mocked(lib.steerPiMessage).mockRejectedValueOnce(new Error("no turn"));
    fireEvent.click(await screen.findByText("Send now"));
    await waitFor(() => expect(lib.steerPiMessage).toHaveBeenCalledWith("ws", "s1", "steer me"));
    const strip = screen.getByLabelText("Queued messages");
    await waitFor(() => expect(within(strip).getByText(/no turn/)).toBeTruthy());
    expect(within(strip).getByText("steer me")).toBeTruthy();

    vi.mocked(lib.steerPiMessage).mockResolvedValueOnce({} as never);
    fireEvent.click(within(strip).getByText("Send now"));
    await waitFor(() => expect(screen.queryByLabelText("Queued messages")).toBeNull());
  });
});

describe("the composer's model pill and / commands (2026-11-04)", () => {
  const MODELS = ["gpt-6-luna", "DeepSeek-V4-Flash-0731"];
  async function setup() {
    const lib = await import("@/lib/pi-builder");
    const base = await vi.mocked(lib.createPiSession)("ws");
    vi.mocked(lib.createPiSession).mockResolvedValueOnce({ ...base, model: "gpt-6-luna", models: MODELS } as never);
    vi.mocked(lib.sendPiMessage).mockReset();
    vi.mocked(lib.setPiModel).mockReset();
    render(inShell(<PiBuilderWorkbench />));
    const box = (await screen.findByLabelText("Chat message")) as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByTestId("model-pill").textContent).toContain("GPT-6 Luna"));
    return { lib, box };
  }

  it("the pill shows the clean model name", async () => {
    await setup();
    expect(screen.getByTestId("model-pill").textContent).toBe("GPT-6 Luna");
  });

  it("typing / lists /model, and not /think in Workflow Builder", async () => {
    const { box } = await setup();
    fireEvent.change(box, { target: { value: "/" } });
    const menu = screen.getByTestId("slash-menu");
    expect(menu.textContent).toContain("/model");
    expect(menu.textContent).not.toContain("/think");
  });

  it("/model deep picks the matching model, sends nothing, and the pill follows", async () => {
    const { lib, box } = await setup();
    vi.mocked(lib.setPiModel).mockResolvedValueOnce({ model: "DeepSeek-V4-Flash-0731", models: MODELS } as never);
    fireEvent.change(box, { target: { value: "/model deep" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(lib.setPiModel).toHaveBeenCalledWith("ws", "s1", "DeepSeek-V4-Flash-0731"));
    expect(lib.sendPiMessage).not.toHaveBeenCalled();
    expect(box.value).toBe("");
    await waitFor(() => expect(screen.getByTestId("model-pill").textContent).toContain("DeepSeek V4 Flash"));
  });

  it("/model alone opens the pill menu and sends nothing", async () => {
    const { lib, box } = await setup();
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(lib.sendPiMessage).not.toHaveBeenCalled();
  });

  it("the / button puts a / in the box and shows the menu", async () => {
    const { box } = await setup();
    fireEvent.click(screen.getByTestId("composer-slash"));
    await waitFor(() => expect(box.value).toBe("/"));
    expect(screen.getByTestId("slash-menu")).toBeTruthy();
  });
});
