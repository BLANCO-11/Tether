/**
 * What the person talking to Forge Agent can reach in connected services, and switching an action on (agent-grants.ts):
 * who may choose which place, that "for me" is the Apps page's own personal action, and what can never be switched on.
 *
 * ⚠ The first block is the defect that produced this file's current shape (2026-10-29, chat 48357b29): a person's own
 * ("only for me") Azure DevOps connection was hidden from Forge's list — the listing read the workspace's connections
 * only — while `mayDecide` would have let them use it. Forge guessed "github", was told "No connected service", and
 * reported the service as not connected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  admin: false,
  conns: [] as Array<{ id: string; piece: string; label: string; secretName: string; ownerSubject: string | null }>,
  tools: [] as Array<{ name: string; url: string; isActive: boolean; secretEnvName: string }>,
  /** Personal actions (plugin_personal_actions): subject → tool names on for them. */
  mine: {} as Record<string, string[]>,
  personalAllowed: true,
  setActions: vi.fn(async () => ({})),
  setMyActions: vi.fn(async () => ({})),
}));
const GH = "@activepieces/piece-github";
const AZ = "@activepieces/piece-azure-devops";
const action = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  displayName: name,
  description: `does ${name}`,
  classification: null,
  writes: true,
  destructive: false,
  idempotent: null,
  params: { path: { type: "string", required: true, description: "where" } },
  unsupported: [],
  ...over,
});
vi.mock("../repositories/plugin.repo.js", () => ({
  pluginRepo: {
    // As the real query: the workspace's connections, plus the VIEWER's own — never another person's.
    listConnections: async (_ws: string, piece?: string, viewer?: string | null) =>
      m.conns.filter((c) => (!piece || c.piece === piece) && (!c.ownerSubject || c.ownerSubject === viewer)),
    personalActions: async (_ws: string, subject: string, piece?: string) =>
      (m.mine[subject] ?? []).map((tool) => ({ piece: piece ?? GH, action: tool.replace(/^github_/, "") })),
    personalAllowed: async () => m.personalAllowed,
  },
}));
vi.mock("../repositories/tool.repo.js", () => ({ toolRepo: { listByWorkspace: async () => m.tools } }));
vi.mock("../services/effective-permissions.service.js", () => ({ effectivePermissionsService: { has: async () => m.admin } }));
vi.mock("../services/plugin.service.js", () => ({ pluginService: { setActions: m.setActions, setMyActions: m.setMyActions } }));
vi.mock("../services/personal-actions.js", () => ({
  ownConnections: async (_ws: string, piece: string, subject: string) => m.conns.filter((c) => c.piece === piece && c.ownerSubject === subject),
  personalTools: async (_ws: string, subject: string | null) => (subject ? (m.mine[subject] ?? []) : []).map((name) => ({ name })),
}));
vi.mock("../services/plugin-connector.service.js", async (orig) => ({
  ...(await orig<typeof import("../services/plugin-connector.service.js")>()),
  connectorPieces: async () => [
    {
      name: GH,
      displayName: "GitHub",
      version: "0.11.0",
      actions: [action("create_or_update_file"), action("delete_file", { destructive: true }), action("custom_api_call"), action("list_branches", { writes: false })],
    },
    { name: AZ, displayName: "Azure DevOps", version: "1.0.0", actions: [action("list_branches", { writes: false }), action("update_work_item")] },
  ],
}));

import { actionsFor, applyMine, applyWorkspace, connectedServices, matchService, mayDecide, neverFromChat, serviceLine } from "./agent-grants.js";

const me = { subject: "me" };
const other = { subject: "someone-else" };
const wsConn = { id: "c1", piece: GH, label: "Team GitHub", secretName: "PLUGIN_GITHUB_TEAM", ownerSubject: null };
const myConn = { id: "c2", piece: GH, label: "Mine", secretName: "PLUGIN_GITHUB_ME_abc123", ownerSubject: "me" };
const myAz = { id: "c3", piece: AZ, label: "foundry-devops-connection", secretName: "PLUGIN_AZURE_DEVOPS_ME_x", ownerSubject: "me" };
beforeEach(() => {
  m.admin = false;
  m.conns = [];
  m.tools = [];
  m.mine = {};
  m.personalAllowed = true;
  m.setActions.mockClear();
  m.setMyActions.mockClear();
});

describe("⚠ a person's OWN connection is what Forge can see — to them, and to nobody else", () => {
  it("listed for its owner with nothing switched on yet, by any of its names", async () => {
    m.conns = [myAz];
    const [az] = await actionsFor("w", me, "devops");
    expect(az).toMatchObject({ service: "azure-devops", name: "Azure DevOps", connections: [{ label: "foundry-devops-connection", whose: "yours" }] });
    expect(az!.actions.map((a) => a.on)).toEqual(["off", "off"]);
    expect((await actionsFor("w", me, "Azure DevOps"))[0]!.service).toBe("azure-devops");
    expect((await actionsFor("w", me))[0]!.service).toBe("azure-devops");
  });
  it("CONTROL: another member of the same workspace does not see it", async () => {
    m.conns = [myAz];
    expect(await actionsFor("w", other)).toEqual([]);
    await expect(actionsFor("w", other, "azure-devops")).rejects.toThrow(/nothing is connected that you can use/);
  });
  it("a name that is not a connected service is answered with the ones that ARE", async () => {
    m.conns = [myAz];
    await expect(actionsFor("w", me, "github")).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringMatching(/No connected service "github" here\. Connected services you can use: azure-devops \(Azure DevOps; your own connection “foundry-devops-connection”; no actions switched on yet; the Azure Repos pack is offered but off/),
    });
  });
  it("the turn's line and the permission agree: listed ⇔ they may switch it on for themselves", async () => {
    m.conns = [myAz];
    const listed = (await connectedServices("w", me)).map((s) => s.piece.name);
    expect(listed).toEqual([AZ]);
    expect(await mayDecide("w", me, AZ, "me")).toBe(true);
    expect(await connectedServices("w", other)).toEqual([]);
    expect(await mayDecide("w", other, AZ, "me")).not.toBe(true);
  });
  it("one line per service, naming whose connection and how many actions are on", async () => {
    m.conns = [wsConn, myConn];
    m.tools = [{ name: "github_list_branches", url: `plugin://${GH}@0.11.0/list_branches`, isActive: true, secretEnvName: "PLUGIN_GITHUB_TEAM" }];
    const [gh] = await connectedServices("w", me);
    expect(serviceLine(gh!)).toBe("github (GitHub; the workspace's connection “Team GitHub”, your own connection “Mine”; 1 action on)");
  });
});

describe("naming a service", () => {
  const pieces = [
    { name: GH, displayName: "GitHub" },
    { name: AZ, displayName: "Azure DevOps" },
    { name: "@activepieces/piece-azure-blob-storage", displayName: "Azure Blob Storage" },
  ];
  it("short name, package name or display name, case and spacing ignored; a part names the ONE that contains it", () => {
    for (const w of ["azure-devops", AZ, "Azure DevOps", "azuredevops", "devops"]) expect(matchService(pieces, w)?.name).toBe(AZ);
  });
  it("CONTROL: a part several contain names none — never a guess", () => {
    expect(matchService(pieces, "azure")).toBeNull();
    expect(matchService(pieces, "Foundry")).toBeNull();
  });
});

describe("who may switch an action on, and where", () => {
  it("the WORKSPACE needs an Admin and the workspace's own connection", async () => {
    m.conns = [wsConn];
    expect(await mayDecide("w", me, GH, "workspace")).toMatch(/needs a person who can change connectors/);
    m.admin = true;
    expect(await mayDecide("w", me, GH, "workspace")).toBe(true);
    m.conns = [myConn];
    expect(await mayDecide("w", me, GH, "workspace")).toMatch(/no connection to this service/);
  });
  it("⚠ FOR ME: only through their OWN connection — an Admin gets no way through the workspace's here", async () => {
    m.conns = [wsConn];
    m.admin = true;
    expect(await mayDecide("w", me, GH, "me")).toMatch(/Connect your own account first/);
    m.conns = [wsConn, myConn];
    m.admin = false;
    expect(await mayDecide("w", me, GH, "me")).toBe(true);
  });
  it("FOR ME: refused, with why, where an admin has turned personal use off for that service", async () => {
    m.conns = [myConn];
    m.personalAllowed = false;
    expect(await mayDecide("w", me, GH, "me")).toMatch(/An admin has turned off members switching/);
  });
  it("deleting actions and the raw API call are never switched on from chat", () => {
    expect(neverFromChat(action("delete_file", { destructive: true }) as never)).toMatch(/deletes/);
    expect(neverFromChat(action("custom_api_call") as never)).toMatch(/any address/);
    expect(neverFromChat(action("create_or_update_file") as never)).toBeNull();
  });
});

describe("an action a person switched on for themselves", () => {
  it("is the Apps page's own \"For me\" call, adding it and keeping their others", async () => {
    m.mine = { me: ["github_list_branches"] };
    await applyMine("w", GH, "create_or_update_file", true, me);
    expect(m.setMyActions).toHaveBeenCalledWith("w", GH, { actions: ["list_branches", "create_or_update_file"] }, me);
    await applyMine("w", GH, "list_branches", false, me);
    expect(m.setMyActions).toHaveBeenLastCalledWith("w", GH, { actions: [] }, me);
  });
});

describe("what Forge lists", () => {
  it("each action with where it is on — for everyone or for them — and the inputs when one service is asked about", async () => {
    m.conns = [wsConn, myConn];
    m.tools = [{ name: "github_list_branches", url: `plugin://${GH}@0.11.0/list_branches`, isActive: true, secretEnvName: "PLUGIN_GITHUB_TEAM" }];
    m.mine = { me: ["github_create_or_update_file"] };
    const [gh] = await actionsFor("w", me, "github");
    const by = Object.fromEntries(gh!.actions.map((a) => [a.action, a]));
    expect(by.list_branches!.on).toBe("workspace");
    expect(by.create_or_update_file).toMatchObject({ on: "me", effect: "changes", params: { path: expect.anything() } });
    expect(by.delete_file).toMatchObject({ on: "off", never: expect.stringMatching(/deletes/) });
    expect(by.custom_api_call).toBeUndefined();
    // CONTROL: nobody else sees it on for them.
    m.conns = [wsConn];
    const [theirs] = await actionsFor("w", other, "github");
    expect(theirs!.actions.find((a) => a.action === "create_or_update_file")!.on).toBe("off");
  });
  it("a pack offered and off is named, with where to switch it on; on, it says for whom", async () => {
    m.conns = [myAz];
    const [az] = await connectedServices("w", me);
    expect(serviceLine(az!)).toMatch(/the Azure Repos pack is offered but off \(a person switches it on in Apps → Azure DevOps → For me/);
    m.mine = { me: ["azure_devops_list_branches"] };
    expect(serviceLine((await connectedServices("w", me))[0]!)).toMatch(/the Azure Repos pack is on for them/);
  });
});

describe("switching it on for the workspace", () => {
  it("is Apps' own call, adding the action and keeping the others", async () => {
    m.conns = [wsConn];
    m.tools = [{ name: "github_list_branches", url: `plugin://${GH}@0.11.0/list_branches`, isActive: true, secretEnvName: "PLUGIN_GITHUB_TEAM" }];
    await applyWorkspace("w", GH, "create_or_update_file", true, { subject: "me" });
    expect(m.setActions).toHaveBeenCalledWith("w", GH, { connectionId: "c1", actions: ["list_branches", "create_or_update_file"] }, { subject: "me" });
    await applyWorkspace("w", GH, "list_branches", false, { subject: "me" });
    expect(m.setActions).toHaveBeenLastCalledWith("w", GH, { connectionId: "c1", actions: [] }, { subject: "me" });
  });
});
