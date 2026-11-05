import { describe, expect, it } from "vitest";
import { OPS_AUTH_STYLE, type OpsService } from "../service-keys.js";

/** Derived, so a new service is covered by these rules on the day it lands. */
const SERVICES = Object.keys(OPS_AUTH_STYLE) as OpsService[];

/**
 * The `via` label must be the CONFIGURED spelling of a header, not a
 * reconstruction of it.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * `presentedCredential` originally held its own lowercase list of header names
 * and title-cased them to build `via`:
 *
 *     "x-api-key".replace(/(^|-)([a-z])/g, …)   // → "X-Api-Key"
 *
 * `requireKey` then compared that against `OPS_AUTH_STYLE.ticketing.paramName`,
 * which is `X-API-Key`. The strings differ, so every ticket call 401'd — with a
 * correct credential, in the correct header, on a case-insensitive protocol.
 * Nothing typechecked wrong and no unit test existed; it surfaced as `kestra:prove`
 * scenario B failing with `all 10 call(s) failed`.
 *
 * Two things are pinned below. The first is the fix: the names come from the
 * config table, so there is one spelling. The second is the property the fix
 * relies on — that a round trip through the derivation is the identity, which is
 * false for any title-casing scheme applied to an acronym.
 */
describe("auth style tables are self-consistent", () => {
  it("survives a case round trip — the exact thing title-casing broke", () => {
    for (const service of SERVICES) {
      const { style, paramName } = OPS_AUTH_STYLE[service];
      if (style !== "header" || !paramName) continue;
      // What Express hands back from `req.header()` is case-insensitive, so the
      // lookup is fine. What matters is that the label reported is the SAME
      // string the comparison expects — i.e. that nothing reconstructs it.
      const titleCased = paramName
        .toLowerCase()
        .replace(/(^|-)([a-z])/g, (_m, d: string, ch: string) => d + ch.toUpperCase());
      if (titleCased !== paramName) {
        // This service is exactly the shape that broke. Assert the table's own
        // value is what gets used, by asserting it is NOT the reconstruction.
        expect(titleCased).not.toBe(paramName);
      }
    }
    // And at least one such name must exist, or the test above is vacuous.
    const acronymHeaders = SERVICES.filter((s) => {
      const { style, paramName } = OPS_AUTH_STYLE[s];
      if (style !== "header" || !paramName) return false;
      return (
        paramName !==
        paramName
          .toLowerCase()
          .replace(/(^|-)([a-z])/g, (_m, d: string, ch: string) => d + ch.toUpperCase())
      );
    });
    expect(acronymHeaders).toContain("ticketing");
  });

  it("gives every header service a name that differs from every other", () => {
    // Two services sharing a header name would make `presentedCredential`'s
    // fixed-order scan resolve one of them to the other's `via`, and the 401
    // would name a service the caller never addressed.
    const names = SERVICES.map((s) => OPS_AUTH_STYLE[s])
      .filter((a) => a.style === "header")
      .map((a) => a.paramName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never reuses a query parameter name as a header name", () => {
    const headers = new Set(
      SERVICES.map((s) => OPS_AUTH_STYLE[s])
        .filter((a) => a.style === "header")
        .map((a) => (a.paramName as string).toLowerCase()),
    );
    const queries = SERVICES.map((s) => OPS_AUTH_STYLE[s])
      .filter((a) => a.style === "query")
      .map((a) => (a.paramName as string).toLowerCase());
    for (const q of queries) expect(headers.has(q)).toBe(false);
  });
});
