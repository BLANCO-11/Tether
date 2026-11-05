/**
 * A person removed from a workspace loses their own ("only for me") connections in it (plugins 8.7) — the credential and
 * the connection — and nobody else's. Against the real database: the rows are what is at stake.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { pluginRepo } from "../repositories/plugin.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { workspaceMemberService } from "./workspace-member.service.js";
import { encrypt } from "../utils/encryptor.js";

const GH = "@activepieces/piece-github";
const ws = await workspaceRepo.create({ name: "8.7 member connections", tenantSlug: "memconn", slug: `memconn-${Date.now().toString(36)}` });

async function connect(label: string, owner: string | null) {
  const secretName = `PLUGIN_GITHUB_${label.toUpperCase()}_${Date.now().toString(36)}`;
  await workspaceSecretRepo.upsertByName({ workspaceId: ws.id, name: secretName, kind: "tool", valueEnc: encrypt('{"token":"x"}') } as never);
  return pluginRepo.createConnection({ workspaceId: ws.id, piece: GH, label, authType: "SECRET_TEXT", secretName, fieldNames: ["token"], createdBy: "test", ownerSubject: owner });
}

afterAll(async () => {
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws.id)); // cascades members, connections, secrets
});

describe("removing a member", () => {
  it("⚠ removes their own connections and credentials, and leaves the workspace's and other people's", async () => {
    const team = await connect("team", null);
    const alice = await connect("alice", "oid-alice");
    const bob = await connect("bob", "oid-bob");
    await workspaceMemberService.grant(ws.id, { subject: "oid-alice", email: "alice@example.com", role: "author" }, "test");
    await workspaceMemberService.grant(ws.id, { subject: "oid-admin", email: "admin@example.com", role: "admin" }, "test");

    expect(await workspaceMemberService.revoke(ws.id, "oid-alice", { by: "admin@example.com" })).toBe(true);

    expect(await pluginRepo.getConnection(ws.id, alice.id)).toBeUndefined();
    expect(await workspaceSecretRepo.getByName(ws.id, alice.secretName)).toBeUndefined();
    expect(await pluginRepo.getConnection(ws.id, team.id)).toBeDefined();
    expect(await pluginRepo.getConnection(ws.id, bob.id)).toBeDefined();
    expect(await workspaceSecretRepo.getByName(ws.id, bob.secretName)).toBeDefined();
  });
  it("CONTROL: a removal that is refused (the last admin) removes nothing", async () => {
    const mine = await connect("admins", "oid-admin");
    await expect(workspaceMemberService.revoke(ws.id, "oid-admin")).rejects.toMatchObject({ statusCode: 409 });
    expect(await pluginRepo.getConnection(ws.id, mine.id)).toBeDefined();
  });
});
