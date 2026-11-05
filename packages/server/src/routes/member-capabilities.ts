/**
 * ⚠ **`requireSuperAdmin` REMOVED — these are `members.read` / `members.grant` now.**
 *
 * Same resolution as `members.ts`: the rule is super admin **OR** the permission, not
 * AND. Keeping the super-admin guard alongside the spliced permission guard would mean
 * AND, which is narrower than today and would stop a workspace administrator managing
 * grants inside their own workspace. `config.isSuperAdmin` short-circuits the resolver
 * to the whole catalogue, so an allowlist holder still passes with no membership row.
 *
 * The guards are declared in `auth/route-permissions.ts` and spliced at boot; do not add
 * a second one here.
 */
import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { isValidCapability, workspaceMemberCapabilitiesService } from "../services/workspace-member-capabilities.service.js";

export const memberCapabilitiesRouter = Router({ mergeParams: true });

memberCapabilitiesRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ capabilities: await workspaceMemberCapabilitiesService.listAll(req.params.workspaceId!) });
  }),
);

memberCapabilitiesRouter.put(
  "/:subject/:capability",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { workspaceId, subject, capability } = req.params;
    if (!isValidCapability(capability)) {
      return res.status(400).json({ error: "validation", message: `unknown capability ${capability}` });
    }
    if (!req.user?.subject) return res.status(401).json({ error: "identity required" });
    await workspaceMemberCapabilitiesService.grant({
      workspaceId: workspaceId!,
      subject: subject!,
      capability,
      grantedBy: req.user.subject,
    });
    res.json({ ok: true });
  }),
);

memberCapabilitiesRouter.delete(
  "/:subject/:capability",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { workspaceId, subject, capability } = req.params;
    if (!isValidCapability(capability)) {
      return res.status(400).json({ error: "validation", message: `unknown capability ${capability}` });
    }
    if (!req.user?.subject) return res.status(401).json({ error: "identity required" });
    await workspaceMemberCapabilitiesService.revoke({ workspaceId: workspaceId!, subject: subject!, capability });
    res.json({ ok: true });
  }),
);
