import { describe, expect, it } from "vitest";
import { isSessionEnded, safeNext } from "./session-expiry";

describe("session expiry", () => {
  it("treats only the two signed-out answers as an ended session", () => {
    expect(isSessionEnded(401, JSON.stringify({ error: "not_authenticated" }))).toBe(true);
    expect(isSessionEnded(401, JSON.stringify({ error: "identity_expired" }))).toBe(true);
    // A real refusal stays a refusal — redirecting on it would loop between the page and sign-in.
    expect(isSessionEnded(401, JSON.stringify({ error: "identity_invalid" }))).toBe(false);
    expect(isSessionEnded(403, JSON.stringify({ error: "not_authenticated" }))).toBe(false);
    expect(isSessionEnded(401, "not json")).toBe(false);
  });

  it("returns only to a page of this app", () => {
    expect(safeNext("/history?q=x")).toBe("/history?q=x");
    expect(safeNext("//evil.example/x")).toBe("/dashboard");
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext("/login?expired=1")).toBe("/dashboard");
    expect(safeNext(undefined)).toBe("/dashboard");
  });
});
