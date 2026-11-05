/**
 * Connectors (plans/plugins-2026-10-27, phase 3). Permissions are spliced from the route map
 * (`auth/route-permissions.ts`), never written here:
 *
 *   /api/plugins/…                      platform.plugins.install — the deployment's installs
 *   /api/workspaces/:ws/plugins/…       plugins.read (look) · plugins.enable (connect, choose actions)
 *
 * ⚠ No route returns a connection's value. Creating and rotating one take it; every answer carries names only.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { pluginService, pieceName, type Actor } from "../services/plugin.service.js";

function actor(req: { user?: { subject: string; email?: string | null } }): Actor {
  return { subject: req.user!.subject, email: req.user!.email ?? null };
}

/**
 * ⚠ The route map grants these routes on `plugins.read`, because a person may manage their OWN connection ("as me")
 * with that alone. A WORKSPACE connection still needs `plugins.enable`, checked here against the same resolver every
 * guard uses — the handler only ever narrows what the route allows.
 */
async function canEnable(user: Request["user"], workspaceId: string): Promise<boolean> {
  const { effectivePermissionsService } = await import("../services/effective-permissions.service.js");
  const eff = await effectivePermissionsService.forWorkspace(user, workspaceId);
  return eff.permissions.includes("plugins.enable");
}
function refuseEnable(): never {
  throw Object.assign(new Error("connecting a service for the whole workspace needs the “Connect services” permission here"), { statusCode: 403 });
}
async function workspaceOnlyIfAllowed(user: Request["user"], workspaceId: string, personal: boolean) {
  if (!personal && !(await canEnable(user, workspaceId))) refuseEnable();
}

const installSchema = z.object({
  piece: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a connector's short name, e.g. amazon-s3"),
  version: z.string().optional(),
  hosts: z.array(z.string()).optional(),
}).strict();
const hostsSchema = z.object({ hosts: z.array(z.string()) }).strict();
const upgradeSchema = z.object({ version: z.string() }).strict();
const fieldsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const connectionSchema = z.object({ label: z.string(), authType: z.string().optional(), fields: fieldsSchema, asMe: z.boolean().optional() }).strict();
const oauthAppSchema = z
  .object({ useSignInApp: z.boolean().optional(), clientId: z.string().optional(), clientSecret: z.string().optional(), scopes: z.array(z.string()).optional() })
  .strict();
const oauthStartSchema = z
  .object({ label: z.string().optional(), connectionId: z.string().uuid().optional(), asMe: z.boolean().optional(), props: fieldsSchema.optional() })
  .strict();
const oauthCallbackSchema = z
  .object({ code: z.string().max(4000).optional(), state: z.string().max(400).optional(), error: z.string().max(400).optional(), errorDescription: z.string().max(1000).optional() })
  .strict();
const connectionPatchSchema = z.object({ label: z.string().optional(), fields: fieldsSchema.optional() }).strict();
const actionsSchema = z.object({ connectionId: z.string().uuid(), actions: z.array(z.string()) }).strict();
// The call itself is checked in the service (declared-call.ts), where its refusal can name the rule it broke.
const declareSchema = z.object({ connectionId: z.string().uuid(), call: z.unknown() }).strict();
const packSchema = z.object({ connectionId: z.string().uuid() }).strict();

// ── deployment-wide ──────────────────────────────────────────────────────────────────────────────────────────────────
export const pluginPlatformRouter = Router();

pluginPlatformRouter.get(
  "/marketplace",
  requireIdentity,
  asyncHandler(async (_req, res) => {
    res.json(await pluginService.marketplace());
  }),
);

pluginPlatformRouter.get(
  "/installs",
  requireIdentity,
  asyncHandler(async (_req, res) => {
    res.json({ installs: await pluginService.installs() });
  }),
);

pluginPlatformRouter.post(
  "/installs",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = installSchema.parse(req.body);
    res.status(201).json({ install: await pluginService.install({ ...input, piece: pieceName(input.piece) }, actor(req)) });
  }),
);

pluginPlatformRouter.put(
  "/installs/:piece/hosts",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { hosts } = hostsSchema.parse(req.body);
    res.json({ install: await pluginService.setHosts(pieceName(req.params.piece), hosts, actor(req)) });
  }),
);

pluginPlatformRouter.post(
  "/installs/:piece/upgrade",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { version } = upgradeSchema.parse(req.body);
    res.json(await pluginService.upgrade(pieceName(req.params.piece), version, actor(req)));
  }),
);

pluginPlatformRouter.delete(
  "/installs/:piece",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await pluginService.uninstall(pieceName(req.params.piece), actor(req));
    res.status(204).end();
  }),
);

pluginPlatformRouter.get(
  "/oauth-apps/:piece",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ app: await pluginService.oauthApp(pieceName(req.params.piece!)) });
  }),
);

pluginPlatformRouter.put(
  "/oauth-apps/:piece",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = oauthAppSchema.parse(req.body);
    res.json({ app: await pluginService.setOauthApp(pieceName(req.params.piece!), input, actor(req)) });
  }),
);

pluginPlatformRouter.delete(
  "/oauth-apps/:piece",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await pluginService.removeOauthApp(pieceName(req.params.piece!), actor(req));
    res.status(204).end();
  }),
);

// ── one workspace ────────────────────────────────────────────────────────────────────────────────────────────────────
export const pluginWorkspaceRouter = Router({ mergeParams: true });

pluginWorkspaceRouter.get(
  "/marketplace",
  requireIdentity,
  asyncHandler(async (_req, res) => {
    res.json(await pluginService.marketplace());
  }),
);

pluginWorkspaceRouter.get(
  "/",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ plugins: await pluginService.workspaceView(req.params.workspaceId!, req.user!.subject) });
  }),
);

pluginWorkspaceRouter.post(
  "/:piece/connections",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = connectionSchema.parse(req.body);
    await workspaceOnlyIfAllowed(req.user, req.params.workspaceId!, input.asMe === true);
    res.status(201).json({ connection: await pluginService.createConnection(req.params.workspaceId!, pieceName(req.params.piece!), input, actor(req)) });
  }),
);

pluginWorkspaceRouter.put(
  "/:piece/actions",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = actionsSchema.parse(req.body);
    res.json({ plugin: await pluginService.setActions(req.params.workspaceId!, pieceName(req.params.piece!), input, actor(req)) });
  }),
);

/**
 * Declared API calls (plans/declared-api-calls-2026-10-29). Reading is `plugins.read`; declaring, switching on a pack
 * and switching a call off is `plugins.enable` — the same people who choose a piece's own actions.
 */
pluginWorkspaceRouter.get(
  "/:piece/calls",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await pluginService.listDeclaredCalls(req.params.workspaceId!, pieceName(req.params.piece!)));
  }),
);

pluginWorkspaceRouter.post(
  "/:piece/calls",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = declareSchema.parse(req.body);
    res.status(201).json(await pluginService.declareCall(req.params.workspaceId!, pieceName(req.params.piece!), { connectionId: input.connectionId, call: input.call }, actor(req)));
  }),
);

pluginWorkspaceRouter.post(
  "/:piece/call-packs/:pack",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = packSchema.parse(req.body);
    res.status(201).json(await pluginService.enablePack(req.params.workspaceId!, pieceName(req.params.piece!), { connectionId: input.connectionId, pack: req.params.pack! }, actor(req)));
  }),
);

pluginWorkspaceRouter.delete(
  "/:piece/calls/:name",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await pluginService.removeDeclaredCall(req.params.workspaceId!, pieceName(req.params.piece!), req.params.name!, actor(req)));
  }),
);

/**
 * For me (plans/personal-actions-2026-10-29): actions a person switches on for THEMSELVES, through their own connection.
 * `plugins.read` — every member who can see connectors; the subject is always the caller, never a body field. Whether
 * members may do it at all is an admin's (`plugins.enable`).
 */
const myActionsSchema = z.object({ actions: z.array(z.string().min(1).max(200)).max(500) }).strict();
const personalPolicySchema = z.object({ allowed: z.boolean() }).strict();

pluginWorkspaceRouter.get(
  "/:piece/mine",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await pluginService.personalView(req.params.workspaceId!, pieceName(req.params.piece!), req.user!.subject));
  }),
);

pluginWorkspaceRouter.put(
  "/:piece/mine/actions",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = myActionsSchema.parse(req.body);
    res.json(await pluginService.setMyActions(req.params.workspaceId!, pieceName(req.params.piece!), input, actor(req)));
  }),
);

pluginWorkspaceRouter.post(
  "/:piece/mine/call-packs/:pack",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.status(201).json(await pluginService.enableMyPack(req.params.workspaceId!, pieceName(req.params.piece!), req.params.pack!, actor(req)));
  }),
);

pluginWorkspaceRouter.delete(
  "/:piece/mine/calls/:name",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await pluginService.removeMyCall(req.params.workspaceId!, pieceName(req.params.piece!), req.params.name!, actor(req)));
  }),
);

pluginWorkspaceRouter.put(
  "/:piece/personal-use",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = personalPolicySchema.parse(req.body);
    res.json(await pluginService.setPersonalAllowed(req.params.workspaceId!, pieceName(req.params.piece!), input.allowed, actor(req)));
  }),
);

pluginWorkspaceRouter.patch(
  "/connections/:connectionId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = connectionPatchSchema.parse(req.body);
    const row = await pluginService.getConnectionRow(req.params.workspaceId!, req.params.connectionId!, req.user!.subject);
    await workspaceOnlyIfAllowed(req.user, req.params.workspaceId!, row.ownerSubject != null);
    res.json({ connection: await pluginService.updateConnection(req.params.workspaceId!, req.params.connectionId!, input, actor(req)) });
  }),
);

pluginWorkspaceRouter.post(
  "/connections/:connectionId/test",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const row = await pluginService.getConnectionRow(req.params.workspaceId!, req.params.connectionId!, req.user!.subject);
    await workspaceOnlyIfAllowed(req.user, req.params.workspaceId!, row.ownerSubject != null);
    res.json(await pluginService.testConnection(req.params.workspaceId!, req.params.connectionId!, actor(req)));
  }),
);

pluginWorkspaceRouter.delete(
  "/connections/:connectionId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const row = await pluginService.getConnectionRow(req.params.workspaceId!, req.params.connectionId!, req.user!.subject);
    await workspaceOnlyIfAllowed(req.user, req.params.workspaceId!, row.ownerSubject != null);
    await pluginService.deleteConnection(req.params.workspaceId!, req.params.connectionId!, actor(req));
    res.status(204).end();
  }),
);

/** Begin signing in. Answers `{authorizeUrl}` (the browser goes there) or, with no person needed, `{connection}`. */
pluginWorkspaceRouter.post(
  "/:piece/oauth/start",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = oauthStartSchema.parse(req.body);
    const ws = req.params.workspaceId!;
    if (input.connectionId) {
      const row = await pluginService.getConnectionRow(ws, input.connectionId, req.user!.subject);
      await workspaceOnlyIfAllowed(req.user, ws, row.ownerSubject != null);
    } else {
      await workspaceOnlyIfAllowed(req.user, ws, input.asMe === true);
    }
    res.json(await pluginService.startOauth(ws, pieceName(req.params.piece!), input, actor(req)));
  }),
);

/** The provider's answer, posted by the client's `/api/oauth/callback` page on the person's behalf. */
pluginWorkspaceRouter.post(
  "/oauth/callback",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = oauthCallbackSchema.parse(req.body);
    const ws = req.params.workspaceId!;
    res.json(await pluginService.finishOauth(ws, input, actor(req), { canEnable: await canEnable(req.user, ws) }));
  }),
);
