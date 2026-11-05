// Sharing boundaries Q1: when an Admin opens somebody's private work, the OWNER is shown it — a stored notice, not
// only an audit line. Mocked services; no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const added = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../services/notification.service.js", () => ({
  notificationService: { add: async (n: Record<string, unknown>) => void added.push(n) },
}));
vi.mock("../services/audit.service.js", () => ({ auditService: { record: async () => {} } }));

const { noteAdminReads, chatRead } = await import("./content-guard.middleware.js");

const req = (subject: string) => ({ user: { subject, email: `${subject}@x.example` }, method: "GET" }) as never;
const settle = () => new Promise((r) => setTimeout(r, 20));
let n = 0;
/** A fresh item each time: the ten-minute window is per person per item, and would hide a repeat. */
const flowRead = (owner: string | null) => ({ entity: "flow" as const, id: `f${(n += 1)}`, label: "Payroll", owner, href: `/flows/f${n}` });

beforeEach(() => {
  added.length = 0;
});

describe("an Admin's look at private work is shown to its owner", () => {
  it("notifies the owner, naming who looked and linking to it", async () => {
    const r = flowRead("alice");
    noteAdminReads(req("boss"), "w", [r]);
    await settle();
    expect(added).toEqual([
      expect.objectContaining({ workspaceId: "w", subject: "alice", kind: "admin_viewed", href: r.href, body: expect.stringContaining("boss@x.example") }),
    ]);
  });

  it("does not notify anybody about their own thing, or about something nobody owns", async () => {
    noteAdminReads(req("alice"), "w", [flowRead("alice")]);
    noteAdminReads(req("boss"), "w", [flowRead(null)]);
    await settle();
    expect(added).toEqual([]);
  });

  it("one notice per person per item in the window — opening a workflow is a dozen requests, not a dozen notices", async () => {
    const r = flowRead("alice");
    for (let i = 0; i < 5; i += 1) noteAdminReads(req("boss"), "w", [r]);
    await settle();
    expect(added).toHaveLength(1);
  });

  it("a chat is the person who started it's, and opens where the client opens it", () => {
    expect(chatRead({ id: "c1", title: "T", createdBySubject: "alice", flowId: null })).toMatchObject({ owner: "alice", href: "/flows/new?chat=c1" });
    expect(chatRead({ id: "c1", title: "T", createdBySubject: "alice", flowId: "f9" })).toMatchObject({ href: "/flows/f9/builder" });
  });
});
