/**
 * Forge Agent proposals through the chat service: Forge PROPOSES (its conversation key, mid-answer, Forge Agent only),
 * the PERSON decides (only the one Forge was answering, only once). The rules themselves are agent-changes.test.ts.
 */
process.env.PI_MODEL ??= "test-model"; // readyForTurn refuses a turn with no model configured (no built-in default since a1182c5).
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  // Before config loads: connected services are on in this deployment (the connector is configured).
  process.env.PLUGINS_CONNECTOR_URL = "http://connector.invalid:4010";
  process.env.PLUGINS_CONNECTOR_SECRET = "test-only";
  return {
    allowed: { ok: true } as { ok: true } | { ok: false; why: string },
    perform: vi.fn(),
    may: { me: true, workspace: "needs an Admin" } as Record<string, true | string>,
    applyWorkspace: vi.fn(async () => undefined),
    applyMine: vi.fn(async () => undefined),
    // What connection-choice.ts answers: one connection to use, or several to ask about.
    resolve: { kind: "use", account: { connectionId: "c-ws", label: "Team", personal: false, identity: null, secretName: "PLUGIN_AZDO_TEAM" } } as Record<string, unknown>,
    options: [{ connectionId: "c-ws", label: "Team", personal: false, identity: null, secretName: "PLUGIN_AZDO_TEAM" }] as Array<Record<string, unknown>>,
    conns: {} as Record<string, { id: string; piece: string; ownerSubject: string | null }>,
  };
});
vi.mock("./connection-choice.js", () => ({
  resolveAccount: async () => m.resolve,
  accountOptions: async () => m.options,
  accountLine: (a: { label: string }) => `“${a.label}”`,
  askMessage: () => "Nothing was done: choose on the card",
}));
vi.mock("../repositories/plugin.repo.js", () => ({ pluginRepo: { getConnection: async (_w: string, id: string) => m.conns[id] } }));
vi.mock("../repositories/tool.repo.js", () => ({ toolRepo: { listByWorkspace: async () => [] } }));
vi.mock("../repositories/workspace.repo.js", () => ({ workspaceRepo: { get: async () => ({ assistant: true, agentChanges: true }) } }));
vi.mock("./agent-grants.js", () => ({
  actionsFor: async () => [],
  applyMine: m.applyMine,
  applyWorkspace: m.applyWorkspace,
  connectedServices: async () => [],
  serviceLine: () => "",
  findAction: async () => ({
    piece: { name: "@activepieces/piece-github", displayName: "GitHub", version: "0.11.0", actions: [] },
    action: { name: "create_or_update_file", displayName: "Create or Update File", description: "Commits a file", writes: true, destructive: false, unsupported: [] },
  }),
  grantTools: async () => [],
  mayDecide: async (_w: string, _i: unknown, _p: string, scope: string) => m.may[scope],
  neverFromChat: () => null,
  workspaceConnection: async () => ({ label: "Team GitHub", lastTestOk: true, lastTestMessage: "Connected as BLANCO-11" }),
}));
vi.mock("../services/personal-actions.js", () => ({
  isPersonalTool: () => false,
  mayRunThrough: async () => true,
  ownConnections: async () => [],
  personalTools: async () => [],
}));
vi.mock("./agent-changes.js", () => ({
  MAX_PROPOSALS_PER_TURN: 5,
  changesAllowed: async () => m.allowed,
  proposable: async (_w: string, tool: string) => ({ tool: { name: tool, url: "plugin://@activepieces/piece-azure-devops@1.0.0/update_work_item" }, action: { displayName: "Update Work Item" }, connector: "Azure DevOps" }),
  checkValues: async () => undefined,
  performConfirmed: (...a: unknown[]) => m.perform(...a),
  outcomeLine: (p: { status: string; summary: string }) => `outcome: ${p.status} ${p.summary}`,
}));
vi.mock("../services/edge-device.service.js", () => ({
  edgeDeviceService: {
    approveJob: vi.fn(async () => ({ id: "ej1", status: "approved" })),
    rejectJob: vi.fn(async () => ({ id: "ej1", status: "revoked" })),
    waitForJob: vi.fn(async () => ({
      id: "ej1",
      status: "succeeded",
      kind: "run_command",
      payload: { command: "mkdir x" },
      error: null,
      result: { exitCode: 0, stdout: "", stderr: "" },
    })),
    getJob: vi.fn(async () => ({
      id: "ej1",
      status: "succeeded",
      kind: "run_command",
      payload: { command: "mkdir x" },
      error: null,
      result: { exitCode: 0, stdout: "", stderr: "" },
    })),
  },
}));
vi.mock("../services/edge-trust.service.js", () => ({
  applyEdgeAlways: vi.fn(async () => undefined),
}));

import { __sessionsForTests, buildPrompt, piBuilderService, proposeChange, proposeSetting } from "./service.js";

const WS = "ws-1";
const ASKER = { subject: "person-1", name: "Himanshu" };
function session(over: Record<string, unknown> = {}) {
  const s = {
    id: "sess-1",
    workspaceId: WS,
    chatId: null,
    scrub: (t: string) => t,
    mode: "agent",
    abort: new AbortController() as AbortController | null,
    bus: new EventEmitter(),
    messages: [{ id: "u1", role: "user", text: "close my task", at: "", by: ASKER }],
    proposals: [] as unknown[],
    proposalOutcomes: [] as string[],
    accounts: {} as Record<string, unknown>,
    reader: { subject: ASKER.subject },
    requester: { subject: ASKER.subject },
    pendingEdgeContinues: [] as unknown[],
    edgeFlushTimer: null as ReturnType<typeof setTimeout> | null,
    edgeContinued: new Set<string>(),
    testing: false,
    compacting: false,
    status: "ready",
    ...over,
  };
  __sessionsForTests.sessions.set(s.id, s);
  __sessionsForTests.toolTokens.set("tok", s.id);
  return s;
}
beforeEach(() => {
  m.may = { me: true, workspace: "needs an Admin" };
  m.applyWorkspace.mockClear();
  m.applyMine.mockClear();
  __sessionsForTests.sessions.clear();
  __sessionsForTests.toolTokens.clear();
  m.allowed = { ok: true };
  m.perform.mockReset();
  m.resolve = { kind: "use", account: { connectionId: "c-ws", label: "Team", personal: false, identity: null, secretName: "PLUGIN_AZDO_TEAM" } };
  m.options = [{ connectionId: "c-ws", label: "Team", personal: false, identity: null, secretName: "PLUGIN_AZDO_TEAM" }];
  m.conns = {};
});

describe("Forge proposes", () => {
  it("a change is STORED with the exact values, and Forge is told it is not done", async () => {
    const s = session();
    const r = await proposeChange("tok", "azure_devops_update_work_item", { work_item_id: 2688, state: "Closed" }, "Close work item 2688");
    expect(r.message).toMatch(/NOT done/);
    expect(s.proposals).toEqual([expect.objectContaining({ tool: "azure_devops_update_work_item", params: { work_item_id: 2688, state: "Closed" }, status: "pending", summary: "Close work item 2688" })]);
    expect(m.perform).not.toHaveBeenCalled();
  });
  it("⚠ refused outside an answer, in Workflow Builder, with no key, where the workspace does not allow it, and past five", async () => {
    session({ abort: null });
    await expect(proposeChange("tok", "t", {}, "Close it")).rejects.toMatchObject({ statusCode: 409 });
    session({ mode: "workflow" });
    await expect(proposeChange("tok", "t", {}, "Close it")).rejects.toMatchObject({ statusCode: 403 });
    await expect(proposeChange("nope", "t", {}, "Close it")).rejects.toMatchObject({ statusCode: 401 });
    session();
    m.allowed = { ok: false, why: "not allowed here" };
    await expect(proposeChange("tok", "t", {}, "Close it")).rejects.toThrow(/not allowed here/);
    m.allowed = { ok: true };
    for (let i = 0; i < 5; i++) await proposeChange("tok", "t", { i }, `Change ${i}`);
    await expect(proposeChange("tok", "t", {}, "One more")).rejects.toMatchObject({ statusCode: 409 });
    await expect(proposeChange("tok", "t", {}, "")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("the person decides", () => {
  const withProposal = () => {
    const s = session({ abort: null });
    s.messages.push({ id: "a1", role: "assistant", text: "proposed", at: "", proposals: [{ id: "p1", tool: "t", connector: "Azure DevOps", action: "x", summary: "Close 2688", params: { id: 2688 }, status: "pending", at: "" }] } as never);
    return s;
  };
  it("⚠ only the person Forge was answering may confirm it", async () => {
    withProposal();
    await expect(piBuilderService.decideProposal(WS, "sess-1", "p1", "run", { subject: "someone-else" })).rejects.toMatchObject({ statusCode: 403 });
    expect(m.perform).not.toHaveBeenCalled();
  });
  it("their click runs it ONCE; a second click is refused; Forge hears the outcome next turn", async () => {
    const s = withProposal();
    m.perform.mockResolvedValueOnce({ status: "done", result: "{}", via: "workspace" });
    const p = await piBuilderService.decideProposal(WS, "sess-1", "p1", "run", { subject: ASKER.subject, email: "h@example.com" });
    expect(p).toMatchObject({ status: "done", decidedBy: "h@example.com" });
    expect(m.perform).toHaveBeenCalledOnce();
    await expect(piBuilderService.decideProposal(WS, "sess-1", "p1", "run", { subject: ASKER.subject })).rejects.toMatchObject({ statusCode: 409 });
    expect(m.perform).toHaveBeenCalledOnce();
    expect(s.proposalOutcomes).toEqual(["outcome: done Close 2688"]);
  });
  it("declining performs nothing and tells Forge", async () => {
    const s = withProposal();
    const p = await piBuilderService.decideProposal(WS, "sess-1", "p1", "decline", { subject: ASKER.subject });
    expect(p.status).toBe("declined");
    expect(m.perform).not.toHaveBeenCalled();
    expect(s.proposalOutcomes).toEqual(["outcome: declined Close 2688"]);
  });
  it("a rule that stopped holding at the click (setting off) is a failed card, nothing done", async () => {
    withProposal();
    m.perform.mockRejectedValueOnce(new Error("This workspace lets Forge Agent read from connected services, not change them."));
    const p = await piBuilderService.decideProposal(WS, "sess-1", "p1", "run", { subject: ASKER.subject });
    expect(p).toMatchObject({ status: "failed", result: expect.stringMatching(/not change them/) });
  });
  it("an edge Approve after a Foundry continue (by.subject null) still works for the person", async () => {
    const s = session({ abort: null });
    s.messages.push(
      { id: "cont", role: "user", text: "(work on your computer finished)", at: "", by: { subject: null, name: "Foundry" } } as never,
      {
        id: "a-edge",
        role: "assistant",
        text: "This needs your approval before it runs on your computer.",
        at: "",
        proposals: [
          {
            id: "edge-1",
            kind: "edge",
            tool: "edge-run",
            connector: "mac",
            action: "Run a command",
            summary: "mkdir",
            params: { command: "mkdir x" },
            status: "pending",
            at: "",
            edge: { jobId: "ej1", deviceId: "d1", deviceName: "mac", kind: "run_command" },
          },
        ],
      } as never,
    );
    // Would 403 if asker matched the null-subject continue row.
    const p = await piBuilderService.decideProposal(WS, "sess-1", "edge-1", "run", { subject: ASKER.subject, email: "h@example.com" });
    expect(["running", "done"]).toContain(p.status);
    // Give the follow-up wait a tick: mock waitForJob settles immediately and should continue once.
    await new Promise((r) => setTimeout(r, 0));
    expect(s.edgeContinued.has("ej1") || p.status === "done").toBe(true);
  });
});

describe("what Forge is told each message", () => {
  const ws = { purpose: "Engineering work", assistant: true, files: [], plugins: ["azure_devops_update_work_item"] };
  it("who it is talking to, so 'my tasks' is not a guess", () => {
    const t = buildPrompt("list my open tasks", "", { ...ws, person: { name: "Himanshu Saini", email: "h@example.com" } }, "agent");
    expect(t).toMatch(/You are talking to Himanshu Saini <h@example\.com>\. "Me", "my"/);
  });
  it("⚠ propose where the workspace allows confirmed changes; read-only (and who can change that) where it does not", () => {
    expect(buildPrompt("x", "", { ...ws, changes: true }, "agent")).toMatch(/propose it with node tools\/propose-change\.mjs/);
    const ro = buildPrompt("x", "", { ...ws, changes: false }, "agent");
    expect(ro).not.toMatch(/propose-change/);
    expect(ro).toMatch(/read connected services, not change them/);
  });
  it("what became of its proposals since the last turn", () => {
    expect(buildPrompt("x", "", { ...ws, outcomes: ["The person confirmed \"Close 2688\" and it was DONE."] }, "agent")).toMatch(/Close 2688.*DONE/);
  });
});

describe("switching an action on (agent-grants.ts)", () => {
  const proposed = async () => {
    const s = session();
    await proposeSetting("tok", "github", "create_or_update_file", true, "Pushing the mockup needs it");
    const p = s.proposals[0] as { id: string; setting: Record<string, unknown> };
    (s as { abort: AbortController | null }).abort = null;
    s.messages.push({ id: "a1", role: "assistant", text: "asked", at: "", proposals: [p] } as never);
    return { s, p };
  };
  it("the card states what it allows, through whose connection, and which places THIS person may choose", async () => {
    const { p } = await proposed();
    expect(p).toMatchObject({ kind: "setting", summary: "Switch on GitHub · Create or Update File" });
    expect(p.setting).toMatchObject({
      on: true,
      effect: "changes",
      current: "off",
      connection: "Team GitHub (the workspace's connection)",
      identity: "Connected as BLANCO-11",
      scopes: { me: true, workspace: "needs an Admin" },
      reason: "Pushing the mockup needs it",
    });
  });
  it("⚠ 'for me' is the Apps page's \"For me\" call for the person who clicked, with no workspace change, Forge told", async () => {
    const { s, p } = await proposed();
    const out = await piBuilderService.decideProposal(WS, "sess-1", p.id, "run", { subject: ASKER.subject, email: "h@example.com" }, "me");
    expect(out).toMatchObject({ status: "done", scope: "me", result: expect.stringMatching(/on for h@example\.com now, through their own connection: every chat of theirs and the workflows they own/) });
    expect(m.applyMine).toHaveBeenCalledWith(WS, "@activepieces/piece-github", "create_or_update_file", true, { subject: ASKER.subject, email: "h@example.com" });
    expect(m.applyWorkspace).not.toHaveBeenCalled();
    expect(s.proposalOutcomes).toEqual(["outcome: done Switch on GitHub · Create or Update File"]);
  });
  it("⚠ a place the person may not choose is refused at the click, and nothing changes", async () => {
    const { s, p } = await proposed();
    await expect(piBuilderService.decideProposal(WS, "sess-1", p.id, "run", { subject: ASKER.subject }, "workspace")).rejects.toThrow(/needs an Admin/);
    expect(m.applyWorkspace).not.toHaveBeenCalled();
    expect(m.applyMine).not.toHaveBeenCalled();
    // Nor without a place at all.
    await expect(piBuilderService.decideProposal(WS, "sess-1", p.id, "run", { subject: ASKER.subject })).rejects.toMatchObject({ statusCode: 400 });
  });
  it("'the whole workspace' goes through Apps' own call when they may", async () => {
    m.may = { me: true, workspace: true };
    const { p } = await proposed();
    await piBuilderService.decideProposal(WS, "sess-1", p.id, "run", { subject: ASKER.subject }, "workspace");
    expect(m.applyWorkspace).toHaveBeenCalledWith(WS, "@activepieces/piece-github", "create_or_update_file", true, expect.objectContaining({ subject: ASKER.subject }));
    expect(m.applyMine).not.toHaveBeenCalled();
  });
  it("is Forge Agent's only, and only while it answers", async () => {
    session({ mode: "workflow" });
    await expect(proposeSetting("tok", "github", "create_or_update_file", true, "needed")).rejects.toMatchObject({ statusCode: 403 });
    session({ abort: null });
    await expect(proposeSetting("tok", "github", "create_or_update_file", true, "needed")).rejects.toMatchObject({ statusCode: 409 });
  });
  it("Forge is told it can ask to switch actions on, and which are on for this person", () => {
    const t = buildPrompt("x", "", { purpose: "", assistant: true, plugins: ["github_list_branches"], myTools: ["github_create_or_update_file"], settings: true }, "agent");
    expect(t).toMatch(/On for this person only, through their own account.*github_create_or_update_file/);
    expect(t).toMatch(/propose-setting\.mjs/);
  });
  it("⚠ Forge is told which services are connected EVEN WITH NO ACTION ON, so it never guesses a name", () => {
    const line = "azure-devops (Azure DevOps; your own connection “foundry-devops-connection”; no actions switched on yet)";
    const t = buildPrompt("check the plugins", "", { purpose: "", assistant: true, services: [line], settings: true }, "agent");
    expect(t).toContain(`Connected services you can use here: ${line}.`);
    expect(t).toMatch(/never guess one/);
    expect(buildPrompt("x", "", { purpose: "", assistant: true, services: [], settings: true }, "agent")).toMatch(/Connected services: none you can use/);
    // CONTROL: unread is not "none" — say nothing rather than "nothing is connected".
    expect(buildPrompt("x", "", { purpose: "", assistant: true, settings: true }, "agent")).not.toMatch(/Connected services/);
  });
});

describe("which account (plugins 8.5)", () => {
  const AZ = "@activepieces/piece-azure-devops";
  const ask = {
    kind: "ask",
    question: {
      piece: AZ,
      service: "Azure DevOps",
      options: [
        { connectionId: "c-ws", label: "Team", personal: false, identity: null },
        { connectionId: "c-me", label: "Mine", personal: true, identity: "Connected as me" },
      ],
    },
  };
  it("⚠ several connections and none chosen: nothing is proposed, a card asks, Forge is told to stop — once", async () => {
    const s = session();
    m.resolve = ask;
    await expect(proposeChange("tok", "azure_devops_update_work_item", { work_item_id: 1 }, "Close item one")).rejects.toThrow(/choose on the card/);
    await expect(proposeChange("tok", "azure_devops_update_work_item", { work_item_id: 2 }, "Close item two")).rejects.toThrow(/choose on the card/);
    expect(s.proposals).toHaveLength(1);
    expect(s.proposals[0]).toMatchObject({ kind: "account", status: "pending", choice: { piece: AZ } });
  });
  it("a proposal names the account it will go through", async () => {
    const s = session();
    await proposeChange("tok", "azure_devops_update_work_item", { work_item_id: 1 }, "Close item one");
    expect(s.proposals[0]).toMatchObject({ via: "workspace", account: { connectionId: "c-ws", label: "Team" } });
  });
  it("the person's pick is remembered on the chat; another person's connection, or one not offered, is refused", async () => {
    const card = { id: "a1", kind: "account", tool: "t", connector: "Azure DevOps", action: "Choose", summary: "Which?", params: {}, status: "pending", at: "", choice: ask.question };
    const s = session({ messages: [{ id: "u1", role: "user", text: "close it", at: "", by: ASKER }, { id: "r1", role: "assistant", text: "", at: "", proposals: [card] }] });
    m.conns = { "c-me": { id: "c-me", piece: AZ, ownerSubject: "someone-else" } };
    await expect(piBuilderService.decideProposal(WS, s.id, "a1", "run", { subject: ASKER.subject }, undefined, "c-me")).rejects.toThrow(/no longer/);
    await expect(piBuilderService.decideProposal(WS, s.id, "a1", "run", { subject: ASKER.subject }, undefined, "11111111-1111-1111-1111-111111111111")).rejects.toThrow(/Choose one/);
    m.conns = { "c-me": { id: "c-me", piece: AZ, ownerSubject: ASKER.subject } };
    const p = await piBuilderService.decideProposal(WS, s.id, "a1", "run", { subject: ASKER.subject }, undefined, "c-me");
    expect(p).toMatchObject({ status: "done", choice: { chosen: "c-me" } });
    expect((s.accounts as Record<string, { connectionId: string }>)[AZ]!.connectionId).toBe("c-me");
    expect(s.proposalOutcomes).toHaveLength(1);
  });
  it("⚠ the pick carries the job on: Forge's next reply starts at once, shown as the person's choice", async () => {
    const card = { id: "a2", kind: "account", tool: "t", connector: "Azure DevOps", action: "Choose", summary: "Which?", params: {}, status: "pending", at: "", choice: ask.question };
    const s = session({ abort: undefined, messages: [{ id: "u1", role: "user", text: "my open tasks", at: "", by: ASKER }, { id: "r1", role: "assistant", text: "", at: "", proposals: [card] }] });
    m.conns = { "c-me": { id: "c-me", piece: AZ, ownerSubject: ASKER.subject } };
    await piBuilderService.decideProposal(WS, s.id, "a2", "run", { subject: ASKER.subject, name: "Himanshu" }, undefined, "c-me");
    expect(s.messages.at(-1)).toMatchObject({ role: "user", text: "Use my own Azure DevOps “Mine”.", by: { subject: ASKER.subject } });
  });
  it("chosen while Forge is still answering: nothing new starts, the choice applies from its next call", async () => {
    const card = { id: "a3", kind: "account", tool: "t", connector: "Azure DevOps", action: "Choose", summary: "Which?", params: {}, status: "pending", at: "", choice: ask.question };
    const s = session({ messages: [{ id: "u1", role: "user", text: "my open tasks", at: "", by: ASKER }, { id: "r1", role: "assistant", text: "", at: "", proposals: [card] }] });
    m.conns = { "c-me": { id: "c-me", piece: AZ, ownerSubject: ASKER.subject } };
    await piBuilderService.decideProposal(WS, s.id, "a3", "run", { subject: ASKER.subject }, undefined, "c-me");
    expect(s.messages).toHaveLength(2);
  });
  it("a workflow save it stopped is not redone for them: the card says to press Save again", async () => {
    const card = { id: "a4", kind: "account", tool: "t", connector: "Azure DevOps", action: "Choose", summary: "Which?", params: {}, status: "pending", at: "", choice: { ...ask.question, purpose: "workflow" } };
    const s = session({ abort: undefined, accountResume: { kind: "save" }, messages: [{ id: "u1", role: "user", text: "build it", at: "", by: ASKER }, { id: "r1", role: "assistant", text: "", at: "", proposals: [card] }] });
    m.conns = { "c-me": { id: "c-me", piece: AZ, ownerSubject: ASKER.subject } };
    const p = await piBuilderService.decideProposal(WS, s.id, "a4", "run", { subject: ASKER.subject }, undefined, "c-me");
    expect(p.result).toMatch(/Press Save again/);
    expect(s.messages).toHaveLength(2);
    expect((s as { accountResume?: unknown }).accountResume).toBeUndefined();
  });
  it("a confirmed change goes through the account its card named, re-checked at the click", async () => {
    const card = { id: "p1", tool: "t", connector: "Azure DevOps", action: "Update", summary: "Close it", params: {}, status: "pending", at: "", account: { connectionId: "c-me", label: "Mine", personal: true, identity: null } };
    const s = session({ messages: [{ id: "u1", role: "user", text: "close it", at: "", by: ASKER }, { id: "r1", role: "assistant", text: "", at: "", proposals: [card] }] });
    m.options = [{ connectionId: "c-ws", label: "Team", personal: false, identity: null, secretName: "PLUGIN_AZDO_TEAM" }]; // "Mine" is gone
    const gone = await piBuilderService.decideProposal(WS, s.id, "p1", "run", { subject: ASKER.subject });
    expect(gone).toMatchObject({ status: "failed", result: expect.stringMatching(/Mine.*can no longer/) });
    expect(m.perform).not.toHaveBeenCalled();
  });
  it("Change forgets the chat's choice, so the next call asks again", () => {
    const s = session({ accounts: { [AZ]: { connectionId: "c-me", label: "Mine" } } });
    piBuilderService.clearAccount(WS, s.id, AZ);
    expect(s.accounts).toEqual({});
    expect(() => piBuilderService.clearAccount(WS, s.id, AZ)).toThrow(/no connection chosen/);
  });
});
