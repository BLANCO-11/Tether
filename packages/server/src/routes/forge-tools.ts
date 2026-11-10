import express, { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { forgeMailBodySchema } from "../pi-builder/forge-mail.js";
import { listActions, piBuilderService, proposeChange, proposeSetting, showCard, usePlugin } from "../pi-builder/service.js";

/**
 * What Forge's OWN tools call while it answers in a chat (2026-10-12) — mounted at `/api/forge`, outside the API key:
 * the caller is a command Forge runs in its sandbox, which holds no server credential (its environment is stripped,
 * `forgeEnv`). It presents its conversation's key (`x-forge-token`, from the sandbox's `.forge-tool.json`), and every
 * other gate is in the service, checked on each call.
 */
export const forgeToolsRouter = Router();

forgeToolsRouter.post(
  "/data",
  express.json({ limit: "64kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z.object({ datasource: z.string().min(1).max(128), sql: z.string().min(1).max(20_000) }).strict().parse(req.body);
    const out = await piBuilderService.askData(token, body.datasource, body.sql);
    res.json(out);
  }),
);

/** A workspace File — or, with `project`, a file of the chat's project — opened while Forge builds (tools/open-file.mjs). */
forgeToolsRouter.post(
  "/file",
  express.json({ limit: "8kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z.object({ name: z.string().min(1).max(255), project: z.boolean().optional() }).strict().parse(req.body);
    const file = await piBuilderService.openWorkspaceFile(token, body.name, { project: body.project });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(file.data.length));
    res.end(file.data);
  }),
);

/** A public web address read while Forge builds (tools/fetch-url.mjs): the same rules as the `web_fetch` tool. */
forgeToolsRouter.post(
  "/fetch",
  express.json({ limit: "8kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z.object({ url: z.string().min(1).max(4000), raw: z.boolean().optional() }).strict().parse(req.body);
    res.json(await piBuilderService.fetchWeb(token, body.url, { raw: body.raw }));
  }),
);

/** Forge Agent emails from the chat (tools/send-email.mjs). It may name To/CC: mail to the owner alone is sent at once; anything else becomes a card that only the person's click (a different, user-authenticated route) sends. */
forgeToolsRouter.post(
  "/mail",
  express.json({ limit: "64kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = forgeMailBodySchema.parse(req.body);
    res.json(await piBuilderService.sendOwnerMail(token, body));
  }),
);

/** Plugins POC: read from a connected service while answering (tools/use-plugin.mjs). A change is refused — see `usePlugin`. */
forgeToolsRouter.post(
  "/plugin",
  express.json({ limit: "64kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z.object({ tool: z.string().min(1).max(255), params: z.record(z.unknown()).default({}) }).strict().parse(req.body);
    res.json(await usePlugin(token, body.tool, body.params));
  }),
);

/**
 * Forge Agent PROPOSES a change to a connected service (tools/propose-change.mjs). ⚠ Nothing is performed here: the
 * proposal becomes a card, and only the person's click (a different route, under their identity) runs it.
 */
forgeToolsRouter.post(
  "/propose",
  // A file committed to a repository travels here as base64 (a batch of up to 25 of them).
  // Cap is also set on `/api/forge/propose` in app.ts (before the process-wide 2mb).
  express.json({ limit: "16mb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z
      .object({
        tool: z.string().min(1).max(255),
        // One call, or a batch of the same action (one card, one click): agent-changes.ts `callsOf` bounds it.
        params: z.union([z.record(z.unknown()), z.array(z.record(z.unknown())).max(25)]).default({}),
        summary: z.string().max(1000).default(""),
      })
      .strict()
      .parse(req.body);
    res.json(await proposeChange(token, body.tool, body.params, body.summary));
  }),
);

/** Every action of the services the person talking can reach, on or off, with its inputs (tools/connector-actions.mjs). A service named and not reachable is a 404 naming the ones that are. */
forgeToolsRouter.post(
  "/actions",
  express.json({ limit: "8kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z.object({ service: z.string().max(128).optional() }).strict().parse(req.body ?? {});
    res.json(await listActions(token, body.service));
  }),
);

/**
 * Forge Agent PROPOSES switching an action on or off (tools/propose-setting.mjs). ⚠ Nothing changes here: the card lets
 * the person choose for themselves (every chat of theirs) or the workspace, and their click (under their identity) applies it.
 */
forgeToolsRouter.post(
  "/propose-setting",
  express.json({ limit: "8kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z
      .object({ service: z.string().min(1).max(128), action: z.string().min(1).max(255), on: z.boolean(), reason: z.string().max(1000).default("") })
      .strict()
      .parse(req.body);
    res.json(await proposeSetting(token, body.service, body.action, body.on, body.reason));
  }),
);

/**
 * Forge shows a structured card in the chat (tools/show-card.mjs): list (info) or choice (ask).
 * Validated allowlisted JSON only; ask-mode pauses until the person acts.
 */
forgeToolsRouter.post(
  "/card",
  express.json({ limit: "64kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z.object({ card: z.unknown() }).strict().parse(req.body ?? {});
    res.json(await showCard(token, body.card));
  }),
);

/** Personal thin: list / enqueue / wait on the person's paired edge devices (tools/edge-*.mjs). */
forgeToolsRouter.post(
  "/edge/devices",
  express.json({ limit: "4kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    res.json(await piBuilderService.edgeListDevices(token));
  }),
);

forgeToolsRouter.post(
  "/edge/enqueue",
  express.json({ limit: "64kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z
      .object({
        deviceId: z.string().uuid(),
        kind: z.enum(["run_command", "read_path", "write_path"]),
        payload: z.record(z.unknown()).default({}),
      })
      .strict()
      .parse(req.body ?? {});
    res.status(201).json(await piBuilderService.edgeEnqueue(token, body));
  }),
);

forgeToolsRouter.post(
  "/edge/job",
  express.json({ limit: "4kb" }),
  asyncHandler(async (req, res) => {
    const token = req.header("x-forge-token") ?? "";
    const body = z
      .object({ jobId: z.string().uuid(), waitMs: z.number().int().min(0).max(120_000).optional() })
      .strict()
      .parse(req.body ?? {});
    res.json(await piBuilderService.edgeJob(token, body));
  }),
);
