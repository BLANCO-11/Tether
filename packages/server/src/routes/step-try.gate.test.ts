import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";

/**
 * `POST /steps/try` production opt-in gate (plan §4).
 *
 * Plain previews stay at `author`. `useProductionData: true` needs a
 * workspace admin — 403 otherwise — and the service is never reached.
 * The `author` check itself is pre-existing and out of scope, so the
 * identity middleware is stubbed to pass authenticated callers through;
 * the admin verdict under test is the real `workspaceMemberService.check`
 * mock point both routes share.
 */

const tryStepMock = vi.fn();
const memberCheckMock = vi.fn();

vi.mock("../db/index.js", () => ({ db: {}, pool: {}, schema: {} }));
vi.mock("../services/step-try.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/step-try.service.js")>();
  return { ...actual, stepTryService: { tryStep: (...a: unknown[]) => tryStepMock(...a) } };
});
vi.mock("../services/workspace-member.service.js", () => ({
  workspaceMemberService: { check: (...a: unknown[]) => memberCheckMock(...a) },
}));
vi.mock("../middleware/identity.middleware.js", () => ({
  requireIdentity: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireWorkspaceRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  actorOf: () => "ada@example.com",
}));

const { stepTryRouter } = await import("./step-try.js");

function appAs() {
  const app = express();
  app.use(express.json());
  app.use("/api/workspaces/:workspaceId/steps", stepTryRouter);
  return app;
}

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws-1/steps/try`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const TRY = { stepKind: "datasource", ref: "hr_demo.active_users", params: {} };

beforeEach(() => {
  tryStepMock.mockResolvedValue({ ok: true, item: { ok: true }, warnings: [], readFrom: "mock" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("step-try opt-in gate", () => {
  it("plain preview stays ungated by the admin check", async () => {
    const res = await post(appAs(), TRY);
    expect(res.status).toBe(200);
    expect(memberCheckMock).not.toHaveBeenCalled();
    expect(tryStepMock).toHaveBeenCalledTimes(1);
  });

  it("override as non-admin → 403 without reaching the service", async () => {
    memberCheckMock.mockResolvedValue({
      allowed: false,
      status: 403,
      reason: 'this action needs the "admin" role',
    });
    const res = await post(appAs(), { ...TRY, useProductionData: true });
    expect(res.status).toBe(403);
    expect(tryStepMock).not.toHaveBeenCalled();
  });

  it("override as admin → 200 with the flag through", async () => {
    memberCheckMock.mockResolvedValue({ allowed: true, role: "admin" });
    tryStepMock.mockResolvedValue({
      ok: true,
      item: { ok: true },
      warnings: [],
      readFrom: "production",
      usedProductionData: true,
    });
    const res = await post(appAs(), { ...TRY, useProductionData: true });
    expect(res.status).toBe(200);
    expect(tryStepMock).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ useProductionData: true }),
      { actor: "ada@example.com" },
    );
    // fetch JSON boundary — shape asserted here, not trusted above.
    const body: { usedProductionData?: boolean } = res.body as { usedProductionData?: boolean };
    expect(body.usedProductionData).toBe(true);
  });
});
