// src/lib/schema-allowlist.ts — the "schemas to read" field, parsed.
//
// ── WHY THE FIELD EXISTS AT ALL (I-123) ─────────────────────────────────────
//
// `createConnection` sent `{name, type, connectionString}` and nothing else,
// though `createDatasourceInputSchema` has accepted `schemaAllowlist` since
// WS-C.1. So every datasource registered in the browser was confined to
// `public`: `refreshSchema` introspected `public` alone, and every table in a
// named schema was invisible to the manifest and therefore to the drafter — a
// datasource that registers cleanly and can answer nothing.
//
// ── ⚠ WIDENING IS A GATE, NOT A PREFERENCE ──────────────────────────────────
//
// `datasourceService.create` passes this list straight into `assertReadOnly`
// (D-40), and `update` re-runs it whenever the list changes: a role can be
// read-only in `public` and an owner in the schema just added. So naming a second
// schema can be **refused**, with `findings` naming the privilege it found. That
// refusal is the product working, and the wizard renders the findings rather than
// a paraphrase.
//
// ── ⚠ THIS VALIDATION IS A MIRROR, NEVER THE CONTROL ────────────────────────
//
// `schemaAllowlistSchema` in `services/datasource.service.ts` is the authority:
// 1–20 entries, each 1–63 chars matching `^[A-Za-z_][A-Za-z0-9_$]*$`, because the
// names are interpolated into the introspection query as a parameterised array
// and an unquotable name should fail at registration rather than there. The copy
// below exists so a typo is named beside the box instead of arriving as a zod
// issue path, and it is deliberately identical — same direction of protection as
// `connectors.test.ts`'s `REGISTRABLE`: if the server ever tightens, this stays
// green while being wrong in the permissive direction, and the server still
// refuses. Never treat a green parse here as permission.

/** The server's own rule, copied deliberately. See the header. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_SCHEMAS = 20;
const MAX_LEN = 63;

/** What the product introspects when nobody says otherwise — and what the server defaults to. */
export const DEFAULT_SCHEMAS = ["public"];

export type SchemaListParse = {
  /** The names to send, in the order typed, de-duplicated. */
  schemas: string[];
  /** Each rejected token with the reason, for rendering beside the field. */
  rejected: Array<{ token: string; why: string }>;
  /** False when there is nothing sendable, or something the server would refuse. */
  ok: boolean;
};

/**
 * Split a typed list into schema names.
 *
 * Commas, whitespace and newlines all separate, because people paste all three.
 * ⚠ It reports what it could not read rather than dropping it: a parser that
 * silently discards `hr-payroll` (a hyphen is not a legal identifier) registers a
 * datasource that reads fewer schemas than the person asked for and says nothing
 * — the shape D-118 refuses for curl parsing, one subject along.
 */
export function parseSchemaList(raw: string): SchemaListParse {
  const tokens = raw.split(/[\s,]+/).filter((t) => t.length > 0);
  const schemas: string[] = [];
  const rejected: SchemaListParse["rejected"] = [];
  for (const t of tokens) {
    if (t.length > MAX_LEN) {
      rejected.push({ token: t, why: `longer than ${MAX_LEN} characters` });
    } else if (!SCHEMA_NAME.test(t)) {
      rejected.push({
        token: t,
        why: "not a plain identifier — letters, digits, _ and $, not starting with a digit",
      });
    } else if (!schemas.includes(t)) {
      schemas.push(t);
    }
  }
  if (schemas.length > MAX_SCHEMAS) {
    rejected.push({
      token: schemas.slice(MAX_SCHEMAS).join(", "),
      why: `more than ${MAX_SCHEMAS} schemas — the manifest is already most of the drafter's prompt`,
    });
  }
  return {
    schemas,
    rejected,
    ok: rejected.length === 0 && schemas.length > 0 && schemas.length <= MAX_SCHEMAS,
  };
}
