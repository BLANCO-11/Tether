import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pluginConnections, tools, workspaceMembers, workspaceSecrets, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";
import { encrypt } from "../utils/encryptor.js";
import { declarationHash } from "../services/declared-call.js";

/**
 * Declared API calls (plans/declared-api-calls-2026-10-29), through the real app and database. Only the CONNECTOR's
 * HTTP is stubbed (it runs in its own container): it describes a piece with a raw call, and records what a run sends.
 * The connection's credential is FAKE test data written here.
 *
 * Pinned: who may declare; the tool's address carries the declaration's hash; a run sends the declaration with it; a
 * changed shape is a new address and the same shape the same one; refusals name the rule; a personal connection and a
 * name taken by the piece's own action are refused; choosing the piece's own actions leaves declared calls alone; a
 * pack declares its calls; switching one off keeps its tool, inactive.
 */
const PIECE = "@activepieces/piece-azure-devops";
const DESC = {
  name: PIECE,
  version: "0.1.2",
  displayName: "Azure DevOps",
  auth: [{ type: "CUSTOM_AUTH", fields: [] }],
  actions: [
    { name: "create_work_item", displayName: "Create Work Item", description: "x", classification: "WRITE", writes: true, destructive: false, idempotent: null, params: {}, unsupported: [] },
    { name: "custom_api_call", displayName: "Custom API Call", description: "x", classification: "WRITE", writes: true, destructive: false, idempotent: null, params: {}, unsupported: [] },
  ],
  hosts: [],
};
const runs: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  if (config.plugins.url && url.startsWith(config.plugins.url)) {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/pieces")) return json({ pieces: [DESC] });
    if (url.endsWith("/run")) {
      runs.push(JSON.parse(String(init?.body ?? "{}")));
      return json({ ok: true, captured: false, writes: false, output: { status: 200, headers: {}, body: { value: [] } }, files: [] });
    }
    return new Response("{}", { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { createApp } = await import("../app.js");
const { invokePluginTool } = await import("../services/plugin-connector.service.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;
const stamp = Date.now().toString(36);
type Who = { subject: string; email: string };
const ADA: Who = { subject: `oid-dc-ada-${stamp}`, email: `ada-${stamp}@acme-hr.example` };
const BEN: Who = { subject: `oid-dc-ben-${stamp}`, email: `ben-${stamp}@acme-hr.example` };
const ws = await workspaceRepo.create({ name: `declared calls ${stamp}`, tenantSlug: "dcwire", slug: `dcwire-${stamp}` });
const reachable = !!ws && !!config.plugins.url && !!config.plugins.secret;
let connId = "";
let personalId = "";

async function call(path: string, as: Who, method = "GET", body?: unknown) {
  const token = await new SignJWT({ sub: as.subject, email: as.email, name: as.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
  const res = await realFetch(`${base}/api/workspaces/${ws!.id}${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": token, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const toolNamed = async (name: string) => (await db.select().from(tools).where(and(eq(tools.workspaceId, ws!.id), eq(tools.name, name))))[0];

const REPOS = {
  name: "list_repositories",
  displayName: "List repositories",
  description: "Every repository in a project.",
  method: "GET",
  path: "/{project}/_apis/git/repositories",
  query: { "api-version": "7.1" },
  params: [{ name: "project", in: "path", type: "string", required: true }],
};

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: ws!.id, ...BEN, role: "author", grantedBy: "test" },
  ]);
  const fake = encrypt(JSON.stringify({ organizationUrl: "https://dev.azure.com/foundry-test-fake", pat: "fake" }));
  await db.insert(workspaceSecrets).values([
    { workspaceId: ws!.id, name: `PLUGIN_AZURE_DEVOPS_TEST_${stamp}`, valueEnc: fake },
    { workspaceId: ws!.id, name: `PLUGIN_AZURE_DEVOPS_MINE_${stamp}`, valueEnc: fake },
  ] as never);
  const [c] = await db
    .insert(pluginConnections)
    .values({ workspaceId: ws!.id, piece: PIECE, label: "Team", authType: "CUSTOM_AUTH", secretName: `PLUGIN_AZURE_DEVOPS_TEST_${stamp}`, createdBy: "test" })
    .returning();
  connId = c!.id;
  const [m] = await db
    .insert(pluginConnections)
    .values({ workspaceId: ws!.id, piece: PIECE, label: "Mine", authType: "CUSTOM_AUTH", secretName: `PLUGIN_AZURE_DEVOPS_MINE_${stamp}`, createdBy: "test", ownerSubject: ADA.subject })
    .returning();
  personalId = m!.id;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (ws) await db.delete(workspacesTable).where(eq(workspacesTable.id, ws.id));
  server?.close();
});

describe.skipIf(!reachable)("declared API calls, at the wire", () => {
  it("a Creator may look and may not declare; an Admin declares, and the tool's address carries the hash", async () => {
    expect((await call("/plugins/azure-devops/calls", BEN)).status).toBe(200);
    expect((await call("/plugins/azure-devops/calls", BEN, "POST", { connectionId: connId, call: REPOS })).status).toBe(403);
    const made = await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: connId, call: REPOS });
    expect(made.status).toBe(201);
    const t = await toolNamed("azure_devops_list_repositories");
    expect(t?.url).toBe(`plugin://${PIECE}@0.1.2/call_${declarationHash({ ...REPOS, method: "GET", returns: "json", params: [{ name: "project", in: "path", type: "string", required: true, description: "" }] })}`);
    expect(t?.isActive).toBe(true);
    expect(t?.description).toMatch(/Only reads from Azure DevOps/);
  });

  it("a run sends the declaration with its address, and the values as given", async () => {
    runs.length = 0;
    const t = (await toolNamed("azure_devops_list_repositories"))!;
    const { results } = await invokePluginTool(ws!.id, t, [{ project: "Platform" }]);
    expect(results[0]?.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.action).toBe(t.url!.split("/").pop());
    expect((runs[0]!.declared as { path: string }).path).toBe("/{project}/_apis/git/repositories");
    expect(runs[0]!.props).toEqual({ project: "Platform" });
  });

  it("the same shape keeps its address; a changed one gets a new address", async () => {
    const before = (await toolNamed("azure_devops_list_repositories"))!.url;
    const reworded = await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: connId, call: { ...REPOS, description: "Reworded, same call." } });
    expect(reworded.body.changed).toBe(false);
    expect((await toolNamed("azure_devops_list_repositories"))!.url).toBe(before);
    const changed = await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: connId, call: { ...REPOS, query: { "api-version": "7.0" } } });
    expect(changed.body.changed).toBe(true);
    expect((await toolNamed("azure_devops_list_repositories"))!.url).not.toBe(before);
  });

  it("a bad declaration is refused, naming the rule", async () => {
    const dot = await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: connId, call: { ...REPOS, name: "climb", path: "/../other/_apis", params: [] } });
    expect(dot.status).toBe(400);
    expect(JSON.stringify(dot.body)).toMatch(/\. or \.\. segments/);
    const del = await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: connId, call: { ...REPOS, name: "gone", method: "DELETE" } });
    expect(del.status).toBe(400);
    expect(await toolNamed("azure_devops_climb")).toBeUndefined();
  });

  it("a personal connection is refused, and so is a name the piece's own action has", async () => {
    expect((await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: personalId, call: { ...REPOS, name: "mine_only" } })).status).toBe(422);
    expect((await call("/plugins/azure-devops/actions", ADA, "PUT", { connectionId: connId, actions: ["create_work_item"] })).status).toBe(200);
    expect((await call("/plugins/azure-devops/calls", ADA, "POST", { connectionId: connId, call: { ...REPOS, name: "create_work_item" } })).status).toBe(409);
  });

  it("choosing the piece's own actions leaves declared calls switched on", async () => {
    expect((await call("/plugins/azure-devops/actions", ADA, "PUT", { connectionId: connId, actions: [] })).status).toBe(200);
    expect((await toolNamed("azure_devops_create_work_item"))?.isActive).toBe(false); // CONTROL: the own action did go off
    expect((await toolNamed("azure_devops_list_repositories"))?.isActive).toBe(true);
  });

  it("a pack declares each of its calls, and the list shows them on", async () => {
    expect((await call("/plugins/azure-devops/call-packs/azure-repos", BEN, "POST", { connectionId: connId })).status).toBe(403);
    const r = await call("/plugins/azure-devops/call-packs/azure-repos", ADA, "POST", { connectionId: connId });
    expect(r.status).toBe(201);
    const list = (await call("/plugins/azure-devops/calls", BEN)).body as { calls: Array<{ name: string; on: boolean; pack: string | null; writes: boolean }>; packs: Array<{ key: string }> };
    expect(list.packs.map((p) => p.key)).toEqual(["azure-repos"]);
    const fromPack = list.calls.filter((c) => c.pack === "azure-repos").map((c) => c.name).sort();
    expect(fromPack).toEqual([
      "comment_on_pull_request",
      "commit_file_change",
      "commit_new_file",
      "compare_branches",
      "create_branch",
      "create_pull_request",
      "get_commit",
      "get_file",
      "get_pull_request",
      "list_branches",
      "list_commits",
      "list_files",
      "list_pull_requests",
      "list_repositories",
    ]);
    expect(list.calls.find((c) => c.name === "list_branches")?.writes).toBe(false);
    expect(list.calls.find((c) => c.name === "commit_new_file")?.writes).toBe(true);
    expect(list.calls.find((c) => c.name === "create_pull_request")?.writes).toBe(true);
  });

  it("switching one off keeps its tool, inactive", async () => {
    expect((await call("/plugins/azure-devops/calls/get_file", ADA, "DELETE")).status).toBe(200);
    expect((await toolNamed("azure_devops_get_file"))?.isActive).toBe(false);
    expect((await call("/plugins/azure-devops/calls/get_file", BEN, "DELETE")).status).toBe(403);
  });
});
