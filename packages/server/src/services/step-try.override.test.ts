import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Step-try production opt-in (plan §4) — same branches as the run path.
 *
 * Default: draft + mock, no audit. Opt-in (`datasource`/`query`): override
 * threaded to the executor plus one `access`/`datasource` audit event.
 * `tool` ignores the flag: no second decision, no audit.
 */

const toolMock = vi.fn();
const datasourceMock = vi.fn();
const operationMock = vi.fn();
const auditRecordMock = vi.fn();

vi.mock("./step-execution.service.js", () => ({
  stepExecutionService: {
    tool: (...a: unknown[]) => toolMock(...a),
    datasource: (...a: unknown[]) => datasourceMock(...a),
    operation: (...a: unknown[]) => operationMock(...a),
  },
}));
vi.mock("./audit.service.js", () => ({
  auditService: { record: (...a: unknown[]) => auditRecordMock(...a) },
}));

const { stepTryService } = await import("./step-try.service.js");

const MOCK_RESULT = {
  results: [{ ok: true, data: [{ id: 1 }] }],
  succeeded: 1,
  failed: 0,
  warnings: [] as string[],
  readFrom: "mock" as const,
};

beforeEach(() => {
  toolMock.mockResolvedValue({ ...MOCK_RESULT, readFrom: undefined });
  datasourceMock.mockResolvedValue({ ...MOCK_RESULT });
  operationMock.mockResolvedValue({ ...MOCK_RESULT });
  auditRecordMock.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("step-try production opt-in", () => {
  it("defaults to mock with no audit", async () => {
    const out = await stepTryService.tryStep("ws-1", {
      stepKind: "datasource",
      ref: "hr_demo.active_users",
      params: { period: "2026-06" },
    });
    expect(datasourceMock).toHaveBeenCalledWith(
      "ws-1",
      { ref: "hr_demo.active_users", params: [{ period: "2026-06" }] },
      "draft",
      { workspaceId: "ws-1", useProdOverride: false },
    );
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(out.readFrom).toBe("mock");
    expect(out.usedProductionData).toBeUndefined();
  });

  it("opt-in threads the override and records access/datasource", async () => {
    datasourceMock.mockResolvedValue({
      ...MOCK_RESULT,
      readFrom: "production" as const,
      usedProductionData: true as const,
    });
    const out = await stepTryService.tryStep(
      "ws-1",
      {
        stepKind: "datasource",
        ref: "hr_demo.active_users",
        params: {},
        useProductionData: true,
      },
      { actor: "ada@example.com" },
    );
    expect(datasourceMock).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ ref: "hr_demo.active_users" }),
      "draft",
      { workspaceId: "ws-1", useProdOverride: true },
    );
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        actor: "ada@example.com",
        operation: "access",
        entity: "datasource",
      }),
    );
    expect(out.usedProductionData).toBe(true);
  });

  it("opt-in on an operation threads the override too", async () => {
    await stepTryService.tryStep("ws-1", {
      stepKind: "query",
      ref: "hr_demo.headcount",
      params: {},
      useProductionData: true,
    });
    expect(operationMock).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ ref: "hr_demo.headcount" }),
      "draft",
      { workspaceId: "ws-1", useProdOverride: true },
    );
    expect(auditRecordMock).toHaveBeenCalledTimes(1);
  });

  it("tool ignores the flag: no override, no audit", async () => {
    const out = await stepTryService.tryStep("ws-1", {
      stepKind: "tool",
      ref: "mail_send",
      params: {},
      useProductionData: true,
    });
    expect(toolMock).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ ref: "mail_send" }),
    );
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(out.usedProductionData).toBeUndefined();
  });

  it("carries frozen sql and datasourceRef into the batch", async () => {
    await stepTryService.tryStep("ws-1", {
      stepKind: "datasource",
      ref: "hr_demo.active_users",
      params: {},
      sql: "SELECT 1",
      datasourceRef: "hr_demo",
    });
    expect(datasourceMock).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ sql: "SELECT 1", datasourceRef: "hr_demo" }),
      "draft",
      expect.anything(),
    );
  });
});
