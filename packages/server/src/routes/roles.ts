import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { workspaceRoleService } from "../services/workspace-role.service.js";

export const rolesRouter = Router({ mergeParams: true });

/**
 * Custom workspace roles — contracts/api.md §B.
 *
 * ⚠ **EVERY SCHEMA IS `.strict()`, AND THAT IS THE CONTROL, NOT TIDINESS.** FR-025: a
 * caller must not be able to name their own authority. `.strict()` means an unknown key
 * is a 400 rather than being quietly ignored — so a body carrying `subject`,
 * `grantedBy`, `bySuperAdmin` or `workspaceId` is REFUSED rather than accepted and
 * dropped. That difference matters: a field that is accepted and ignored reads, to
 * whoever added it, exactly like a field that works, and the next person wires it up.
 *
 * This is the same rule `approveSchema.strict()` enforces for self-approval, and the
 * same reason `verifyVia` is a function argument rather than a field on a schema.
 *
 * ⚠ **The permission guards are SPLICED from `auth/route-permissions.ts`**, not written
 * here. Adding one in this file would be a second answer to "what does this route need",
 * and `route-permissions.test.ts` asserts the mounted guard matches the map.
 */

const nameSchema = z.string().min(1).max(120);

const createSchema = z
  .object({
    name: nameSchema,
    description: z.string().max(1000).nullish(),
    permissions: z.array(z.string()).max(64),
  })
  .strict();

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().max(1000).nullish(),
    permissions: z.array(z.string()).max(64).optional(),
  })
  .strict();

/**
 * ⚠ `subject` is the ONLY field, and it names WHO is being assigned — never what they
 * get. The role comes from the path. A `permissions` field here would let a caller
 * assign a role and silently widen it in the same request.
 */
const assignSchema = z.object({ subject: z.string().min(1).max(255) }).strict();

rolesRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ roles: await workspaceRoleService.list(req.params.workspaceId!) });
  }),
);

rolesRouter.post(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const role = await workspaceRoleService.create(
      req.params.workspaceId!,
      { name: input.name, description: input.description ?? null, permissions: input.permissions },
      req.user!,
    );
    res.status(201).json({ role });
  }),
);

rolesRouter.get(
  "/:roleId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ role: await workspaceRoleService.get(req.params.workspaceId!, req.params.roleId!) });
  }),
);

rolesRouter.patch(
  "/:roleId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const patch = patchSchema.parse(req.body);
    const role = await workspaceRoleService.update(
      req.params.workspaceId!,
      req.params.roleId!,
      patch,
      req.user!,
    );
    res.json({ role });
  }),
);

/** ⚠ Retire, never delete (INV-7). `?confirm=true` is required when anybody holds it. */
rolesRouter.delete(
  "/:roleId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const result = await workspaceRoleService.retire(
      req.params.workspaceId!,
      req.params.roleId!,
      req.user!,
      { confirm: req.query.confirm === "true" },
    );
    res.json(result);
  }),
);

rolesRouter.get(
  "/:roleId/members",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({
      members: await workspaceRoleService.holders(req.params.workspaceId!, req.params.roleId!),
    });
  }),
);

rolesRouter.post(
  "/:roleId/members",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { subject } = assignSchema.parse(req.body);
    await workspaceRoleService.assign(
      req.params.workspaceId!,
      req.params.roleId!,
      subject,
      req.user!,
    );
    res.status(201).json({ assigned: true });
  }),
);

rolesRouter.delete(
  "/:roleId/members/:subject",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await workspaceRoleService.unassign(
      req.params.workspaceId!,
      req.params.roleId!,
      req.params.subject!,
      req.user!,
    );
    res.json({ assigned: false });
  }),
);
