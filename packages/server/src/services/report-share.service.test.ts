import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("./mail.service.js", () => ({ mailService: { send: (...a: unknown[]) => send(...a) } }));

const inserted: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
vi.mock("../db/index.js", () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => (inserted.push(v), { returning: async () => [{ id: "share-1" }] }) }),
    update: () => ({ set: (v: Record<string, unknown>) => (updates.push(v), { where: async () => undefined }) }),
  },
}));

const { checkRecipients, reportShareService } = await import("./report-share.service.js");
const { windowOf } = await import("./report.service.js");

const DOMAINS = ["microland.com"];

describe("who a report may be emailed to", () => {
  it("accepts company addresses, lowercased and de-duplicated", () => {
    expect(checkRecipients(["A@Microland.com", "a@microland.com", " b@microland.com "], DOMAINS)).toEqual({
      ok: true,
      to: ["a@microland.com", "b@microland.com"],
    });
  });

  it("refuses an address outside the allowed domain and names it", () => {
    const r = checkRecipients(["a@microland.com", "x@gmail.com"], DOMAINS);
    expect(r).toMatchObject({ ok: false, offending: ["x@gmail.com"] });
  });

  it("a look-alike domain is not the domain", () => {
    expect(checkRecipients(["a@microland.com.evil.example"], DOMAINS).ok).toBe(false);
    expect(checkRecipients(["a@evilmicroland.com"], DOMAINS).ok).toBe(false);
    expect(checkRecipients(["a@mail.microland.com"], DOMAINS).ok).toBe(false);
  });

  it("refuses nothing-to-send-to and malformed addresses", () => {
    expect(checkRecipients([], DOMAINS).ok).toBe(false);
    expect(checkRecipients(["not-an-address"], DOMAINS)).toMatchObject({ ok: false, offending: ["not-an-address"] });
  });

  it("no configured domain means nobody may receive it", () => {
    expect(checkRecipients(["a@microland.com"], []).ok).toBe(false);
  });
});

const input = {
  sender: { subject: "s1", email: "ada@microland.com", name: "Ada" },
  to: ["person.a@microland.com"],
  runs: [
    {
      key: "a", workspaceId: "w1", workspaceName: "Finance", flowId: "f1", flowName: "Invoice chase", subject: "s1", person: "Priya",
      purpose: "live" as const, status: "succeeded", at: "2026-10-20T10:00:00.000Z", tokensIn: 1, tokensOut: 1, tokens: 2, costUsd: 1.5,
    },
  ],
  window: windowOf({ from: "2026-10-19", to: "2026-10-25" }),
  workspaces: [{ id: "w1", name: "Finance" }],
  filterWords: [],
  filters: {},
};

describe("sending a report", () => {
  beforeEach(() => {
    send.mockReset();
    inserted.length = 0;
    updates.length = 0;
  });

  it("records the attempt BEFORE it sends, attaches the workbook, and marks it sent", async () => {
    send.mockImplementation(async () => {
      expect(inserted.length).toBe(1); // the intent row already exists when the transport is called
      expect(inserted[0]).toMatchObject({ outcome: "failed", recipients: ["person.a@microland.com"], workspaceNames: ["Finance"] });
      return { ok: true, messageId: "m1", requestId: null };
    });
    const r = await reportShareService.send(input);
    expect(r).toMatchObject({ ok: true, recipients: ["person.a@microland.com"] });
    const msg = send.mock.calls[0][0] as { attachments: Array<{ name: string; data: Buffer }>; to: string[]; body: string };
    expect(msg.to).toEqual(["person.a@microland.com"]);
    expect(msg.attachments[0].name).toMatch(/^cost-report_finance_.*\.xlsx$/);
    expect(msg.attachments[0].data.subarray(0, 2).toString()).toBe("PK"); // an xlsx is a zip
    expect(msg.body).not.toMatch(/https?:\/\//); // a snapshot: nothing links back into the product
    expect(updates.at(-1)).toMatchObject({ outcome: "sent" });
  });

  it("an address outside the domain never reaches the transport or the record", async () => {
    const r = await reportShareService.send({ ...input, to: ["x@gmail.com"] });
    expect(r).toMatchObject({ ok: false, status: 422, offending: ["x@gmail.com"] });
    expect(send).not.toHaveBeenCalled();
    expect(inserted.length).toBe(0);
  });

  it("a provider failure is recorded as failed and reported, not swallowed", async () => {
    send.mockResolvedValue({ ok: false, status: 502, message: "graph said no", detail: {} });
    const r = await reportShareService.send(input);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(updates.at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("an empty selection is not sent", async () => {
    const r = await reportShareService.send({ ...input, runs: [] });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(send).not.toHaveBeenCalled();
  });
});
