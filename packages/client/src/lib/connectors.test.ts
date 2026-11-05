// src/lib/connectors.test.ts — the picker may only offer what can be registered.
//
// ── The defect this exists to stop coming back ───────────────────────────────
//
// The catalogue used to offer five connectors and the server accepts two.
// MongoDB, Amazon S3 and Google Cloud Storage were pickable on
// `/data-sources/new`, rendered a full credential form, assembled a DSN and —
// for Mongo — stored a row. `datasource.service.ts` states the bound in its own
// docblock: `schemaIntrospectorService.supports()` covers `postgres` and `mysql`
// alone, so only those two can be introspected, only they can host a named
// query, and only a named query is reachable from a `datasource` step. Anything
// else is **inert** once registered.
//
// ⚠ **Inert is worse than refused**, which is why the three were deleted rather
// than disabled or labelled "coming soon". A refusal happens at registration,
// naming the reason, in front of the person who chose it. Inert happens at the
// first flow that tries to read, weeks later, and presents as a broken flow.
import { describe, expect, it } from "vitest";
import { CONNECTORS, isFileConnector } from "@/lib/connectors";
import { assembleConnectionString } from "@/lib/adapters";

/**
 * ⚠ **A MIRROR of the server, and it says so rather than pretending otherwise.**
 *
 * The authority is `packages/server/src/services/datasource.service.ts` and
 * `schemaIntrospectorService.supports()`; the client has no endpoint that would
 * tell it, and inventing one to serve two strings would be more moving parts
 * than the thing it guards. A test-only mirror is the honest shape here.
 *
 * ⚠ Know which direction it protects. If the SERVER gains a third engine this
 * stays green while the catalogue lags — a missing option, which somebody
 * notices and complains about. If the CATALOGUE gains one the server cannot
 * register, this goes red, which is the direction that ships a dead end.
 */
const REGISTRABLE = new Set(["postgres", "mysql", "sqlite"]);

/** The connectors whose credential is an assembled DSN — SQLite is a file, not one. */
const DSN_CONNECTORS = CONNECTORS.filter((c) => !isFileConnector(c));

/** The minimum a connector's own schema says it needs, filled with anything. */
function sampleCredentials(connectorId: string): Record<string, unknown> {
  const c = CONNECTORS.find((x) => x.id === connectorId)!;
  const props = c.onboarding_schema.auth?.properties ?? {};
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, (v as { default?: unknown }).default ?? `sample-${k}`]),
  );
}

describe("the connector catalogue offers only what the server can register", () => {
  it("has at least one entry, so the assertions below are not vacuous", () => {
    // I-38. A catalogue emptied by a bad edit would satisfy every `for` loop in
    // this file and report green.
    expect(CONNECTORS.length).toBeGreaterThan(0);
  });

  it("offers no connector the server would leave inert", () => {
    for (const c of CONNECTORS) {
      expect(
        REGISTRABLE.has(c.id),
        `${c.display_name} (${c.id}) is offered but cannot be introspected — see the docblock`,
      ).toBe(true);
    }
  });

  /**
   * The half that needs no mirror. `assembleConnectionString` maps a connector
   * id onto a DSN *type*, falling back to the raw id when it knows nothing —
   * which is how `s3` produced `s3://host:5432/bucket`, a string shaped like a
   * DSN that no driver will ever open.
   */
  it("assembles a DSN whose type the product actually understands", () => {
    expect(DSN_CONNECTORS.length).toBeGreaterThan(0);
    for (const c of DSN_CONNECTORS) {
      const { type, connectionString } = assembleConnectionString(c.id, sampleCredentials(c.id), c);
      expect(REGISTRABLE.has(type), `${c.id} assembles as type "${type}"`).toBe(true);
      expect(connectionString).toMatch(/^[a-z]+:\/\/.+/);
    }
  });

  it("names each entry's port default, because the assembler guesses otherwise", () => {
    // `assembleConnectionString` falls back to 5432 for anything it does not
    // recognise as MySQL or Mongo. A connector that declares no port default
    // therefore inherits Postgres's silently.
    for (const c of DSN_CONNECTORS) {
      const port = c.onboarding_schema.auth?.properties?.port as { default?: number } | undefined;
      expect(port?.default, `${c.id} declares no default port`).toBeTypeOf("number");
    }
  });
});

describe("SQLite is offered as a FILE, not a DSN", () => {
  it("is in the catalogue, marked as a file connector, with no fields to type a connection into", () => {
    const c = CONNECTORS.find((x) => x.id === "sqlite");
    expect(c).toBeTruthy();
    expect(isFileConnector(c)).toBe(true);
    expect(Object.keys(c!.onboarding_schema.auth?.properties ?? {})).toEqual([]);
  });
  it("no network connector is mistaken for a file one", () => {
    expect(isFileConnector(CONNECTORS.find((x) => x.id === "postgres"))).toBe(false);
    expect(isFileConnector(CONNECTORS.find((x) => x.id === "mysql"))).toBe(false);
  });
});

/**
 * The advanced section's own defaults, exactly as `initialValues` would seed
 * them — read off the catalogue rather than written out here, so a renamed
 * field changes what this test sends instead of leaving it testing a key
 * nothing uses.
 */
function advancedDefaults(connectorId: string): Record<string, unknown> {
  const c = CONNECTORS.find((x) => x.id === connectorId)!;
  const props = c.onboarding_schema.advanced?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const d = (v as { default?: unknown }).default;
    if (d !== undefined) out[k] = d;
  }
  return out;
}

/**
 * ── I-132: the TLS settings reach the DSN ────────────────────────────────────
 *
 * The advanced form collected `sslmode` and `require_tls` and
 * `assembleConnectionString` emitted no query string at all, so both were
 * inert. The cost was not cosmetic: Azure Postgres Flexible Server refuses an
 * unencrypted connection, so registration died in the first server-side gate
 * with the database's own complaint about `pg_hba.conf` — which reads as the
 * customer's server being misconfigured — while the SSL mode they had chosen
 * sat unread in the payload.
 *
 * ⚠ These assert the PAIR (catalogue field ↔ assembler read), not one side.
 * The failure mode is silent in both directions: rename the catalogue key and
 * the assembler stops finding it, change the assembler and the form's default
 * stops arriving. Either way the DSN goes out bare and the only symptom is a
 * connection error blaming the far end.
 */
describe("the TLS settings the form collects reach the DSN (I-132)", () => {
  it("puts PostgreSQL's seeded default in the connection string", () => {
    // Exactly what a person who never opens "advanced" sends: `pickConnector`
    // seeds `initialValues([...auth, ...advanced])` the moment they pick.
    const payload = { ...sampleCredentials("postgres"), ...advancedDefaults("postgres") };
    const { connectionString } = assembleConnectionString("postgres", payload);
    expect(connectionString).toContain("?sslmode=require");
  });

  it("declares a default SSL mode at all, or the line above tests nothing", () => {
    // I-38. With no default seeded there is nothing to carry, and the
    // assertion above would pass against a payload with no TLS setting in it.
    expect(advancedDefaults("postgres").sslmode).toBe("require");
  });

  it("emits `disable` rather than dropping it", () => {
    // The two behave identically at the wire. A DSN that says what the person
    // chose beats one that means it by absence — and `disable` is the ONLY way
    // to reach a plain no-TLS Postgres, because on pg 8.23 `prefer` does not
    // fall back.
    const { connectionString } = assembleConnectionString("postgres", {
      ...sampleCredentials("postgres"),
      sslmode: "disable",
    });
    expect(connectionString).toContain("?sslmode=disable");
  });

  it("offers `disable`, which is the only escape hatch for a no-TLS database", () => {
    const modes = (CONNECTORS.find((c) => c.id === "postgres")!.onboarding_schema.advanced
      ?.properties?.sslmode as { enum?: string[] } | undefined)?.enum;
    expect(modes).toContain("disable");
  });

  it("spells MySQL's TLS opt-in the way mysql2 reads it, not the way the form names it", () => {
    // ⚠ `require_tls` is the FORM's name for it. mysql2 rejects that as an
    // unknown connection option — it warns today and says it will throw — so
    // passing the key through verbatim would be a second inert field wearing a
    // working one's clothes. Verified against mysql2's own connection config:
    // `ssl={"rejectUnauthorized":true}` parses to `{rejectUnauthorized: true}`.
    const payload = { ...sampleCredentials("mysql"), ...advancedDefaults("mysql") };
    const { connectionString } = assembleConnectionString("mysql", payload);
    const ssl = new URL(connectionString).searchParams.get("ssl");
    expect(ssl && JSON.parse(ssl)).toEqual({ rejectUnauthorized: true });
    expect(connectionString).not.toContain("require_tls");
  });

  it("leaves the DSN alone when no TLS setting was collected", () => {
    // Every caller that predates this — and `update`, which rebuilds a DSN from
    // a stored row — must keep producing exactly what it produced before.
    const { connectionString } = assembleConnectionString("postgres", sampleCredentials("postgres"));
    expect(connectionString).not.toContain("?");
  });

  it("honours a full DSN's own parameters rather than appending to them", () => {
    const { connectionString } = assembleConnectionString("postgres", {
      connection_string: "postgresql://u:p@h:5432/db?sslmode=verify-full",
      sslmode: "disable",
    });
    expect(connectionString).toBe("postgresql://u:p@h:5432/db?sslmode=verify-full");
  });
});
