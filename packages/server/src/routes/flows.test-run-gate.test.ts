import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";

/**
 * `POST /:flowId/test-run` production opt-in gate (plan §4).
 *
 * Plain runs are untouched (no identity needed, as before). `useProductionData:
 * true` without a signed-in admin is refused — 401 anonymous, 403 non-admin —
 * and the service is never reached. An admin gets 202 with the flag through.
 */

const testRunMock = vi.fn();
const memberCheckMock = vi.fn();

vi.mock("../db/index.js", () => ({ db: {}, pool: {}, schema: {} }));
vi.mock("../services/flow.service.js", () => ({
  flowService: { testRun: (...a: unknown[]) => testRunMock(...a) },
}));
vi.mock("../services/workspace-member.service.js", () => ({
  workspaceMemberService: { check: (...a: unknown[]) => memberCheckMock(...a) },
}));

const { flowsRouter } = await import("./flows.js");

function appAs(user: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/api/workspaces/:workspaceId/flows", (req, _res, next) => {
    if (user) (req as unknown as Record<string, unknown>).user = user;
    next();
  }, flowsRouter);
  return app;
}

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws-1/flows/flow-1/test-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const ADMIN = { subject: "u-admin", email: "admin@example.com" };
const AUTHOR = { subject: "u-author", email: "author@example.com" };

beforeEach(() => {
  testRunMock.mockResolvedValue({ revision: 2, usedProductionData: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("test-run opt-in gate", () => {
  beforeEach(() => {
    testRunMock.mockResolvedValue({ revision: 2, usedProductionData: false });
  });

  it("plain run stays ungated and defaults the flag off", async () => {
    const res = await post(appAs(undefined), {});
    expect(res.status).toBe(202);
    expect(testRunMock).toHaveBeenCalledWith("ws-1", "flow-1", {}, expect.anything(), {
      useProductionData: false,
    });
    expect(memberCheckMock).not.toHaveBeenCalled();
  });

  it("override as author → 403 without reaching the service", async () => {
    memberCheckMock.mockResolvedValue({
      allowed: false,
      status: 403,
      reason: 'this action needs the "admin" role',
    });
    const res = await post(appAs(AUTHOR), { useProductionData: true });
    expect(res.status).toBe(403);
    expect(testRunMock).not.toHaveBeenCalled();
  });

  it("override anonymous → 401 without reaching the service", async () => {
    memberCheckMock.mockResolvedValue({ allowed: false, status: 401, reason: "needs a signed-in user" });
    const res = await post(appAs(undefined), { useProductionData: true });
    expect(res.status).toBe(401);
    expect(testRunMock).not.toHaveBeenCalled();
  });

  it("override as admin → 202 with the flag through and back", async () => {
    memberCheckMock.mockResolvedValue({ allowed: true, role: "admin" });
    testRunMock.mockResolvedValue({ revision: 2, usedProductionData: true });
    const res = await post(appAs(ADMIN), { useProductionData: true });
    expect(res.status).toBe(202);
    expect(testRunMock).toHaveBeenCalledWith("ws-1", "flow-1", {}, expect.anything(), {
      useProductionData: true,
    });
    expect(res.body).toEqual({ revision: 2, usedProductionData: true });
  });
});
