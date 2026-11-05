// src/lib/manifest-form.test.ts — the connector payload, after vault mode was
// refused. D-117, I-122, foundations Phase 1.4.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// `buildPayload` is the seam where the defect lived, and no test watched it. In
// `"vault"` mode it DROPPED every secret field and attached two reserved keys —
// `_vault` and `_credential_source` — that no route in `packages/server` has ever
// read (measured: zero hits). So the wizard produced a payload the browser had
// every reason to think was complete, `assembleConnectionString` built a
// password-less DSN out of it, and the person got
// `400 could not verify that this credential is read-only`.
//
// Deleting the branch is the fix; these assertions are what stop it coming back
// as a helpful-looking option. ⚠ The second one is the load-bearing half: a
// reserved key that the server ignores is indistinguishable, from here, from one
// that works, which is exactly why it survived so long.
import { describe, expect, it } from "vitest";
import {
  buildPayload,
  checkFields,
  checkFormField,
  coerceValue,
  jsonSchemaToFields,
  requiredComplete,
  type FormField,
} from "@/lib/manifest-form";

const PG: FormField[] = [
  { key: "host", label: "Host", type: "text", required: true },
  { key: "port", label: "Port", type: "number", integer: true, required: true, default: "5432" },
  { key: "database", label: "Database", type: "text", required: true },
  { key: "username", label: "Username", type: "text", required: true },
  { key: "password", label: "Password", type: "password", secret: true, required: true },
  { key: "sslmode", label: "SSL mode", type: "select", options: ["require", "disable"] },
];

const FILLED = {
  host: "db.internal",
  port: "5432",
  database: "people",
  username: "reader",
  password: "s3cret",
};

describe("buildPayload carries the connector's own fields and nothing else", () => {
  it("includes the secret field — the DSN needs a password in it", () => {
    // The vault branch dropped exactly this key, which is the whole defect.
    expect(buildPayload(PG, FILLED)).toEqual({
      host: "db.internal",
      port: 5432,
      database: "people",
      username: "reader",
      password: "s3cret",
    });
  });

  it("⚠ attaches no reserved key the server does not read", () => {
    const payload = buildPayload(PG, FILLED);
    for (const key of Object.keys(payload)) {
      expect(key.startsWith("_"), `${key} is a reserved key — no server route reads one`).toBe(
        false,
      );
    }
    expect(payload).not.toHaveProperty("_vault");
    expect(payload).not.toHaveProperty("_credential_source");
  });

  it("omits empty values rather than sending blanks", () => {
    // `""` for a port would coerce to NaN and for a password would build a DSN
    // with an empty credential — the gate would refuse it and blame the database.
    expect(buildPayload(PG, { ...FILLED, sslmode: "" })).not.toHaveProperty("sslmode");
  });
});

describe("a required secret is required", () => {
  it("refuses to call the details step complete with the password empty", () => {
    // `requiredComplete` used to take `{ skipSecret: true }`, which is the check
    // that let a password-less payload through in vault mode. There is no option.
    expect(requiredComplete(PG, { ...FILLED, password: "" })).toBe(false);
    expect(requiredComplete(PG, FILLED)).toBe(true);
  });

  it("ignores optional fields", () => {
    expect(requiredComplete(PG, FILLED)).toBe(true); // sslmode unset
  });
});

describe("the field list still comes from the manifest, not from code", () => {
  it("marks a password-formatted property secret and coerces an integer", () => {
    const fields = jsonSchemaToFields({
      type: "object",
      properties: {
        port: { type: "integer", default: 5432 },
        password: { type: "string", format: "password" },
      },
      required: ["port"],
    });
    const port = fields.find((f) => f.key === "port")!;
    const password = fields.find((f) => f.key === "password")!;
    expect(port.required).toBe(true);
    expect(coerceValue(port, "5433")).toBe(5433);
    expect(password.secret).toBe(true);
    expect(password.type).toBe("password");
  });
});

/**
 * ⚠ **The gap this closes was named in the guardrails roadmap and was still open
 * here:** `jsonSchemaToFields` *"carries `required`, `min`, `max` and `integer`
 * onto `FormField` and nothing checks a value against them"*. So the wizard's
 * Next button accepted `abc` in a numeric field and `-5` under a `minimum: 1`,
 * and the refusal arrived from the server one action later in the server's
 * words, with nothing pointing at the box that was wrong.
 */
describe("checkFormField — the field's own constraints, actually checked", () => {
  const num = (over: Partial<FormField> = {}): FormField => ({
    key: "port",
    label: "Port",
    type: "number",
    ...over,
  });

  it("accepts a value inside the declared bounds", () => {
    expect(checkFormField(num({ min: 1, max: 65535 }), "5432")).toEqual([]);
  });

  it("⚠ rejects text in a numeric field — the case the wizard used to pass", () => {
    expect(checkFormField(num(), "abc")[0]!.rule).toBe("number");
  });

  it("⚠ rejects a value under `minimum` — the other case that used to pass", () => {
    expect(checkFormField(num({ min: 1 }), "-5")[0]!.rule).toBe("min");
  });

  it("rejects a value over `maximum`", () => {
    expect(checkFormField(num({ max: 65535 }), "70000")[0]!.rule).toBe("max");
  });

  it("rejects a fraction where the schema said integer", () => {
    expect(checkFormField(num({ integer: true }), "1.5")[0]!.rule).toBe("integer");
  });

  it("reports BOTH bounds problems it finds rather than only the first", () => {
    // min and max cannot both fail on one number, so this pins the plural path
    // via the field that can: a non-integer that is also out of range.
    const problems = checkFormField(num({ integer: true, min: 10 }), "1.5");
    expect(problems.map((p) => p.rule)).toContain("integer");
  });

  it("⚠ empty is NOT invalid unless the field is required", () => {
    // Otherwise a form paints itself red before anyone has typed anything.
    expect(checkFormField(num({ min: 1 }), "")).toEqual([]);
    expect(checkFormField(num({ min: 1, required: true }), "")[0]!.rule).toBe("required");
  });

  it("⚠ does NOT apply numeric bounds to a text field that happens to hold a number", () => {
    // A free-text field must not acquire constraints it was never given.
    const text: FormField = { key: "host", label: "Host", type: "text", min: 100 };
    expect(checkFormField(text, "5")).toEqual([]);
  });

  it("ignores a field with no constraints at all", () => {
    expect(checkFormField({ key: "note", label: "Note" }, "anything")).toEqual([]);
  });

  it("checkFields reports across the whole set, so one submit reveals everything", () => {
    const fields = [num({ key: "a", min: 1 }), num({ key: "b", integer: true })];
    const problems = checkFields(fields, { a: "-1", b: "2.5" });
    expect(problems.map((p) => p.field).sort()).toEqual(["a", "b"]);
  });
});
