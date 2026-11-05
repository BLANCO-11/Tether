/**
 * Cross-package validation rules (V7 — research.md Decision 4).
 *
 * Closes the two duplication risks the client's own comments already
 * admitted: `ENV_NAME_RE` was defined independently in
 * `packages/client/src/lib/secret-edit.ts` AND `tool-edit.ts`, and
 * `AUTH_STYLES` was a documented MIRROR of `packages/server/src/services/tool.service.ts`'s
 * list. Both now live here once; both sides import this instead of
 * maintaining their own copy.
 */

/** The server's own rule — a valid environment-variable name. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * **A data source's name, which is also half of every step ref.**
 *
 * ── ⚠ Why this moved here on 2026-09-17 ─────────────────────────────────────
 *
 * `datasource.service.ts` has owned this regex since it was written and the
 * onboarding form knew nothing about it, so the form happily accepted
 * `ML-ZERO-DB`, posted it, and the server refused with a 400. On
 * `/data-sources/new` that refusal rendered as the literal words "Couldn't
 * connect" — a message about the network, for a name. It cost a real user a
 * morning, and the fix turned out to be one character.
 *
 * So the rule now lives where BOTH sides can read it, which is the same reason
 * `ENV_NAME_RE` and `AUTH_STYLES` are here. The server still enforces it — this
 * is not a client-side gate — but the form can now say so beside the box
 * instead of letting somebody discover it from a submit.
 *
 * ── ⚠ The rule is NOT loosened, and the reason is structural ────────────────
 *
 * A `datasource` step's ref is `<datasource>.<query>` and `runNamedQuery`
 * splits it at the FIRST dot, so a name containing a dot makes every query on
 * that datasource unresolvable — at execution, i.e. after approval, mid-run. It
 * is also a fingerprint collision: `refFingerprints()` keys one flat map on the
 * concatenation, so `a.b` + `c` and `a` + `b.c` produce the same entry.
 *
 * ⚠ A hyphen is very probably harmless where a dot is not, and this regex bans
 * both. Widening it to allow one is a real option and it is **deliberately not
 * taken here**: every ref that exists would have to be re-checked against the
 * expression allowlist and the compiler, and that is a measurement, not a
 * one-line edit. Making the form honest costs nothing and needed no such proof.
 */
export const DATASOURCE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The nearest legal name to what somebody typed — `ML-ZERO-DB` ⇒ `ML_ZERO_DB`.
 *
 * ⚠ **Offered, never applied silently.** A form that rewrites the name you
 * typed is a form that stores something you did not choose, and the name is the
 * thing every step ref is built from. The caller shows this and the person
 * presses it, so the value is still theirs.
 *
 * Returns `null` when there is nothing useful to offer — an empty box, or a
 * string with no usable characters at all — so a caller can tell "here is a
 * suggestion" from "I have nothing", rather than rendering a button that fills
 * the field with `_`.
 */
export function suggestDatasourceName(raw: string): string | null {
  const swapped = raw.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!swapped) return null;
  // A leading digit is legal in the middle and not at the front; prefix rather
  // than drop, because dropping changes which database the name refers to.
  const legal = /^[0-9]/.test(swapped) ? `_${swapped}` : swapped;
  if (!DATASOURCE_NAME_RE.test(legal)) return null;
  return legal === raw ? null : legal;
}

/** The four credential styles a tool call can authenticate with, plus `none`. */
export const AUTH_STYLES = ["bearer", "header", "query", "basic", "none"] as const;
export type AuthStyle = (typeof AUTH_STYLES)[number];

/**
 * **What a data source is allowed to do** — the levels and the words for them.
 *
 * ⚠ Shared because BOTH sides need them and they must not drift: the server's
 * `createDatasourceInputSchema` validates against this list and the onboarding
 * form renders it. A client copy that gained a fourth level would offer a
 * choice the server refuses on submit; one that lost a level would hide a
 * capability nobody could reach. That is the same trap `AUTH_STYLES` was moved
 * here to close.
 *
 * ⚠ **The ENFORCEMENT deliberately stays in the server**
 * (`datasource-access-policy.ts` — `enforcedPolicy`,
 * `requiresReadOnlyTransaction`). This package holds the vocabulary and the
 * copy; nothing here decides anything. A browser-computable answer to "may this
 * write" would be a second authority on a security boundary, and it would be
 * the one an attacker controls.
 *
 * ⚠ ORDERED, widest last — `read ⊂ read_write ⊂ full`.
 */
export const ACCESS_POLICIES = ["read", "read_write", "full"] as const;
export type AccessPolicy = (typeof ACCESS_POLICIES)[number];

/**
 * ⚠ **The copy says the database refuses it, because the database does.**
 * Measured 2026-09-17 against a Postgres SUPERUSER inside `BEGIN READ ONLY`:
 * INSERT, UPDATE, DELETE and CREATE TABLE all refused with "cannot execute … in
 * a read-only transaction", SELECT allowed. If the transaction ever stops being
 * opened, this sentence becomes a false promise on a security control — which
 * is why `datasource-access-policy.test.ts` asserts the executor emits it.
 */
export const ACCESS_POLICY_COPY: Record<AccessPolicy, { title: string; detail: string }> = {
  read: {
    title: "Read only",
    detail:
      "Statements run inside a read-only transaction, so the database refuses every write — " +
      "even if the credential you gave is an administrator.",
  },
  read_write: {
    title: "Read and write rows",
    detail:
      "Adds INSERT and UPDATE. Nothing can delete rows or change the schema. " +
      "Choose this only if an automation is meant to change data.",
  },
  full: {
    title: "Full access",
    detail:
      "Adds DELETE, TRUNCATE and schema changes. Foundry places no restriction of its own — " +
      "whatever the credential can do, a statement can do.",
  },
};

export { MATRIX_ROWS, cellFor, type MatrixRow, type Cell } from "./role-matrix.js";
