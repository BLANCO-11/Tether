/**
 * WHO a real email may be delivered to.
 * email-send-tool · US2, US3 · contracts/mail-send.md §3
 *
 * ⚠ Every assertion here is a restatement of one rule: **no `to` means the
 * person who started the run and nobody else; an explicit `to` must be
 * allowlisted.** These run with no database, no express and no Graph, because
 * this is the module where a mistake reaches a stranger's inbox and there is no
 * unsend.
 *
 * Two shapes are asserted repeatedly and on purpose:
 *
 *  1. A refusal **names the rejected address and the rule it broke**. A bare
 *     `false` is not an acceptable return — a caller that cannot say which
 *     address was wrong produces a redraft cycle instead of a fix (FR-013).
 *  2. A refusal is **total**. If one recipient fails, `to` is not partially
 *     delivered. The failure this migration was built around reported `clean`
 *     after emailing 0 of 11 people; a half-send that reports success is the
 *     same lie with a smaller gap.
 */
import { describe, expect, it } from "vitest";
import {
  checkMessageCaps,
  EMAIL_RE,
  resolveRecipients,
  resolveRequester,
  SUBJECT_MAX_CHARS, isReservedDomain } from "./mail-recipients.js";

const CAPS = { maxRecipients: 10, maxBodyBytes: 262_144 } as const;

/** The common case: a real person started the run, one deployment domain. */
const base = {
  requester: "asked.person@example.com",
  deploymentAllowlist: ["example.com"],
  workspaceAllowlist: null,
  caps: CAPS,
} as const;

const resolve = (over: Partial<Parameters<typeof resolveRecipients>[0]> = {}) =>
  resolveRecipients({ explicitTo: [], explicitCc: [], ...base, ...over });

/**
 * Narrow the discriminated union so a failed expectation reads as an assertion
 * failure rather than a type error. Generic over both `resolveRecipients` and
 * `checkMessageCaps`, which share the refusal shape but not the success shape.
 */
function refused<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  if (r.ok) throw new Error(`expected a refusal, got ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: false }>;
}
function allowed<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe("EMAIL_RE — is this string an address at all", () => {
  it("accepts ordinary addresses", () => {
    for (const a of ["a@b.co", "first.last@sub.example.com", "x+tag@example.co.uk"]) {
      expect(EMAIL_RE.test(a)).toBe(true);
    }
  });

  it("rejects the values that actually turn up in `requested_by`", () => {
    // ⚠ These are not hypothetical bad inputs — they are the real contents of
    // `flow_executions.requested_by` for non-person runs. Treating any of them
    // as a mailbox is the failure this regex exists to prevent.
    for (const notAnAddress of [
      "system",
      "trigger:nightly-close",
      "b3c1f0e2-4d5a-4c7b-9f01-2a3b4c5d6e7f", // an Entra object id
      "",
      "no-at-sign.example.com",
      "two@@example.com",
      "spaces in@example.com",
      "a@localhost", // no dot in the domain
    ]) {
      expect(EMAIL_RE.test(notAnAddress)).toBe(false);
    }
  });
});

describe("US3 — resolving the requester from the execution row", () => {
  // ⚠ Read off `flow_executions` directly, never joined from `flow_run_requests`
  // (plan.md Decision 3). The row carries a copy taken at `begin`; the pointer is
  // not followed later.

  it("accepts a `user` run whose requester is an address", () => {
    expect(resolveRequester({ requestedBy: "her@example.com", requestedByKind: "user" })).toBe(
      "her@example.com",
    );
  });

  it("accepts a `replay` run — a person pressed replay, so there is a person", () => {
    expect(resolveRequester({ requestedBy: "him@example.com", requestedByKind: "replay" })).toBe(
      "him@example.com",
    );
  });

  it.each(["trigger", "system", "schedule", "unknown"] as const)(
    "refuses to invent a person for a `%s` run",
    (kind) => {
      // Even when the column happens to hold something address-shaped. A
      // scheduled run has no requester by definition, and guessing one is how a
      // nightly job starts emailing whoever last touched the flow.
      expect(resolveRequester({ requestedBy: "someone@example.com", requestedByKind: kind })).toBe(
        null,
      );
    },
  );

  it("refuses a `user` run whose requester is not an address", () => {
    // `requestedBy` is `user.email ?? user.subject` — so an identity with no
    // email claim leaves an Entra OID here, and it must not become a mailbox.
    expect(
      resolveRequester({
        requestedBy: "b3c1f0e2-4d5a-4c7b-9f01-2a3b4c5d6e7f",
        requestedByKind: "user",
      }),
    ).toBe(null);
  });

  it("refuses the literal `system` even on a `user`-kind row", () => {
    expect(resolveRequester({ requestedBy: "system", requestedByKind: "user" })).toBe(null);
  });

  it("refuses null and empty", () => {
    expect(resolveRequester({ requestedBy: null, requestedByKind: "user" })).toBe(null);
    expect(resolveRequester({ requestedBy: "", requestedByKind: "user" })).toBe(null);
    expect(resolveRequester({ requestedBy: "a@b.co", requestedByKind: null })).toBe(null);
  });

  it("trims and lowercases, because a mailbox is not case-sensitive", () => {
    expect(resolveRequester({ requestedBy: "  Her@Example.COM ", requestedByKind: "user" })).toBe(
      "her@example.com",
    );
  });
});

describe("US1 — no `to` means the requester", () => {
  it("sends to the requester alone and says so", () => {
    const r = allowed(resolve());
    expect(r.to).toEqual(["asked.person@example.com"]);
    expect(r.cc).toEqual([]);
    expect(r.resolvedFrom).toBe("requester");
  });

  it("needs no allowlist entry for the requester — not even a matching domain", () => {
    // The point of the default: it works on a deployment that has allowlisted
    // nothing at all, which is the deployment most likely to exist.
    const r = allowed(
      resolve({ requester: "her@outside-vendor.io", deploymentAllowlist: ["example.com"] }),
    );
    expect(r.to).toEqual(["her@outside-vendor.io"]);
  });

  it("refuses when there is no `to` AND no resolvable requester", () => {
    // US3: the loud refusal. The alternative — falling back to a configured
    // address — would deliver a tenant's payroll report to an operator.
    const r = refused(resolve({ requester: null }));
    expect(r.status).toBe(422);
    expect(r.message).toMatch(/no recipient/i);
    expect(r.detail).toMatchObject({ remedy: expect.stringMatching(/`to`/) });
  });
});

describe("US2 — an explicit `to` must be allowlisted", () => {
  it("allows an address on an allowlisted deployment domain", () => {
    const r = allowed(resolve({ explicitTo: ["colleague@example.com"] }));
    expect(r.to).toEqual(["colleague@example.com"]);
    expect(r.resolvedFrom).toBe("explicit");
  });

  it("refuses an address on no allowlisted domain, naming address and rule", () => {
    const r = refused(resolve({ explicitTo: ["stranger@elsewhere.net"] }));
    expect(r.status).toBe(422);
    expect(r.detail).toMatchObject({ rejected: ["stranger@elsewhere.net"] });
    expect((r.detail as { rule: string }).rule).toMatch(/allow/i);
    // The rule text must be actionable: it names the setting an operator changes.
    expect((r.detail as { rule: string }).rule).toMatch(/MAIL_ALLOWED_RECIPIENT_DOMAINS/);
  });

  it("permits the requester by name even when their own domain is not allowlisted", () => {
    const r = allowed(
      resolve({ requester: "her@outside-vendor.io", explicitTo: ["her@outside-vendor.io"] }),
    );
    expect(r.to).toEqual(["her@outside-vendor.io"]);
    expect(r.resolvedFrom).toBe("explicit");
  });

  it("refuses the WHOLE call when one of several recipients fails", () => {
    // ⚠ FR-007, and the most important assertion in this file. Two good
    // addresses and one bad one send nothing — there is no code path that
    // delivers the good two.
    const r = refused(
      resolve({
        explicitTo: ["ok1@example.com", "stranger@elsewhere.net", "ok2@example.com"],
      }),
    );
    expect(r.status).toBe(422);
    expect(r.detail).toMatchObject({ rejected: ["stranger@elsewhere.net"] });
  });

  it("names EVERY rejected address, not just the first", () => {
    // A caller fixing one address at a time round-trips through the model once
    // per bad address; naming them all is one redraft instead of three.
    const r = refused(
      resolve({ explicitTo: ["a@elsewhere.net", "ok@example.com", "b@other.org"] }),
    );
    expect(r.detail).toMatchObject({ rejected: ["a@elsewhere.net", "b@other.org"] });
  });

  it("applies the same allowlist to `cc`", () => {
    // Cc is delivery. A `cc` exemption would be a bypass of the entire policy.
    const r = refused(
      resolve({ explicitTo: ["ok@example.com"], explicitCc: ["stranger@elsewhere.net"] }),
    );
    expect(r.detail).toMatchObject({ rejected: ["stranger@elsewhere.net"] });
  });

  it("rejects a malformed address as a policy failure, not a crash", () => {
    const r = refused(resolve({ explicitTo: ["not-an-address"] }));
    expect(r.status).toBe(422);
    expect(r.detail).toMatchObject({ rejected: ["not-an-address"] });
  });
});

describe("US2 — an empty deployment allowlist means the requester and nobody else", () => {
  // ⚠ There is no wildcard value, deliberately. A deployment that wants wide
  // sending lists its domains; the absence of configuration is not consent.

  it("still sends to the requester with no `to`", () => {
    expect(allowed(resolve({ deploymentAllowlist: [] })).to).toEqual(["asked.person@example.com"]);
  });

  it("refuses every named address that is not the requester", () => {
    const r = refused(resolve({ deploymentAllowlist: [], explicitTo: ["colleague@example.com"] }));
    expect(r.detail).toMatchObject({ rejected: ["colleague@example.com"] });
  });

  it("still permits the requester named explicitly", () => {
    expect(
      allowed(resolve({ deploymentAllowlist: [], explicitTo: ["asked.person@example.com"] })).to,
    ).toEqual(["asked.person@example.com"]);
  });
});

describe("US2 — the workspace allowlist NARROWS, it never widens", () => {
  // `null` = no narrowing; `[]` = requester only; entries are addresses or bare
  // domains. Both gates must pass, so a workspace cannot grant a domain the
  // deployment has not.

  it("null narrows nothing", () => {
    expect(
      allowed(resolve({ workspaceAllowlist: null, explicitTo: ["colleague@example.com"] })).to,
    ).toEqual(["colleague@example.com"]);
  });

  it("an address entry admits exactly that address", () => {
    const ws = ["named@example.com"];
    expect(allowed(resolve({ workspaceAllowlist: ws, explicitTo: ["named@example.com"] })).to)
      .toEqual(["named@example.com"]);
    expect(
      refused(resolve({ workspaceAllowlist: ws, explicitTo: ["other@example.com"] })).detail,
    ).toMatchObject({ rejected: ["other@example.com"] });
  });

  it("a bare-domain entry admits that domain", () => {
    expect(
      allowed(resolve({ workspaceAllowlist: ["example.com"], explicitTo: ["any@example.com"] })).to,
    ).toEqual(["any@example.com"]);
  });

  it("CANNOT widen past the deployment allowlist", () => {
    // ⚠ The containment property. A workspace admin editing their own allowlist
    // must not be able to reach a domain the operator excluded.
    const r = refused(
      resolve({
        deploymentAllowlist: ["example.com"],
        workspaceAllowlist: ["elsewhere.net"],
        explicitTo: ["stranger@elsewhere.net"],
      }),
    );
    expect(r.detail).toMatchObject({ rejected: ["stranger@elsewhere.net"] });
  });

  it("an empty workspace allowlist means requester-only", () => {
    expect(allowed(resolve({ workspaceAllowlist: [] })).to).toEqual(["asked.person@example.com"]);
    expect(
      refused(resolve({ workspaceAllowlist: [], explicitTo: ["colleague@example.com"] })).status,
    ).toBe(422);
  });

  it("still permits the requester through a narrowed workspace", () => {
    expect(
      allowed(
        resolve({ workspaceAllowlist: ["nobody@example.com"], explicitTo: [base.requester] }),
      ).to,
    ).toEqual([base.requester]);
  });
});

describe("normalisation and dedup", () => {
  it("dedupes case-insensitively and keeps one canonical form", () => {
    const r = allowed(
      resolve({ explicitTo: ["Colleague@Example.com", "colleague@example.com", "COLLEAGUE@EXAMPLE.COM"] }),
    );
    expect(r.to).toEqual(["colleague@example.com"]);
  });

  it("trims surrounding whitespace before deciding anything", () => {
    expect(allowed(resolve({ explicitTo: ["  colleague@example.com  "] })).to).toEqual([
      "colleague@example.com",
    ]);
  });

  it("drops an address from `cc` when it is already in `to`", () => {
    // Graph would deliver twice and the recipient would see themselves cc'd on
    // their own mail.
    const r = allowed(
      resolve({ explicitTo: ["colleague@example.com"], explicitCc: ["Colleague@example.com"] }),
    );
    expect(r.to).toEqual(["colleague@example.com"]);
    expect(r.cc).toEqual([]);
  });

  it("ignores empty strings rather than treating them as recipients", () => {
    const r = allowed(resolve({ explicitTo: ["colleague@example.com", "", "   "] }));
    expect(r.to).toEqual(["colleague@example.com"]);
  });

  it("treats a `to` of only blanks as no `to` at all, falling back to the requester", () => {
    const r = allowed(resolve({ explicitTo: ["", "  "] }));
    expect(r.to).toEqual(["asked.person@example.com"]);
    expect(r.resolvedFrom).toBe("requester");
  });

  it("matches the allowlist domain case-insensitively", () => {
    expect(
      allowed(resolve({ deploymentAllowlist: ["EXAMPLE.COM"], explicitTo: ["a@example.com"] })).to,
    ).toEqual(["a@example.com"]);
  });
});

describe("caps — every refusal names `actual` and `allowed`", () => {
  it("refuses more recipients than the cap, counting `to` and `cc` together", () => {
    const many = Array.from({ length: 8 }, (_, i) => `p${i}@example.com`);
    const r = refused(
      resolve({ explicitTo: many, explicitCc: ["x@example.com", "y@example.com", "z@example.com"] }),
    );
    expect(r.status).toBe(422);
    expect(r.detail).toMatchObject({ actual: 11, allowed: 10 });
  });

  it("counts AFTER dedup, so a duplicated list is not spuriously over the cap", () => {
    const dupes = Array.from({ length: 20 }, () => "one@example.com");
    expect(allowed(resolve({ explicitTo: dupes })).to).toEqual(["one@example.com"]);
  });

  it("refuses a subject over the character cap", () => {
    const r = refused(
      checkMessageCaps({ subject: "s".repeat(SUBJECT_MAX_CHARS + 1), body: "ok", caps: CAPS }),
    );
    expect(r.status).toBe(422);
    expect(r.detail).toMatchObject({ actual: SUBJECT_MAX_CHARS + 1, allowed: SUBJECT_MAX_CHARS });
  });

  it("refuses a newline in the subject", () => {
    // A header injection shape. Graph would almost certainly reject or sanitise
    // it, but "the provider probably handles it" is not a control.
    for (const subject of ["a\nb", "a\rb", "a\r\nb"]) {
      const r = refused(checkMessageCaps({ subject, body: "ok", caps: CAPS }));
      expect(r.message).toMatch(/newline/i);
    }
  });

  it("refuses an empty subject and an empty body", () => {
    expect(refused(checkMessageCaps({ subject: "   ", body: "ok", caps: CAPS })).status).toBe(422);
    expect(refused(checkMessageCaps({ subject: "ok", body: "", caps: CAPS })).status).toBe(422);
  });

  it("measures the body in BYTES, not characters", () => {
    // ⚠ The bug this prevents: a UTF-8 report of 200k characters is not 200k
    // bytes. `.length` would let a body through that Graph then rejects, and the
    // refusal would come from Microsoft instead of from us.
    const caps = { ...CAPS, maxBodyBytes: 10 };
    expect(allowed(checkMessageCaps({ subject: "s", body: "abcdefghij", caps }))).toBeTruthy();

    const fiveEuro = "€€€€€"; // 5 chars, 15 bytes
    expect(fiveEuro.length).toBe(5);
    const r = refused(checkMessageCaps({ subject: "s", body: fiveEuro, caps }));
    expect(r.detail).toMatchObject({ actual: 15, allowed: 10 });
  });

  it("accepts a body exactly at the cap — the boundary is inclusive", () => {
    const caps = { ...CAPS, maxBodyBytes: 4 };
    expect(allowed(checkMessageCaps({ subject: "s", body: "abcd", caps }))).toBeTruthy();
    expect(refused(checkMessageCaps({ subject: "s", body: "abcde", caps })).status).toBe(422);
  });
});

describe("D-267 — a DRAFT run accepts RFC 2606 reserved recipients; live policy is unchanged", () => {
  const base = { explicitCc: [], requester: "me@microland.com", deploymentAllowlist: ["microland.com"], workspaceAllowlist: null, caps: { maxRecipients: 10, maxBodyBytes: 1_000_000 } };

  it("draft: a reserved-domain address passes and is NAMED as such", () => {
    const r = resolveRecipients({ ...base, explicitTo: ["marta@acme-hr.example", "x@example.com"], draftAllowsReserved: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reservedAllowed).toEqual(["marta@acme-hr.example", "x@example.com"]);
  });

  it("⚠ live (flag absent): the same address is refused exactly as before", () => {
    const r = resolveRecipients({ ...base, explicitTo: ["marta@acme-hr.example"] });
    expect(r.ok).toBe(false);
  });

  it("⚠ draft does NOT open real domains — only reserved ones", () => {
    const r = resolveRecipients({ ...base, explicitTo: ["someone@gmail.com"], draftAllowsReserved: true });
    expect(r.ok).toBe(false);
  });

  it("CONTROL: an allowlisted address in a draft is not reported as reserved", () => {
    const r = resolveRecipients({ ...base, explicitTo: ["a@microland.com"], draftAllowsReserved: true });
    expect(r.ok && r.reservedAllowed).toBeFalsy();
  });

  it("isReservedDomain: the reserved names and nothing lookalike", () => {
    for (const d of ["acme-hr.example", "a.test", "x.invalid", "h.localhost", "example.com"]) expect(isReservedDomain(d)).toBe(true);
    for (const d of ["example.co", "myexample.com", "exampletest.com", "microland.com"]) expect(isReservedDomain(d)).toBe(false);
  });
});
