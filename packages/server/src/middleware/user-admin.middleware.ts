import type { NextFunction, Request, Response } from "express";
import { allowedUserService } from "../services/allowed-user.service.js";

function httpError(message: string, status: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

/** Gate for managing who can sign in. The admin check is injected so it can be tested without a DB. */
export function makeRequireUserAdmin(isAdmin: (user: NonNullable<Request["user"]>) => Promise<boolean>) {
  return async function requireUserAdmin(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) {
      return next(httpError("managing who can sign in needs a signed-in user", 401));
    }
    let ok: boolean;
    try {
      ok = await isAdmin(req.user);
    } catch (e) {
      return next(e);
    }
    if (!ok) return next(httpError("only an admin can manage who can sign in to this Tether", 403));
    return next();
  };
}

export const requireUserAdmin = makeRequireUserAdmin((u) => allowedUserService.isUserAdmin(u));
