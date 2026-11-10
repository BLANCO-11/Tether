import { describe, expect, it } from "vitest";
import { explainModelError, turnFailure } from "./forge-errors.js";

describe("a model error, in words a person acts on", () => {
  it("names a request too large for the gateway (a 413 from nginx), not a generic error", () => {
    const e = explainModelError("413 <html><head><title>413 Request Entity Too Large</title></head></html>");
    expect(e.title).toMatch(/too large/i);
    expect(e.retryable).toBe(true);
  });

  it("the error measured on 2026-10-11 — '403 terminated' — is a cut-off request, worth trying again", () => {
    const e = explainModelError("403 terminated");
    expect(e.title).toBe("The AI service cut the request off");
    expect(e.retryable).toBe(true);
    expect(e.detail).toBe("403 terminated"); // the raw error is kept, never dropped
  });
  it("busy, down and unreachable are each said differently, and all worth trying again", () => {
    expect(explainModelError("429 Too Many Requests").title).toBe("The AI service is busy");
    expect(explainModelError("503 Service Unavailable").title).toBe("The AI service is having problems");
    expect(explainModelError("fetch failed: ECONNREFUSED").title).toBe("Tether could not reach the AI service");
  });
  it("⚠ a sign-in failure and a too-long conversation say Try again will NOT help", () => {
    expect(explainModelError("401 Unauthorized: invalid api key")).toMatchObject({ retryable: false });
    expect(explainModelError("maximum context length is 128000 tokens")).toMatchObject({ retryable: false });
  });
  it("control: an error nobody anticipated still gets a sentence, and its raw text", () => {
    const e = explainModelError("something odd");
    expect(e.said).toMatch(/failed/);
    expect(e.detail).toBe("something odd");
  });
});

describe("a turn that did not finish", () => {
  it("retries that ran out say they were already retried", () => {
    expect(turnFailure("failed", { modelError: "403 terminated", minutes: 10 }).said).toMatch(/already retried automatically/);
  });
  it("a timeout names the limit; a crash keeps its exit code as detail", () => {
    expect(turnFailure("timeout", { minutes: 10 }).title).toMatch(/longer than 10 minutes/);
    expect(turnFailure("exited", { minutes: 10, exitCode: 137, stderr: "" })).toMatchObject({ title: "Forge stopped unexpectedly", detail: "exit 137" });
  });
});
