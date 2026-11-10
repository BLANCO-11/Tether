import { Router } from "express";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { config } from "../config/index.js";
import { workspaceMemberCapabilitiesService } from "../services/workspace-member-capabilities.service.js";
import { effectivePermissionsService } from "../services/effective-permissions.service.js";
import { asyncHandler } from "../middleware/error.middleware.js";
import { platformUserService } from "../services/platform-user.service.js";
import { reportService } from "../services/report.service.js";
import { allowedUserService } from "../services/allowed-user.service.js";
import { z } from "zod";
export const meRouter = Router();


/**
 * Who the caller is, and what the deployment will let them do at deployment
 * level. Mounted at `/api/me`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The client has to hide the Manage Workspaces nav row from a non-super-admin
 * and render a refusal on the page itself. It cannot decide that locally.
 *
 * ⚠ **`session.user.roles` MUST NOT be used for it, and it is sitting right
 * there.** `packages/client/src/auth.ts` already puts `["superadmin","admin"]`
 * on the local credentials account, in the browser's session, from a password
 * check — while the server's answer comes from `SUPER_ADMIN_EMAILS` in the API
 * server's environment. Reading the session would be a second definition of
 * "super admin" that can disagree with the only one that refuses anything, and
 * it would disagree in the worse direction: a screen that renders because the
 * session says so, over routes that all 403.
 *
 * So: **the client asks, and never decides.** Hiding the row is presentation;
 * `requireSuperAdmin` on the routes is the control.
 *
 * ── ⚠ Deliberately NOT super-admin-gated ────────────────────────────────────
 *
 * `requireIdentity` only. A non-super-admin is precisely who needs the `false`,
 * and gating it would make the answer unobtainable by everyone who needs it —
 * a 403 here would be indistinguishable from a broken deployment.
 *
 * It reveals nothing a caller does not already have: their own token's claims,
 * plus one boolean about themselves. ⚠ It does **not** list who the super admins
 * are — `superAdminConfigured` says only whether any exist, which is what lets a
 * screen tell "you are not one" from "nobody is, set the variable". Publishing
 * the list would name the accounts worth attacking.
 */
meRouter.get(
  "/",
  requireIdentity,
  /**
   * ⚠ `asyncHandler`, not a bare `async` handler. This route is where the
   * 2026-09-08 outage landed: a page sent `?workspaceId=ws_it`, Postgres
   * refused the non-uuid with `22P02`, the rejection reached no `next`, and
   * **Node exited the process** — fifteen times. `error.middleware.ts` has had
   * the correct `22P02 → 400` branch the whole time; nothing routed to it.
   */
  asyncHandler(async (req, res) => {
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  let capabilities: string[] | undefined;
  if (workspaceId) {
    capabilities = await workspaceMemberCapabilitiesService.getCapabilities({
      workspaceId,
      subject: req.user!.subject,
      email: req.user!.email,
    });
  } else if (config.isSuperAdmin(req.user)) {
    // no workspace — super admin gets all, others get role-agnostic none
    capabilities = [...workspaceMemberCapabilitiesService.CAPABILITIES];
  }
  /**
   * ⚠ The PLATFORM tier, added by the RBAC feature.
   *
   * Keyed on the person alone — there is no workspace in the question — so it is
   * answered whether or not `?workspaceId=` was supplied. A screen that hides the
   * deployment-admin surfaces needs this, and reading the sign-in session for it would
   * be a second authority that can disagree with the only one that refuses anything
   * (`ui-honesty-check.sh` bans that read for exactly this reason).
   *
   * ⚠ Existing keys keep their meaning and their position. `capabilities` is still the
   * workspace answer and is still absent when no workspace was named.
   */
  const platform = await effectivePermissionsService.platformPermissions(req.user);
  // The mode a new Forge chat opens in (0097) — the person's own choice, Workflow Builder until they make one.
  const forgeDefaultMode = await platformUserService.forgeDefaultMode(req.user!.subject).catch(() => "workflow" as const);

  // Whether the cost report is theirs to open: `reports.read` (an Admin's) in at least one workspace, or a super admin.
  // The nav asks; the report routes decide. A failed lookup reads as "no", which only hides a link.
  const canViewReports = await reportService
    .allowedWorkspaces(req.user)
    .then((w) => w.length > 0)
    .catch(() => false);

  res.json({
    subject: req.user!.subject,
    email: req.user!.email,
    ...(req.user!.name ? { name: req.user!.name } : {}),
    superAdmin: config.isSuperAdmin(req.user),
    superAdminConfigured: config.superAdminConfigured,
    ...(capabilities ? { capabilities } : {}),
    platformRoles: platform.roles,
    platformPermissions: platform.permissions,
    forgeDefaultMode,
    canViewReports,
    userAdmin: await allowedUserService.isUserAdmin(req.user).catch(() => false),
  });
}),
);

/**
 * A person's own default for new Forge chats (0097): Workflow Builder or Forge Agent. Their own setting, from their
 * verified identity, so it needs no permission beyond being signed in. A workspace that does not offer Forge Agent
 * still opens its chats in Workflow Builder, whatever this says.
 */
meRouter.put(
  "/forge-default-mode",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { mode } = z.object({ mode: z.enum(["workflow", "agent"]) }).strict().parse(req.body ?? {});
    await platformUserService.setForgeDefaultMode(
      { subject: req.user!.subject, email: req.user!.email ?? null, name: req.user!.name ?? null },
      mode,
    );
    res.json({ forgeDefaultMode: mode });
  }),
);
