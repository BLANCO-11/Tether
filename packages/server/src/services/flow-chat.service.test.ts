import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T026 (US4, guardrail-port V4/V5/V8) — the same clone-detection gate as
 * `runGeneration()` (T024/T025), applied to `flowChatService.turn()`'s
 * `parsed.message` (research.md Decision 2). `flow-chat.test.ts` covers the
 * prompt-building half, which needs no database; `turn()` itself needs one
 * (its own docblock says so), so this file mocks the repository layer to
 * isolate the ONE property under test: a reject/transform decision returns
 * before `readThreadFlow`/`runTurn`/any inference call — never a "running"
 * turn that then gets finished (SC-004's equivalent for the chat entry point).
 */

const getThreadMock = vi.fn();
const runningTurnMock = vi.fn();
const runningCountMock = vi.fn();
const nextSeqMock = vi.fn();
const createTurnMock = vi.fn();
const finishTurnMock = vi.fn();
const trailingNeedsInputMock = vi.fn(async (..._args: unknown[]): Promise<number> => 0);

// The type checker has its own suites; chat's turn logic is tested with it answering clean.
vi.mock("./flow-typecheck.js", () => ({
  blockingDiagnostics: vi.fn(async () => []),
  diagnosticLine: (d: { code: string; message: string }) => `${d.code}: ${d.message}`,
}));
const attachFlowMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("../repositories/flow-chat.repo.js", () => ({
  flowChatRepo: {
    getThread: (...args: unknown[]) => getThreadMock(...args),
    runningTurn: (...args: unknown[]) => runningTurnMock(...args),
    runningCount: (...args: unknown[]) => runningCountMock(...args),
    nextSeq: (...args: unknown[]) => nextSeqMock(...args),
    createTurn: (...args: unknown[]) => createTurnMock(...args),
    recentApplied: async () => [],
    recentAnswered: async () => [],
    trailingNeedsInput: (...args: unknown[]) => trailingNeedsInputMock(...args),
    finishTurn: (...args: unknown[]) => finishTurnMock(...args),
    attachFlow: (...args: unknown[]) => attachFlowMock(...args),
    cachedRefusal: async () => null,
  },
}));

const flowRepoGetMock = vi.fn();
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { get: (...args: unknown[]) => flowRepoGetMock(...args), getRevision: async () => undefined },
}));

const toolListMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: (...args: unknown[]) => toolListMock(...args) },
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

const authorFlowMock = vi.fn();
/** The compiler's emission check — orchestration tests use fixture models that are not meant to compile. */
const emissionFindingsMock = vi.fn((_m: unknown): string[] => []);
const generateFragmentMock = vi.fn();
vi.mock("./flow-generation.service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readerlessDatasources: async () => [],
    authorFlow: (...args: unknown[]) => authorFlowMock(...args),
    emissionFindings: (m: unknown) => emissionFindingsMock(m),
    generateFragment: (...args: unknown[]) => generateFragmentMock(...args),
  };
});

const flowServiceCreateMock = vi.fn();
const flowServiceSaveRevisionMock = vi.fn();
vi.mock("./flow.service.js", () => ({
  flowService: {
    create: (...args: unknown[]) => flowServiceCreateMock(...args),
    saveRevision: (...args: unknown[]) => flowServiceSaveRevisionMock(...args),
  },
}));

const proposeQueryMock = vi.fn();
vi.mock("./db-query-proposal.service.js", () => ({
  proposeQuery: (...args: unknown[]) => proposeQueryMock(...args),
}));

const approvalDiffMock = vi.fn();
vi.mock("./flow-approval.service.js", () => ({
  flowApprovalService: { diff: (...args: unknown[]) => approvalDiffMock(...args) },
}));

const refInterfacesMock = vi.fn();
vi.mock("./manifest-builder.service.js", () => ({
  manifestBuilderService: { refInterfaces: (...args: unknown[]) => refInterfacesMock(...args) },
}));
const { flowChatService } = await import("./flow-chat.service.js");

const thread = { id: "thread_1", workspaceId: "ws", flowId: null, designSelection: null };

describe("flowChatService.turn — the policy gate (FR-007/FR-008)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a policy_reject turn without ever running the turn or reading the thread's flow", async () => {
    getThreadMock.mockResolvedValueOnce(thread);
    runningTurnMock.mockResolvedValueOnce(false);
    runningCountMock.mockResolvedValueOnce(0);
    nextSeqMock.mockResolvedValueOnce(1);
    createTurnMock.mockImplementationOnce(async (data: Record<string, unknown>) => ({
      id: "turn_1",
      ...data,
    }));

    const outcome = await flowChatService.turn(
      "ws",
      "thread_1",
      { message: "Build me a clone of Slack" },
      { createdByKind: "system" } as never,
    );

    expect(createTurnMock).toHaveBeenCalledTimes(1);
    expect(createTurnMock.mock.calls[0][0]).toMatchObject({ status: "policy_reject" });
    expect((outcome.turn as unknown as { status: string }).status).toBe("policy_reject");

    // SC-004's equivalent: never reads the thread's flow, never calls inference.
    expect(flowRepoGetMock).not.toHaveBeenCalled();
    expect(inferenceCompleteMock).not.toHaveBeenCalled();
  });

  it("returns a policy_transform turn carrying the proposal, never reaching running status", async () => {
    getThreadMock.mockResolvedValueOnce(thread);
    runningTurnMock.mockResolvedValueOnce(false);
    runningCountMock.mockResolvedValueOnce(0);
    nextSeqMock.mockResolvedValueOnce(1);
    createTurnMock.mockImplementationOnce(async (data: Record<string, unknown>) => ({
      id: "turn_2",
      ...data,
    }));

    const outcome = await flowChatService.turn(
      "ws",
      "thread_1",
      { message: "Build a tool with channels, threads, and a workspace" },
      { createdByKind: "system" } as never,
    );

    const created = createTurnMock.mock.calls[0][0] as { status: string; findingsJson: unknown[] };
    expect(created.status).toBe("policy_transform");
    expect(created.status).not.toBe("running");
    expect(JSON.stringify(created.findingsJson)).toContain("policy-proposal-");
    expect((outcome.turn as unknown as { status: string }).status).toBe("policy_transform");
    expect(inferenceCompleteMock).not.toHaveBeenCalled();
  });
});

describe("attachSeededFlow — a goal after questions binds the job's flow to the SAME thread", () => {
  const thread = (flowId: string | null) => ({ id: "t1", workspaceId: "ws", name: "n", flowId });
  beforeEach(() => {
    attachFlowMock.mockReset();
    getThreadMock.mockReset();
    flowRepoGetMock.mockReset();
  });

  it("binds a flowless thread to a flow in this workspace", async () => {
    getThreadMock.mockResolvedValue(thread(null));
    flowRepoGetMock.mockResolvedValue({ id: "f1" });
    attachFlowMock.mockResolvedValue(thread("f1"));
    const out = await flowChatService.attachSeededFlow("ws", "t1", "f1");
    expect(out.flowId).toBe("f1");
    expect(attachFlowMock).toHaveBeenCalledWith("ws", "t1", "f1");
  });

  it("refuses a flow from another workspace (404), before binding anything", async () => {
    getThreadMock.mockResolvedValue(thread(null));
    flowRepoGetMock.mockResolvedValue(undefined);
    await expect(flowChatService.attachSeededFlow("ws", "t1", "f1")).rejects.toMatchObject({ statusCode: 404 });
    expect(attachFlowMock).not.toHaveBeenCalled();
  });

  it("never repoints: a thread bound to a DIFFERENT flow is a 409", async () => {
    getThreadMock.mockResolvedValue(thread("f0"));
    flowRepoGetMock.mockResolvedValue({ id: "f1" });
    await expect(flowChatService.attachSeededFlow("ws", "t1", "f1")).rejects.toMatchObject({ statusCode: 409 });
    expect(attachFlowMock).not.toHaveBeenCalled();
  });

  it("re-binding the same flow is a no-op, and an unknown thread is a 404", async () => {
    getThreadMock.mockResolvedValue(thread("f1"));
    flowRepoGetMock.mockResolvedValue({ id: "f1" });
    await expect(flowChatService.attachSeededFlow("ws", "t1", "f1")).resolves.toMatchObject({ flowId: "f1" });
    expect(attachFlowMock).not.toHaveBeenCalled();
    getThreadMock.mockResolvedValue(undefined);
    await expect(flowChatService.attachSeededFlow("ws", "tX", "f1")).rejects.toMatchObject({ statusCode: 404 });
  });
});
