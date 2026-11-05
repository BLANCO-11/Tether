/**
 * Forge Agent's proposed changes — the rules (agent-changes.ts), against mocked repositories and connector.
 * ⚠ The properties: a workspace that has not chosen confirmed changes never gets one; a deleting action and a read are
 * never proposals; a confirmed change goes through the person's OWN connection when they have one, and is audited
 * under the person.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ws: { assistant: true, agentChanges: true } as Record<string, unknown> | null,
  tools: [] as Array<Record<string, unknown>>,
  pieces: [] as Array<Record<string, unknown>>,
  personal: [] as Array<Record<string, unknown>>,
  invoke: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../config/index.js", () => ({ config: { plugins: { enabled: true } } }));
vi.mock("../repositories/workspace.repo.js", () => ({ workspaceRepo: { get: async () => m.ws } }));
vi.mock("../repositories/tool.repo.js", () => ({ toolRepo: { listByWorkspace: async () => m.tools } }));
vi.mock("../repositories/plugin.repo.js", () => ({ pluginRepo: { listConnections: async () => m.personal } }));
vi.mock("../services/audit.service.js", () => ({ auditService: { record: (...a: unknown[]) => (m.audit(...a), Promise.resolve()) } }));
vi.mock("../services/plugin-connector.service.js", () => ({
  connectorPieces: async () => m.pieces,
  invokePluginTool: (...a: unknown[]) => m.invoke(...a),
  isPluginTool: (t: { url?: string }) => !!t.url?.startsWith("plugin://"),
  parsePluginUrl: (u: string) => {
    const x = u.slice(9).match(/^(@activepieces\/piece-[a-z0-9-]+)@(\d+\.\d+\.\d+)\/(.+)$/);
    return x ? { piece: x[1], version: x[2], action: x[3] } : null;
  },
}));

import { callsOf, changesAllowed, checkValues, outcomeLine, performConfirmed, proposable } from "./agent-changes.js";

const PIECE = "@activepieces/piece-azure-devops";
const tool = (action: string, over: Record<string, unknown> = {}) => ({ name: `azure_devops_${action}`, url: `plugin://${PIECE}@0.1.2/${action}`, secretEnvName: "PLUGIN_AZURE_DEVOPS_WS", isActive: true, ...over });
const act = (name: string, over: Record<string, unknown> = {}) => ({ name, displayName: name, writes: true, destructive: false, ...over });

beforeEach(() => {
  m.ws = { assistant: true, agentChanges: true };
  m.tools = [tool("update_work_item"), tool("list_work_items"), tool("delete_work_item")];
  m.pieces = [{ name: PIECE, displayName: "Azure DevOps", actions: [act("update_work_item"), act("list_work_items", { writes: false }), act("delete_work_item", { destructive: true })] }];
  m.personal = [];
  m.invoke.mockReset();
  m.audit.mockReset();
});

describe("whether this workspace allows confirmed changes", () => {
  it("⚠ off unless BOTH Forge Agent and confirmed changes are on — and the refusal says who can turn it on", async () => {
    m.ws = { assistant: true, agentChanges: false };
    const r = await changesAllowed("w");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/super admin can allow confirmed changes/);
    m.ws = { assistant: false, agentChanges: true };
    expect((await changesAllowed("w")).ok).toBe(false);
    m.ws = { assistant: true, agentChanges: true };
    expect((await changesAllowed("w")).ok).toBe(true);
  });
});

describe("what can be proposed", () => {
  it("a change to an enabled connector action is", async () => {
    const r = await proposable("w", "azure_devops_update_work_item");
    expect(r.connector).toBe("Azure DevOps");
  });
  it("⚠ a deleting action never is, and a read has nothing to confirm", async () => {
    await expect(proposable("w", "azure_devops_delete_work_item")).rejects.toThrow(/never done from chat/);
    await expect(proposable("w", "azure_devops_list_work_items")).rejects.toThrow(/only reads/);
  });
  it("an unknown or switched-off tool is refused, naming what is there", async () => {
    m.tools[0]!.isActive = false;
    await expect(proposable("w", "azure_devops_update_work_item")).rejects.toThrow(/no connected-service tool named.*azure_devops_list_work_items/);
  });
  it("values are checked by the connector WITHOUT doing anything; a bad value is refused by name", async () => {
    m.invoke.mockResolvedValueOnce({ results: [{ ok: true, captured: true }] });
    await checkValues("w", tool("update_work_item") as never, { work_item_id: 1 });
    // No run and not `confirmed` ⇒ capture mode; the person it is checked for is passed (a personal connection is theirs only).
    expect(m.invoke.mock.calls[0]![3]).toBeUndefined();
    expect(m.invoke.mock.calls[0]![4]).toEqual({ actingSubject: undefined });
    m.invoke.mockResolvedValueOnce({ results: [{ ok: false, error: "validation: missing: project" }] });
    await expect(checkValues("w", tool("update_work_item") as never, {})).rejects.toThrow(/do not work.*missing: project/);
  });
});

describe("a confirmed change", () => {
  const p = { id: "p1", tool: "azure_devops_update_work_item", connector: "Azure DevOps", action: "Update", summary: "Close 2688", params: { work_item_id: 2688, state: "Closed" }, status: "running" as const, at: "" };
  it("runs exactly the stored values, through the WORKSPACE connection when the person has none, audited under the person", async () => {
    m.invoke.mockResolvedValueOnce({ results: [{ ok: true, data: { id: 2688, state: "Closed" } }] });
    const r = await performConfirmed("w", p, { subject: "s1", label: "himanshu@example.com" }, { chatId: "c1" });
    expect(r).toMatchObject({ status: "done", via: "workspace" });
    const [, , items, runId, confirmed] = m.invoke.mock.calls[0]!;
    expect(items).toEqual([p.params]);
    expect(runId).toBeUndefined();
    expect(confirmed).toEqual({ confirmed: true, secretName: "PLUGIN_AZURE_DEVOPS_WS", actingSubject: "s1" });
    expect(m.audit.mock.calls[0]![0]).toMatchObject({ actor: "himanshu@example.com", operation: "update", description: expect.stringMatching(/Confirmed and done from Forge Agent: Close 2688/) });
  });
  it("⚠ goes through the connection the PERSON chose, and never picks one itself (plugins 8.5)", async () => {
    // Even with a personal connection present, nothing is chosen here: without `use` it is the tool's own.
    m.personal = [{ ownerSubject: "s1", secretName: "PLUGIN_AZURE_DEVOPS_ME_abc_MINE" }, { ownerSubject: null, secretName: "X" }];
    m.invoke.mockResolvedValueOnce({ results: [{ ok: true, data: {} }] });
    expect((await performConfirmed("w", p, { subject: "s1", label: "me" }, { chatId: null })).via).toBe("workspace");
    expect(m.invoke.mock.calls[0]![4]).toMatchObject({ secretName: "PLUGIN_AZURE_DEVOPS_WS" });
    m.invoke.mockResolvedValueOnce({ results: [{ ok: true, data: {} }] });
    const r = await performConfirmed("w", p, { subject: "s1", label: "me" }, { chatId: null }, [], { secretName: "PLUGIN_AZURE_DEVOPS_ME_abc_MINE", personal: true, label: "Mine" });
    expect(r.via).toBe("personal");
    expect(m.invoke.mock.calls[1]![4]).toEqual({ confirmed: true, secretName: "PLUGIN_AZURE_DEVOPS_ME_abc_MINE", actingSubject: "s1" });
  });
  it("the service's refusal is the card's answer, not a crash — and still audited", async () => {
    m.invoke.mockResolvedValueOnce({ results: [{ ok: false, error: "action_failed: HTTP 401" }] });
    const r = await performConfirmed("w", p, { subject: "s1", label: "me" }, { chatId: null });
    expect(r).toMatchObject({ status: "failed", result: "action_failed: HTTP 401" });
    expect(m.audit).toHaveBeenCalledOnce();
  });
  it("⚠ the settings are checked again at the click: turned off in between ⇒ nothing runs", async () => {
    m.ws = { assistant: true, agentChanges: false };
    await expect(performConfirmed("w", p, { subject: "s1", label: "me" }, { chatId: null })).rejects.toThrow(/not change them/);
    expect(m.invoke).not.toHaveBeenCalled();
  });
  it("what Forge is told next turn says done / failed / declined, never leaves it to guess", () => {
    expect(outcomeLine({ ...p, status: "done", result: "{}" })).toMatch(/confirmed "Close 2688".*DONE/);
    expect(outcomeLine({ ...p, status: "failed", result: "HTTP 401" })).toMatch(/FAILED: HTTP 401/);
    expect(outcomeLine({ ...p, status: "declined" })).toMatch(/DECLINED.*nothing was done/);
  });
});

describe("a batch: one action, many items, one card, one click", () => {
  const items = [{ work_item_id: 1, state: "Closed" }, { work_item_id: 2, state: "Closed" }, { work_item_id: 3, state: "Closed" }];
  const batch = { id: "b1", tool: "azure_devops_update_work_item", connector: "Azure DevOps", action: "Update", summary: "Close 3 items", params: items, status: "running" as const, at: "" };
  it("bounds its shape: 1 to 25 objects", () => {
    expect(callsOf({ a: 1 })).toEqual([{ a: 1 }]);
    expect(callsOf(items)).toHaveLength(3);
    expect(() => callsOf([])).toThrow(/at least one/);
    expect(() => callsOf(Array.from({ length: 26 }, () => ({})))).toThrow(/At most 25/);
    expect(() => callsOf([1, 2])).toThrow(/one JSON object/);
  });
  it("every entry is checked by the connector; a bad one is named by its position", async () => {
    m.invoke.mockResolvedValueOnce({ results: [{ ok: true, captured: true }, { ok: false, error: "missing: project" }, { ok: true, captured: true }] });
    await expect(checkValues("w", tool("update_work_item") as never, items)).rejects.toThrow(/\(entry 2\): missing: project/);
    expect(m.invoke.mock.calls[0]![2]).toEqual(items);
  });
  it("⚠ runs every entry; partly done is PARTIAL with each entry's answer — never 'done' over a failure", async () => {
    m.invoke.mockResolvedValueOnce({ results: [{ ok: true, data: { id: 1 } }, { ok: false, error: "HTTP 403" }, { ok: true, data: { id: 3 } }] });
    const r = await performConfirmed("w", batch, { subject: "s1", label: "me" }, { chatId: null });
    expect(r).toMatchObject({ status: "partial", result: "2 of 3 done; 1 failed" });
    expect(r.results?.map((x) => x.ok)).toEqual([true, false, true]);
    expect(outcomeLine({ ...batch, ...r })).toMatch(/PARTLY done.*entry 2: HTTP 403/);
    m.invoke.mockResolvedValueOnce({ results: items.map(() => ({ ok: true, data: {} })) });
    expect((await performConfirmed("w", batch, { subject: "s1", label: "me" }, { chatId: null })).status).toBe("done");
  });
});

describe("placeholders are never proposed (chat 4ecefa5a)", () => {
  it("names a value that stands in for a real one, and lets real text through", async () => {
    const { placeholdersIn } = await import("./agent-changes.js");
    expect(placeholdersIn([{ content: "PLACEHOLDER", path: "index.html" }])).toEqual(['content = "PLACEHOLDER"']);
    expect(placeholdersIn([{ a: "<file content>" }, { a: "{{sha}}" }, { a: "TODO" }, { a: "…" }])).toHaveLength(4);
    expect(placeholdersIn([{ message: "Add the placeholder text for the hero", body: "TODO list app", state: "Closed" }])).toEqual([]);
  });
});

describe("what a card shows of the service's answer", () => {
  it("the web page, never an API address, and a few facts — from GitHub's real answer shape", async () => {
    const { answerLink, answerBrief } = await import("./agent-changes.js");
    const gh = {
      content: { name: "index.html", path: "index.html", sha: "65def7ab4c9747cfb5f0772c5554d597306d5d21", url: "https://api.github.com/repos/o/r/contents/index.html", html_url: "https://github.com/o/r/blob/main/index.html" },
      commit: { sha: "9f1e2d3c4b5a69788776655443322110ffeeddcc", html_url: "https://github.com/o/r/commit/9f1e2d3" },
    };
    expect(answerLink(gh)).toBe("https://github.com/o/r/blob/main/index.html");
    expect(answerBrief(gh)).toEqual([["name", "index.html"], ["sha", "65def7a"]]);
    // Azure DevOps answers only API urls: no link rather than a page that is not one.
    expect(answerLink({ id: 2688, url: "https://dev.azure.com/org/x/_apis/wit/workItems/2688" })).toBeNull();
    expect(answerLink({ link: "http://example.com", html_url: "javascript:alert(1)" })).toBeNull();
  });
});
