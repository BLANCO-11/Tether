// src/lib/manifest-form.ts — turns a connector manifest's JSON-Schema onboarding form
// into the field list the wizard renders, and assembles the payload sent to the backend.
// This is what makes the Data Sources wizard fully manifest-driven: there is zero
// connector-specific code in the UI — every field comes from the backend-served schema.
//
// ── ⚠ `_vault` and `_credential_source` ARE GONE (D-117, I-122) ──────────────
//
// `buildPayload` used to take a `credentialSource`, and in `"vault"` mode it
// DROPPED the connector's own secret fields and attached two reserved keys:
// `payload._vault` (provider, address, path, the vault's own login, a key map)
// and `payload._credential_source`. Measured: `grep -rn "_vault\|_credential_source"
// packages/server/src` returned **zero hits**, and `assembleConnectionString`
// reads only `connection_string|url|dsn|uri`, `host`, `port`, `database`,
// `username|user`, `password` — never either key.
//
// So the whole path assembled a PASSWORD-LESS DSN, which the server then refused
// with `400 could not verify that this credential is read-only`. True, and it
// reads as a bug in the gate rather than as an unsupported choice.
//
// It is refused rather than implemented because it cannot pass the gates:
// `assertRegistrableTarget` (D-64) and `assertReadOnly` (D-40) connect at
// registration, from the registering process, and a vault-sourced DSN is not
// known until execution — so the row that existed would be the one unverified
// row in the system. `lib/connectors.ts`'s header states the rule this applies:
// inert is worse than refused. The wizard now says so on screen.
//
// The consequence for this file is that a payload is now just coerced schema
// values, with no reserved keys and no mode: every secret field is always sent,
// so `assembleConnectionString` always has a password to put in the DSN.
import type { JsonSchema } from "@/lib/types";

/** One rendered form field (a superset of a JSON-Schema property). */
export type FormField = {
  key: string; // where the value is stored (matches the schema property name)
  label: string;
  type?: "text" | "password" | "number" | "select" | "boolean" | "file";
  placeholder?: string;
  hint?: string;
  required?: boolean;
  options?: string[]; // for type: "select"
  default?: string; // stored as a string; coerced on submit
  half?: boolean; // render at half width (pairs into a 2-col grid)
  secret?: boolean; // format password/data-url ⇒ rendered masked, never read back
  integer?: boolean; // integer coercion
  min?: number;
  max?: number;
};

const humanize = (k: string) => k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Convert one JSON-Schema object into the fields the wizard renders. */
export function jsonSchemaToFields(schema?: JsonSchema): FormField[] {
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, prop]) => {
    const f: FormField = {
      key,
      label: prop.title ?? humanize(key),
      hint: prop.description,
      required: required.has(key),
      default: prop.default != null ? String(prop.default) : undefined,
      min: prop.minimum,
      max: prop.maximum,
    };
    if (prop.enum) { f.type = "select"; f.options = prop.enum.map(String); }
    else if (prop.format === "password") { f.type = "password"; f.secret = true; }
    else if (prop.format === "data-url") { f.type = "file"; f.secret = true; }
    else if (prop.type === "boolean") { f.type = "boolean"; }
    else if (prop.type === "integer") { f.type = "number"; f.integer = true; }
    else if (prop.type === "number") { f.type = "number"; }
    else { f.type = "text"; }
    return f;
  });
}

// ⚠ `isSecretField` and `secretFieldNames` WERE HERE and went with vault mode.
// Their only two callers were the vault key-map editor ("which key inside the
// fetched secret holds `password`") and `buildPayload`'s drop set. The `secret`
// flag itself stays — it is what makes a field render masked — but a helper whose
// only subject is a refused feature is scenery that reads like a capability.

/** Seed a values object with each field's default. */
export function initialValues(fields: FormField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

/** Coerce a collected string value back to its typed JSON value; "" ⇒ undefined (omit). */
export function coerceValue(f: FormField, raw: string): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (f.type === "boolean") return raw === "true" || raw === "Yes";
  if (f.type === "number") {
    const n = f.integer ? parseInt(raw, 10) : Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
  return raw; // text / password / select / file (data-url string)
}

/**
 * True when every required field has a value.
 *
 * ⚠ There is no `skipSecret` option any more, and there must not be one again.
 * It existed so vault mode could pass validation with the password box empty —
 * i.e. it is the check that let a password-less payload reach
 * `assembleConnectionString`. A required secret field is now required.
 */
export function requiredComplete(fields: FormField[], values: Record<string, string>): boolean {
  return fields.every((f) => !f.required || (values[f.key] ?? "").trim() !== "");
}

/**
 * Assemble the connector onboarding payload: coerced schema values, nothing else.
 *
 * ⚠ No reserved keys. `_credential_source` and `_vault` were attached here and no
 * server route has ever read either (see the header). A key the payload carries
 * and the server ignores is indistinguishable, from the browser, from a key that
 * works — which is how a whole credential mode stayed shipped and inert.
 */
export function buildPayload(
  fields: FormField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const c = coerceValue(f, values[f.key] ?? "");
    if (c !== undefined) payload[f.key] = c;
  }
  return payload;
}

/**
 * One reason a value is not acceptable.
 *
 * `rule` is the constraint that failed, so a caller can style or group without
 * matching on prose.
 */
export type FieldProblem = { field: string; rule: string; message: string };

/**
 * Check one value against the constraints this field ALREADY CARRIES.
 *
 * ⚠ **This closes the gap the guardrails roadmap named for V7 in exactly these
 * words:** `jsonSchemaToFields` *"carries `required`, `min`, `max` and `integer`
 * onto `FormField` and **nothing checks a value against them**. It is a
 * rendering seam, not a validating one."* That was true here until 2026-08-18 —
 * `requiredComplete` was the only check, so the wizard's Next button accepted
 * `abc` in a number field and `-5` under a `minimum: 1`, and the person found
 * out from a 400 one screen later with the server's wording rather than the
 * field's.
 *
 * ⚠ **It is UX and it is NOT the guardrail.** Every rule here exists server-side
 * first — that is the roadmap's own condition on client validation, and it is
 * why this function is allowed to be this small. It adds no rule of its own and
 * derives nothing: it checks the four constraints the backend's JSON Schema
 * already sent, which is the only version that cannot drift from the server.
 *
 * ⚠ Empty is NOT invalid here. Absence is `required`'s business, and reporting
 * "must be a number" over an untouched optional field turns a form into a wall
 * of red on first render.
 */
export function checkFormField(field: FormField, raw: string): FieldProblem[] {
  const trimmed = raw.trim();
  if (field.required && trimmed === "") {
    return [{ field: field.key, rule: "required", message: "This field is required" }];
  }
  if (trimmed === "") return [];

  // ⚠ Gated on the field being NUMERIC, not on the text parsing as a number. A
  // free-text field that happens to hold "5" must not acquire numeric bounds it
  // was never given.
  if (field.type === "number" || field.integer) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return [{ field: field.key, rule: "number", message: "Must be a number" }];
    }
    if (field.integer && !Number.isInteger(n)) {
      return [{ field: field.key, rule: "integer", message: "Must be a whole number" }];
    }
    const problems: FieldProblem[] = [];
    if (field.min !== undefined && n < field.min) {
      problems.push({ field: field.key, rule: "min", message: `Must be at least ${field.min}` });
    }
    if (field.max !== undefined && n > field.max) {
      problems.push({ field: field.key, rule: "max", message: `Must be at most ${field.max}` });
    }
    return problems;
  }

  return [];
}

/**
 * Every problem across a set of fields.
 *
 * ⚠ Returns them ALL rather than the first. A form that reveals one error at a
 * time makes a person submit four times to learn four things.
 */
export function checkFields(
  fields: FormField[],
  values: Record<string, string>,
): FieldProblem[] {
  return fields.flatMap((f) => checkFormField(f, values[f.key] ?? ""));
}
