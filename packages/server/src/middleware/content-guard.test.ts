import { describe, expect, it } from "vitest";
import { mountedRoutes } from "../auth/route-stack.js";
import { contentParams } from "./content-guard.middleware.js";
import { contentVisibility, type Viewer } from "../services/content-visibility.service.js";

/**
 * rbac-observability (2026-10-15): PRIVATE work is its owner's (and an Admin's); PUBLISHED work is everybody's.
 * The rules are pure functions, asserted here directly, and the content guard must reach every route that names a
 * piece of content — asserted by walking the real app, so a new `:flowId` route cannot ship unguarded.
 */
const { createApp } = await import("../app.js");
const routes = mountedRoutes(createApp());

const me: Viewer = { subject: "me", all: false, reviewer: false };
const admin: Viewer = { subject: "boss", all: true, reviewer: false };
const reviewer: Viewer = { subject: "rev", all: false, reviewer: true };
const nobody: Viewer = { subject: null, all: false, reviewer: false };

const f = { armedRevision: null, reviewRequestedRevision: null, othersMayEdit: false };
const myDraft = { ...f, ownerSubject: "me", visibility: "private" };
const theirDraft = { ...f, ownerSubject: "them", visibility: "private" };
const theirPublished = { ...f, ownerSubject: "them", visibility: "public" };
const ownerless = { ...f, ownerSubject: null, visibility: "private" };
// Put in front of a reviewer: its owner asked for approval, or it is live (sharing-boundaries 2026-10-30).
const theirAsked = { ...theirDraft, reviewRequestedRevision: 2 };
const theirLive = { ...theirDraft, armedRevision: 1 };

describe("automations: drafts are private, published ones are everybody's", () => {
  it("a person sees their own draft and every published automation, and not somebody else's draft", () => {
    expect(contentVisibility.flowVisible(me, myDraft)).toBe(true);
    expect(contentVisibility.flowVisible(me, theirPublished)).toBe(true);
    expect(contentVisibility.flowVisible(me, theirDraft)).toBe(false);
    expect(contentVisibility.flowVisible(me, ownerless)).toBe(false);
  });

  it("an Admin sees every automation", () => {
    for (const x of [myDraft, theirDraft, theirPublished, ownerless, theirAsked, theirLive]) expect(contentVisibility.flowVisible(admin, x)).toBe(true);
  });

  it("⚠ a Reviewer sees what was put in front of them — public, asked for approval, or live — and not a private draft", () => {
    for (const x of [theirPublished, theirAsked, theirLive]) expect(contentVisibility.flowVisible(reviewer, x)).toBe(true);
    for (const x of [theirDraft, ownerless]) expect(contentVisibility.flowVisible(reviewer, x)).toBe(false);
    // a member is NOT let in by the same facts: asking for approval is for reviewers
    expect(contentVisibility.flowVisible(me, theirAsked)).toBe(false);
    expect(contentVisibility.flowVisible(me, theirLive)).toBe(false);
  });

  it("only the owner or an Admin may change one — a Reviewer approves, it does not edit", () => {
    expect(contentVisibility.flowChangeable(me, myDraft)).toBe(true);
    expect(contentVisibility.flowChangeable(me, theirPublished)).toBe(false);
    expect(contentVisibility.flowChangeable(admin, theirDraft)).toBe(true);
    expect(contentVisibility.flowChangeable(reviewer, theirDraft)).toBe(false);
  });

  it("an identity that names nobody sees only what is published", () => {
    expect(contentVisibility.flowVisible(nobody, ownerless)).toBe(false);
    expect(contentVisibility.flowVisible(nobody, theirPublished)).toBe(true);
  });
});

describe("⚠ editing vs managing a SHARED workflow (sharing-boundaries phase 2)", () => {
  const editable = { ...theirPublished, othersMayEdit: true };
  const viewOnly = { ...theirPublished, othersMayEdit: false };
  const observer: Viewer = { subject: "obs", all: false, reviewer: false, write: false };
  const builder: Viewer = { ...me, write: true };
  it("a member who may build edits a shared, editable workflow — and manages nothing of it", () => {
    expect(contentVisibility.flowChangeable(builder, editable)).toBe(true);
    expect(contentVisibility.flowManageable(builder, editable)).toBe(false);
  });
  it("view-only means only its owner and Admins edit it", () => {
    expect(contentVisibility.flowChangeable(builder, viewOnly)).toBe(false);
    expect(contentVisibility.flowChangeable({ ...builder, subject: "them" }, viewOnly)).toBe(true);
    expect(contentVisibility.flowChangeable(admin, viewOnly)).toBe(true);
  });
  it("an Observer never edits, and a PRIVATE workflow is not editable by others whatever the setting says", () => {
    expect(contentVisibility.flowChangeable(observer, editable)).toBe(false);
    expect(contentVisibility.flowChangeable(builder, { ...theirDraft, othersMayEdit: true })).toBe(false);
  });
  it("its owner and an Admin manage it", () => {
    expect(contentVisibility.flowManageable({ ...builder, subject: "them" }, editable)).toBe(true);
    expect(contentVisibility.flowManageable(admin, editable)).toBe(true);
    expect(contentVisibility.flowManageable(reviewer, editable)).toBe(false);
  });
});

describe("runs follow their automation, and a test run stays private", () => {
  const live = { requestedBySubject: "them", kestraNamespace: "foundry.t.ws" };
  const test = { requestedBySubject: "them", kestraNamespace: "foundry.t.ws.draft" };

  it("a live run of a published automation is everybody's; its test run is not", () => {
    expect(contentVisibility.runVisible(me, live, theirPublished)).toBe(true);
    expect(contentVisibility.runVisible(me, test, theirPublished)).toBe(false);
  });

  it("a run of somebody else's draft is theirs; a run I started is mine", () => {
    expect(contentVisibility.runVisible(me, live, theirDraft)).toBe(false);
    expect(contentVisibility.runVisible(me, { ...test, requestedBySubject: "me" }, theirDraft)).toBe(true);
    expect(contentVisibility.runVisible(me, test, myDraft)).toBe(true);
  });

  it("a run whose automation is gone is visible only to whoever started it, or an Admin", () => {
    expect(contentVisibility.runVisible(me, live, null)).toBe(false);
    expect(contentVisibility.runVisible(admin, live, null)).toBe(true);
    expect(contentVisibility.runVisible(reviewer, live, null)).toBe(false);
  });

  it("⚠ a Reviewer sees every run, test runs included, of what was put in front of them — and none of a private draft", () => {
    for (const x of [theirAsked, theirLive, theirPublished]) {
      expect(contentVisibility.runVisible(reviewer, test, x)).toBe(true);
      expect(contentVisibility.runVisible(reviewer, live, x)).toBe(true);
    }
    expect(contentVisibility.runVisible(reviewer, test, theirDraft)).toBe(false);
    expect(contentVisibility.runVisible(reviewer, live, theirDraft)).toBe(false);
  });
});

describe("⚠ a chat shared with the workspace is shared to READ (sharing-boundaries P1-I5 \"A\")", () => {
  const shared = { createdBySubject: "them", visibility: "public" };
  it("every member reads it; only its owner or an Admin continues, renames, deletes or shares it", () => {
    expect(contentVisibility.chatVisible(me, shared)).toBe(true);
    expect(contentVisibility.chatVisible(nobody, shared)).toBe(true);
    expect(contentVisibility.chatChangeable(me, shared)).toBe(false);
    expect(contentVisibility.chatChangeable(reviewer, shared)).toBe(false);
    expect(contentVisibility.chatChangeable({ ...me, subject: "them" }, shared)).toBe(true);
    expect(contentVisibility.chatChangeable(admin, shared)).toBe(true);
  });
  it("the list form includes shared chats for a member", () => {
    expect(contentVisibility.chatsWhere(me)).toBeDefined();
    expect(contentVisibility.chatsWhere(admin)).toBeUndefined();
  });
});

describe("chats are private — a Reviewer does NOT see them", () => {
  it("the owner and an Admin, nobody else", () => {
    expect(contentVisibility.chatVisible(me, { createdBySubject: "me", visibility: "private" })).toBe(true);
    expect(contentVisibility.chatVisible(me, { createdBySubject: "them", visibility: "private" })).toBe(false);
    expect(contentVisibility.chatVisible(reviewer, { createdBySubject: "them", visibility: "private" })).toBe(false);
    expect(contentVisibility.chatVisible(admin, { createdBySubject: "them", visibility: "private" })).toBe(true);
  });
});

describe("the content guard reaches every route that names content", () => {
  it("CONTROL: the app has routes naming each kind of content, so the check below is not over nothing", () => {
    const kinds = new Set(routes.flatMap((r) => contentParams(r.path).map((p) => p.kind)));
    expect([...kinds].sort()).toEqual(["chat", "flow", "run", "session", "thread"]);
  });

  it("every workspace route whose path names content carries the content guard", () => {
    const missing = routes
      .filter((r) => r.rbac && r.path.startsWith("/api/workspaces/") && contentParams(r.path).length > 0)
      .filter((r) => !r.content?.length)
      .map((r) => `${r.method} ${r.path}`);
    expect(missing, `routes that name content but are not content-guarded:\n  ${missing.join("\n  ")}`).toEqual([]);
  });
});
