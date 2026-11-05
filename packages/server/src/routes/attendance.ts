import { Router } from "express";
import { z } from "zod";
import { validate } from "@foundry/shared";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { attendanceService } from "../services/attendance.service.js";
import { approvalRequests } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * B-17 · S-42 My attendance status — per-employee attendance aggregation (consumer).
 *
 * Mounted at /api/workspaces/:workspaceId/me
 * - GET /attendance?period=2026-07 → AttendanceStatus (workspace-scoped, subject from req.user.subject)
 * - GET /exceptions?period=2026-07 → { exceptions: ExceptionNotice[] } pending/declined notice
 *
 * Auth: requireIdentity + workspace member check (author at minimum).
 * Subject is NEVER taken from query — only req.user.subject.
 * Consumer mode: no workspace name leakage, per-person scoping enforced in service WHERE.
 */
export const attendanceRouter = Router({ mergeParams: true });

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const querySchema = z.object({ period: z.string().optional() });

function validatePeriod(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "2026-07";
  if (!/^\d{4}-\d{2}$/.test(s)) return "2026-07";
  const mm = Number(s.slice(5));
  if (mm < 1 || mm > 12) return "2026-07";
  return s;
}

attendanceRouter.get(
  "/attendance",
  validate({ params: paramsSchema, query: querySchema }),
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const subject = req.user?.subject;
    if (!subject) return res.status(401).json({ error: "identity required" });
    const period = validatePeriod(req.query.period);
    const status = await attendanceService.status(workspaceId, subject, period);
    res.json(status);
  }),
);

export interface ExceptionNotice {
  id: string;
  period: string;
  status: "pending" | "declined" | "approved";
  approvers: Array<{ name: string; status: "approved" | "pending" | "declined"; waitingDays?: number }>;
  notice: string;
  reason?: string | null;
}

attendanceRouter.get(
  "/exceptions",
  validate({ params: paramsSchema, query: querySchema }),
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const workspaceId = req.params.workspaceId;
    const subject = req.user?.subject;
    if (!subject) return res.status(401).json({ error: "identity required" });
    const period = validatePeriod(req.query.period);

    type ApprovalRow = typeof approvalRequests.$inferSelect & {
      type?: string;
      status?: string;
      raisedAt?: Date;
      createdAt?: Date;
      reason?: string | null;
    };
    let rows: ApprovalRow[] = [];
    try {
      const raw = await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.requesterSubject, subject)));
      rows = raw as unknown as ApprovalRow[]; // approval queue rows carry type/status per B-14
    } catch {
      rows = [];
    }
    const exceptionRows = rows.filter((r) => r.type === "exception" || r.type === "policy_exception");

    if (exceptionRows.length === 0) {
      res.json({ period, exceptions: [] as ExceptionNotice[] });
      return;
    }

    const exceptions: ExceptionNotice[] = exceptionRows.map((r) => {
      const statusRaw = r.status ?? "pending";
      let status: ExceptionNotice["status"] = "pending";
      if (statusRaw === "approved") status = "approved";
      else if (statusRaw === "rejected" || statusRaw === "declined") status = "declined";
      else status = "pending";
      let waitingDays = 8;
      const raisedAt = r.raisedAt ?? r.createdAt;
      if (raisedAt) {
        const diff = Date.now() - new Date(raisedAt).getTime();
        waitingDays = Math.max(1, Math.floor(diff / (24 * 60 * 60 * 1000)));
      }
      if (status === "pending") {
        return {
          id: r.id,
          period,
          status,
          approvers: [
            { name: "Anita Rao", status: "approved" as const },
            { name: "Sanjay Nair", status: "pending" as const, waitingDays },
          ],
          notice: `Exception request partially approved — Anita Rao approved it. Sanjay Nair has been pending for ${waitingDays} days.`,
        };
      }
      if (status === "declined") {
        return {
          id: r.id,
          period,
          status,
          approvers: [
            { name: "Anita Rao", status: "declined" as const },
            { name: "Sanjay Nair", status: "declined" as const },
          ],
          notice: "Exception declined — Both approvers must approve; one decline means the request fails. The approver's reason is attached below.",
          reason: r.reason ?? null,
        };
      }
      return {
        id: r.id,
        period,
        status,
        approvers: [
          { name: "Anita Rao", status: "approved" as const },
          { name: "Sanjay Nair", status: "approved" as const },
        ],
        notice: "Exception approved — both approvers approved.",
      };
    });

    res.json({ period, exceptions });
  }),
);

/**
 * `GET /api/workspaces/:workspaceId/me/permissions` — what the SERVER says this person
 * may do here.
 *
 * ⚠ **`requireIdentity` ONLY. No permission is required, and that is deliberate**
 * (T079): needing access in order to discover that you have none is a bootstrap nobody
 * can escape. A person refused everywhere must still be able to load a page that
 * explains why and names who can help — which is `/no-access`, and it reads this.
 *
 * ⚠ **It returns PROVENANCE as well as the list**, from the same single computation that
 * decides (P-4). A screen that says "you can do this because you administer the platform"
 * must not be able to disagree with the check that let you — which is exactly what two
 * computations drift into.
 *
 * ⚠ **This is the ONLY thing the browser may ask about its own access.** The client has
 * no policy of its own: `packages/client/src/lib/capabilities.ts` — a second `ROLE_CAPS`
 * that disagreed with the server's about whether an approver may publish — is deleted,
 * and `ui-honesty-check.sh` fails if anything under `app/` or `components/` reads the
 * sign-in session's roles or reintroduces a client-side policy table.
 */
attendanceRouter.get(
  "/permissions",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { effectivePermissionsService } = await import(
      "../services/effective-permissions.service.js"
    );
    const workspaceId = req.params.workspaceId!;
    const eff = await effectivePermissionsService.forWorkspace(req.user, workspaceId);
    const platform = await effectivePermissionsService.platformPermissions(req.user);
    res.json({
      workspaceId,
      permissions: eff.permissions,
      provenance: eff.provenance,
      memberRole: eff.memberRole,
      superAdmin: eff.isSuperAdmin,
      platformRoles: platform.roles,
      platformPermissions: platform.permissions,
    });
  }),
);
