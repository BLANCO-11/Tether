import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { personInvitations, platformUsers, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";
import { _resetPersonMergeCache } from "../services/person-merge.service.js";

/**
 * Invitations (admin simplify, phase 2), measured through the REAL app on the tests' own database:
 *
 *   - an admin invites an email to several workspaces, each with its role, before that person has ever signed in;
 *   - the person's FIRST request already sees their workspaces — nothing to wait for, nobody to ask;
 *   - nobody can invite into a workspace they could not add people to, and nothing is kept when they try;
 *   - an invitation never lowers a role somebody already holds; an expired or withdrawn one gives nothing;
 *   - an email that has already signed in gets its access at once, with no invitation left behind.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const person = (n: string) => ({ subject: `oid-iv-${n}-${stamp}`, email: `${n}-${stamp}@invite.example` });
const ADA = person("ada"); // admin of A and B
const ALICE = person("alice"); // creator in A
const NEW = person("newbie"); // never signed in
const LATE = person("late"); // invited, then the invitation expires
const GONE = person("gone"); // invited, then withdrawn
const KNOWN = person("known"); // has signed in already

const A = await workspaceRepo.create({ name: `invite A ${stamp}`, tenantSlug: "ivwire", slug: `iva-${stamp}` });
const B = await workspaceRepo.create({ name: `invite B ${stamp}`, tenantSlug: "ivwire", slug: `ivb-${stamp}` });
const C = await workspaceRepo.create({ name: `invite C ${stamp}`, tenantSlug: "ivwire", slug: `ivc-${stamp}` }); // Ada is not in it
const reachable = !!A && !!B && !!C;
const emails = [NEW, LATE, GONE, KNOWN].map((p) => p.email);

type Who = { subject: string; email: string };
const identity = (who: Who) =>
  new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));

async function call(path: string, as: Who, method = "GET", body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const roleIn = async (workspaceId: string, subject: string) =>
  (await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.subject, subject))))[0]
    ?.role ?? null;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  await db.insert(workspaceMembers).values([
    { workspaceId: A!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: B!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: A!.id, ...ALICE, role: "author", grantedBy: "test" },
  ]);
  await db.insert(platformUsers).values({ subject: KNOWN.subject, email: KNOWN.email });
});

afterAll(async () => {
  if (reachable) {
    await db.delete(personInvitations).where(inArray(personInvitations.email, emails));
    await db.delete(platformUsers).where(sql`email LIKE ${`%-${stamp}@invite.example`}`);
    await db.delete(workspacesTable).where(inArray(workspacesTable.id, [A!.id, B!.id, C!.id]));
  }
  server?.close();
});

describe.skipIf(!reachable)("invitations, through the real app", () => {
  it("an admin invites somebody who has never signed in, to two workspaces with a role in each", async () => {
    const r = await call("/invitations", ADA, "POST", {
      email: NEW.email.toUpperCase(),
      workspaces: [
        { workspaceId: A!.id, role: "author" },
        { workspaceId: B!.id, role: "viewer" },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBe(false);
    const inv = r.body.invitation as { email: string; workspaces: { workspaceName: string; role: string }[] };
    expect(inv.email).toBe(NEW.email);
    expect(inv.workspaces.map((w) => w.role).sort()).toEqual(["author", "viewer"]);
  });

  it("their FIRST request already sees both workspaces — ready from the first page", async () => {
    _resetPersonMergeCache();
    const r = await call("/workspaces", NEW);
    expect(r.status).toBe(200);
    const ids = ((r.body.workspaces ?? r.body) as { id: string }[]).map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([A!.id, B!.id]));
    expect(await roleIn(A!.id, NEW.subject)).toBe("author");
    expect(await roleIn(B!.id, NEW.subject)).toBe("viewer");
    expect((await call("/invitations", ADA)).body.invitations).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ email: NEW.email })]),
    );
  });

  it("CONTROL: nobody invites where they could not add people, and nothing is kept", async () => {
    const creator = await call("/invitations", ALICE, "POST", { email: LATE.email, workspaces: [{ workspaceId: A!.id, role: "admin" }] });
    expect(creator.status).toBe(403);
    const elsewhere = await call("/invitations", ADA, "POST", {
      email: LATE.email,
      workspaces: [
        { workspaceId: A!.id, role: "author" },
        { workspaceId: C!.id, role: "author" },
      ],
    });
    expect(elsewhere.status).toBe(403);
    expect(String(elsewhere.body.message)).toContain(C!.name);
    expect((await db.select().from(personInvitations).where(eq(personInvitations.email, LATE.email))).length).toBe(0);
  });

  it("a workspace admin cannot hand out a platform role by inviting somebody", async () => {
    const r = await call("/invitations", ADA, "POST", { email: LATE.email, platformRole: "platform-admin" });
    expect(r.status).toBe(403);
    expect((await db.select().from(personInvitations).where(eq(personInvitations.email, LATE.email))).length).toBe(0);
  });

  it("an expired invitation gives nothing; a withdrawn one gives nothing", async () => {
    expect((await call("/invitations", ADA, "POST", { email: LATE.email, workspaces: [{ workspaceId: A!.id, role: "author" }] })).status).toBe(201);
    await db.update(personInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(personInvitations.email, LATE.email));
    const g = await call("/invitations", ADA, "POST", { email: GONE.email, workspaces: [{ workspaceId: A!.id, role: "author" }] });
    const id = (g.body.invitation as { id: string }).id;
    expect((await call(`/invitations/${id}`, ALICE, "DELETE")).status).toBe(403);
    expect((await call(`/invitations/${id}`, ADA, "DELETE")).status).toBe(200);
    _resetPersonMergeCache();
    await call("/workspaces", LATE);
    await call("/workspaces", GONE);
    expect(await roleIn(A!.id, LATE.subject)).toBeNull();
    expect(await roleIn(A!.id, GONE.subject)).toBeNull();
  });

  it("an email that has already signed in gets the access at once, with no invitation kept", async () => {
    const r = await call("/invitations", ADA, "POST", { email: KNOWN.email, workspaces: [{ workspaceId: B!.id, role: "approver" }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, subject: KNOWN.subject });
    expect(await roleIn(B!.id, KNOWN.subject)).toBe("approver");
    expect((await db.select().from(personInvitations).where(eq(personInvitations.email, KNOWN.email))).length).toBe(0);
  });

  it("an invitation never lowers a role the person already holds", async () => {
    const STRONG = person("strong");
    // Access already given under their email (the case phase 1 merges), stronger than the invitation's.
    await db.insert(workspaceMembers).values({ workspaceId: A!.id, subject: STRONG.email, email: STRONG.email, role: "admin", grantedBy: "test" });
    await call("/invitations", ADA, "POST", { email: STRONG.email, workspaces: [{ workspaceId: A!.id, role: "viewer" }] });
    _resetPersonMergeCache();
    await call("/workspaces", STRONG);
    expect(await roleIn(A!.id, STRONG.subject)).toBe("admin");
    await db.delete(personInvitations).where(eq(personInvitations.email, STRONG.email));
  });

  it("the list shows each reader only the workspaces they may see", async () => {
    // A second admin, of A only, sees the A part of an invitation to A and B and not the B part.
    const ADMIN_A = person("admin-a");
    await db.insert(workspaceMembers).values({ workspaceId: A!.id, ...ADMIN_A, role: "admin", grantedBy: "test" });
    const OTHER = person("other");
    await call("/invitations", ADA, "POST", {
      email: OTHER.email,
      workspaces: [
        { workspaceId: A!.id, role: "author" },
        { workspaceId: B!.id, role: "author" },
      ],
    });
    const mine = ((await call("/invitations", ADMIN_A)).body.invitations as { email: string; workspaces: { workspaceId: string }[] }[]).find(
      (i) => i.email === OTHER.email,
    );
    expect(mine?.workspaces.map((w) => w.workspaceId)).toEqual([A!.id]);
    // A Creator reads members, so sees who is about to join A — and never anything of B.
    const alices = (await call("/invitations", ALICE)).body.invitations as { workspaces: { workspaceId: string }[] }[];
    expect(alices.flatMap((i) => i.workspaces.map((w) => w.workspaceId)).every((id) => id === A!.id)).toBe(true);
    // CONTROL: somebody in none of these workspaces sees none of these invitations.
    const outsider = (await call("/invitations", person("outsider"))).body.invitations as { email: string }[];
    expect(outsider.filter((i) => i.email.endsWith(`-${stamp}@invite.example`))).toEqual([]);
    await db.delete(personInvitations).where(eq(personInvitations.email, OTHER.email));
  });
});
