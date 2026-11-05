/**
 * Strict JSON Schema, the subset the new builder sends as `response_format` (compiled-builder D-307) — and the validator the
 * server runs over every reply against the SAME schema object.
 *
 * ⚠ The gateway decodes only replies the schema admits (E0.1), so a reply that fails here is a GATEWAY defect: it is logged
 * and refused, never sent back to the model (D-307 — a corrective pass would weaken P1 from "cannot" to "refused before
 * save"). The validator is exact on the subset and REFUSES any schema keyword outside it, so a schema this module cannot
 * judge is never sent: one definition of what a reply may be.
 *
 * The subset is what OpenAI-style strict mode requires anyway: every object lists all its properties in `required` and sets
 * `additionalProperties: false`; optional values are `anyOf [X, {type: "null"}]`.
 */
export type Schema =
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false; description?: string }
  | { type: "array"; items: Schema; description?: string; maxItems?: number }
  | { type: "string"; enum?: string[]; description?: string }
  | { type: "integer" | "number" | "boolean" | "null"; description?: string }
  | { anyOf: Schema[]; description?: string }
  | { const: string | number | boolean; description?: string }
  /** A recursive part, defined once in the root's `$defs` (P1-I2: the read form's computed values nest; measured accepted). */
  | { $ref: string; description?: string };

const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "const", "description", "maxItems", "$ref", "$defs"]);
type Defs = Record<string, Schema>;
const refName = (r: string) => (r.startsWith("#/$defs/") ? r.slice("#/$defs/".length) : null);

/** Builders — each makes a schema strict mode accepts. */
export const S = {
  obj: (properties: Record<string, Schema>, description?: string): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) }),
  arr: (items: Schema, maxItems?: number, description?: string): Schema => ({ type: "array", items, ...(maxItems ? { maxItems } : {}), ...(description ? { description } : {}) }),
  str: (description?: string): Schema => ({ type: "string", ...(description ? { description } : {}) }),
  oneOf: (values: string[], description?: string): Schema => ({ type: "string", enum: [...values], ...(description ? { description } : {}) }),
  num: (description?: string): Schema => ({ type: "number", ...(description ? { description } : {}) }),
  int: (description?: string): Schema => ({ type: "integer", ...(description ? { description } : {}) }),
  bool: (description?: string): Schema => ({ type: "boolean", ...(description ? { description } : {}) }),
  nullable: (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] }),
  any: (...ss: Schema[]): Schema => ({ anyOf: ss }),
  lit: (v: string): Schema => ({ const: v }),
};

/**
 * The gateway refuses a schema with more than this many enum values IN TOTAL ("Expected at most 1000 enum values in total within a
 * single schema when using structured outputs") — before the model sees anything, as a 400 the person reads as `internal_error`.
 */
export const ENUM_BUDGET = 1000;
/** Every enum value in `schema`, counted as the gateway counts them (each occurrence, however often a list repeats). */
export function enumCount(schema: Schema): number {
  if ("$ref" in schema) return 0;
  const defs = (schema as { $defs?: Defs }).$defs;
  if (defs) { const { $defs: _d, ...rest } = schema as Schema & { $defs: Defs }; void _d; return enumCount(rest as Schema) + Object.values(defs).reduce((n, x) => n + enumCount(x), 0); }
  if ("anyOf" in schema) return schema.anyOf.reduce((n, x) => n + enumCount(x), 0);
  if ("const" in schema) return 0;
  if (schema.type === "object") return Object.values(schema.properties).reduce((n, x) => n + enumCount(x), 0);
  if (schema.type === "array") return enumCount(schema.items);
  return schema.type === "string" ? schema.enum?.length ?? 0 : 0;
}

/** Why `schema` is not in the subset, or `null`. Called before a schema is sent. */
export function schemaProblem(schema: unknown, at = "$", defs?: Defs): string | null {
  if (!schema || typeof schema !== "object") return `${at}: not a schema`;
  const o = schema as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) return `${at}: keyword \`${k}\` is outside the strict subset`;
  if ("$defs" in o) {
    if (at !== "$") return `${at}: \`$defs\` belongs on the root only`;
    const d = o.$defs as Defs;
    const { $defs: _d, ...rest } = o; void _d;
    for (const [k, v] of Object.entries(d)) { const p = schemaProblem(v, `$defs.${k}`, d); if (p) return p; }
    return schemaProblem(rest, at, d);
  }
  // Azure refuses a `$ref` beside any other keyword ("$ref cannot have keywords {'description'}", measured 2026-10-02).
  if ("$ref" in o && Object.keys(o).length > 1) return `${at}: \`$ref\` cannot carry other keywords (${Object.keys(o).filter((k) => k !== "$ref").join(", ")})`;
  if ("$ref" in o) { const n = refName(String(o.$ref)); return n && defs?.[n] ? null : `${at}: \`$ref\` ${String(o.$ref)} names no definition`; }
  if ("anyOf" in o) { const xs = o.anyOf as unknown[]; if (!Array.isArray(xs) || !xs.length) return `${at}: empty anyOf`; for (const [i, x] of xs.entries()) { const p = schemaProblem(x, `${at}.anyOf[${i}]`, defs); if (p) return p; } return null; }
  if ("const" in o) return null;
  switch (o.type) {
    case "object": {
      const props = o.properties as Record<string, unknown>;
      if (!props || typeof props !== "object") return `${at}: object without properties`;
      const req = o.required as unknown[];
      if (!Array.isArray(req) || req.length !== Object.keys(props).length || Object.keys(props).some((k) => !req.includes(k))) return `${at}: strict mode requires every property in \`required\``;
      if (o.additionalProperties !== false) return `${at}: strict mode requires additionalProperties: false`;
      for (const [k, v] of Object.entries(props)) { const p = schemaProblem(v, `${at}.${k}`, defs); if (p) return p; }
      return null;
    }
    case "array": return schemaProblem(o.items, `${at}[]`, defs);
    case "string": if (o.enum !== undefined && (!Array.isArray(o.enum) || !o.enum.length || new Set(o.enum).size !== o.enum.length)) return `${at}: enum must be non-empty and distinct`; return null;
    case "integer": case "number": case "boolean": case "null": return null;
    default: return `${at}: unknown type ${JSON.stringify(o.type)}`;
  }
}

/** Why `v` does not conform to `schema`, or `null`. Exact on the subset. */
export function validate(schema: Schema, v: unknown, at = "$", defs?: Defs): string | null {
  const own = (schema as { $defs?: Defs }).$defs;
  if (own) defs = own;
  if ("$ref" in schema) { const n = refName(schema.$ref), d = n ? defs?.[n] : undefined; return d ? validate(d, v, at, defs) : `${at}: \`$ref\` ${schema.$ref} names no definition`; }
  if ("anyOf" in schema) return schema.anyOf.some((s) => validate(s, v, at, defs) === null) ? null : `${at}: matches none of ${schema.anyOf.length} alternatives`;
  if ("const" in schema) return v === schema.const ? null : `${at}: expected ${JSON.stringify(schema.const)}`;
  switch (schema.type) {
    case "null": return v === null ? null : `${at}: expected null`;
    case "boolean": return typeof v === "boolean" ? null : `${at}: expected a boolean`;
    case "integer": return typeof v === "number" && Number.isInteger(v) ? null : `${at}: expected an integer`;
    case "number": return typeof v === "number" && Number.isFinite(v) ? null : `${at}: expected a number`;
    case "string":
      if (typeof v !== "string") return `${at}: expected a string`;
      return schema.enum && !schema.enum.includes(v) ? `${at}: "${v.slice(0, 40)}" is not one of the ${schema.enum.length} allowed values` : null;
    case "array": {
      if (!Array.isArray(v)) return `${at}: expected an array`;
      if (schema.maxItems !== undefined && v.length > schema.maxItems) return `${at}: more than ${schema.maxItems} items`;
      for (const [i, x] of v.entries()) { const e = validate(schema.items, x, `${at}[${i}]`, defs); if (e) return e; }
      return null;
    }
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${at}: expected an object`;
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!(k in schema.properties)) return `${at}: unexpected property \`${k}\``;
      for (const k of schema.required) if (!(k in o)) return `${at}: missing \`${k}\``;
      for (const [k, s] of Object.entries(schema.properties)) { const e = validate(s, o[k], `${at}.${k}`, defs); if (e) return e; }
      return null;
    }
  }
}

/** A reply that failed the schema the gateway enforced — a gateway defect (D-307), carried with the label for the log. */
export class GatewayDefect extends Error {
  /** An upstream defect, not the caller's: 502, whose body the error handler redacts to `upstream_error` + request id. */
  readonly statusCode = 502;
  constructor(message: string, readonly label: string, readonly reply: string) { super(message); this.name = "GatewayDefect"; }
}

/** Parse + validate one strict reply. Throws `GatewayDefect`; never repairs. */
export function parseStrict<T>(schema: Schema, reply: string, label: string): T {
  let v: unknown;
  try { v = JSON.parse(reply); } catch { throw new GatewayDefect(`the reply is not JSON though the schema was enforced`, label, reply); }
  const bad = validate(schema, v);
  if (bad) throw new GatewayDefect(`the reply breaks the schema the gateway enforced: ${bad}`, label, reply);
  return v as T;
}
