/**
 * `tools.paramsSchema` is validated, and the refusal names the ENVELOPE.
 * foundations phase 1 · task 1.3 · I-125
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * `z.record(z.any()).optional()`. A jsonb column with nothing in front of it, so
 * a harness, an import or any API caller could store a JSON-Schema envelope —
 * `{type: "object", properties: {…}}` — and `manifest-builder.service.ts`, which
 * iterates `Object.entries` and reads `type`/`required`/`description` off each
 * value, would render **two nonsense parameters called `type` and `properties`**
 * into the flow drafter's prompt. Not hypothetical: the client's own edit form
 * wrote exactly that until I-39, and `jsonSchemaToParams` still reads it back.
 *
 * ── The two things these tests exist to hold ─────────────────────────────────
 *
 *  1. **The message names the shape.** A bare zod `invalid_type` on
 *     `paramsSchema.type` is technically true and sends the caller to delete a
 *     key rather than to change a shape — I-47's failure mode, where a wrong
 *     step kind reported itself as `steps: Required` and the retry prompt was fed
 *     that verbatim.
 *  2. **It does not cry wolf.** ⚠ I-62 is the record of the other approach: a
 *     guard written as "a pattern that resembles the defect" had three false
 *     positives and zero real ones, *and the widening people reach for permits
 *     the defect*. So the envelope is detected by something a flat map cannot
 *     contain, and three parameters legitimately named `type`, `properties` and
 *     `required` are asserted to pass.
 */
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_REFUSAL,
  QUERY_PARAM_TYPES,
  TOOL_PARAM_TYPES,
  looksLikeJsonSchemaEnvelope,
  queryParamDescriptor,
  toolParamsSchema,
} from "./param-descriptor.js";
import { createToolSchema, updateToolSchema } from "./tool.service.js";

const TOOL = { name: "t", url: "http://x.local/a", method: "GET" as const };

function refusalFor(paramsSchema: unknown): string[] {
  const r = createToolSchema.safeParse({ ...TOOL, paramsSchema });
  if (r.success) return [];
  return r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("the envelope is refused BY NAME", () => {
  it("names the envelope rather than reporting a bad `type` field", () => {
    // The exact shape the pre-I-39 client wrote, so every tool created in the UI
    // before that fix is in it.
    const messages = refusalFor({
      type: "object",
      properties: { note: { type: "string", description: "Free text" } },
      required: ["note"],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("paramsSchema:");
    expect(messages[0]).toContain(ENVELOPE_REFUSAL);
    // ⚠ And it must NOT be the bare zod message, which is the whole point.
    expect(messages[0]).not.toMatch(/expected object, received string/i);
  });

  it("refuses it on PATCH too, not only on create", () => {
    // `PATCH` is where it actually arrives: a client reads a stored tool and
    // writes it back, so the shape a route accepts has to be the same on both.
    const r = updateToolSchema.safeParse({ paramsSchema: { type: "object", properties: {} } });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]!.message).toContain(ENVELOPE_REFUSAL);
  });

  it("⚠ does not fire on parameters legitimately named type, properties or required", () => {
    // I-62, stated as three assertions. A flat map's values are descriptor
    // OBJECTS; the envelope's `type` is a string, its `required` is an array and
    // its `properties` holds descriptors. Those are the discriminators, and a
    // parameter can be called anything.
    expect(refusalFor({ type: { type: "string", required: true } })).toEqual([]);
    expect(refusalFor({ properties: { type: "object", required: true } })).toEqual([]);
    expect(refusalFor({ required: { type: "boolean", required: false } })).toEqual([]);
    expect(looksLikeJsonSchemaEnvelope({ type: { type: "string" } })).toBe(false);
    expect(looksLikeJsonSchemaEnvelope({ type: "object" })).toBe(true);
    expect(looksLikeJsonSchemaEnvelope({ required: ["a"] })).toBe(true);
  });
});

describe("a descriptor is strict, and stored exactly as sent", () => {
  it("refuses an unknown key instead of dropping it silently", () => {
    // zod strips by default, so `example` would have been accepted, discarded,
    // and reported nowhere — a field that looks stored and is not. Same class as
    // the inert vault mode (I-122): inert is worse than refused, because a
    // refusal names the reason in front of whoever chose it.
    const messages = refusalFor({ id: { type: "string", required: true, example: "5" } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("paramsSchema.id:");
    expect(messages[0]).toMatch(/`type`, `required` and an optional `description`/);
  });

  it("⚠ adds no key the caller did not send", () => {
    // ⚠ The reason the tool descriptor has no `.default()` while the query one
    // does. `refFingerprints()` hashes `paramsSchema` WHOLE, so a default filled
    // in here is written back to the column, moves the tool's fingerprint, and
    // the staleness sweep unarms every flow using it — for a save the author
    // believed changed nothing. That is I-39 arriving as a convenience.
    const r = createToolSchema.safeParse({ ...TOOL, paramsSchema: { id: { type: "string" } } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.paramsSchema).toEqual({ id: { type: "string" } });
  });

  it("carries the parameter name in the issue path, so a form can place it", () => {
    const r = createToolSchema.safeParse({
      ...TOOL,
      paramsSchema: { good: { type: "string", required: true }, bad: { type: "uuid" } },
    });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]!.path).toEqual(["paramsSchema", "bad", "type"]);
  });

  it("treats an absent paramsSchema as 'no parameters' and does not invent one", () => {
    const r = createToolSchema.safeParse({ ...TOOL });
    expect(r.success).toBe(true);
    expect(r.success && r.data.paramsSchema).toBeUndefined();
  });
});

describe("⚠ the two type vocabularies differ, and the live rows are why", () => {
  it("accepts the types the seeded tools actually use", () => {
    // ⚠ MEASURED against `foundry_parent` on 2026-08-10 before this schema was
    // written: 128 stored tool descriptors across 3 workspaces, using `integer`
    // (20), `array` (19) and `object` (2) as well as `string` — `blocks` on
    // `chat_post_message`, `recipients`/`cc`/`attachments` on `mail_send`,
    // `variables` on `mail_send_template`.
    //
    // Every one is written by a seeder that goes through `createToolSchema.parse`
    // (`demo/provision.ts:127`, `demo/finance/provision-finance.ts:113`,
    // `demo/alt/provision-alt.ts:108`). Narrowing this enum to the query
    // vocabulary would therefore have broken `demo:seed`, `finance:seed`,
    // `demo:seed-alt` and `showcase:seed` outright — I-36's shape, a gate that
    // refuses the thing it exists to protect.
    for (const type of ["string", "integer", "array", "object"]) {
      expect(refusalFor({ p: { type, required: true } })).toEqual([]);
    }
  });

  it("keeps a QUERY parameter to scalars, because it binds to a positional $n", () => {
    // The other direction, and it is not symmetric. `array` is dialect-specific
    // and `object` binds nothing, so accepting them would let an author declare
    // a type the SQL can never honour — and advertise it through
    // `refInterfaces()` to another tenant, which is the one check an IMPORT is
    // made against (D-25).
    expect(queryParamDescriptor.safeParse({ type: "array", required: true }).success).toBe(false);
    expect(queryParamDescriptor.safeParse({ type: "integer", required: true }).success).toBe(false);
    expect(queryParamDescriptor.safeParse({ type: "date", required: true }).success).toBe(true);
  });

  it("keeps the query defaults, because that shape was already in use", () => {
    // Unchanged from the original `paramDescriptor`. `checkSqlShape` requires a
    // descriptor per declared parameter, and its message says an undescribed one
    // is "a type assertion nobody made" — the default is what makes that
    // sentence true.
    expect(queryParamDescriptor.parse({})).toEqual({ type: "string", required: true });
  });

  it("⚠ pins QUERY_PARAM_TYPES verbatim — NamedQueryPanel.tsx mirrors this list", () => {
    // There is no endpoint serving these four values, so
    // `packages/client/src/components/data/NamedQueryPanel.tsx` declares them as
    // a mirror in a `<select>`. This assertion is the guard from the other side:
    // adding a fifth type goes red HERE, which points at the file that has to
    // learn about it. Without it the failure is a select that silently never
    // offers the new type — `lib/connectors.ts`'s trap, in the direction nobody
    // notices.
    expect([...QUERY_PARAM_TYPES]).toEqual(["string", "number", "boolean", "date"]);
    expect([...TOOL_PARAM_TYPES]).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "date",
      "array",
      "object",
    ]);
  });
});

describe("the record itself", () => {
  it("is optional and reports every bad descriptor at once", () => {
    expect(toolParamsSchema.safeParse(undefined).success).toBe(true);
    const r = toolParamsSchema.safeParse({ a: { type: "uuid" }, b: { type: "string", nope: 1 } });
    expect(r.success).toBe(false);
    // Both, not the first. An author fixing one rule per round-trip is how a
    // correct rule gets worked around — `checkSqlShape`'s own argument.
    expect(r.success === false && r.error.issues).toHaveLength(2);
  });
});
