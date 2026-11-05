/**
 * An owner switches on their own automation, with no reviewer, only when it uses nothing but their own things
 * (flowApprovalService.enableOwn, plugins phase 9). ⚠ What is pinned, each control proven by turning it off:
 *   - a workspace resource cannot be switched on this way (the reach check);
 *   - only the owner may, and only where the workspace allows it;
 *   - an edit is classified afresh — a revision that adds a workspace resource is refused even after an own-only one
 *     was switched on;
 *   - at every live start: the workspace turning the setting off stops one already on; one a reviewer approved is
 *     untouched by the setting;
 *   - only a PRIVATE workflow (sharing-boundaries Q2): a shared one needs a reviewer, and sharing one already on stops
 *     it at its next live start.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const GH = "@activepieces/piece-github";
const m = vi.hoisted(() => ({
  flow: null as Record<string, unknown> | null,
  revisions: {} as Record<number, unknown>,
  ws: { selfEnable: true } as { selfEnable: boolean } | null,
  approval: null as Record<string, unknown> | null,
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
}));
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: {
    get: async () => m.flow,
    getRevision: async (_id: string, rev: number) => (m.revisions[rev] ? { revision: rev, modelJson: m.revisions[rev], createdByKind: "user", createdBy: "alice@x" } : undefined),
    revokeApprovals: async () => 0,
    insertApproval: async (row: Record<string, unknown>) => {
      m.inserted.push(row);
      return { id: "a1", ...row };
    },
    update: async (_id: string, patch: Record<string, unknown>) => {
      m.updated.push(patch);
      return { ...m.flow, ...patch };
    },
    currentApproval: async () => m.approval,
  },
}));
vi.mock("../repositories/workspace.repo.js", () => ({ workspaceRepo: { get: async () => m.ws } }));
vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: {
    listByWorkspace: async () => [
      { name: "llm_complete", url: "http://ops-api:4004/llm/complete" },
      { name: "github_create_issue", url: `plugin://${GH}@0.11.0/create_issue` },
    ],
  },
}));
vi.mock("../repositories/plugin.repo.js", () => ({
  pluginRepo: {
    getConnection: async (_w: string, id: string) => (id === "c-alice" ? { id, piece: GH, ownerSubject: "alice", label: "Mine" } : undefined),
    // Personal actions (0118) are read whenever plugins are configured; none here.
    personalActions: async () => [],
  },
}));
// The stored choice stands here; what My space does to it is run-as.service.test.ts's (sharing-boundaries phase 6).
vi.mock("./run-as.service.js", () => ({ runAsProblems: async () => [], effectiveAccounts: async (_ws: string, _flow: unknown, model: { accounts?: unknown }) => model?.accounts }));
vi.mock("../services/manifest-builder.service.js", () => ({
  manifestBuilderService: { refFingerprints: async () => ({ llm_complete: "x", github_create_issue: "y", "orders.open": "z" }), aggregateFingerprint: () => "fp" },
}));
vi.mock("./kestra-client.service.js", () => ({ kestra: {}, KestraError: class extends Error {} }));

import { flowApprovalService } from "./flow-approval.service.js";

const pi = (uses: string[], accounts?: Record<string, unknown>) => ({
  runtime: "foundry",
  workflow: { steps: [{ id: "s", entry: "s.py", uses }] },
  files: {},
  ...(accounts ? { accounts } : {}),
});
const mine = { [GH]: { connectionId: "c-alice", label: "Mine", personal: true, service: "GitHub" } };

beforeEach(() => {
  m.flow = { id: "f1", workspaceId: "w", name: "My digest", runtime: "foundry", ownerSubject: "alice", visibility: "private", draftRevision: 1, armedRevision: null };
  m.revisions = { 1: pi(["tool:llm_complete", "tool:github_create_issue"], mine), 2: pi(["tool:llm_complete", "read:orders"]) };
  m.ws = { selfEnable: true };
  m.approval = null;
  m.inserted = [];
  m.updated = [];
});

const enable = (subject = "alice", revision?: number) =>
  flowApprovalService.enableOwn("w", "f1", { subject, actor: `${subject}@x`, ...(revision ? { revision } : {}) });

describe("switching it on yourself", () => {
  it("an owner switches on a revision that uses only their own things — recorded as self-enabled", async () => {
    await enable();
    expect(m.inserted).toEqual([expect.objectContaining({ revision: 1, approverUserId: "alice@x", selfEnabled: true, selfApprovedOverride: false })]);
    expect(m.updated.at(-1)).toMatchObject({ armedRevision: 1, status: "approved" });
  });

  it("⚠ a revision that uses anything of the workspace's is refused, naming it — an edit is classified afresh", async () => {
    await enable();
    m.flow = { ...m.flow!, armedRevision: 1, draftRevision: 2 };
    await expect(enable("alice", 2)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/needs a reviewer.*reads the workspace's data/) });
    expect(m.inserted).toHaveLength(1);
  });

  it("⚠ only its owner", async () => {
    await expect(enable("bob")).rejects.toMatchObject({ statusCode: 403 });
    m.flow = { ...m.flow!, ownerSubject: null };
    await expect(enable("alice")).rejects.toMatchObject({ statusCode: 403 });
    expect(m.inserted).toHaveLength(0);
  });

  it("⚠ only where the workspace lets members do it", async () => {
    m.ws = { selfEnable: false };
    await expect(enable()).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/may not switch on their own/) });
    expect(m.inserted).toHaveLength(0);
  });

  it("⚠ only a private workflow — a shared one has a blast radius, so a reviewer approves it", async () => {
    m.flow = { ...m.flow!, visibility: "public" };
    await expect(enable()).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/shared with the workspace/) });
    expect(m.inserted).toHaveLength(0);
  });

  it("a workflow not built with Forge always needs a reviewer", async () => {
    m.flow = { ...m.flow!, runtime: "kestra" };
    await expect(enable()).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("⚠ at every live start", () => {
  beforeEach(() => {
    m.flow = { ...m.flow!, armedRevision: 1 };
  });
  it("one its owner switched on runs while the workspace allows it, and stops when it no longer does", async () => {
    m.approval = { revision: 1, selfEnabled: true, manifestFingerprint: "fp" };
    await expect(flowApprovalService.assertMayRunLive("w", m.flow as never)).resolves.toBe(1);
    m.ws = { selfEnable: false };
    await expect(flowApprovalService.assertMayRunLive("w", m.flow as never)).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/no longer lets members/) });
  });
  it("⚠ one its owner switched on stops once it is shared", async () => {
    m.approval = { revision: 1, selfEnabled: true, manifestFingerprint: "fp" };
    await expect(flowApprovalService.assertMayRunLive("w", m.flow as never)).resolves.toBe(1);
    m.flow = { ...m.flow!, visibility: "public" };
    await expect(flowApprovalService.assertMayRunLive("w", m.flow as never)).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/now shared/) });
  });
  it("one a reviewer approved is untouched by the setting", async () => {
    m.approval = { revision: 1, selfEnabled: false, manifestFingerprint: "fp" };
    m.ws = { selfEnable: false };
    await expect(flowApprovalService.assertMayRunLive("w", m.flow as never)).resolves.toBe(1);
  });
});
