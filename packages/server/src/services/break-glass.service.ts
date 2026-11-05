import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { breakGlassSessions, incidents } from "../db/schema.js";
import { auditService } from "./audit.service.js";

export const BREAK_GLASS_SCOPES = ["hris-unmasked", "payroll-restricted"] as const;
export type BreakGlassScope = (typeof BREAK_GLASS_SCOPES)[number];

export const BREAK_GLASS_DURATIONS = [1, 2, 4] as const;
export type BreakGlassDuration = (typeof BREAK_GLASS_DURATIONS)[number];

export type BreakGlassSession = typeof breakGlassSessions.$inferSelect;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

export const breakGlassService = {
  /**
   * Activate a break-glass session.
   * Server-side gates:
   * - scope must be valid
   * - duration must be 1|2|4
   * - duration 4 only if incident.severity=sev1 else 400
   * - justification length >=20 else 400
   * - acknowledged must be true else 400
   * - incident must belong to workspace
   * - 5 concurrent active max per workspace
   * Ties to auditService.record for every activation (append-only trail).
   */
  async activate(params: {
    workspaceId: string;
    incidentId: string;
    scope: string;
    duration: number;
    justification: string;
    acknowledged: boolean;
    activatedBy: string;
  }): Promise<BreakGlassSession> {
    const { workspaceId, incidentId, scope, duration, justification, acknowledged, activatedBy } = params;
    if (!workspaceId) throw httpError("workspaceId required", 400);
    if (!incidentId) throw httpError("incidentId required", 400);
    if (!activatedBy) throw httpError("activatedBy required", 400);

    if (!(BREAK_GLASS_SCOPES as readonly string[]).includes(scope)) {
      throw httpError(`invalid scope: ${scope}`, 400);
    }
    if (!(BREAK_GLASS_DURATIONS as readonly number[]).includes(duration)) {
      throw httpError(`invalid duration: ${duration}`, 400);
    }
    if (!justification || justification.trim().length < 20) {
      throw httpError("justification must be at least 20 characters", 400);
    }
    if (acknowledged !== true) {
      throw httpError("acknowledgement required", 400);
    }

    // Workspace scoping: incident must be in workspace
    const [incident] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.id, incidentId)))
      .limit(1);
    if (!incident) throw httpError("incident not found in workspace", 404);

    // SEV1 gate: duration 4 only if severity sev1
    if (duration === 4 && incident.severity !== "sev1") {
      throw httpError("4 hour duration requires SEV1 incident", 400);
    }

    // 5 concurrent active max per workspace
    const activeCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(breakGlassSessions)
      .where(and(eq(breakGlassSessions.workspaceId, workspaceId), eq(breakGlassSessions.status, "active")));
    const count = activeCount[0]?.count ?? 0;
    if (count >= 5) throw httpError("too many active break-glass sessions (max 5 concurrent)", 409);

    const [row] = await db
      .insert(breakGlassSessions)
      .values({
        workspaceId,
        incidentId,
        scope,
        durationHours: duration,
        justification,
        acknowledged: true,
        activatedBySubject: activatedBy,
        status: "active",
      })
      .returning();

    // Tie to auditService.record for every activation (append-only)
    await auditService.record({
      workspaceId,
      actor: activatedBy,
      operation: "access",
      entity: "incident",
      entityId: incidentId,
      description: `Break-glass activated for ${incidentId} scope=${scope} duration=${duration}h`,
      whereText: `Incidents · ${incidentId}`,
      whereEntityType: "incident",
      whereEntityId: incidentId,
      raw: { breakGlassSessionId: row.id, scope, durationHours: duration, justification: justification.slice(0, 80) },
    });

    return row;
  },

  /**
   * List active sessions for a workspace.
   */
  async active(workspaceId: string): Promise<BreakGlassSession[]> {
    if (!workspaceId) throw httpError("workspaceId required", 400);
    const rows = await db
      .select()
      .from(breakGlassSessions)
      .where(and(eq(breakGlassSessions.workspaceId, workspaceId), eq(breakGlassSessions.status, "active")));
    return rows;
  },

  /**
   * Revoke a session — sets status to revoked. Workspace-scoped.
   */
  async revoke(params: { workspaceId: string; sessionId: string }): Promise<BreakGlassSession | undefined> {
    const { workspaceId, sessionId } = params;
    if (!workspaceId) throw httpError("workspaceId required", 400);
    if (!sessionId) throw httpError("sessionId required", 400);
    const [existing] = await db
      .select()
      .from(breakGlassSessions)
      .where(and(eq(breakGlassSessions.workspaceId, workspaceId), eq(breakGlassSessions.id, sessionId)))
      .limit(1);
    if (!existing) return undefined;
    if (existing.status !== "active") throw httpError(`session already ${existing.status}`, 409);
    const [updated] = await db
      .update(breakGlassSessions)
      .set({ status: "revoked" })
      .where(eq(breakGlassSessions.id, sessionId))
      .returning();
    return updated;
  },

  /**
   * Expire cron stub — marks active sessions where expires_at <= now() as expired.
   * Called by scheduler or manually; returns number expired.
   */
  async expire(): Promise<number> {
    const expired = await db
      .update(breakGlassSessions)
      .set({ status: "expired" })
      .where(and(eq(breakGlassSessions.status, "active"), sql`${breakGlassSessions.expiresAt} <= now()`))
      .returning();
    return expired.length;
  },
};
