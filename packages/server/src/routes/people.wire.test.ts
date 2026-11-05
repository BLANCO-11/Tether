import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { personInvitations, platformRoleAssignments, platformUsers, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * People (admin simplify, phase 3), through the REAL app on the tests' own database:
 *
 *   - one row per person, with each workspace they reach and their role there;
 *   - a person recorded once, not once per id (phase 1's merge is what makes that hold);
 *   - a restricted workspace the viewer is outside of is a NAME only: none of its members' rows mention it;
 *   - what the viewer may do is said, per workspace, so the screen offers only what will work;
 *   - CONTROL: somebody without `platform.users.read` gets nothing.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const person = (n: string) => ({ subject: `oid-pp-${n}-${stamp}`, email: `${n}-${stamp}@people.example` });
const PAT = person("pat"); // platform admin, admin of A
const ALICE = person("alice"); // creator in A, observer in B
const RHEA = person("rhea"); // admin of R (restricted), nowhere else

const A = await workspaceRepo.create({ name: `people A ${stamp}`, tenantSlug: "ppwire", slug: `ppa-${stamp}` });
const B = await workspaceRepo.create({ name: `people B ${stamp}`, tenantSlug: "ppwire", slug: `ppb-${stamp}` });
const R = await workspaceRepo.create({ name: `people R ${stamp}`, tenantSlug: "ppwire", slug: `ppr-${stamp}` });
const reachable = !!A && !!B && !!R;

type Who = { subject: string; email: string };
const identity = (who: Who) =>
  new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
async function get(path: string, as: Who) {
  const res = await fetch(`${base}/api${path}`, {
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
type P = { subject: string; workspaces: { id: string; role: string | null }[] };

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  await db.update(workspacesTable).set({ restricted: true } as never).where(eq(workspacesTable.id, R!.id));
  await db.insert(workspaceMembers).values([
    { workspaceId: A!.id, ...PAT, role: "admin", grantedBy: "test" },
    { workspaceId: A!.id, ...ALICE, role: "author", grantedBy: "test" },
    { workspaceId: B!.id, ...ALICE, role: "viewer", grantedBy: "test" },
    { workspaceId: R!.id, ...RHEA, role: "admin", grantedBy: "test" },
  ]);
  await db.insert(platformRoleAssignments).values({ ...PAT, roleKey: "platform-admin", grantedBy: "test" });
  await db.insert(platformUsers).values([PAT, ALICE].map((p) => ({ subject: p.subject, email: p.email })));
});

afterAll(async () => {
  if (reachable) {
    await db.delete(platformRoleAssignments).where(eq(platformRoleAssignments.subject, PAT.subject));
    await db.delete(platformUsers).where(sql`email LIKE ${`%-${stamp}@people.example`}`);
    await db.delete(personInvitations).where(sql`email LIKE ${`%-${stamp}@people.example`}`);
    await db.delete(workspacesTable).where(inArray(workspacesTable.id, [A!.id, B!.id, R!.id]));
  }
  server?.close();
});

describe.skipIf(!reachable)("People, through the real app", () => {
  it("one row per person, each workspace they reach with their role", async () => {
    const r = await get("/platform/people", PAT);
    expect(r.status).toBe(200);
    const people = r.body.people as P[];
    const alice = people.filter((p) => p.subject === ALICE.subject);
    expect(alice).toHaveLength(1);
    const roles = Object.fromEntries(alice[0]!.workspaces.filter((w) => [A!.id, B!.id].includes(w.id)).map((w) => [w.id, w.role]));
    expect(roles).toEqual({ [A!.id]: "author", [B!.id]: "viewer" });
  });

  it("a restricted workspace the viewer is outside of is a name only", async () => {
    const r = await get("/platform/people", PAT);
    expect(r.body.closedWorkspaces).toContain(R!.name);
    const all = (r.body.people as P[]).flatMap((p) => p.workspaces.map((w) => w.id));
    expect(all).not.toContain(R!.id);
    expect((r.body.workspaces as { id: string }[]).map((w) => w.id)).not.toContain(R!.id);
  });

  it("says what the viewer may do, per workspace", async () => {
    const r = await get("/platform/people", PAT);
    const ws = Object.fromEntries((r.body.workspaces as { id: string; canAddPeople: boolean }[]).map((w) => [w.id, w.canAddPeople]));
    expect(ws[A!.id]).toBe(true);
    expect(r.body.can).toMatchObject({ givePlatformRoles: true, createLocalAccounts: true });
  });

  it("CONTROL: somebody without platform.users.read gets nothing", async () => {
    const r = await get("/platform/people", ALICE);
    expect(r.status).toBe(403);
    expect(r.body.people).toBeUndefined();
  });
});
