// The findings a person is shown when generation fails. I-100.
import { describe, expect, it } from "vitest";
import { gatewayFailed, normaliseFindings, ranOutOfAttempts } from "@/lib/generation-findings";

describe("normaliseFindings", () => {
  it("⚠ renders STRING findings — the shape that used to vanish", () => {
    // `FlowDraftError` carries strings, and it is what "could not draft a valid
    // flow in 3 attempts" throws — the failure a person actually hits. The
    // screen read `f.message` off each one, got `undefined`, and drew an empty
    // row where the only actionable text was.
    const out = normaliseFindings([
      'step "notify".paramsExpr reads `outputs.fetch.vars`, but "fetch" is a `datasource` step',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("outputs.fetch.vars");
  });

  it("still renders OBJECT findings, with their rule and step", () => {
    const out = normaliseFindings([{ rule: "unknown_ref", stepId: "notify", message: "no such tool" }]);
    expect(out[0]).toEqual({ rule: "unknown_ref", stepId: "notify", message: "no such tool" });
  });

  it("handles a mixed list, because both errors reach the same field", () => {
    const out = normaliseFindings(["a string one", { message: "an object one", stepId: "s" }]);
    expect(out.map((f) => f.message)).toEqual(["a string one", "an object one"]);
  });

  it("⚠ never drops a finding it cannot read", () => {
    // Dropping is the original defect with a tidier implementation: the screen
    // looks like there was nothing to say. Unreadable is better shown raw.
    const out = normaliseFindings([{ detail: "no message key" }, 42]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("no message key");
  });

  it("drops empty strings, which are the blank rows this exists to stop", () => {
    expect(normaliseFindings(["", "   "])).toEqual([]);
  });

  it("returns nothing for a non-list, rather than throwing on the failure screen", () => {
    // ⚠ It runs while rendering an error. Throwing here replaces a bad error
    // message with a blank page.
    expect(normaliseFindings(undefined)).toEqual([]);
    expect(normaliseFindings(null)).toEqual([]);
    expect(normaliseFindings("not a list")).toEqual([]);
  });
});

describe("ranOutOfAttempts — the diagnosis must be READ, not assumed", () => {
  it("recognises the drafter running out of attempts", () => {
    expect(ranOutOfAttempts("could not draft a valid flow in 3 attempts: nested {{ }}")).toBe(true);
  });

  it("⚠ does NOT claim it for a flow-id collision", () => {
    // The failure that exposed this. The draft SUCCEEDED and `flowService.create`
    // refused the id — so "the designer could not produce a valid flow in three
    // attempts" was a confident wrong diagnosis printed over it, within an hour
    // of the sentence shipping. I-102, and I-95's shape.
    expect(ranOutOfAttempts('a flow with id "attendance_report_automation" already exists in this workspace')).toBe(false);
  });

  it("does not claim it for a cap or an unknown ref", () => {
    expect(ranOutOfAttempts("this flow cannot be built as authored")).toBe(false);
    expect(ranOutOfAttempts('unknown ref "mail_send"; available: [...]')).toBe(false);
  });

  it("⚠ fails CLOSED on nothing and on anything unrecognised", () => {
    // No explanation and no suggestion is what this screen did before, and it is
    // honest. A default of `true` would put the wrong sentence over every future
    // failure mode nobody has thought of yet.
    expect(ranOutOfAttempts(undefined)).toBe(false);
    expect(ranOutOfAttempts(null)).toBe(false);
    expect(ranOutOfAttempts("")).toBe(false);
    expect(ranOutOfAttempts("something new nobody has seen")).toBe(false);
  });

  it("tolerates a different attempt count, since the cap is a constant that can move", () => {
    expect(ranOutOfAttempts("could not draft a valid flow in 5 attempts: x")).toBe(true);
  });
});

describe("gatewayFailed — a model outage must not render as no reason at all", () => {
  // The REAL message from 2026-08-18, verbatim from `flow_generation_jobs`,
  // truncated exactly as `inference.service.ts`'s `text.slice(0, 300)` left it.
  const REAL =
    'drafting call failed: gateway returned 502: {"error":{"message":"litellm.BadGatewayError: ' +
    'BadGatewayError: Hosted_vllmException - <html>\r\n<head><title>502 Bad Gateway</title></head>' +
    "\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.24.0 (Ubuntu)" +
    "</center>\r\n</body>\r\n</html>\r\n. Received Model Group=google/gemm";

  it("⚠ recognises the outage that shipped as a blank diagnosis", () => {
    expect(gatewayFailed(REAL)).toBe(true);
  });

  it("recognises the other two shapes inference.service.ts throws", () => {
    expect(gatewayFailed("drafting call failed: gateway returned a non-JSON body")).toBe(true);
    expect(gatewayFailed("drafting call failed: gateway returned no message content")).toBe(true);
  });

  it("⚠ claims a 4xx too — a wrong model name is also not a statement about the goal", () => {
    expect(gatewayFailed("drafting call failed: gateway returned 404: model not found")).toBe(true);
    expect(gatewayFailed("drafting call failed: gateway returned 401: invalid key")).toBe(true);
  });

  it("⚠ fails CLOSED on nothing and on anything unrecognised", () => {
    expect(gatewayFailed(undefined)).toBe(false);
    expect(gatewayFailed(null)).toBe(false);
    expect(gatewayFailed("")).toBe(false);
    expect(gatewayFailed("flow id already taken")).toBe(false);
    expect(gatewayFailed("unknown ref \"x\"; available: [a, b]")).toBe(false);
  });

  it("⚠ does NOT claim the drafter running out of attempts, and vice versa", () => {
    // The two branches must be mutually exclusive on real messages, or the
    // screen prints two different diagnoses of one failure.
    const attempts = "could not draft a valid flow in 3 attempts";
    expect(gatewayFailed(attempts)).toBe(false);
    expect(ranOutOfAttempts(REAL)).toBe(false);
  });
});
