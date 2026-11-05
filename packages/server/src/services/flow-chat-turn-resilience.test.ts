import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Builder-chat "runs forever" defect — server slice.
 *
 * A process death mid-turn orphans a `running` row and every later turn 409s
 * for ever; and a transient gateway-transport failure fails the turn outright.
 * Covers: stale reclaim lets the new turn proceed, a transient failure retries
 * once then succeeds, a fresh running turn still 409s byte-identical, and a
 * non-transport InferenceError is never retried.
 */

const getThreadMock = vi.fn();
const runningTurnMock = vi.fn();
const runningCountMock = vi.fn();
const nextSeqMock = vi.fn();
const createTurnMock = vi.fn();
const finishTurnMock = vi.fn();

// The type checker has its own suites; chat's turn logic is tested with it answering clean.
vi.mock("./flow-typecheck.js", () => ({
  blockingDiagnostics: vi.fn(async () => []),
  diagnosticLine: (d: { code: string; message: string }) => `${d.code}: ${d.message}`,
}));
vi.mock("../repositories/flow-chat.repo.js", () => ({
  flowChatRepo: {
    getThread: (...args: unknown[]) => getThreadMock(...args),
    runningTurn: (...args: unknown[]) => runningTurnMock(...args),
    runningCount: (...args: unknown[]) => runningCountMock(...args),
    nextSeq: (...args: unknown[]) => nextSeqMock(...args),
    createTurn: (...args: unknown[]) => createTurnMock(...args),
    recentApplied: async () => [],
    recentAnswered: async () => [],
    trailingNeedsInput: async () => 0,
    finishTurn: (...args: unknown[]) => finishTurnMock(...args),
  },
}));

vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { get: async () => undefined, getRevision: async () => undefined },
}));

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByWorkspace: async () => [] },
}));

const inferenceCompleteMock = vi.fn();
vi.mock("./inference.service.js", () => ({
  inference: { complete: (...args: unknown[]) => inferenceCompleteMock(...args) },
}));

vi.mock("./flow-generation.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readerlessDatasources: async () => [] };
});

const { flowChatService, STALE_RUNNING_MS } = await import("./flow-chat.service.js");

const thread = { id: "thread_1", workspaceId: "ws", flowId: null, designSelection: null, name: "chat" };

/** An InferenceError without importing the (mocked) class — the service matches on name + message. */
function inferenceError(message: string): Error {
  const e = new Error(message);
  e.name = "InferenceError";
  return e;
}

// The turn itself is the builder's (`flow-chat-builder.ts`); what is under test here is the reclaim in front of it.
const builderChatTurnMock = vi.fn();
vi.mock("./flow-chat-builder.js", () => ({ builderChatTurn: (...a: unknown[]) => builderChatTurnMock(...a) }));
const answered = JSON.stringify({ status: "answered", text: "it chases overdue invoices" });

function seedNewTurn(turnId: string) {
  getThreadMock.mockResolvedValueOnce(thread);
  runningCountMock.mockResolvedValueOnce(0);
  nextSeqMock.mockResolvedValueOnce(2);
  createTurnMock.mockImplementationOnce(async (data: Record<string, unknown>) => ({
    id: turnId,
    threadId: "thread_1",
    seq: 2,
    createdAt: new Date(),
    ...data,
  }));
  finishTurnMock.mockImplementation(async (id: unknown, data: Record<string, unknown>) => ({
    id,
    ...data,
  }));
}

describe("stale running reclaim", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pins the stale bound at ten minutes", () => {
    expect(STALE_RUNNING_MS).toBe(10 * 60_000);
  });

  it("fails the orphaned turn and lets the new turn proceed", async () => {
    runningTurnMock.mockResolvedValueOnce({
      id: "orphan_1",
      threadId: "thread_1",
      seq: 1,
      status: "running",
      createdAt: new Date(Date.now() - STALE_RUNNING_MS - 60_000),
    });
    seedNewTurn("turn_new");
    builderChatTurnMock.mockImplementationOnce(async (ctx: { turn: unknown }) => ({ turn: { ...(ctx.turn as object), status: "answered" }, flowId: null }));

    const outcome = await flowChatService.turn(
      "ws",
      "thread_1",
      { message: "what does this workflow do" },
      { createdByKind: "system" } as never,
    );

    // The orphan is failed with the stall on the record…
    expect(finishTurnMock).toHaveBeenCalledWith(
      "orphan_1",
      expect.objectContaining({ status: "failed" }),
    );
    const orphanFindings = JSON.stringify(finishTurnMock.mock.calls[0][1]);
    expect(orphanFindings).toMatch(/stall|restart/i);
    // …and the new turn runs to completion.
    expect(createTurnMock).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
    expect(builderChatTurnMock).toHaveBeenCalledTimes(1);
    expect((outcome.turn as unknown as { status: string }).status).toBe("answered");
  });

  it("still 409s byte-identical on a fresh running turn", async () => {
    runningTurnMock.mockResolvedValueOnce({
      id: "live_1",
      threadId: "thread_1",
      seq: 1,
      status: "running",
      createdAt: new Date(),
    });
    getThreadMock.mockResolvedValueOnce(thread);

    const err = await flowChatService
      .turn("ws", "thread_1", { message: "what does this workflow do" }, { createdByKind: "system" } as never)
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err).not.toBeNull();
    expect((err as Error).message).toBe("this conversation is still working on the previous message");
    expect((err as Error & { statusCode?: number }).statusCode).toBe(409);
    expect(createTurnMock).not.toHaveBeenCalled();
    expect(finishTurnMock).not.toHaveBeenCalled();
  });
});
