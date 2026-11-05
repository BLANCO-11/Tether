// A leaver's workflows become the Admins' (sharing-boundaries phase 1). Mocked repositories; no database.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  flows: [] as Array<Record<string, unknown>>,
  approvals: {} as Record<string, { selfEnabled: boolean }>,
  setOwner: [] as Array<[string, string | null]>,
  revoked: [] as string[],
}));
vi.mock("../repositories/flow.repo.js", () => ({
  flowRepo: {
    listByWorkspace: async () => m.flows,
    setOwner: async (_w: string, id: string, s: string | null) => void m.setOwner.push([id, s]),
    currentApproval: async (id: string) => m.approvals[id],
  },
}));
vi.mock("./flow-approval.service.js", () => ({
  flowApprovalService: { revoke: async (_w: string, id: string) => void m.revoked.push(id) },
}));
vi.mock("./audit.service.js", () => ({ auditService: { record: async () => {} } }));

const { releaseOwnedBy } = await import("./flow-ownership.service.js");

beforeEach(() => {
  m.flows = [
    { id: "mine-private", name: "A", ownerSubject: "leaver", armedRevision: null },
    { id: "mine-self-on", name: "B", ownerSubject: "leaver", armedRevision: 2 },
    { id: "mine-reviewed", name: "C", ownerSubject: "leaver", armedRevision: 1 },
    { id: "someone-else", name: "D", ownerSubject: "stayer", armedRevision: 1 },
  ];
  m.approvals = { "mine-self-on": { selfEnabled: true }, "mine-reviewed": { selfEnabled: false }, "someone-else": { selfEnabled: true } };
  m.setOwner = [];
  m.revoked = [];
});

describe("releaseOwnedBy — when an owner leaves", () => {
  it("every workflow they owned becomes ownerless (the Admins'), and nobody else's is touched", async () => {
    expect(await releaseOwnedBy("w", "leaver", "admin@x")).toBe(3);
    expect(m.setOwner).toEqual([["mine-private", null], ["mine-self-on", null], ["mine-reviewed", null]]);
  });

  it("⚠ one they switched on themselves is turned off; one a reviewer approved keeps running", async () => {
    await releaseOwnedBy("w", "leaver", "admin@x");
    expect(m.revoked).toEqual(["mine-self-on"]);
  });

  it("someone who owns nothing releases nothing", async () => {
    expect(await releaseOwnedBy("w", "nobody", "admin@x")).toBe(0);
    expect(m.setOwner).toEqual([]);
  });
});
