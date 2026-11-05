/**
 * Which hosts ONE run may reach, carried in its proxy credentials and signed — shared by the connector (mints) and
 * the egress proxy (verifies). No state between the two: the proxy needs only the shared secret.
 *
 *   user = base64url(JSON {r: runId, h: [host patterns], e: expiry ms})
 *   pass = base64url(HMAC-SHA256(secret, user))
 *
 * A host pattern is `example.com` (ports 80 and 443), `example.com:8333` (that port only) or `*.example.com` (any
 * subdomain, 80/443). Nothing else matches: no pattern means no host.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");

export function mintProxyAuth(secret, { runId, hosts, ttlMs = 15 * 60_000 }) {
  if (!secret) throw new Error("no egress secret");
  const user = b64u(JSON.stringify({ r: String(runId ?? ""), h: [...new Set(hosts.map(normalisePattern).filter(Boolean))], e: Date.now() + ttlMs }));
  const pass = createHmac("sha256", secret).update(user).digest("base64url");
  return { user, pass };
}

/** `Proxy-Authorization: Basic …` → `{runId, hosts}`, or null when absent, malformed, forged or expired. */
export function verifyProxyAuth(secret, header) {
  const m = /^Basic\s+(.+)$/i.exec(String(header ?? ""));
  if (!m || !secret) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i <= 0) return null;
  const user = decoded.slice(0, i);
  const pass = Buffer.from(decoded.slice(i + 1));
  const want = Buffer.from(createHmac("sha256", secret).update(user).digest("base64url"));
  if (pass.length !== want.length || !timingSafeEqual(pass, want)) return null;
  try {
    const claim = JSON.parse(Buffer.from(user, "base64url").toString("utf8"));
    if (typeof claim.e !== "number" || claim.e < Date.now() || !Array.isArray(claim.h)) return null;
    return { runId: String(claim.r ?? ""), hosts: claim.h.map(String) };
  } catch {
    return null;
  }
}

export function normalisePattern(p) {
  const s = String(p ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(s) ? s : "";
}

/** Does any pattern allow `host` on `port`? */
export function hostAllowed(patterns, host, port) {
  const h = String(host).toLowerCase();
  const p = Number(port);
  return patterns.some((pat) => {
    const [name, explicit] = pat.split(":");
    const portOk = explicit ? Number(explicit) === p : p === 443 || p === 80;
    if (!portOk) return false;
    return name.startsWith("*.") ? h.endsWith(name.slice(1)) && h.length > name.length - 1 : h === name;
  });
}
