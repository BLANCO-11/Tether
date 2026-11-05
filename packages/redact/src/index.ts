/**
 * Redaction by KEY NAME, for anything that renders a payload we did not author.
 *
 * ── Why this is a package rather than a file in one service ──────────────────
 *
 * Two processes need it and they are on opposite sides of a trust boundary.
 * `packages/server` redacts step outputs before a browser sees them (D-07 —
 * `begin`'s response body carries an execution token, so redacting client-side
 * would be theatre). `packages/ops-api` redacts request parameters before
 * writing them to its call log, which is the bug this function was written for.
 *
 * The obvious alternative — copy the file — puts a security control in two
 * places that can drift, and the drift would be silent: each copy keeps passing
 * its own tests while the two disagree about what a secret looks like. One
 * module, one regex, one test file.
 *
 * ── Why by key name rather than by value ─────────────────────────────────────
 *
 * Matching values requires knowing them. Foundry stores only the *hash* of an
 * execution token (deliberately — see `execution-token.service.ts`), so it
 * cannot recognise a live token by comparison even in its own database. Matching
 * the key holds for fields nobody has thought of yet, which is the property that
 * actually survives.
 *
 * The original bug: an API key sent as `?api_key=…` was written verbatim into
 * the tool call log, where it survived for 2000 rows and appeared in demo
 * screenshots.
 */
const SECRET_KEY_RE =
  /^(x-)?(api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd|authorization|auth)$/i;

export const REDACTED = "[redacted]";

export function redactSecrets(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      SECRET_KEY_RE.test(k) ? [k, REDACTED] : [k, redactSecrets(x, depth + 1)],
    ),
  );
}

/**
 * Redact inside a JSON **string**.
 *
 * Kestra persists an `http.Request` response body as a string, so `redactSecrets`
 * walks straight past it — the token in `begin`'s body sits inside one of these.
 * Parse, redact, re-serialise; a body that is not JSON is returned untouched
 * because there is no structure to match a key against.
 */
export function redactJsonString(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== "object") return raw;
  return JSON.stringify(redactSecrets(parsed));
}
