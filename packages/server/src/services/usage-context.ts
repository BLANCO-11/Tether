/**
 * Who and which workspace a request is for, available to code deep inside it without threading parameters (P-OBS).
 * Set once per workspace request; read by the inference client, so a model call made while serving a person's
 * request is recorded against them and their workspace — and one made by a harness or a background job (no request)
 * is not recorded at all, rather than recorded against nobody.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export type UsageContext = { workspaceId: string; flowId: string | null; actor: string | null; subject: string | null };

export const usageContext = new AsyncLocalStorage<UsageContext>();

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WORKSPACE_PATH = new RegExp(`^/api/workspaces/(${UUID})(?:/flows/(${UUID}))?`, "i");

/** App-level (before the routers), so `req.path` is the full path. */
export function usageContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const m = WORKSPACE_PATH.exec(req.path);
  if (!m) return next();
  const user = req.user;
  usageContext.run(
    { workspaceId: m[1]!, flowId: m[2] ?? null, actor: user ? (user.email ?? user.subject ?? null) : "system", subject: user?.subject ?? null },
    () => next(),
  );
}
