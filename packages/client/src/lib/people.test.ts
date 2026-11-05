import { describe, expect, it } from "vitest";
import { expiresLabel, invitationMatches, lastSeenLabel, personMatches } from "./people";
import type { FAInvitation, FAPerson } from "./foundry-client";

const person = (workspaces: { id: string; role: string | null }[], extra: Partial<FAPerson> = {}): FAPerson => ({
  subject: "s",
  email: "priya@x.example",
  name: "Priya Shah",
  signIn: "microsoft",
  lastSeenAt: null,
  superAdmin: false,
  platformRoles: [],
  workspaces: workspaces.map((w) => ({ ...w, name: w.id, reach: "own", via: [] })),
  localAccount: null,
  ...extra,
});

describe("personMatches", () => {
  const p = person([
    { id: "fin", role: "admin" },
    { id: "hr", role: "author" },
  ]);
  it("searches name and email", () => {
    expect(personMatches(p, { q: "shah", workspaceId: "", role: "" })).toBe(true);
    expect(personMatches(p, { q: "PRIYA@", workspaceId: "", role: "" })).toBe(true);
    expect(personMatches(p, { q: "ravi", workspaceId: "", role: "" })).toBe(false);
  });
  it("workspace and role must hold in the SAME workspace", () => {
    expect(personMatches(p, { q: "", workspaceId: "fin", role: "admin" })).toBe(true);
    // Admin somewhere and in HR, but not admin IN HR: must not match.
    expect(personMatches(p, { q: "", workspaceId: "hr", role: "admin" })).toBe(false);
    expect(personMatches(p, { q: "", workspaceId: "", role: "author" })).toBe(true);
  });
});

describe("invitationMatches", () => {
  const i = { email: "sam@x.example", workspaces: [{ workspaceId: "fin", workspaceName: "Finance", role: "author" }] } as FAInvitation;
  it("filters like a person", () => {
    expect(invitationMatches(i, { q: "sam", workspaceId: "fin", role: "author" })).toBe(true);
    expect(invitationMatches(i, { q: "", workspaceId: "fin", role: "admin" })).toBe(false);
  });
});

describe("labels", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  it("says when an invitation expires, in days", () => {
    expect(expiresLabel({ expired: false, expiresAt: "2026-11-27T12:00:00Z" }, now)).toBe("Expires in 28 days");
    expect(expiresLabel({ expired: false, expiresAt: "2026-10-31T13:00:00Z" }, now)).toBe("Expires in 1 day");
    expect(expiresLabel({ expired: false, expiresAt: "2026-10-30T20:00:00Z" }, now)).toBe("Expires today");
    expect(expiresLabel({ expired: true, expiresAt: "2026-10-01T00:00:00Z" }, now)).toBe("Expired");
  });
  it("says when somebody was last seen, and never blank", () => {
    expect(lastSeenLabel(null, now)).toBe("Not signed in yet");
    expect(lastSeenLabel("2026-10-30T08:00:00Z", now)).toBe("Today");
    expect(lastSeenLabel("2026-10-29T08:00:00Z", now)).toBe("Yesterday");
    expect(lastSeenLabel("2026-10-27T08:00:00Z", now)).toBe("3 days ago");
  });
});
