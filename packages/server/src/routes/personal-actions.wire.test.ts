import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pluginConnections, workspaceMembers, workspaceSecrets, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";
import { encrypt } from "../utils/encryptor.js";

/**
 * Personal connector actions (plans/personal-actions-2026-10-29), through the real app and database. Only the
 * CONNECTOR's HTTP is stubbed (it runs in its own container) and describes one piece. Credentials are FAKE test data,
 * and the workspace is a throwaway this file creates and deletes.
 *
 * Pinned: a member switches actions on for THEMSELVES with no workspace connection at all — the reason this exists; it
 * needs their own connection; only an admin decides personal use, and "off" stops a member at once; a pack can be
 * switched on for oneself; what one person switches on is not another's.
 */
const PIECE = "@activepieces/piece-azure-devops";
const DESC = {
  name: PIECE,
  version: "0.1.2",
  displayName: "Azure DevOps",
  auth: [{ type: "CUSTOM_AUTH", fields: [] }],
  actions: [
    { name: "list_work_items", displayName: "List Work Items", description: "x", classification: "READ", writes: false, destructive: false, idempotent: null, params: {}, unsupported: [] },
    { name: "custom_api_call", displayName: "Custom API Call", description: "x", classification: "WRITE", writes: true, destructive: false, idempotent: null, params: {}, unsupported: [] },
  ],
  hosts: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  if (config.plugins.url && url.startsWith(config.plugins.url)) {
    if (url.endsWith("/pieces")) return new Response(JSON.stringify({ pieces: [DESC] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;
const stamp = Date.now().toString(36);
type Who = { subject: string; email: string };
const ADA: Who = { subject: `oid-pa-ada-${stamp}`, email: `ada-${stamp}@acme-hr.example` };
const BEN: Who = { subject: `oid-pa-ben-${stamp}`, email: `ben-${stamp}@acme-hr.example` };
const CAL: Who = { subject: `oid-pa-cal-${stamp}`, email: `cal-${stamp}@acme-hr.example` };
const ws = await workspaceRepo.create({ name: `personal actions ${stamp}`, tenantSlug: "pawire", slug: `pawire-${stamp}` });
const reachable = !!ws && config.plugins.enabled;

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
const own = async (who: Who, label: string) => {
  const name = `PLUGIN_AZURE_DEVOPS_${label}_${stamp}`.toUpperCase();
  await db.insert(workspaceSecrets).values({ workspaceId: ws!.id, name, valueEnc: encrypt(JSON.stringify({ organizationUrl: "https://dev.azure.com/foundry-test-fake", pat: "fake" })) } as never);
  await db.insert(pluginConnections).values({ workspaceId: ws!.id, piece: PIECE, label, authType: "CUSTOM_AUTH", secretName: name, createdBy: "test", ownerSubject: who.subject });
};

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: ws!.id, ...BEN, role: "author", grantedBy: "test" },
    { workspaceId: ws!.id, ...CAL, role: "author", grantedBy: "test" },
  ]);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (ws) await db.delete(workspacesTable).where(eq(workspacesTable.id, ws.id));
  server?.close();
});

describe.skipIf(!reachable)("personal actions, at the wire", () => {
  it("a member needs their own connection — and NOT a workspace connection — to switch an action on for themselves", async () => {
    const before = await call("/plugins/azure-devops/mine/actions", BEN, "PUT", { actions: ["list_work_items"] });
    expect(before.status).toBe(409);
    expect(JSON.stringify(before.body)).toMatch(/Connect your own/);
    await own(BEN, "bens");
    // The workspace has no connection to the service at all: this is the case the feature exists for.
    const r = await call("/plugins/azure-devops/mine/actions", BEN, "PUT", { actions: ["list_work_items"] });
    expect(r.status).toBe(200);
    expect(r.body.actions).toEqual(["list_work_items"]);
  });

  it("what one person switches on is not another's", async () => {
    expect((await call("/plugins/azure-devops/mine", CAL)).body.actions).toEqual([]);
    expect((await call("/plugins/azure-devops/mine", BEN)).body.actions).toEqual(["list_work_items"]);
  });

  it("only an admin decides personal use; off stops a member at once, on lets them again", async () => {
    expect((await call("/plugins/azure-devops/personal-use", BEN, "PUT", { allowed: false })).status).toBe(403);
    expect((await call("/plugins/azure-devops/personal-use", ADA, "PUT", { allowed: false })).status).toBe(200);
    const view = await call("/plugins/azure-devops/mine", BEN);
    expect(view.body.allowed).toBe(false);
    expect((await call("/plugins/azure-devops/mine/actions", BEN, "PUT", { actions: [] })).status).toBe(403);
    expect((await call("/plugins/azure-devops/personal-use", ADA, "PUT", { allowed: true })).status).toBe(200);
    expect((await call("/plugins/azure-devops/mine/actions", BEN, "PUT", { actions: ["list_work_items"] })).status).toBe(200);
  });

  it("a pack switches on for a member, and one of its calls switches off again", async () => {
    const r = await call("/plugins/azure-devops/mine/call-packs/azure-repos", BEN, "POST");
    expect(r.status).toBe(201);
    expect((r.body.calls as Array<{ name: string }>).map((c) => c.name)).toContain("list_branches");
    expect((await call("/plugins/azure-devops/mine/calls/list_branches", BEN, "DELETE")).status).toBe(200);
    expect(((await call("/plugins/azure-devops/mine", BEN)).body.calls as Array<{ name: string }>).map((c) => c.name)).not.toContain("list_branches");
  });

  it("the raw call is never switched on for oneself", async () => {
    expect((await call("/plugins/azure-devops/mine/actions", BEN, "PUT", { actions: ["custom_api_call"] })).status).toBe(422);
  });
});
