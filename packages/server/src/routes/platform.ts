import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { platformUserService } from "../services/platform-user.service.js";
import { config } from "../config/index.js";
import { accessMatrixService } from "../services/access-matrix.service.js";
import { peopleService } from "../services/people.service.js";
import { z } from "zod";
import { EMERGENCY_HOURS, startEmergencyAccess } from "../services/workspace-restriction.service.js";

export const platformRouter = Router();

/**
 * Deployment-level reads. Mounted at `/api/platform`.
 *
 * ⚠ **Super-admin only, and the reason is that this is the one list in the
 * product that spans tenants.** There is deliberately no cross-workspace MEMBER
 * listing (D-27) because it would assemble a directory of a customer base out of
 * rows nobody meant to publish together. This list is narrower in subject — it
 * names identities, not who works on whose automations — but it is still every
 * person who has touched the deployment, so it is gated to the people who run it.
 */

/**
 * Who this API has seen.
 *
 * ⚠ The payload carries its own bound in `caveat`, served WITH the data rather
 * than documented beside it — the same rule fragment promotion follows, for the
 * same reason: presenting this as a list of verified users is the failure mode
 * here, and a caveat a client has to go and look up is one it will not.
 */
platformRouter.get(
  "/users",
  requireIdentity,
  // ⚠ `requireSuperAdmin` removed: this is `platform.users.read`, spliced from the route
  // map. Keeping both would make it AND, so an auditor or a support role — whose whole
  // purpose is reading who exists — would be refused. A super admin still passes.
  asyncHandler(async (_req, res) => {
    res.json({
      users: await platformUserService.list(),
      caveat:
        "Every identity that has presented a token this API could verify. Not accounts, not " +
        "verified people, and not a record of who is signed in now — anything holding this " +
        "deployment's identity signing secret can present any identity.",
    });
  }),
);

/**
 * Who can see what, across every workspace (rbac-observability, 2026-10-15). `platform.users.read`, spliced from the
 * route map — the people who already read the list above. See `access-matrix.service.ts` for why this cross-workspace
 * view exists despite D-27, and why every cell is the guard's own answer.
 */
platformRouter.get(
  "/access",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await accessMatrixService.build(req.user));
  }),
);

/**
 * People — one row per person with the workspaces they reach, the open invitations, and what the viewer may do
 * (admin simplify, phase 3). `platform.users.read`, like the two reads above; built on the access grid so each workspace
 * shown is the guard's own answer.
 */
platformRouter.get(
  "/people",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await peopleService.build(req.user ?? {}));
  }),
);

/**
 * A super admin's emergency access to a RESTRICTED workspace (restricted-workspaces phase 2). Outside the workspace's
 * own routes on purpose: inside them the guard resolves the super admin to nothing until this access exists. The
 * route permission is `platform.workspaces.write`; the service narrows it to the super-admin allowlist, so a platform
 * admin who is not on it is refused. A reason (at least 20 characters) and 1, 2 or 4 hours; recorded in that
 * workspace's audit log and emailed to its admins.
 */
const emergencySchema = z
  .object({
    workspaceId: z.string().uuid(),
    reason: z.string().trim().min(20, "say why, in at least 20 characters").max(1000),
    hours: z.union([z.literal(EMERGENCY_HOURS[0]), z.literal(EMERGENCY_HOURS[1]), z.literal(EMERGENCY_HOURS[2])]),
  })
  .strict();

platformRouter.post(
  "/emergency-access",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = emergencySchema.parse(req.body ?? {});
    const { access, notified } = await startEmergencyAccess(input.workspaceId, { subject: req.user!.subject, email: req.user!.email }, input);
    res.status(201).json({ access, notified });
  }),
);
