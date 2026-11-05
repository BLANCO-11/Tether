import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

/**
 * `PATCH /api/workspaces/:ws/pi-builder/chats/:chatId` — rename a saved chat.
 *
 * The same people as delete may rename (the person who started the chat, or an Admin — `content.read.others`); anyone
 * else is a 403 with the reason, and nothing is written. The name is trimmed and its inner runs of space collapsed;
 * empty or over 200 characters is a 400. Chats are PRIVATE (rbac-observability, 2026-10-15): the list holds only the
 * caller's own, or every chat for an Admin.
 */
const svc = vi.hoisted(() => ({
  chatOwner: vi.fn(async (_ws: string, _id: string): Promise<{ subject: string | null } | null> => ({ subject: "owner" })),
  renameChat: vi.fn(async (_ws: string, _id: string, _title: string) => undefined),
  listChats: vi.fn(async (_ws: string) => [
    { id: "c-1", title: "Mine", createdBy: { subject: "owner", name: "O" } },
    { id: "c-2", title: "Theirs", createdBy: { subject: "someone", name: "S" } },
  ]),
}));
const admin = vi.hoisted(() => ({ allowed: false }));

vi.mock("../pi-builder/service.js", () => ({ piBuilderService: svc }));
vi.mock("../services/content-visibility.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/content-visibility.service.js")>();
  return {
    contentVisibility: {
      ...actual.contentVisibility,
      viewer: vi.fn(async (user?: { subject?: string | null }) => ({ subject: user?.subject ?? null, all: admin.allowed, reviewer: false })),
    },
  };
});

const { piBuilderRouter } = await import("./pi-builder.js");
const { errorHandler } = await import("../middleware/error.middleware.js");

const CHAT = "6f1c2c1e-7a7b-4c55-9a35-1d3f8f6b2a10";
let base = "";
let server: ReturnType<express.Express["listen"]>;
let caller = "owner";

beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { subject: caller, name: caller };
    next();
  });
  app.use("/api/workspaces/:workspaceId/pi-builder", piBuilderRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());
beforeEach(() => {
  vi.clearAllMocks();
  caller = "owner";
  admin.allowed = false;
});

const rename = (title: unknown, id = CHAT) =>
  fetch(`${base}/api/workspaces/ws-1/pi-builder/chats/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });

describe("rename a saved chat", () => {
  it("the person who started it renames it; the name is trimmed and its spaces collapsed", async () => {
    const res = await rename("  Weekly   attendance  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: CHAT, title: "Weekly attendance" });
    expect(svc.renameChat).toHaveBeenCalledWith("ws-1", CHAT, "Weekly attendance");
  });

  it("someone else is refused with the reason and nothing is written; an Admin may", async () => {
    caller = "intruder";
    const res = await rename("New name");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/an Admin can rename it/);
    expect(svc.renameChat).not.toHaveBeenCalled();
    admin.allowed = true;
    expect((await rename("New name")).status).toBe(200);
    expect(svc.renameChat).toHaveBeenCalledWith("ws-1", CHAT, "New name");
  });

  it("an empty or over-long name is a 400, and a missing chat a 404", async () => {
    expect((await rename("   ")).status).toBe(400);
    expect((await rename("x".repeat(201))).status).toBe(400);
    expect((await rename("x".repeat(200))).status).toBe(200);
    svc.chatOwner.mockResolvedValueOnce(null);
    expect((await rename("Name")).status).toBe(404);
    expect((await rename("Name", "not-a-uuid")).status).toBe(400);
  });

  it("the list holds only the caller's own chats — and every chat for an Admin", async () => {
    const list = async () => {
      const res = await fetch(`${base}/api/workspaces/ws-1/pi-builder/chats`);
      return ((await res.json()) as { chats: Array<{ id: string; canDelete: boolean; canRename: boolean }> }).chats;
    };
    expect((await list()).map((c) => [c.id, c.canDelete, c.canRename])).toEqual([["c-1", true, true]]);
    admin.allowed = true;
    expect((await list()).map((c) => c.id)).toEqual(["c-1", "c-2"]);
  });
});
