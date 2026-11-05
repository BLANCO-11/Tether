import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { incidents } from "../db/schema.js";
import { auditService } from "./audit.service.js";

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = [
  "reported",
  "triaged",
  "investigating",
  "contained",
  "recovering",
  "monitoring",
  "resolved",
  "post-incident-review",
  "closed",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export type Incident = typeof incidents.$inferSelect;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

function isSeverity(v: string): v is IncidentSeverity {
  return (INCIDENT_SEVERITIES as readonly string[]).includes(v);
}

function isStatus(v: string): v is IncidentStatus {
  return (INCIDENT_STATUSES as readonly string[]).includes(v);
}

export const incidentService = {
  /**
   * List incidents for a workspace, ordered by openedAt desc.
   * Workspace-scoped: every read filters WHERE workspace_id = ?
   */
  async list(workspaceId: string): Promise<Incident[]> {
    if (!workspaceId) throw httpError("workspaceId required", 400);
    const rows = await db
      .select()
      .from(incidents)
      .where(eq(incidents.workspaceId, workspaceId))
      .orderBy(desc(incidents.openedAt));
    return rows;
  },

  async get(workspaceId: string, incidentId: string): Promise<Incident | undefined> {
    if (!workspaceId) throw httpError("workspaceId required", 400);
    if (!incidentId) throw httpError("incidentId required", 400);
    const [row] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.id, incidentId)))
      .limit(1);
    return row;
  },

  /**
   * Create an incident. Enforces 5 concurrent open (status != closed) max per workspace,
   * severity enum, and append-only audit via caller.
   */
  async create(params: {
    workspaceId: string;
    id: string;
    title: string;
    severity: string;
    status?: string;
    ownerSubject?: string | null;
    timeline?: unknown;
  }): Promise<Incident> {
    const { workspaceId, id, title, severity, status, ownerSubject, timeline } = params;
    if (!workspaceId) throw httpError("workspaceId required", 400);
    if (!id || id.trim().length === 0) throw httpError("incident id required", 400);
    if (!title || title.trim().length === 0) throw httpError("title required", 400);
    if (!isSeverity(severity)) throw httpError(`invalid severity: ${severity}`, 400);
    const effectiveStatus = status ?? "reported";
    if (!isStatus(effectiveStatus)) throw httpError(`invalid status: ${effectiveStatus}`, 400);

    // 5 concurrent open max — workspace-scoped, status != closed
    const openCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), ne(incidents.status, "closed")));
    const count = openCount[0]?.count ?? 0;
    if (count >= 5) throw httpError("too many open incidents (max 5 concurrent)", 409);

    const [row] = await db
      .insert(incidents)
      .values({
        id,
        workspaceId,
        title,
        severity,
        status: effectiveStatus,
        ownerSubject: ownerSubject ?? null,
        timeline: timeline ?? null,
      })
      .returning();
    return row;
  },

  /**
   * Move an incident to a new status. Accepts any of the 9 CHECK-allowed
   * statuses — no second state machine is invented here. Records the change
   * in the audit log; the `timeline` column is left untouched.
   */
  async transition(params: {
    workspaceId: string;
    incidentId: string;
    status: string;
    actorSubject: string;
  }): Promise<Incident> {
    const { workspaceId, incidentId, status, actorSubject } = params;
    if (!isStatus(status)) throw httpError(`unknown incident status: ${status}`, 400);
    const existing = await this.get(workspaceId, incidentId);
    if (!existing) throw httpError("incident not found", 404);
    const [row] = await db
      .update(incidents)
      .set({ status })
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.id, incidentId)))
      .returning();
    await auditService.record({
      workspaceId,
      actor: actorSubject,
      operation: "update",
      entity: "incident",
      entityId: incidentId,
      description: `Status changed from ${existing.status} to ${status}`,
      whereText: existing.title,
      whereEntityType: "incident",
      whereEntityId: incidentId,
      raw: { from: existing.status, to: status },
    });
    return row;
  },
};
