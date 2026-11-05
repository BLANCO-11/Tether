import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditEvents, platformAuditEvents, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { accessAuditService } from "./access-audit.service.js";

const ACTOR = "oid-audit-actor";
const TARGET = "oid-audit-target";

const ws = await workspaceRepo.create({
  name: "rbac audit tests",
  tenantSlug: "audittest",
  slug: `audittest-${Date.now().toString(36)}`,
});
const reachable = !!ws;

async function wipe() {
  if (!reachable) return;
  await db.delete(auditEvents).where(eq(auditEvents.workspaceId, ws!.id));
  await db.delete(platformAuditEvents).where(eq(platformAuditEvents.actor, ACTOR));
}
async function rows() {
  return db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, ws!.id), eq(auditEvents.operation, "access")));
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  if (ws) await db.delete(workspacesTable).where(eq(workspacesTable.id, ws.id));
});

describe.skipIf(!reachable)("the access audit records what happened", () => {
  it("CONTROL: it records ANYTHING at all", () => {
    // ⚠ Every assertion about what a record must NOT contain is satisfied by a recorder
    // that writes nothing. This is the assertion that stops that.
    return (async () => {
      await accessAuditService.recordGrant({
        workspaceId: ws!.id,
        actor: ACTOR,
        subject: TARGET,
        what: "approver",
        after: { role: "approver" },
      });
      const written = await rows();
      expect(written.length).toBe(1);
      expect(written[0]!.actor).toBe(ACTOR);
      expect(written[0]!.description).toMatch(/granted approver/);
    })();
  });

  it("a grant and a revocation are distinguishable, with before and after", async () => {
    await accessAuditService.recordGrant({
      workspaceId: ws!.id,
      actor: ACTOR,
      subject: TARGET,
      what: "approver",
      before: null,
      after: { role: "approver" },
    });
    await accessAuditService.recordRevoke({
      workspaceId: ws!.id,
      actor: ACTOR,
      subject: TARGET,
      what: "approver",
      before: { role: "approver" },
      after: null,
    });
    const written = await rows();
    expect(written.length).toBe(2);
    const descriptions = written.map((r) => r.description).sort();
    expect(descriptions).toEqual(["granted approver", "revoked approver"]);
    // FR-033 — actor, subject, before, after and time are all present.
    for (const r of written) {
      expect(r.actor).toBe(ACTOR);
      expect((r.raw as { subject: string }).subject).toBe(TARGET);
      expect(r.time).toBeInstanceOf(Date);
      expect(r.raw).toHaveProperty("before");
      expect(r.raw).toHaveProperty("after");
    }
  });

  it("a role change is `policy`, a membership change is `member`", async () => {
    await accessAuditService.recordRoleChange({
      workspaceId: ws!.id,
      actor: ACTOR,
      subject: TARGET,
      what: "Finance Reviewer",
      action: "role.create",
    });
    await accessAuditService.recordGrant({
      workspaceId: ws!.id,
      actor: ACTOR,
      subject: TARGET,
      what: "author",
    });
    const written = await rows();
    expect(new Set(written.map((r) => r.entity))).toEqual(new Set(["policy", "member"]));
  });

  it("INV-16: it writes to audit_events UNALTERED — operation `access` was already legal", async () => {
    // No migration touches `audit_events`. If this insert ever fails a CHECK, somebody
    // has narrowed that table's vocabulary and FR-028 stopped being cheap to prove.
    await accessAuditService.recordGrant({
      workspaceId: ws!.id,
      actor: ACTOR,
      subject: TARGET,
      what: "admin",
    });
    expect((await rows()).length).toBe(1);
  });
});

/**
 * FR-034 — a refusal records the DECISION, never the protected resource.
 *
 * ⚠ An audit trail that quoted what was withheld would be a second copy of the exposure,
 * in a table readable by administrators — including, through the platform tier, people
 * who deliberately hold no permission over that data.
 */
describe.skipIf(!reachable)("FR-034: a denial entry carries no part of the protected resource", () => {
  it("records person, permission and resource — and nothing else", async () => {
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "secrets.read",
      route: "GET /api/workspaces/:workspaceId/secrets",
    });
    const written = await rows();
    expect(written.length).toBe(1);
    const row = written[0]!;

    // The three things it MUST carry.
    expect(row.actor).toBe(ACTOR);
    expect(row.whereEntityId).toBe("secrets.read");
    expect(row.workspaceId).toBe(ws!.id);
    expect(row.description).toMatch(/refused/);

    // ⚠ And nothing from the thing that was withheld. The route is a DECLARED path
    // (`:workspaceId`, not a resolved id), so it names the shape of the request and
    // never its contents.
    const blob = JSON.stringify(row);
    for (const leak of ["SELECT", "password", "sk-", "Bearer ", "@acme-hr.example"]) {
      expect(blob, `denial entry contains ${leak}`).not.toContain(leak);
    }
    expect(row.whereText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("a deployment-level refusal goes to the platform record instead", async () => {
    await accessAuditService.recordDenial({
      workspaceId: null,
      actor: ACTOR,
      permission: "platform.generation.write",
      route: "PUT /api/generation/llm/provider",
    });
    const written = await db
      .select()
      .from(platformAuditEvents)
      .where(eq(platformAuditEvents.actor, ACTOR));
    expect(written.length).toBe(1);
    expect(written[0]!.action).toBe("deny");
    expect(written[0]!.entity).toBe("permission");
    expect(written[0]!.entityId).toBe("platform.generation.write");
    // And it did NOT land in the workspace table, which has no workspace to belong to.
    expect((await rows()).length).toBe(0);
  });
});

describe.skipIf(!reachable)("recording can never fail the thing it records", () => {
  it("swallows a write failure rather than throwing into the caller", async () => {
    // ⚠ A grant that succeeded and then threw on its way into the audit gets rolled back
    // by the caller's error handling — leaving the operator looking at a failure for an
    // action that already happened. The fix people then reach for is to stop recording.
    await expect(
      accessAuditService.recordGrant({
        workspaceId: "00000000-0000-0000-0000-000000000000", // no such workspace: FK fails
        actor: ACTOR,
        subject: TARGET,
        what: "author",
      }),
    ).resolves.toBeUndefined();
  });

  it("CONTROL: that same call against a REAL workspace does write a row", async () => {
    // Otherwise "resolves" above is satisfied by a method that never writes anything.
    await accessAuditService.recordGrant({
      workspaceId: ws!.id,
      actor: ACTOR,
      subject: TARGET,
      what: "author",
    });
    expect((await rows()).length).toBe(1);
  });
});

/**
 * T094/T095 — the BOUND on denial recording.
 *
 * ⚠ The audit record is deniable-of-service by exactly the person it is about: a refused
 * caller in a retry loop writes one row per attempt, and an audit store an unauthorised
 * caller can flood stops being readable precisely when it matters.
 */
describe.skipIf(!reachable)("FR-034: 500 identical refusals are ONE entry with a count", () => {
  beforeEach(() => accessAuditService._resetDenialWindow());

  it("writes the first immediately and counts the rest", async () => {
    for (let i = 0; i < 500; i += 1) {
      await accessAuditService.recordDenial({
        workspaceId: ws!.id,
        actor: ACTOR,
        permission: "secrets.read",
        route: "GET /api/workspaces/:workspaceId/secrets",
      });
    }
    const written = await rows();
    // ⚠ ONE row, not 500.
    expect(written.length).toBe(1);

    // ⚠ And the FACT was written immediately — it did not wait for the window to close.
    expect(written[0]!.description).toMatch(/refused: missing secrets\.read/);

    await accessAuditService.flushDenials();
    const after = await rows();
    expect(after.length).toBe(1);
    expect((after[0]!.raw as { repeats: number }).repeats).toBe(499);
  });

  it("CONTROL: a DIFFERENT permission is its own entry — the bound is not 'record one thing'", async () => {
    // Without this, a recorder that wrote one row ever would pass the assertion above.
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "secrets.read",
    });
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "audit.read",
    });
    expect((await rows()).length).toBe(2);
  });

  it("CONTROL: a different PERSON is its own entry", async () => {
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "secrets.read",
    });
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: "somebody-else",
      permission: "secrets.read",
    });
    expect((await rows()).length).toBe(2);
  });

  it("⚠ the ROUTE does not split the count — two routes, one missing grant", async () => {
    // Two routes needing the same permission in the same workspace are the same refusal
    // to the person hitting them. Counting them apart lets a loop over ten routes write
    // ten rows for one missing grant.
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "secrets.read",
      route: "GET /api/workspaces/:workspaceId/secrets",
    });
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "secrets.read",
      route: "GET /api/workspaces/:workspaceId/secrets/audit",
    });
    expect((await rows()).length).toBe(1);
  });

  it("a restart loses the COUNT and never the FACT", async () => {
    await accessAuditService.recordDenial({
      workspaceId: ws!.id,
      actor: ACTOR,
      permission: "secrets.read",
    });
    for (let i = 0; i < 9; i += 1) {
      await accessAuditService.recordDenial({
        workspaceId: ws!.id,
        actor: ACTOR,
        permission: "secrets.read",
      });
    }
    // A restart: the in-memory window is gone before it could be flushed.
    accessAuditService._resetDenialWindow();

    const written = await rows();
    expect(written.length).toBe(1); // the FACT survived
    expect((written[0]!.raw as { repeats: number }).repeats).toBe(0); // the COUNT did not
  });
});
