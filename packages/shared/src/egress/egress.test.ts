import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup } from "node:dns/promises";
import { classifyHost, guardedFetch, STRICT, PERMISSIVE } from "./index.js";

const mockedLookup = vi.mocked(lookup);

describe("classifyHost — STRICT (V6, the three genuinely new call sites)", () => {
  it("denies loopback, link-local, and RFC 1918 (literal IPs, no DNS needed)", async () => {
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "172.17.0.2", "192.168.1.10", "169.254.169.254"]) {
      const decision = await classifyHost(ip, STRICT);
      expect(decision.allowed, ip).toBe(false);
    }
  });

  it("allows a public address (literal IP, no DNS needed)", async () => {
    const decision = await classifyHost("8.8.8.8", STRICT);
    expect(decision.allowed).toBe(true);
  });
});

describe("classifyHost — PERMISSIVE (byte-for-byte datasource-target.service.ts's NEVER_A_DATABASE)", () => {
  it("does NOT classify private ranges or loopback — the same positive control datasource-target.test.ts pins", async () => {
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "172.17.0.2", "192.168.1.10", "8.8.8.8"]) {
      const decision = await classifyHost(ip, PERMISSIVE);
      expect(decision.allowed, ip).toBe(true);
    }
  });

  it("still denies link-local, unspecified/broadcast, and multicast", async () => {
    for (const ip of ["169.254.169.254", "fe80::1", "0.0.0.0", "255.255.255.255", "224.0.0.1"]) {
      const decision = await classifyHost(ip, PERMISSIVE);
      expect(decision.allowed, ip).toBe(false);
    }
  });
});

/**
 * The bypass that mattered: `classifyAddress` only ever matched dotted decimal,
 * and the literal-IP fast path was `/^[\d.]+$/`. So `http://2130706433/` skipped
 * DNS *and* matched no range — one request, no rebinding race, straight to
 * loopback from inside the parent process.
 *
 * Every row here is a real encoding a resolver accepts. They must be refused
 * under STRICT and — because PERMISSIVE has to stay byte-for-byte
 * NEVER_A_DATABASE or `demo:seed`/`finance:seed` break — allowed under it.
 */
describe("classifyHost — alternate encodings of a reserved address (canonicalisation)", () => {
  const LOOPBACK_FORMS = [
    "2130706433", // decimal
    "0x7f000001", // hex, one part
    "0x7f.0.0.1", // hex octet
    "0177.0.0.1", // octal octet
    "017700000001", // octal, one part
    "127.1", // inet_aton short form
    "127.0.1",
    "::ffff:127.0.0.1", // IPv4-mapped IPv6
    "::ffff:7f00:1", // IPv4-mapped, hex words
    "::127.0.0.1", // IPv4-compatible IPv6
    "[::1]", // bracketed
    "0x7F000001", // uppercase hex
  ];

  it.each(LOOPBACK_FORMS)("STRICT refuses %s as loopback", async (form) => {
    const d = await classifyHost(form, STRICT);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("loopback");
  });

  it.each(LOOPBACK_FORMS)("PERMISSIVE still allows %s — demo databases live on loopback", async (form) => {
    expect((await classifyHost(form, PERMISSIVE)).allowed).toBe(true);
  });

  it("refuses link-local and metadata addresses in alternate encodings", async () => {
    // 2852039166 === 0xa9fea9fe === 169.254.169.254, the cloud metadata endpoint.
    for (const form of ["2852039166", "0xa9fea9fe", "169.254.169.254", "::ffff:169.254.169.254"]) {
      const d = await classifyHost(form, STRICT);
      expect(d.allowed, form).toBe(false);
      expect(d.reason, form).toBe("link-local");
    }
  });

  it("refuses RFC 1918 in alternate encodings", async () => {
    for (const form of ["167772161", "10.1", "0xa.0.0.1", "::ffff:10.0.0.5"]) {
      const d = await classifyHost(form, STRICT);
      expect(d.allowed, form).toBe(false);
      expect(d.reason, form).toBe("rfc1918");
    }
  });

  it("refuses the ranges the first cut missed: CGNAT and IPv6 unique-local", async () => {
    for (const ip of ["100.64.0.1", "100.127.255.255", "fc00::1", "fd12:3456::1"]) {
      const d = await classifyHost(ip, STRICT);
      expect(d.allowed, ip).toBe(false);
      expect(d.reason, ip).toBe("rfc1918");
    }
    // 100.63.x and 100.128.x are OUTSIDE 100.64.0.0/10 — public, must stay allowed.
    for (const ip of ["100.63.255.255", "100.128.0.1"]) {
      expect((await classifyHost(ip, STRICT)).allowed, ip).toBe(true);
    }
  });

  it("does not mistake a hostname or a public literal for a reserved address", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    for (const host of ["example.com", "api.stripe.com", "1e3.example.com"]) {
      expect((await classifyHost(host, STRICT)).allowed, host).toBe(true);
    }
    mockedLookup.mockReset();
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      expect((await classifyHost(ip, STRICT)).allowed, ip).toBe(true);
    }
  });
});

/**
 * A resolver that fails at the instant of the check is indistinguishable from
 * one being MADE to fail. At dial time that must refuse; at registration time
 * (PERMISSIVE) it stays permissive, because refusing a transient blip there is
 * recoverable and this is where the demo provisioners run.
 */
describe("classifyHost — an unresolvable host", () => {
  beforeEach(() => mockedLookup.mockReset());

  it("STRICT fails CLOSED — this is the dial-time guard", async () => {
    mockedLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const d = await classifyHost("gone.example", STRICT);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unresolvable");
  });

  it("STRICT refuses an empty answer too", async () => {
    mockedLookup.mockResolvedValueOnce([] as never);
    expect((await classifyHost("empty.example", STRICT)).allowed).toBe(false);
  });

  it("PERMISSIVE stays permissive — registration-time behaviour is unchanged", async () => {
    mockedLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect((await classifyHost("gone.example", PERMISSIVE)).allowed).toBe(true);
  });

  it("guardedFetch does not dial an unresolvable host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    mockedLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(guardedFetch("http://gone.example/", {}, STRICT)).rejects.toThrow(/egress/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("guardedFetch does not dial a decimal-encoded loopback literal", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await expect(guardedFetch("http://2130706433/", {}, STRICT)).rejects.toThrow(/egress/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedLookup).not.toHaveBeenCalled(); // caught without a DNS round trip
    fetchSpy.mockRestore();
  });
});

describe("guardedFetch — re-checks before dialing (FR-008)", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it("rejects when the host resolves to a private address at dial time, even if a prior classifyHost check on the same host passed", async () => {
    // First "registration" classification, against a resolver answering public.
    mockedLookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never);
    const first = await classifyHost("rebound.example", STRICT);
    expect(first.allowed).toBe(true);

    // The record moved underneath us before the dial.
    mockedLookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as never);
    await expect(guardedFetch("http://rebound.example/", {}, STRICT)).rejects.toThrow(/egress/i);
  });

  it("dials normally for a public host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    mockedLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never);

    const res = await guardedFetch("https://example.com/", {}, STRICT);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
