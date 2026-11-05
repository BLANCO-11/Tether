/**
 * PGlite driver tests — prepare/query/destroy lifecycle, write-reject,
 * timeout/row-cap, fingerprint reload. In-process WASM only: no network,
 * no production database, deterministic.
 *
 * ⚠ **THIS FILE BOOTS A REAL POSTGRES PER TEST, so vitest's 5s default is the wrong
 * budget for it.** Three of these timed out when `release/beta` merged in on 2026-09-14,
 * and the diagnosis matters: they were **slow, not hung**. Every one passes at 5.5–6.1s,
 * and sibling tests doing the same work already sat at 2.8–3.3s — i.e. the whole file was
 * a fraction under the limit and drifted over it on a slower host. This workstation runs
 * an EDR agent that makes a bare `/usr/bin/true` cost ~62ms, which CLAUDE.md records.
 *
 * ⚠ **The number is here because of what these tests DO, not to make them green.** That
 * distinction is the whole of it: a timeout raised until a hang goes quiet hides the
 * hang. It was checked first — 22/22 at `--testTimeout=30000`, with the slowest at
 * 6.1s — so the budget is ~5× the worst observed, not a number picked to clear it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import {
  createPgliteDriver,
  MOCK_MAX_ROWS,
  MOCK_STATEMENT_TIMEOUT_MS,
  pgliteDriver,
} from "./pglite.driver.js";
import {
  MockEngineTimeoutError,
  MockEngineWriteRejectedError,
  type MockHandle,
  type MockTable,
} from "./types.js";

function tables(): MockTable[] {
  return [
    {
      name: "users",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
        { name: "active", type: "boolean" },
      ],
      rows: [
        { id: 1, name: "amy", active: true },
        { id: 2, name: "bo", active: false },
        { id: 3, name: "cy", active: true },
      ],
    },
    {
      name: "orders",
      columns: [
        { name: "id", type: "integer" },
        { name: "user_id", type: "integer" },
        { name: "total", type: "numeric" },
      ],
      rows: [
        { id: 10, user_id: 1, total: 42.5 },
        { id: 11, user_id: 3, total: 7.25 },
      ],
    },
  ];
}

const live: MockHandle[] = [];
afterEach(async () => {
  while (live.length > 0) {
    const h = live.pop();
    if (h) await pgliteDriver.destroy(h).catch(() => {});
  }
});

async function prepared(fp = "fp-1", t: MockTable[] = tables()): Promise<MockHandle> {
  const h = await pgliteDriver.prepare("ws-1", "ds-1", fp, t);
  live.push(h);
  return h;
}

describe("pglite driver lifecycle", () => {
  it("prepares, queries with params, and destroys", async () => {
    const h = await prepared();
    expect(h.driver).toBe("pglite");
    expect(h.fingerprint).toBe("fp-1");

    const { rows } = await pgliteDriver.query(h, "SELECT id, name FROM users WHERE active = $1 ORDER BY id", [true]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "amy" });
    expect(Number((rows[1] as Record<string, unknown>).id)).toBe(3);

    const join = await pgliteDriver.query(
      h,
      "SELECT u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = $1",
      [1],
    );
    expect(join.rows).toHaveLength(1);
    expect(Number((join.rows[0] as Record<string, unknown>).total)).toBeCloseTo(42.5);

    await pgliteDriver.destroy(h);
    await expect(pgliteDriver.query(h, "SELECT 1", [])).rejects.toThrow(/already destroyed/);
  });

  it("a numeric or bigint column arrives as a NUMBER, a text one as text (phase 7, R05)", async () => {
    const h = await prepared();
    const { rows } = await pgliteDriver.query(
      h,
      "SELECT total, count(*) AS n, '007'::text AS code, sum(total) / count(*) AS avg FROM orders GROUP BY total ORDER BY total",
      [],
    );
    // numeric and count(*) (bigint) used to come back as "7.25" and "1".
    expect(rows[0]).toEqual({ total: 7.25, n: 1, code: "007", avg: 7.25 });
  });

  it("an array literal binds to = ANY($1) (phase 7, R03)", async () => {
    const { coerceSqlParams } = await import("../query-row-numbers.js");
    const h = await prepared();
    const p = coerceSqlParams({ names: '["amy","cy"]' }, { names: { type: "array" } });
    const { rows } = await pgliteDriver.query(h, "SELECT name FROM users WHERE name = ANY($1) ORDER BY name", [p.names]);
    expect(rows.map((r) => (r as { name: string }).name)).toEqual(["amy", "cy"]);
    // The JSON text it used to be sent as is what Postgres refused.
    await expect(pgliteDriver.query(h, "SELECT name FROM users WHERE name = ANY($1)", ['["amy","cy"]'])).rejects.toThrow(/malformed array literal/);
  });

  it("a failed prepare tears down and surfaces the load error", async () => {
    await expect(
      pgliteDriver.prepare("ws-1", "ds-1", "fp-bad", [
        { name: "t", columns: [{ name: "id", type: "integer" }], rows: [{ id: "not-a-number" }] },
      ]),
    ).rejects.toThrow(/invalid input syntax/);
    // The failure tore down without poisoning the driver — a fresh prepare works.
    const h = await prepared("fp-after-failure");
    expect((await pgliteDriver.query(h, "SELECT id FROM users ORDER BY id", [])).rows).toHaveLength(3);
  });

  it("destroy is idempotent — teardown on failure does not raise a second error", async () => {
    const h = await prepared();
    live.pop();
    await pgliteDriver.destroy(h);
    await expect(pgliteDriver.destroy(h)).resolves.toBeUndefined();
  });


  it("unknown column types fall back to TEXT instead of failing the load", async () => {
    const h = await prepared("fp-text", [
      { name: "t", columns: [{ name: "v", type: "fictional_type" }], rows: [{ v: "kept" }] },
    ]);
    const { rows } = await pgliteDriver.query(h, "SELECT v FROM t", []);
    expect(rows).toEqual([{ v: "kept" }]);
  });

  it("refuses non-identifier table names rather than interpolating them", async () => {
    await expect(
      pgliteDriver.prepare("ws-1", "ds-1", "fp-evil", [
        { name: "t; DROP TABLE users", columns: [], rows: [] },
      ]),
    ).rejects.toThrow(/not a plain identifier/);
  });
});

describe("fingerprint reload", () => {
  it("a new fingerprint loads fresh rows — no stale cache across prepares", async () => {
    const v1: MockTable[] = [
      { name: "t", columns: [{ name: "v", type: "text" }], rows: [{ v: "one" }] },
    ];
    const v2: MockTable[] = [
      { name: "t", columns: [{ name: "v", type: "text" }], rows: [{ v: "two" }] },
    ];
    const h1 = await pgliteDriver.prepare("ws-1", "ds-1", "fp-1", v1);
    expect((await pgliteDriver.query(h1, "SELECT v FROM t", [])).rows).toEqual([{ v: "one" }]);
    await pgliteDriver.destroy(h1);

    const h2 = await pgliteDriver.prepare("ws-1", "ds-1", "fp-2", v2);
    live.push(h2);
    expect(h2.fingerprint).toBe("fp-2");
    expect((await pgliteDriver.query(h2, "SELECT v FROM t", [])).rows).toEqual([{ v: "two" }]);
  });
});

describe("write-reject", () => {
  const writes = [
    "INSERT INTO users (id, name, active) VALUES (9, 'mallory', true)",
    "UPDATE users SET name = 'mallory' WHERE id = 1",
    "DELETE FROM users WHERE id = 1",
    "DROP TABLE users",
    "CREATE TABLE evil (id integer)",
    "TRUNCATE users",
    "ALTER TABLE users ADD COLUMN evil text",
    "SELECT 1; SELECT 2",
    "WITH x AS (INSERT INTO users (id, name, active) VALUES (9, 'm', true) RETURNING *) SELECT * FROM x",
    "SELECT $$ DELETE FROM users $$",
    "GRANT SELECT ON users TO PUBLIC",
  ];
  it.each(writes)("refuses %s", async (sql) => {
    const h = await prepared();
    await expect(pgliteDriver.query(h, sql, [])).rejects.toBeInstanceOf(MockEngineWriteRejectedError);
    // Nothing executed: the fixture is intact.
    const { rows } = await pgliteDriver.query(h, "SELECT id FROM users ORDER BY id", []);
    expect(rows).toHaveLength(3);
  });

  it("refuses a non-read first word", async () => {
    const h = await prepared();
    await expect(pgliteDriver.query(h, "EXPLAIN SELECT 1", [])).rejects.toBeInstanceOf(
      MockEngineWriteRejectedError,
    );
  });
});

describe("row cap and timeout", () => {
  it(`caps rows at the driver max (default ${MOCK_MAX_ROWS})`, async () => {
    const driver = createPgliteDriver({ maxRows: 3 });
    const rows = Array.from({ length: 5 }, (_, i) => ({ v: `r${i}` }));
    const h = await driver.prepare("ws-1", "ds-1", "fp-cap", [
      { name: "t", columns: [{ name: "v", type: "text" }], rows },
    ]);
    try {
      const out = await driver.query(h, "SELECT v FROM t ORDER BY v", []);
      expect(out.rows).toHaveLength(3);
    } finally {
      await driver.destroy(h);
    }
  });

  it("a runaway query is refused by terminating the handle, never returned", async () => {
    const driver = createPgliteDriver({ statementTimeoutMs: 300 });
    const h = await driver.prepare("ws-1", "ds-1", "fp-slow", []);
    try {
      // 50M rows would take ~9s in-process; the 300ms budget kills the worker.
      await expect(
        driver.query(h, "SELECT sum(g) FROM generate_series(1, 50000000) g", []),
      ).rejects.toBeInstanceOf(MockEngineTimeoutError);
      // The worker is gone: the handle is dead and nothing lingers behind it.
      await expect(driver.query(h, "SELECT 1", [])).rejects.toThrow(/already destroyed/);
    } finally {
      await driver.destroy(h);
    }
  });

  it("a timeout on one handle leaves sibling handles usable", async () => {
    const driver = createPgliteDriver({ statementTimeoutMs: 300 });
    const alive: MockTable[] = [
      { name: "t", columns: [{ name: "v", type: "text" }], rows: [{ v: "alive" }] },
    ];
    const slow = await driver.prepare("ws-1", "ds-1", "fp-slow", []);
    const fast = await driver.prepare("ws-1", "ds-1", "fp-fast", alive);
    try {
      await expect(
        driver.query(slow, "SELECT sum(g) FROM generate_series(1, 50000000) g", []),
      ).rejects.toBeInstanceOf(MockEngineTimeoutError);
      expect((await driver.query(fast, "SELECT v FROM t", [])).rows).toEqual([{ v: "alive" }]);
    } finally {
      await driver.destroy(slow);
      await driver.destroy(fast);
    }
  });

  it("timeout and write-reject errors carry stable codes for upstream mapping", async () => {
    expect(new MockEngineTimeoutError(MOCK_STATEMENT_TIMEOUT_MS).code).toBe("mock_statement_timeout");
    expect(new MockEngineWriteRejectedError("x").code).toBe("mock_write_rejected");
    const foreign = { driver: "pglite", workspaceId: "w", datasourceId: "d", fingerprint: "f", handleId: "nope" };
    await expect(pgliteDriver.query(foreign, "SELECT 1", [])).rejects.toThrow(/does not belong/);
    await expect(pgliteDriver.destroy(foreign)).rejects.toThrow(/does not belong/);
  });
});

/**
 * ── 2026-09-18 — the declared type reaches the engine ────────────────────────
 *
 * Reported from use: *"the workflow runs on prod data but it's failing on mock
 * data"*, with `operator does not exist: text >= timestamp without time zone`.
 * The cause was upstream of this file — `mockTablesFromFixture` typed every
 * column by guessing at the stored JSON values, so a timestamp became `text` —
 * but these are the assertions that say what a declared type must BUY, and they
 * fail against a column loaded as `TEXT` — except where a wrong type is
 * coincidentally harmless, which the second test below writes down rather
 * than asserting past.
 */
describe("declared column types", () => {
  it("⚠ a timestamp column compares against a timestamp — the reported failure", async () => {
    const declared: MockTable[] = [
      {
        name: "o",
        columns: [
          { name: "id", type: "uuid" },
          { name: "joiningDate", type: "timestamp" },
        ],
        rows: [
          { id: "7b6f6a7e-7a1a-4a1a-9a1a-1a1a1a1a1a1a", joiningDate: "2026-01-15T17:00:55.403Z" },
          { id: "8b6f6a7e-7a1a-4a1a-9a1a-1a1a1a1a1a1a", joiningDate: "2025-01-15T17:00:55.403Z" },
        ],
      },
    ];
    const h = await pgliteDriver.prepare("ws-1", "ds-1", "fp-declared-ts", declared);
    try {
      // The exact shape of the failing step's SQL: an explicit cast on the
      // parameter, which is what makes a TEXT column an operator error rather
      // than a wrong answer.
      const r = await pgliteDriver.query(
        h,
        `SELECT "id" FROM "o" WHERE "joiningDate" >= $1::timestamp without time zone`,
        ["2026-01-01T00:00:00.000Z"],
      );
      expect(r.rows.length).toBe(1);
    } finally {
      await pgliteDriver.destroy(h);
    }
  });

  it("⚠ date arithmetic works at all — the capability a TEXT column does not have", async () => {
    /**
     * ⚠ **Ordering is NOT the assertion here, and the first draft of this test
     * wrongly said it was.** The generator writes ISO-8601 UTC, which sorts
     * lexicographically in chronological order — so `ORDER BY` over a
     * text-shaped timestamp is coincidentally CORRECT and a test on it passes
     * against the defect. What a text column genuinely cannot do is arithmetic
     * and truncation, which is most of what a reporting query does with a date.
     *
     * The silent half of this defect is demonstrated by the `numeric` case
     * below, where the wrong type returns a wrong NUMBER rather than an error.
     */
    const declared: MockTable[] = [
      {
        name: "e",
        columns: [
          { name: "label", type: "text" },
          { name: "at", type: "timestamptz" },
        ],
        rows: [
          { label: "a", at: "2026-02-03T00:00:00.000Z" },
          { label: "b", at: "2026-02-27T00:00:00.000Z" },
          { label: "c", at: "2026-03-01T00:00:00.000Z" },
        ],
      },
    ];
    const h = await pgliteDriver.prepare("ws-1", "ds-1", "fp-declared-trunc", declared);
    try {
      const r = await pgliteDriver.query(
        h,
        `SELECT count(*)::int AS n FROM "e" WHERE date_trunc('month', "at") = date_trunc('month', $1::timestamptz)`,
        ["2026-02-14T00:00:00.000Z"],
      );
      expect((r.rows[0] as { n: number }).n).toBe(2);
    } finally {
      await pgliteDriver.destroy(h);
    }
  });

  it("⚠ an ARRAY type loads — `text[]` is not a scalar TEXT", async () => {
    // `deriveShape` maps `array:_text` to the declared spelling `text[]`, and
    // the scalar regex in `mapColumnType` cannot match a bracket: before the
    // array branch this created a TEXT column and the INSERT failed outright.
    const declared: MockTable[] = [
      {
        name: "tagged",
        columns: [
          { name: "id", type: "integer" },
          { name: "tags", type: "text[]" },
        ],
        rows: [{ id: 1, tags: ["a", "b"] }],
      },
    ];
    const h = await pgliteDriver.prepare("ws-1", "ds-1", "fp-declared-arr", declared);
    try {
      const r = await pgliteDriver.query(h, `SELECT array_length("tags", 1) AS n FROM "tagged"`, []);
      expect(Number((r.rows[0] as { n: unknown }).n)).toBe(2);
    } finally {
      await pgliteDriver.destroy(h);
    }
  });

  it("numeric keeps its scale — a double precision substitute does not", async () => {
    const declared: MockTable[] = [
      {
        name: "money",
        columns: [{ name: "amount", type: "numeric(10,2)" }],
        rows: [{ amount: 0.1 }, { amount: 0.2 }],
      },
    ];
    const h = await pgliteDriver.prepare("ws-1", "ds-1", "fp-declared-num", declared);
    try {
      const r = await pgliteDriver.query(h, `SELECT sum("amount") AS s FROM "money"`, []);
      // Exact decimal arithmetic in SQL: 0.1 + 0.2 is 0.3, where a double precision
      // column would give 0.30000000000000004. Since phase 7 (R05) a numeric column
      // arrives as a NUMBER, so this compares the value — its trailing zero is
      // presentation, and a number has none.
      expect((r.rows[0] as { s: unknown }).s).toBe(0.3);
    } finally {
      await pgliteDriver.destroy(h);
    }
  });
});
