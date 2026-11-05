/**
 * One parameter descriptor shape, for both kinds of callable ref.
 *
 * A flow's catalogue holds exactly two kinds of thing a step can call — a tool
 * and a named query — and a person authoring either one is describing the same
 * thing: what this parameter is called, what type it is, whether it has to be
 * supplied, and what it MEANS. Until now only one of the two said so in code.
 * `datasource-query.service.ts` had a `paramDescriptor` with a type enum, a
 * required flag and a bounded description; `tool.service.ts` had
 * `z.record(z.any()).optional()` — a jsonb column with nothing in front of it
 * (**I-125**).
 *
 * ── Why the shape is worth validating at all ─────────────────────────────────
 *
 * `manifest-builder.service.ts` does `Object.entries(paramsSchema)` and reads
 * `type` / `required` / `description` off each value. So the map is FLAT —
 * `{name: {type, required, description}}` — and a JSON-Schema envelope
 * (`{type: "object", properties: {…}}`) renders **two nonsense parameters called
 * `type` and `properties`** into the drafter's prompt. That is not hypothetical:
 * the client's own edit form wrote the envelope until I-39, and every tool
 * created through the UI before that fix is in that shape. `jsonSchemaToParams`
 * on the client still reads it for exactly that reason.
 *
 * The refusal therefore has to NAME the envelope. A bare zod `invalid_type` on
 * `paramsSchema.type` sends the caller to fix a field that should not exist,
 * which is the same failure mode as I-47: a wrong shape reporting itself as a
 * missing key.
 *
 * ── Why the two type vocabularies differ, and must ───────────────────────────
 *
 * They were going to be one enum. Measured against the live `foundry_parent`
 * first (2026-08-10), which is what stopped that:
 *
 *   • 128 stored tool descriptors across 3 workspaces, using **`integer`**
 *     (20), **`array`** (19) and **`object`** (2) as well as `string` — a
 *     `blocks` array on `chat_post_message`, `recipients` on `mail_send`,
 *     `variables` on `mail_send_template`.
 *   • every one of those rows is written by a seeder that goes through
 *     `createToolSchema.parse` (`demo/provision.ts:127`,
 *     `demo/finance/provision-finance.ts:113`, `demo/alt/provision-alt.ts:108`).
 *
 * So narrowing tools to the query vocabulary would have refused every seeded
 * tool and broken `demo:seed`, `finance:seed`, `demo:seed-alt` and
 * `showcase:seed` outright — I-36's shape, a gate that refuses the thing it was
 * written to protect. And widening the QUERY vocabulary to match is worse in the
 * other direction: a named query's parameter binds to a positional `$n` in SQL,
 * where `array` is at best dialect-specific and `object` binds nothing at all,
 * so accepting them would let an author declare a type the query can never
 * honour and advertise it through `refInterfaces()` to another tenant (D-25).
 *
 * What IS shared is everything that actually caused the defects: the flat map,
 * the strictness, the bounded description, and the envelope refusal.
 */

import { z } from "zod";

/**
 * What a named query's parameter can be.
 *
 * Unchanged from the original `paramDescriptor` in
 * `datasource-query.service.ts`. A parameter here binds to `$1`, `$2` … in
 * `runNamedQuery`, so the set is scalars only.
 *
 * ⚠ `services/param-descriptor.test.ts` asserts this list verbatim, because
 * `components/data/NamedQueryPanel.tsx` offers these four values in a select and
 * has no way to learn about a fifth. A silent mirror is how a UI ends up
 * offering a type the server refuses (`lib/connectors.ts`'s lesson, one subject
 * along).
 */
export const QUERY_PARAM_TYPES = ["string", "number", "boolean", "date"] as const;

/**
 * What a tool's parameter can be.
 *
 * A superset, and every extra member is here because a live row uses it — see
 * the header. `integer` is kept distinct from `number` rather than normalised
 * to it: normalising would rewrite 20 stored descriptors on their next save,
 * and `paramsSchema` is hashed WHOLE by `refFingerprints()`, so that save would
 * move the tool's fingerprint and the staleness sweep would unarm every flow
 * using it. That is I-39 arriving as a tidy-up.
 */
export const TOOL_PARAM_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "array",
  "object",
] as const;

/**
 * Machine-readable value shapes a tool parameter can declare.
 *
 * `type` says the JSON kind (`string` covers both a month and free prose);
 * `format` says which SHAPE of string the reader enforces, so a compatibility
 * check can tell a YYYY-MM feeder from unconstrained prose without parsing
 * descriptions. Absent means unconstrained prose — never a block.
 *
 * The semantics live in `packages/ops-api/src/routes/ops.ts` (`periodParam`
 * enforces the `month` shape, `dateParam` the `date` shape); nothing here
 * duplicates those regexes, it only names which one applies.
 */
export const PARAM_FORMATS = ["month", "date", "datetime", "text"] as const;
export type ParamFormat = (typeof PARAM_FORMATS)[number];

/**
 * The message a caller sending `{type, properties}` gets.
 *
 * Exported so a test can assert the wording rather than a substring of it: the
 * whole value of this refusal is that it names the shape, and a test matching
 * `/invalid/` would pass over a bare zod message.
 */
export const ENVELOPE_REFUSAL =
  "this is a JSON-Schema envelope; a tool's `paramsSchema` is the flat " +
  "`{name:{type,required,description,format}}` map — an envelope renders two nonsense parameters " +
  "called `type` and `properties`";

const STRICT_REFUSAL =
  "a parameter descriptor holds exactly `type`, `required` and an optional `description`. " +
  "Nothing else is stored or rendered, so an extra key here would look saved and would not be";

const TOOL_STRICT_REFUSAL =
  "a parameter descriptor holds exactly `type`, `required` and an optional `description`, plus an optional `format`. " +
  "Nothing else is stored or rendered, so an extra key here would look saved and would not be";

/**
 * Is this map the JSON-Schema envelope rather than the flat descriptor map?
 *
 * ⚠ Deliberately checks for something a flat map CANNOT contain, not for a
 * pattern that resembles one. **I-62** is the record of the other approach: a
 * guard that flagged `createdBy: z.string()` had three false positives and zero
 * real ones, and the widening people reach for then permits the defect.
 *
 * A flat map's every value is a descriptor OBJECT. So:
 *
 *   • `type` with a STRING value can only be `type: "object"` from an envelope —
 *     a parameter legitimately named `type` has `{type: "string", …}` there.
 *   • `required` with an ARRAY value is the envelope's required-names list; a
 *     parameter named `required` has an object.
 *   • `properties` whose values are all objects is the envelope's body. A
 *     parameter named `properties` has `{type: "object", required: true}`, whose
 *     values are a string and a boolean.
 *
 * Any one of the three is conclusive. None of them can be produced by the flat
 * map, which is why this reports the envelope rather than guessing at it.
 */
export function looksLikeJsonSchemaEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type === "string") return true;
  if (Array.isArray(v.required)) return true;
  const props = v.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const entries = Object.values(props as Record<string, unknown>);
    if (entries.every((e) => e !== null && typeof e === "object")) return true;
  }
  return false;
}

/**
 * One descriptor, for one parameter.
 *
 * `.strict()` is the half that took the argument. zod strips unknown keys by
 * default, so `{type, required, description, example}` would have been stored as
 * the first three and the caller would never learn that `example` went nowhere —
 * a field that looks stored and is not, which is the same class of defect as the
 * inert vault mode (I-122) and as `paramsSchema` being unvalidated in the first
 * place. Refusing names it in front of whoever wrote it.
 *
 * @param types the vocabulary for this ref kind
 * @param opts  `defaults: false` validates without inventing keys — see below
 */
function descriptor<T extends readonly [string, ...string[]]>(
  types: T,
  opts: { defaults: boolean; format: boolean; constant?: boolean },
) {
  const type = z.enum(types);
  const required = z.boolean();
  return z
    .object(
      opts.defaults
        ? {
            type: type.default(types[0] as T[number]),
            required: required.default(true),
            description: z.string().max(2000).optional(),
            // Never defaulted — absent means unconstrained, and a key a PATCH gained would move the fingerprint.
            ...(opts.format ? { format: z.enum(PARAM_FORMATS).optional() } : {}),
          }
        : {
            // ⚠ No `.default()`, on purpose, and this is not a stylistic
            // difference from the query descriptor below.
            //
            // A default here does not just fill a gap in the parsed value — it
            // is written back to `tools.params_schema`, and `refFingerprints()`
            // hashes that column WHOLE. So a PATCH that echoed a stored
            // descriptor back would gain a key it did not have, move the tool's
            // fingerprint, and the sweep would unarm every flow using it.
            // Pressing Save on an unchanged tool disarming automations is
            // precisely I-39, and a default is a quiet way to reintroduce it.
            //
            // Absent keys keep the behaviour they already have:
            // `manifest-builder` renders `type="string" required="false"` for a
            // descriptor that omits them, and has since it was written.
            // `format` follows the same rule: absent means unconstrained prose
            // and is never defaulted to `text`, for the same fingerprint reason.
            type: type.optional(),
            required: required.optional(),
            description: z.string().max(2000).optional(),
            ...(opts.format ? { format: z.enum(PARAM_FORMATS).optional() } : {}),
            // A date compared BY ITS MONTH (2026-10-01): declared by the operator that reads it (`month`), so any day of the month
            // is the month. Absent means the date is a day — and absent keys never move a fingerprint, as above.
            ...(opts.format ? { per: z.enum(["month"]).optional() } : {}),
            // compiled-builder phase 5 (D-323): the value the catalogue itself STATES for this parameter — "Use 'prod'" as
            // data, not prose. A string in the engine's literal form ("true", "3"); whether it fits the port is the
            // engine's `literalFits`, checked again wherever it is bound. Operations only: a tool's descriptor stays as
            // it was, because the client's tool form round-trips it (I-39) and knows no such key.
            ...(opts.constant ? { default: z.string().min(1).max(200).optional() } : {}),
          },
    )
    .strict(opts.format ? TOOL_STRICT_REFUSAL : STRICT_REFUSAL);
}

/**
 * A named query's parameter. Defaults preserved — this is the original shape. It may declare a `format` (2026-09-29, flow
 * d3c79698): a query's SQL is what enforces a month (`to_date($1, 'YYYY-MM')`), and without the declaration a person's
 * "monthly" type-checked and failed at run time. Absent still means unconstrained.
 */
export const queryParamDescriptor = descriptor(QUERY_PARAM_TYPES, { defaults: true, format: true });

/** A tool's parameter. Validated, never rewritten — see `descriptor`. */
export const toolParamDescriptor = descriptor(TOOL_PARAM_TYPES, { defaults: false, format: true });
/** A DB operation's parameter: the tool descriptor plus an optional catalogue-stated `default` (D-323). */
export const operationParamDescriptor = descriptor(TOOL_PARAM_TYPES, { defaults: false, format: true, constant: true });

/**
 * A tool's whole `paramsSchema`, with the envelope refused BY NAME.
 *
 * The order matters and is the reason this is not simply
 * `z.record(toolParamDescriptor)`. Handed an envelope, that schema reports
 * `paramsSchema.type: expected object, received string` — true, useless, and it
 * points at a key the caller should delete rather than at the shape they should
 * change. So the envelope is decided first and returns on its own, and only a
 * map that is not an envelope is checked descriptor by descriptor.
 *
 * Per-descriptor issues carry the parameter name in their path, so a client can
 * put the message beside the row it belongs to.
 */
export const toolParamsSchema = z
  .record(z.unknown())
  .superRefine((val, ctx) => {
    if (looksLikeJsonSchemaEnvelope(val)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: ENVELOPE_REFUSAL, path: [] });
      return;
    }
    for (const [name, raw] of Object.entries(val)) {
      const parsed = toolParamDescriptor.safeParse(raw);
      if (parsed.success) continue;
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: [name, ...issue.path] });
      }
    }
  })
  .optional();
