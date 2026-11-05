/**
 * Personal connector actions (plans/personal-actions-2026-10-29). Storage and the connector are stubbed; the rules are
 * the real code: which actions become a person's tools, that one runs only through its person's own connection — in a
 * chat check and in a workflow's step — and what a person may switch on for themselves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  // Connectors on in this deployment (the connector is configured).
  process.env.PLUGINS_CONNECTOR_URL = "http://connector.invalid:4010";
  process.env.PLUGINS_CONNECTOR_SECRET = "test-only";
  return {
    actions: [] as Array<{ workspaceId: string; subject: string; piece: string; action: string }>,
    allowed: true,
    conns: [] as Array<{ id: string; piece: string; label: string; ownerSubject: string | null; secretName: string }>,
    declared: [] as Array<{ name: string; displayName: string; description: string; hash: string; pack: string | null; declaration: unknown }>,
    tools: [] as Array<Record<string, unknown>>,
    acting: { subject: "ada" as string | null, live: false },
    runAs: {} as { secretName?: string; actingSubject?: string | null },
    calls: [] as Array<{ tool: string; secretName?: string }>,
  };
});

const PIECE = "@activepieces/piece-azure-devops";
const DESC = {
  name: PIECE,
  version: "0.1.2",
  displayName: "Azure DevOps",
  auth: [],
  hosts: [],
  actions: [
    { name: "list_work_items", displayName: "List Work Items", description: "x", writes: false, destructive: false, params: { project: { type: "string", required: true } }, unsupported: [] },
    { name: "update_work_item", displayName: "Update Work Item", description: "x", writes: true, destructive: false, params: {}, unsupported: [] },
    { name: "odd_one", displayName: "Odd", description: "x", writes: false, destructive: false, params: {}, unsupported: ["needs a file input"] },
    { name: "custom_api_call", displayName: "Custom API Call", description: "x", writes: true, destructive: false, params: {}, unsupported: [] },
  ],
};

vi.mock("../repositories/plugin.repo.js", () => ({
  pluginRepo: {
    personalActions: async (_w: string, subject: string | null, piece?: string) => m.actions.filter((a) => (!subject || a.subject === subject) && (!piece || a.piece === piece)),
    addPersonalActions: async (workspaceId: string, subject: string, piece: string, actions: string[]) => {
      for (const action of actions) if (!m.actions.some((a) => a.subject === subject && a.piece === piece && a.action === action)) m.actions.push({ workspaceId, subject, piece, action });
    },
    removePersonalActions: async (_w: string, subject: string, piece?: string, actions?: string[]) => {
      const before = m.actions.length;
      m.actions = m.actions.filter((a) => !(a.subject === subject && (!piece || a.piece === piece) && (!actions || actions.includes(a.action))));
      return before - m.actions.length;
    },
    personalAllowed: async () => m.allowed,
    setPersonalAllowed: async (_w: string, _p: string, allowed: boolean) => void (m.allowed = allowed),
    listConnections: async (_w: string, piece?: string, viewer?: string | null) => m.conns.filter((c) => (!piece || c.piece === piece) && (c.ownerSubject === null || c.ownerSubject === viewer)),
    declaredCalls: async () => m.declared,
    saveDeclaredCall: async (row: { name: string; displayName: string; description: string; hash: string; pack: string | null; declaration: unknown }) => {
      if (!m.declared.some((d) => d.hash === row.hash)) m.declared.push(row);
      return row;
    },
  },
}));
vi.mock("../repositories/tool.repo.js", () => ({ toolRepo: { listByWorkspace: async () => m.tools } }));
vi.mock("./audit.service.js", () => ({ auditService: { record: async () => undefined } }));
vi.mock("./run-as.service.js", () => ({
  actingSubjectForRun: async () => m.acting,
  connectionForRun: async () => m.runAs,
  suspendRunningAs: async () => [],
  piecesUsed: async () => new Map(),
}));
vi.mock("./plugin-connector.service.js", async (orig) => ({
  ...(await orig<typeof import("./plugin-connector.service.js")>()),
  connectorPieces: async () => [DESC],
  invokePluginTool: async (_w: string, tool: { name: string }, params: unknown[], _run?: string, opts?: { secretName?: string }) => {
    m.calls.push({ tool: tool.name, secretName: opts?.secretName });
    return { results: params.map(() => ({ ok: true, data: { value: [] } })) };
  },
}));

const { personalTools, mayRunThrough, isPersonalTool } = await import("./personal-actions.js");
const { pluginService } = await import("./plugin.service.js");
const { stepExecutionService } = await import("./step-execution.service.js");

const WS = "11111111-1111-4111-8111-111111111111";
const own = { id: "c-ada", piece: PIECE, label: "Mine", ownerSubject: "ada", secretName: "PLUGIN_AZURE_DEVOPS_MINE" };
const team = { id: "c-team", piece: PIECE, label: "Team", ownerSubject: null, secretName: "PLUGIN_AZURE_DEVOPS_TEAM" };
const bens = { id: "c-ben", piece: PIECE, label: "Ben's", ownerSubject: "ben", secretName: "PLUGIN_AZURE_DEVOPS_BEN" };
const ada = { subject: "ada", email: "ada@acme.example" };
// A service refusal carries `statusCode`; a step's carries `status` (StepError) — either is the HTTP status it surfaces.
const status = async (p: Promise<unknown>) =>
  p.then(() => null).catch((e) => ({ code: (e as { statusCode?: number; status?: number }).statusCode ?? (e as { status?: number }).status, message: (e as Error).message }));

beforeEach(() => {
  m.actions = [];
  m.allowed = true;
  m.conns = [own, team, bens];
  m.declared = [];
  m.tools = [];
  m.acting = { subject: "ada", live: false };
  m.runAs = {};
  m.calls = [];
});

describe("a person's own actions as tools", () => {
  it("become tools through their OWN connection, for them only", async () => {
    m.actions.push({ workspaceId: WS, subject: "ada", piece: PIECE, action: "list_work_items" });
    const tools = await personalTools(WS, "ada");
    expect(tools.map((t) => t.name)).toEqual(["azure_devops_list_work_items"]);
    expect(tools[0]!.secretEnvName).toBe(own.secretName);
    expect(isPersonalTool(tools[0]!)).toBe(true);
    expect(await personalTools(WS, "ben")).toEqual([]); // CONTROL: nobody else gets them
  });

  it("are left out when an admin turned personal use off, or the person has no own connection", async () => {
    m.actions.push({ workspaceId: WS, subject: "ada", piece: PIECE, action: "list_work_items" });
    m.allowed = false;
    expect(await personalTools(WS, "ada")).toEqual([]);
    m.allowed = true;
    m.conns = [team];
    expect(await personalTools(WS, "ada")).toEqual([]); // never through the workspace's instead
  });

  it("leave out an action the connector no longer offers, and a declared call whose record is gone", async () => {
    m.actions.push(
      { workspaceId: WS, subject: "ada", piece: PIECE, action: "odd_one" },
      { workspaceId: WS, subject: "ada", piece: PIECE, action: "gone_action" },
      { workspaceId: WS, subject: "ada", piece: PIECE, action: "call_0000000000000000" },
    );
    expect(await personalTools(WS, "ada")).toEqual([]);
  });
});

describe("⚠ a personal action runs only through its person's own connection", () => {
  const tool = { id: "mine:ada:x:y" };
  it("own: yes; the workspace's: no; another person's: no", async () => {
    expect(await mayRunThrough(WS, tool, own.secretName, "ada")).toBe(true);
    expect(await mayRunThrough(WS, tool, team.secretName, "ada")).toMatch(/only through that person's own connection/);
    expect(await mayRunThrough(WS, tool, bens.secretName, "ada")).toMatch(/only through/);
  });
  it("CONTROL: a workspace tool is not this rule's business", async () => {
    expect(await mayRunThrough(WS, { id: "a-uuid" }, team.secretName, "ada")).toBe(true);
  });
});

describe("a workflow step calling a personal action", () => {
  const call = () => stepExecutionService.tool(WS, { ref: "azure_devops_list_work_items", params: [{ project: "P" }] } as never, "run-1");

  it("runs for the person the run acts for, through their own connection", async () => {
    m.actions.push({ workspaceId: WS, subject: "ada", piece: PIECE, action: "list_work_items" });
    const r = await call();
    expect(r.succeeded).toBe(1);
    expect(m.calls).toEqual([{ tool: "azure_devops_list_work_items", secretName: own.secretName }]);
  });

  it("⚠ is refused when the run's choice for the service is the workspace's connection — nothing is sent", async () => {
    m.actions.push({ workspaceId: WS, subject: "ada", piece: PIECE, action: "list_work_items" });
    m.runAs = { secretName: team.secretName, actingSubject: null };
    expect((await status(call()))?.code).toBe(403);
    expect(m.calls).toEqual([]);
  });

  it("is unknown when the person the run acts for does not have it on", async () => {
    m.actions.push({ workspaceId: WS, subject: "ben", piece: PIECE, action: "list_work_items" });
    expect((await status(call()))?.code).toBe(404);
    expect(m.calls).toEqual([]);
  });
});

describe("switching actions on for yourself", () => {
  it("needs your own connection, and the admin's yes", async () => {
    m.conns = [team];
    expect((await status(pluginService.setMyActions(WS, PIECE, { actions: ["list_work_items"] }, ada)))?.code).toBe(409);
    m.conns = [own];
    m.allowed = false;
    expect((await status(pluginService.setMyActions(WS, PIECE, { actions: ["list_work_items"] }, ada)))?.code).toBe(403);
    expect(m.actions).toEqual([]);
  });

  it("sets exactly the list given, and never the raw call or an action not offered", async () => {
    await pluginService.setMyActions(WS, PIECE, { actions: ["list_work_items", "update_work_item"] }, ada);
    await pluginService.setMyActions(WS, PIECE, { actions: ["list_work_items"] }, ada);
    expect(m.actions.map((a) => a.action)).toEqual(["list_work_items"]);
    expect((await status(pluginService.setMyActions(WS, PIECE, { actions: ["custom_api_call"] }, ada)))?.code).toBe(422);
    expect((await status(pluginService.setMyActions(WS, PIECE, { actions: ["odd_one"] }, ada)))?.code).toBe(422);
  });

  it("a pack switches each of its calls on for you, and switching one off removes it", async () => {
    const view = await pluginService.enableMyPack(WS, PIECE, "azure-repos", ada);
    expect(view.calls.map((c) => c.name)).toContain("list_branches");
    expect(m.actions.filter((a) => a.action.startsWith("call_"))).toHaveLength(14);
    expect((await personalTools(WS, "ada")).map((t) => t.name)).toContain("azure_devops_create_branch");
    await pluginService.removeMyCall(WS, PIECE, "create_branch", ada);
    expect((await personalTools(WS, "ada")).map((t) => t.name)).not.toContain("azure_devops_create_branch");
    expect((await status(pluginService.removeMyCall(WS, PIECE, "create_branch", ada)))?.code).toBe(404);
  });
});
