import { describe, expect, it } from "vitest";
import {
  assertSecretOwner,
  forgeNoteFor,
  hostSchema,
  interceptSecrets,
  placementSchema,
  toView,
  vaultLine,
} from "./chat-secrets.js";

const KEY = "twtr_9fK2LmQ8xZ7pR4sT1vW3yB6n";

describe("chat secrets", () => {
  it("toView carries neither the value nor valueEnc", () => {
    const row = {
      id: "1",
      name: "k",
      status: "active",
      boundHost: "api.example.com",
      extraHosts: [],
      placementKind: "bearer",
      placementName: null,
      createdAt: new Date(),
      expiresAt: null,
      lastUsedAt: null,
      valueEnc: "ENCRYPTED",
      value: "PLAINVALUE",
    };
    const json = JSON.stringify(toView(row));
    expect(json).not.toContain("ENCRYPTED");
    expect(json).not.toContain("PLAINVALUE");
    expect(json).not.toContain("valueEnc");
  });

  it("only the owner passes", () => {
    expect(() => assertSecretOwner("a@x.com", "a@x.com")).not.toThrow();
    expect(() => assertSecretOwner("a@x.com", "b@x.com")).toThrow(/Only the person/);
    expect(() => assertSecretOwner(null, "a@x.com")).toThrow();
    expect(() => assertSecretOwner("a@x.com", null)).toThrow();
  });

  it("hostSchema normalises and refuses", () => {
    expect(hostSchema.parse("https://API.TwitterAPI.io/v2/x")).toBe("api.twitterapi.io");
    expect(hostSchema.parse("api.example.com")).toBe("api.example.com");
    expect(hostSchema.safeParse("not a host").success).toBe(false);
    expect(hostSchema.safeParse("").success).toBe(false);
    expect(hostSchema.safeParse("localhost").success).toBe(false);
  });

  it("placementSchema needs a name for header and query", () => {
    expect(placementSchema.safeParse({ kind: "bearer" }).success).toBe(true);
    expect(placementSchema.safeParse({ kind: "header" }).success).toBe(false);
    expect(placementSchema.safeParse({ kind: "query" }).success).toBe(false);
    expect(placementSchema.safeParse({ kind: "header", name: "X-Api-Key" }).success).toBe(true);
  });

  it("interceptSecrets moves a pasted key out of the text", () => {
    const r = interceptSecrets(`my twitterapis key is ${KEY} thanks`, []);
    expect(r.text).toContain("{{secret:twtr-key}}");
    expect(r.text).not.toContain(KEY);
    expect(r.caught[0]!.value).toBe(KEY);
  });

  it("the same key twice gets one name", () => {
    const r = interceptSecrets(`${KEY} and again ${KEY}`, []);
    expect(r.caught).toHaveLength(1);
    expect(r.text.match(/\{\{secret:twtr-key\}\}/g)).toHaveLength(2);
  });

  it("de-duplicates against existing names", () => {
    const r = interceptSecrets(`key ${KEY}`, ["twtr-key"]);
    expect(r.caught[0]!.name).toBe("twtr-key-2");
  });

  it("plain text is unchanged", () => {
    const r = interceptSecrets("hello there, nothing secret", []);
    expect(r).toEqual({ text: "hello there, nothing secret", caught: [] });
  });

  it("forgeNoteFor is empty for nothing", () => {
    expect(forgeNoteFor([])).toBe("");
    expect(forgeNoteFor([{ name: "twtr-key" }])).toContain("twtr-key");
  });
});

describe("vaultLine", () => {
  const base = { id: "1", createdAt: "", expiresAt: null, lastUsedAt: null, extraHosts: [] as string[] };
  it("lists active keys with host, placement and the http tool, and says no service is needed", () => {
    const l = vaultLine([{ ...base, name: "twitterapikey", status: "active", host: "api.twitterapis.com", placement: { kind: "bearer", name: null } }]);
    expect(l).toContain("twitterapikey — for api.twitterapis.com, sent as bearer");
    expect(l).toContain("node tools/http.mjs GET https://api.twitterapis.com/... --secret twitterapikey");
    expect(l).toContain("does NOT need a connected service");
  });
  it("lists pending keys as waiting", () => {
    const l = vaultLine([{ ...base, name: "k2", status: "pending", host: null, placement: { kind: "header", name: "X-Key" } }]);
    expect(l).toContain("k2 (waiting for the person to choose its website)");
  });
  it("says so when the vault is empty", () => {
    expect(vaultLine([])).toMatch(/^No keys in this chat's vault\..*key button/);
  });
});
