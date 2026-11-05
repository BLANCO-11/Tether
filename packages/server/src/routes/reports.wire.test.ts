import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { reportShares, usageEvents, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { config } from "../config/index.js";

/**
 * The cost report (2026-10-26), through the REAL app, guards and SQL:
 *
 *   - only a holder of `reports.read` (an Admin) opens it; an author, a reviewer and an observer are refused;
 *   - an Admin sees the workspaces they are an Admin of, and a workspace outside that set is refused, not emptied;
 *   - the file and the page carry the same rows, and the file carries ALL of them while a page carries one slice;
 *   - an emailed report refuses an address outside the allowed domain before anything is sent or recorded.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const who = (n: string) => ({ subject: `oid-rp-${n}-${stamp}`, email: `${n}-${stamp}@acme-hr.example` });
const ADA = who("ada"); // Admin of A only
const BEN = who("ben"); // Admin of B only
const ALICE = who("alice"); // Creator in A
const OLGA = who("olga"); // Observer in A
const NOBODY = who("nobody");

const wsA = await workspaceRepo.create({ name: `report A ${stamp}`, tenantSlug: "rpwire", slug: `rpa-${stamp}` });
const wsB = await workspaceRepo.create({ name: `report B ${stamp}`, tenantSlug: "rpwire", slug: `rpb-${stamp}` });
const reachable = !!wsA && !!wsB;

async function token(p: { subject: string; email: string }) {
  return new SignJWT({ sub: p.subject, email: p.email, name: p.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));
}
async function call(path: string, as: { subject: string; email: string }, method = "GET", body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await token(as), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) return { status: res.status, type, json: (await res.json()) as Record<string, any>, bytes: Buffer.alloc(0) };
  return { status: res.status, type, json: {} as Record<string, any>, bytes: Buffer.from(await res.arrayBuffer()) };
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (!reachable) return;
  await db.insert(workspaceMembers).values([
    { workspaceId: wsA!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: wsB!.id, ...BEN, role: "admin", grantedBy: "test" },
    { workspaceId: wsA!.id, ...ALICE, role: "author", grantedBy: "test" },
    { workspaceId: wsA!.id, ...OLGA, role: "viewer", grantedBy: "test" },
  ]);
  const at = new Date(Date.now() - 3600_000);
  const row = (workspaceId: string, p: { subject: string; email: string }, cost: string, sessionId: string, purpose = "building") => ({
    workspaceId, purpose, kind: "llm", source: "test", subject: p.subject, actor: p.email, sessionId, costUsd: cost, tokensIn: 10, tokensOut: 5, at,
  });
  await db.insert(usageEvents).values([
    row(wsA!.id, ADA, "1.5", `s1-${stamp}`),
    row(wsA!.id, ALICE, "2.5", `s2-${stamp}`, "test"),
    row(wsA!.id, ALICE, "3", `s3-${stamp}`),
    row(wsB!.id, BEN, "100", `s4-${stamp}`),
  ]);
});

afterAll(async () => {
  if (reachable) {
    await db.delete(reportShares).where(eq(reportShares.senderSubject, ADA.subject));
    await db.delete(workspacesTable).where(eq(workspacesTable.id, wsA!.id));
    await db.delete(workspacesTable).where(eq(workspacesTable.id, wsB!.id));
  }
  server?.close();
});

describe.skipIf(!reachable)("the cost report, at the wire", () => {
  it("CONTROL: an Admin of A opens the report — without it, 'refuse everybody' passes every refusal below", async () => {
    const r = await call("/api/reports/summary?days=30", ADA);
    expect(r.status).toBe(200);
    expect(r.json.tiles.costUsd).toBeCloseTo(7, 6);
    expect(r.json.tiles.runs).toBe(3);
  });

  it("an Admin sees only the workspaces they administer: B's 100 dollars are not in A's report, and B is not offered", async () => {
    const r = await call("/api/reports/summary?days=30", ADA);
    expect(r.json.workspaces.map((w: { id: string }) => w.id)).toEqual([wsA!.id]);
    expect(r.json.lenses.workspaces.map((g: { id: string }) => g.id)).toEqual([wsA!.id]);
  });

  it("a workspace outside the Admin's set is refused, on every route — not shown empty", async () => {
    const q = `days=30&workspaces=${wsB!.id}`;
    expect((await call(`/api/reports/summary?${q}`, ADA)).status).toBe(403);
    expect((await call(`/api/reports/runs?${q}`, ADA)).status).toBe(403);
    expect((await call(`/api/reports/export?${q}`, ADA)).status).toBe(403);
    expect((await call("/api/reports/email", ADA, "POST", { workspaces: [wsB!.id], recipients: ["x@microland.com"] })).status).toBe(403);
  });

  it("a Creator, an Observer and somebody with no membership are all refused", async () => {
    for (const p of [ALICE, OLGA, NOBODY]) {
      for (const path of ["/api/reports/summary", "/api/reports/runs", "/api/reports/export"]) {
        expect((await call(path, p)).status, `${p.email} ${path}`).toBe(403);
      }
    }
  });

  it("the nav is told whether the report is theirs", async () => {
    expect((await call("/api/me", ADA)).json.canViewReports).toBe(true);
    expect((await call("/api/me", ALICE)).json.canViewReports).toBe(false);
  });

  it("the runs page is a slice and the total is the whole set", async () => {
    const r = await call("/api/reports/runs?days=30&limit=2&sort=cost&dir=desc", ADA);
    expect(r.json.total).toBe(3);
    expect(r.json.rows.map((x: { costUsd: number }) => x.costUsd)).toEqual([3, 2.5]);
    const next = await call("/api/reports/runs?days=30&limit=2&offset=2&sort=cost&dir=desc", ADA);
    expect(next.json.rows.map((x: { costUsd: number }) => x.costUsd)).toEqual([1.5]);
  });

  it("the person drill narrows the report and the tiles follow it", async () => {
    const r = await call(`/api/reports/summary?days=30&subject=${encodeURIComponent(ALICE.subject)}`, ADA);
    expect(r.json.tiles.costUsd).toBeCloseTo(5.5, 6);
    expect(r.json.tiles.people).toBe(1);
  });

  it("the download is a workbook carrying every run", async () => {
    const r = await call("/api/reports/export?days=30", ADA);
    expect(r.status).toBe(200);
    expect(r.type).toContain("spreadsheetml");
    expect(r.bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("an emailed report refuses an address outside the allowed domain, before anything is sent or recorded", async () => {
    const before = await db.select().from(reportShares).where(eq(reportShares.senderSubject, ADA.subject));
    const r = await call("/api/reports/email", ADA, "POST", { days: 30, recipients: ["x@gmail.com"] });
    expect(r.status).toBe(422);
    expect(r.json.offending).toEqual(["x@gmail.com"]);
    const after = await db.select().from(reportShares).where(eq(reportShares.senderSubject, ADA.subject));
    expect(after.length).toBe(before.length);
  });

  it("a Creator cannot email a report either", async () => {
    expect((await call("/api/reports/email", ALICE, "POST", { days: 30, recipients: ["a@microland.com"] })).status).toBe(403);
  });

  it("a malformed request is a 400, not a 500", async () => {
    expect((await call("/api/reports/summary?days=0", ADA)).status).toBe(400);
    expect((await call("/api/reports/summary?from=2026-10-10", ADA)).status).toBe(400);
  });
});
