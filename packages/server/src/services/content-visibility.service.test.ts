// Pure rules of `content-visibility.service.ts` — no database. The wire test covers routes against a real one.
import { describe, expect, it, vi } from "vitest";

vi.mock("./effective-permissions.service.js", () => ({ effectivePermissionsService: {} }));

const { contentVisibility } = await import("./content-visibility.service.js");

const owner = { subject: "owner", all: false, reviewer: false, write: true };
const member = { subject: "member", all: false, reviewer: false, write: true };
const admin = { subject: "admin", all: true, reviewer: false, write: true };
const reviewer = { subject: "rev", all: false, reviewer: true, write: true };
const f = { armedRevision: null, reviewRequestedRevision: null, othersMayEdit: false };
const priv = { ...f, ownerSubject: "owner", visibility: "private" };
const pub = { ...f, ownerSubject: "owner", visibility: "public" };

describe("flowCopyableToWorkspace — copying a workflow into a template every member sees", () => {
  it("lets the owner copy their own private workflow", () => {
    expect(contentVisibility.flowCopyableToWorkspace(owner, priv)).toBe(true);
  });

  it("refuses an Admin or a Reviewer who can SEE somebody else's private workflow", () => {
    const asked = { ...priv, reviewRequestedRevision: 1 };
    expect(contentVisibility.flowVisible(admin, priv)).toBe(true); // control: they can see it
    expect(contentVisibility.flowCopyableToWorkspace(admin, priv)).toBe(false);
    expect(contentVisibility.flowVisible(reviewer, asked)).toBe(true);
    expect(contentVisibility.flowCopyableToWorkspace(reviewer, asked)).toBe(false);
  });

  it("refuses a member who cannot see it", () => {
    expect(contentVisibility.flowCopyableToWorkspace(member, priv)).toBe(false);
  });

  it("lets any member copy a public workflow, but not an identity naming nobody", () => {
    expect(contentVisibility.flowCopyableToWorkspace(member, pub)).toBe(true);
    expect(contentVisibility.flowCopyableToWorkspace({ ...member, subject: null }, priv)).toBe(false);
  });

  it("treats an unknown visibility as private", () => {
    expect(contentVisibility.flowCopyableToWorkspace(member, { ...f, ownerSubject: "owner", visibility: "shared?" })).toBe(false);
  });
});

describe("flowsWhere / runsWhere — the list form of the same rules", () => {
  it("narrows a member AND a Reviewer, and leaves only an Admin unfiltered", () => {
    expect(contentVisibility.flowsWhere(member)).toBeDefined();
    expect(contentVisibility.flowsWhere(reviewer)).toBeDefined();
    expect(contentVisibility.runsWhere(reviewer)).toBeDefined();
    expect(contentVisibility.flowsWhere(admin)).toBeUndefined();
  });
});
