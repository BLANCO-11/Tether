import { describe, it, expect } from "vitest";
import * as copy from "./workspace-access-copy";
import {
  ACCESS_IS_NOT_IDENTITY,
  ACCESS_UNKNOWN,
  NOT_SUPER_ADMIN,
  NO_SUPER_ADMIN_CONFIGURED,
  SEEN_USERS_EMPTY,
  SEEN_USERS_EXPLAINER,
  SEEN_USERS_UNREADABLE,
} from "./workspace-access-copy";

/**
 * ⚠ **These assert what the copy may NOT claim, which is why the strings live in
 * a module at all** (`generation-findings.ts`, `policy-copy.ts` and
 * `prompt-boundary-copy.ts` all do the same). Wording drifts; a rule about what
 * a screen is allowed to assert has to be checkable.
 */

describe("the access bound", () => {
  it("never calls a role proof of identity, and names the signing secret", () => {
    // Anything holding RUNTIME_JWT_SECRET can present any identity (I-13), so
    // "verified person" is the one thing these screens may not say — and the
    // reason has to be on screen, not only in a docblock.
    expect(ACCESS_IS_NOT_IDENTITY).toMatch(/not proof of who they are/);
    expect(ACCESS_IS_NOT_IDENTITY).toMatch(/signing secret/);
  });
});

describe("the seen-users list", () => {
  it("says what a row means and what it does not", () => {
    expect(SEEN_USERS_EXPLAINER).toMatch(/not a list of accounts/i);
    expect(SEEN_USERS_EXPLAINER).toMatch(/not proof of who anyone is/i);
    // ⚠ It is not a session list either: a row does not expire.
    expect(SEEN_USERS_EXPLAINER).toMatch(/signed in right now/i);
  });

  it("⚠ has no all-clear string, and unreadable is not the empty case", () => {
    // The two must be distinguishable, or a failed request renders as "nobody
    // has signed in" — an absence of findings nobody obtained.
    expect(SEEN_USERS_UNREADABLE).not.toBe(SEEN_USERS_EMPTY);
    expect(SEEN_USERS_UNREADABLE).toMatch(/did not run/);
    // And the unreadable string must not itself assert the absence.
    expect(SEEN_USERS_UNREADABLE).toMatch(/not “nobody has signed in yet”/);
  });
});

describe("the two super-admin refusals", () => {
  it("are different strings, and only one names the variable", () => {
    // Two problems, two fixes: ask a person, versus set an environment variable.
    expect(NOT_SUPER_ADMIN).not.toBe(NO_SUPER_ADMIN_CONFIGURED);
    expect(NO_SUPER_ADMIN_CONFIGURED).toMatch(/SUPER_ADMIN_EMAILS/);
    expect(NOT_SUPER_ADMIN).not.toMatch(/SUPER_ADMIN_EMAILS/);
  });

  it("⚠ neither tells anybody to retry, and neither reads as an error", () => {
    // A refusal is not a failure — D-38's rule, applied to copy. "Try again" on
    // an authorisation decision is a button that cannot work.
    for (const s of [NOT_SUPER_ADMIN, NO_SUPER_ADMIN_CONFIGURED]) {
      expect(s.toLowerCase()).not.toMatch(/try again|retry|error|failed/);
    }
  });

  it("⚠ “could not check” is neither refusal", () => {
    // The fourth state. It must not read as "you are not allowed": we do not know.
    expect(ACCESS_UNKNOWN).toMatch(/could not be checked/);
    expect(ACCESS_UNKNOWN).toMatch(/not saying you are or are not allowed/);
  });

  it("no string in this module names who the super admins are", () => {
    // A refusal is the last place to publish the list of accounts worth
    // attacking, and the server deliberately does not send it.
    for (const [name, s] of Object.entries(copy)) {
      if (typeof s !== "string") continue;
      expect(s, name).not.toMatch(/@/);
    }
  });
});

describe("access for one local account", () => {
  it("⚠ says access can be given BEFORE a first sign-in — the whole point of it", () => {
    // The members picker is built from identities the API has SEEN, so it
    // cannot offer an account created a second earlier. If this sentence goes,
    // the screen stops explaining why it exists rather than the other panel.
    expect(copy.LOCAL_ACCESS_EXPLAINER).toMatch(/before they have ever signed in/i);
  });

  it("⚠ the unreadable state and the empty state are DIFFERENT sentences", () => {
    expect(copy.LOCAL_ACCESS_UNREADABLE).not.toBe(copy.LOCAL_ACCESS_NONE);
    // Unreadable must deny being an absence, in those terms.
    expect(copy.LOCAL_ACCESS_UNREADABLE).toMatch(/not .no access./i);
    expect(copy.LOCAL_ACCESS_UNREADABLE).toMatch(/the check did not run/i);
    // Empty must say what it MEANS, not merely that there is nothing.
    expect(copy.LOCAL_ACCESS_NONE).toMatch(/refuse/i);
  });

  it("⚠ states these are the SAME roles a work account gets", () => {
    // A local account granted `admin` is a workspace admin in exactly the same
    // sense — the row is identical. Copy implying a lesser kind of access would
    // be false, and false in the reassuring direction.
    expect(copy.LOCAL_ACCESS_SAME_AS_AD).toMatch(/same workspace roles/i);
    expect(copy.LOCAL_ACCESS_SAME_AS_AD).toMatch(/no separate, lesser kind/i);
  });

  it("no local-access string claims a role proves who somebody is", () => {
    for (const k of ["LOCAL_ACCESS_EXPLAINER", "LOCAL_ACCESS_NONE", "LOCAL_ACCESS_SAME_AS_AD"] as const) {
      expect((copy[k] as string).toLowerCase(), k).not.toMatch(/verified|proves|identity of/);
    }
  });
});
