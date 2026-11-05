/**
 * What the health endpoint is ALLOWED to say — GAPS §6.2.
 *
 * Three properties are load-bearing and each has a case that fails without the
 * behaviour:
 *
 *   1. a dependency being down does not take this process out of the load
 *      balancer, and its OWN database being down does;
 *   2. nothing in the body addresses Kestra, names an internal host or carries
 *      a credential — the route is unauthenticated;
 *   3. every component states the bound of its own probe, and mail's states
 *      the `llmConnected` false green **in the response**, not in a doc.
 *
 * The probes are injected, so none of this needs a database, an engine or a
 * network — and there is no environment branch in `buildReport` for a test to
 * accidentally exercise instead of the real path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The engine probe is reported only where one is configured; these tests describe a deployment that has one. Set here,
// not inherited from a local .env, so the suite means the same on every machine.
beforeEach(() => vi.stubEnv("KESTRA_BASE_URL", "http://kestra:8080"));
afterEach(() => vi.unstubAllEnvs());

/**
 * The real migration probe needs a database, so its ONE interesting branch —
 * "the ledger table does not exist" versus "the query failed" — is proved
 * against a fake pool rather than left to a harness nobody runs on a cold
 * install. Hoisted, so `liveDeps` below sees the fake; nothing else in this file
 * touches the database.
 */
const dbExecute = vi.fn();
vi.mock("../db/index.js", () => ({ db: { execute: (...a: unknown[]) => dbExecute(...a) } }));

import {
  buildReport,
  liveDeps,
  sanitizeDetail,
  expectedMigrations,
  type HealthDeps,
  type HealthReport,
} from "./health.service.js";

const healthy: HealthDeps = {
  pingDatabase: async () => {},
  migrations: async () => ({ applied: 12, expected: 12 }),
  kestra: async () => ({ reachable: true, authenticated: true }),
  // email-send-tool T040. Injected like every other component so this suite does
  // not pass or fail according to whether the developer running it happens to have
  // Graph configured in their `.env`.
  mail: async () => ({ configured: true, enabled: true, missing: [] }),
};

const deps = (over: Partial<HealthDeps>): HealthDeps => ({ ...healthy, ...over });
const at = (r: HealthReport, name: string) => r.components.find((c) => c.name === name)!;

describe("mail — a CONFIG check that must never read as a working sender", () => {
  /**
   * ⚠ The runtime component this file used to carry is the documented example
   * of the mistake this component is one step away from: reporting `up` because
   * an endpoint exists. `up` here means the four variables are set — not that a
   * message can be delivered, which needs tenant admin consent on the `Mail.Send`
   * application permission and an Exchange application access policy, neither of
   * which is visible without sending something.
   */
  it("is `up` when configured, and NOT critical", async () => {
    const r = await buildReport(healthy);
    expect(at(r, "mail").status).toBe("up");
    expect(at(r, "mail").critical).toBe(false);
    // No probe ran, so there is no latency to report. `latencyMs`'s own contract
    // says null means "it never ran" — a 0 would claim an instant round trip.
    expect(at(r, "mail").latencyMs).toBeNull();
  });

  it("is `down` when unconfigured, naming EVERY missing variable", async () => {
    // The same list the endpoint's 424 gives, from the same `config.mail.missing`,
    // so the health page and the refusal cannot disagree about what to set.
    const r = await buildReport(
      deps({
        mail: async () => ({
          configured: false,
          enabled: true,
          missing: ["MAIL_GRAPH_TENANT_ID", "MAIL_SENDER_UPN"],
        }),
      }),
    );
    expect(at(r, "mail").status).toBe("down");
    expect(at(r, "mail").detail).toMatch(/MAIL_GRAPH_TENANT_ID/);
    expect(at(r, "mail").detail).toMatch(/MAIL_SENDER_UPN/);
  });

  it("does not take the deployment down — email is not critical", async () => {
    const r = await buildReport(
      deps({ mail: async () => ({ configured: false, enabled: true, missing: ["MAIL_SENDER_UPN"] }) }),
    );
    expect(r.status).toBe("degraded");
    expect(r.serves).toBe(true);
  });

  it("reports a deliberate MAIL_ENABLED=false as `degraded`, not `down`", async () => {
    // A switched-off capability is not a fault. Reporting it as one trains a reader
    // to ignore the field — but it is not `up` either, because a flow that emails
    // will be refused.
    const r = await buildReport(
      deps({ mail: async () => ({ configured: true, enabled: false, missing: [] }) }),
    );
    expect(at(r, "mail").status).toBe("degraded");
    expect(at(r, "mail").detail).toMatch(/MAIL_ENABLED/);
  });

  it("its caveat says it does not contact Microsoft", async () => {
    // The caveat travels with the answer, never only in a doc.
    const r = await buildReport(healthy);
    expect(at(r, "mail").caveat).toMatch(/does not contact Microsoft/i);
    expect(at(r, "mail").caveat).toMatch(/admin consent/i);
    expect(at(r, "mail").caveat).toMatch(/configured, not working/i);
  });
});

describe("what /api/health means", () => {
  it("no engine configured → no kestra component, and the deployment is still ok", async () => {
    vi.stubEnv("KESTRA_BASE_URL", "");
    const r = await buildReport(healthy);
    expect(r.status).toBe("ok");
    expect(r.components.map((c) => c.name)).toEqual(["database", "migrations", "mail"]);
  });

  it("everything up → ok, serving, six components", async () => {
    const r = await buildReport(healthy);
    expect(r.status).toBe("ok");
    expect(r.serves).toBe(true);
    expect(r.components.map((c) => c.name)).toEqual([
      "database",
      "migrations",
      "kestra",
      "mail",
    ]);
  });

  /**
   * The decision this gap turned on. With the engine unreachable the API can
   * still list flows and show a person the reason — ejecting it from the load
   * balancer removes the only surface that could.
   */
  it("Kestra down is DEGRADED and still serving — not 503", async () => {
    const r = await buildReport(
      deps({ kestra: async () => ({ reachable: false, authenticated: false, detail: "refused" }) }),
    );
    expect(r.status).toBe("degraded");
    expect(r.serves).toBe(true);
    expect(at(r, "kestra").status).toBe("down");
    expect(at(r, "kestra").critical).toBe(false);
  });

  it("the process's OWN database down is `down` and not serving", async () => {
    const r = await buildReport(
      deps({
        pingDatabase: async () => {
          throw new Error("connection terminated");
        },
      }),
    );
    expect(r.status).toBe("down");
    expect(r.serves).toBe(false);
    expect(at(r, "database").critical).toBe(true);
  });

  it("migrations behind the build is `down` — the schema this code expects is not there", async () => {
    const r = await buildReport(deps({ migrations: async () => ({ applied: 9, expected: 12 }) }));
    expect(r.serves).toBe(false);
    expect(at(r, "migrations").detail).toContain("3 of 12");
  });

  it("no ledger at all is `down` and says migrations have NEVER run", async () => {
    const r = await buildReport(
      deps({ migrations: async () => ({ applied: 0, expected: 12, ledgerMissing: true }) }),
    );
    expect(r.serves).toBe(false);
    expect(at(r, "migrations").detail).toMatch(/no migration ledger/);
    expect(at(r, "migrations").detail).toMatch(/ever been applied/);
  });

  /**
   * Ahead, not behind. A rollback or a mixed-version deploy: this process is
   * older than the schema and very likely still serves, so refusing traffic on
   * that guess is worse than reporting it.
   */
  it("more migrations applied than shipped is degraded, and names the direction", async () => {
    const r = await buildReport(deps({ migrations: async () => ({ applied: 14, expected: 12 }) }));
    expect(r.serves).toBe(true);
    expect(at(r, "migrations").status).toBe("degraded");
    expect(at(r, "migrations").detail).toMatch(/older than the schema/);
  });

  /**
   * `unknown` ≠ `down`. We could not ask; that is not evidence of failure, and
   * ejecting the process for an unreadable journal turns a packaging mistake
   * into an outage.
   */
  it("a migration probe that cannot RUN is `unknown` and keeps the process serving", async () => {
    const r = await buildReport(
      deps({
        migrations: async () => {
          throw new Error("ENOENT: no such file _journal.json");
        },
      }),
    );
    expect(at(r, "migrations").status).toBe("unknown");
    expect(r.serves).toBe(true);
    expect(r.status).toBe("degraded");
  });

  it("Kestra reachable but rejecting our credential is DOWN, and says which of the two it is", async () => {
    const r = await buildReport(
      deps({ kestra: async () => ({ reachable: true, authenticated: false, detail: "401" }) }),
    );
    expect(at(r, "kestra").status).toBe("down");
    expect(at(r, "kestra").detail).toMatch(/REJECTED our credential/);
  });

});

describe("a probe cannot hang the endpoint", () => {
  /**
   * The Kestra client's own ceiling is 30s. A health check that hangs is worse
   * than one that lies: the load balancer's timeout fires and every instance
   * drops out together.
   */
  it("a probe that never resolves becomes `down` at the deadline, and the rest still answer", async () => {
    const r = await buildReport(
      deps({ kestra: () => new Promise(() => {}) }),
      40,
    );
    expect(at(r, "kestra").status).toBe("down");
    expect(at(r, "kestra").detail).toMatch(/did not answer within 40ms/);
    expect(at(r, "database").status).toBe("up");
    expect(r.probeTimeoutMs).toBe(40);
  });

  it("probes run concurrently, so six slow ones cost one deadline and not six", async () => {
    const slow = () => new Promise<never>(() => {});
    const t0 = Date.now();
    await buildReport(
      {
        pingDatabase: slow,
        migrations: slow,
        kestra: slow,
        mail: slow,
      },
      60,
    );
    expect(Date.now() - t0).toBeLessThan(240);
  });
});

describe("nothing in the body may leak", () => {
  const leaky =
    "Kestra GET /api/v1/configs → transport failure: getaddrinfo ENOTFOUND kestra " +
    "(http://kestra:8080) execution 6ZQ1abcdefGHIJKLmnopqrst in foundry.acme.hr.draft " +
    "with authorization Bearer sk-live-0123456789abcdefghijklmnop";

  it("strips URLs, host:port, ids, namespaces and token-shaped strings", () => {
    const s = sanitizeDetail(leaky);
    expect(s).not.toMatch(/http:\/\//);
    expect(s).not.toMatch(/:8080/);
    expect(s).not.toMatch(/foundry\.acme\.hr/);
    expect(s).not.toMatch(/6ZQ1abcdefGHIJKLmnopqrst/);
    expect(s).not.toMatch(/sk-live-0123456789abcdefghijklmnop/);
    // …and still says something a person can act on.
    expect(s).toMatch(/ENOTFOUND/);
  });

  it("a UUID does not survive — an execution id is 36 characters of exactly that alphabet", () => {
    expect(sanitizeDetail("run 550e8400-e29b-41d4-a716-446655440000 failed")).not.toMatch(
      /550e8400/,
    );
  });

  it("detail is bounded, so an upstream cannot use it as an output channel", () => {
    expect(sanitizeDetail("x".repeat(5000)).length).toBeLessThanOrEqual(221);
  });

  /**
   * The end-to-end version of the three above: whatever an upstream says, the
   * assembled report holds none of it verbatim.
   */
  it("upstream error text reaches the report already redacted", async () => {
    const r = await buildReport(
      deps({
        kestra: async () => ({ reachable: false, authenticated: false, detail: leaky }),
      }),
    );
    const body = JSON.stringify(r);
    expect(body).not.toMatch(/http:\/\//);
    expect(body).not.toMatch(/foundry\.acme\.hr/);
    expect(body).not.toMatch(/sk-live-/);
  });
});

describe("every probe states its own bound, in the response", () => {
  it("all five carry a non-empty caveat", async () => {
    const r = await buildReport(healthy);
    for (const c of r.components) expect(c.caveat.length).toBeGreaterThan(40);
  });

  /**
   * ⚠ **THE SUBJECT CHANGED; THE PROPERTY DID NOT.** This asserted it of the
   * runtime component, whose `llmConnected: true` was the documented false green
   * — derived from a model LISTING, so it proved no completion had ever
   * succeeded — and it stayed a trap because the warning lived in a doc while the
   * boolean travelled on the wire. That component is gone with its runtime;
   * `mail` is the surviving one whose `up` is far weaker than a reader will take
   * it for, so it inherits the assertion rather than the file losing it.
   */
  it("a component whose `up` is weaker than it reads carries the warning beside it", async () => {
    const r = await buildReport(healthy);
    expect(at(r, "mail").status).toBe("up");
    expect(at(r, "mail").caveat).toMatch(/does not contact Microsoft/i);
  });

  it("Kestra's caveat refuses to be read as “a flow can execute”", async () => {
    expect(at(await buildReport(healthy), "kestra").caveat).toMatch(/does NOT prove a flow can/);
  });
});

describe("the migration journal this build ships", () => {
  /**
   * The count is read from `drizzle/meta/_journal.json` at runtime, which the
   * Dockerfile copies beside `dist/`. If that ever stops being true the probe
   * reports `unknown` rather than lying — but this asserts the happy path is
   * real, not that the fallback works.
   */
  it("is readable and names every migration in order", () => {
    const tags = expectedMigrations();
    expect(tags.length).toBeGreaterThan(20);
    expect(tags[0]).toMatch(/^0000_/);
  });

  it("counts the ledger against the journal", async () => {
    dbExecute.mockResolvedValueOnce({ rows: [{ n: 7 }] });
    const m = await liveDeps.migrations();
    expect(m.applied).toBe(7);
    expect(m.expected).toBe(expectedMigrations().length);
    expect(m.ledgerMissing).toBeUndefined();
  });

  /**
   * ⚠ The branch worth having. `42P01` is `undefined_table` — the ledger not
   * existing is not an uninterpretable error, it is the strongest evidence
   * available that migrations have NEVER run here. Swallowing it into the
   * generic catch would report `unknown` (which keeps the process serving) for
   * a database with no schema at all.
   */
  it("a missing ledger table is reported as “never applied”, not as an unreadable probe", async () => {
    dbExecute.mockRejectedValueOnce(
      Object.assign(new Error('relation "drizzle.__drizzle_migrations" does not exist'), {
        code: "42P01",
      }),
    );
    const m = await liveDeps.migrations();
    expect(m).toMatchObject({ applied: 0, ledgerMissing: true });
  });

  /** The shape Drizzle actually throws (0.44+): the SQLSTATE is on `cause`, not on the error itself. */
  it("a missing ledger table is still “never applied” when Drizzle wraps the error", async () => {
    const raw = Object.assign(new Error('relation "drizzle.__drizzle_migrations" does not exist'), { code: "42P01" });
    dbExecute.mockRejectedValueOnce(new Error("Failed query: select count(*) ...", { cause: raw }));
    const m = await liveDeps.migrations();
    expect(m).toMatchObject({ applied: 0, ledgerMissing: true });
  });

  it("any other database error is rethrown, so the component reports `unknown`", async () => {
    dbExecute.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "42501" }));
    await expect(liveDeps.migrations()).rejects.toThrow(/permission denied/);
  });
});
