import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformRoles, platformRoleAssignments, platformAuditEvents } from "../db/schema.js";
import { platformRoleService } from "./platform-role.service.js";
import { effectivePermissionsService } from "./effective-permissions.service.js";
import { conferredByPlatform } from "../auth/platform-conferral.js";
import { config } from "../config/index.js";

const ADMIN = { subject: "oid-prs-admin", email: "prsadmin@acme-hr.example" };
const SECOND = { subject: "oid-prs-second", email: "prssecond@acme-hr.example" };
const AUDITOR = { subject: "oid-prs-auditor", email: "prsauditor@acme-hr.example" };
const SUPER = { subject: "oid-prs-super", email: "prssuper@acme-hr.example" };
const SUBJECTS = [ADMIN.subject, SECOND.subject, AUDITOR.subject, SUPER.subject];

async function wipe() {
  await db.delete(platformRoleAssignments).where(inArray(platformRoleAssignments.subject, SUBJECTS));
  await db.delete(platformRoles).where(eq(platformRoles.key, "custom-ops"));
  await db.delete(platformAuditEvents).where(inArray(platformAuditEvents.actor, SUBJECTS));
}

beforeEach(async () => {
  await wipe();
  config.superAdminEmails.add(SUPER.email);
  await platformRoleService.assign(
    { subject: ADMIN.subject, email: ADMIN.email, roleKey: "platform-admin" },
    SUPER,
  );
});
afterAll(async () => {
  await wipe();
  config.superAdminEmails.delete(SUPER.email);
});

describe("INV-15: built-in platform roles are immutable", () => {
  it("refuses to edit or delete one", async () => {
    for (const key of ["platform-admin", "auditor", "support"]) {
      await expect(
        platformRoleService.update(key, { name: "Renamed" }, ADMIN),
      ).rejects.toMatchObject({ statusCode: 409, reason: "builtin" });
      await expect(platformRoleService.remove(key, ADMIN)).rejects.toMatchObject({
        reason: "builtin",
      });
    }
  });

  it("CONTROL: a CUSTOM role can be edited and deleted", async () => {
    // Without this, "refuse every edit" satisfies the assertion above.
    await platformRoleService.create(
      { key: "custom-ops", name: "Custom Ops", permissions: ["platform.ops.read"] },
      ADMIN,
    );
    await expect(
      platformRoleService.update("custom-ops", { name: "Custom Ops 2" }, ADMIN),
    ).resolves.toMatchObject({ name: "Custom Ops 2" });
    await expect(platformRoleService.remove("custom-ops", ADMIN)).resolves.toBeUndefined();
  });
});

describe("a platform role carries only platform permissions", () => {
  it("refuses a workspace permission, and says why", async () => {
    // ⚠ A workspace permission here would be a role claiming to grant something inside
    // every workspace WITHOUT going through PLATFORM_CONFERS — the single audited
    // two-entry map that bounds D-9's whole cost. A second route to conferral would make
    // that bound meaningless.
    await expect(
      platformRoleService.create(
        { key: "custom-ops", name: "Sneaky", permissions: ["flows.read"] },
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 400, reason: "not_a_platform_permission" });
  });

  it("CONTROL: a platform permission is accepted", async () => {
    await expect(
      platformRoleService.create(
        { key: "custom-ops", name: "Ops", permissions: ["platform.ops.read"] },
        ADMIN,
      ),
    ).resolves.toBeTruthy();
  });

  it("FR-009: a caller cannot put a platform permission they do not hold into a role", async () => {
    await platformRoleService.assign(
      { subject: AUDITOR.subject, email: AUDITOR.email, roleKey: "auditor" },
      SUPER,
    );
    await expect(
      platformRoleService.create(
        { key: "custom-ops", name: "Escalate", permissions: ["platform.roles.write"] },
        AUDITOR,
      ),
    ).rejects.toMatchObject({ reason: "role_exceeds_granter" });
  });
});

/**
 * INV-12 — the auditor sees the record and no tenant data.
 *
 * ⚠ **Asserted DIRECTLY through the conferral map, not inferred from refusals.** A
 * refusal can also come from a bug: a broken resolver refuses everybody and would make
 * this test green while proving nothing about the auditor in particular.
 */
describe("INV-12: an auditor confers nothing — asserted directly", () => {
  it("its conferred set is empty, computed through PLATFORM_CONFERS", async () => {
    await platformRoleService.assign(
      { subject: AUDITOR.subject, email: AUDITOR.email, roleKey: "auditor" },
      SUPER,
    );
    const { permissions } = await effectivePermissionsService.platformPermissions(AUDITOR);
    expect(permissions).toEqual(["platform.audit.read"]);
    // Directly: the map's answer for exactly what they hold.
    expect(conferredByPlatform(permissions)).toEqual([]);
    expect(await effectivePermissionsService.conferredEverywhere(AUDITOR)).toEqual([]);
  });

  it("CONTROL: a platform-admin's conferred set is NOT empty — the map does answer", async () => {
    const { permissions } = await effectivePermissionsService.platformPermissions(ADMIN);
    expect(conferredByPlatform(permissions)).toEqual(["members.grant", "members.read"]);
  });
});

/**
 * INV-14 / INV-20 — the last platform administrator, and the exemption that does NOT
 * extend to this tier.
 */
describe("INV-14: the last platform administrator", () => {
  it("cannot be removed by another platform admin", async () => {
    await expect(
      platformRoleService.unassign(ADMIN.subject, "platform-admin", ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, reason: "last_platform_admin" });
  });

  it("CAN be removed by an allowlist holder — there must be a way back", async () => {
    await expect(
      platformRoleService.unassign(ADMIN.subject, "platform-admin", SUPER),
    ).resolves.toBeUndefined();
  });

  it("CONTROL: once there are TWO, either can be removed by a platform admin", async () => {
    // Without this, "refuse every unassign" passes the first assertion.
    await platformRoleService.assign(
      { subject: SECOND.subject, email: SECOND.email, roleKey: "platform-admin" },
      SUPER,
    );
    await expect(
      platformRoleService.unassign(SECOND.subject, "platform-admin", ADMIN),
    ).resolves.toBeUndefined();
  });

  it("⚠ INV-20: the refusal's message names the way out, and differs when no allowlist exists", async () => {
    const withAllowlist = (await platformRoleService
      .unassign(ADMIN.subject, "platform-admin", ADMIN)
      .then(() => null)
      .catch((e: unknown) => e)) as Error;
    expect(withAllowlist, "the refusal did not fire at all").toBeTruthy();
    expect(withAllowlist.message).toMatch(/SUPER_ADMIN_EMAILS|assign a second/i);

    // ⚠ The workspace tier lets a SUPER ADMIN remove a workspace's last admin, because
    // there is nobody above them to undo a mis-assignment. A platform admin always has
    // an allowlist holder above them, so for them the refusal is recoverable and stays.
    // Two tiers, two answers, and the asymmetry is the decision.
    expect(withAllowlist.message).not.toMatch(/cannot be undone/i);
  });

  it("a non-admin role has no last-holder protection — it is not the tier's root", async () => {
    await platformRoleService.assign(
      { subject: AUDITOR.subject, email: AUDITOR.email, roleKey: "auditor" },
      SUPER,
    );
    await expect(
      platformRoleService.unassign(AUDITOR.subject, "auditor", ADMIN),
    ).resolves.toBeUndefined();
  });
});

describe("INV-13: nothing here can confer super admin", () => {
  it("there is no permission that grants the allowlist", async () => {
    const roles = await platformRoleService.list();
    for (const r of roles) {
      for (const p of r.permissions) {
        expect(p).not.toMatch(/superadmin|super_admin|allowlist/i);
      }
    }
  });

  it("holding every platform permission still does not make you a super admin", async () => {
    const plat = await effectivePermissionsService.platformPermissions(ADMIN);
    expect(plat.permissions.length).toBeGreaterThan(0);
    expect(plat.isSuperAdmin).toBe(false);
    expect(config.isSuperAdmin(ADMIN)).toBe(false);
  });
});

describe("INV-17: the audit reader unions both stores in one time order", () => {
  it("returns platform events and workspace access events together, newest first", async () => {
    await platformRoleService.assign(
      { subject: AUDITOR.subject, email: AUDITOR.email, roleKey: "auditor" },
      ADMIN,
    );
    const events = await platformRoleService.auditTrail({ limit: 50 });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.tier === "platform")).toBe(true);
    // One time order, regardless of which table each came from.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i - 1]!.time.getTime()).toBeGreaterThanOrEqual(events[i]!.time.getTime());
    }
  });

  it("every grant is on the record with actor and subject (FR-033)", async () => {
    await platformRoleService.assign(
      { subject: AUDITOR.subject, email: AUDITOR.email, roleKey: "auditor" },
      ADMIN,
    );
    const events = await platformRoleService.auditTrail({ actor: ADMIN.subject, limit: 50 });
    const grant = events.find((e) => e.action === "grant");
    expect(grant).toBeTruthy();
    expect(grant!.actor).toBe(ADMIN.subject);
    expect(grant!.subject).toBe(AUDITOR.subject);
  });
});
