import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditEvents, platformRoleAssignments, workspaceEmergencyAccess, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";
import { mountedRoutes } from "../auth/route-stack.js";
import { ROUTE_PERMISSIONS, routeKey } from "../auth/route-permissions.js";

/**
 * Restricted workspaces (plans/restricted-workspaces-2026-10-29, phases 1–2), measured through the REAL app:
 *
 *   - in a restricted workspace a super admin holds nothing and a platform admin's conferral does not apply;
 *   - only its own admins rename, delete, restrict or open it up;
 *   - a super admin gets in only through an emergency access — a reason, a few hours, audited in that workspace —
 *     and is out again once it ends or expires.
 *
 * ⚠ Every refusal has its control: the same person in an OPEN workspace is let in, and the workspace's own admin is
 * let in to the restricted one. Without them, "refuse everyone" passes every assertion below.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
type Who = { subject: string; email: string };
const ADA: Who = { subject: `oid-rw-ada-${stamp}`, email: `ada-${stamp}@acme-hr.example` }; // the restricted workspace's own admin
const SAM: Who = { subject: `oid-rw-sam-${stamp}`, email: `sam-${stamp}@acme-hr.example` }; // super admin (allowlist), member of nothing
const BEN: Who = { subject: `oid-rw-ben-${stamp}`, email: `ben-${stamp}@acme-hr.example` }; // an ordinary member (author) of it
const PAT: Who = { subject: `oid-rw-pat-${stamp}`, email: `pat-${stamp}@acme-hr.example` }; // platform admin, member of nothing

const closed = await workspaceRepo.create({ name: `restricted ${stamp}`, tenantSlug: "rwwire", slug: `rwwire-c-${stamp}` });
const open = await workspaceRepo.create({ name: `open ${stamp}`, tenantSlug: "rwwire", slug: `rwwire-o-${stamp}` });
const reachable = !!closed && !!open;

async function identity(who: Who): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

async function call(path: string, as: Who, method = "GET", body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const inWs = (id: string, path: string, as: Who, method = "GET", body?: unknown) => call(`/workspaces/${id}${path}`, as, method, body);
const REASON = "Payroll run failing in this workspace, admins unreachable";
const startAccess = (workspaceId: string, as: Who, over: Record<string, unknown> = {}) =>
  call("/platform/emergency-access", as, "POST", { workspaceId, reason: REASON, hours: 1, ...over });

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  config.superAdminEmails.add(SAM.email);
  await db.insert(workspaceMembers).values([
    { workspaceId: closed!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: closed!.id, ...BEN, role: "author", grantedBy: "test" },
  ]);
  await db.insert(platformRoleAssignments).values({ ...PAT, roleKey: "platform-admin", grantedBy: "test" });
  await db.update(workspacesTable).set({ restricted: true, restrictedBy: ADA.email, restrictedAt: new Date() }).where(eq(workspacesTable.id, closed!.id));
});

afterAll(async () => {
  config.superAdminEmails.delete(SAM.email);
  if (reachable) {
    await db.delete(platformRoleAssignments).where(eq(platformRoleAssignments.subject, PAT.subject));
    await db.delete(workspacesTable).where(inArray(workspacesTable.id, [closed!.id, open!.id]));
  }
  server?.close();
});

describe.skipIf(!reachable)("a restricted workspace, at the wire", () => {
  it("CONTROL: its own admin is let in", async () => {
    expect((await inWs(closed!.id, "/flows", ADA)).status).toBe(200);
    expect((await inWs(closed!.id, "/members", ADA)).status).toBe(200);
  });

  it("EVERY workspace route refuses a super admin (no emergency access) and a platform admin, and lets its own admin past", async () => {
    const targets = mountedRoutes(app).filter((r) => ROUTE_PERMISSIONS.get(routeKey(r.method, r.path))?.kind === "workspace");
    expect(targets.length).toBeGreaterThan(200); // the sweep must have something to sweep
    const UUID = "00000000-0000-0000-0000-000000000001";
    const status = async (method: string, path: string, who: Who) => {
      const url = base + path.replace(/:workspaceId/g, closed!.id).replace(/:id(?=\/|$)/g, closed!.id).replace(/:[A-Za-z]+/g, UUID);
      const res = await fetch(url, {
        method,
        headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(who), "content-type": "application/json" },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      await res.arrayBuffer();
      return res.status;
    };
    const leaked: string[] = [];
    const adminRefused: string[] = [];
    for (const r of targets) {
      const key = routeKey(r.method, r.path);
      for (const who of [SAM, PAT]) {
        const st = await status(r.method, r.path, who);
        if (st !== 401 && st !== 403) leaked.push(`${key} → ${st} for ${who === SAM ? "super admin" : "platform admin"}`);
      }
      // "Past the guard" is anything but 401/403: most of these address a fixture that does not exist.
      const own = await status(r.method, r.path, ADA);
      if (own === 401 || own === 403) adminRefused.push(`${key} → ${own}`);
    }
    expect(leaked).toEqual([]);
    expect(adminRefused).toEqual([]);
  }, 120_000);

  it("a super admin holds nothing in it — and CONTROL, everything in an open workspace", async () => {
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(403);
    expect((await inWs(closed!.id, "/members", SAM)).status).toBe(403);
    expect((await inWs(open!.id, "/flows", SAM)).status).toBe(200);
  });

  it("a platform admin's conferral does not apply in it — and CONTROL, it does in an open workspace", async () => {
    expect((await inWs(closed!.id, "/members", PAT)).status).toBe(403);
    expect((await inWs(open!.id, "/members", PAT)).status).toBe(200);
  });

  it("only its own admins rename it, delete it, or open it up", async () => {
    expect((await call(`/workspaces/${closed!.id}`, SAM, "PATCH", { name: "taken over" })).status).toBe(403);
    expect((await call(`/workspaces/${closed!.id}`, SAM, "DELETE")).status).toBe(403);
    expect((await inWs(closed!.id, "/restricted", SAM, "PUT", { restricted: false })).status).toBe(403);
    expect((await inWs(closed!.id, "/restricted", PAT, "PUT", { restricted: false })).status).toBe(403);
    expect((await call(`/local-users/x/access/${closed!.id}`, SAM, "DELETE")).status).toBe(403);
    // A platform admin's conferred members.grant passes the guard in an OPEN workspace; the handler still refuses,
    // because restricting is for the workspace's own admins.
    expect((await inWs(open!.id, "/restricted", PAT, "PUT", { restricted: true })).status).toBe(403);
    // …and the emergency-access record is the workspace's own: not readable through conferral either
    // (rbac:platform-verify found this — the bound of 11 conferred routes).
    expect((await inWs(open!.id, "/emergency-access", PAT)).status).toBe(403);
    const [row] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, closed!.id));
    expect(row!.restricted).toBe(true);
    expect(row!.name).toBe(`restricted ${stamp}`);
  });

  it("CONTROL: its own admin can open it up and restrict it again", async () => {
    expect((await inWs(closed!.id, "/restricted", ADA, "PUT", { restricted: false })).status).toBe(200);
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(200);
    expect((await inWs(closed!.id, "/restricted", ADA, "PUT", { restricted: true })).status).toBe(200);
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(403);
  });
});

describe.skipIf(!reachable)("creating a restricted workspace", () => {
  it("makes its creator its first admin, and is closed to the platform from the first moment", async () => {
    const made = await call("/workspaces", SAM, "POST", { name: `made restricted ${stamp}`, description: "A restricted workspace made by the wire test, to check who gets in.", restricted: true });
    expect(made.status).toBe(201);
    const id = (made.body.workspace as { id: string; restricted: boolean }).id;
    try {
      expect((made.body.workspace as { restricted: boolean }).restricted).toBe(true);
      const [member] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.subject, SAM.subject)));
      expect(member?.role).toBe("admin");
      // Its creator gets in as its admin — not through the allowlist, which no longer counts here.
      expect((await inWs(id, "/members", SAM)).status).toBe(200);
      expect((await inWs(id, "/members", PAT)).status).toBe(403);
    } finally {
      await db.delete(workspacesTable).where(eq(workspacesTable.id, id));
    }
  });
});

describe.skipIf(!reachable)("emergency access, at the wire", () => {
  it("is refused to anyone not on the super-admin allowlist, without a real reason, and where it is not needed", async () => {
    expect((await startAccess(closed!.id, PAT)).status).toBe(403);
    expect((await startAccess(closed!.id, SAM, { reason: "need in" })).status).toBe(400);
    expect((await startAccess(closed!.id, SAM, { hours: 8 })).status).toBe(400);
    expect((await startAccess(open!.id, SAM)).status).toBe(409);
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(403);
  });

  it("lets the super admin in while open, is recorded in the workspace, and its admin ends it", async () => {
    const started = await startAccess(closed!.id, SAM);
    expect(started.status).toBe(201);
    const id = (started.body.access as { id: string }).id;
    expect(started.body.notified).toMatch(/^not emailed/); // every address here is on a reserved domain
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(200);
    // Asking again while one is open answers that one.
    expect(((await startAccess(closed!.id, SAM)).body.access as { id: string }).id).toBe(id);

    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, closed!.id), eq(auditEvents.operation, "access")));
    expect(audit.some((a) => a.description.includes("Emergency access") && a.description.includes(REASON))).toBe(true);

    const listed = await inWs(closed!.id, "/emergency-access", ADA);
    expect(listed.status).toBe(200);
    expect((listed.body.accesses as Array<{ id: string; open: boolean }>).find((a) => a.id === id)?.open).toBe(true);

    expect((await inWs(closed!.id, `/emergency-access/${id}/end`, ADA, "POST")).status).toBe(200);
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(403);
  });

  it("the holder can end their own", async () => {
    const id = ((await startAccess(closed!.id, SAM)).body.access as { id: string }).id;
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(200);
    expect((await inWs(closed!.id, `/emergency-access/${id}/end`, SAM, "POST")).status).toBe(200);
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(403);
  });

  it("ends by itself when it expires", async () => {
    const id = ((await startAccess(closed!.id, SAM)).body.access as { id: string }).id;
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(200);
    const past = new Date(Date.now() - 60_000);
    await db
      .update(workspaceEmergencyAccess)
      .set({ startedAt: new Date(past.getTime() - 3_600_000), expiresAt: past })
      .where(eq(workspaceEmergencyAccess.id, id));
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(403);
  });

  it("only its admins or the holder end it — not an ordinary member, not a platform admin", async () => {
    const id = ((await startAccess(closed!.id, SAM)).body.access as { id: string }).id;
    // BEN passes the route's members.read; the SERVICE refuses him. PAT is refused at the guard (no conferral here).
    expect((await inWs(closed!.id, "/emergency-access", BEN)).status).toBe(200);
    expect((await inWs(closed!.id, `/emergency-access/${id}/end`, BEN, "POST")).status).toBe(403);
    expect((await inWs(closed!.id, `/emergency-access/${id}/end`, PAT, "POST")).status).toBe(403);
    expect((await inWs(closed!.id, "/flows", SAM)).status).toBe(200);
    await inWs(closed!.id, `/emergency-access/${id}/end`, SAM, "POST");
  });
});
