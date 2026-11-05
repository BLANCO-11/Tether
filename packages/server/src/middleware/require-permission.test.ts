import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { requirePermission } from "./require-permission.middleware.js";
import { errorHandler } from "./error.middleware.js";
import type { Request, Response, NextFunction } from "express";

/**
 * The guard's three outcomes, and the one that is not a refusal.
 *
 * ⚠ The positive control ("a permitted caller reaches the handler") is what makes the
 * rest mean anything — a guard that refused unconditionally would satisfy every refusal
 * assertion in this file.
 */

const ALICE = { subject: "oid-guard-alice", email: "alice-guard@acme-hr.example" };
const BOB = { subject: "oid-guard-bob", email: "bob-guard@acme-hr.example" };

const ws = await workspaceRepo.create({
  name: "rbac guard tests",
  tenantSlug: "guardtest",
  slug: `guardtest-${Date.now().toString(36)}`,
});
const reachable = !!ws;

/**
 * A tiny app carrying one guarded route, and an identity the test chooses.
 *
 * ⚠ Over real HTTP through `listen()` rather than by calling the handler, matching
 * `local-users.test.ts`: the thing under test is WHICH MIDDLEWARE RUNS and what the
 * error handler does with what it threw, and a direct call skips both.
 */
function appWith(
  permission: Parameters<typeof requirePermission>[0],
  identity: { subject?: string | null; email?: string | null } | null,
  opts: { path?: string; param?: string } = {},
) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { id?: string }).id = "test-request-id";
    if (identity) (req as Request & { user?: unknown }).user = identity as never;
    next();
  });
  app.get(
    opts.path ?? "/api/workspaces/:workspaceId/thing",
    requirePermission(permission, opts.param ? { param: opts.param } : {}),
    (_req, res) => res.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

/** Start one of those apps, issue one GET or POST, shut it down. */
async function call(
  app: express.Express,
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function makeMember(role: string, who = ALICE) {
  await db.insert(workspaceMembers).values({
    workspaceId: ws!.id,
    subject: who.subject,
    email: who.email,
    role,
    grantedBy: "test",
  });
}

beforeEach(async () => {
  if (reachable) await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
});
afterAll(async () => {
  if (!reachable) return;
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
});

describe.skipIf(!reachable)("the two refusals are distinguishable — FR-022", () => {
  it("401 when no person is named, naming the API key as insufficient", async () => {
    const res = await call(appWith("flows.read", null), `/api/workspaces/${ws!.id}/thing`,
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
    expect(res.body.reason).toBe("no_identity");
    // ⚠ The distinction that matters: the API key authorises the REQUEST, it does not
    // name a person, and a workspace permission is a question about a person.
    expect(res.body.message).toMatch(/signed-in user/i);
    expect(res.body.requestId).toBe("test-request-id");
  });

  it("403 `not_a_member` when the person has no standing in this workspace at all", async () => {
    const res = await call(appWith("flows.read", BOB), `/api/workspaces/${ws!.id}/thing`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(res.body.reason).toBe("not_a_member");
  });

  it("403 `missing_permission` when they ARE a member but lack this one", async () => {
    await makeMember("author");
    const res = await call(appWith("secrets.write", ALICE), `/api/workspaces/${ws!.id}/thing`,
    );
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("missing_permission");
    expect(res.body.permission).toBe("secrets.write");
    // ⚠ The two 403s send the reader to two different places — "get added to this
    // workspace" and "get this one permission". One shared reason makes the first
    // person ask for the wrong thing.
    expect(res.body.message).toMatch(/secrets\.write/);
  });

  it("FR-021: a refusal never names who DOES hold the permission", async () => {
    await makeMember("admin", BOB);
    const res = await call(appWith("secrets.write", ALICE), `/api/workspaces/${ws!.id}/thing`,
    );
    expect(res.status).toBe(403);
    const body = JSON.stringify(res.body);
    // A 403 is the last place to publish the list of accounts worth attacking.
    expect(body).not.toContain(BOB.email);
    expect(body).not.toContain(BOB.subject);
  });

  it("CONTROL: a permitted caller reaches the handler", async () => {
    // ⚠ Without this, a guard that refused everything scores 100% above.
    await makeMember("admin");
    const res = await call(appWith("secrets.write", ALICE), `/api/workspaces/${ws!.id}/thing`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("CONTROL: the same identity is refused a permission its role does not carry", async () => {
    await makeMember("author");
    expect(
      (await call(appWith("flows.read", ALICE), `/api/workspaces/${ws!.id}/thing`)).status,
    ).toBe(200);
    expect(
      (await call(appWith("secrets.write", ALICE), `/api/workspaces/${ws!.id}/thing`))
        .status,
    ).toBe(403);
  });
});

describe.skipIf(!reachable)("FR-024: a guard that cannot decide REFUSES TO PASS", () => {
  it("500 naming the wiring defect when the workspace parameter is not in scope", async () => {
    // ⚠ The tempting behaviour is "no workspace, so nothing to check, call next()".
    // That turns the guard off exactly where somebody wired it wrongly — which is
    // exactly where you want to hear about it. A control that cannot fail is worse
    // than no control (I-38).
    const res = await call(appWith("flows.read", ALICE, { path: "/api/thing" }), "/api/thing",
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("misconfigured");
    expect(res.body.reason).toBe("wiring");
    expect(res.body.message).toMatch(/wiring bug, not a permission failure/);
    expect(res.body.message).toMatch(/flows\.read/);
  });

  it("and it is a 500 even for a caller who would otherwise be permitted", async () => {
    await makeMember("admin");
    const res = await call(appWith("flows.read", ALICE, { path: "/api/thing" }), "/api/thing",
    );
    expect(res.status).toBe(500);
  });

  it("takes the parameter NAME explicitly — scope is never inferred from presence", async () => {
    // `GET /api/workspaces/:id` carries `:id`, and
    // `PUT /api/local-users/:id/access/:workspaceId` is a DEPLOYMENT-level route that
    // carries a `:workspaceId`. Inferring either way gets one of them wrong.
    await makeMember("admin");
    const res = await call(
      appWith("flows.read", ALICE, { path: "/api/workspaces/:id", param: "id" }),
      `/api/workspaces/${ws!.id}`,
    );
    expect(res.status).toBe(200);
  });

  it("400 rather than 403 when the workspace id is not a uuid", async () => {
    const res = await call(appWith("flows.read", ALICE), "/api/workspaces/not-a-uuid/thing");
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!reachable)("FR-023: nothing in the request can widen the answer", () => {
  it("a body, a query string and headers claiming the permission change nothing", async () => {
    await makeMember("author");
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { id?: string }).id = "test-request-id";
      (req as Request & { user?: unknown }).user = ALICE;
      next();
    });
    app.post(
      "/api/workspaces/:workspaceId/thing",
      requirePermission("secrets.write"),
      (_req, res) => res.json({ ok: true }),
    );
    app.use(errorHandler);

    const res = await call(
      app,
      `/api/workspaces/${ws!.id}/thing?permission=secrets.write&superAdmin=true`,
      {
        method: "POST",
        headers: {
          "x-foundry-permission": "secrets.write",
          "x-super-admin": "true",
        },
        body: {
          permission: "secrets.write",
          permissions: ["secrets.write"],
          role: "admin",
          isSuperAdmin: true,
          superAdmin: true,
        },
      },
    );

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("missing_permission");
  });

  it("and a caller cannot name a DIFFERENT workspace in the body to be judged against", async () => {
    // The workspace comes from the route parameter and from nowhere else.
    await makeMember("admin");
    const other = await workspaceRepo.create({
      name: "rbac guard other",
      tenantSlug: "guardtest",
      slug: `guardtest-other-${Date.now().toString(36)}`,
    });
    try {
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { id?: string }).id = "test-request-id";
        (req as Request & { user?: unknown }).user = ALICE;
        next();
      });
      app.post(
        "/api/workspaces/:workspaceId/thing",
        requirePermission("secrets.write"),
        (_req, res) => res.json({ ok: true }),
      );
      app.use(errorHandler);

      // Alice is an admin of `ws`, and of nothing in `other`.
      const res = await call(app, `/api/workspaces/${other!.id}/thing`, {
        method: "POST",
        body: { workspaceId: ws!.id },
      });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("not_a_member");
    } finally {
      if (other) await db.delete(workspacesTable).where(eq(workspacesTable.id, other.id));
    }
  });
});
