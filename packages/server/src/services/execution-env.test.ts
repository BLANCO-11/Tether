import { describe, expect, it } from "vitest";
import { envForNamespace } from "./execution-env.service.js";

/**
 * Which data an execution reads is decided by ONE function, and this is it.
 *
 * The whole of Stage 4's structural claim reduces to: a draft namespace resolves
 * to `draft`, and nothing a request can carry changes the answer. So the tests
 * that matter are the boundary cases of a string split — which is exactly the
 * kind of code that looks too simple to test until a namespace with an unusual
 * prefix reads production during a test run.
 */
describe("envForNamespace", () => {
  it("resolves the draft namespace to draft", () => {
    expect(envForNamespace("foundry.default.hr.draft")).toBe("draft");
  });

  it("resolves the live namespace to live", () => {
    expect(envForNamespace("foundry.default.hr")).toBe("live");
  });

  /**
   * A namespace under a different prefix is not this deployment's, so it is not
   * recognised — and an unrecognised namespace is DRAFT. Worth an explicit test
   * because the intuition is "well, it has no `.draft` on the end, so it is
   * live", and that intuition is the one that leaks data.
   */
  it("treats a namespace under a different prefix as unrecognised, hence draft", () => {
    expect(envForNamespace("acme.foundry.default.hr")).toBe("draft");
    expect(envForNamespace("somebodyelse.default.hr")).toBe("draft");
  });

  /**
   * ⚠ Fails CLOSED, and the direction is the whole point. Answering `draft` for
   * something unreadable reads fixtures on a production run — a wrong result,
   * loudly, on a run somebody is watching. Answering `live` would silently ship
   * tenant rows to a model during development, which is the exposure this stage
   * exists to close.
   */
  it("treats an unreadable namespace as draft, not live", () => {
    expect(envForNamespace(null)).toBe("draft");
    expect(envForNamespace(undefined)).toBe("draft");
    expect(envForNamespace("")).toBe("draft");
  });

  /**
   * A workspace whose slug happens to be "draft" lives at
   * `foundry.default.draft`, and its DRAFT namespace is `foundry.default.draft.draft`.
   * The live one must not be read as a draft.
   */
  it("does not mistake a workspace slugged `draft` for the draft namespace", () => {
    expect(envForNamespace("foundry.default.draft")).toBe("live");
    expect(envForNamespace("foundry.default.draft.draft")).toBe("draft");
  });

  it("matches the segment exactly, never a prefix of it", () => {
    // `…hr-draft` is a four-segment-shaped name with a live segment count of
    // three, so it is live — the hyphenated suffix is part of the slug.
    expect(envForNamespace("foundry.default.hr-draft")).toBe("live");
    // `…hr.drafts` has the DRAFT segment count but the wrong final segment, so
    // it is not a shape this deployment emits. Unrecognised ⇒ draft.
    expect(envForNamespace("foundry.default.hr.drafts")).toBe("draft");
  });
});
