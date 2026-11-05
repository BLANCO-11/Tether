import type { ZodSchema } from "zod";

/**
 * Declarative request-boundary validation (V1 — research.md Decision 3).
 *
 * ⚠ Scope is deliberate: this closes measured gaps (routes with no schema at
 * all), not a retrofit of the ~20 routes already validating inline with
 * `zod` — those already satisfy the intent this exists for.
 *
 * On mismatch, calls `next(zodError)` so the failure flows through the
 * pre-existing `ZodError` branch in `error.middleware.ts` — no second
 * response-shape implementation.
 */
export interface RequestLike {
  params: unknown;
  query: unknown;
  body: unknown;
}

export interface ValidateSchemas {
  params?: ZodSchema;
  query?: ZodSchema;
  body?: ZodSchema;
}

export function validate(schemas: ValidateSchemas) {
  return (req: RequestLike, _res: unknown, next: (err?: unknown) => void) => {
    // The parsed (not the raw) value is written back — a schema with
    // `.default()`/coercion must actually apply for downstream handlers, the
    // same way ops-proxy.ts's routes relied on `defaultModel`/`allowedModels`
    // defaulting before this middleware existed.
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) return next(result.error);
      req.params = result.data;
    }
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) return next(result.error);
      // ⚠ Express 5 defines `req.query` as a getter with no setter, so `req.query = …` throws a TypeError. An own
      // property shadows the getter, which is how the parsed value still reaches the handler.
      Object.defineProperty(req, "query", { value: result.data, writable: true, configurable: true, enumerable: true });
    }
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) return next(result.error);
      req.body = result.data;
    }
    next();
  };
}
