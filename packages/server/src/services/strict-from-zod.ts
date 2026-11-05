/**
 * A strict JSON Schema DERIVED from a zod schema (builder-stability P1-I2, 2026-10-02) — so a model call whose reply is checked by
 * zod can also be DECODED to that shape by the gateway (`response_format: json_schema, strict`), and a reply cannot be malformed
 * JSON or the wrong shape by construction. The proposer spent whole attempts on unparseable replies; that class is gone.
 *
 * ⚠ ONE DEFINITION. The zod schema stays the authority: every refinement (exactly one of `param`/`value`, an identifier's
 * pattern, a fixed value's operator) is still checked by zod on the parsed reply, and its findings still drive the retry. This
 * schema only fixes the SHAPE — which properties exist, their types, enums and literals. Nothing here is written by hand, so it
 * cannot drift from the form.
 *
 * Strict mode's rules, followed exactly:
 * - every object lists all its properties in `required`, with `additionalProperties: false`; an OPTIONAL property (zod
 *   `.optional()` / `.default()`) is nullable instead, and `stripNulls` removes those nulls before zod parses, so zod's own
 *   optional/default handling applies unchanged;
 * - a recursive schema (`z.lazy`) becomes one `$defs` entry referenced by `$ref` (measured: the gateway decodes it);
 * - the root must be an object: a root union is wrapped as `{"reply": …}` (`ROOT_KEY`), unwrapped by `unwrapRoot`;
 * - every schema carries a `type` (Azure refuses a bare `const`): a string literal is a one-value enum.
 *
 * ⚠ A zod type this module does not know THROWS — a schema it cannot express is never sent half-expressed.
 */
import { z } from "zod";

export const ROOT_KEY = "reply";
type Json = Record<string, unknown>;

export function strictFromZod(schema: z.ZodTypeAny): { schema: Json; wrapped: boolean } {
  const defs: Record<string, Json> = {};
  const named = new Map<z.ZodTypeAny, string>();

  const conv = (s: z.ZodTypeAny): { out: Json; optional: boolean } => {
    const def = s._def as { typeName: string } & Record<string, unknown>;
    switch (def.typeName) {
      case "ZodOptional":
      case "ZodDefault":
        return { out: conv((def.innerType as z.ZodTypeAny)).out, optional: true };
      case "ZodNullable":
        return { out: { anyOf: [conv(def.innerType as z.ZodTypeAny).out, { type: "null" }] }, optional: false };
      case "ZodEffects": {
        const inner = conv(def.schema as z.ZodTypeAny);
        return inner;
      }
      case "ZodLazy": {
        const target = (def.getter as () => z.ZodTypeAny)();
        let name = named.get(target);
        if (!name) {
          name = `d${named.size}`;
          named.set(target, name);
          defs[name] = {}; // reserved before converting, so a cycle refers to it
          defs[name] = conv(target).out;
        }
        return { out: { $ref: `#/$defs/${name}` }, optional: false };
      }
      case "ZodObject": {
        const shape = (s as z.ZodObject<z.ZodRawShape>).shape;
        const properties: Json = {};
        for (const [k, v] of Object.entries(shape)) {
          const c = conv(v as z.ZodTypeAny);
          properties[k] = c.optional ? { anyOf: [c.out, { type: "null" }] } : c.out;
        }
        return { out: { type: "object", properties, required: Object.keys(properties), additionalProperties: false }, optional: false };
      }
      case "ZodArray": {
        const max = (def.maxLength as { value: number } | null)?.value;
        return { out: { type: "array", items: conv(def.type as z.ZodTypeAny).out, ...(max !== undefined ? { maxItems: max } : {}) }, optional: false };
      }
      case "ZodUnion":
      case "ZodDiscriminatedUnion": {
        const options = (def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>);
        const list = Array.isArray(options) ? options : [...options.values()];
        return { out: { anyOf: list.map((o) => conv(o).out) }, optional: false };
      }
      case "ZodString": return { out: { type: "string" }, optional: false };
      case "ZodNumber": {
        const int = ((def.checks as Array<{ kind: string }>) ?? []).some((c) => c.kind === "int");
        return { out: { type: int ? "integer" : "number" }, optional: false };
      }
      case "ZodBoolean": return { out: { type: "boolean" }, optional: false };
      case "ZodEnum": return { out: { type: "string", enum: [...(def.values as string[])] }, optional: false };
      // Azure's strict mode refuses a bare `const` ("schema must have a 'type' key", measured 2026-10-02): a string literal is a
      // one-value enum, any other literal its type with `const`.
      case "ZodLiteral": {
        const v = def.value;
        return { out: typeof v === "string" ? { type: "string", enum: [v] } : { type: typeof v === "number" ? "number" : "boolean", const: v }, optional: false };
      }
      default:
        throw new Error(`strictFromZod: ${def.typeName} has no strict JSON Schema form`);
    }
  };

  const root = conv(schema).out;
  const wrapped = root.type !== "object";
  const body: Json = wrapped ? { type: "object", properties: { [ROOT_KEY]: root }, required: [ROOT_KEY], additionalProperties: false } : root;
  return { schema: Object.keys(defs).length ? { ...body, $defs: defs } : body, wrapped };
}

/** The reply without the nulls strict mode made the model write for an absent optional property. */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== null) out[k] = stripNulls(x);
  return out;
}

/** The reply's own value, out of the `{"reply": …}` wrapper a root union is sent in. */
export const unwrapRoot = (v: unknown, wrapped: boolean): unknown =>
  wrapped && v && typeof v === "object" && ROOT_KEY in (v as Json) ? (v as Json)[ROOT_KEY] : v;
