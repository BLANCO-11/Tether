import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowExecutions, flows, notifications, piChats, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * Projects (sharing-boundaries phase 5), measured through the REAL app — permission guard, content guard, routes, SQL:
 *
 *   - a project is seen by its members (and Admins); anybody else gets NOT FOUND for it and for everything in it;
 *   - what is in it is seen by its members — not by a Reviewer outside it, who sees only what is put in front of them;
 *   - an item in a project cannot be made "public": sharing wider is a move;
 *   - a move says first who would stop seeing it; into a project only for somebody in it;
 *   - removing somebody takes everything in it from them AT ONCE, and what they owned passes to its owner;
 *   - deleting a project returns each item to its owner's My space, never to the workspace.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const person = (n: string) => ({ subject: `oid-pj-${n}-${stamp}`, email: `${n}-${stamp}@acme-hr.example` });
const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");
const ADA = person("ada");
const RITA = person("rita");
const OLGA = person("olga");

const ws = await workspaceRepo.create({ name: `projects ${stamp}`, tenantSlug: "pjwire", slug: `pjwire-${stamp}` });
const reachable = !!ws;
const ids = { aliceFlow: randomUUID(), bobFlow: randomUUID(), carolFlow: randomUUID(), aliceChat: randomUUID(), aliceRun: randomUUID() };
let project = "";

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
const flowIds = async (as: Who) => (((await call("/flows", as)).body.flows as Array<{ id?: string; flow?: { id: string } }>) ?? []).map((f) => f.id ?? f.flow?.id);
const projectIds = async (as: Who) => (((await call("/projects", as)).body.projects as Array<{ id: string }>) ?? []).map((p) => p.id);
const runIds = async (as: Who) => (((await call("/flow-executions", as)).body.executions as Array<{ id: string }>) ?? []).map((r) => r.id);
const chatIds = async (as: Who) => (((await call("/pi-builder/chats", as)).body.chats as Array<{ id: string }>) ?? []).map((c) => c.id);
const flowRow = async (id: string) => (await db.select().from(flows).where(eq(flows.id, id)))[0]!;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  const w = ws!.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: w, ...ALICE, role: "author", grantedBy: "test" },
    { workspaceId: w, ...BOB, role: "author", grantedBy: "test" },
    { workspaceId: w, ...CAROL, role: "author", grantedBy: "test" },
    { workspaceId: w, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: w, ...RITA, role: "approver", grantedBy: "test" },
    { workspaceId: w, ...OLGA, role: "viewer", grantedBy: "test" },
  ]);
  await db.insert(flows).values([
    { id: ids.aliceFlow, workspaceId: w, name: "alice's", kestraFlowId: `a-${stamp}`, ownerSubject: ALICE.subject, othersMayEdit: true },
    { id: ids.bobFlow, workspaceId: w, name: "bob's", kestraFlowId: `b-${stamp}`, ownerSubject: BOB.subject },
    { id: ids.carolFlow, workspaceId: w, name: "carol's", kestraFlowId: `c-${stamp}`, ownerSubject: CAROL.subject },
  ]);
  // A live run of Alice's workflow: in a project, its live runs are its members' to see (the runs list's SQL).
  await db.insert(flowExecutions).values({ id: ids.aliceRun, workspaceId: w, flowId: ids.aliceFlow, kestraNamespace: `foundry.pjwire.pjwire-${stamp}`, kestraFlowId: `a-${stamp}`, kestraExecutionId: `ar-${stamp}` });
  await db.insert(piChats).values({ id: ids.aliceChat, workspaceId: w, title: "alice's chat", createdBySubject: ALICE.subject });
});

afterAll(async () => {
  if (reachable) await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
  server?.close();
});

describe.skipIf(!reachable)("projects, through the real app", () => {
  it("a Creator makes one and adds a member; an Observer cannot; nobody outside it learns it exists", async () => {
    expect((await call("/projects", OLGA, "POST", { name: `Payroll ${stamp}` })).status).toBe(403);
    const made = await call("/projects", ALICE, "POST", { name: `Payroll ${stamp}`, instructions: "Always cite the pay period." });
    expect(made.status).toBe(201);
    project = (made.body.project as { id: string }).id;
    expect((await call(`/projects/${project}/members`, ALICE, "POST", { subject: BOB.subject })).status).toBe(201);
    // A member who does not own it cannot add people.
    expect((await call(`/projects/${project}/members`, BOB, "POST", { subject: CAROL.subject })).status).toBe(403);
    // Outside it: not found, and not listed. An Admin sees it.
    expect((await call(`/projects/${project}`, CAROL)).status).toBe(404);
    expect((await call(`/projects/${project}/members`, CAROL, "POST", { subject: CAROL.subject })).status).toBe(404);
    expect(await projectIds(CAROL)).not.toContain(project);
    expect(await projectIds(BOB)).toContain(project);
    expect(await projectIds(ADA)).toContain(project);
  });

  it("a move says first who gains and who loses; into a project only for somebody in it", async () => {
    const pre = await call(`/flows/${ids.aliceFlow}/move-preview?to=project:${project}`, ALICE);
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ loses: [], gains: 1, narrows: false });
    // Not hers to see: the guard answers before the move route does.
    expect((await call(`/flows/${ids.aliceFlow}/move-preview?to=mine`, CAROL)).status).toBe(404);
    // Her own workflow, into a project she is not in.
    expect((await call(`/flows/${ids.carolFlow}/move`, CAROL, "POST", { to: `project:${project}` })).status).toBe(403);
    expect((await call(`/flows/${ids.aliceFlow}/move`, ALICE, "POST", { to: "everywhere" })).status).toBe(400);
    expect((await call(`/flows/${ids.aliceFlow}/move`, ALICE, "POST", { to: `project:${project}` })).status).toBe(200);
    expect((await flowRow(ids.aliceFlow)).projectId).toBe(project);
    expect((await call(`/flows/${ids.bobFlow}/move`, BOB, "POST", { to: `project:${project}` })).status).toBe(200);
    expect((await call(`/pi-builder/chats/${ids.aliceChat}/move`, ALICE, "POST", { to: `project:${project}` })).status).toBe(200);
  });

  it("⚠ members see and edit what is in it; somebody outside it, a Reviewer included, gets NOT FOUND", async () => {
    expect((await call(`/flows/${ids.aliceFlow}`, BOB)).status).toBe(200);
    expect(await flowIds(BOB)).toContain(ids.aliceFlow);
    expect((await call(`/pi-builder/chats/${ids.aliceChat}`, BOB)).status).toBe(200);
    expect(await chatIds(BOB)).toContain(ids.aliceChat);
    expect(await runIds(BOB)).toContain(ids.aliceRun);
    expect((await call(`/flow-executions/${ids.aliceRun}`, BOB)).status).toBe(200);
    for (const who of [CAROL, RITA, OLGA]) {
      expect(await runIds(who)).not.toContain(ids.aliceRun);
      expect(await chatIds(who)).not.toContain(ids.aliceChat);
      expect((await call(`/flow-executions/${ids.aliceRun}`, who)).status).toBe(404);
      expect((await call(`/flows/${ids.aliceFlow}`, who)).status).toBe(404);
      expect(await flowIds(who)).not.toContain(ids.aliceFlow);
      expect((await call(`/pi-builder/chats/${ids.aliceChat}`, who)).status).toBe(404);
    }
    // Editing is shared with the members (othersMayEdit); managing stays the owner's.
    expect((await call(`/flows/${ids.aliceFlow}/move-preview?to=mine`, BOB)).status).toBe(403);
    expect((await call(`/flows/${ids.aliceFlow}/move`, BOB, "POST", { to: "mine" })).status).toBe(403);
  });

  it("⚠ an item in a project is not made public by the old switch; sharing wider is a move (phase 7, P7-D1)", async () => {
    const r = await call(`/flows/${ids.aliceFlow}/visibility`, ALICE, "PUT", { visibility: "public" });
    expect([r.status, r.body.error]).toEqual([409, "use_move"]);
    expect((await call(`/pi-builder/chats/${ids.aliceChat}`, ALICE, "PATCH", { visibility: "public" })).status).toBe(409);
    expect((await flowRow(ids.aliceFlow)).visibility).toBe("private");
  });

  it("a chat cannot be started in a project the person is not in", async () => {
    expect((await call("/pi-builder/sessions", CAROL, "POST", { projectId: project })).status).toBe(404);
    expect((await call("/pi-builder/sessions", CAROL, "POST", { projectId: randomUUID() })).status).toBe(404);
  });

  it("a chat started in the project says it lives there; one started elsewhere says My space (P6-I4)", async () => {
    const inProject = await call("/pi-builder/sessions", ALICE, "POST", { projectId: project });
    expect(inProject.status).toBe(201);
    expect(inProject.body.place).toEqual({ key: `project:${project}`, projectName: expect.any(String) });
    const elsewhere = await call("/pi-builder/sessions", ALICE, "POST", { draftKey: randomUUID() });
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.body.place).toEqual({ key: "mine", projectName: null });
  });

  it("moving out of the project names who would stop seeing it", async () => {
    const pre = await call(`/flows/${ids.aliceFlow}/move-preview?to=mine`, ALICE);
    expect(pre.body.narrows).toBe(true);
    expect(pre.body.loses).toContain(BOB.email);
  });

  it("⚠ removing a member takes everything in it from them at once; what they owned passes to its owner", async () => {
    const r = await call(`/projects/${project}/members/${encodeURIComponent(BOB.subject)}`, ALICE, "DELETE");
    expect(r.status).toBe(200);
    expect(r.body.handedOver).toBe(1);
    expect((await call(`/flows/${ids.aliceFlow}`, BOB)).status).toBe(404);
    expect((await call(`/flows/${ids.bobFlow}`, BOB)).status).toBe(404);
    expect(await flowIds(BOB)).not.toContain(ids.aliceFlow);
    expect((await flowRow(ids.bobFlow)).ownerSubject).toBe(ALICE.subject);
    const told = await db.select().from(notifications).where(and(eq(notifications.workspaceId, ws!.id), eq(notifications.subject, BOB.subject), eq(notifications.kind, "project_changed")));
    expect(told.some((n) => n.title.includes("removed"))).toBe(true);
    // The owner cannot be removed; a member may leave on their own.
    expect((await call(`/projects/${project}/members/${encodeURIComponent(ALICE.subject)}`, ADA, "DELETE")).status).toBe(409);
    await call(`/projects/${project}/members`, ALICE, "POST", { subject: BOB.subject });
    expect((await call(`/projects/${project}/members/${encodeURIComponent(BOB.subject)}`, BOB, "DELETE")).status).toBe(200);
    expect((await call(`/projects/${project}`, BOB)).status).toBe(404);
  });

  it("⚠ deleting a project returns each item to its owner's My space — never to the workspace", async () => {
    expect((await call(`/projects/${project}`, BOB, "DELETE")).status).toBe(404);
    const r = await call(`/projects/${project}`, ALICE, "DELETE");
    expect(r.status).toBe(200);
    expect(r.body.returned).toBe(3);
    for (const id of [ids.aliceFlow, ids.bobFlow]) {
      const f = await flowRow(id);
      expect([f.projectId, f.visibility]).toEqual([null, "private"]);
    }
    const [c] = await db.select().from(piChats).where(eq(piChats.id, ids.aliceChat));
    expect([c!.projectId, c!.visibility]).toEqual([null, "private"]);
    expect((await call(`/flows/${ids.aliceFlow}`, CAROL)).status).toBe(404);
  });
});
