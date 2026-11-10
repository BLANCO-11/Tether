import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.hoisted(() => {
  process.env.RUNTIME_JWT_SECRET = process.env.RUNTIME_JWT_SECRET || "test-secret";
});

const svc = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  findByEmail: vi.fn(),
  superAdminEmails: vi.fn(() => ["root@example.com"]),
  isUserAdmin: vi.fn(),
}));

vi.mock("../services/mail.service.js", () => ({ sendSystemMail: vi.fn(async () => ({ ok: true, messageId: null, requestId: null })) }));
vi.mock("../services/allowed-user.service.js", () => ({
  allowedUserService: svc,
  normalizeEmail: (s: string) => s.trim().toLowerCase(),
}));

import express from "express";
import { allowedUsersRouter } from "./allowed-users.js";
import { errorHandler } from "../middleware/error.middleware.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const h = req.header("x-test-user");
    if (h) req.user = JSON.parse(h);
    next();
  });
  app.use("/api/allowed-users", allowedUsersRouter);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/allowed-users`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const me = { subject: "email:boss@example.com", email: "boss@example.com" };
const call = (method: string, path = "", user: object | null = me, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  svc.isUserAdmin.mockResolvedValue(true);
  svc.list.mockResolvedValue([{ id: "u1", email: "boss@example.com", role: "admin", enabled: true }]);
  svc.add.mockResolvedValue({ id: "u2", email: "a@b.co", role: "user" });
});

describe("allowed-users authorization", () => {
  it("no user is a 401", async () => {
    expect((await call("GET", "", null)).status).toBe(401);
  });

  it("a non-admin is a 403 everywhere and nothing is written", async () => {
    svc.isUserAdmin.mockResolvedValue(false);
    expect((await call("GET")).status).toBe(403);
    expect((await call("POST", "", me, { email: "a@b.co", role: "user" })).status).toBe(403);
    expect((await call("PATCH", "/u1", me, { enabled: false })).status).toBe(403);
    expect((await call("DELETE", "/u1")).status).toBe(403);
    expect(svc.add).not.toHaveBeenCalled();
    expect(svc.update).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("an admin lists users and super admins", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[]; superAdmins: string[] };
    expect(body.users).toHaveLength(1);
    expect(body.superAdmins).toEqual(["root@example.com"]);
  });

  it("refuses createdBy in the body", async () => {
    const res = await call("POST", "", me, { email: "a@b.co", role: "user", createdBy: "x" });
    expect(res.status).toBe(400);
    expect(svc.add).not.toHaveBeenCalled();
  });

  it("creates with createdBy from the identity", async () => {
    const res = await call("POST", "", me, { email: "a@b.co", role: "user" });
    expect(res.status).toBe(201);
    expect(svc.add).toHaveBeenCalledWith({ email: "a@b.co", role: "user", createdBy: me.subject });
  });

  it("an admin cannot demote their own row", async () => {
    const res = await call("PATCH", "/u1", me, { role: "user" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message?: string }).message ?? "").toMatch(/own admin access/);
    expect(svc.update).not.toHaveBeenCalled();
  });
});
