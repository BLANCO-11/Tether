import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformUsers, projectFiles, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { projectService } from "../services/project.service.js";
import { projectFileService } from "../services/project-file.service.js";
import { projectLines } from "../pi-builder/service.js";
import { config } from "../config/index.js";

/**
 * A project's files (0132), through the REAL app — permission guard, routes, SQL:
 *
 *   - its members see, add and download them; anybody outside the project gets NOT FOUND, never a 403;
 *   - removing one is whoever added it, the project's owner, or an Admin;
 *   - removing a member takes the files from them at once; deleting the project deletes its files;
 *   - a chat in the project is told the files' names.
 */
const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const stamp = Date.now().toString(36);
const person = (n: string) => ({ subject: `oid-pf-${n}-${stamp}`, email: `${n}-${stamp}@acme-hr.example` });
const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");
const ADA = person("ada");
// Never makes a request, so their sign-in record keeps the name given here (each request re-records it from the token).
const EVE = person("eve");

const ws = await workspaceRepo.create({ name: `project files ${stamp}`, tenantSlug: "pfwire", slug: `pfwire-${stamp}` });
let project = "";

type Who = { subject: string; email: string };
const identity = (who: Who) =>
  new SignJWT({ sub: who.subject, email: who.email, name: who.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(config.identity.secret));

async function call(path: string, as: Who, method = "GET", body?: unknown) {
  const res = await fetch(`${base}/api/workspaces/${ws!.id}${path}`, {
    method,
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed };
}
async function upload(as: Who, name: string, content: string) {
  const res = await fetch(`${base}/api/workspaces/${ws!.id}/projects/${project}/files`, {
    method: "POST",
    headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(as), "x-file-name": encodeURIComponent(name), "content-type": "application/octet-stream" },
    body: content,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { file?: { id: string; name: string; canRemove: boolean } } };
}
const names = async (as: Who) => (((await call(`/projects/${project}/files`, as)).body.files as Array<{ name: string }>) ?? []).map((f) => f.name);

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, ...ALICE, role: "author", grantedBy: "test" },
    { workspaceId: ws!.id, ...BOB, role: "author", grantedBy: "test" },
    { workspaceId: ws!.id, ...CAROL, role: "author", grantedBy: "test" },
    { workspaceId: ws!.id, ...ADA, role: "admin", grantedBy: "test" },
    { workspaceId: ws!.id, ...EVE, role: "author", grantedBy: "test" },
  ]);
  // Eve has a sign-in record with a name; Alice is named only by what her membership and requests record.
  await db.insert(platformUsers).values({ subject: EVE.subject, email: EVE.email, name: "Eve Rao" });
  const made = await call("/projects", ALICE, "POST", { name: `files ${stamp}` });
  project = (made.body.project as { id: string }).id;
  expect((await call(`/projects/${project}/members`, ALICE, "POST", { subject: BOB.subject })).status).toBe(201);
});

afterAll(async () => {
  await db.delete(platformUsers).where(eq(platformUsers.subject, EVE.subject));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
  server?.close();
});

describe("a project's files", () => {
  let alices = "";
  let bobs = "";

  it("a member adds one; the other member lists and downloads it", async () => {
    const a = await upload(ALICE, "Project brief.txt", "the brief");
    expect(a.status).toBe(201);
    alices = a.body.file!.id;
    expect(await names(BOB)).toEqual(["Project brief.txt"]);
    const res = await fetch(`${base}/api/workspaces/${ws!.id}/projects/${project}/files/${alices}/content`, {
      headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": await identity(BOB) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the brief");
  });

  it("somebody outside the project gets NOT FOUND for the list, an upload and a download", async () => {
    expect((await call(`/projects/${project}/files`, CAROL)).status).toBe(404);
    expect((await upload(CAROL, "x.txt", "x")).status).toBe(404);
    expect((await call(`/projects/${project}/files/${alices}/content`, CAROL)).status).toBe(404);
    // CONTROL: an Admin outside the project sees them.
    expect(await names(ADA)).toEqual(["Project brief.txt"]);
  });

  it("refuses a taken name and a type that cannot be stored", async () => {
    expect((await upload(BOB, "Project brief.txt", "again")).status).toBe(409);
    expect((await upload(BOB, "slides.pptx", "x")).status).toBe(415);
  });

  it("removing is whoever added it, the owner, or an Admin — not another member", async () => {
    const b = await upload(BOB, "Notes.txt", "bob's notes");
    bobs = b.body.file!.id;
    const asBob = (await call(`/projects/${project}/files`, BOB)).body.files as Array<{ id: string; canRemove: boolean }>;
    expect(asBob.find((f) => f.id === alices)!.canRemove).toBe(false);
    expect(asBob.find((f) => f.id === bobs)!.canRemove).toBe(true);
    expect((await call(`/projects/${project}/files/${alices}`, BOB, "DELETE")).status).toBe(403);
    expect((await call(`/projects/${project}/files/${bobs}`, ALICE, "DELETE")).status).toBe(204);
    expect(await names(ALICE)).toEqual(["Project brief.txt"]);
  });

  it("people are named by their sign-in name, else their email — never by their sign-in id", async () => {
    expect((await call(`/projects/${project}/members`, ALICE, "POST", { subject: EVE.subject })).status).toBe(201);
    const p = (await call(`/projects/${project}`, ALICE)).body.project as { members: Array<{ subject: string; name: string }> };
    expect(p.members.find((m) => m.subject === EVE.subject)!.name).toBe("Eve Rao");
    expect(p.members.find((m) => m.subject === ALICE.subject)!.name).toBe(ALICE.email);
  });

  it("a chat in the project is told the files' names, and can open them — only from its own project", async () => {
    const ctx = await projectService.contextOf(ws!.id, project);
    expect(ctx?.files).toEqual(["Project brief.txt"]);
    expect(projectLines(ctx).join("\n")).toContain('open-file.mjs --project "<name>"');
    expect(projectLines(ctx).join("\n")).toContain('"Project brief.txt"');
    expect((await projectFileService.readForChat(ws!.id, project, "Project brief.txt"))?.data.toString()).toBe("the brief");
    // Another project's id, or another workspace's, opens nothing.
    expect(await projectFileService.readForChat(ws!.id, "00000000-0000-0000-0000-000000000000", "Project brief.txt")).toBeNull();
    expect(await projectFileService.readForChat("00000000-0000-0000-0000-000000000000", project, "Project brief.txt")).toBeNull();
  });

  it("removing a member takes the files from them at once", async () => {
    expect((await call(`/projects/${project}/members/${encodeURIComponent(BOB.subject)}`, ALICE, "DELETE")).status).toBe(200);
    expect((await call(`/projects/${project}/files`, BOB)).status).toBe(404);
  });

  it("deleting the project deletes its files", async () => {
    expect((await call(`/projects/${project}`, ALICE, "DELETE")).status).toBe(200);
    expect(await db.select().from(projectFiles).where(eq(projectFiles.projectId, project))).toEqual([]);
  });
});
