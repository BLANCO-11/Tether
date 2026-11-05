import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { SYSTEM_AUTHOR_NAME } from "../services/revision-author.js";

/**
 * The identity middleware — Stage 9.1.
 *
 * Three of these tests are the ones that would silently stop holding, and each
 * has a control that fails if the check is written the tempting way:
 *
 *  * **A present-but-invalid token must be a 401, never "no identity".** The
 *    tempting version treats a bad token like an absent one and carries on under
 *    the API key, so an expired session records an approval attributed to
 *    nobody — worse than before the middleware existed, because the field now
 *    looks verified. The control is the absent-header case, which MUST pass
 *    through: an implementation that 401s on everything satisfies the first half
 *    and breaks Kestra's step callbacks.
 *  * **`alg` is pinned.** A token this server did not sign must be refused
 *    however confidently it announces its own algorithm.
 *  * **`authorOf` refuses a body value from a signed-in caller** rather than
 *    overriding it, because a field that is accepted and ignored reads, to the
 *    next person, as a field that works.
 */

const SECRET = "test-identity-secret-do-not-use-anywhere-else";
process.env.RUNTIME_JWT_SECRET = SECRET;

const { resolveIdentity, requireIdentity, actorOf, authorOf, IDENTITY_HEADER } = await import(
  "./identity.middleware.js"
);

const key = new TextEncoder().encode(SECRET);

async function token(
  claims: Record<string, unknown>,
  opts: { expiresIn?: string; signWith?: Uint8Array } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(opts.signWith ?? key);
}

/** A minimal express-shaped request/response pair. */
function ctx(headerValue?: string, ip = "10.0.0.100") {
  const req = {
    headers: {} as Record<string, string>,
    ip,
    path: "/api/workspaces",
    header(name: string) {
      return name.toLowerCase() === IDENTITY_HEADER ? headerValue : undefined;
    },
  } as unknown as import("express").Request;
  let statusCode = 0;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    get headers() {
      return headers;
    },
  } as unknown as import("express").Response;
  let nextArg: unknown = "not-called";
  const next = ((e?: unknown) => {
    nextArg = e;
  }) as import("express").NextFunction;
  return {
    req,
    res,
    next,
    get status() {
      return statusCode;
    },
    get body() {
      return payload as { error?: string; message?: string };
    },
    get responseHeaders() {
      return headers;
    },
    get called() {
      return nextArg !== "not-called";
    },
    get error() {
      return nextArg as (Error & { statusCode?: number }) | undefined;
    },
  };
}

describe("resolveIdentity", () => {
  it("passes an unauthenticated request straight through", async () => {
    // The control. Kestra's step callbacks, every kestra:* harness and the seeds
    // hold the API key and no session; a middleware that refused them would
    // break the engine while passing every other test in this file.
    const c = ctx(undefined);
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.called).toBe(true);
    expect(c.error).toBeUndefined();
    expect(c.req.user).toBeUndefined();
    expect(c.status).toBe(0);
  });

  it("attaches a verified identity", async () => {
    const c = ctx(await token({ sub: "oid-1", email: "approver@acme-hr.example", name: "A" }));
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.req.user).toEqual({
      subject: "oid-1",
      email: "approver@acme-hr.example",
      name: "A",
    });
    expect(actorOf(c.req)).toBe("approver@acme-hr.example");
  });

  it("401s a token signed with a DIFFERENT secret — never falls back to anonymous", async () => {
    const c = ctx(
      await token(
        { sub: "x", email: "attacker@example.com" },
        { signWith: new TextEncoder().encode("some-other-secret") },
      ),
    );
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.body.error).toBe("identity_invalid");
    // The load-bearing half: it did NOT carry on with the request unattributed.
    expect(c.called).toBe(false);
    expect(c.req.user).toBeUndefined();
  });

  it("401s an expired token, and says that is what happened", async () => {
    const c = ctx(await token({ sub: "x", email: "e@x.test" }, { expiresIn: "-5m" }));
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    // Distinct from `identity_invalid` because the fix is different: sign in
    // again, versus something is wrong with your deployment.
    expect(c.body.error).toBe("identity_expired");
  });

  it("refuses an unsigned token however it labels its algorithm", async () => {
    // `alg: none` with an empty signature — the classic. The verifier pins
    // HS256 and never reads the algorithm out of the token, so this cannot
    // negotiate its way in.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "x", email: "attacker@example.com", exp: 9_999_999_999 }),
    ).toString("base64url");
    const c = ctx(`${header}.${body}.`);
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.req.user).toBeUndefined();
  });

  it("refuses a token that names nobody", async () => {
    const c = ctx(await token({}));
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.status).toBe(401);
  });
});

describe("requireIdentity", () => {
  it("401s when there is no verified user", () => {
    const c = ctx(undefined);
    requireIdentity(c.req, c.res, c.next);
    expect(c.error?.statusCode).toBe(401);
    // The message has to say that the API key is not the problem, or the reader
    // goes looking at their key.
    expect(c.error?.message).toMatch(/API key authorises the request/);
  });

  it("passes when one is attached", async () => {
    const c = ctx(await token({ sub: "x", email: "e@x.test" }));
    await resolveIdentity(c.req, c.res, c.next);
    const c2 = { ...c };
    let passed = false;
    requireIdentity(c.req, c.res, ((e?: unknown) => {
      passed = e === undefined;
    }) as import("express").NextFunction);
    expect(passed).toBe(true);
    expect(c2).toBeTruthy();
  });
});

describe("authorOf", () => {
  /**
   * ⚠ These two used to assert a bare string, and the change of shape IS the fix
   * for archive/GAPS.md §1.2 rather than a refactor they need updating for. A name on its
   * own cannot answer *"did this server verify it?"*, so both callers of a name
   * — gate 2's self-approval comparison and the revision row — were treating a
   * body-supplied string and a verified identity as the same kind of fact. The
   * kind travels WITH the name now, for the same reason `resolveKey()` returns
   * `{ key, shared, secretName }` (D-42): a qualifier that can be dropped at a
   * call site is one that will be.
   */
  it("accepts a body value when nobody is signed in, and never calls it attested", () => {
    const c = ctx(undefined);
    expect(authorOf(c.req, "seed-script")).toEqual({
      createdBy: "seed-script",
      createdByKind: "system",
    });
    // No body value and no identity still produces an author — the row's column
    // is NOT NULL, and a writer that supplies nothing must land as unattested
    // rather than as an absence somebody later reads as "fine".
    expect(authorOf(c.req, undefined)).toEqual({
      createdBy: SYSTEM_AUTHOR_NAME,
      createdByKind: "system",
    });
  });

  it("uses the verified identity when there is one, and marks it `user`", async () => {
    const c = ctx(await token({ sub: "x", email: "author@acme-hr.example" }));
    await resolveIdentity(c.req, c.res, c.next);
    expect(authorOf(c.req, undefined)).toEqual({
      createdBy: "author@acme-hr.example",
      createdByKind: "user",
    });
  });

  it("REFUSES a body value alongside a verified identity, rather than overriding it", async () => {
    const c = ctx(await token({ sub: "x", email: "author@acme-hr.example" }));
    await resolveIdentity(c.req, c.res, c.next);
    expect(() => authorOf(c.req, "someone-else")).toThrowError(/not accepted from a signed-in/);
  });
});

describe("resolveIdentity — auth-failure throttling shares one instance with requireApiKey (FR-007)", () => {
  it("a rejected token records a failure and throttles after enough of them, from the same IP", async () => {
    const { resetAuthFailureThrottleForTests } = await import("./auth.middleware.js");
    resetAuthFailureThrottleForTests();
    const ip = "10.0.0.200";
    const badToken = await token(
      { sub: "x", email: "attacker@example.com" },
      { signWith: new TextEncoder().encode("some-other-secret") },
    );
    let last = ctx(badToken, ip);
    for (let i = 0; i < 20; i++) {
      last = ctx(badToken, ip);
      await resolveIdentity(last.req, last.res, last.next);
    }
    expect(last.status).toBe(429);
    expect(last.responseHeaders["Retry-After"]).toBeTruthy();
    resetAuthFailureThrottleForTests();
  });

  it("a single rejected token is still a plain 401 — not throttled on the first failure", async () => {
    const { resetAuthFailureThrottleForTests } = await import("./auth.middleware.js");
    resetAuthFailureThrottleForTests();
    const c = ctx(
      await token(
        { sub: "x", email: "attacker@example.com" },
        { signWith: new TextEncoder().encode("some-other-secret") },
      ),
      "10.0.0.201",
    );
    await resolveIdentity(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    resetAuthFailureThrottleForTests();
  });
});
