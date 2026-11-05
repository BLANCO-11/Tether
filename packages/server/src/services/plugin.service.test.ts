import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __test, pieceName, shortName } from "./plugin.service.js";
import type { PieceAuth, PieceDescription } from "./plugin-connector.service.js";

const { shapeCatalogue, checkFields, cleanHosts, authDeclFor, connectionView } = __test;
const status = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return { code: (e as { statusCode?: number }).statusCode, message: (e as Error).message };
  }
  return null;
};

describe("the marketplace catalogue", () => {
  const raw = [
    { name: "@activepieces/piece-amazon-s3", displayName: "Amazon S3", version: "0.8.1", categories: ["CONTENT_AND_FILES"], logoUrl: "https://cdn.activepieces.com/pieces/amazon-s3.png", auth: { type: "CUSTOM_AUTH" }, actions: 19, triggers: 2 },
    { name: "@activepieces/piece-delay", displayName: "Delay", version: "0.1.0", categories: ["CORE"], auth: null },
    { name: "@activepieces/piece-branch", displayName: "Branch", version: "0.1.0", categories: ["FLOW_CONTROL"] },
    { name: "left-pad", displayName: "Not a piece", version: "1.0.0" },
    { name: "@activepieces/piece-github", displayName: "GitHub", version: "^0.11", auth: [{ type: "OAUTH2" }] },
    { name: "@activepieces/piece-evil", displayName: "Evil", version: "1.0.0", logoUrl: "javascript:alert(1)", auth: [{ type: "SECRET_TEXT" }, { type: "OAUTH2" }] },
  ];
  const out = shapeCatalogue(raw);

  it("keeps real pieces at exact versions, and leaves out Activepieces' own flow plumbing", () => {
    expect(out.map((e) => e.short)).toEqual(["amazon-s3", "evil"]);
  });
  it("a logo is only ever the Activepieces CDN — anything else is dropped, never rendered", () => {
    expect(out.find((e) => e.short === "amazon-s3")!.logoUrl).toMatch(/^https:\/\/cdn\.activepieces\.com\//);
    expect(out.find((e) => e.short === "evil")!.logoUrl).toBeNull();
  });
  it("auth kinds are listed whether the catalogue gives one or several", () => {
    expect(out.find((e) => e.short === "amazon-s3")!.authTypes).toEqual(["CUSTOM_AUTH"]);
    expect(out.find((e) => e.short === "evil")!.authTypes).toEqual(["SECRET_TEXT", "OAUTH2"]);
  });
  it("refuses a body that is not a list", () => {
    expect(() => shapeCatalogue({ pieces: [] })).toThrow();
  });
});

describe("connection fields", () => {
  const decl: PieceAuth = {
    type: "CUSTOM_AUTH",
    displayName: "Access key",
    required: true,
    fields: [
      { name: "accessKeyId", label: "Access key ID", type: "SHORT_TEXT", required: true, secret: false, description: "" },
      { name: "secretAccessKey", label: "Secret", type: "SECRET_TEXT", required: true, secret: true, description: "" },
      { name: "region", type: "STATIC_DROPDOWN", required: false, secret: false, description: "", defaultValue: "us-east-1", options: [{ label: "US East", value: "us-east-1" }, { label: "EU West", value: "eu-west-1" }] },
    ],
  };

  it("takes the declared fields, applying a default", () => {
    expect(checkFields(decl, { accessKeyId: "A", secretAccessKey: "S" }, {})).toEqual({ accessKeyId: "A", secretAccessKey: "S", region: "us-east-1" });
  });
  it("names a missing required field by its label", () => {
    expect(status(() => checkFields(decl, { accessKeyId: "A" }, {}))).toEqual({ code: 400, message: "missing: Secret" });
  });
  it("refuses a field the piece does not declare — nothing extra rides into the stored value", () => {
    expect(status(() => checkFields(decl, { accessKeyId: "A", secretAccessKey: "S", endpoint: "http://postgres" }, {}))?.message).toMatch(/not fields of this connection: endpoint/);
  });
  it("refuses a dropdown value that is not one of its options", () => {
    expect(status(() => checkFields(decl, { accessKeyId: "A", secretAccessKey: "S", region: "mars-1" }, {}))?.message).toMatch(/must be one of US East, EU West/);
  });
  it("on a rotation, a field left blank keeps the stored value; a given one replaces it", () => {
    const stored = { accessKeyId: "OLD", secretAccessKey: "OLDS", region: "eu-west-1" };
    expect(checkFields(decl, { accessKeyId: "", secretAccessKey: "NEW" }, stored)).toEqual({ accessKeyId: "OLD", secretAccessKey: "NEW", region: "eu-west-1" });
  });
  it("refuses an object as a value", () => {
    expect(status(() => checkFields(decl, { accessKeyId: { $ne: 1 } as never, secretAccessKey: "S" }, {}))?.code).toBe(400);
  });
});

describe("which auth a connection uses", () => {
  const p = (auth: PieceAuth[]) => ({ name: "@activepieces/piece-x", version: "1.0.0", displayName: "X", auth, actions: [] }) as PieceDescription;
  it("prefers a non-OAuth kind when the caller names none", () => {
    expect(authDeclFor(p([{ type: "OAUTH2", displayName: null, required: true }, { type: "SECRET_TEXT", displayName: null, required: true }])).type).toBe("SECRET_TEXT");
  });
  it("a sign-in (OAuth) connection is never taken as typed values — a form that took a token by hand would skip consent", () => {
    expect(status(() => authDeclFor(p([{ type: "OAUTH2", displayName: null, required: true }])))).toMatchObject({ code: 422, message: expect.stringMatching(/connects by signing in, not with values/) });
  });
  it("refuses a kind the piece does not take, and a piece that takes none", () => {
    expect(status(() => authDeclFor(p([{ type: "SECRET_TEXT", displayName: null, required: true }]), "BASIC_AUTH"))?.code).toBe(400);
    expect(status(() => authDeclFor(p([])))?.message).toMatch(/needs no connection/);
  });
});

describe("hosts and names", () => {
  it("hosts are host, host:port or *.domain — lower-cased and de-duplicated", () => {
    expect(cleanHosts(["API.github.com", "api.github.com", "s3:8333", "*.example.com"])).toEqual(["api.github.com", "s3:8333", "*.example.com"]);
    expect(status(() => cleanHosts(["https://x.com/path"]))?.code).toBe(400);
    expect(status(() => cleanHosts("x.com"))?.code).toBe(400);
  });
  it("a short name maps to the scope and back, and nothing else is a name", () => {
    expect(pieceName("amazon-s3")).toBe("@activepieces/piece-amazon-s3");
    expect(shortName("@activepieces/piece-amazon-s3")).toBe("amazon-s3");
    for (const bad of ["../x", "Amazon", "a/b", ""]) expect(status(() => pieceName(bad))?.code).toBe(400);
  });
});

describe("⚠ a connection's value never leaves the server", () => {
  it("the view of a connection has names and dates, and no field a value could travel in", () => {
    const now = new Date();
    const v = connectionView({
      id: "00000000-0000-0000-0000-000000000000",
      workspaceId: "w",
      piece: "@activepieces/piece-amazon-s3",
      label: "prod",
      authType: "CUSTOM_AUTH",
      secretName: "PLUGIN_AMAZON_S3_PROD",
      fieldNames: ["accessKeyId", "secretAccessKey"],
      createdBy: "a@b",
      createdAt: now,
      updatedAt: now,
      lastTestedAt: null,
      lastTestOk: null,
      lastTestMessage: null,
      ownerSubject: "someone",
    });
    expect(Object.keys(v).sort()).toEqual(["authType", "createdAt", "createdBy", "fieldNames", "id", "label", "lastTestMessage", "lastTestOk", "lastTestedAt", "personal", "piece", "updatedAt"]);
    expect(JSON.stringify(v)).not.toMatch(/someone/);
    expect(JSON.stringify(v)).not.toMatch(/secretName|valueEnc|PLUGIN_AMAZON_S3_PROD/);
  });
  it("the service decrypts in exactly one place (storedFields), and no route file decrypts at all", () => {
    const svc = readFileSync(join(import.meta.dirname, "plugin.service.ts"), "utf8");
    expect(svc.length).toBeGreaterThan(1000);
    expect([...svc.matchAll(/\bdecrypt\(/g)].length).toBe(1);
    const routes = readFileSync(join(import.meta.dirname, "..", "routes", "plugins.ts"), "utf8");
    expect(routes.length).toBeGreaterThan(500);
    expect(routes).not.toMatch(/decrypt|valueEnc|storedFields/);
  });
});
