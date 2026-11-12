/**
 * Removes a chat's secret values (and the Forge tool key) from any text on its way out, in the forms a value tends to
 * take: as is, URL-encoded, base64 and base64url. Plain string replacement, never a pattern built from a value.
 * No DB or config imports.
 */
import { redactSecretValues } from "@foundry/redact";

export type ScrubSecret = { name: string; value: string };

const MIN_LEN = 8;
const MAX_DEPTH = 12;

function forms(value: string): string[] {
  const enc = encodeURIComponent(value);
  const b64 = Buffer.from(value).toString("base64");
  const out = new Set<string>([
    value,
    enc,
    enc.replace(/%20/g, "+"),
    b64,
    b64.replace(/=+$/, ""),
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ]);
  return [...out].filter((f) => f.length >= MIN_LEN);
}

export function makeScrubber(secrets: ScrubSecret[], opts?: { token?: string | null }): (text: string) => string {
  const rules: Array<{ form: string; label: string }> = [];
  for (const s of secrets) {
    if (s.value.length < MIN_LEN) continue;
    for (const f of forms(s.value)) rules.push({ form: f, label: `[secret:${s.name}]` });
  }
  if (opts?.token && opts.token.length >= MIN_LEN) {
    for (const f of forms(opts.token)) rules.push({ form: f, label: "[forge-tool-key]" });
  }
  rules.sort((a, b) => b.form.length - a.form.length);
  return (text: string): string => {
    let out = text;
    for (const r of rules) if (out.includes(r.form)) out = out.split(r.form).join(r.label);
    return redactSecretValues(out);
  };
}

/** A copy of `v` with every string value scrubbed (keys are left alone). Deeper than 12 levels is returned as is. */
export function scrubDeep<T>(v: T, scrub: (t: string) => string, depth = 0): T {
  if (typeof v === "string") return scrub(v) as unknown as T;
  if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub, depth + 1)) as unknown as T;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrubDeep(x, scrub, depth + 1);
  return out as T;
}
