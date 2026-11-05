/**
 * Redaction is the security control behind Phase 2's step-graph UI, and behind
 * ops-api's call log. It lives in `@foundry/redact` because both need it and
 * they sit on opposite sides of a trust boundary — two copies would drift, and
 * each would keep passing its own tests while doing so.
 * archive/kestra-migration/progress/DECISIONS.md D-07
 *
 * `begin`'s response body contains a LIVE execution token and Kestra persists
 * task outputs, so rendering a step naively prints a bearer credential into a
 * client-facing page. These tests pin the two properties that stop it:
 *
 *   1. credential-shaped KEYS are removed wherever they appear, including inside
 *      the JSON *string* Kestra stores an HTTP body as;
 *   2. non-credential data survives, because a redactor that eats the payload is
 *      a redactor someone switches off.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets, redactJsonString, REDACTED } from "./index.js";

describe("redactSecrets", () => {
  it("removes credential-shaped keys at any depth", () => {
    const out = redactSecrets({
      token: "live-token",
      nested: { api_key: "k", deep: { authorization: "Bearer x" } },
      list: [{ secret: "s" }, { password: "p" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    expect(JSON.stringify(out)).not.toContain("live-token");
    expect(out.token).toBe(REDACTED);
    expect(out.nested.api_key).toBe(REDACTED);
    expect(out.nested.deep.authorization).toBe(REDACTED);
    expect(out.list[0].secret).toBe(REDACTED);
    expect(out.list[1].password).toBe(REDACTED);
  });

  it("matches the spellings an API actually uses", () => {
    for (const key of [
      "token", "Token", "api_key", "apiKey", "apikey", "API-KEY", "x-api-key",
      "access_token", "accessToken", "secret", "password", "passwd", "authorization", "auth",
    ]) {
      expect((redactSecrets({ [key]: "v" }) as Record<string, unknown>)[key]).toBe(REDACTED);
    }
  });

  it("leaves ordinary data alone", () => {
    // The failure mode on the other side: a redactor that eats the payload makes
    // the step graph useless and gets disabled.
    const rows = { results: [{ ok: true, data: [{ employee_id: 14, work_email: "a@b.example" }] }] };
    expect(redactSecrets(rows)).toEqual(rows);
  });

  it("does not match keys that merely contain a secret word", () => {
    // `tokenCount` and `password_reset_url` are not credentials, and redacting
    // them would hide real diagnostic data.
    const out = redactSecrets({ tokenCount: 12, password_reset_url: "/reset" }) as Record<string, unknown>;
    expect(out.tokenCount).toBe(12);
    expect(out.password_reset_url).toBe("/reset");
  });
});

describe("redactJsonString", () => {
  it("reaches inside the JSON string Kestra stores a body as", () => {
    // This is verbatim the shape of `begin`'s persisted output.
    const body = JSON.stringify({
      token: "DO1aFrcjTaQt9ijDGhR8nNFJB-9tg8oUPvquUKfAp8g",
      flowExecutionId: "6318bb21-7fe9-4243-a6c2-dcbedac37c0d",
      expiresAt: "2026-07-28T21:51:00.217Z",
    });

    const out = redactJsonString(body);
    expect(out).not.toContain("DO1aFrcjTaQt9ijDGhR8nNFJB");
    // The non-credential fields survive: the execution id is what a step-detail
    // panel is FOR.
    expect(out).toContain("6318bb21-7fe9-4243-a6c2-dcbedac37c0d");
  });

  it("returns non-JSON untouched rather than destroying it", () => {
    expect(redactJsonString("Internal Server Error")).toBe("Internal Server Error");
    expect(redactJsonString('"just a string"')).toBe('"just a string"');
  });

  it("passes a normal step-API envelope through unchanged", () => {
    const body = JSON.stringify({ results: [{ ok: true, data: [] }], succeeded: 1, failed: 0, warnings: [] });
    expect(JSON.parse(redactJsonString(body))).toEqual(JSON.parse(body));
  });
});
