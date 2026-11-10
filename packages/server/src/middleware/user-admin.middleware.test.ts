import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { makeRequireUserAdmin } from "./user-admin.middleware.js";

const res = {} as Response;
const withUser = { user: { subject: "s", email: "a@x.com" } } as unknown as Request;

describe("requireUserAdmin", () => {
  it("401 when there is no user", async () => {
    const next = vi.fn();
    await makeRequireUserAdmin(async () => true)({} as Request, res, next);
    expect((next.mock.calls[0][0] as { statusCode: number }).statusCode).toBe(401);
  });
  it("403 when not an admin", async () => {
    const next = vi.fn();
    await makeRequireUserAdmin(async () => false)(withUser, res, next);
    expect((next.mock.calls[0][0] as { statusCode: number }).statusCode).toBe(403);
  });
  it("passes when admin", async () => {
    const next = vi.fn();
    await makeRequireUserAdmin(async () => true)(withUser, res, next);
    expect(next).toHaveBeenCalledWith();
  });
  it("forwards a thrown error", async () => {
    const next = vi.fn();
    const err = new Error("boom");
    await makeRequireUserAdmin(async () => {
      throw err;
    })(withUser, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
