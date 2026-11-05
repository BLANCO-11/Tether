// src/lib/secret-edit.test.ts — the rules behind renaming a secret, and the
// three things the PATCH body must LEAVE OUT. ui-upgrade Phase 8.4, D-110.
import { describe, expect, it } from "vitest";
import { editState, patchFor, saveBlocked, savedMessage } from "@/lib/secret-edit";
import type { SecretImpact, WorkspaceSecret } from "@/lib/types";

function secret(over: Partial<WorkspaceSecret> = {}): WorkspaceSecret {
  return {
    id: "s-1",
    workspaceId: "ws-1",
    name: "TICKETING_API_KEY",
    description: "Ticketing key",
    hasValue: true,
    hasSandboxValue: false,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function impact(over: Partial<SecretImpact> = {}): SecretImpact {
  return {
    name: "TICKETING_API_KEY",
    newName: "TICKET_KEY",
    references: [],
    nameTaken: false,
    collidesWithDatasource: null,
    adopts: [],
    orphanWarning: null,
    ...over,
  };
}

const ONE_REF: SecretImpact["references"] = [
  { kind: "tool", label: 'tool "ticket_create"', breaks: "every call presents no credential" },
];

const draft = (over: Partial<{ name: string; description: string; value: string }> = {}) => ({
  name: "TICKETING_API_KEY",
  description: "Ticketing key",
  value: "",
  ...over,
});

describe("editState", () => {
  it("reports no orphans while the name is not moving", () => {
    // ⚠ The impact object DOES carry references — `GET …/:id/impact` with no
    // `name` answers "what depends on this?", which is the right answer for a
    // delete and the wrong one for a description edit. "3 things break" over an
    // edit that breaks nothing is how a warning stops being read.
    const s = editState(secret(), draft({ description: "new words" }), impact({ references: ONE_REF }));
    expect(s.renaming).toBe(false);
    expect(s.orphans).toEqual([]);
    expect(s.needsAck).toBe(false);
  });

  it("reports the orphans once the name moves", () => {
    const s = editState(secret(), draft({ name: "TICKET_KEY" }), impact({ references: ONE_REF }));
    expect(s.renaming).toBe(true);
    expect(s.needsAck).toBe(true);
    expect(s.orphans).toEqual(ONE_REF);
  });

  it("refuses a name that could not be an environment variable", () => {
    expect(editState(secret(), draft({ name: "not a name" }), null).nameInvalid).toBe(true);
    expect(editState(secret(), draft({ name: "9LIVES" }), null).nameInvalid).toBe(true);
    expect(editState(secret(), draft({ name: "_ok9" }), null).nameInvalid).toBe(false);
  });

  it("does not call an unchanged name taken, even against a stale impact", () => {
    const s = editState(secret(), draft(), impact({ nameTaken: true }));
    expect(s.nameTaken).toBe(false);
  });
});

describe("saveBlocked", () => {
  const opts = { impactKnown: true, accepted: false, busy: false };

  it("allows an ordinary edit", () => {
    const d = draft({ description: "new words" });
    expect(saveBlocked(editState(secret(), d, null), d, opts)).toBe(false);
  });

  it("⚠ fails CLOSED while a rename's impact has not come back", () => {
    // The one direction that cannot be undone by looking: nothing is suspended,
    // no fingerprint moves, no manifest changes, and the first sign is a 401
    // inside a run. An unanswered impact must not read as "nothing breaks".
    const d = draft({ name: "TICKET_KEY" });
    expect(saveBlocked(editState(secret(), d, null), d, { ...opts, impactKnown: false })).toBe(true);
  });

  it("blocks until the orphan list is acknowledged, then allows", () => {
    const d = draft({ name: "TICKET_KEY" });
    const s = editState(secret(), d, impact({ references: ONE_REF }));
    expect(saveBlocked(s, d, opts)).toBe(true);
    expect(saveBlocked(s, d, { ...opts, accepted: true })).toBe(false);
  });

  it("blocks a name another secret already holds, acknowledged or not", () => {
    const d = draft({ name: "TICKET_KEY" });
    const s = editState(secret(), d, impact({ nameTaken: true }));
    expect(saveBlocked(s, d, { ...opts, accepted: true })).toBe(true);
  });

  it("blocks an empty or malformed name, and while busy", () => {
    const empty = draft({ name: "" });
    expect(saveBlocked(editState(secret(), empty, null), empty, opts)).toBe(true);
    const bad = draft({ name: "TICKET KEY" });
    expect(saveBlocked(editState(secret(), bad, null), bad, opts)).toBe(true);
    const d = draft({ description: "x" });
    expect(saveBlocked(editState(secret(), d, null), d, { ...opts, busy: true })).toBe(true);
  });
});

describe("patchFor", () => {
  it("⚠ omits `value` when the box is blank", () => {
    // "Leave blank to keep the current one" has to be TRUE. A body carrying
    // `value: ""` would replace a working credential with an empty string —
    // and the server would accept it as a write, so nothing downstream would
    // notice until a run failed to sign in.
    const d = draft({ description: "new words" });
    const body = patchFor(secret(), d, editState(secret(), d, null));
    expect(body).not.toHaveProperty("value");
    expect(body).toEqual({ description: "new words" });
  });

  it("omits `name` when it has not moved", () => {
    const d = draft({ value: "new-key" });
    expect(patchFor(secret(), d, editState(secret(), d, null))).toEqual({ value: "new-key" });
  });

  it("omits `description` when it has not moved", () => {
    const d = draft({ value: "new-key" });
    expect(patchFor(secret(), d, editState(secret(), d, null))).not.toHaveProperty("description");
  });

  it("⚠ NEVER sends confirmOrphans when nothing is being orphaned", () => {
    // A client that always sends `true` has turned the server's refusal off from
    // the outside — the flag would be a field that exists and never refuses,
    // which reads exactly like one that works.
    const d = draft({ name: "TICKET_KEY" });
    const body = patchFor(secret(), d, editState(secret(), d, impact()));
    expect(body).not.toHaveProperty("confirmOrphans");
    expect(body.name).toBe("TICKET_KEY");
  });

  it("sends confirmOrphans exactly when there is an orphan list to acknowledge", () => {
    const d = draft({ name: "TICKET_KEY" });
    const body = patchFor(secret(), d, editState(secret(), d, impact({ references: ONE_REF })));
    expect(body.confirmOrphans).toBe(true);
  });

  it("treats a description cleared to empty as a real change", () => {
    // `""` and `undefined` mean different things: "no description" and "leave it
    // alone". Dropping an emptied box would make clearing a description
    // impossible with no error to say so.
    const d = draft({ description: "" });
    expect(patchFor(secret(), d, editState(secret(), d, null))).toEqual({ description: "" });
  });

  it("carries nothing at all for an untouched form", () => {
    const d = draft();
    expect(patchFor(secret(), d, editState(secret(), d, null))).toEqual({});
  });
});

describe("savedMessage", () => {
  it("says what a rename orphaned, rather than just 'saved'", () => {
    // The write SUCCEEDED and left references pointing at nothing. A bare
    // "Saved" is the false green this whole phase is about.
    const m = savedMessage("TICKETING_API_KEY", { to: "TICKET_KEY", orphaned: ONE_REF });
    expect(m).toContain("TICKET_KEY");
    expect(m).toMatch(/1 reference/);
    expect(m).toMatch(/fail to sign in/);
  });

  it("does not invent a warning when a rename broke nothing", () => {
    expect(savedMessage("X", { to: "Y", orphaned: [] })).toBe("Renamed to Y.");
  });

  it("says nothing about renaming for an ordinary edit", () => {
    expect(savedMessage("X", null)).toBe("X updated.");
  });
});
