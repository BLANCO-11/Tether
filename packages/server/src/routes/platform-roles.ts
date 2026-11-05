import { closedTo } from "../services/workspace-restriction.service.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { requirePlatformPermission } from "../middleware/platform-permission.middleware.js";
import { platformRoleService } from "../services/platform-role.service.js";

export const platformRolesRouter = Router();

/**
 * The platform tier — contracts/api.md §C.
 *
 * ⚠ **These guards are written HERE, not spliced.** Deployment-level routes are not in
 * `mountPermissionGuards`'s workspace sweep — they have no workspace to resolve against
 * — so each one names its own `requirePlatformPermission`. The route map still declares
 * them, and `route-permissions.test.ts` still requires every one to be declared; what it
 * does not do for this tier is mount them, which is why they are explicit.
 *
 * ⚠ Every schema is `.strict()` (FR-025). `permissions` may be named here — that is the
 * point of the endpoint — but `builtin`, `grantedBy` and anything resembling a
 * super-admin flag may not, because INV-13 says no row can confer the allowlist and a
 * field that looks like it might is the beginning of one that does.
 */

const createSchema = z
  .object({
    key: z.string().min(2).max(64),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullish(),
    permissions: z.array(z.string()).max(32),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullish(),
    permissions: z.array(z.string()).max(32).optional(),
  })
  .strict();

const assignSchema = z
  .object({
    subject: z.string().min(1).max(255),
    email: z.string().min(1).max(320),
    roleKey: z.string().min(1).max(64),
  })
  .strict();

platformRolesRouter.get(
  "/roles",
  requireIdentity,
  requirePlatformPermission("platform.users.read"),
  asyncHandler(async (_req, res) => {
    res.json({ roles: await platformRoleService.list() });
  }),
);

platformRolesRouter.post(
  "/roles",
  requireIdentity,
  requirePlatformPermission("platform.roles.write"),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const role = await platformRoleService.create(
      { ...input, description: input.description ?? null },
      req.user!,
    );
    res.status(201).json({ role });
  }),
);

platformRolesRouter.patch(
  "/roles/:key",
  requireIdentity,
  requirePlatformPermission("platform.roles.write"),
  asyncHandler(async (req, res) => {
    const patch = patchSchema.parse(req.body);
    res.json({ role: await platformRoleService.update(req.params.key!, patch, req.user!) });
  }),
);

platformRolesRouter.delete(
  "/roles/:key",
  requireIdentity,
  requirePlatformPermission("platform.roles.write"),
  asyncHandler(async (req, res) => {
    await platformRoleService.remove(req.params.key!, req.user!);
    res.json({ deleted: true });
  }),
);

platformRolesRouter.get(
  "/role-assignments",
  requireIdentity,
  requirePlatformPermission("platform.users.read"),
  asyncHandler(async (_req, res) => {
    res.json({ assignments: await platformRoleService.assignments() });
  }),
);

platformRolesRouter.post(
  "/role-assignments",
  requireIdentity,
  requirePlatformPermission("platform.members.grant"),
  asyncHandler(async (req, res) => {
    const input = assignSchema.parse(req.body);
    await platformRoleService.assign(input, req.user!);
    res.status(201).json({ assigned: true });
  }),
);

platformRolesRouter.delete(
  "/role-assignments/:subject/:roleKey",
  requireIdentity,
  requirePlatformPermission("platform.members.grant"),
  asyncHandler(async (req, res) => {
    await platformRoleService.unassign(req.params.subject!, req.params.roleKey!, req.user!);
    res.json({ assigned: false });
  }),
);

/**
 * ⚠ INV-17 — the union of both audit stores, in one time order. Which table a decision
 * landed in is a storage decision and must never be reader-visible.
 */
platformRolesRouter.get(
  "/audit",
  requireIdentity,
  requirePlatformPermission("platform.audit.read"),
  asyncHandler(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? "200"), 10);
    const actor = typeof req.query.actor === "string" ? req.query.actor : undefined;
    res.json({
      events: await platformRoleService.auditTrail({
        limit: Number.isFinite(limit) ? limit : 200,
        actor,
        hideWorkspaces: new Set((await closedTo(req.user)).keys()),
      }),
    });
  }),
);
