/**
 * Invitations — add a person by email with their workspaces and roles chosen in advance (admin simplify, phase 2).
 *
 *   GET    /api/invitations                                open invitations, each limited to what the reader may see
 *   POST   /api/invitations                                { email, workspaces: [{workspaceId, role}], platformRole? }
 *   DELETE /api/invitations/:id                            withdraw the whole invitation
 *   DELETE /api/invitations/:id/workspaces/:workspaceId    take one workspace off it
 *
 * ⚠ **Identity-only in the route map, like the reports, and that is not open.** An invitation spans workspaces, so no
 * single workspace guard fits; `invitationService` checks `members.grant` (and, for a platform role, the grantable
 * check) per workspace, from the verified identity — never from the body.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { invitationService } from "../services/invitation.service.js";

export const invitationsRouter = Router();
const uuid = z.string().uuid();

function caller(req: { user?: { subject?: string | null; email?: string | null } }) {
  return { subject: req.user!.subject ?? req.user!.email ?? "", email: req.user!.email ?? null };
}

invitationsRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ invitations: await invitationService.list(caller(req)) });
  }),
);

invitationsRouter.post(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const result = await invitationService.invite(caller(req), req.body);
    res.status(result.applied ? 200 : 201).json(result);
  }),
);

invitationsRouter.delete(
  "/:id",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await invitationService.revoke(caller(req), uuid.parse(req.params.id));
    res.json({ revoked: true });
  }),
);

invitationsRouter.delete(
  "/:id/workspaces/:workspaceId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await invitationService.removeWorkspace(caller(req), uuid.parse(req.params.id), uuid.parse(req.params.workspaceId));
    res.json({ removed: true });
  }),
);
