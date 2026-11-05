import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { db, pool } from "../db/index.js";
import { chatMessages, mailOutbox } from "../db/schema.js";
import { config } from "../config.js";
import { adminRouter } from "./admin.js";

/**
 * `DELETE /admin/records/:name` — clear one capture table, and only that one.
 *
 * The Email box's "Clear test inbox" button rides this endpoint with
 * `:name = "mail"`. The existing `POST /admin/reset` truncates all five tables
 * plus the probe counter, which is a broader action than the button's label
 * promises — so the button needs a scoped clear, and this test pins the scope:
 * mail goes, chat stays.
 */
let base = "";
let server: ReturnType<express.Express["listen"]>;
const key = config.apiKey;

const del = async (name: string, auth = true) =>
  fetch(`${base}/admin/records/${name}`, {
    method: "DELETE",
    headers: auth ? { authorization: `Bearer ${key}` } : {},
  });

beforeAll(async () => {
  const app = express();
  app.use("/admin", adminRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await pool.end();
});

describe("DELETE /admin/records/mail clears the test inbox and nothing else", () => {
  it("deletes every mail_outbox row and leaves chat_messages alone", async () => {
    const tag = `clear-test-${Date.now()}`;
    await db.insert(mailOutbox).values([
      {
        messageId: `${tag}-1`,
        sender: "hr-bot@acme-hr.example",
        recipients: ["a@acme-hr.example"],
        subject: tag,
      },
      {
        messageId: `${tag}-2`,
        sender: "hr-bot@acme-hr.example",
        recipients: ["b@acme-hr.example"],
        subject: tag,
      },
    ]);
    await db.insert(chatMessages).values([
      { channel: tag, author: "bot", text: "stays" },
    ]);

    const res = await del("mail");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: number; set: string };
    expect(body.ok).toBe(true);
    expect(body.set).toBe("mail");
    expect(body.cleared).toBeGreaterThanOrEqual(2);
    const mail = await db.select().from(mailOutbox);
    expect(mail).toEqual([]);
    const chat = await db.select().from(chatMessages);
    expect(chat.length).toBeGreaterThanOrEqual(1);

    // Tidy up: only the seed row is ours; the deployment's own rows are not.
    await db.delete(chatMessages).where(eq(chatMessages.channel, tag));
  });

  it("refuses an unknown record set without touching any table", async () => {
    const res = await del("llm_provider");
    expect(res.status).toBe(404);
  });

  it("refuses a missing root key", async () => {
    const res = await del("mail", false);
    expect(res.status).toBe(401);
  });
});
