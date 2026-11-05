import { describe, it, expect, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireApiKey } from "./auth.js";

// FR-001/FR-002 — mcp-bridge has never had any authentication (confirmed by
// reading the whole package before this feature). This is its first test.
function ctx(headerValue?: string) {
  const req = {
    header(name: string) {
      return name.toLowerCase() === "x-api-key" ? headerValue : undefined;
    },
  } as unknown as Request;
  let statusCode = 0;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  } as unknown as Response;
  let called = false;
  const next = (() => {
    called = true;
  }) as NextFunction;
  return {
    req,
    res,
    next,
    get status() {
      return statusCode;
    },
    get body() {
      return payload as { error?: string };
    },
    get called() {
      return called;
    },
  };
}

describe("requireApiKey", () => {
  const originalKey = process.env.MCP_BRIDGE_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MCP_BRIDGE_API_KEY;
    else process.env.MCP_BRIDGE_API_KEY = originalKey;
  });

  it("refuses a request with no credential", () => {
    process.env.MCP_BRIDGE_API_KEY = "correct-key";
    const c = ctx(undefined);
    requireApiKey(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.called).toBe(false);
    expect(c.body.error).toBe("unauthorized");
  });

  it("refuses a request with the wrong credential", () => {
    process.env.MCP_BRIDGE_API_KEY = "correct-key";
    const c = ctx("wrong-key");
    requireApiKey(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.called).toBe(false);
  });

  it("passes through a request with the correct credential — unchanged behavior for a legitimate caller (SC-001)", () => {
    process.env.MCP_BRIDGE_API_KEY = "correct-key";
    const c = ctx("correct-key");
    requireApiKey(c.req, c.res, c.next);
    expect(c.called).toBe(true);
    expect(c.status).toBe(0);
  });

  it("fails CLOSED when the credential is unconfigured — never treats an unset key as anonymous-allowed (FR-002)", () => {
    delete process.env.MCP_BRIDGE_API_KEY;
    const c = ctx("anything");
    requireApiKey(c.req, c.res, c.next);
    expect(c.status).toBe(500);
    expect(c.called).toBe(false);
    expect(c.body.error).toBe("misconfigured");
  });

  it("fails CLOSED when unconfigured even with no header presented at all", () => {
    delete process.env.MCP_BRIDGE_API_KEY;
    const c = ctx(undefined);
    requireApiKey(c.req, c.res, c.next);
    expect(c.status).toBe(500);
    expect(c.called).toBe(false);
  });
});
