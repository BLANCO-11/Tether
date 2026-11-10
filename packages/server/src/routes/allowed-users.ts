// src/routes/allowed-users.ts — who may sign in by email, managed by an allowlist
// admin (an `allowed_users` admin or SUPER_ADMIN_EMAILS). The actor is always the
// verified identity, never a body field.
import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { requireUserAdmin } from "../middleware/user-admin.middleware.js";
import { allowedUserService } from "../services/allowed-user.service.js";
import { config } from "../config/index.js";

export const allowedUsersRouter = Router();

allowedUsersRouter.use(requireIdentity, requireUserAdmin);

function httpError(message: string, status: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

const roleSchema = z.enum(["admin", "user"]);

// `.strict()`: `createdBy` is taken from the identity, so a body that names it is a 400.
const createSchema = z.object({ email: z.string().min(3).max(320), role: roleSchema }).strict();

const updateSchema = z
  .object({ role: roleSchema.optional(), enabled: z.boolean().optional() })
  .strict()
  .refine((v) => v.role !== undefined || v.enabled !== undefined, { message: "send role or enabled" });

/**
 * The target row, after refusing a change that would lock the caller out: an admin may not demote, disable or
 * delete their own row, unless a super admin (who cannot be locked out).
 */
async function targetRow(req: Request, id: string, removes: boolean) {
  const row = (await allowedUserService.list()).find((u) => u.id === id) ?? null;
  const me = req.user!;
  if (removes && row && me.email && !config.isSuperAdmin(me) && row.email.toLowerCase() === me.email.toLowerCase()) {
    throw httpError("You cannot remove your own admin access.", 400);
  }
  return row;
}

allowedUsersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ users: await allowedUserService.list(), superAdmins: allowedUserService.superAdminEmails() });
  }),
);

allowedUsersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const user = await allowedUserService.add({ ...input, createdBy: req.user!.subject });
    res.status(201).json({ user });
  }),
);

allowedUsersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = updateSchema.parse(req.body);
    const id = req.params.id!;
    await targetRow(req, id, patch.role === "user" || patch.enabled === false);
    res.json({ user: await allowedUserService.update(id, patch) });
  }),
);

allowedUsersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const user = await targetRow(req, id, true);
    await allowedUserService.remove(id);
    res.json({ user });
  }),
);
