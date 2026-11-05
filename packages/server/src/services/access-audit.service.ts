import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";
import { platformAuditRepo } from "../repositories/platform-audit.repo.js";
import type { Permission } from "../auth/permissions.js";

/**
 * The access audit — who was granted what, who took it away, and who was refused.
 *
 * ## ⚠ Two stores, and that must never be reader-visible
 *
 * A workspace-scoped access event goes to **`audit_events`** with
 * `operation: "access"` and `entity: "member" | "policy"` — values that table already
 * permits, which is why **no migration alters it** (research M-2, and INV-16 wants it
 * untouched so FR-028 stays cheap to prove). A deployment-level event has no workspace
 * to belong to and goes to **`platform_audit_events`**.
 *
 * `GET /api/platform/audit` unions the two in one time order (INV-17). "Which table was
 * it written to" is a storage decision and is not a question a reader of an audit trail
 * should ever have to answer.
 *
 * ## ⚠ FR-034 — an entry records the DECISION, never the protected resource
 *
 * A refusal entry says: this person was refused this permission on this workspace. It
 * says nothing about what they were trying to read. An audit trail that quoted the flow,
 * the query or the secret that was withheld would be a **second copy of the exposure**,
 * sitting in a table readable by administrators — including, through the platform tier,
 * people who deliberately hold no permission over that data at all. The `description`
 * and `raw` fields are built here, from fixed strings and identifiers, and never from a
 * request body or a response payload.
 *
 * ## ⚠ Recording must never be able to fail the thing it records
 *
 * Every method swallows its own errors after logging. A grant that succeeded and then
 * threw on its way into the audit would be rolled back by the caller's error handling,
 * leaving the operator staring at a failure for an action that had already happened —
 * and the fix people reach for is to stop recording. Same posture as the
 * `platform_users` write, for the same reason.
 */

export interface AccessGrantEvent {
  workspaceId: string;
  /** The identity subject of whoever performed the grant. */
  actor: string;
  /** The identity subject the grant is about. */
  subject: string;
  /** What changed, as a role name, a permission, or a custom role's name. */
  what: string;
  before?: unknown;
  after?: unknown;
  /** `member` for a membership or role assignment; `policy` for a role definition. */
  entity?: "member" | "policy";
  entityId?: string | null;
}

export interface AccessDenialEvent {
  /** Null for a deployment-level refusal. */
  workspaceId: string | null;
  actor: string;
  actorEmail?: string | null;
  permission: Permission;
  /** The route that refused, as a declared path — never a request body. */
  route?: string | null;
}

export const accessAuditService = {
  /** A grant, an assignment, or a role gaining a permission. */
  async recordGrant(e: AccessGrantEvent): Promise<void> {
    await writeWorkspace(e, "granted");
  },

  /** A revocation, a removal, or a role losing a permission. */
  async recordRevoke(e: AccessGrantEvent): Promise<void> {
    await writeWorkspace(e, "revoked");
  },

  /** A custom role created, edited or retired. */
  async recordRoleChange(
    e: AccessGrantEvent & { action: "role.create" | "role.update" | "role.retire" },
  ): Promise<void> {
    await writeWorkspace({ ...e, entity: "policy" }, verbFor(e.action));
  },

  /** A platform-tier grant or revocation. */
  async recordPlatformGrant(e: {
    actor: string;
    actorEmail?: string | null;
    subject: string;
    roleKey: string;
    action: "grant" | "revoke" | "role.create" | "role.update" | "role.retire";
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    try {
      await platformAuditRepo.record({
        actor: e.actor,
        actorEmail: e.actorEmail ?? null,
        action: e.action,
        subject: e.subject,
        entity: e.action.startsWith("role.") ? "platform_role" : "member",
        entityId: e.roleKey,
        before: e.before ?? null,
        after: e.after ?? null,
      });
    } catch (err) {
      console.error("[access-audit] platform grant not recorded", err);
    }
  },

  /**
   * A refusal, BOUNDED.
   *
   * ## ⚠ WHY IT IS BOUNDED: THE AUDIT IS DENIABLE-OF-SERVICE BY THE PERSON IT IS ABOUT
   *
   * A refused caller in a retry loop writes one row per attempt. A page that polls every
   * two seconds against a permission it does not hold writes 1,800 rows an hour, and a
   * script does far worse — filling the audit store, pushing the entries somebody needs
   * off the end of every query, and doing it from a position of having no access at all.
   * An audit record an unauthorised caller can flood is one that stops being readable
   * exactly when it matters.
   *
   * So: **the first refusal is written immediately** — the FACT is never delayed or
   * batched — and identical repeats inside the window increment a count on that row
   * instead.
   *
   * ⚠ **A restart loses a COUNT, never a FACT**, and that is the right half to lose. The
   * window lives in memory deliberately: persisting it would mean a write per refusal,
   * which is the thing being avoided.
   *
   * ⚠ **Identity is `(subject, permission, workspaceId)`.** Not the route: two routes
   * needing the same permission in the same workspace are the same refusal to the person
   * hitting them, and counting them apart would let a loop over ten routes write ten
   * rows for one missing grant.
   */
  async recordDenial(e: AccessDenialEvent): Promise<void> {
    const key = `${e.actor}\u0000${e.permission}\u0000${e.workspaceId ?? ""}`;
    const now = Date.now();
    const open = denialWindow.get(key);

    if (open && now - open.openedAt < DENIAL_WINDOW_MS) {
      // ⚠ Counted, not written. The fact is already on the record from the first one.
      open.repeats += 1;
      return;
    }

    // A window that has closed: flush its count onto the row it opened, then open a new
    // one. Flushing is one UPDATE per window, not one per refusal.
    if (open) {
      denialWindow.delete(key);
      if (open.repeats > 0 && open.rowId) {
        try {
          if (open.workspaceId) await bumpWorkspaceRepeat(open.rowId, open.repeats);
          else await platformAuditRepo.bumpRepeat(open.rowId, open.repeats);
        } catch (err) {
          console.error("[access-audit] could not flush a denial count", err);
        }
      }
    }

    const rowId = await writeDenial(e);
    if (rowId) {
      denialWindow.set(key, {
        openedAt: now,
        repeats: 0,
        rowId,
        workspaceId: e.workspaceId,
      });
    }
  },

  /** Flush every open window. For tests, and for a graceful shutdown. */
  async flushDenials(): Promise<void> {
    for (const [key, open] of [...denialWindow.entries()]) {
      denialWindow.delete(key);
      if (open.repeats <= 0 || !open.rowId) continue;
      try {
        if (open.workspaceId) await bumpWorkspaceRepeat(open.rowId, open.repeats);
        else await platformAuditRepo.bumpRepeat(open.rowId, open.repeats);
      } catch (err) {
        console.error("[access-audit] could not flush a denial count", err);
      }
    }
  },

  /** Test seam. Never called in production. */
  _resetDenialWindow(): void {
    denialWindow.clear();
  },

};

/**
 * The open denial window, keyed `(subject, permission, workspaceId)`.
 *
 * ⚠ In memory, deliberately. Persisting it would mean a write per refusal, which is the
 * exact thing the window exists to avoid.
 */
const denialWindow = new Map<
  string,
  { openedAt: number; repeats: number; rowId: string | null; workspaceId: string | null }
>();

/** Five minutes. Long enough to absorb a retry loop; short enough that a count lands. */
const DENIAL_WINDOW_MS = 5 * 60_000;

/** Write the FIRST refusal of a window. Returns the row id so repeats can find it. */
async function writeDenial(e: AccessDenialEvent): Promise<string | null> {
  try {
    if (e.workspaceId) {
      const [row] = await db
        .insert(auditEvents)
        .values({
          workspaceId: e.workspaceId,
          actor: e.actor,
          operation: "access",
          entity: "member",
          entityId: e.actor,
          // ⚠ Fixed strings and identifiers only. No request body, no response payload,
          // no part of whatever was being reached for (FR-034).
          description: `refused: missing ${e.permission}`,
          whereText: e.route ?? "(route not recorded)",
          whereEntityType: "permission",
          whereEntityId: e.permission,
          raw: { denied: true, permission: e.permission, route: e.route ?? null, repeats: 0 },
        })
        .returning({ id: auditEvents.id });
      return row?.id ?? null;
    }
    const row = await platformAuditRepo.record({
      actor: e.actor,
      actorEmail: e.actorEmail ?? null,
      action: "deny",
      subject: e.actor,
      entity: "permission",
      entityId: e.permission,
      after: { permission: e.permission, route: e.route ?? null },
    });
    return row.id;
  } catch (err) {
    console.error("[access-audit] denial not recorded", err);
    return null;
  }
}

/**
 * Flush a window's repeat count onto the workspace row that opened it.
 *
 * ⚠ `audit_events` has no `repeat_count` column and **is not getting one** — INV-16
 * keeps that table structurally untouched so FR-028 stays cheap to prove. The count goes
 * into the existing `raw` JSON instead, which is already free-form.
 */
async function bumpWorkspaceRepeat(id: string, by: number): Promise<void> {
  await db
    .update(auditEvents)
    .set({
      raw: sql`jsonb_set(coalesce(${auditEvents.raw}, '{}'::jsonb), '{repeats}', to_jsonb(${by}::int), true)`,
    })
    .where(eq(auditEvents.id, id));
}

function verbFor(action: "role.create" | "role.update" | "role.retire"): string {
  return action === "role.create" ? "created" : action === "role.update" ? "edited" : "retired";
}

async function writeWorkspace(e: AccessGrantEvent, verb: string): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      workspaceId: e.workspaceId,
      actor: e.actor,
      operation: "access",
      entity: e.entity ?? "member",
      entityId: e.entityId ?? e.subject,
      description: `${verb} ${e.what}`,
      whereText: e.subject,
      whereEntityType: "member",
      whereEntityId: e.subject,
      raw: {
        subject: e.subject,
        what: e.what,
        before: e.before ?? null,
        after: e.after ?? null,
      },
    });
  } catch (err) {
    console.error("[access-audit] access change not recorded", err);
  }
}
