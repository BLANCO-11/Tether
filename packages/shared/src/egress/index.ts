/**
 * Egress/SSRF policy (V6 — research.md Decision 2).
 *
 * `classifyHost` is generalized from
 * `packages/server/src/services/datasource-target.service.ts`'s
 * `NEVER_A_DATABASE`/`_addressClass` — that file is NOT modified by this
 * feature; its own tests and behavior stay exactly as they are. This module
 * is a separate generalization, applied to the three genuinely open gaps
 * (poll triggers, tool endpoint calls, the ops-proxy LLM `baseUrl`), never to
 * datasource registration.
 */

export interface EgressPolicyProfile {
  name: "strict" | "permissive";
  deniesRfc1918: boolean;
  deniesLoopback: boolean;
  deniesLinkLocal: boolean;
  /**
   * What an unresolvable host means. `false` = refuse it (fail closed).
   *
   * This is a field rather than one shared default because the two callers want
   * opposite answers, and the difference is not a preference. A
   * REGISTRATION-time check that refuses on a DNS blip rejects a credential the
   * operator can see is fine, and they retry — recoverable. A DIAL-time check
   * that ALLOWS on a DNS blip hands the request through unclassified at the one
   * moment the check exists for, and nothing says so. So `STRICT` (dial time)
   * fails closed and `PERMISSIVE` keeps `NEVER_A_DATABASE`'s permissive answer.
   */
  allowsUnresolvable: boolean;
}

export const STRICT: EgressPolicyProfile = {
  name: "strict",
  deniesRfc1918: true,
  deniesLoopback: true,
  deniesLinkLocal: true,
  allowsUnresolvable: false,
};

/**
 * Byte-for-byte `NEVER_A_DATABASE`: denies link-local + unspecified/broadcast
 * + multicast only. Loopback and RFC 1918 are deliberately allowed — this
 * deployment's demo databases live there (`host.docker.internal:5433`,
 * `localhost:5432`), and refusing them would break `demo:seed`/`finance:seed`.
 * Exists here for completeness/documentation; nothing in this feature calls
 * it with `PERMISSIVE` — `datasource-target.service.ts` keeps its own,
 * separate implementation (research.md Decision 2's explicit scope boundary).
 */
export const PERMISSIVE: EgressPolicyProfile = {
  name: "permissive",
  deniesRfc1918: false,
  deniesLoopback: false,
  deniesLinkLocal: true,
  allowsUnresolvable: true,
};

export interface EgressDecision {
  allowed: boolean;
  reason: string | null;
  resolvedAddress: string;
}

const LOOPBACK = (ip: string) => /^127\./.test(ip) || ip === "::1";
const RFC1918 = (ip: string) =>
  /^10\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) || /^192\.168\./.test(ip);
/** Carrier-grade NAT, 100.64.0.0/10 — not the public internet. */
const CGNAT = (ip: string) => /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(ip);
/** IPv6 unique-local, fc00::/7 (fc00…fdff). The v6 analogue of RFC 1918. */
const IPV6_ULA = (ip: string) => /^f[cd][0-9a-f]*:/i.test(ip);
const LINK_LOCAL = (ip: string) => /^169\.254\./.test(ip) || /^fe[89ab][0-9a-f]*:/i.test(ip);
const UNSPECIFIED_OR_BROADCAST = (ip: string) =>
  ip === "0.0.0.0" || ip === "::" || ip === "255.255.255.255";
const MULTICAST = (ip: string) => /^2(2[4-9]|3[0-9])\./.test(ip) || /^ff[0-9a-f]*:/i.test(ip);

function classifyAddress(ip: string, profile: EgressPolicyProfile): string | null {
  if (profile.deniesLoopback && LOOPBACK(ip)) return "loopback";
  if (profile.deniesLinkLocal && LINK_LOCAL(ip)) return "link-local";
  if (profile.deniesRfc1918 && (RFC1918(ip) || CGNAT(ip) || IPV6_ULA(ip))) return "rfc1918";
  if (UNSPECIFIED_OR_BROADCAST(ip)) return "unspecified-or-broadcast";
  if (MULTICAST(ip)) return "multicast";
  return null;
}

/**
 * One octet/word of an IPv4 literal, in any base a resolver accepts.
 *
 * `inet_aton` semantics, which is what the OS and every HTTP client actually
 * apply: a leading `0x` is hex, a leading `0` is OCTAL, anything else decimal.
 * This is the half that was missing — `classifyAddress` only ever saw dotted
 * decimal, so `0x7f.0.0.1` and `0177.0.0.1` were never recognised as loopback.
 */
function parseOctet(part: string): number | null {
  if (part === "") return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8);
  if (/^(0|[1-9][0-9]*)$/.test(part)) return parseInt(part, 10);
  return null;
}

function dotted(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/**
 * Canonicalise every IPv4 form a resolver accepts to dotted-quad, or `null` if
 * this is not an IPv4 literal at all.
 *
 * `inet_aton` accepts 1–4 parts and the LAST part absorbs the remaining bytes,
 * so `2130706433`, `127.1`, `127.0.1` and `0x7f000001` are all 127.0.0.1. A
 * denylist that only matches `/^127\./` sees none of them.
 */
function canonicalizeIpv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseOctet(p);
    if (v === null || !Number.isFinite(v) || v < 0) return null;
    nums.push(v);
  }
  const n = nums.length;
  // Every part but the last is one byte; the last holds what is left.
  for (let i = 0; i < n - 1; i++) if (nums[i]! > 255) return null;
  const lastMax = Math.pow(256, 5 - n);
  if (nums[n - 1]! >= lastMax) return null;
  let value = nums[n - 1]!;
  for (let i = 0; i < n - 1; i++) value += nums[i]! * Math.pow(256, 3 - i);
  return dotted(value);
}

/**
 * What will actually be dialled, in one normal form.
 *
 * Returns `name` for a hostname (which then needs DNS), or a canonical address.
 * IPv4-mapped and IPv4-compatible IPv6 collapse to their embedded IPv4 —
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are loopback, and the classic way past
 * a v4-only denylist is to write loopback in v6 clothing.
 */
export function canonicalizeHost(host: string): { kind: "ipv4" | "ipv6" | "name"; value: string } {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

  if (h.includes(":")) {
    const mapped = /^(?:::ffff:0:|::ffff:|::)([0-9a-f.:]+)$/.exec(h);
    if (mapped) {
      const tail = mapped[1]!;
      if (tail.includes(".")) {
        const v4 = canonicalizeIpv4(tail);
        if (v4) return { kind: "ipv4", value: v4 };
      } else if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(tail)) {
        const [hi, lo] = tail.split(":");
        return { kind: "ipv4", value: dotted(parseInt(hi!, 16) * 65536 + parseInt(lo!, 16)) };
      }
    }
    return { kind: "ipv6", value: h };
  }

  const v4 = canonicalizeIpv4(h);
  if (v4) return { kind: "ipv4", value: v4 };
  return { kind: "name", value: h };
}

/**
 * Resolve `host` and classify it against `profile`. A literal IP — in ANY of
 * the forms `canonicalizeHost` understands — needs no DNS round trip.
 * `allowed: false` on ANY resolved address: a name resolving to one public and
 * one private address is refused, since the caller's HTTP client (or driver)
 * may pick either one.
 *
 * An unresolvable host follows `profile.allowsUnresolvable` — refused under
 * STRICT, allowed under PERMISSIVE. See that field for why the two differ.
 */
export async function classifyHost(host: string, profile: EgressPolicyProfile): Promise<EgressDecision> {
  const canon = canonicalizeHost(host);
  if (canon.kind !== "name") {
    const reason = classifyAddress(canon.value, profile);
    return reason
      ? { allowed: false, reason, resolvedAddress: canon.value }
      : { allowed: true, reason: null, resolvedAddress: canon.value };
  }

  const { lookup } = await import("node:dns/promises");
  let addresses: string[];
  try {
    const records = await lookup(host, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    if (profile.allowsUnresolvable) {
      return { allowed: true, reason: null, resolvedAddress: host };
    }
    // Fail closed at dial time. A resolver that fails at the instant of the
    // check is indistinguishable from one being made to fail, and this branch
    // is the one guarding the dial.
    return { allowed: false, reason: "unresolvable", resolvedAddress: host };
  }
  if (addresses.length === 0 && !profile.allowsUnresolvable) {
    return { allowed: false, reason: "unresolvable", resolvedAddress: host };
  }

  for (const addr of addresses) {
    const c = canonicalizeHost(addr);
    const reason = classifyAddress(c.kind === "name" ? addr : c.value, profile);
    if (reason) return { allowed: false, reason, resolvedAddress: addr };
  }
  return { allowed: true, reason: null, resolvedAddress: addresses[0] ?? host };
}

/**
 * FR-008 — re-resolves and re-classifies immediately before dialing. Callers
 * replace a bare `fetch` with this at the two named call sites
 * (`trigger-scheduler.ts`, `step-execution.service.ts`) plus the ops-proxy
 * LLM `baseUrl` check.
 *
 * ⚠ WHAT THIS DOES NOT DO — do not restate the stronger claim.
 *
 * This NARROWS the DNS-rebinding window; it does not close it. The check below
 * resolves the host itself, and then `fetch` resolves it AGAIN when it opens the
 * socket — so the address that was classified is not provably the address that
 * gets dialled. Closing that needs the check to run at connection time (an
 * `undici` dispatcher with a `connect`/`lookup` hook, or dialling the checked IP
 * with the original Host/SNI preserved). `undici` is not a dependency here today
 * and Node's global `fetch` exposes no such hook, so this is deliberately left
 * as the narrower control, stated rather than implied.
 *
 * What IS solid: every alternate encoding of a reserved address is caught before
 * any dial (`canonicalizeHost`), and an unresolvable host fails closed under
 * STRICT. Those are the two paths that needed no rebinding race at all — the
 * literal bypass was reachable in one request.
 */
export async function guardedFetch(
  url: string | URL,
  init: RequestInit,
  profile: EgressPolicyProfile,
): Promise<Response> {
  const parsed = url instanceof URL ? url : new URL(url);
  const decision = await classifyHost(parsed.hostname, profile);
  if (!decision.allowed) {
    throw new Error(
      `egress_rejected: "${parsed.hostname}" resolves to ${decision.resolvedAddress}, which is ${decision.reason}`,
    );
  }
  return fetch(url, init);
}
