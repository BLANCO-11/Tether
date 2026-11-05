import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validate } from "./index.js";

function reqResNext(input: { params?: unknown; query?: unknown; body?: unknown }) {
  const req = { params: input.params ?? {}, query: input.query ?? {}, body: input.body ?? {} };
  const res = {};
  const next = vi.fn();
  return { req, res, next };
}

describe("validate({params, query, body})", () => {
  it("calls next() with no arguments when every present schema matches", () => {
    const middleware = validate({ params: z.object({ workspaceId: z.string().uuid() }) });
    const { req, res, next } = reqResNext({
      params: { workspaceId: "550e8400-e29b-41d4-a716-446655440000" },
    });
    middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next(zodError) on a params mismatch, and never reaches the route handler", () => {
    const middleware = validate({ params: z.object({ workspaceId: z.string().uuid() }) });
    const { req, res, next } = reqResNext({ params: { workspaceId: "not-a-uuid" } });
    middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(z.ZodError);
  });

  it("validates body independently of params/query", () => {
    const middleware = validate({ body: z.object({ baseUrl: z.string().min(1) }) });
    const { req, res, next } = reqResNext({ body: { baseUrl: "" } });
    middleware(req as never, res as never, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(z.ZodError);
  });

  it("only validates the schemas actually supplied — an omitted schema is not checked", () => {
    const middleware = validate({ body: z.object({ baseUrl: z.string().min(1) }) });
    const { req, res, next } = reqResNext({
      params: { anything: "goes" },
      body: { baseUrl: "https://example.com" },
    });
    middleware(req as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
  });
});

/**
 * Express 5 defines `req.query` on the request prototype as a getter with NO setter, so a plain `req.query = …` throws
 * a TypeError in strict mode. This builds that shape rather than a plain object, which would accept the write and pass.
 */
describe("validate({ query }) on an Express 5 request", () => {
  function express5Req(raw: Record<string, unknown>) {
    const proto = {};
    Object.defineProperty(proto, "query", { get: () => ({ ...raw }), configurable: true, enumerable: true });
    return Object.assign(Object.create(proto) as { query: unknown; params: unknown; body: unknown }, { params: {}, body: {} });
  }

  it("CONTROL — a plain assignment to that shape throws", () => {
    const req = express5Req({ limit: "5" });
    expect(() => {
      "use strict";
      (req as { query: unknown }).query = {};
    }).toThrow(TypeError);
  });

  it("hands the PARSED query to the handler, not the raw one", () => {
    const middleware = validate({ query: z.object({ limit: z.coerce.number().int() }) });
    const req = express5Req({ limit: "5" });
    const next = vi.fn();
    middleware(req as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ limit: 5 });
  });
});
