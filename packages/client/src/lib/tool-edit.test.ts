/**
 * ⚠ The trap in fixing I-124, which is the sharpest thing in Phase 1.2.
 *
 * `manifestBuilderService.refFingerprints()` hashes `{kind, method, url, params,
 * isDummy, authStyle, authParamName, secretEnvName}` for a tool. So adding a
 * credential to an EXISTING tool moves its fingerprint, and the staleness sweep
 * then marks every flow using it `suspended` and removes its Kestra schedule —
 * on a later poll tick, and not undone by putting the old value back, because the
 * approval is closed by then.
 *
 * Without a warning, exposing the four credential fields would have shipped a new
 * way to unarm a live automation by filling in a form. These tests pin the two
 * halves that make the warning worth having:
 *
 *   · it FIRES for every one of the six hashed fields — not only the two the plan
 *     named, because `url` and `params` have been editable in that form since it
 *     was written and have always had this consequence; and
 *   · it does NOT fire for a save that changes something outside the hash, or for
 *     one that only reorders keys. A warning that appears when nothing happens is
 *     how a warning stops being read, which is I-38 from the other end.
 */
import { describe, expect, it } from "vitest";
import {
  authFindings,
  fingerprintFieldsOf,
  hasStoredValue,
  movedFingerprintFields,
  needsAuthParamName,
  secretNameOptions,
  suspensionWarning,
  typeForMethod,
} from "./tool-edit";
import type { Tool } from "./types";

const stored: Tool = {
  id: "t1",
  name: "ticket_create",
  description: "Raise a ticket",
  app: "api.example.com",
  type: "changes data",
  usedBy: 3,
  status: "ok",
  statusText: "Ready",
  endpoint: "https://api.example.com/incidents",
  method: "POST",
  secretEnvName: "TICKETING_TOKEN",
  authStyle: "bearer",
  authParamName: null,
  params: [{ name: "title", dataType: "string", required: true, description: "The summary" }],
};

const schema = { title: { type: "string", required: true, description: "The summary" } };
const before = fingerprintFieldsOf(stored, schema);

describe("movedFingerprintFields", () => {
  it("says nothing moved when nothing in the hash moved", () => {
    expect(movedFingerprintFields(before, fingerprintFieldsOf(stored, schema))).toEqual([]);
    expect(suspensionWarning([])).toBeNull();
  });

  it("ignores a change OUTSIDE the hash", () => {
    // The tool's description is prose the drafter reads. It is not in the
    // fingerprint payload, so editing it unarms nothing and must not warn.
    const renamed = { ...stored, description: "Completely rewritten prose" };
    expect(movedFingerprintFields(before, fingerprintFieldsOf(renamed, schema))).toEqual([]);
  });

  it("ignores a reordering of the parameter map", () => {
    // `refFingerprints` runs the payload through `canonical()` before hashing, so
    // key order is not part of the fingerprint and must not be part of this
    // comparison. A plain JSON.stringify would report a suspension here.
    const two = {
      title: { type: "string", required: true, description: "The summary" },
      note: { type: "string", required: false },
    };
    const reordered = {
      note: { type: "string", required: false },
      title: { description: "The summary", required: true, type: "string" },
    };
    expect(
      movedFingerprintFields(
        fingerprintFieldsOf(stored, two),
        fingerprintFieldsOf(stored, reordered),
      ),
    ).toEqual([]);
  });

  it("fires on each of the six hashed fields, naming which", () => {
    const cases: Array<[Partial<Tool>, string]> = [
      [{ method: "PATCH" }, "the HTTP method"],
      [{ endpoint: "https://api.example.com/v2/incidents" }, "the endpoint URL"],
      [{ authStyle: "header", authParamName: "X-API-Key" }, "how the credential is presented"],
      [{ authParamName: "X-Other" }, "the header or query-parameter name"],
      [{ secretEnvName: "OTHER_TOKEN" }, "which credential it presents"],
    ];
    for (const [patch, label] of cases) {
      const moved = movedFingerprintFields(
        before,
        fingerprintFieldsOf({ ...stored, ...patch }, schema),
      );
      expect(moved, `${label} should have moved`).toContain(label);
    }
    // `params` is the sixth, and it is the one that has ALWAYS been editable in
    // this form with no warning at all — adding one description moves the hash.
    expect(
      movedFingerprintFields(before, fingerprintFieldsOf(stored, { ...schema, extra: { type: "string" } })),
    ).toContain("the parameters");
  });

  it("counts an added credential on a tool that had none", () => {
    // The exact edit I-124's warning exists for.
    const bare: Tool = { ...stored, authStyle: null, secretEnvName: null };
    const moved = movedFingerprintFields(
      fingerprintFieldsOf(bare, schema),
      fingerprintFieldsOf(stored, schema),
    );
    expect(moved).toEqual(["how the credential is presented", "which credential it presents"]);
  });

  it("compares the method case-insensitively", () => {
    // The stored value is upper-case and a select's value is too, but an older row
    // could hold `post`. Reporting a suspension for a case difference would be a
    // warning about nothing.
    expect(
      movedFingerprintFields(before, fingerprintFieldsOf({ ...stored, method: "post" }, schema)),
    ).toEqual([]);
  });
});

describe("suspensionWarning", () => {
  it("names no flow and no count, and says why", () => {
    // ⚠ Deliberate. There is no `GET /tools/:id/impact`, and the answer depends on
    // `manifest_refs_json` on each ARMED revision, which no browser can read.
    // `datasourceQueryService.impact`'s own docblock calls the inferred version
    // "a confidently wrong list". Filed as I-132.
    const text = suspensionWarning(["the endpoint URL"])!;
    expect(text).toMatch(/cannot list which automations/);
    expect(text).toMatch(/does not restore the approval/);
    expect(text).not.toMatch(/\d+ flow/);
  });
});

describe("authFindings mirrors createToolSchema's two cross-field rules", () => {
  it("passes `none` with nothing else set", () => {
    expect(authFindings({ authStyle: "none" })).toEqual([]);
  });

  it("requires a credential for every style that is not `none`", () => {
    for (const style of ["bearer", "header", "query", "basic"] as const) {
      const f = authFindings({ authStyle: style });
      expect(f.some((x) => x.field === "secretEnvName")).toBe(true);
    }
  });

  it("requires an env-var-shaped name, because that identifier IS the reference", () => {
    expect(authFindings({ authStyle: "bearer", secretEnvName: "my key" })[0].field).toBe(
      "secretEnvName",
    );
    expect(authFindings({ authStyle: "bearer", secretEnvName: "MY_KEY" })).toEqual([]);
  });

  it("requires authParamName for header and query ONLY", () => {
    expect(
      authFindings({ authStyle: "header", secretEnvName: "K" }).map((f) => f.field),
    ).toEqual(["authParamName"]);
    expect(
      authFindings({ authStyle: "query", secretEnvName: "K" }).map((f) => f.field),
    ).toEqual(["authParamName"]);
    expect(authFindings({ authStyle: "bearer", secretEnvName: "K" })).toEqual([]);
    expect(authFindings({ authStyle: "basic", secretEnvName: "K" })).toEqual([]);
    expect(needsAuthParamName("header")).toBe(true);
    expect(needsAuthParamName("bearer")).toBe(false);
  });

  it("addresses each finding to the field that has to change", () => {
    // A message reading "authStyle bearer requires a secretEnvName" at the bottom
    // of a modal makes a person re-read the auth dropdown, which was already right.
    const f = authFindings({ authStyle: "query", secretEnvName: "" });
    expect(f.map((x) => x.field).sort()).toEqual(["authParamName", "secretEnvName"]);
  });
});

describe("oauth2_client_credentials validation — Phase 7", () => {
  it("requires the trio: a token URL and both secret refs, each on its own field", () => {
    const f = authFindings({ authStyle: "oauth2_client_credentials" });
    expect(f.map((x) => x.field).sort()).toEqual([
      "clientIdSecretRef", "clientSecretSecretRef", "tokenUrl",
    ]);
  });

  it("passes a complete, well-formed trio", () => {
    expect(
      authFindings({
        authStyle: "oauth2_client_credentials",
        tokenUrl: "https://auth.example.com/oauth2/token",
        clientIdSecretRef: "SWAPI_CLIENT_ID",
        clientSecretSecretRef: "SWAPI_CLIENT_SECRET",
      }),
    ).toEqual([]);
  });

  it("refuses a token URL that is not a full URL, and an http one outside localhost", () => {
    // The server accepts https only, with an http carve-out for localhost —
    // credentials cross the wire, so a plain http endpoint is a token leaked
    // in flight. The mirror says the same thing beside the field.
    const f = authFindings({
      authStyle: "oauth2_client_credentials",
      tokenUrl: "auth.example.com/token",
      clientIdSecretRef: "A",
      clientSecretSecretRef: "B",
    });
    expect(f.map((x) => x.field)).toEqual(["tokenUrl"]);
    expect(
      authFindings({
        authStyle: "oauth2_client_credentials",
        tokenUrl: "http://auth.example.com/oauth2/token",
        clientIdSecretRef: "A",
        clientSecretSecretRef: "B",
      }).map((x) => x.field),
    ).toEqual(["tokenUrl"]);
  });

  it("accepts an http token URL on localhost", () => {
    expect(
      authFindings({
        authStyle: "oauth2_client_credentials",
        tokenUrl: "http://localhost:9099/oauth2/token",
        clientIdSecretRef: "A",
        clientSecretSecretRef: "B",
      }),
    ).toEqual([]);
  });

  it("refuses refs that are not env-var identifiers", () => {
    const f = authFindings({
      authStyle: "oauth2_client_credentials",
      tokenUrl: "https://auth.example.com/token",
      clientIdSecretRef: "swapi client id",
      clientSecretSecretRef: "swapi client secret",
    });
    expect(f.map((x) => x.field).sort()).toEqual(["clientIdSecretRef", "clientSecretSecretRef"]);
    expect(f[0].message).toMatch(/env-var NAME/);
  });

  it("demands no single secretEnvName, and reads none", () => {
    // The oauth2 style's credentials live in the two refs; the server refuses a
    // secretEnvName for it, so this branch must neither require nor accept one.
    const f = authFindings({
      authStyle: "oauth2_client_credentials",
      secretEnvName: "SINGLE_SECRET",
      tokenUrl: "https://auth.example.com/token",
      clientIdSecretRef: "A",
      clientSecretSecretRef: "B",
    });
    expect(f.map((x) => x.field)).not.toContain("secretEnvName");
    expect(authFindings({ authStyle: "oauth2_client_credentials" }).map((x) => x.field))
      .not.toContain("secretEnvName");
  });

  it("never asks for an auth parameter name for oauth2", () => {
    expect(needsAuthParamName("oauth2_client_credentials")).toBe(false);
  });
});

describe("the credential picker", () => {
  it("offers the stored names plus the one already on the tool", () => {
    // ⚠ The union is what stops the picker losing a value. A tool may reference a
    // name with nothing stored under it — that is the state `/keys` and
    // `applyAuth`'s 424 exist to report — and a select built from stored names
    // alone would render it as having no credential, then clear the field on save.
    expect(secretNameOptions(["B_KEY", "A_KEY"], "UNSTORED_KEY")).toEqual([
      "A_KEY", "B_KEY", "UNSTORED_KEY",
    ]);
  });

  it("does not duplicate a name that is both stored and current", () => {
    expect(secretNameOptions(["A_KEY"], "A_KEY")).toEqual(["A_KEY"]);
  });

  it("reports presence and never content", () => {
    const secrets = [{ name: "A_KEY", hasValue: true }, { name: "B_KEY", hasValue: false }];
    expect(hasStoredValue(secrets, "A_KEY")).toBe(true);
    // Declared but unstored — the 424 case, which must read as "not stored".
    expect(hasStoredValue(secrets, "B_KEY")).toBe(false);
    expect(hasStoredValue(secrets, "MISSING")).toBe(false);
  });
});

describe("typeForMethod", () => {
  it("is the same derivation `toolFromFA` performs, in both directions", () => {
    expect(typeForMethod("GET")).toBe("read-only");
    expect(typeForMethod("head")).toBe("read-only");
    expect(typeForMethod("OPTIONS")).toBe("read-only");
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(typeForMethod(m)).toBe("changes data");
    }
  });
});
