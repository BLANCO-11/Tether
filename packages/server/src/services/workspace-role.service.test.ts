import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  workspaceMembers,
  workspaceRoles,
  workspaceRoleAssignments,
  auditEvents,
  workspaces as workspacesTable,
} from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { workspaceRoleService } from "./workspace-role.service.js";
import { workspaceRoleRepo } from "../repositories/workspace-role.repo.js";
import { effectivePermissionsService } from "./effective-permissions.service.js";

/**
 * Custom roles — one test per invariant, each with a positive control.
 *
 * ⚠ Every refusal test in this file is satisfied by a service that refuses everything,
 * so every one of them is paired with the case that must still WORK. That pairing is the
 * only thing separating "the invariant holds" from "the feature is broken".
 */

const ADMIN = { subject: "oid-role-admin", email: "roleadmin@acme-hr.example" };
const AUTHOR = { subject: "oid-role-author", email: "roleauthor@acme-hr.example" };
const OUTSIDER = { subject: "oid-role-outsider", email: "roleoutsider@acme-hr.example" };

const ws = await workspaceRepo.create({
  name: "rbac custom role tests",
  tenantSlug: "roletests",
  slug: `roletests-${Date.now().toString(36)}`,
});
const reachable = !!ws;

async function wipe() {
  if (!reachable) return;
  await db.delete(workspaceRoleAssignments).where(eq(workspaceRoleAssignments.workspaceId, ws!.id));
  await db.delete(workspaceRoles).where(eq(workspaceRoles.workspaceId, ws!.id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
  await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws!.id));
  for (const who of [ADMIN, AUTHOR]) {
    await db.insert(workspaceMembers).values({
      workspaceId: ws!.id,
      subject: who.subject,
      email: who.email,
      role: who === ADMIN ? "admin" : "author",
      grantedBy: "test",
    });
  }
}

beforeEach(wipe);
afterAll(async () => {
  if (!reachable) return;
  await db.delete(workspaceRoleAssignments).where(eq(workspaceRoleAssignments.workspaceId, ws!.id));
  await db.delete(workspaceRoles).where(eq(workspaceRoles.workspaceId, ws!.id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
  await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws!.id));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
});

const make = (permissions: string[], name = "Finance Reviewer", who = ADMIN) =>
  workspaceRoleService.create(ws!.id, { name, permissions }, who);

describe.skipIf(!reachable)("INV-6: a custom role may not be named after a preset", () => {
  it("refuses author / approver / admin, case-insensitively", async () => {
    for (const name of ["author", "Approver", "ADMIN"]) {
      await expect(make(["flows.read"], name)).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it("refuses a second LIVE role with the same name, case-insensitively", async () => {
    await make(["flows.read"], "Finance Reviewer");
    await expect(make(["flows.read"], "finance reviewer")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("CONTROL: an unused name is accepted", async () => {
    const role = await make(["flows.read"], "Finance Reviewer");
    expect(role.name).toBe("Finance Reviewer");
    expect(role.permissions).toEqual(["flows.read"]);
  });

  it("and a RETIRED role's name is free again", async () => {
    const first = await make(["flows.read"], "Finance Reviewer");
    await workspaceRoleService.retire(ws!.id, first.id, ADMIN);
    const second = await make(["flows.read"], "Finance Reviewer");
    expect(second.id).not.toBe(first.id);
  });
});

describe.skipIf(!reachable)("INV-7: retiring is a timestamp, never a delete", () => {
  it("the row survives so an audit entry naming it can still be resolved", async () => {
    const role = await make(["flows.read"]);
    await workspaceRoleService.retire(ws!.id, role.id, ADMIN);
    const after = await workspaceRoleRepo.get(role.id);
    expect(after).not.toBeNull();
    expect(after!.retiredAt).toBeInstanceOf(Date);
  });

  it("but it stops conferring immediately", async () => {
    const role = await make(["audit.read"]);
    await workspaceRoleService.assign(ws!.id, role.id, AUTHOR.subject, ADMIN);
    expect(
      (await effectivePermissionsService.forWorkspace(AUTHOR, ws!.id)).permissions,
    ).toContain("audit.read");

    await workspaceRoleService.retire(ws!.id, role.id, ADMIN, { confirm: true });
    expect(
      (await effectivePermissionsService.forWorkspace(AUTHOR, ws!.id)).permissions,
    ).not.toContain("audit.read");
  });

  it("⚠ refuses to retire a role people hold, and the refusal CARRIES THE COUNT", async () => {
    // "Are you sure?" with no number is a dialog people learn to click through.
    const role = await make(["flows.read"]);
    await workspaceRoleService.assign(ws!.id, role.id, AUTHOR.subject, ADMIN);
    await expect(workspaceRoleService.retire(ws!.id, role.id, ADMIN)).rejects.toMatchObject({
      statusCode: 409,
      assignees: 1,
    });
  });

  it("CONTROL: with confirm it goes through, and reports how many it affected", async () => {
    const role = await make(["flows.read"]);
    await workspaceRoleService.assign(ws!.id, role.id, AUTHOR.subject, ADMIN);
    await expect(
      workspaceRoleService.retire(ws!.id, role.id, ADMIN, { confirm: true }),
    ).resolves.toEqual({ retired: true, hadAssignees: 1 });
  });

  it("a role nobody holds retires without confirmation", async () => {
    const role = await make(["flows.read"]);
    await expect(workspaceRoleService.retire(ws!.id, role.id, ADMIN)).resolves.toMatchObject({
      hadAssignees: 0,
    });
  });
});

describe.skipIf(!reachable)("INV-8: no `platform.*` in a workspace role", () => {
  it("refuses, and says why rather than surfacing a database error", async () => {
    await expect(make(["platform.members.grant"])).rejects.toMatchObject({
      statusCode: 400,
      reason: "platform_permission",
    });
  });

  it("refuses a string that is no permission at all, naming it", async () => {
    await expect(make(["flows.superuser"])).rejects.toMatchObject({
      statusCode: 400,
      reason: "unknown_permission",
      permission: "flows.superuser",
    });
  });

  it("CONTROL: a workspace permission is accepted", async () => {
    await expect(make(["flows.read"])).resolves.toBeTruthy();
  });
});

describe.skipIf(!reachable)("INV-9: an assignee must already be a member", () => {
  it("refuses a non-member, naming the missing membership", async () => {
    const role = await make(["flows.read"]);
    await expect(
      workspaceRoleService.assign(ws!.id, role.id, OUTSIDER.subject, ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, reason: "not_a_member" });
  });

  it("CONTROL: a member is assigned", async () => {
    const role = await make(["flows.read"]);
    await expect(
      workspaceRoleService.assign(ws!.id, role.id, AUTHOR.subject, ADMIN),
    ).resolves.toBeUndefined();
    expect(await workspaceRoleService.holders(ws!.id, role.id)).toHaveLength(1);
  });

  it("a custom role ADDS to a membership and never replaces it", async () => {
    const role = await make(["audit.read"]);
    await workspaceRoleService.assign(ws!.id, role.id, AUTHOR.subject, ADMIN);
    const eff = await effectivePermissionsService.forWorkspace(AUTHOR, ws!.id);
    // Still everything the author preset gives...
    expect(eff.memberRole).toBe("author");
    expect(eff.permissions).toContain("flows.write");
    // ...plus the role.
    expect(eff.permissions).toContain("audit.read");
  });
});

/**
 * FR-009 — the most important rule in the file.
 *
 * ⚠ Without it, role authoring is privilege escalation with extra steps: anybody who may
 * create a role could compose "Everything" and assign it to themselves.
 */
describe.skipIf(!reachable)("FR-009: you cannot grant what you do not hold", () => {
  it("an author cannot put `secrets.read` in a role — they do not hold it", async () => {
    await expect(make(["secrets.read"], "Sneaky", AUTHOR)).rejects.toMatchObject({
      statusCode: 403,
      reason: "role_exceeds_granter",
      permission: "secrets.read",
    });
  });

  it("⚠ the refusal names the offending permission and NEVER what the caller holds", async () => {
    // FR-021/FR-023 — a 403 is the last place to publish a capability list to somebody
    // who has just demonstrated they are probing.
    const err = (await make(["secrets.read"], "Sneaky", AUTHOR).catch((e: unknown) => e)) as Error;
    const blob = `${err.message} ${JSON.stringify(err)}`;
    expect(blob).toContain("secrets.read");
    for (const held of ["flows.write", "catalogue.read", "runs.read", "templates.read"]) {
      expect(blob, `the refusal listed the caller's own "${held}"`).not.toContain(held);
    }
  });

  it("CONTROL: an author CAN put a permission they do hold into a role", async () => {
    // Without this, "refuse every author" scores 100% on the assertions above.
    await expect(make(["flows.read"], "Author's Role", AUTHOR)).resolves.toBeTruthy();
  });

  it("and an admin, who holds everything, can put anything in", async () => {
    await expect(make(["secrets.read", "audit.read"], "Admin's Role", ADMIN)).resolves.toBeTruthy();
  });

  it("⚠ it is enforced at ASSIGNMENT too, not only at authoring", async () => {
    // Otherwise "who may grant X" has two answers depending on whether X arrived
    // through a role or directly — and the role door is the unguarded one.
    const powerful = await make(["secrets.read"], "Powerful", ADMIN);
    await expect(
      workspaceRoleService.assign(ws!.id, powerful.id, AUTHOR.subject, AUTHOR),
    ).rejects.toMatchObject({ reason: "role_exceeds_granter" });
  });

  it("editing a role is checked the same way", async () => {
    const role = await make(["flows.read"], "Editable", ADMIN);
    await expect(
      workspaceRoleService.update(ws!.id, role.id, { permissions: ["secrets.read"] }, AUTHOR),
    ).rejects.toMatchObject({ reason: "role_exceeds_granter" });
  });
});

describe.skipIf(!reachable)("scoping and the record", () => {
  it("a role id from another workspace reads as ABSENT, not as somebody else's role", async () => {
    const other = await workspaceRepo.create({
      name: "role other",
      tenantSlug: "roletests",
      slug: `roletests-other-${Date.now().toString(36)}`,
    });
    try {
      const role = await make(["flows.read"]);
      await expect(workspaceRoleService.get(other!.id, role.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      if (other) await db.delete(workspacesTable).where(eq(workspacesTable.id, other.id));
    }
  });

  it("FR-033: creating, assigning and retiring are all on the record", async () => {
    const role = await make(["flows.read"]);
    await workspaceRoleService.assign(ws!.id, role.id, AUTHOR.subject, ADMIN);
    await workspaceRoleService.unassign(ws!.id, role.id, AUTHOR.subject, ADMIN);
    await workspaceRoleService.retire(ws!.id, role.id, ADMIN);

    const written = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, ws!.id));
    const descriptions = written.map((r) => r.description).sort();
    expect(descriptions).toEqual([
      'created Finance Reviewer',
      'granted role "Finance Reviewer"',
      'retired Finance Reviewer',
      'revoked role "Finance Reviewer"',
    ]);
    for (const r of written) expect(r.actor).toBe(ADMIN.subject);
  });

  it("the list shows presets BESIDE custom roles, with assignee counts", async () => {
    // A screen showing only custom roles implies a workspace with none has no roles at
    // all, when everybody in it holds one.
    await make(["flows.read"]);
    const roles = await workspaceRoleService.list(ws!.id);
    const builtins = roles.filter((r) => r.builtin).map((r) => r.name);
    expect(builtins).toEqual(["author", "approver", "admin"]);
    expect(roles.find((r) => r.name === "admin")!.assignees).toBe(1);
    expect(roles.find((r) => r.name === "author")!.assignees).toBe(1);
    expect(roles.find((r) => r.name === "Finance Reviewer")!.builtin).toBe(false);
  });
});
