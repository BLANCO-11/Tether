import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { ROLE_PRESETS, PRESET_ROLES } from "../auth/role-presets.js";
import { CONFERRABLE, PLATFORM_CONFERS } from "../auth/platform-conferral.js";

export const permissionsRouter = Router();

/**
 * `GET /api/permissions/catalogue` — what a role editor renders from.
 *
 * ⚠ **`requireIdentity` and NO permission.** Needing a permission to discover what
 * permissions exist is a bootstrap nobody can escape, and the catalogue is not sensitive:
 * it is the product's vocabulary, identical on every deployment, and already legible from
 * any refusal message. What IS sensitive — who holds what — is behind `members.read`.
 *
 * ⚠ **Served from the code-owned catalogue, so a client cannot be shown a permission the
 * server would refuse to store.** That is the whole reason there is no `permissions`
 * table: a row referencing something the code does not implement is a grant that reads as
 * real and enforces nothing. This endpoint is what makes the browser's list the same list.
 */
permissionsRouter.get(
  "/catalogue",
  requireIdentity,
  asyncHandler(async (_req, res) => {
    res.json({
      permissions: PERMISSIONS,
      presets: PRESET_ROLES.map((name) => ({ name, permissions: ROLE_PRESETS[name] })),
      /**
       * ⚠ Published deliberately. A screen that says "because they administer the
       * platform" needs to know which permissions can arrive that way, and the set is
       * exactly two — so publishing it is also the clearest possible statement of D-9's
       * bound. Hiding it would not narrow it.
       */
      platformConfers: PLATFORM_CONFERS,
      conferrable: CONFERRABLE,
    });
  }),
);
