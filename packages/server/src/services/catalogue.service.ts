import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { approvalRequests, datasources, flowTemplates, schemas, tools, workspaceMembers } from "../db/schema.js";
import { datasourceFixtureRepo } from "../repositories/datasource-fixture.repo.js";
import { workspaceMemberCapabilitiesService } from "./workspace-member-capabilities.service.js";

/**
 * B-10 · S-04 attachment & reference picker — catalogue union with per-access safety.
 *
 * Purpose: "Files, workflows, data sources, reports and policies are checked against
 * your access before they are attached."
 *
 * Safety law:
 * - masked  — safe masked identifiers (real-data holders see masked, or entity is safe)
 * - mock    — safe mock/fixture data (sandbox)
 * - restricted — real data without real-data capability; expands to hatched panel naming owner + Request access
 *
 * 5 concurrent max via approval_requests cap (approvalQueueService.create enforces).
 * No `any` — strict types throughout.
 */

export type CatalogueSafety = "masked" | "mock" | "restricted";

export type CatalogueKind = "workflow" | "datasource" | "tool" | "table" | "file" | "report" | "policy";

export interface CatalogueItem {
  id: string;
  label: string;
  icon: string;
  kind: CatalogueKind;
  safety: CatalogueSafety;
  owner: string | null;
  ownerName: string | null;
}

const KIND_ICON: Record<CatalogueKind, string> = {
  workflow: "workflow",
  datasource: "database",
  tool: "tool",
  table: "table",
  file: "file",
  report: "bar-chart",
  policy: "shield",
};

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}
export const catalogueService = {
  async list(params: {
    workspaceId: string;
    q?: string;
    viewerSubject?: string | null;
    viewerEmail?: string | null;
  }): Promise<{ items: CatalogueItem[] }> {
    const { workspaceId, q, viewerSubject, viewerEmail } = params;
    if (!workspaceId) throw httpError("workspaceId required", 400);

    const hasRealData = viewerSubject
      ? await workspaceMemberCapabilitiesService.hasCapability({
          workspaceId,
          subject: viewerSubject,
          email: viewerEmail ?? null,
          capability: "realdata.use",
        })
      : false;

    // Owner resolution: map subject -> email for display.
    const members = await db
      .select({ subject: workspaceMembers.subject, email: workspaceMembers.email })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    const memberEmail = new Map(members.map((m) => [m.subject, m.email] as const));
    const firstAdmin = members[0] ?? null;

    const [templateRows, datasourceRows, toolRows] = await Promise.all([
      db.select().from(flowTemplates).where(eq(flowTemplates.workspaceId, workspaceId)),
      db.select().from(datasources).where(eq(datasources.workspaceId, workspaceId)),
      db.select().from(tools).where(eq(tools.workspaceId, workspaceId)),
    ]);
    // Mock readiness (Slice A): a datasource is "mock" only when a READY
    // fixture exists. Sandbox columns are legacy and no longer consulted.
    const readyIds =
      datasourceRows.length > 0
        ? await datasourceFixtureRepo.readyIdsForWorkspace(workspaceId)
        : new Set<string>();
    // Schemas: distinct entities per datasource (entityName + entitySchema)
    const schemaRows =
      datasourceRows.length > 0
        ? await db
            .selectDistinct({
              id: schemas.id,
              datasourceId: schemas.datasourceId,
              entityName: schemas.entityName,
              entitySchema: schemas.entitySchema,
              entityType: schemas.entityType,
            })
            .from(schemas)
            .where(
              sql`${schemas.datasourceId} in (select id from ${datasources} where ${datasources.workspaceId} = ${workspaceId})`,
            )
        : [];

    // Deduplicate schemas by (datasourceId, entitySchema, entityName)
    const seenSchema = new Set<string>();
    const dedupedSchemas: Array<(typeof schemaRows)[number]> = [];
    for (const r of schemaRows) {
      const key = `${r.datasourceId}:${r.entitySchema ?? ""}:${r.entityName}`;
      if (seenSchema.has(key)) continue;
      seenSchema.add(key);
      dedupedSchemas.push(r);
    }

    const items: CatalogueItem[] = [];

    for (const t of templateRows) {
      const label = t.name;
      const qTrim = q?.trim().toLowerCase();
      if (qTrim && !label.toLowerCase().includes(qTrim)) continue;
      const safety: CatalogueSafety = "mock";
      // mock for workflows — safe fixture, not real data
      const owner = t.createdBy ?? firstAdmin?.subject ?? null;
      const ownerName = owner ? (memberEmail.get(owner) ?? owner) : null;
      items.push({
        id: t.id,
        label,
        icon: KIND_ICON["workflow"],
        kind: "workflow",
        safety,
        owner,
        ownerName,
      });
    }

    for (const ds of datasourceRows) {
      const label = ds.name;
      const qTrim = q?.trim().toLowerCase();
      if (qTrim && !label.toLowerCase().includes(qTrim)) continue;
      const hasMock = readyIds.has(ds.id);
      const safety: CatalogueSafety = hasMock ? "mock" : !hasRealData ? "restricted" : "masked";
      const owner = firstAdmin?.subject ?? null;
      const ownerName = owner ? (memberEmail.get(owner) ?? owner) : null;
      items.push({
        id: ds.id,
        label,
        icon: KIND_ICON["datasource"],
        kind: "datasource",
        safety,
        owner,
        ownerName,
      });
    }

    for (const tl of toolRows) {
      const label = tl.name;
      const qTrim = q?.trim().toLowerCase();
      if (qTrim && !label.toLowerCase().includes(qTrim)) continue;
      const safety: CatalogueSafety = "masked";
      const owner = firstAdmin?.subject ?? null;
      const ownerName = owner ? (memberEmail.get(owner) ?? owner) : null;
      items.push({
        id: tl.id,
        label,
        icon: KIND_ICON["tool"],
        kind: "tool",
        safety,
        owner,
        ownerName,
      });
    }

    for (const s of dedupedSchemas) {
      const label = s.entitySchema ? `${s.entitySchema}.${s.entityName}` : s.entityName;
      const qTrim = q?.trim().toLowerCase();
      if (qTrim && !label.toLowerCase().includes(qTrim)) continue;
      // Schemas are metadata — masked safe. Could be report/policy kind.
      const kind: CatalogueKind = s.entityType === "view" ? "report" : "table";
      const safety: CatalogueSafety = "masked";
      const owner = firstAdmin?.subject ?? null;
      const ownerName = owner ? (memberEmail.get(owner) ?? owner) : null;
      items.push({
        id: s.id,
        label,
        icon: KIND_ICON[kind],
        kind,
        safety,
        owner,
        ownerName,
      });
    }


    // Deterministic ordering: restricted first, then label alphabetical, so hatched panel items surface.
    items.sort((a, b) => {
      if (a.safety === "restricted" && b.safety !== "restricted") return -1;
      if (a.safety !== "restricted" && b.safety === "restricted") return 1;
      return a.label.localeCompare(b.label);
    });

    return { items };
  },

  async findItem(workspaceId: string, itemId: string): Promise<CatalogueItem | null> {
    const { items } = await this.list({ workspaceId });
    return items.find((i) => i.id === itemId) ?? null;
  },

  async requestAccess(params: {
    workspaceId: string;
    itemId: string;
    reason: string;
    requesterSubject: string;
  }): Promise<typeof approvalRequests.$inferSelect> {
    const { workspaceId, itemId, reason, requesterSubject } = params;
    if (!workspaceId) throw httpError("workspaceId required", 400);
    if (!itemId) throw httpError("itemId required", 400);
    const trimmed = reason?.trim() ?? "";
    if (trimmed.length < 10) throw httpError("reason must be at least 10 characters", 400);
    if (!requesterSubject) throw httpError("requesterSubject required", 400);

    const item = await this.findItem(workspaceId, itemId);
    if (!item) throw httpError("catalogue item not found in this workspace", 404);

    const pending = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, "pending")));
    const count = pending[0]?.count ?? 0;
    if (count >= 5) throw httpError("too many pending approvals (max 5 concurrent)", 409);

    const [row] = await db
      .insert(approvalRequests)
      .values({
        workspaceId,
        type: "access_request",
        subjectEntityType: item.kind,
        subjectEntityId: item.id,
        subjectLabel: item.label,
        requesterSubject,
        risk: "medium",
        status: "pending",
        approvalPolicy: "any",
      })
      .returning();
    return row;
  },
};
