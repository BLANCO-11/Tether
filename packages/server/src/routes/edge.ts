/**
 * Edge agent (personal thin Phase 6) — setup URL + connect approval, jobs, device poll.
 *
 * Person routes (API key + identity) under /workspaces/:ws/edge.
 * Public host routes at /api/edge (setup fetch, register, wait, OTP pair, job claim).
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config/index.js";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity } from "../middleware/identity.middleware.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { edgeDeviceService } from "../services/edge-device.service.js";
import { edgeRelayService } from "../services/edge-relay.service.js";
// Also registers the plugin-relay Approve-card attacher (side effect).
import { piBuilderService } from "../pi-builder/service.js";

export const edgeRouter = Router({ mergeParams: true });
export const edgePublicRouter = Router();

/**
 * Base URL agents can reach. Prefer PUBLIC_API_BASE_URL.
 * Do not use the request Host: Devices mints via the Next proxy, so Host is often the
 * docker service name (`server:4000`) which an agent on the laptop cannot open.
 */
function apiBase(): string {
  return (config.publicApiBaseUrl || "http://localhost:4000").replace(/\/+$/, "");
}

edgeRouter.get(
  "/devices",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ devices: await edgeDeviceService.list(req.params.workspaceId!, req.user!.subject) });
  }),
);

edgeRouter.get(
  "/connects/pending",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json({ connects: await edgeDeviceService.pendingConnects(req.params.workspaceId!, req.user!.subject) });
  }),
);

/** Copy-paste for agents: curl that fetches instructions (+ setup token inside). */
edgeRouter.post(
  "/setup-link",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().max(120).optional() }).strict().parse(req.body ?? {});
    const out = await edgeDeviceService.mintSetupLink(
      req.params.workspaceId!,
      req.user!.subject,
      name ?? "This computer",
      apiBase(),
    );
    res.status(201).json({
      curl: out.curl,
      url: out.url,
      expiresAt: out.expiresAt.toISOString(),
      label: out.label,
    });
  }),
);

edgeRouter.post(
  "/devices/:deviceId/approve-connect",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    const device = await edgeDeviceService.approveConnect(
      req.params.workspaceId!,
      req.params.deviceId!,
      req.user!.subject,
      v.all,
    );
    res.json({ device });
  }),
);

edgeRouter.post(
  "/devices/:deviceId/deny-connect",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    await edgeDeviceService.denyConnect(req.params.workspaceId!, req.params.deviceId!, req.user!.subject, v.all);
    res.status(204).end();
  }),
);

/** Legacy OTP mint (advanced). */
edgeRouter.post(
  "/devices/pair",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().max(120).optional() }).strict().parse(req.body ?? {});
    const out = await edgeDeviceService.beginPairing(req.params.workspaceId!, req.user!.subject, name ?? "This computer");
    res.status(201).json({
      device: out.device,
      pairingCode: out.pairingCode,
      expiresAt: out.expiresAt.toISOString(),
    });
  }),
);

edgeRouter.delete(
  "/devices/:deviceId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    await edgeDeviceService.revoke(req.params.workspaceId!, req.params.deviceId!, req.user!.subject, v.all);
    res.status(204).end();
  }),
);

edgeRouter.post(
  "/devices/:deviceId/jobs",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        kind: z.enum(["run_command", "read_path", "write_path"]),
        payload: z.record(z.unknown()).default({}),
      })
      .strict()
      .parse(req.body ?? {});
    const job = await edgeDeviceService.enqueue(
      req.params.workspaceId!,
      req.params.deviceId!,
      req.user!.subject,
      body.kind,
      body.payload,
    );
    res.status(201).json({ job });
  }),
);

edgeRouter.get(
  "/devices/:deviceId/jobs",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    res.json({
      jobs: await edgeDeviceService.listJobs(req.params.workspaceId!, req.params.deviceId!, req.user!.subject, v.all),
    });
  }),
);

edgeRouter.post(
  "/jobs/:jobId/approve",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    const job = await edgeDeviceService.approveJob(req.params.workspaceId!, req.params.jobId!, req.user!.subject, v.all);
    res.json({ job });
  }),
);

edgeRouter.post(
  "/jobs/:jobId/reject",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    const job = await edgeDeviceService.rejectJob(req.params.workspaceId!, req.params.jobId!, req.user!.subject, v.all);
    res.json({ job });
  }),
);

edgeRouter.get(
  "/pending",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const [jobs, connects, relays] = await Promise.all([
      edgeDeviceService.pendingApprovals(req.params.workspaceId!, req.user!.subject),
      edgeDeviceService.pendingConnects(req.params.workspaceId!, req.user!.subject),
      edgeRelayService.listPending(req.params.workspaceId!, req.user!.subject),
    ]);
    res.json({ jobs, connects, relays });
  }),
);

/** Needs you: Approve or decline a device → Foundry plugin relay (when no live chat card, or from the inbox). */
edgeRouter.post(
  "/relay/:id/decide",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const body = z.object({ decision: z.enum(["run", "decline"]) }).strict().parse(req.body ?? {});
    const out = await piBuilderService.decideRelayInbox(req.params.workspaceId!, req.params.id!, body.decision, {
      subject: req.user!.subject,
      email: req.user!.email,
      name: req.user!.name,
      identity: req.user!,
    });
    res.json(out);
  }),
);

/** Agent bootstrap script — shipped in packages/server/assets (keep in sync with scripts/edge-agent.mjs). */
edgePublicRouter.get(
  "/agent.mjs",
  asyncHandler(async (_req, res) => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { SERVER_ROOT } = await import("../pi-builder/paths.js");
    const body = await readFile(join(SERVER_ROOT, "assets/edge-agent.mjs"), "utf8");
    res.type("application/javascript; charset=utf-8").send(body);
  }),
);

/** Agent/human: fetch setup instructions (token in query). fmt=sh → one-shot bash bootstrap. */
edgePublicRouter.get(
  "/setup",
  asyncHandler(async (req, res) => {
    const t = z.string().min(8).parse(req.query.t);
    const link = await edgeDeviceService.resolveSetupToken(t);
    const base = apiBase();
    const fmt = String(req.query.fmt || "").toLowerCase();
    if (fmt === "sh" || fmt === "bash") {
      res.type("text/x-shellscript; charset=utf-8").send(edgeDeviceService.setupBootstrapShell(base, t, link.label));
      return;
    }
    const text = edgeDeviceService.setupInstructions(base, t, link.label);
    const wantsJson = String(req.headers.accept || "").includes("application/json");
    if (wantsJson) {
      res.json({
        label: link.label,
        expiresAt: link.expiresAt.toISOString(),
        instructions: text,
        curl: `curl -fsSL '${base}/api/edge/setup?t=${encodeURIComponent(t)}&fmt=sh' | bash`,
        registerUrl: `${base}/api/edge/setup/register`,
        waitUrl: `${base}/api/edge/setup/wait`,
        t,
      });
      return;
    }
    res.type("text/markdown; charset=utf-8").send(text);
  }),
);

edgePublicRouter.post(
  "/setup/register",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        t: z.string().min(8),
        name: z.string().max(120).optional(),
        agent: z.string().max(200).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const out = await edgeDeviceService.registerConnect(body.t, body.name, body.agent);
    res.status(201).json({
      ...out,
      message: "Ask the Foundry user to Approve this connect in Devices (or Needs you). Then poll /api/edge/setup/wait.",
    });
  }),
);

edgePublicRouter.post(
  "/setup/wait",
  asyncHandler(async (req, res) => {
    const body = z
      .object({ deviceId: z.string().uuid(), waitSecret: z.string().min(8) })
      .strict()
      .parse(req.body ?? {});
    const out = await edgeDeviceService.waitForConnect(body.deviceId, body.waitSecret);
    if (out.status === "waiting") {
      res.status(202).json(out);
      return;
    }
    if (out.status === "denied") {
      res.status(410).json(out);
      return;
    }
    res.json(out);
  }),
);

/** Legacy: host completes pairing with the 6-digit code. */
edgePublicRouter.post(
  "/pair",
  asyncHandler(async (req, res) => {
    const body = z.object({ code: z.string().min(4).max(16), name: z.string().max(120).optional() }).strict().parse(req.body ?? {});
    const out = await edgeDeviceService.completePairing(body.code, body.name);
    res.status(201).json(out);
  }),
);

async function deviceAuth(req: { headers: { authorization?: string } }) {
  const raw = req.headers.authorization ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (!token) throw Object.assign(new Error("This request needs the device token as Bearer."), { statusCode: 401 });
  const device = await edgeDeviceService.deviceFromToken(token);
  if (!device) throw Object.assign(new Error("Unknown or revoked device token."), { statusCode: 401 });
  return device;
}

edgePublicRouter.post(
  "/jobs/claim",
  asyncHandler(async (req, res) => {
    const device = await deviceAuth(req);
    const host = z
      .object({
        home: z.string().max(500).optional(),
        cwd: z.string().max(500).optional(),
        platform: z.string().max(64).optional(),
      })
      .strict()
      .optional()
      .parse(req.body ?? {});
    const job = await edgeDeviceService.claimNext(device, host);
    res.json({ job });
  }),
);

edgePublicRouter.post(
  "/jobs/:jobId/complete",
  asyncHandler(async (req, res) => {
    const device = await deviceAuth(req);
    const body = z
      .union([
        z.object({ ok: z.literal(true), result: z.record(z.unknown()).optional() }),
        z.object({ ok: z.literal(false), error: z.string().min(1).max(2000), result: z.record(z.unknown()).optional() }),
      ])
      .parse(req.body ?? {});
    const job = await edgeDeviceService.completeJob(device, req.params.jobId!, body);
    res.json({ job });
  }),
);

/**
 * Device → Foundry → plugin relay: run a connected-plugin action with the owner's configured connection.
 * Reads finish immediately; writes become an Approve card (poll GET until done/declined).
 */
edgePublicRouter.post(
  "/relay",
  asyncHandler(async (req, res) => {
    const device = await deviceAuth(req);
    const body = z
      .object({
        tool: z.string().min(1).max(200),
        params: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]).optional(),
        summary: z.string().min(5).max(500),
        sessionId: z.string().max(80).nullable().optional(),
        chatId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const out = await edgeRelayService.create(device, body);
    res.status(out.status === "awaiting_approval" ? 202 : out.status === "done" ? 200 : 200).json({ relay: out, message: out.message });
  }),
);

edgePublicRouter.get(
  "/relay/:id",
  asyncHandler(async (req, res) => {
    const device = await deviceAuth(req);
    const relay = await edgeRelayService.get(device, req.params.id!);
    res.json({ relay });
  }),
);
