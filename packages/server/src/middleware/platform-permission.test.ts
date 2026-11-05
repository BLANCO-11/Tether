import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Request, Response, NextFunction } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformRoleAssignments } from "../db/schema.js";
import { platformRoleRepo } from "../repositories/platform-role.repo.js";
import { requirePlatformPermission } from "./platform-permission.middleware.js";
import { errorHandler } from "./error.middleware.js";
import { config } from "../config/index.js";

const ADMIN = { subject: "oid-ppm-admin", email: "ppmadmin@acme-hr.example" };
const AUDITOR = { subject: "oid-ppm-auditor", email: "ppmauditor@acme-hr.example" };
const NOBODY = { subject: "oid-ppm-nobody", email: "ppmnobody@acme-hr.example" };
const SUPER = { subject: "oid-ppm-super", email: "ppmsuper@acme-hr.example" };
const SUBJECTS = [ADMIN.subject, AUDITOR.subject, NOBODY.subject, SUPER.subject];

function appWith(
  permission: Parameters<typeof requirePlatformPermission>[0],
  identity: { subject?: string | null; email?: string | null } | null,
) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { id?: string }).id = "test-request-id";
    if (identity) (req as Request & { user?: unknown }).user = identity as never;
    next();
  });
  app.get("/thing", requirePlatformPermission(permission), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

async function call(app: express.Express) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/thing`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(async () => {
  await db.delete(platformRoleAssignments).where(inArray(platformRoleAssignments.subject, SUBJECTS));
  await platformRoleRepo.assign({
    subject: ADMIN.subject,
    email: ADMIN.email,
    roleKey: "platform-admin",
    grantedBy: "test",
  });
  await platformRoleRepo.assign({
    subject: AUDITOR.subject,
    email: AUDITOR.email,
    roleKey: "auditor",
    grantedBy: "test",
  });
});
afterAll(async () => {
  await db.delete(platformRoleAssignments).where(inArray(platformRoleAssignments.subject, SUBJECTS));
  config.superAdminEmails.delete(SUPER.email);
});

describe("the platform guard's three answers", () => {
  it("401 when no person is named — the API key does not name anybody", async () => {
    const res = await call(appWith("platform.users.read", null));
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("no_identity");
  });

  it("403 for a signed-in person holding nothing on the deployment", async () => {
    const res = await call(appWith("platform.users.read", NOBODY));
    expect(res.status).toBe(403);
    expect(res.body.permission).toBe("platform.users.read");
  });

  it("CONTROL: a platform admin is permitted", async () => {
    // Without this, "refuse everything" scores 100% above.
    expect((await call(appWith("platform.users.read", ADMIN))).status).toBe(200);
  });

  it("an auditor holds `platform.audit.read` and NOT `platform.roles.write`", async () => {
    expect((await call(appWith("platform.audit.read", AUDITOR))).status).toBe(200);
    expect((await call(appWith("platform.roles.write", AUDITOR))).status).toBe(403);
  });
});

/**
 * FR-022 — two refusals, two ACTIONS.
 *
 * ⚠ Not politeness. "Set an environment variable" and "ask a person" are different jobs
 * for different people, and one shared message sends somebody looking for an
 * administrator who does not exist.
 */
describe("FR-022: the refusal names the fix, and the fix differs", () => {
  it("with NO allowlist configured, it names SUPER_ADMIN_EMAILS", async () => {
    const had = [...config.superAdminEmails];
    config.superAdminEmails.clear();
    try {
      const res = await call(appWith("platform.users.read", NOBODY));
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("deployment_unconfigured");
      expect(res.body.message).toContain("SUPER_ADMIN_EMAILS");
    } finally {
      for (const e of had) config.superAdminEmails.add(e);
    }
  });

  it("with an allowlist configured, it points at a person instead", async () => {
    config.superAdminEmails.add(SUPER.email);
    try {
      const res = await call(appWith("platform.users.read", NOBODY));
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("missing_permission");
      expect(res.body.message).toMatch(/platform administrator can grant it/i);
      expect(res.body.message).not.toContain("SUPER_ADMIN_EMAILS");
    } finally {
      config.superAdminEmails.delete(SUPER.email);
    }
  });

  it("⚠ the refusal never names WHO holds the permission", async () => {
    config.superAdminEmails.add(SUPER.email);
    try {
      const res = await call(appWith("platform.roles.write", NOBODY));
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain(ADMIN.email);
      expect(blob).not.toContain(ADMIN.subject);
      expect(blob).not.toContain(SUPER.email);
    } finally {
      config.superAdminEmails.delete(SUPER.email);
    }
  });
});

describe("bootstrap: an allowlist holder passes with no assignment at all", () => {
  it("⚠ this is what stops a fresh deployment being un-administrable", async () => {
    config.superAdminEmails.add(SUPER.email);
    try {
      const holders = await platformRoleRepo.rolesFor(SUPER.subject);
      expect(holders, "the allowlist holder must have NO platform role row").toEqual([]);
      for (const p of [
        "platform.users.read",
        "platform.roles.write",
        "platform.members.grant",
        "platform.workspaces.write",
      ] as const) {
        expect((await call(appWith(p, SUPER))).status, p).toBe(200);
      }
    } finally {
      config.superAdminEmails.delete(SUPER.email);
    }
  });

  it("CONTROL: the same identity NOT on the allowlist is refused", async () => {
    expect((await call(appWith("platform.users.read", SUPER))).status).toBe(403);
  });
});

describe("no request field can widen the answer", () => {
  it("the permission is baked in at mount time, not read from anywhere", async () => {
    // The factory closes over the permission; there is no query string, header or body
    // it consults. Asserted by the source carrying no request-derived permission read.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("./platform-permission.middleware.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(src.length).toBeGreaterThan(500); // CONTROL: the scan found the file
    expect(src).not.toMatch(/req\.(body|query|headers)\s*[.[]\s*["']?permission/);
    expect(src).not.toMatch(/req\.body/);
  });
});
