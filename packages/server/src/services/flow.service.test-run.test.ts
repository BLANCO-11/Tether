import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * `flowService.testRun` production opt-in (plan §4).
 *
 * Default: no new label, no audit, `usedProductionData: false`.
 * Opt-in: `foundry_use_prod: "1"` label for `begin` + one
 * `access`/`datasource` audit event, `usedProductionData: true`.
 * Kestra and every repository are mocked. No engine, no prod touch.
 */

const flowGet = vi.fn();
const revisionGet = vi.fn();
const workspaceGet = vi.fn();
const namespacesForMock = vi.fn();
const runRequestRecord = vi.fn();
const kestraStart = vi.fn();
const auditRecordMock = vi.fn();

vi.mock("../db/index.js", () => ({ db: {}, pool: {}, schema: {} }));
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: { get: (...a: unknown[]) => flowGet(...a), getRevision: (...a: unknown[]) => revisionGet(...a) },
}));
vi.mock("../repositories/workspace.repo.js", () => ({
  workspaceRepo: { get: (...a: unknown[]) => workspaceGet(...a) },
}));
vi.mock("./tenant-mapper.service.js", () => ({
  tenantMapper: { namespacesFor: (...a: unknown[]) => namespacesForMock(...a) },
}));
vi.mock("./run-requester.js", () => ({
  runRequesterRepo: { record: (...a: unknown[]) => runRequestRecord(...a) },
  systemRequester: (actor: string) => ({ subject: null, actor, kind: "system" }),
  requesterOf: () => ({ subject: "u-1", actor: "ada@example.com", kind: "user" }),
}));
vi.mock("./kestra-client.service.js", () => ({
  kestra: { startExecution: (...a: unknown[]) => kestraStart(...a) },
  KestraError: class KestraError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status = 500, body: unknown = null) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));
vi.mock("./audit.service.js", () => ({
  auditService: { record: (...a: unknown[]) => auditRecordMock(...a) },
}));

const { flowService } = await import("./flow.service.js");

const FLOW = {
  id: "flow-1",
  kestraFlowId: "hr-screening",
  draftRevision: 2,
  name: "Screening",
};

beforeEach(() => {
  flowGet.mockResolvedValue(FLOW);
  revisionGet.mockResolvedValue({ modelJson: { inputs: [{ id: "period", type: "STRING", format: "month" }] } });
  workspaceGet.mockResolvedValue({ id: "ws-1", slug: "hr" });
  namespacesForMock.mockReturnValue({
    live: { value: "foundry.acme.hr" },
    draft: { value: "foundry.acme.hr.draft" },
  });
  runRequestRecord.mockResolvedValue("req-1");
  kestraStart.mockResolvedValue({ id: "kex-1" });
  auditRecordMock.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("flowService.testRun production opt-in", () => {
  it("defaults to a mock run: no label, no audit, flag false", async () => {
    const out = await flowService.testRun("ws-1", "flow-1", {});
    expect(kestraStart).toHaveBeenCalledWith(
      { value: "foundry.acme.hr.draft" },
      "hr-screening",
      {},
      {
        foundry_flow: "flow-1",
        foundry_revision: "2",
        foundry_env: "draft",
        foundry_run_request: "req-1",
      },
    );
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(out.usedProductionData).toBe(false);
    expect(out.revision).toBe(2);
  });

  it("opt-in forwards the begin label and audits access/datasource", async () => {
    const out = await flowService.testRun(
      "ws-1",
      "flow-1",
      {},
      { subject: "u-1", actor: "ada@example.com", kind: "user" },
      { useProductionData: true },
    );
    const labels = kestraStart.mock.calls[0]?.[3] as Record<string, string>;
    expect(labels.foundry_use_prod).toBe("1");
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
});

describe("flowService.testRun input check (phase 5 task 4, D-255)", () => {
  it("a malformed input is refused naming it — before any run request, audit or execution", async () => {
    await expect(flowService.testRun("ws-1", "flow-1", { period: "01/08/2026" })).rejects.toMatchObject({
      statusCode: 400,
      message: 'input "period" must be a month (YYYY-MM), got "01/08/2026"',
    });
    expect(runRequestRecord).not.toHaveBeenCalled();
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(kestraStart).not.toHaveBeenCalled();
  });
  it("CONTROL: a well-formed one runs", async () => {
    await flowService.testRun("ws-1", "flow-1", { period: "2026-06" });
    expect(kestraStart).toHaveBeenCalledTimes(1);
  });
});
