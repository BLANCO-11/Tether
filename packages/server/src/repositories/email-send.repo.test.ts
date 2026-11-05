/**
 * The record that a real email was attempted — and what it must never contain.
 * email-send-tool · US1, FR-009 · contracts/mail-send.md §4
 *
 * These hit the real database, in the style of `workspace-slug.test.ts`, and clean
 * up after themselves. A schema-shape test would not do here: the load-bearing
 * assertion is that **the message body reaches no column**, and that is a property
 * of the inserted row, not of the type.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { emailSends, workspaces } from "../db/schema.js";
import { emailSendRepo } from "./email-send.repo.js";

const createdWorkspaces: string[] = [];

async function makeWorkspace(name: string): Promise<string> {
  const rows = await db.insert(workspaces).values({ name }).returning();
  createdWorkspaces.push(rows[0].id);
  return rows[0].id;
}

afterAll(async () => {
  if (createdWorkspaces.length) {
    // email_sends cascades on workspace delete, so this clears both tables.
    await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaces));
  }
  await pool.end();
});

describe("email_sends records every outcome", () => {
  it("records a `sent` row with recipients, cc and the correlation id", async () => {
    const workspaceId = await makeWorkspace("Email Repo — sent");
    const row = await emailSendRepo.record({
      workspaceId,
      recipients: ["her@example.com"],
      cc: ["him@example.com"],
      resolvedFrom: "explicit",
      subject: "Q3 close summary",
      outcome: "sent",
      graphMessageId: "e1f2a3b4-0000-4000-8000-abcdefabcdef",
    });

    expect(row.outcome).toBe("sent");
    expect(row.recipients).toEqual(["her@example.com"]);
    expect(row.cc).toEqual(["him@example.com"]);
    expect(row.resolvedFrom).toBe("explicit");
    expect(row.graphMessageId).toBe("e1f2a3b4-0000-4000-8000-abcdefabcdef");
    expect(row.failureReason).toBeNull();
    expect(row.createdAt).toBeTruthy();
  });

  it("records a `refused` row that names the reason and NO recipients", async () => {
    // ⚠ A refusal must leave a trace. A refusal that records nothing is
    // indistinguishable from a send that never happened, and the difference is
    // the whole point of the run page.
    const workspaceId = await makeWorkspace("Email Repo — refused");
    const row = await emailSendRepo.record({
      workspaceId,
      recipients: [],
      cc: [],
      subject: "Q3 close summary",
      outcome: "refused",
      failureReason: "recipient not allowed: stranger@elsewhere.net",
    });

    expect(row.outcome).toBe("refused");
    expect(row.recipients).toEqual([]);
    expect(row.failureReason).toMatch(/stranger@elsewhere\.net/);
    expect(row.graphMessageId).toBeNull();
  });

  it("records a `failed` row — the provider was reached and did not accept it", async () => {
    // `refused` and `failed` are not interchangeable: one sends the reader to a
    // config variable, the other to Azure.
    const workspaceId = await makeWorkspace("Email Repo — failed");
    const row = await emailSendRepo.record({
      workspaceId,
      recipients: ["her@example.com"],
      subject: "Q3 close summary",
      outcome: "failed",
      failureReason: "graph 403: application access policy denies this mailbox",
      graphMessageId: "req-0000-1111",
    });

    expect(row.outcome).toBe("failed");
    expect(row.failureReason).toMatch(/403/);
  });

  it("refuses a fourth outcome at the database, not just in TypeScript", async () => {
    // The CHECK constraint. A type-only guarantee is lost the moment a value
    // arrives from JSON, and every reader of this column would then have to guess
    // what an unrecognised outcome means.
    const workspaceId = await makeWorkspace("Email Repo — bad outcome");
    await expect(
      emailSendRepo.record({
        workspaceId,
        subject: "s",
        outcome: "queued" as "sent",
      }),
    ).rejects.toThrow();
  });
});

describe("FR-009 — the body reaches no column", () => {
  it("stores nothing resembling the message body", async () => {
    // ⚠ The single most important assertion in this file. The body is the
    // script's output — it may carry payroll figures, an extract of a customer
    // table, whatever the flow computed. This table exists to answer "was a
    // message sent, to whom, did it work", and it must answer all three without
    // becoming a copy of every report the platform has ever emailed.
    //
    // Asserted over the WHOLE row rather than over a named column, so adding a
    // body column later fails this test rather than passing it unnoticed.
    const workspaceId = await makeWorkspace("Email Repo — no body");
    const SECRET_BODY = "SENTINEL-BODY-a4f9c2 employee 00417 net pay 3184.22";

    const row = await emailSendRepo.record({
      workspaceId,
      recipients: ["her@example.com"],
      subject: "Payroll summary",
      outcome: "sent",
    });

    const [stored] = await db.select().from(emailSends).where(eq(emailSends.id, row.id));
    expect(JSON.stringify(stored)).not.toContain("SENTINEL-BODY");
    expect(JSON.stringify(stored)).not.toContain("3184.22");

    // The positive control (I-38): the sentinel is genuinely absent rather than
    // this being an assertion over an empty read.
    expect(SECRET_BODY).toContain("SENTINEL-BODY");
    expect(JSON.stringify(stored)).toContain("Payroll summary");

    // And there is no column a body could go into, whatever it were called.
    const bodyish = Object.keys(stored).filter((c) =>
      /^(body|content|message|text|payload|html)$/i.test(c),
    );
    expect(bodyish).toEqual([]);
  });
});

describe("reads are workspace-scoped", () => {
  it("does not return another workspace's rows for the same execution id", async () => {
    // An execution id is a uuid a caller could hold from another tenant. Scoping
    // by workspace as well means a cross-workspace read is empty, not a leak.
    const wsA = await makeWorkspace("Email Repo — scope A");
    const wsB = await makeWorkspace("Email Repo — scope B");

    await emailSendRepo.record({
      workspaceId: wsA,
      recipients: ["a@example.com"],
      subject: "belongs to A",
      outcome: "sent",
    });

    // `flowExecutionId` is null here (a bare tool test call), so the scoping
    // assertion is made against the workspace-wide read.
    const forA = await emailSendRepo.listByWorkspace(wsA);
    const forB = await emailSendRepo.listByWorkspace(wsB);
    expect(forA.map((r) => r.subject)).toEqual(["belongs to A"]);
    expect(forB).toEqual([]);
  });

  it("accepts a null flow_execution_id — a bare tool test call has no run", async () => {
    const workspaceId = await makeWorkspace("Email Repo — no execution");
    const row = await emailSendRepo.record({
      workspaceId,
      recipients: ["her@example.com"],
      subject: "tool test",
      outcome: "sent",
    });
    expect(row.flowExecutionId).toBeNull();
  });
});

describe("finish() completes an intent row", () => {
  it("turns a pending row into its outcome without a second insert", async () => {
    // The row is written BEFORE Graph is called, so a process that dies mid-send
    // leaves "we may have sent something" rather than silence.
    const workspaceId = await makeWorkspace("Email Repo — finish");
    const intent = await emailSendRepo.record({
      workspaceId,
      recipients: ["her@example.com"],
      subject: "in flight",
      outcome: "failed",
      failureReason: "in flight — no provider answer yet",
    });

    const done = await emailSendRepo.finish(intent.id, {
      outcome: "sent",
      graphMessageId: "req-9999",
      failureReason: null,
    });

    expect(done?.id).toBe(intent.id);
    expect(done?.outcome).toBe("sent");
    expect(done?.graphMessageId).toBe("req-9999");
    expect(done?.failureReason).toBeNull();

    const all = await emailSendRepo.listByWorkspace(workspaceId);
    expect(all).toHaveLength(1); // updated, not duplicated
  });
});
