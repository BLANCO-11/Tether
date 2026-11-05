/**
 * The chat turn routed onto the compiled builder (`BUILDER_CHAT`). The builder seam is mocked: what is under test is
 * which seam function a message reaches, how each `BuilderTurn` is filed as a chat turn, and that the flag-off arm never
 * touches the builder at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const getThreadMock = vi.fn();
const nextSeqMock = vi.fn(async () => 1);
const createTurnMock = vi.fn(async (data: Record<string, unknown>) => ({ id: "turn_1", ...data }));
const finishTurnMock = vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
const attachFlowMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined);
const listTurnsMock = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
vi.mock("../repositories/flow-chat.repo.js", () => ({
  flowChatRepo: {
    getThread: (...a: unknown[]) => getThreadMock(...a),
    runningTurn: async () => null,
    runningCount: async () => 0,
    nextSeq: () => nextSeqMock(),
    createTurn: (d: Record<string, unknown>) => createTurnMock(d),
    finishTurn: (id: string, p: Record<string, unknown>) => finishTurnMock(id, p),
    attachFlow: (...a: unknown[]) => attachFlowMock(...a),
    recentApplied: async () => [],
    recentAnswered: async () => [],
    trailingNeedsInput: async () => 0,
    cachedRefusal: async () => null,
    listTurns: (...a: unknown[]) => listTurnsMock(...a),
  },
}));

const flowRepoGetMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { get: (...a: unknown[]) => flowRepoGetMock(...a), getRevision: async () => undefined },
}));

const getIncompleteMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock("./flow.service.js", () => ({
  flowService: { getIncomplete: (...a: unknown[]) => getIncompleteMock(...a) },
}));

const diffMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ changes: [] }));
vi.mock("./flow-approval.service.js", () => ({
  flowApprovalService: { diff: (...a: unknown[]) => diffMock(...a) },
}));

const builderStartMock = vi.fn();
const builderAnswerMock = vi.fn();
const builderRebuildMock = vi.fn();
vi.mock("./builder/conversation.js", async (orig) => ({
  // Real exports stay real (CLARIFY_BOUND_OFFER and friends); the three entry points are the seams under test.
  ...(await orig<typeof import("./builder/conversation.js")>()),
  builderStart: (...a: unknown[]) => builderStartMock(...a),
  builderAnswer: (...a: unknown[]) => builderAnswerMock(...a),
  builderRebuild: (...a: unknown[]) => builderRebuildMock(...a),
  builderContinue: async () => null, // no unfinished build to continue: these tests start or edit
}));

// Phase X: the route, the catalogue, the state and the edit service are seams too.
const routeMock = vi.fn(async (..._a: unknown[]): Promise<string> => "build");
vi.mock("./builder/chat-route.js", () => ({ routeMessage: (...a: unknown[]) => routeMock(...a) }));
const CAT_ITEMS = { items: [
  { ref: "shop.orders", kind: "reader", about: "Every order placed this month. One row per order." },
  { ref: "notify", kind: "tool", about: "Send a message to a person. Delivered at once." },
] };
vi.mock("./builder/builder.service.js", () => ({
  builderCatalogue: async () => ({ items: CAT_ITEMS, cat: {} }),
  modelChooser: async () => "{}",
}));
const loadStateMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ state: { id: "f", inputs: [], steps: [], holes: [] } }));
vi.mock("./builder/canvas.service.js", () => ({ loadState: (...a: unknown[]) => loadStateMock(...a) }));
const editTurnMock = vi.fn();
const resumeEditMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock("./builder/chat-edit.service.js", async (orig) => ({
  ...(await orig<typeof import("./builder/chat-edit.service.js")>()),
  editTurn: (...a: unknown[]) => editTurnMock(...a),
  resumeEdit: (...a: unknown[]) => resumeEditMock(...a),
}));

const { flowChatService } = await import("./flow-chat.service.js");
const { builderTurnPatch, answerText, questionIdOf } = await import("./flow-chat-builder.js");
const { CLARIFY_BOUND_OFFER } = await import("./builder/conversation.js");

const AUTHOR = { createdByKind: "user", createdBy: "u1" } as never;
const pendingView = (pending: string | null, stale = false) => ({
  model: {},
  build: { goalSpec: { conversation: { pending } } },
  stale,
  diagnostics: [],
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("chat on the builder", () => {
  it("a first message starts the builder, links the thread to the flow it created, and files its question", async () => {
    getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId: null, name: "x" });
    builderStartMock.mockResolvedValueOnce({
      status: "asks",
      flowId: "f1",
      readback: ["read the people in store people", "every day"],
      question: { holeId: "delivery:0:delivery", ask: "Where should the result go?", options: ["email", "chat"] },
      unmet: [],
      summary: "It reads the people in store people. Runs every day at 09:00.",
    });

    const out = await flowChatService.turn("ws", "th", { message: "the people in store people, every day" }, AUTHOR);

    expect(builderStartMock).toHaveBeenCalledWith("ws", "the people in store people, every day", AUTHOR, null, expect.any(Function));
    expect(builderAnswerMock).not.toHaveBeenCalled();
    expect(attachFlowMock).toHaveBeenCalledWith("ws", "th", "f1");
    expect(createTurnMock.mock.calls[0]![0]).toMatchObject({ status: "running" });
    expect(out.flowId).toBe("f1");
    const turn = out.turn as unknown as { status: string; findingsJson: string[] };
    expect(turn.status).toBe("needs_input");
    const asked = JSON.parse(turn.findingsJson[0]!);
    // The framing is the flow so far in a sentence; the readback folds beneath it (2026-09-28).
    expect(asked.text).toBe("So far: it reads the people in store people. Runs every day at 09:00.");
    expect(asked.details).toEqual(["read the people in store people", "every day"]);
    expect(asked.questions).toEqual([
      {
        id: "delivery_0_delivery",
        question: "Where should the result go?",
        options: [{ label: "email", value: "email" }, { label: "chat", value: "chat" }],
        allow_custom: true,
      },
    ]);
  });

  it("a pending question makes the next message an ANSWER, with the panel's `id:` prefix stripped", async () => {
    getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId: "f1", name: "x" });
    getIncompleteMock.mockResolvedValueOnce(pendingView("delivery:0:delivery"));
    builderAnswerMock.mockResolvedValueOnce({ status: "complete", flowId: "f1", readback: ["post to #ops"], revision: 2, unmet: [], calls: 0, suggestions: [] });
    routeMock.mockResolvedValueOnce("answer"); // P4 (R11): whether it answers is decided with the question in view

    const out = await flowChatService.turn("ws", "th", { message: "delivery_0_delivery: post it to #ops\n" }, AUTHOR);

    expect(builderAnswerMock).toHaveBeenCalledWith("ws", "f1", "post it to #ops", AUTHOR, expect.any(Function));
    expect(builderStartMock).not.toHaveBeenCalled();
    expect(attachFlowMock).not.toHaveBeenCalled();
    const turn = out.turn as unknown as { status: string; revision: number; findingsJson: string[] };
    expect(turn.status).toBe("applied");
    expect(turn.revision).toBe(2);
    expect(turn.findingsJson).toEqual(["Understood: post to #ops"]);
    expect(diffMock).toHaveBeenCalledWith("ws", "f1", 1, 2);
    expect(out.diff).toEqual({ changes: [] });
  });

  it("no pending question on a flow → an edit: builderStart with the thread's flow", async () => {
    getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId: "f1", name: "x" });
    getIncompleteMock.mockResolvedValueOnce(pendingView(null));
    builderStartMock.mockResolvedValueOnce({ status: "unchanged", flowId: "f1", readback: [], unmet: [] });

    const out = await flowChatService.turn("ws", "th", { message: "also email me" }, AUTHOR);

    expect(builderStartMock).toHaveBeenCalledWith("ws", "also email me", AUTHOR, "f1", expect.any(Function));
    expect(builderAnswerMock).not.toHaveBeenCalled();
    expect((out.turn as unknown as { status: string }).status).toBe("answered");
  });

  it("a STALE working copy's pending question is not answered — the message starts again from the current draft", async () => {
    getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId: "f1", name: "x" });
    getIncompleteMock.mockResolvedValueOnce(pendingView("delivery:0:delivery", true));
    builderStartMock.mockResolvedValueOnce({ status: "cannot", flowId: "f1", readback: [], unmet: ["no tool posts to a pager"] });

    await flowChatService.turn("ws", "th", { message: "page me" }, AUTHOR);

    expect(builderAnswerMock).not.toHaveBeenCalled();
    expect(builderStartMock).toHaveBeenCalledWith("ws", "page me", AUTHOR, "f1", expect.any(Function));
  });

  it("a builder throw fails the running turn with the reason, and rethrows", async () => {
    getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId: null, name: "x" });
    builderStartMock.mockRejectedValueOnce(new Error("gateway request failed"));

    await expect(flowChatService.turn("ws", "th", { message: "hello there" }, AUTHOR)).rejects.toThrow("gateway request failed");
    expect(finishTurnMock).toHaveBeenCalledWith("turn_1", { status: "failed", findingsJson: ["gateway request failed"] });
  });

  it("the policy gate still runs first: a rejected message never reaches the builder", async () => {
    getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId: null, name: "x" });
    const out = await flowChatService.turn("ws", "th", { message: "Build me a clone of Slack" }, AUTHOR);
    expect((out.turn as unknown as { status: string }).status).toBe("policy_reject");
    expect(builderStartMock).not.toHaveBeenCalled();
  });
});

describe("the BuilderTurn → chat turn mapping", () => {
  const base = { flowId: "f1", readback: ["r1"], unmet: [] as string[], calls: 0, suggestions: [] as string[] };
  it("each builder status files under an existing chat status", () => {
    expect(builderTurnPatch({ ...base, status: "asks", question: { holeId: "h", ask: "q?" } }).status).toBe("needs_input");
    expect(builderTurnPatch({ ...base, status: "complete", revision: 1 }).status).toBe("applied");
    expect(builderTurnPatch({ ...base, status: "incomplete", unmet: ["u"] }).status).toBe("incomplete");
    expect(builderTurnPatch({ ...base, status: "cannot", unmet: ["u"] }).status).toBe("insufficient_catalogue");
    expect(builderTurnPatch({ ...base, status: "unchanged" }).status).toBe("answered");
  });
  it("Phase 6: what the builder did with a reply leads the turn, and no engine syntax reaches the person", () => {
    const asks = builderTurnPatch({ ...base, status: "asks", said: "That is not one of the options.", question: { holeId: "reader:a|b", ask: "Which one?", options: ["ds.tickets_by_status", "ds.ticket_sla_rows"], onlyOptions: true } });
    const body = JSON.parse(asks.findingsJson[0]!) as { text: string; questions: Array<{ options: Array<{ label: string }> }> };
    expect(body.text.split("\n")[0]).toBe("That is not one of the options.");
    expect(body.questions[0]!.options.map((o) => o.label)).toEqual(["tickets by status", "ticket sla rows"]);
    const inc = builderTurnPatch({ ...base, status: "incomplete", unmet: ["`read_1.status` was asked (who receives it) and not answered"] });
    expect(inc.findingsJson.join("\n")).not.toMatch(/`|read_1/);
  });
  it("incomplete and cannot list every unmet line and the readback, and say which of the two they are", () => {
    const inc = builderTurnPatch({ ...base, status: "incomplete", unmet: ["no recipient", "no schedule"] });
    expect(inc.findingsJson).toEqual([
      "The draft is kept, but it does not yet do all of this:",
      "no recipient",
      "no schedule",
      "Understood: r1",
    ]);
    const cannot = builderTurnPatch({ ...base, status: "cannot", unmet: ["no pager tool"] });
    expect(cannot.findingsJson[0]).toMatch(/cannot build that/);
    expect(cannot.findingsJson).toContain("no pager tool");
    expect(cannot.revision).toBeUndefined();
  });
  it("a question with no options still allows a typed answer", () => {
    const p = builderTurnPatch({ ...base, status: "asks", question: { holeId: "value:0", ask: "Which address?" } });
    const q = JSON.parse(p.findingsJson[0]!).questions[0];
    expect(q).toEqual({ id: "value_0", question: "Which address?", allow_custom: true });
  });
  it("Intent IR: Preview lines fold separately; CLARIFY offers acceptGaps", () => {
    const p = builderTurnPatch({
      ...base,
      status: "asks",
      readback: ["Reads spend", "Preview: spend.new_read: ~3 row(s) in preview (columns: id, amount)"],
      question: { holeId: "clarify:unsettled", ask: "What did you mean by “the usual ones”?" },
    });
    const body = JSON.parse(p.findingsJson[0]!) as { details: string[]; previews: string[]; acceptGaps?: boolean };
    expect(body.acceptGaps).toBe(true);
    expect(body.previews.some((l) => /~3 row|preview/i.test(l))).toBe(true);
    expect(body.details).toEqual(["Reads spend"]);
    const done = builderTurnPatch({
      ...base,
      status: "complete",
      revision: 1,
      readback: ["Preview: ds.r: projects columns a, b"],
    });
    expect(done.findingsJson.some((l) => l.startsWith("Preview:"))).toBe(true);
    expect(done.findingsJson.some((l) => l.startsWith("Understood: Preview:"))).toBe(false);
  });
  it("C7/C8: the round-bound turn files as incomplete with its terminal offer — never needs_input; needs_input only ever carries a question", () => {
    const bound = builderTurnPatch({ ...base, status: "incomplete", unmet: ["“the regular ones” is unclear — what it refers to was not settled"], suggestions: [CLARIFY_BOUND_OFFER] });
    expect(bound.status).toBe("incomplete");
    expect(bound.findingsJson).toContain(`Suggestion: ${CLARIFY_BOUND_OFFER}`);
    // C8's ⇔: the badge "Needs your input" is filed only WITH a question to answer — an open one, actually open.
    const asked = builderTurnPatch({ ...base, status: "asks", question: { holeId: "h", ask: "q?" } });
    expect(asked.status).toBe("needs_input");
    expect(JSON.parse(asked.findingsJson[0]!).questions).toHaveLength(1);
  });
  it("answerText strips only the question's own prefix", () => {
    expect(answerText("delivery_0_delivery: me@x.example", "delivery:0:delivery")).toBe("me@x.example");
    expect(answerText("delivery:0:delivery: me@x.example", "delivery:0:delivery")).toBe("me@x.example");
    expect(answerText("  at 9:00 every day ", "schedule:0")).toBe("at 9:00 every day");
    expect(questionIdOf("delivery:0:delivery")).toBe("delivery_0_delivery");
  });
});

/**
 * Phase X (I-309): a message is ROUTED before anything is built. The report's own message is the regression: "What can you
 * build?" reached `builderStart` as a goal and came back "what do you mean?".
 */
describe("phase X — chat is routed: questions answered, changes made, goals built", () => {
  const thread = (flowId: string | null) => getThreadMock.mockResolvedValueOnce({ id: "th", workspaceId: "ws", flowId, name: "x" });
  const filed = () => finishTurnMock.mock.calls.at(-1)![1] as { status: string; findingsJson: string[]; attempts: number; revision?: number };

  it("“What can you build?” is ANSWERED from the catalogue — the builder is never reached (I-309)", async () => {
    thread(null);
    routeMock.mockResolvedValueOnce("capabilities");
    await flowChatService.turn("ws", "th", { message: "What can you build?" }, AUTHOR);
    expect(builderStartMock).not.toHaveBeenCalled();
    const f = filed();
    expect(f.status).toBe("answered");
    expect(f.findingsJson[0]).toContain("Every order placed this month.");
    expect(f.findingsJson[0]).toContain("Send a message to a person.");
    // The starters ride as structured data in the second finding; the model stub fails them, so code's fallback is offered.
    expect(JSON.parse(f.findingsJson[1]!).suggestions[0]).toEqual({ label: "Show me every order placed this month", value: "Show me every order placed this month" });
    expect(f.attempts).toBe(2); // the route call and the starters call, and nothing else
  });

  it("CONTROL: a goal still reaches the builder, and the route call is counted with its calls", async () => {
    thread(null);
    builderStartMock.mockResolvedValueOnce({ status: "unchanged", flowId: null, readback: [], unmet: [], calls: 2, suggestions: [] });
    await flowChatService.turn("ws", "th", { message: "email me the orders every day" }, AUTHOR);
    expect(builderStartMock).toHaveBeenCalledTimes(1);
    expect(filed().attempts).toBe(3);
  });

  it("a question about the automation is answered from its own steps", async () => {
    thread("f1");
    loadStateMock.mockResolvedValueOnce({ state: { id: "f", inputs: [], holes: [], steps: [{ id: "read_orders", kind: "datasource", ref: "shop.orders", inputs: [] }] } });
    routeMock.mockResolvedValueOnce("about_flow");
    await flowChatService.turn("ws", "th", { message: "what does this do?" }, AUTHOR);
    expect(routeMock).toHaveBeenCalledWith("what does this do?", true, expect.any(Function), undefined);
    expect(filed().status).toBe("answered");
    // Intent IR default-on: assistant-voice phrases the same facts (never invents steps).
    expect(filed().findingsJson[0]).toMatch(/It reads every order placed this month/);
    expect(filed().findingsJson[0]).toMatch(/Here’s what it does so far/);
    // The steps fold beneath the sentence, numbered, without ids.
    expect(JSON.parse(filed().findingsJson[1]!).card).toMatchObject({ more: "See the steps", inventory: ["1. Reads every order placed this month"] });
  });

  it("with no steps, the route is not offered `change` or `about_flow`", async () => {
    thread("f1");
    routeMock.mockResolvedValueOnce("chat");
    await flowChatService.turn("ws", "th", { message: "thanks" }, AUTHOR);
    expect(routeMock).toHaveBeenCalledWith("thanks", false, expect.any(Function), undefined);
  });

  it("a change goes to ONE canvas action, never to the builder", async () => {
    thread("f1");
    loadStateMock.mockResolvedValueOnce({ state: { id: "f", inputs: [], holes: [], steps: [{ id: "a", kind: "datasource", inputs: [] }] } });
    routeMock.mockResolvedValueOnce("change");
    editTurnMock.mockResolvedValueOnce({ status: "applied", lines: ["Changed: x — at step a"], revision: 3, calls: 1 });
    await flowChatService.turn("ws", "th", { message: "use the other reader" }, AUTHOR);
    expect(editTurnMock).toHaveBeenCalledWith("ws", "f1", "use the other reader", AUTHOR, expect.any(Function));
    expect(builderStartMock).not.toHaveBeenCalled();
    expect(filed()).toMatchObject({ status: "applied", revision: 3, attempts: 2 });
  });

  it("a change no listed one-step change makes auto-rebuilds (no Enable replan)", async () => {
    const { REPLAN_DONE } = await import("./builder/conversation.js");
    thread("f1");
    loadStateMock.mockResolvedValueOnce({ state: { id: "f", inputs: [], holes: [], steps: [{ id: "a", kind: "datasource", inputs: [] }] } });
    routeMock.mockResolvedValueOnce("change");
    editTurnMock.mockResolvedValueOnce({ status: "insufficient_catalogue", lines: ["I could not match that…"], calls: 1, decision: "none_fit" });
    builderRebuildMock.mockResolvedValueOnce({ status: "complete", flowId: "f1", readback: [], unmet: [], calls: 2, suggestions: [], revision: 4 });
    await flowChatService.turn("ws", "th", { message: "post it to chat instead" }, AUTHOR);
    expect(editTurnMock).toHaveBeenCalled();
    expect(builderRebuildMock).toHaveBeenCalledWith("ws", "f1", "post it to chat instead", AUTHOR, expect.any(Function));
    expect(filed().status).toBe("applied");
    expect(filed().findingsJson[0]).toBe(REPLAN_DONE);
    expect(filed().revision).toBe(4);
    expect(diffMock).toHaveBeenLastCalledWith("ws", "f1", 3, 4);
  });

  it("the builder's own pending question: a reply the route reads as its answer is answered — one route call, nothing else", async () => {
    thread("f1");
    getIncompleteMock.mockResolvedValueOnce(pendingView("delivery:0:delivery"));
    builderAnswerMock.mockResolvedValueOnce({ status: "complete", flowId: "f1", readback: [], unmet: [], revision: 2, calls: 0, suggestions: [] });
    routeMock.mockResolvedValueOnce("answer");
    await flowChatService.turn("ws", "th", { message: "email" }, AUTHOR);
    expect(routeMock).toHaveBeenCalledTimes(1);
    expect(builderAnswerMock).toHaveBeenCalled();
    expect(builderStartMock).not.toHaveBeenCalled();
  });
});

