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

/**
 * ── Redaction by VALUE ───────────────────────────────────────────────────────
 *
 * Key-name matching cannot see a key pasted into a chat message or printed by an
 * agent in free text: there is no key name, only the value. These detectors match
 * VALUES, and live here for the same reason as the rest of the package — a copied
 * security control drifts silently.
 *
 * STRONG detectors are vendor-shaped and safe to redact automatically. The
 * HEURISTIC ones (`prefixed`, `hex`, `base64`) guess from shape and entropy; they
 * are for paste detection only (warn the person) and must never drive silent
 * redaction of stored data.
 */
export type SecretHit = { start: number; end: number; value: string; kind: string; strong: boolean };

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const STRONG_DETECTORS: { kind: string; re: RegExp; group?: number }[] = [
  { kind: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { kind: "github", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: "aws", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "google", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "stripe", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "bearer", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
];

function* matches(text: string, re: RegExp, group = 0): Generator<{ start: number; value: string }> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    const value = m[group];
    if (!value) continue;
    // Group 1 always sits at the end of its match in the detectors above.
    const start = group === 0 ? m.index : m.index + m[0].length - value.length;
    yield { start, value };
  }
}

export function findSecretValues(text: string, opts?: { heuristics?: boolean }): SecretHit[] {
  const hits: SecretHit[] = [];
  const push = (start: number, value: string, kind: string, strong: boolean) =>
    hits.push({ start, end: start + value.length, value, kind, strong });

  for (const d of STRONG_DETECTORS) {
    for (const m of matches(text, d.re, d.group)) push(m.start, m.value, d.kind, true);
  }

  if (opts?.heuristics !== false) {
    const hasDigit = (s: string) => /[0-9]/.test(s);
    const hasLetter = (s: string) => /[A-Za-z]/.test(s);
    for (const m of matches(text, /\b([a-z][a-z0-9]{1,15})[-_]([A-Za-z0-9]{20,})\b/g)) {
      const tail = m.value.replace(/^[a-z][a-z0-9]{1,15}[-_]/, "");
      if (hasDigit(tail) && hasLetter(tail) && shannonEntropy(tail) >= 3.0) {
        push(m.start, m.value, "prefixed", false);
      }
    }
    for (const m of matches(text, /\b[0-9a-fA-F]{32,}\b/g)) push(m.start, m.value, "hex", false);
    for (const m of matches(text, /[A-Za-z0-9+/_-]{32,}={0,2}/g)) {
      const v = m.value;
      if (
        hasDigit(v) &&
        /[A-Z]/.test(v) &&
        /[a-z]/.test(v) &&
        !v.includes("/") &&
        shannonEntropy(v) >= 3.5
      ) {
        push(m.start, v, "base64", false);
      }
    }
  }

  // Strong beats heuristic, then longer wins; keep a non-overlapping set.
  const ranked = [...hits].sort(
    (a, b) =>
      Number(b.strong) - Number(a.strong) || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: SecretHit[] = [];
  for (const h of ranked) {
    if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Replace STRONG hits only. Right to left so earlier indexes stay valid. */
export function redactSecretValues(text: string, replacement: string = REDACTED): string {
  const strong = findSecretValues(text, { heuristics: false }).filter((h) => h.strong);
  let out = text;
  for (let i = strong.length - 1; i >= 0; i--) {
    out = out.slice(0, strong[i].start) + replacement + out.slice(strong[i].end);
  }
  return out;
}
