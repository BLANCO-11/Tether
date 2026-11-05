import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { approvalRequests } from "../db/schema.js";

/**
 * B-14 · S-37 Approvals inbox — unified queue (one queue, six types).
 *
 * Six types: exception (EXC-), publication (PUB-), access_request (ACC-),
 * recovery (REC-), policy_exception (POL-), resource_change (RES-).
 * `approval_policy` is all|any|quorum (UX-005). Workspace-scoped
 * WHERE workspaceId = ? on every read.
 */

export type ApprovalRequestType =
  | "exception"
  | "publication"
  | "access_request"
  | "recovery"
  | "policy_exception"
  | "resource_change";

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalPolicy = "all" | "any" | "quorum";

export type ApprovalQueueTab = "pending_me" | "requested" | "delegated" | "history";

export const APPROVAL_TABS: readonly ApprovalQueueTab[] = [
  "pending_me",
  "requested",
  "delegated",
  "history",
] as const;

export function normalizeTab(raw: string | undefined): ApprovalQueueTab {
  if (!raw) return "pending_me";
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  // Accept both "pending_me" and "pending" and "requested_by_me"
  if (v === "pending" || v === "pending_me" || v === "pending-me") return "pending_me";
  if (v === "requested" || v === "requested_by_me" || v === "requested_me" || v === "requestedbyme")
    return "requested";
  if (v === "delegated") return "delegated";
  if (v === "history") return "history";
  return "pending_me";
}

export type ApprovalRequest = typeof approvalRequests.$inferSelect;

export interface ApprovalFigures {
  pendingYourApproval: number;
  inFlight: number;
}

export interface ApprovalQueueResult {
  requests: ApprovalRequest[];
  figures: ApprovalFigures;
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

export const approvalQueueService = {
  /**
   * List for the inbox-tabs. Workspace-scoped, ordered by raisedAt desc.
   *
   * - pending_me: approvals awaiting this person — status = pending (all pending in workspace are awaiting reviewers)
   * - requested: where requester = me
   * - delegated: viewers delegate queue — no delegation model yet, returns empty
   * - history: status != pending ordered by raisedAt desc
   *
   * Also returns figures: pendingYourApproval (pending count) and inFlight (total pending).
   */
  async list(params: {
    workspaceId: string;
    viewerSubject: string;
    tab: string | undefined;
  }): Promise<ApprovalQueueResult> {
    const { workspaceId, viewerSubject, tab } = params;
    if (!workspaceId) throw httpError("workspaceId required", 400);
    if (!viewerSubject) throw httpError("viewerSubject required", 400);

    const normalized = normalizeTab(tab);

    let requests: ApprovalRequest[] = [];

    if (normalized === "pending_me") {
      requests = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, "pending")))
        .orderBy(desc(approvalRequests.raisedAt));
    } else if (normalized === "requested") {
      requests = await db
        .select()
        .from(approvalRequests)
        .where(
          and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.requesterSubject, viewerSubject)),
        )
        .orderBy(desc(approvalRequests.raisedAt));
    } else if (normalized === "delegated") {
      // No delegation model yet — honest empty rather than fabricated rows.
      requests = [];
    } else if (normalized === "history") {
      requests = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.workspaceId, workspaceId), ne(approvalRequests.status, "pending")))
        .orderBy(desc(approvalRequests.raisedAt));
    }

    // Figures are workspace-scoped counts, independent of tab.
    const pendingYourApprovalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, "pending")));

    const inFlightRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, "pending")));

    const figures: ApprovalFigures = {
      pendingYourApproval: pendingYourApprovalRows[0]?.count ?? 0,
      inFlight: inFlightRows[0]?.count ?? 0,
    };

    return { requests, figures };
  },

  /**
   * Create a request — helper for seeding/tests. Enforces 5 concurrent pending max per workspace.
   * Not exposed as a route yet; the queue's writes come from their source tables.
   */
  async create(data: typeof approvalRequests.$inferInsert): Promise<ApprovalRequest> {
    if (!data.workspaceId) throw httpError("workspaceId required", 400);
    // 5 concurrent max — workspace-scoped pending cap
    const pending = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, data.workspaceId), eq(approvalRequests.status, "pending")));
    const count = pending[0]?.count ?? 0;
    if (count >= 5) throw httpError("too many pending approvals (max 5 concurrent)", 409);
    const rows = await db.insert(approvalRequests).values(data).returning();
    return rows[0];
  },

  /** Workspace-scoped counts helper */
  async figures(workspaceId: string): Promise<ApprovalFigures> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, "pending")));
    const c = rows[0]?.count ?? 0;
    return { pendingYourApproval: c, inFlight: c };
  },
};
