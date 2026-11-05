// src/lib/plugin-setup.test.ts — the setup story's rules, asserted without
// rendering.
//
// The one worth pinning is that step 3 reports BLOCKED with a reason whenever a
// plugin is not emittable. `/apps` shows brand logos for Slack, AWS and Azure;
// the only thing standing between that and a false claim of integration is this
// step saying, in words, that an administrator has to enable it first.
import { describe, expect, it } from "vitest";
import { secretNameFor, setupSteps } from "./plugin-setup";
import type { PluginCredentials } from "./types";

const creds = (over: Partial<PluginCredentials> = {}): PluginCredentials => ({
  plugin: "plugin-slack",
  reachable: true,
  fields: [],
  classesRead: 10,
  classesTotal: 10,
  usableToday: false,
  notes: [],
  ...over,
});

describe("secretNameFor", () => {
  it("splits camelCase into an env-var name", () => {
    expect(secretNameFor("AWS", "accessKeyId")).toBe("AWS_ACCESS_KEY_ID");
    expect(secretNameFor("Azure", "connectionString")).toBe("AZURE_CONNECTION_STRING");
  });

  it("prefixes with the plugin so two plugins' fields cannot collide", () => {
    // A workspace secret is referenced by NAME and a collision fails the
    // execution with a 409 rather than last-write-wins. Two plugins each wanting
    // a bare `URL` is the obvious way to author that collision by accident.
    expect(secretNameFor("Slack", "url")).toBe("SLACK_URL");
    expect(secretNameFor("Email", "url")).toBe("EMAIL_URL");
  });

  it("does not double a prefix the field already carries", () => {
    // ⚠ Common rather than an edge case — plugin fields are frequently named
    // after their own service, and `SLACK_SLACK_TOKEN` would be the usual
    // output rather than a rarity.
    expect(secretNameFor("Slack", "slackToken")).toBe("SLACK_TOKEN");
    expect(secretNameFor("Slack", "slack")).toBe("SLACK");
  });

  it("survives punctuation and spacing in either part", () => {
    expect(secretNameFor("Google Cloud", "private-key.id")).toBe("GOOGLE_CLOUD_PRIVATE_KEY_ID");
  });
});

describe("setupSteps", () => {
  it("blocks step 3, with a reason, when nothing can call the plugin", () => {
    // ⚠ The assertion the panel turns on.
    const [, , three] = setupSteps(creds({ usableToday: false }), "Slack");
    expect(three!.blocked).toBe(true);
    expect(three!.because).toMatch(/No automation can call Slack yet/);
  });

  it("unblocks step 3 once a capability is emittable", () => {
    // `usableToday` is the flip. When Phase 8 allows a capability this step
    // stops being a request to somebody else.
    const [, , three] = setupSteps(creds({ usableToday: true }), "Slack");
    expect(three!.blocked).toBe(false);
    expect(three!.because).toBeNull();
  });

  it("never blocks steps 1 and 2, because both are real today", () => {
    // Workspace secrets exist and are reachable from this panel, so presenting
    // the whole flow as unavailable would be its own false statement — and it
    // would hide that putting the credential in place now is not wasted work.
    const [one, two] = setupSteps(creds({ usableToday: false }), "Slack");
    expect(one!.blocked).toBe(false);
    expect(two!.blocked).toBe(false);
  });

  it("marks no step as done, ever", () => {
    // ⚠ There is deliberately no `done`. This product cannot tell whether
    // somebody has obtained a Slack token, and a tick beside a step nobody
    // verified is exactly the false green the page exists to avoid.
    const steps = setupSteps(creds({ usableToday: true }), "Slack");
    expect(steps.every((s) => !("done" in s))).toBe(true);
  });

  it("asks a credential-less plugin to CHECK rather than to go and get one", () => {
    const [one] = setupSteps(creds({ fields: [] }), "Serialization");
    expect(one!.title).toMatch(/Check whether/);
  });

  it("still returns all three steps when the engine could not be read", () => {
    // A null payload must not collapse the panel to nothing — the steps are the
    // answer to "how do I set this up", which is true regardless of whether this
    // particular read succeeded.
    expect(setupSteps(null, "Slack")).toHaveLength(3);
    expect(setupSteps(null, "Slack")[2]!.blocked).toBe(true);
  });
});
