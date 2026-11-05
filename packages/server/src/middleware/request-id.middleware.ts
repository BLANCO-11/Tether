import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/**
 * Always server-generated — a caller-supplied `X-Request-Id` is never
 * trusted (research.md Decision 6): echoing it back would let a caller
 * inject values into logs it doesn't otherwise control.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}
