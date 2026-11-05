/**
 * Two implementations of "which addresses are reserved", held in agreement.
 *
 * ── Why there are two, and why they are not merged ──────────────────────────
 *
 * `datasource-target.service.ts`'s `NEVER_A_DATABASE` came first and is
 * deliberately permissive: loopback and RFC 1918 are ALLOWED, because this
 * deployment's own demo databases live there (`host.docker.internal:5433`,
 * `localhost:5433` for every host-run harness). I-36 is the record of what
 * happens when a datasource check refuses them — `pnpm demo:seed` was broken
 * outright for two programmes. `@foundry/shared`'s egress module then generalised
 * the same idea for the three genuinely open call sites, with a STRICT profile
 * that does refuse those ranges, and its own docblock records that
 * `datasource-target.service.ts` is NOT modified — that is an explicit scope
 * boundary, not an oversight.
 *
 * So merging them is the wrong fix: one caller needs loopback allowed and another
 * needs it refused, and a single classifier would have to be told which, which is
 * what the two profiles already are.
 *
 * ── What this file does instead ─────────────────────────────────────────────
 *
 * The classes they are supposed to AGREE on — link-local, unspecified/broadcast,
 * multicast — are duplicated regex, and duplicated regex drifts. It drifts
 * silently and in the dangerous direction: whichever copy is not exercised by a
 * test stops matching, and nothing anywhere reports a disagreement. This pins the
 * agreement so the next edit to either list has to be made to both.
 */
import { describe, expect, it } from "vitest";
import { PERMISSIVE, classifyHost } from "@foundry/shared";
import { _addressClass } from "./datasource-target.service.js";

/** Refused by BOTH: nothing legitimate is a database or a webhook here. */
const REFUSED_BY_BOTH = [
  "169.254.169.254", // the cloud metadata endpoint, on AWS/GCP/Azure/DO
  "169.254.0.1",
  "fe80::1", // IPv6 link-local
  "0.0.0.0",
  "::",
  "255.255.255.255",
  "224.0.0.1", // multicast
  "239.255.255.250",
];

/**
 * Allowed by BOTH: `PERMISSIVE` exists to be byte-for-byte `NEVER_A_DATABASE`,
 * and every entry here is an address a demo database or a harness actually uses.
 */
const ALLOWED_BY_BOTH = [
  "127.0.0.1",
  "::1",
  "10.0.0.5",
  "172.17.0.2", // the docker bridge — where a registered tool endpoint resolves
  "192.168.1.10",
  "8.8.8.8",
];

describe("the two reserved-address classifiers agree", () => {
  it.each(REFUSED_BY_BOTH)("both refuse %s", async (ip) => {
    expect(_addressClass(ip), `datasource-target on ${ip}`).not.toBeNull();
    expect((await classifyHost(ip, PERMISSIVE)).allowed, `egress PERMISSIVE on ${ip}`).toBe(false);
  });

  it.each(ALLOWED_BY_BOTH)("both allow %s", async (ip) => {
    expect(_addressClass(ip), `datasource-target on ${ip}`).toBeNull();
    expect((await classifyHost(ip, PERMISSIVE)).allowed, `egress PERMISSIVE on ${ip}`).toBe(true);
  });

  /**
   * ⚠ THE CONTROL. Both loops above pass against two classifiers that answer
   * "reserved" for everything and "fine" for everything respectively, as long as
   * the two lists happen to line up. This asserts each classifier can produce
   * BOTH answers, so neither is stuck.
   */
  it("CONTROL — each classifier discriminates, rather than answering one way", async () => {
    expect(_addressClass("169.254.169.254")).not.toBeNull();
    expect(_addressClass("8.8.8.8")).toBeNull();
    expect((await classifyHost("169.254.169.254", PERMISSIVE)).allowed).toBe(false);
    expect((await classifyHost("8.8.8.8", PERMISSIVE)).allowed).toBe(true);
  });

  /**
   * ⚠ And where they are supposed to DISAGREE, they must actually disagree — or
   * the STRICT profile is not doing the one thing it was added for. This is the
   * negative of the parity above: same addresses, opposite verdicts.
   */
  it("STRICT is genuinely stricter, on exactly the ranges the demo databases use", async () => {
    const { STRICT } = await import("@foundry/shared");
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.10"]) {
      expect(_addressClass(ip), ip).toBeNull();
      expect((await classifyHost(ip, STRICT)).allowed, ip).toBe(false);
    }
  });
});
