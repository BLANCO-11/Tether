/**
 * Whose account a workflow acts as (run-as.service.ts, plugins 8.6). ⚠ What is pinned: a test run may act as only the
 * person who started it, a live run as only the workflow's CURRENT owner; a choice that stopped holding refuses the call
 * and never falls back; another person's connection is never offered; a change is a new revision; a removed connection
 * turns the workflows that run as it off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const GH = "@activepieces/piece-github";
type Conn = { id: string; workspaceId: string; piece: string; label: string; secretName: string; ownerSubject: string | null };
const m = vi.hoisted(() => ({
  conns: [] as Conn[],
  exec: null as Record<string, unknown> | null,
  env: "draft" as "draft" | "live",
  flows: [] as Array<Record<string, unknown>>,
  revisions: {} as Record<string, unknown>,
  model: null as Record<string, unknown> | null,
  save: vi.fn(async () => ({ flowId: "f1", revision: 4 })),
  revoke: vi.fn(async () => ({})),
  chosen: null as string | null,
}));
vi.mock("./readiness.service.js", () => ({
  chosenAccount: async (_w: string, _s: string, _p: string, own: Conn[]) => own.find((c) => c.id === m.chosen) ?? null,
}));
vi.mock("../repositories/plugin.repo.js", () => ({
  pluginRepo: {
    getConnection: async (_w: string, id: string) => m.conns.find((c) => c.id === id),
    listConnections: async (_w: string, piece: string, viewer?: string | null) => m.conns.filter((c) => c.piece === piece && (!c.ownerSubject || c.ownerSubject === viewer)),
    // Nobody here has switched an action on for themselves (plans/personal-actions-2026-10-29).
    personalActions: async () => [],
  },
}));
vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: async () => [{ name: "github_create_issue", url: `plugin://${GH}@0.11.0/create_issue`, secretEnvName: "PLUGIN_GITHUB_TEAM" }] },
}));
vi.mock("../repositories/flow-execution.repo.js", () => ({ flowExecutionRepo: { get: async () => m.exec } }));
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: {
    get: async (_w: string, id: string) => m.flows.find((f) => f.id === id),
    listByWorkspace: async () => m.flows,
    getRevision: async (id: string, rev: number) => m.revisions[`${id}:${rev}`],
  },
}));
vi.mock("./execution-env.service.js", () => ({ envForExecution: async () => m.env }));
vi.mock("./pi-flow.service.js", () => ({
  forgeRefsOf: () => ["github_create_issue"],
  piFlowService: { load: async () => ({ flow: m.flows[0], revision: 3, model: m.model }), save: m.save },
}));
vi.mock("./flow-approval.service.js", () => ({ flowApprovalService: { revoke: m.revoke } }));
vi.mock("./plugin-connector.service.js", async (orig) => ({
  ...(await orig<typeof import("./plugin-connector.service.js")>()),
  connectorPieces: async () => [{ name: GH, displayName: "GitHub" }],
}));

import { actsAsOwner, actsAsSubjectOf, connectionForRun, effectiveAccounts, ownersOwn, runAsProblems, runAsView, setRunAs, suspendRunningAs, type PiRunAs } from "./run-as.service.js";

const team: Conn = { id: "c-team", workspaceId: "w", piece: GH, label: "Team", secretName: "PLUGIN_GITHUB_TEAM", ownerSubject: null };
const alice: Conn = { id: "c-alice", workspaceId: "w", piece: GH, label: "Alice's", secretName: "PLUGIN_GITHUB_ME_a", ownerSubject: "alice" };
const bob: Conn = { id: "c-bob", workspaceId: "w", piece: GH, label: "Bob's", secretName: "PLUGIN_GITHUB_ME_b", ownerSubject: "bob" };
const asAlice: PiRunAs = { connectionId: "c-alice", label: "Alice's", personal: true, service: "GitHub" };
const tool = { name: "github_create_issue", url: `plugin://${GH}@0.11.0/create_issue`, secretEnvName: "PLUGIN_GITHUB_TEAM" } as never;

beforeEach(() => {
  m.conns = [team, alice, bob];
  m.env = "draft";
  m.flows = [{ id: "f1", name: "Weekly issues", ownerSubject: "alice", armedRevision: null, runtime: "foundry" }];
  m.revisions = {};
  m.model = { workflow: { steps: [] }, files: {}, accounts: {} };
  m.save.mockClear();
  m.revoke.mockClear();
});

describe("a run's call goes through the connection it was approved to act as", () => {
  it("no choice recorded ⇒ the tool's own (the workspace's) connection", async () => {
    m.exec = { runnerJob: {}, requestedBySubject: "alice", flowId: "f1" };
    expect(await connectionForRun("w", "run-1", tool)).toEqual({});
  });
  it("⚠ a TEST run acts as a personal connection only of the person who started it", async () => {
    m.exec = { runnerJob: { runAs: { [GH]: asAlice } }, requestedBySubject: "alice", flowId: "f1" };
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ secretName: "PLUGIN_GITHUB_ME_a", actingSubject: "alice" });
    m.exec = { runnerJob: { runAs: { [GH]: asAlice } }, requestedBySubject: "bob", flowId: "f1" };
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/not the person who started this test/);
  });
  it("⚠ a LIVE run acts as it only while the workflow's CURRENT owner owns it — never falling back", async () => {
    m.env = "live";
    m.exec = { runnerJob: { runAs: { [GH]: asAlice } }, requestedBySubject: "someone-who-pressed-run", flowId: "f1" };
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ secretName: "PLUGIN_GITHUB_ME_a" });
    m.flows[0]!.ownerSubject = "bob"; // handed over
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/not the workflow's owner's/);
    m.flows[0]!.ownerSubject = "alice";
    m.conns = [team, bob]; // alice's connection removed
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/no longer exists/);
  });
  it("runAsProblems says what no longer holds for an owner", async () => {
    expect(await runAsProblems("w", { [GH]: asAlice }, "alice")).toEqual([]);
    expect(await runAsProblems("w", { [GH]: asAlice }, "bob")).toHaveLength(1);
    expect(await runAsProblems("w", undefined, null)).toEqual([]);
  });
});

describe("the workflow's page", () => {
  // Shared with the workspace: in My space there is no choice at all (Q3, below).
  beforeEach(() => {
    m.flows = [{ ...m.flows[0]!, visibility: "public" }];
  });
  it("⚠ offers the workspace's connection, plus the OWNER's own — never another person's, and not to a non-owner", async () => {
    const forAlice = await runAsView("w", "f1", "alice");
    expect(forAlice.owner).toBe(true);
    expect(forAlice.services[0]!.options.map((o) => o.connectionId)).toEqual(["c-team", "c-alice", ""]);
    const forBob = await runAsView("w", "f1", "bob");
    expect(forBob.services[0]!.options.map((o) => o.connectionId)).toEqual(["c-team", ""]);
  });
  it("a change is a NEW revision with the new choice; one not offered is refused", async () => {
    await setRunAs("w", "f1", GH, "c-alice", "alice", { createdBy: "alice", createdByKind: "user" } as never);
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ flowId: "f1", accounts: { [GH]: expect.objectContaining({ connectionId: "c-alice", personal: true }) } }));
    await expect(setRunAs("w", "f1", GH, "c-bob", "alice", {} as never)).rejects.toMatchObject({ statusCode: 403 });
    await expect(setRunAs("w", "f1", GH, "c-alice", "bob", {} as never)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("a connection removed", () => {
  it("turns off exactly the approved workflows that run as it", async () => {
    m.flows = [
      { id: "f1", name: "Uses alice", ownerSubject: "alice", armedRevision: 2, runtime: "foundry" },
      { id: "f2", name: "Uses team", ownerSubject: "alice", armedRevision: 1, runtime: "foundry" },
      { id: "f3", name: "Not approved", ownerSubject: "alice", armedRevision: null, runtime: "foundry" },
    ];
    m.revisions = { "f1:2": { modelJson: { accounts: { [GH]: asAlice } } }, "f2:1": { modelJson: { accounts: { [GH]: { ...asAlice, connectionId: "c-team", personal: false } } } } };
    expect(await suspendRunningAs("w", ["c-alice"], "gone", "admin")).toEqual(["Uses alice"]);
    expect(m.revoke).toHaveBeenCalledTimes(1);
    expect(m.revoke).toHaveBeenCalledWith("w", "f1", { reason: "gone", revokedBy: "admin" });
  });
});

describe("each person's own account (sharing-boundaries phase 3)", () => {
  const each: PiRunAs = { connectionId: "", label: "Each person", personal: false, service: "GitHub", each: true };

  it("⚠ a run uses the OWN connection of whoever started it — never the owner's, never the workspace's", async () => {
    m.env = "live";
    m.exec = { runnerJob: { runAs: { [GH]: each } }, requestedBySubject: "bob", flowId: "f1" };
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ secretName: "PLUGIN_GITHUB_ME_b", actingSubject: "bob" });
    m.exec = { runnerJob: { runAs: { [GH]: each } }, requestedBySubject: "alice", flowId: "f1" };
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ secretName: "PLUGIN_GITHUB_ME_a", actingSubject: "alice" });
  });

  it("refuses, sending nothing, with no person behind the run, with no own connection, and with two to choose from", async () => {
    m.exec = { runnerJob: { runAs: { [GH]: each } }, requestedBySubject: null, flowId: "f1" };
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/nobody started this run/);
    m.exec = { runnerJob: { runAs: { [GH]: each } }, requestedBySubject: "carol", flowId: "f1" };
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/you have not connected one/);
    m.conns = [...m.conns, { ...bob, id: "c-bob2", label: "Bob's other" }];
    m.exec = { runnerJob: { runAs: { [GH]: each } }, requestedBySubject: "bob", flowId: "f1" };
    m.chosen = null;
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/2 GitHub accounts of your own .* have not chosen/);
    // Once he has said which (phase 4, P3-I1), his runs use it.
    m.chosen = "c-bob2";
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ label: "Bob's other", actingSubject: "bob" });
  });

  it("is offered only once the workflow is shared, and chosen as a new revision", async () => {
    expect((await runAsView("w", "f1", "alice")).services[0]!.options.some((o) => o.each)).toBe(false);
    await expect(setRunAs("w", "f1", GH, "each", "alice", {} as never)).rejects.toMatchObject({ statusCode: 409 });
    m.flows = [{ ...m.flows[0]!, visibility: "public" }];
    expect((await runAsView("w", "f1", "alice")).services[0]!.options.at(-1)).toMatchObject({ each: true });
    await setRunAs("w", "f1", GH, "each", "alice", {} as never);
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ accounts: { [GH]: expect.objectContaining({ each: true }) } }));
  });

  it("an owner check has nothing to say about it, and the run records who it acted as", async () => {
    expect(await runAsProblems("w", { [GH]: each }, "alice")).toEqual([]);
    expect(actsAsSubjectOf({ [GH]: each }, { live: true, requester: "bob", owner: "alice" })).toBe("bob");
    expect(actsAsSubjectOf({ [GH]: asAlice }, { live: true, requester: "bob", owner: "alice" })).toBe("alice");
    expect(actsAsSubjectOf({ [GH]: asAlice }, { live: false, requester: "alice", owner: "alice" })).toBe("alice");
    expect(actsAsSubjectOf({ [GH]: { ...asAlice, personal: false, connectionId: "c-team" } }, { live: true, requester: "bob", owner: "alice" })).toBeNull();
    expect(actsAsOwner({ [GH]: asAlice })).toBe(true);
    expect(actsAsOwner({ [GH]: each })).toBe(false);
  });
});

describe("⚠ My space: always its owner's own account, no choice (sharing-boundaries Q3)", () => {
  const asTeam: PiRunAs = { connectionId: "c-team", label: "Team", personal: false, service: "GitHub" };
  const own = ownersOwn("GitHub");
  const mySpace = { visibility: "private", projectId: null, ownerSubject: "alice" };
  const model = (accounts: Record<string, PiRunAs>) => ({ workflow: { steps: [] }, files: {}, accounts });

  it("a stored workspace choice becomes its owner's own; one of the owner's own stands; outside My space nothing changes", async () => {
    expect(await effectiveAccounts("w", mySpace, model({ [GH]: asTeam }))).toEqual({ [GH]: own });
    expect(await effectiveAccounts("w", mySpace, model({}))).toEqual({ [GH]: expect.objectContaining({ own: true }) });
    expect(await effectiveAccounts("w", mySpace, model({ [GH]: asAlice }))).toEqual({ [GH]: asAlice });
    expect(await effectiveAccounts("w", { ...mySpace, visibility: "public" }, model({ [GH]: asTeam }))).toEqual({ [GH]: asTeam });
    expect(await effectiveAccounts("w", { ...mySpace, projectId: "p1" }, model({ [GH]: asTeam }))).toEqual({ [GH]: asTeam });
  });
  it("the page offers nothing to choose and says it uses its owner's own; a change is refused", async () => {
    m.model = model({ [GH]: asTeam });
    const v = await runAsView("w", "f1", "alice");
    expect(v.mySpace).toBe(true);
    expect(v.services[0]!.options).toEqual([]);
    expect(v.services[0]!.current).toMatchObject({ own: true });
    await expect(setRunAs("w", "f1", GH, "c-team", "alice", {} as never)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/My space/) });
    expect(m.save).not.toHaveBeenCalled();
  });
  it("⚠ a live run uses the OWNER's own connection, a test the tester's — never the workspace's", async () => {
    m.env = "live";
    m.exec = { runnerJob: { runAs: { [GH]: own } }, requestedBySubject: "bob", flowId: "f1" };
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ secretName: "PLUGIN_GITHUB_ME_a", actingSubject: "alice" });
    m.env = "draft";
    expect(await connectionForRun("w", "run-1", tool)).toMatchObject({ secretName: "PLUGIN_GITHUB_ME_b", actingSubject: "bob" });
    m.exec = { runnerJob: { runAs: { [GH]: own } }, requestedBySubject: "carol", flowId: "f1" };
    await expect(connectionForRun("w", "run-1", tool)).rejects.toThrow(/have not connected one/);
  });
  it("an owner check says when the owner has none of their own", async () => {
    expect(await runAsProblems("w", { [GH]: own }, "alice")).toEqual([]);
    expect(await runAsProblems("w", { [GH]: own }, "carol")).toEqual(["its owner has not connected their own GitHub account"]);
    expect(await runAsProblems("w", { [GH]: own }, null)).toHaveLength(1);
  });
});
