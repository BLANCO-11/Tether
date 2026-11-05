// src/services/local-user-hash.test.ts — the password primitives.
//
// ⚠ Separate from the service's database tests on purpose: these are pure and
// must be runnable with no Postgres, because they are the part that would fail
// SILENTLY. A hash that verifies nothing lets every password through; a compare
// that throws turns a sign-in attempt into a 500 a caller can trigger at will.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./local-user.service.js";

describe("hashPassword", () => {
  it("round-trips the right password and refuses the wrong one", () => {
    const h = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(verifyPassword("correct horse battery stapl", h)).toBe(false);
    expect(verifyPassword("", h)).toBe(false);
  });

  it("⚠ SALTS — two accounts with the same password have different hashes", () => {
    // Without a per-row salt, one leaked hash tells you every account sharing
    // that password, and a rainbow table does the rest.
    const a = hashPassword("same passphrase here");
    const b = hashPassword("same passphrase here");
    expect(a).not.toBe(b);
    expect(verifyPassword("same passphrase here", a)).toBe(true);
    expect(verifyPassword("same passphrase here", b)).toBe(true);
  });

  it("⚠ stores its PARAMETERS with the hash, so the cost can be raised later", () => {
    // A cost read from a constant at verify time would make every existing
    // password fail the moment it was raised — silently, for everyone at once.
    const parts = hashPassword("a passphrase to store").split("$");
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
    expect(parts).toHaveLength(6);
  });

  it("⚠ the plaintext is NOWHERE in the stored string", () => {
    const secret = "unmistakable-plaintext-42";
    expect(hashPassword(secret)).not.toContain(secret);
  });

  it("handles a long passphrase and unicode without throwing", () => {
    for (const p of ["ünïcödé pässwörd wíth ãccents", "x".repeat(512), "🔐🔐🔐 emoji passphrase"]) {
      const h = hashPassword(p);
      expect(verifyPassword(p, h)).toBe(true);
      expect(verifyPassword(`${p}!`, h)).toBe(false);
    }
  });
});

describe("verifyPassword — every malformed input is FALSE, never a throw", () => {
  /**
   * ⚠ `timingSafeEqual` throws on a length mismatch, so the obvious
   * implementation turns a corrupt stored hash into a 500 that any caller can
   * trigger by attempting a sign-in. Lengths are compared first, on the
   * buffers, exactly as `requireApiKey` does.
   */
  it("refuses a hash of the wrong shape", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$1$2$3",
      "scrypt$1$2$3$4$5$6",
      "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
      "scrypt$notanumber$8$1$c2FsdA==$aGFzaA==",
      "scrypt$16384$8$1$$",
    ]) {
      expect(() => verifyPassword("anything", bad)).not.toThrow();
      expect(verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("⚠ refuses an absurd stored COST instead of spending a minute of CPU on it", () => {
    // A corrupt or hostile row naming N=2^30 is a denial of service against the
    // sign-in path, one row at a time.
    expect(verifyPassword("anything", "scrypt$1073741824$8$1$c2FsdA==$aGFzaA==")).toBe(false);
    expect(verifyPassword("anything", "scrypt$16384$99999$1$c2FsdA==$aGFzaA==")).toBe(false);
  });

  it("⚠ A TRUNCATED HASH DOES NOT VERIFY — this test found a real hole", () => {
    /**
     * ⚠ **The first version of `verifyPassword` PASSED this input**, and that
     * is the single most valuable thing in this file.
     *
     * Deriving at `keyLen = expected.length` is the standard shape and reads
     * as obviously fine. It is not: scrypt output is a prefix, so a hash
     * truncated to one byte derives one byte and matches roughly 1 password in
     * 256. The attacker-controlled value was the stored LENGTH, so anything
     * able to write or corrupt a row — a bad restore included — turned a
     * sign-in into a coin flip. The fix is the 32-byte floor.
     */
    const h = hashPassword("a real passphrase");
    const parts = h.split("$");
    for (const keep of [1, 2, 8, 20, 31]) {
      const truncated = [...parts.slice(0, 5), Buffer.from(parts[5]!, "base64").subarray(0, keep).toString("base64")].join("$");
      expect(() => verifyPassword("a real passphrase", truncated)).not.toThrow();
      expect(verifyPassword("a real passphrase", truncated)).toBe(false);
    }
  });

  it("⚠ but a LONGER key length still verifies, so the cost can be raised", () => {
    // The floor is a minimum and not an equality: `SCRYPT.keyLen` must be able
    // to change without invalidating every password already stored.
    const salt = Buffer.from("0123456789abcdef");
    const long = crypto.scryptSync("a real passphrase", salt, 96, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const stored = ["scrypt", 16384, 8, 1, salt.toString("base64"), long.toString("base64")].join("$");
    expect(verifyPassword("a real passphrase", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });
});
