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
import {
  redactSecrets,
  redactJsonString,
  redactSecretValues,
  findSecretValues,
  REDACTED,
} from "./index.js";

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

describe("findSecretValues", () => {
  const cases: [string, string][] = [
    ["anthropic", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
    ["openai", "sk-proj-AAAAbbbbCCCCdddd1234"],
    ["github", "ghp_" + "a1B2c3D4e5".repeat(3) + "xyz"],
    ["github", "github_pat_" + "a1B2c3D4e5".repeat(4)],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["slack", "xoxb-1234567890-abcdefghij"],
    ["google", "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"],
    ["stripe", "sk_live_" + "a1B2c3D4e5F6g7H8"],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"],
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"],
  ];
  for (const [kind, value] of cases) {
    it(`finds ${kind} inside a sentence`, () => {
      const text = `please use ${value} for this, thanks`;
      const hits = findSecretValues(text);
      const hit = hits.find((h) => h.kind === kind);
      expect(hit).toBeDefined();
      expect(hit!.strong).toBe(true);
      expect(hit!.value).toBe(value);
      expect(hit!.start).toBe(text.indexOf(value));
      expect(hit!.end).toBe(text.indexOf(value) + value.length);
    });
  }

  it("reports only the token for Bearer", () => {
    const token = "abcdefghijklmnopqrstuvwx";
    const text = `Authorization: Bearer ${token}`;
    const hits = findSecretValues(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "bearer", value: token, start: text.indexOf(token) });
  });

  it("finds a prefixed key only with heuristics on", () => {
    const text = "my key is twtr_9fK2LmQ8xZ7pR4sT1vW3yB6n ok";
    expect(findSecretValues(text).map((h) => h.kind)).toEqual(["prefixed"]);
    expect(findSecretValues(text, { heuristics: false })).toEqual([]);
  });

  it("finds a 40-char hex string", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(findSecretValues(`sha ${hex}`).map((h) => h.kind)).toEqual(["hex"]);
  });

  it("does not flag ordinary text", () => {
    for (const t of [
      "e9eea8d0-1c2b-4d3e-9f00-123456789abc",
      "The quick brown fox jumps over the lazy dog near the river bank.",
      "https://example.com/some/long/path/segment/abcdefghijklmnopqrstuvwxyz012345",
      "snake_case_name",
    ]) {
      expect(findSecretValues(t)).toEqual([]);
    }
  });

  it("finds a key inside a query string", () => {
    const hits = findSecretValues("https://x.example/a?api_key=sk-proj-AAAAbbbbCCCCdddd1234&b=1");
    expect(hits.map((h) => h.value)).toEqual(["sk-proj-AAAAbbbbCCCCdddd1234"]);
  });

  it("does not double-report an sk-ant key", () => {
    const hits = findSecretValues("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("anthropic");
  });
});

describe("redactSecretValues", () => {
  it("replaces strong hits only", () => {
    expect(redactSecretValues("key sk-proj-AAAAbbbbCCCCdddd1234 and twtr_9fK2LmQ8xZ7pR4sT1vW3yB6n")).toBe(
      `key ${REDACTED} and twtr_9fK2LmQ8xZ7pR4sT1vW3yB6n`,
    );
  });
});
