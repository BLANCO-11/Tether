/**
 * Which hosts a run may reach = the piece's APPROVED hosts (set at install) ∪ the hosts its connection names.
 *
 * Pieces do not declare their hosts, and scanning a bundle is not an allowlist: every piece bundles a framework that
 * names AI providers' and documentation hosts (measured on S3, ServiceNow, Teams, GitHub — `FRAMEWORK_HOSTS` below is
 * what all four had in common). So a scan only SUGGESTS, minus that noise; what is allowed is chosen.
 */
import { normalisePattern } from "./egress-token.mjs";

/** Hosts found in all four measured bundles (2026-10-27): the bundled framework and its `ai` SDK, schemas, the CDN. */
export const FRAMEWORK_HOSTS = new Set([
  "api.deepseek.com",
  "api.minimax.io",
  "api.moonshot.ai",
  "api.x.ai",
  "api.z.ai",
  "cdn.activepieces.com",
  "dashscope-intl.aliyuncs.com",
  "json-schema.org",
  "www.w3.org",
  "example.com",
  "api.example.com",
]);

/** Hosts named as URLs in the piece's code, minus the framework's — suggestions for the person approving an install. */
export function suggestHosts(source) {
  const out = new Set();
  for (const m of String(source).matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) {
    const h = m[1].toLowerCase();
    if (!FRAMEWORK_HOSTS.has(h)) out.add(h);
  }
  return [...out].sort();
}

const HOSTLIKE_FIELD = /(url|uri|host|endpoint|domain|instance|server|base)/i;
/** A secret is never a host — and the run log prints the hosts, so a URL-shaped password would be logged. */
const SECRET_FIELD = /(pass|secret|token|key|credential)/i;

/**
 * The hosts a connection names: any field whose value is an http(s) URL, or a host-like field holding a bare host
 * name. A non-default port is kept (`s3:8333`), so the allowance is that port only. Secret-named fields never count.
 */
export function connectionHosts(fields) {
  const out = new Set();
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (typeof v !== "string" || !v.trim() || SECRET_FIELD.test(k)) continue;
    const s = v.trim();
    let pattern = "";
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        pattern = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      } catch {
        /* not a URL */
      }
    } else if (HOSTLIKE_FIELD.test(k) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) {
      pattern = s;
    }
    pattern = normalisePattern(pattern);
    if (pattern) out.add(pattern);
  }
  return [...out];
}
