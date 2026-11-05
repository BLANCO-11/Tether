import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";

export type AuditOperation =
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "approve"
  | "reject"
  | "access"
  | "execute";

export type AuditEntity =
  | "workflow"
  | "version"
  | "resource"
  | "run"
  | "incident"
  | "approval"
  | "policy"
  | "datasource"
  | "tool"
  | "trigger"
  | "secret"
  | "member"
  | "flow"
  | "execution"
  | "template"
  | "chat"
  | "plugin"
  | "connection"
  | "project";

export const AUDIT_OPERATIONS: readonly AuditOperation[] = [
  "create",
  "update",
  "delete",
  "publish",
  "approve",
  "reject",
  "access",
  "execute",
] as const;

export const AUDIT_ENTITIES: readonly AuditEntity[] = [
  "workflow",
  "version",
  "resource",
  "run",
  "incident",
  "approval",
  "policy",
  "datasource",
  "tool",
  "trigger",
  "secret",
  "member",
  "flow",
  "execution",
  "template",
  "chat",
  "plugin",
  "connection",
  "project",
] as const;

export interface AuditListParams {
  workspaceId: string;
  q?: string;
  from?: string;
  to?: string;
  /** A page: at most `limit` events, skipping `offset`. Absent = every match (the CSV export). */
  limit?: number;
  offset?: number;
}

export interface AuditRecordParams {
  workspaceId: string;
  actor: string;
  operation: AuditOperation;
  entity: AuditEntity;
  entityId?: string | null;
  description: string;
  whereText: string;
  whereEntityType?: string | null;
  whereEntityId?: string | null;
  raw?: unknown;
  time?: Date;
}

export type AuditEventRow = typeof auditEvents.$inferSelect;

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toEndOfDayInclusive(d: Date, original: string): Date {
  // If input is YYYY-MM-DD (length 10) treat as inclusive end of that day
  if (/^\d{4}-\d{2}-\d{2}$/.test(original.trim())) {
    const end = new Date(d);
    end.setUTCHours(23, 59, 59, 999);
    return end;
  }
  return d;
}

/** The one WHERE every audit read uses — the list and its count can never disagree about what matches. */
function whereFor(params: AuditListParams) {
  const { workspaceId, q, from, to } = params;
  const conditions: unknown[] = [eq(auditEvents.workspaceId, workspaceId)];

  const trimmedQ = q?.trim();
  if (trimmedQ) {
    const like = `%${trimmedQ}%`;
    // Search actor, operation, entity, description, where_text, or exact id.
    // id is uuid — only compare when q is a valid uuid, otherwise Postgres
    // rejects `where id = 'alice'` with "invalid input syntax for type uuid".
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedQ);
    const orParts: unknown[] = [
      sql`lower(${auditEvents.actor}) like lower(${like})`,
      sql`lower(${auditEvents.operation}) like lower(${like})`,
      sql`lower(${auditEvents.entity}) like lower(${like})`,
      sql`lower(${auditEvents.description}) like lower(${like})`,
      sql`lower(${auditEvents.whereText}) like lower(${like})`,
    ];
    if (isUuid) orParts.push(eq(auditEvents.id, trimmedQ));
    const qCondition = or(...(orParts as Parameters<typeof or>));
    if (qCondition) conditions.push(qCondition);
  }

  const fromDate = parseDate(from);
  if (fromDate) {
    conditions.push(gte(auditEvents.time, fromDate));
  }

  const toRaw = to?.trim();
  const toDate = parseDate(toRaw);
  if (toDate && toRaw) {
    const end = toEndOfDayInclusive(toDate, toRaw);
    conditions.push(lte(auditEvents.time, end));
  }

  return conditions.length === 1 ? conditions[0] : and(...(conditions as Parameters<typeof and>));
}

export const auditService = {
  async list(params: AuditListParams): Promise<AuditEventRow[]> {
    const where = whereFor(params);
    const query = db
      .select()
      .from(auditEvents)
      .where(where as never)
      // `id` breaks ties so a page boundary between two events at the same instant is stable.
      .orderBy(desc(auditEvents.time), desc(auditEvents.id));
    if (params.limit === undefined) return await query;
    return await query.limit(params.limit).offset(params.offset ?? 0);
  },

  /** How many events the same filter matches — the denominator of a page ("51–100 of 312"). */
  async count(params: AuditListParams): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(whereFor(params) as never);
    return Number(row?.n ?? 0);
  },

  async record(params: AuditRecordParams): Promise<AuditEventRow> {
    const {
      workspaceId,
      actor,
      operation,
      entity,
      entityId,
      description,
      whereText,
      whereEntityType,
      whereEntityId,
      raw,
      time,
    } = params;

    if (!AUDIT_OPERATIONS.includes(operation as AuditOperation)) {
      const err = new Error(`invalid operation: ${operation}`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (!AUDIT_ENTITIES.includes(entity as AuditEntity)) {
      const err = new Error(`invalid entity: ${entity}`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const [row] = await db
      .insert(auditEvents)
      .values({
        workspaceId,
        actor,
        operation,
        entity,
        entityId: entityId ?? null,
        description,
        whereText,
        whereEntityType: whereEntityType ?? null,
        whereEntityId: whereEntityId ?? null,
        raw: raw ?? null,
        ...(time ? { time } : {}),
      })
      .returning();
    return row;
  },
};
