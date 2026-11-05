import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditEvents, platformRoleAssignments, tools, usageEvents, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * Restricted workspaces, phase 3 — the views ACROSS workspaces, through the real app. A restricted workspace the reader
 * is outside of shows as its name (and, in the list, its admins) and nothing from inside it: no counts, no access
 * cells, no audit entries (auditors included), no spend.
 *
 * ⚠ Every withholding has its control: the OPEN workspace's equivalent data does show, and the restricted workspace's
 * own data shows again once the reader is inside (its admin, or the workspace opened up).
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
type Who = { subject: string; email: string };
const ADA: Who = { subject: `oid-rv-ada-${stamp}`, email: `ada-${stamp}@acme-hr.example` };
const SAM: Who = { subject: `oid-rv-sam-${stamp}`, email: `sam-${stamp}@acme-hr.example` };
const PAT: Who = { subject: `oid-rv-pat-${stamp}`, email: `pat-${stamp}@acme-hr.example` };
const AUD: Who = { subject: `oid-rv-aud-${stamp}`, email: `aud-${stamp}@acme-hr.example` };

const closed = await workspaceRepo.create({ name: `views restricted ${stamp}`, tenantSlug: "rvwire", slug: `rvwire-c-${stamp}` });
const open = await workspaceRepo.create({ name: `views open ${stamp}`, tenantSlug: "rvwire", slug: `rvwire-o-${stamp}` });
const reachable = !!closed && !!open;
const SECRET_LINE = `inside-only ${stamp}`;
const OPEN_LINE = `open-line ${stamp}`;

async function identity(who: Who): Promise<string> {
  return new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}
async function get(path: string, as: Who) {
  const res = await fetch(`${base}/api${path}`, {
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
const setRestricted = (v: boolean) => db.update(workspacesTable).set({ restricted: v }).where(eq(workspacesTable.id, closed!.id));

type ListRow = { id: string; name: string; restricted?: boolean; closed?: boolean; admins?: string[]; counts?: unknown; description?: unknown };

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  config.superAdminEmails.add(SAM.email);
  await db.insert(workspaceMembers).values({ workspaceId: closed!.id, ...ADA, role: "admin", grantedBy: "test" });
  await db.insert(platformRoleAssignments).values([
    { ...PAT, roleKey: "platform-admin", grantedBy: "test" },
    { ...AUD, roleKey: "auditor", grantedBy: "test" },
  ]);
  const hourAgo = new Date(Date.now() - 3600_000);
  await db.insert(auditEvents).values([
    { workspaceId: closed!.id, actor: "x", operation: "access", entity: "policy", description: SECRET_LINE, whereText: "t" },
    { workspaceId: open!.id, actor: "x", operation: "access", entity: "policy", description: OPEN_LINE, whereText: "t" },
  ]);
  await db.insert(usageEvents).values([
    { workspaceId: closed!.id, purpose: "building", kind: "llm", source: "test", subject: ADA.subject, actor: ADA.email, model: `m-${stamp}`, tokensIn: 7, tokensOut: 0, costUsd: "1", at: hourAgo },
    { workspaceId: open!.id, purpose: "building", kind: "llm", source: "test", subject: ADA.subject, actor: ADA.email, model: `m-${stamp}`, tokensIn: 5, tokensOut: 0, costUsd: "1", at: hourAgo },
  ]);
  await setRestricted(true);
});

afterAll(async () => {
  config.superAdminEmails.delete(SAM.email);
  if (reachable) {
    await db.delete(platformRoleAssignments).where(inArray(platformRoleAssignments.subject, [PAT.subject, AUD.subject]));
    await db.delete(workspacesTable).where(inArray(workspacesTable.id, [closed!.id, open!.id]));
  }
  server?.close();
});

describe.skipIf(!reachable)("views across workspaces, with a restricted one", () => {
  it("the workspace list: name, 'restricted' and its admins for the platform tier — no counts, no description", async () => {
    for (const who of [PAT, SAM]) {
      const rows = (await get("/workspaces?with=counts", who)).body.workspaces as ListRow[];
      const c = rows.find((w) => w.id === closed!.id);
      expect(c).toEqual({ id: closed!.id, name: closed!.name, restricted: true, closed: true, admins: [ADA.email] });
      // CONTROL: the open workspace keeps its counts.
      expect(rows.find((w) => w.id === open!.id)?.counts).toBeDefined();
    }
    // Its own admin sees it as a workspace like any other.
    const mine = ((await get("/workspaces?with=counts", ADA)).body.workspaces as ListRow[]).find((w) => w.id === closed!.id);
    expect(mine?.closed).toBeUndefined();
    expect(mine?.counts).toBeDefined();
  });

  it("the access grid: the restricted workspace is a column with no cell in any row", async () => {
    const grid = (await get("/platform/access", SAM)).body as {
      workspaces: Array<{ id: string; restricted?: boolean }>;
      people: Array<{ subject: string; cells: Record<string, unknown> }>;
    };
    expect(grid.workspaces.find((w) => w.id === closed!.id)?.restricted).toBe(true);
    expect(grid.people.some((p) => closed!.id in p.cells)).toBe(false);
    // CONTROL: the open workspace has cells.
    expect(grid.people.find((p) => p.subject === ADA.subject)?.cells[open!.id]).toBeDefined();
  });

  it("the platform audit: none of its entries — for an auditor too — and CONTROL, the open workspace's are there", async () => {
    for (const who of [AUD, SAM]) {
      const events = ((await get("/platform/audit?limit=1000", who)).body.events as Array<{ action: string }>) ?? [];
      const actions = events.map((e) => e.action);
      expect(actions).toContain(OPEN_LINE);
      expect(actions).not.toContain(SECRET_LINE);
    }
  });

  it("spend and runs: left out of every figure and named only", async () => {
    const o = (await get("/observability?days=1", SAM)).body as {
      byWorkspace: Array<{ workspaceId: string }>;
      restricted: Array<{ id: string; name: string }>;
    };
    expect(o.restricted).toEqual(expect.arrayContaining([{ id: closed!.id, name: closed!.name }]));
    expect(o.byWorkspace.map((w) => w.workspaceId)).not.toContain(closed!.id);
    expect(o.byWorkspace.map((w) => w.workspaceId)).toContain(open!.id); // CONTROL
  });

  it("CONTROL: a platform admin who is ALSO one of its members sees it in full everywhere", async () => {
    await db.insert(workspaceMembers).values({ workspaceId: closed!.id, ...PAT, role: "admin", grantedBy: "test" });
    try {
      const row = ((await get("/workspaces?with=counts", PAT)).body.workspaces as ListRow[]).find((w) => w.id === closed!.id);
      expect(row?.closed).toBeUndefined();
      expect(row?.counts).toBeDefined();
      const grid = (await get("/platform/access", PAT)).body as { people: Array<{ subject: string; cells: Record<string, unknown> }> };
      expect(grid.people.find((p) => p.subject === ADA.subject)?.cells[closed!.id]).toBeDefined();
    } finally {
      await db.delete(workspaceMembers).where(eq(workspaceMembers.subject, PAT.subject));
    }
  });

  it("CONTROL: opened up, every view shows it again", async () => {
    await setRestricted(false);
    try {
      expect(((await get("/workspaces", PAT)).body.workspaces as ListRow[]).find((w) => w.id === closed!.id)?.closed).toBeUndefined();
      const actions = (((await get("/platform/audit?limit=1000", AUD)).body.events as Array<{ action: string }>) ?? []).map((e) => e.action);
      expect(actions).toContain(SECRET_LINE);
      const o = (await get("/observability?days=1", SAM)).body as { byWorkspace: Array<{ workspaceId: string }> };
      expect(o.byWorkspace.map((w) => w.workspaceId)).toContain(closed!.id);
    } finally {
      await setRestricted(true);
    }
  });
});
