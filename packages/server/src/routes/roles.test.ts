import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  workspaceMembers,
  workspaceMemberCapabilities,
  workspaceRoles,
  workspaceRoleAssignments,
  auditEvents,
  workspaces as workspacesTable,
} from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * The custom-role routes over real HTTP.
 *
 * Over the wire rather than by calling handlers, because the thing under test is **which
 * middleware runs** — the spliced permission guard included — and a direct call skips it
 * entirely.
 */

const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const KEY = config.parentApiKey;
const ADMIN = { subject: "oid-rolesroute-admin", email: "rolesadmin@acme-hr.example" };
const AUTHOR = { subject: "oid-rolesroute-author", email: "rolesauthor@acme-hr.example" };
const STRANGER = { subject: "oid-rolesroute-none", email: "rolesnone@acme-hr.example" };

const ws = await workspaceRepo.create({
  name: "rbac roles route tests",
  tenantSlug: "rolesroute",
  slug: `rolesroute-${Date.now().toString(36)}`,
});
const reachable = !!ws;

async function identity(who: { subject: string; email: string }): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; as?: { subject: string; email: string } } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "x-api-key": KEY, "content-type": "application/json" };
  if (opts.as) headers["x-foundry-identity"] = await identity(opts.as);
  const res = await fetch(`${base}/api/workspaces/${ws!.id}${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (!reachable) return;
  await db.delete(workspaceRoleAssignments).where(eq(workspaceRoleAssignments.workspaceId, ws!.id));
  await db.delete(workspaceRoles).where(eq(workspaceRoles.workspaceId, ws!.id));
  await db
    .delete(workspaceMemberCapabilities)
    .where(eq(workspaceMemberCapabilities.workspaceId, ws!.id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
  for (const [who, role] of [
    [ADMIN, "admin"],
    [AUTHOR, "author"],
  ] as const) {
    await db.insert(workspaceMembers).values({
      workspaceId: ws!.id,
      subject: who.subject,
      email: who.email,
      role,
      grantedBy: "test",
    });
  }
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (!reachable) return;
  await db.delete(workspaceRoleAssignments).where(eq(workspaceRoleAssignments.workspaceId, ws!.id));
  await db.delete(workspaceRoles).where(eq(workspaceRoles.workspaceId, ws!.id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
  await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws!.id));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
});

describe.skipIf(!reachable)("the permission guard is mounted on these routes too", () => {
  it("a stranger is refused, naming the permission", async () => {
    const res = await call("/roles", { as: STRANGER });
    expect(res.status).toBe(403);
    expect(res.body.permission).toBe("members.read");
  });

  it("an anonymous caller with only the API key is 401, not 403", async () => {
    const res = await call("/roles");
    expect(res.status).toBe(401);
  });

  it("CONTROL: an admin reads the list", async () => {
    const res = await call("/roles", { as: ADMIN });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.roles)).toBe(true);
  });

  it("an author may READ roles but not create one", async () => {
    // `members.read` is in the author preset; `roles.write` is not.
    expect((await call("/roles", { as: AUTHOR })).status).toBe(200);
    const res = await call("/roles", {
      method: "POST",
      as: AUTHOR,
      body: { name: "Nope", permissions: ["flows.read"] },
    });
    expect(res.status).toBe(403);
    expect(res.body.permission).toBe("roles.write");
  });
});

/**
 * FR-025 — `.strict()`, and it is a control rather than tidiness.
 *
 * ⚠ A field that is accepted and IGNORED reads, to whoever added it, exactly like a
 * field that works — and the next person wires it up. Refusing is what stops that.
 */
describe.skipIf(!reachable)("FR-025: no request field can name the caller's own authority", () => {
  it("refuses a create body carrying `subject`", async () => {
    const res = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "X", permissions: ["flows.read"], subject: "somebody-else" },
    });
    expect(res.status).toBe(400);
  });

  it("refuses a create body carrying `grantedBy`, `workspaceId` or `bySuperAdmin`", async () => {
    for (const extra of [
      { grantedBy: "root" },
      { workspaceId: "00000000-0000-0000-0000-000000000000" },
      { bySuperAdmin: true },
    ]) {
      const res = await call("/roles", {
        method: "POST",
        as: ADMIN,
        body: { name: "X", permissions: ["flows.read"], ...extra },
      });
      expect(res.status, `${JSON.stringify(extra)} was not refused`).toBe(400);
    }
  });

  it("refuses an assign body carrying `permissions`", async () => {
    // Otherwise a caller could assign a role and widen it in the same request.
    const created = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "Assignable", permissions: ["flows.read"] },
    });
    const roleId = (created.body.role as { id: string }).id;
    const res = await call(`/roles/${roleId}/members`, {
      method: "POST",
      as: ADMIN,
      body: { subject: AUTHOR.subject, permissions: ["secrets.read"] },
    });
    expect(res.status).toBe(400);
  });

  it("CONTROL: the same bodies WITHOUT the extra field succeed", async () => {
    const created = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "Clean", permissions: ["flows.read"] },
    });
    expect(created.status).toBe(201);
    const roleId = (created.body.role as { id: string }).id;
    const assigned = await call(`/roles/${roleId}/members`, {
      method: "POST",
      as: ADMIN,
      body: { subject: AUTHOR.subject },
    });
    expect(assigned.status).toBe(201);
  });
});

describe.skipIf(!reachable)("the refusals a client has to render", () => {
  it("an author is stopped by the ROUTE GUARD first — they cannot author roles at all", async () => {
    // ⚠ Worth stating explicitly, because it is why the next test has to work harder:
    // `roles.write` sits in the `admin` preset only, so an ordinary author never reaches
    // FR-009's check. Two different refusals for two different problems.
    const res = await call("/roles", {
      method: "POST",
      as: AUTHOR,
      body: { name: "Sneaky", permissions: ["secrets.read"] },
    });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("missing_permission");
    expect(res.body.permission).toBe("roles.write");
  });

  it("`role_exceeds_granter` names the permission and not the caller's own set", async () => {
    // ⚠ THE REAL FR-009 CASE, and it needs a caller who MAY author roles and still does
    // not hold everything: an author granted `roles.write` individually. That is exactly
    // the situation per-feature granting creates, and the one where role authoring would
    // otherwise become privilege escalation with extra steps.
    await db.insert(workspaceMemberCapabilities).values({
      workspaceId: ws!.id,
      subject: AUTHOR.subject,
      capability: "roles.write",
      grantedBy: "test",
    });

    const res = await call("/roles", {
      method: "POST",
      as: AUTHOR,
      body: { name: "Sneaky", permissions: ["secrets.read"] },
    });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("role_exceeds_granter");
    const blob = JSON.stringify(res.body);
    expect(blob).toContain("secrets.read");
    // FR-021 — never a list of what the caller does hold.
    for (const held of ["flows.write", "catalogue.read", "runs.read"]) {
      expect(blob, `the refusal listed the caller's own "${held}"`).not.toContain(held);
    }

    // CONTROL: the same caller CAN author a role from what they do hold.
    const ok = await call("/roles", {
      method: "POST",
      as: AUTHOR,
      body: { name: "Within Reach", permissions: ["flows.read"] },
    });
    expect(ok.status).toBe(201);
  });

  it("a platform permission is a 400 that explains, not a database error", async () => {
    const res = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "Escalate", permissions: ["platform.members.grant"] },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/platform permission/i);
  });

  it("a preset name is a 409 that says why it is ambiguous", async () => {
    const res = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "admin", permissions: ["flows.read"] },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/built-in/i);
  });

  it("retiring a held role is a 409 CARRYING THE COUNT, and confirm=true goes through", async () => {
    const created = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "Held", permissions: ["flows.read"] },
    });
    const roleId = (created.body.role as { id: string }).id;
    await call(`/roles/${roleId}/members`, {
      method: "POST",
      as: ADMIN,
      body: { subject: AUTHOR.subject },
    });

    const refused = await call(`/roles/${roleId}`, { method: "DELETE", as: ADMIN });
    expect(refused.status).toBe(409);
    expect(refused.body.assignees).toBe(1);
    expect(JSON.stringify(refused.body)).toMatch(/1 person holds/);

    const confirmed = await call(`/roles/${roleId}?confirm=true`, { method: "DELETE", as: ADMIN });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ retired: true, hadAssignees: 1 });
  });

  it("assigning to a non-member is a 409 naming the missing membership", async () => {
    const created = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "ForOutsiders", permissions: ["flows.read"] },
    });
    const roleId = (created.body.role as { id: string }).id;
    const res = await call(`/roles/${roleId}/members`, {
      method: "POST",
      as: ADMIN,
      body: { subject: STRANGER.subject },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/not a member/i);
  });
});

describe.skipIf(!reachable)("end to end: the Story 3 independent test", () => {
  it("two permissions, assigned, narrowed, then retired — no sign-out anywhere", async () => {
    // Create with two permissions.
    const created = await call("/roles", {
      method: "POST",
      as: ADMIN,
      body: { name: "Finance Reviewer", permissions: ["audit.read", "budget.read"] },
    });
    expect(created.status).toBe(201);
    const roleId = (created.body.role as { id: string }).id;

    // Assign to somebody whose preset has neither.
    expect(
      (
        await call(`/roles/${roleId}/members`, {
          method: "POST",
          as: ADMIN,
          body: { subject: AUTHOR.subject },
        })
      ).status,
    ).toBe(201);

    const { effectivePermissionsService } = await import(
      "../services/effective-permissions.service.js"
    );
    let eff = await effectivePermissionsService.forWorkspace(AUTHOR, ws!.id);
    expect(eff.permissions).toContain("audit.read");
    expect(eff.permissions).toContain("budget.read");

    // Remove ONE permission — exactly one thing stops working.
    expect(
      (
        await call(`/roles/${roleId}`, {
          method: "PATCH",
          as: ADMIN,
          body: { permissions: ["audit.read"] },
        })
      ).status,
    ).toBe(200);

    // ⚠ No sign-out, no new token: the next request is decided from the database.
    eff = await effectivePermissionsService.forWorkspace(AUTHOR, ws!.id);
    expect(eff.permissions).toContain("audit.read");
    expect(eff.permissions).not.toContain("budget.read");

    // Retire it; the rest of their access is untouched.
    expect(
      (await call(`/roles/${roleId}?confirm=true`, { method: "DELETE", as: ADMIN })).status,
    ).toBe(200);
    eff = await effectivePermissionsService.forWorkspace(AUTHOR, ws!.id);
    expect(eff.permissions).not.toContain("audit.read");
    expect(eff.permissions).toContain("flows.write");
    expect(eff.memberRole).toBe("author");
  });
});
