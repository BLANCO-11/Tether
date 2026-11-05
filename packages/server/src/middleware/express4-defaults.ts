import type { Express, NextFunction, Request, Response } from "express";

/**
 * The two Express 5 default changes every route here was written against, put back to Express 4's.
 *
 * 1. **`query parser`: `"extended"` (qs), not Express 5's `"simple"`.** `?a[b]=1` is an object under qs and the literal
 *    key `"a[b]"` under the simple parser; a route reading the nested form would get `undefined` with no error.
 *
 * 2. **`req.body` is `{}` when nothing parsed it, not `undefined`.** body-parser 2 leaves it `undefined` for a request
 *    with no body (a POST with no payload, every GET). Express 4's parsers always set `{}`, and ~30 handlers here read
 *    `req.body.x` or hand `req.body` to a zod schema whose fields are all optional — `undefined` turns the first into a
 *    500 and the second into a 400 on a request that worked yesterday. It is set BEFORE any parser runs: body-parser 2
 *    still parses a body that arrives (it only assigns `undefined` when `body` is absent), so a parsed body replaces it.
 */
export function express4Defaults(app: Express): void {
  app.set("query parser", "extended");
  app.use(function bodyDefault(req: Request, _res: Response, next: NextFunction) {
    if (req.body === undefined) req.body = {};
    next();
  });
}
