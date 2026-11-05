import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  workspaceMembers,
  workspaceMemberCapabilities,
  workspaceRoles,
  workspaceRoleAssignments,
  workspaceRolePermissions,
  platformRoleAssignments,
  workspaces as workspacesTable,
} from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { workspaceRoleRepo } from "../repositories/workspace-role.repo.js";
import { platformRoleRepo } from "../repositories/platform-role.repo.js";
import {
  effectivePermissionsService,
  PlatformRoleCache,
} from "./effective-permissions.service.js";
import { ROLE_PRESETS } from "../auth/role-presets.js";
import { WORKSPACE_PERMISSIONS } from "../auth/permissions.js";
import { config } from "../config/index.js";

/**
 * The resolver's six properties.
 *
 * ⚠ **P-3 and the positive control are the two that matter most.** Without the control
 * ("a granted person is actually allowed"), a resolver that returned `[]` unconditionally
 * would satisfy every other assertion in this file and score 100% — which is the failure
 * mode this repo has been bitten by often enough to have a name for (I-38).
 */

const ALICE = { subject: "oid-eff-alice", email: "alice-eff@acme-hr.example" };
const BOB = { subject: "oid-eff-bob", email: "bob-eff@acme-hr.example" };

const wsA = await workspaceRepo.create({
  name: "rbac resolver tests A",
  tenantSlug: "efftest",
  slug: `efftest-a-${Date.now().toString(36)}`,
});
const wsB = await workspaceRepo.create({
  name: "rbac resolver tests B",
  tenantSlug: "efftest",
  slug: `efftest-b-${Date.now().toString(36)}`,
});
const reachable = !!wsA && !!wsB;

async function wipe() {
  if (!reachable) return;
  for (const w of [wsA!, wsB!]) {
    await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, w.id));
    await db
      .delete(workspaceMemberCapabilities)
      .where(eq(workspaceMemberCapabilities.workspaceId, w.id));
    await db
      .delete(workspaceRoleAssignments)
      .where(eq(workspaceRoleAssignments.workspaceId, w.id));
    await db.delete(workspaceRoles).where(eq(workspaceRoles.workspaceId, w.id));
  }
  for (const s of [ALICE.subject, BOB.subject]) {
    await db.delete(platformRoleAssignments).where(eq(platformRoleAssignments.subject, s));
  }
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  if (wsA) await db.delete(workspacesTable).where(eq(workspacesTable.id, wsA.id));
  if (wsB) await db.delete(workspacesTable).where(eq(workspacesTable.id, wsB.id));
});

async function makeMember(workspaceId: string, who: typeof ALICE, role: string) {
  await db.insert(workspaceMembers).values({
    workspaceId,
    subject: who.subject,
    email: who.email,
    role,
    grantedBy: "test",
  });
}

describe.skipIf(!reachable)("P-1: the answer is a union, and order-independent", () => {
  it("a preset, a custom role and an individual grant all add", async () => {
    await makeMember(wsA!.id, ALICE, "author");

    const role = await workspaceRoleRepo.create({
      workspaceId: wsA!.id,
      name: "Auditor-ish",
      createdBy: "test",
    });
    await workspaceRoleRepo.setPermissions(role.id, ["audit.read"], "test");
    await workspaceRoleRepo.assign({
      workspaceId: wsA!.id,
      subject: ALICE.subject,
      roleId: role.id,
      grantedBy: "test",
    });
    await db.insert(workspaceMemberCapabilities).values({
      workspaceId: wsA!.id,
      subject: ALICE.subject,
      capability: "secrets.read",
      grantedBy: "test",
    });

    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);

    // Everything the preset gives...
    for (const p of ROLE_PRESETS.author) expect(eff.permissions).toContain(p);
    // ...plus the custom role...
    expect(eff.permissions).toContain("audit.read");
    // ...plus the individual grant.
    expect(eff.permissions).toContain("secrets.read");
    // And nothing subtracts: the author preset is intact despite two extra sources.
    expect(eff.permissions.length).toBe(ROLE_PRESETS.author.length + 2);
  });

  it("is sorted and deduplicated, so two reads are one string", async () => {
    await makeMember(wsA!.id, ALICE, "author");
    // `flows.read` arrives from BOTH the preset and an individual grant.
    await db.insert(workspaceMemberCapabilities).values({
      workspaceId: wsA!.id,
      subject: ALICE.subject,
      capability: "flows.read",
      grantedBy: "test",
    });
    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
    expect(eff.permissions).toEqual([...eff.permissions].sort());
    expect(new Set(eff.permissions).size).toBe(eff.permissions.length);
    // Two sources, one permission, TWO provenance entries — being granted a thing twice
    // is two reasons, not a conflict.
    expect(eff.provenance["flows.read"]!.length).toBe(2);
  });
});

describe.skipIf(!reachable)("P-2: empty means empty", () => {
  it("a non-member holds nothing at all", async () => {
    const eff = await effectivePermissionsService.forWorkspace(BOB, wsA!.id);
    expect(eff.permissions).toEqual([]);
    expect(eff.memberRole).toBeNull();
    expect(eff.isSuperAdmin).toBe(false);
  });

  it("an identity naming nobody holds nothing — it does not fall through to anonymous", async () => {
    expect((await effectivePermissionsService.forWorkspace(undefined, wsA!.id)).permissions).toEqual(
      [],
    );
    expect(
      (await effectivePermissionsService.forWorkspace({ subject: null }, wsA!.id)).permissions,
    ).toEqual([]);
  });

  it("membership in A grants NOTHING in B", async () => {
    await makeMember(wsA!.id, ALICE, "admin");
    const inB = await effectivePermissionsService.forWorkspace(ALICE, wsB!.id);
    expect(inB.permissions).toEqual([]);
  });

  it("CONTROL: a granted person IS allowed", async () => {
    // ⚠ Without this, a resolver returning [] unconditionally passes every assertion
    // above and scores 100%. This is the assertion that makes the rest mean anything.
    await makeMember(wsA!.id, ALICE, "admin");
    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
    expect(eff.permissions.length).toBe(WORKSPACE_PERMISSIONS.length);
    expect(await effectivePermissionsService.has(ALICE, wsA!.id, "flows.write")).toBe(true);
  });
});

describe.skipIf(!reachable)("P-3: super admin short-circuits BEFORE the member read", () => {
  it("holds every permission in a workspace with ZERO members", async () => {
    // ⚠ This is not an optimisation. `POST …/members/claim` is deleted, so a memberless
    // workspace can only ever gain its first member through somebody who passes with no
    // membership row. Move this branch below the member read and every workspace on a
    // fresh deployment becomes permanently un-grantable.
    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, wsA!.id));
    expect(members.length).toBe(0);

    const original = config.isSuperAdmin;
    try {
      (config as { isSuperAdmin: typeof config.isSuperAdmin }).isSuperAdmin = (i) =>
        i?.subject === ALICE.subject;
      const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
      expect(eff.isSuperAdmin).toBe(true);
      expect(eff.permissions.length).toBe(WORKSPACE_PERMISSIONS.length);
      expect(eff.memberRole).toBe("admin");
      expect(eff.provenance["members.grant"]).toEqual([{ via: "superadmin" }]);
    } finally {
      (config as { isSuperAdmin: typeof config.isSuperAdmin }).isSuperAdmin = original;
    }
  });

  it("CONTROL: without the allowlist, the same identity holds nothing there", async () => {
    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
    expect(eff.isSuperAdmin).toBe(false);
    expect(eff.permissions).toEqual([]);
  });
});

describe.skipIf(!reachable)("P-4: provenance comes back with the answer", () => {
  it("names the preset, the role and the grant separately", async () => {
    await makeMember(wsA!.id, ALICE, "approver");
    const role = await workspaceRoleRepo.create({
      workspaceId: wsA!.id,
      name: "Budget Watcher",
      createdBy: "test",
    });
    await workspaceRoleRepo.setPermissions(role.id, ["budget.read"], "test");
    await workspaceRoleRepo.assign({
      workspaceId: wsA!.id,
      subject: ALICE.subject,
      roleId: role.id,
      grantedBy: "test",
    });
    await db.insert(workspaceMemberCapabilities).values({
      workspaceId: wsA!.id,
      subject: ALICE.subject,
      capability: "tools.write",
      grantedBy: "test",
    });

    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
    expect(eff.provenance["flows.approve"]).toEqual([{ via: "preset", role: "approver" }]);
    expect(eff.provenance["budget.read"]).toEqual([
      { via: "role", roleId: role.id, roleName: "Budget Watcher" },
    ]);
    expect(eff.provenance["tools.write"]).toEqual([{ via: "grant" }]);
    // Every permission in the answer has at least one reason. A permission with no
    // provenance is a permission nothing can explain.
    for (const p of eff.permissions) expect(eff.provenance[p]!.length).toBeGreaterThan(0);
  });

  it("a retired role stops conferring, but the role row survives for the audit", async () => {
    await makeMember(wsA!.id, ALICE, "author");
    const role = await workspaceRoleRepo.create({
      workspaceId: wsA!.id,
      name: "Temporary",
      createdBy: "test",
    });
    await workspaceRoleRepo.setPermissions(role.id, ["audit.read"], "test");
    await workspaceRoleRepo.assign({
      workspaceId: wsA!.id,
      subject: ALICE.subject,
      roleId: role.id,
      grantedBy: "test",
    });
    expect(
      (await effectivePermissionsService.forWorkspace(ALICE, wsA!.id)).permissions,
    ).toContain("audit.read");

    await workspaceRoleRepo.retire(role.id);

    expect(
      (await effectivePermissionsService.forWorkspace(ALICE, wsA!.id)).permissions,
    ).not.toContain("audit.read");
    // INV-7 — the row is still there, so an audit entry naming it can still be resolved.
    expect(await workspaceRoleRepo.get(role.id)).not.toBeNull();
  });
});

/**
 * P-6 / INV-19 / FR-020 — D-9's conferral, and its provenance.
 *
 * ⚠ FR-020 had NO SUBJECT AT ALL before D-9: platform roles conferred nothing, so
 * "distinguishable from a membership grant" was a rule about a case that could not
 * arise. These are the tests that give it one.
 */
describe.skipIf(!reachable)("P-6 [D-9]: a platform role confers, and says so", () => {
  async function givePlatformRole(subject: string, email: string, roleKey: string) {
    await platformRoleRepo.assign({ subject, email, roleKey, grantedBy: "test" });
  }

  it("platform-admin gets members.read + members.grant in a workspace it is not in", async () => {
    await givePlatformRole(ALICE.subject, ALICE.email, "platform-admin");
    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);

    // ⚠ EXACTLY these two, in a workspace with no membership row. Not "at least" —
    // this one number is the entire bound on D-9's cost.
    expect(eff.permissions).toEqual(["members.grant", "members.read"]);
    expect(eff.memberRole).toBeNull();
  });

  it("and carries `via: platform`, never `via: preset`", async () => {
    await givePlatformRole(ALICE.subject, ALICE.email, "platform-admin");
    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
    expect(eff.provenance["members.grant"]).toEqual([
      { via: "platform", role: "platform-admin", permission: "platform.members.grant" },
    ]);
    // The whole point of INV-19: a screen must be able to say "because they administer
    // the platform" rather than implying somebody put them in this workspace.
    for (const sources of Object.values(eff.provenance)) {
      expect(sources.some((s) => s.via === "preset")).toBe(false);
    }
  });

  it("it confers in EVERY workspace, not one", async () => {
    await givePlatformRole(ALICE.subject, ALICE.email, "platform-admin");
    for (const w of [wsA!, wsB!]) {
      const eff = await effectivePermissionsService.forWorkspace(ALICE, w.id);
      expect(eff.permissions).toEqual(["members.grant", "members.read"]);
    }
  });

  it("INV-12: an auditor confers NOTHING, and sees no workspace", async () => {
    await givePlatformRole(BOB.subject, BOB.email, "auditor");
    const eff = await effectivePermissionsService.forWorkspace(BOB, wsA!.id);
    expect(eff.permissions).toEqual([]);
    expect(await effectivePermissionsService.conferredEverywhere(BOB)).toEqual([]);
    // But they DO hold their platform permission — the refusal above is about
    // conferral, not about the role being empty.
    const plat = await effectivePermissionsService.platformPermissions(BOB);
    // 0100 merged `support` into `auditor`: the one read-only platform profile holds all four reads.
    expect(plat.permissions).toEqual([
      "platform.audit.read",
      "platform.ops.read",
      "platform.signals.read",
      "platform.users.read",
    ]);
  });

  it("a membership row and a platform role are TWO reasons, not a conflict", async () => {
    await makeMember(wsA!.id, ALICE, "admin");
    await givePlatformRole(ALICE.subject, ALICE.email, "platform-admin");
    const eff = await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
    expect(eff.permissions.length).toBe(WORKSPACE_PERMISSIONS.length);
    const sources = eff.provenance["members.grant"]!.map((s) => s.via).sort();
    expect(sources).toEqual(["platform", "preset"]);
  });
});

describe.skipIf(!reachable)("P-5: one platform read per request, however many workspaces", () => {
  it("the cache answers both workspaces from one round trip", async () => {
    await platformRoleRepo.assign({
      subject: ALICE.subject,
      email: ALICE.email,
      roleKey: "platform-admin",
      grantedBy: "test",
    });

    let reads = 0;
    const cache = new PlatformRoleCache();
    const real = platformRoleRepo.rolesFor.bind(platformRoleRepo);
    (platformRoleRepo as { rolesFor: typeof platformRoleRepo.rolesFor }).rolesFor = async (s) => {
      reads += 1;
      return real(s);
    };
    try {
      await effectivePermissionsService.forWorkspace(ALICE, wsA!.id, cache);
      await effectivePermissionsService.forWorkspace(ALICE, wsB!.id, cache);
      expect(reads).toBe(1);
    } finally {
      (platformRoleRepo as { rolesFor: typeof platformRoleRepo.rolesFor }).rolesFor = real;
    }
  });

  it("CONTROL: without the cache it really does read twice", async () => {
    // Otherwise "1" above could be a function that never reads at all.
    await platformRoleRepo.assign({
      subject: ALICE.subject,
      email: ALICE.email,
      roleKey: "platform-admin",
      grantedBy: "test",
    });
    let reads = 0;
    const real = platformRoleRepo.rolesFor.bind(platformRoleRepo);
    (platformRoleRepo as { rolesFor: typeof platformRoleRepo.rolesFor }).rolesFor = async (s) => {
      reads += 1;
      return real(s);
    };
    try {
      await effectivePermissionsService.forWorkspace(ALICE, wsA!.id);
      await effectivePermissionsService.forWorkspace(ALICE, wsB!.id);
      expect(reads).toBe(2);
    } finally {
      (platformRoleRepo as { rolesFor: typeof platformRoleRepo.rolesFor }).rolesFor = real;
    }
  });
});
