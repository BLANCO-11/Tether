// src/services/flow-rearm.test.ts
//
// Re-arm without re-review: turning a flow off suspends firing, but the armed
// revision stays recorded — so turning it back on with nothing changed must
// succeed in one click, server-side, with no review round-trip.
//
// ⚠ `vi.mock` is a WHOLE-MODULE replacement. Everything `rearm` touches through
// these modules is mocked; anything else the service file imports loads real
// (as in `flow-publish-arms.test.ts`) and is never called on this path.
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const currentApproval = vi.fn();
const listApprovals = vi.fn();
const getRevision = vi.fn();
const insertApproval = vi.fn();
const update = vi.fn();
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: {
    get: (...a: unknown[]) => get(...a),
    currentApproval: (...a: unknown[]) => currentApproval(...a),
    listApprovals: (...a: unknown[]) => listApprovals(...a),
    getRevision: (...a: unknown[]) => getRevision(...a),
    insertApproval: (...a: unknown[]) => insertApproval(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

const refFingerprints = vi.fn();
const aggregateFingerprint = vi.fn();
vi.mock("../services/manifest-builder.service.js", () => ({
  manifestBuilderService: {
    refFingerprints: (...a: unknown[]) => refFingerprints(...a),
    aggregateFingerprint: (...a: unknown[]) => aggregateFingerprint(...a),
  },
}));

const refsOf = vi.fn();
const compile = vi.fn();
vi.mock("./flow-compiler.service.js", () => ({
  flowCompiler: {
    refsOf: (...a: unknown[]) => refsOf(...a),
    compile: (...a: unknown[]) => compile(...a),
  },
  FlowCompileError: class FlowCompileError extends Error {},
}));

const namespaces = vi.fn();
const assertKestraAccepts = vi.fn();
vi.mock("./flow.service.js", () => ({
  flowService: {
    namespaces: (...a: unknown[]) => namespaces(...a),
    assertKestraAccepts: (...a: unknown[]) => assertKestraAccepts(...a),
  },
}));

const deployFlow = vi.fn();
vi.mock("./kestra-client.service.js", () => ({
  kestra: { deployFlow: (...a: unknown[]) => deployFlow(...a) },
  KestraError: class KestraError extends Error {},
}));

// ⚠ Dynamic import is the exception the rule names: `vi.mock` registers before
// this line runs, and a static import would bind the REAL modules first.
// (Kept after every mock const: the factories above close over them.)
const listByFlow = vi.fn();
const triggerUpdate = vi.fn();
vi.mock("../repositories/trigger.repo.js", () => ({
  triggerRepo: {
    listByFlow: (...a: unknown[]) => listByFlow(...a),
    update: (...a: unknown[]) => triggerUpdate(...a),
  },
}));

const flowEnableReadiness = vi.fn();
vi.mock("./flow-arm-readiness.js", () => ({
  flowEnableReadiness: (...a: unknown[]) => flowEnableReadiness(...a),
}));

const ensureApiAddress = vi.fn();
vi.mock("./flow-api-address.js", () => ({
  ensureApiAddress: (...a: unknown[]) => ensureApiAddress(...a),
}));

// ⚠ Dynamic import is the exception the rule names: `vi.mock` registers before
// this line runs, and a static import would bind the REAL modules first.
// (Placed after every mock const: the factories above close over them.)
const { flowApprovalService } = await import("./flow-approval.service.js");

// A flow turned off at revision 2: trigger gone, approvals closed, revision recorded.
const flow = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  workspaceId: "w1",
  name: "Chase overdue invoices",
  kestraFlowId: "k1",
  draftRevision: 2,
  armedRevision: 2,
  status: "suspended",
  ...over,
});
const model = (over: Record<string, unknown> = {}) => ({
  id: "k1",
  steps: [],
  schedule: { cron: "0 7 * * 1" },
  ...over,
});
const revisionRow = (over: Record<string, unknown> = {}) => ({
  modelJson: model(),
  createdByKind: "user",
  ...over,
});
// The revoked approval: closed by timestamp, never deleted — the audit trail.
const priorApproval = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  flowId: "f1",
  revision: 2,
  approverUserId: "reviewer@example.com",
  manifestFingerprint: "FP",
  revokedAt: new Date("2026-09-10T10:00:00Z"),
  revokedReason: "Turned off from the flows list",
  staleAt: null,
  ...over,
});

beforeEach(() => {
  for (const fn of [
    get,
    currentApproval,
    listApprovals,
    getRevision,
    insertApproval,
    update,
    refFingerprints,
    aggregateFingerprint,
    refsOf,
    compile,
    namespaces,
    assertKestraAccepts,
    deployFlow,
    listByFlow,
    triggerUpdate,
    flowEnableReadiness,
    ensureApiAddress,
  ])
    fn.mockReset();
  get.mockResolvedValue(flow());
  currentApproval.mockResolvedValue(undefined);
  listApprovals.mockResolvedValue([priorApproval()]);
  getRevision.mockResolvedValue(revisionRow());
  refsOf.mockReturnValue(["tool:mail_send"]);
  refFingerprints.mockResolvedValue({ "tool:mail_send": "fp1" });
  aggregateFingerprint.mockReturnValue("FP");
  namespaces.mockResolvedValue({ live: "live-ns", draft: "draft-ns" });
  compile.mockReturnValue({ yaml: "id: k1\n", hash: "h" });
  assertKestraAccepts.mockResolvedValue(undefined);
  deployFlow.mockResolvedValue(undefined);
  listByFlow.mockResolvedValue([]);
  flowEnableReadiness.mockResolvedValue({ ready: true, reason: null });
  ensureApiAddress.mockResolvedValue(undefined);
  insertApproval.mockImplementation(async (row: unknown) => ({ id: "a2", approvedAt: new Date(), ...(row as object) }));
  update.mockImplementation(async (_id: unknown, patch: unknown) => ({ ...flow(), ...(patch as object) }));
});

describe("rearm — one click back on, drafts do not block it", () => {
  it("redeploys the SAME revision, records a new row, and reports armed", async () => {
    const out = await flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" });
    // The live namespace gets the identical revision back, WITH its schedule.
    expect(deployFlow).toHaveBeenCalledTimes(1);
    expect(deployFlow.mock.calls[0]![0]).toBe("live-ns");
    expect(deployFlow.mock.calls[0]![1]).toBe("k1");
    // A new row about the same revision — the revoked one is untouched history.
    expect(insertApproval).toHaveBeenCalledTimes(1);
    const row = insertApproval.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.revision).toBe(2);
    expect(row.manifestFingerprint).toBe("FP");
    expect(row.approverUserId).toBe("op@example.com");
    expect(row.revisionAuthorKind).toBe("user");
    // Status follows the model: a cron means a deployed Schedule trigger.
    expect(update).toHaveBeenCalledWith("f1", { armedRevision: 2, status: "armed" });
    expect(out.flow.status).toBe("armed");
    expect(out.firing.schedule).toBe("0 7 * * 1");
  });

  it("a schedule-less flow comes back as approved, not armed", async () => {
    getRevision.mockResolvedValue(revisionRow({ modelJson: model({ schedule: undefined }) }));
    const out = await flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" });
    expect(update).toHaveBeenCalledWith("f1", { armedRevision: 2, status: "approved" });
    expect(out.flow.status).toBe("approved");
  });

  it("an approval that is somehow still OPEN is redeployed, not doubled", async () => {
    // Defensive: revoke always closes, but if a row slipped through, stacking a
    // second open row would leave `currentApproval` to disambiguate two live
    // answers. Redeploy into the open state instead.
    const open = { ...priorApproval(), id: "a0", revokedAt: null, revokedReason: null };
    currentApproval.mockResolvedValue(open);
    const out = await flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" });
    expect(deployFlow).toHaveBeenCalledTimes(1);
    expect(insertApproval).not.toHaveBeenCalled();
    expect(out.approval).toBe(open);
  });

  it("the re-armer may be the author — the content was already reviewed", async () => {
    // ⚠ Perturbation: re-applying approve's self-approval refusal here turns
    // this red — and takes one-click re-arm down on every single-operator
    // deployment, where the author is the only person who could click.
    getRevision.mockResolvedValue(
      revisionRow({ modelJson: model(), createdByKind: "user" }),
    );
    const out = await flowApprovalService.rearm("w1", "f1", { rearmedBy: "author@example.com" });
    expect(out.flow.status).toBe("armed");
  });

  it("arms the APPROVED revision when the draft moved on — the draft is untouched", async () => {
    // Suspend/resume is orthogonal to drafts: edits since turn-off stay an
    // unapproved draft needing their own review, and must neither block the
    // resume nor ride along silently.
    get.mockResolvedValue(flow({ draftRevision: 3 }));
    const out = await flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" });
    expect(out.flow.status).toBe("armed");
    // The APPROVED revision's model is what loads and deploys — never the draft's.
    expect(getRevision).toHaveBeenCalledWith("f1", 2);
    expect(deployFlow).toHaveBeenCalledTimes(1);
    expect(insertApproval).toHaveBeenCalled();
    // `armedRevision` resumes at 2; `draftRevision` is never written back.
    expect(update).toHaveBeenCalledWith("f1", expect.objectContaining({ armedRevision: 2 }));
    const patch = update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("draftRevision");
  });
});

describe("rearm — 409 whenever a person needs to look", () => {

  it("refuses when a referenced tool changed shape since approval", async () => {
    // The fingerprint is recomputed from the CURRENT manifest — the stored one
    // proves what was reviewed, and drift between them is exactly "changed".
    aggregateFingerprint.mockReturnValue("FP-CHANGED");
    await expect(flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deployFlow).not.toHaveBeenCalled();
    expect(insertApproval).not.toHaveBeenCalled();
  });

  it("refuses when a referenced thing no longer exists", async () => {
    refFingerprints.mockResolvedValue({});
    await expect(flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deployFlow).not.toHaveBeenCalled();
  });

  it("refuses a sweep suspension — staleness is a fault, not a turn-off", async () => {
    listApprovals.mockResolvedValue([priorApproval({ staleAt: new Date(), staleReason: "tool changed shape" })]);
    await expect(flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deployFlow).not.toHaveBeenCalled();
  });

  it("refuses when nothing was ever approved for the armed revision", async () => {
    listApprovals.mockResolvedValue([]);
    await expect(flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deployFlow).not.toHaveBeenCalled();
  });

  it("refuses a flow that was never armed — 409, so the client routes to review", async () => {
    get.mockResolvedValue(flow({ armedRevision: null, draftRevision: 1, status: "draft" }));
    await expect(flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(deployFlow).not.toHaveBeenCalled();
  });

  it("a missing flow is a 404, not a review refusal", async () => {
    get.mockResolvedValue(undefined);
    await expect(flowApprovalService.rearm("w1", "f1", { rearmedBy: "op@example.com" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
