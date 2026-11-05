import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowRevisions, flows, pluginConnections, tools, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * Sharing boundaries Q3, measured through the REAL app: nobody else enters My space, so a workflow there has NO "Runs
 * as" choice — it always uses its owner's own accounts, whatever an older choice stored. The choice appears in a
 * project or the Workspace.
 *
 *   - the page offers nothing to choose and says it is its owner's own; a change is refused, saying why;
 *   - "Before it can run" asks its owner to connect their own account — never falls back to the workspace's;
 *   - using only its owner's own accounts, it is theirs to switch on without a reviewer;
 *   - CONTROL: the same workflow in the Workspace still offers the workspace's account and each person's.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const person = (n: string) => ({ subject: `oid-ms-${n}-${stamp}`, email: `${n}-${stamp}@acme-hr.example` });
const ALICE = person("alice");
const BOB = person("bob");
const GH = "@activepieces/piece-github";

const ws = await workspaceRepo.create({ name: `my space ${stamp}`, tenantSlug: "mswire", slug: `mswire-${stamp}` });
const reachable = !!ws;
const ids = { bobMine: randomUUID(), aliceMine: randomUUID(), bobShared: randomUUID(), bobLive: randomUUID(), team: randomUUID(), bobGh: randomUUID() };

type Who = { subject: string; email: string };
async function identity(who: Who): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}
async function call(path: string, as: Who, method = "GET", body?: unknown) {
  const res = await fetch(`${base}/api/workspaces/${ws!.id}${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
type RunAs = { mySpace: boolean; services: Array<{ piece: string; current: { own?: boolean; connectionId: string } | null; options: Array<{ connectionId: string; each?: boolean }> }> };
type Readiness = { ready: boolean; needs: Array<{ cause: string; fixBy: string; message: string }> };

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  const w = ws!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: w, ...ALICE, role: "author", grantedBy: "test" },
    { workspaceId: w, ...BOB, role: "author", grantedBy: "test" },
  ]);
  // GitHub on for the workspace through its "Team" connection; Bob has one of his own, Alice none.
  await db.insert(tools).values({ workspaceId: w, name: "github_create_issue", url: `plugin://${GH}@0.11.0/create_issue`, secretEnvName: "PLUGIN_GITHUB_TEAM" });
  await db.insert(pluginConnections).values([
    { id: ids.team, workspaceId: w, piece: GH, label: "Team", authType: "SECRET_TEXT", secretName: "PLUGIN_GITHUB_TEAM", createdBy: "test" },
    { id: ids.bobGh, workspaceId: w, piece: GH, label: "Bob's", authType: "SECRET_TEXT", secretName: "PLUGIN_GITHUB_ME_B", createdBy: "test", ownerSubject: BOB.subject },
  ]);
  const flow = (id: string, owner: Who, visibility: "private" | "public") => ({ id, workspaceId: w, name: `${id.slice(0, 6)}`, kestraFlowId: `k-${id}`, ownerSubject: owner.subject, draftRevision: 1, visibility, runtime: "foundry" });
  await db.insert(flows).values([
    flow(ids.bobMine, BOB, "private"),
    flow(ids.aliceMine, ALICE, "private"),
    flow(ids.bobShared, BOB, "public"),
    // Live in My space: approved, running on Bob's own account whatever it stored.
    { ...flow(ids.bobLive, BOB, "private"), armedRevision: 1, status: "armed" },
  ]);
  // Each stored "the workspace's Team" before Q3 — what a workflow built (or moved) into My space can carry.
  await db.insert(flowRevisions).values(
    [ids.bobMine, ids.aliceMine, ids.bobShared, ids.bobLive].map((flowId) => ({
      flowId,
      revision: 1,
      modelJson: { runtime: "foundry", workflow: { steps: [{ id: "open", uses: ["tool:github_create_issue"] }] }, files: {}, accounts: { [GH]: { connectionId: ids.team, label: "Team", personal: false, service: "GitHub" } } },
      compiledYamlHash: "m",
      structureHash: "m",
      createdByKind: "user" as const,
      createdBy: "test",
    })),
  );
});

afterAll(async () => {
  if (reachable) await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
  server?.close();
});

describe.skipIf(!reachable)("⚠ My space: always its owner's own account (sharing-boundaries Q3)", () => {
  it("the page offers nothing to choose and says it is its owner's own; a change is refused, saying why", async () => {
    const v = (await call(`/flows/${ids.bobMine}/run-as`, BOB)).body as unknown as RunAs;
    expect(v.mySpace).toBe(true);
    expect(v.services[0]!.options).toEqual([]);
    expect(v.services[0]!.current).toMatchObject({ own: true });
    const r = await call(`/flows/${ids.bobMine}/run-as`, BOB, "PUT", { piece: GH, connectionId: ids.team });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/My space, so it always uses its owner's own GitHub account/i);
  });

  it("⚠ 'Before it can run' asks its owner for their own account — never falls back to the workspace's", async () => {
    expect(((await call(`/flows/${ids.bobMine}/readiness?revision=draft`, BOB)).body as unknown as Readiness).ready).toBe(true);
    const alice = (await call(`/flows/${ids.aliceMine}/readiness?revision=draft`, ALICE)).body as unknown as Readiness;
    expect(alice.ready).toBe(false);
    expect(alice.needs[0]).toMatchObject({ cause: "not_connected", fixBy: "you" });
    expect(alice.needs[0]!.message).toMatch(/your own GitHub account/i);
  });

  it("using only its owner's own accounts, it is theirs to switch on without a reviewer", async () => {
    const got = await call(`/flows/${ids.bobMine}`, BOB);
    expect(got.status, JSON.stringify(got.body).slice(0, 300)).toBe(200);
    const self = got.body.selfEnable as { ownOnly: boolean; needsReviewerFor: string[] };
    expect(self.ownOnly).toBe(true);
    expect(self.needsReviewerFor).toEqual([]);
  });

  it("CONTROL: the same workflow in the Workspace keeps its choice, and offers the workspace's account and each person's", async () => {
    const v = (await call(`/flows/${ids.bobShared}/run-as`, BOB)).body as unknown as RunAs;
    expect(v.mySpace).toBe(false);
    expect(v.services[0]!.current).toMatchObject({ connectionId: ids.team });
    expect(v.services[0]!.options.map((o) => o.connectionId)).toEqual([ids.team, ids.bobGh, ""]);
    expect(((await call(`/flows/${ids.bobShared}`, BOB)).body.selfEnable as { ownOnly: boolean }).ownOnly).toBe(false);
  });

  it("⚠ moving a LIVE workflow out of My space says whose account it would use instead, and switches it off until approved", async () => {
    const pre = await call(`/flows/${ids.bobLive}/move-preview?to=workspace`, BOB);
    expect(pre.status).toBe(200);
    expect(pre.body.runsAs).toEqual([expect.stringMatching(/would use the workspace's “Team” instead of its owner's own account/)]);
    expect(pre.body.switchesOff).toMatch(/switched off until a reviewer approves it again/);
    const moved = await call(`/flows/${ids.bobLive}/move`, BOB, "POST", { to: "workspace" });
    expect(moved.status).toBe(200);
    expect(moved.body.turnedOff).toBe(true);
    const [f] = await db.select().from(flows).where(eq(flows.id, ids.bobLive));
    expect(f!.status).toBe("suspended");
    // CONTROL: a move that changes nothing about its accounts says nothing about them.
    expect((await call(`/flows/${ids.bobMine}/move-preview?to=mine`, BOB)).body.runsAs ?? []).toEqual([]);
  });
});
