/**
 * A held message's attachments, opened one file at a time (2026-10-13, `email_held_files`).
 *
 * They used to be inline on the message and sent with the whole Email box list, so anything past 5 MB was dropped:
 * a test run's 23 MB report showed its name and nothing to open. Mounted exactly as `app.ts` mounts the router.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { vi } from "vitest";
import type { AddressInfo } from "node:net";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailSends, workspaces } from "../db/schema.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { contentVisibility } from "../services/content-visibility.service.js";

// These tests are about the Email box itself; who may see which message is `content-visibility`'s and has its own
// tests. The route is mounted with no person behind it, so it is given an Admin-level viewer (sees everything).
vi.spyOn(contentVisibility, "viewer").mockResolvedValue({ subject: null, all: true, reviewer: false });
import { emailBoxRouter } from "./email-box.js";
import { emailHeldFileRepo } from "../repositories/email-held-file.repo.js";

let base = "";
let server: ReturnType<express.Express["listen"]>;
const ws: string[] = [];
let held = "";
let delivered = "";
let legacy = "";
const BIG = Buffer.alloc(6 * 1024 * 1024, "a,b\n"); // past the old 5 MB hold limit
const CSV = "emp,status\nE1,Present\nE2,Leave\n";

beforeAll(async () => {
  const app = express();
  app.use("/api/workspaces/:workspaceId/email-box", emailBoxRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rows = await db.insert(workspaces).values([{ name: `held files A ${Date.now()}` }, { name: `held files B ${Date.now()}` }]).returning();
  ws.push(...rows.map((r) => r.id));
  const sends = await db
    .insert(emailSends)
    .values([
      { workspaceId: ws[0]!, recipients: ["a@x.example"], cc: [], subject: "held", outcome: "captured",
        attachments: [{ name: "big.csv", bytes: BIG.length }, { name: "small.csv", bytes: CSV.length }] },
      { workspaceId: ws[0]!, recipients: ["a@x.example"], cc: [], subject: "delivered", outcome: "sent",
        attachments: [{ name: "small.csv", bytes: CSV.length }] },
      { workspaceId: ws[0]!, recipients: ["a@x.example"], cc: [], subject: "held before 0098", outcome: "captured",
        attachments: [{ name: "old.csv", bytes: CSV.length }],
        capturedAttachments: [{ name: "old.csv", contentType: "text/csv", content: CSV, bytes: CSV.length }] },
    ])
    .returning();
  [held, delivered, legacy] = sends.map((s) => s.id) as [string, string, string];
  await emailHeldFileRepo.saveAll(ws[0]!, held, [
    { name: "big.csv", contentType: "text/csv", data: BIG },
    { name: "small.csv", contentType: "text/csv", data: Buffer.from(CSV) },
  ]);
});

afterAll(async () => {
  server?.close();
  if (ws.length) await db.delete(workspaces).where(inArray(workspaces.id, ws));
});

const url = (w: string, send: string, pos: number, q = "") => `${base}/api/workspaces/${w}/email-box/${send}/attachments/${pos}${q}`;

describe("a held attachment is a file, opened on its own", () => {
  it("the list says which files are held and carries no contents", async () => {
    const body = (await (await fetch(`${base}/api/workspaces/${ws[0]}/email-box`)).json()) as { foundry: Array<{ id: string; attachments: unknown[] }> };
    const m = body.foundry.find((x) => x.id === held)!;
    expect(m.attachments).toEqual([
      { name: "big.csv", bytes: BIG.length, position: 0, held: true, contentType: "text/csv" },
      { name: "small.csv", bytes: CSV.length, position: 1, held: true, contentType: "text/csv" },
    ]);
    expect(JSON.stringify(body)).not.toContain("E1,Present");
  });

  it("downloads a file past the old 5 MB limit, whole", async () => {
    const res = await fetch(url(ws[0]!, held, 0));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename\*=UTF-8''big\.csv/);
    expect(Buffer.from(await res.arrayBuffer()).equals(BIG)).toBe(true);
  });

  it("previews a sheet as a table, and shows a CSV inline", async () => {
    const p = (await (await fetch(url(ws[0]!, held, 1, "?preview=1"))).json()) as { preview: { kind: string; sheets: Array<{ rows: string[][] }> } };
    expect(p.preview.kind).toBe("table");
    expect(p.preview.sheets[0]!.rows[1]).toEqual(["E1", "Present"]);
    expect((await fetch(url(ws[0]!, held, 1, "?inline=1"))).headers.get("content-disposition")).toMatch(/^inline/);
  });

  it("a message held before 0098 still opens from its inline copy", async () => {
    const res = await fetch(url(ws[0]!, legacy, 0));
    expect(await res.text()).toBe(CSV);
  });

  it("refuses another workspace, a delivered message and a position that is not there — saying which", async () => {
    expect((await fetch(url(ws[1]!, held, 0))).status).toBe(404);
    const d = await fetch(url(ws[0]!, delivered, 0));
    expect(d.status).toBe(404);
    expect(((await d.json()) as { error: string }).error).toMatch(/Only a held message keeps its files/);
    expect((await fetch(url(ws[0]!, held, 5))).status).toBe(404);
  });
});
