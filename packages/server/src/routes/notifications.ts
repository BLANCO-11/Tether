import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { notificationService } from "../services/notification.service.js";

/**
 * `/api/workspaces/:workspaceId/notifications` — the signed-in person's own notices (sharing-boundaries phase 1).
 * Always the caller's: the subject comes from the verified identity, never from the request.
 */
export const notificationsRouter = Router({ mergeParams: true });

notificationsRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const rows = await notificationService.listFor(req.params.workspaceId!, req.user!.subject);
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        href: n.href,
        createdAt: n.createdAt,
        read: n.readAt != null,
      })),
    });
  }),
);

const readSchema = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).strict();
notificationsRouter.post(
  "/read",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { ids } = readSchema.parse(req.body ?? {});
    await notificationService.markRead(req.params.workspaceId!, req.user!.subject, ids);
    res.json({ ok: true });
  }),
);
