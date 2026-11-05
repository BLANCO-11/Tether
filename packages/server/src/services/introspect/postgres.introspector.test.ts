import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { config } from "../../config/index.js";
import { postgresIntrospector, columnType } from "./postgres.introspector.js";
import type { IntrospectedEntity } from "./types.js";

/**
 * WS-C verification (plans/production-substitution-plan.md §6).
 *
 * Builds a throwaway schema that has everything the HR demo's 7 flat tables do
 * NOT have — a named schema, a view, a materialized view, a composite primary
 * key, a two-column foreign key, an enum, an array, a mixed-case quoted
 * identifier, and a never-analysed table. That combination is the point: the demo
 * schema is too well-behaved to catch any of the bugs this workstream fixes, so
 * "it still returns 7 tables" proves nothing on its own.
 */

const ADMIN_DSN = (() => {
  const u = new URL(config.databaseUrl);
  u.pathname = `/${config.demo.dbName}`;
  return u.toString();
})();

const SCHEMA = "ws_c_probe";

const DDL = `
DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
CREATE SCHEMA ${SCHEMA};

CREATE TYPE ${SCHEMA}.mood AS ENUM ('low', 'normal', 'high');

CREATE TABLE ${SCHEMA}.org_units (
  region   varchar(8)  NOT NULL,
  code     varchar(16) NOT NULL,
  tags     text[],
  priority ${SCHEMA}.mood NOT NULL DEFAULT 'normal',
  -- Composite primary key: both columns must be reported as pk.
  PRIMARY KEY (region, code)
);

CREATE TABLE ${SCHEMA}.staff (
  id           integer PRIMARY KEY,
  home_region  varchar(8)  NOT NULL,
  home_code    varchar(16) NOT NULL,
  "MixedCase"  integer,
  -- Two-column foreign key. information_schema.constraint_column_usage returns
  -- the cartesian product here, so this is the case that catches mispairing.
  FOREIGN KEY (home_region, home_code) REFERENCES ${SCHEMA}.org_units (region, code)
);

-- A plain view: must be kind="view" with NO row estimate.
CREATE VIEW ${SCHEMA}.active_staff AS SELECT id, home_region FROM ${SCHEMA}.staff;

-- A materialized view: distinct kind, and it DOES have a real row count.
CREATE MATERIALIZED VIEW ${SCHEMA}.staff_rollup AS
  SELECT home_region, count(*) AS n FROM ${SCHEMA}.staff GROUP BY home_region;

-- Never ANALYZEd, so pg_class.reltuples is -1. This is the table that used to
-- render as rowsEstimate="~-1".
CREATE TABLE ${SCHEMA}.unanalysed (id integer PRIMARY KEY);
`;

let reachable = false;
let skipReason = "";

const setup = await (async () => {
  const c = new Client({ connectionString: ADMIN_DSN, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.query(DDL);
    // ANALYZE only the relations that should HAVE an estimate, so `unanalysed`
    // keeps reltuples = -1.
    await c.query(`ANALYZE ${SCHEMA}.org_units, ${SCHEMA}.staff, ${SCHEMA}.staff_rollup`);
    await c.end();
    reachable = true;
  } catch (e) {
    skipReason = (e as Error).message;
    await c.end().catch(() => {});
  }
  return reachable;
})();

if (!setup) {
  console.warn(`\n[WS-C] SKIPPING introspector tests — ${config.demo.dbName} unavailable: ${skipReason}\n`);
}

let entities: IntrospectedEntity[] = [];
const byName = (n: string) => entities.find((e) => e.name === n)!;

beforeAll(async () => {
  if (!reachable) return;
  const r = await postgresIntrospector.introspect(ADMIN_DSN, { schemas: [SCHEMA] });
  entities = r.entities;
});

afterAll(async () => {
  if (!reachable) return;
  const c = new Client({ connectionString: ADMIN_DSN });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await c.end();
});

describe.skipIf(!reachable)("WS-C.1 schema allowlist", () => {
  it("reads a NAMED schema — impossible before, when 'public' was hardcoded", () => {
    expect(entities.map((e) => e.name).sort()).toEqual([
      "active_staff",
      "org_units",
      "staff",
      "staff_rollup",
      "unanalysed",
    ]);
  });

  it("does not leak entities from other schemas", () => {
    // `public` in hr_demo holds employees/offices/…; none may appear.
    expect(entities.find((e) => e.name === "employees")).toBeUndefined();
  });

  it("ALWAYS reports the real schema, even when only one was requested", async () => {
    // REGRESSION. This used to null the schema whenever it equalled the single
    // requested one, on the theory that "a single-schema datasource renders as
    // before". That holds only for `public`, which is on the default search_path.
    // With `schemas: ["hr"]` the manifest then carried no schema, the agent wrote
    // `FROM presence_rollup`, and the run died on `relation … does not exist`
    // (found by the WS-E rehearsal, 2026-07-26).
    //
    // Faithfulness belongs to the introspector; deciding what is worth RENDERING
    // belongs to the manifest builder, which omits `public` and states everything
    // else.
    expect(byName("staff").schema).toBe(SCHEMA);
    const multi = await postgresIntrospector.introspect(ADMIN_DSN, {
      schemas: [SCHEMA, "public"],
    });
    expect(multi.entities.find((e) => e.name === "staff")!.schema).toBe(SCHEMA);
  });
});

describe.skipIf(!reachable)("WS-C.2 entity kinds", () => {
  it("labels a view as a view, not a table", () => {
    expect(byName("active_staff").entityType).toBe("view");
  });

  it("distinguishes a materialized view", () => {
    expect(byName("staff_rollup").entityType).toBe("materialized_view");
  });

  it("still labels base tables as tables", () => {
    expect(byName("staff").entityType).toBe("table");
    expect(byName("org_units").entityType).toBe("table");
  });

  it("introspects a view's columns", () => {
    expect(byName("active_staff").columns.map((c) => c.name)).toEqual(["id", "home_region"]);
  });
});

describe.skipIf(!reachable)("WS-C.4 row-count honesty", () => {
  it("reports NULL for a view rather than a meaningless number", () => {
    expect(byName("active_staff").rowCountEstimate).toBeNull();
  });

  it("reports NULL for a never-analysed table instead of -1", () => {
    // The specific bug: reltuples = -1 rendered as rowsEstimate="~-1".
    expect(byName("unanalysed").rowCountEstimate).toBeNull();
  });

  it("reports a real estimate for an analysed table", () => {
    expect(byName("org_units").rowCountEstimate).toBe(0); // analysed, genuinely empty
    expect(byName("staff_rollup").rowCountEstimate).not.toBeNull();
  });
});

describe.skipIf(!reachable)("WS-C.3 keys and types at production complexity", () => {
  it("marks BOTH columns of a composite primary key", () => {
    const cols = byName("org_units").columns;
    expect(cols.filter((c) => c.isPrimaryKey).map((c) => c.name).sort()).toEqual([
      "code",
      "region",
    ]);
  });

  it("pairs a two-column foreign key by ordinal, not by cartesian product", () => {
    // The bug this replaces: constraint_column_usage would report
    // home_region → code and home_code → region half the time.
    const cols = byName("staff").columns;
    expect(cols.find((c) => c.name === "home_region")!.foreignKeyReference).toBe(
      "org_units.region",
    );
    expect(cols.find((c) => c.name === "home_code")!.foreignKeyReference).toBe("org_units.code");
  });

  it("surfaces the real type behind an enum instead of 'USER-DEFINED'", () => {
    const priority = byName("org_units").columns.find((c) => c.name === "priority")!;
    expect(priority.type).toContain("mood");
  });

  it("surfaces the element type behind an array instead of 'ARRAY'", () => {
    const tags = byName("org_units").columns.find((c) => c.name === "tags")!;
    expect(tags.type).toContain("_text");
  });

  it("preserves a quoted mixed-case identifier exactly", () => {
    expect(byName("staff").columns.map((c) => c.name)).toContain("MixedCase");
  });

  it("caps entities and REPORTS the truncation rather than hiding it", async () => {
    const r = await postgresIntrospector.introspect(ADMIN_DSN, {
      schemas: [SCHEMA],
      maxEntities: 2,
    });
    expect(r.entities).toHaveLength(2);
    expect(r.truncated).toEqual({ limit: 2, total: 5 });
  });

  it("does not report truncation when everything fits", async () => {
    const r = await postgresIntrospector.introspect(ADMIN_DSN, { schemas: [SCHEMA] });
    expect(r.truncated).toBeUndefined();
  });
});

/**
 * ── 2026-09-17 — an enum's MEMBERS are recorded ─────────────────────────────
 *
 * `information_schema` reports an enum as `USER-DEFINED` with the type name and
 * nothing else, which made every enum column unreproducible in the mock and the
 * sandbox — 14 columns across 10 tables of a real tenant, absent, so a correct
 * query died against the fixture with `column "partnerType" does not exist`.
 * It also left a model writing SQL told a column is an enum and never told
 * which values are legal, which is the recorded "invented enum value" failure.
 */
describe("columnType — what a column's type is recorded as", () => {
  const members = new Map<string, string[]>([
    ["partner_type", ["AGENCY", "DIRECT"]],
    ["weird", ["a,b", "c"]],
  ]);

  it("appends the members to an enum, in MySQL's spelling", () => {
    expect(columnType("USER-DEFINED", "partner_type", members)).toBe(
      "user-defined:partner_type(AGENCY,DIRECT)",
    );
  });

  it("leaves an ordinary type alone", () => {
    expect(columnType("text", "text", members)).toBe("text");
    expect(columnType("timestamp with time zone", "timestamptz", members)).toBe(
      "timestamp with time zone",
    );
  });

  it("still names an ARRAY by its udt", () => {
    expect(columnType("ARRAY", "_int4", members)).toBe("array:_int4");
  });

  /**
   * ⚠ A domain and a composite are `USER-DEFINED` with no members. They must
   * keep the bare form so `mapColumn` keeps refusing them — an empty member
   * list would read as an enum that permits nothing.
   */
  it("keeps the bare form for a user-defined type with no members", () => {
    expect(columnType("USER-DEFINED", "address_domain", members)).toBe(
      "user-defined:address_domain",
    );
  });

  /**
   * ⚠ A member carrying a comma or a bracket would make the encoding ambiguous
   * to anything splitting on them. Recording no members is the safe direction:
   * the column is then refused loudly rather than reproduced with values parsed
   * into the wrong things.
   */
  it("records NO members when one of them would make the encoding ambiguous", () => {
    expect(columnType("USER-DEFINED", "weird", members)).toBe("user-defined:weird");
  });
});

/**
 * ⚠ **The storage bound, pinned — 2026-09-17.**
 *
 * Recording enum members made `columnType` produce strings past 100 characters,
 * and `schemas.column_type` was `varchar(100)`. The symptom was a **500 on
 * `POST …/schema/refresh`** — `value too long for type character varying(100)`
 * — which is the one action that makes a datasource usable at all, so the
 * datasource became unusable rather than degraded.
 *
 * ⚠ The bound was ALREADY reachable before this feature: `mysql.introspector.ts`
 * has always recorded `COLUMN_TYPE` verbatim, and a MySQL enum is
 * `enum('a','b','c',…)`. This surfaced a latent limit rather than adding one.
 */
describe("a recorded column type has no length bound", () => {
  it("can produce a string far past the old varchar(100)", () => {
    const long = new Map<string, string[]>([
      [
        "ActivityFeedRelationType",
        ["APPLICATION", "CANDIDATE", "JOB", "OFFER", "INTERVIEW", "REQUISITION", "DOCUMENT"],
      ],
    ]);
    const encoded = columnType("USER-DEFINED", "ActivityFeedRelationType", long);
    expect(encoded.length).toBeGreaterThan(100);
    expect(encoded).toContain("REQUISITION");
  });

  it("and the column that stores it is unbounded", async () => {
    const src = await readFile(
      fileURLToPath(new URL("../../db/schema.ts", import.meta.url)),
      "utf8",
    );
    const line = src.split("\n").find((l) => l.includes('columnType: '));
    expect(line, "columnType is not declared where this test looks").toBeTruthy();
    expect(line).toContain('text("column_type")');
    // CONTROL: the scan really can see a bounded declaration when there is one.
    expect(src).toMatch(/entityName: varchar\("entity_name", \{ length: 255 \}\)/);
  });
});
