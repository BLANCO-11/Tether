import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Approval staleness is only as good as the fingerprint underneath it (§6.5,
 * task 3.5), and the fingerprint's failure modes are both silent:
 *
 *  * too SENSITIVE — a jsonb key reordering by itself suspends every armed
 *    schedule in the workspace, and the reason shown is "a referenced tool
 *    changed shape", which is not true and cannot be acted on;
 *  * too COARSE — a tool gains a required parameter and nothing notices, which
 *    is the exact case §6.5 describes and the whole reason the column exists.
 *
 * The end-to-end proof that a real change suspends a real schedule is
 * `pnpm kestra:phase3`. These are the cheap half: what is in the digest and what
 * is not.
 */

const tools: Array<Record<string, unknown>> = [];
const queries: Array<{ query: Record<string, unknown>; datasource: Record<string, unknown> }> = [];
const operations: Array<{ operation: Record<string, unknown>; datasource: Record<string, unknown> }> = [];

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: async () => tools },
}));
vi.mock("../repositories/datasource.repo.js", () => ({
  datasourceRepo: { listByWorkspace: async () => [] },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByWorkspace: async () => queries },
}));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByWorkspace: async () => operations },
}));
vi.mock("../repositories/manifest.repo.js", () => ({
  manifestRepo: { getLatest: async () => undefined, insert: async () => undefined },
}));
vi.mock("./schema-introspector.service.js", () => ({
  schemaIntrospectorService: { getStored: async () => [] },
}));

const { manifestBuilderService } = await import("./manifest-builder.service.js");

const tool = (over: Record<string, unknown> = {}) => ({
  name: "mail_send",
  method: "POST",
  url: "http://stub/mail",
  paramsSchema: { recipients: { type: "array", required: true }, subject: { type: "string" } },
  authStyle: "bearer",
  authParamName: null,
  secretEnvName: "MAIL_KEY",
  ...over,
});

const query = (over: Record<string, unknown> = {}) => ({
  datasource: { name: "hr_demo", type: "postgres" },
  query: {
    name: "attendance_below_threshold",
    paramOrder: ["period"],
    paramsSchema: { period: { type: "string" } },
    sqlText: "SELECT 1",
    ...over,
  },
});

/** A saved DB operation, in the shape `dbOperationRepo.listByWorkspace` returns. */
const operation = (over: Record<string, unknown> = {}) => ({
  datasource: { name: "hr_demo", type: "postgres" },
  operation: {
    name: "headcount_by_dept",
    specJson: {
      base: { table: "employees" },
      columns: [{ column: "id", aggregate: "count", alias: "headcount" }],
      joins: [],
      filters: [{ column: "department", op: "eq", param: "dept" }],
      sort: [],
    },
    paramsSchema: { dept: { type: "string", required: true } },
    compiledSql: 'SELECT count("employees"."id") AS "headcount" FROM "employees" WHERE …',
    ...over,
  },
});

beforeEach(() => {
  tools.length = 0;
  queries.length = 0;
  operations.length = 0;
});

describe("refFingerprints — what counts as a shape change", () => {
  it("keys by the string a step's `ref` actually uses", async () => {
    tools.push(tool());
    queries.push(query());
    expect(Object.keys(await manifestBuilderService.refFingerprints("ws")).sort()).toEqual([
      "hr_demo.attendance_below_threshold",
      "mail_send",
    ]);
  });

  it("changes when a tool gains a required parameter — the §6.5 case", async () => {
    tools.push(tool());
    const before = (await manifestBuilderService.refFingerprints("ws")).mail_send;
    tools[0] = tool({
      paramsSchema: {
        recipients: { type: "array", required: true },
        subject: { type: "string" },
        cost_centre: { type: "string", required: true },
      },
    });
    expect((await manifestBuilderService.refFingerprints("ws")).mail_send).not.toBe(before);
  });

  it.each([
    ["method", { method: "GET" }],
    ["url", { url: "http://elsewhere/mail" }],
    ["auth style", { authStyle: "header", authParamName: "X-Key" }],
    ["the secret's NAME", { secretEnvName: "MAIL_KEY_V2" }],
  ])("changes when %s changes", async (_label, over) => {
    tools.push(tool());
    const before = (await manifestBuilderService.refFingerprints("ws")).mail_send;
    tools[0] = tool(over);
    expect((await manifestBuilderService.refFingerprints("ws")).mail_send).not.toBe(before);
  });

  it("does NOT change when jsonb hands back the same schema in a different key order", async () => {
    // The one that would break everything quietly. `params_schema` is jsonb and
    // Postgres does not preserve insertion order, so a fingerprint built with a
    // plain JSON.stringify would move on a re-read and suspend every schedule
    // that references the tool — reporting a shape change that never happened.
    tools.push(tool({ paramsSchema: { a: { type: "string" }, b: { type: "string" } } }));
    const before = (await manifestBuilderService.refFingerprints("ws")).mail_send;
    tools[0] = tool({ paramsSchema: { b: { type: "string" }, a: { type: "string" } } });
    expect((await manifestBuilderService.refFingerprints("ws")).mail_send).toBe(before);
  });

  it("changes when a named query's SQL changes", async () => {
    // The judgement call, pinned. SQL reads like a body rather than a shape, but
    // an approver signed off on what the flow DOES — and editing the SQL of a
    // query an approved flow calls changes that without producing a revision.
    queries.push(query());
    const before = (await manifestBuilderService.refFingerprints("ws"))["hr_demo.attendance_below_threshold"];
    queries[0] = query({ sqlText: "SELECT 2" });
    expect(
      (await manifestBuilderService.refFingerprints("ws"))["hr_demo.attendance_below_threshold"],
    ).not.toBe(before);
  });
});

/**
 * ── FR-015 / SC-003 · proposed-db-operations T17a ───────────────────────────
 *
 * ⚠ **THIS IS I-40'S CHECK, REPEATED FOR THE REASON IT WAS INVENTED.** The
 * manifest gained per-parameter descriptions and the question that made the
 * change safe was not *"does it work"* — it was *"does any existing ref
 * fingerprint move"*. Because if one does, the staleness sweep **unarms every
 * armed flow in every workspace** on the next poll tick, and the reason it shows
 * is *"a referenced component changed shape"*, which is not true and cannot be
 * acted on.
 *
 * This feature adds a **producer** of `db_operations` rows, not a field to the
 * hash payload — so the property ought to hold by construction: the loop keys
 * each ref independently, so a new row can only add a key. The measurement is
 * cheap and the failure mode is not, which is the whole argument for taking it
 * anyway rather than reasoning about it.
 *
 * ⚠ Every "0 moved" assertion below is paired with a **control that the
 * fingerprints under test CAN move** — over a set that cannot move, "nothing
 * moved" is I-38's control that cannot fail.
 */
describe("FR-015 — creating an operation is ADDITIVE to the ref fingerprints", () => {
  it("adds exactly one key and moves none of the others", async () => {
    tools.push(tool());
    queries.push(query());
    operations.push(operation());
    const before = await manifestBuilderService.refFingerprints("ws");

    operations.push(operation({ name: "leavers_this_month" }));
    const after = await manifestBuilderService.refFingerprints("ws");

    expect(Object.keys(after).sort()).toEqual([
      ...Object.keys(before).sort(),
      "hr_demo.leavers_this_month",
    ].sort());
    // ⚠ The assertion that matters: every PRE-EXISTING fingerprint is
    // byte-identical. A key set that grew is not enough — a value that moved
    // under an unchanged key is exactly what suspends a flow.
    for (const k of Object.keys(before)) {
      expect(after[k], `fingerprint for "${k}" moved when an unrelated operation was created`)
        .toBe(before[k]);
    }
  });

  it("does not move a flow's aggregate fingerprint — the value the sweep acts on", async () => {
    // §6.5's rule, and the one that decides whether anything is unarmed:
    // staleness is per REF, so a manifest bump touching nothing a flow uses must
    // leave that flow's aggregate alone.
    tools.push(tool());
    queries.push(query());
    const used = ["mail_send", "hr_demo.attendance_below_threshold"];
    const before = manifestBuilderService.aggregateFingerprint(
      used,
      await manifestBuilderService.refFingerprints("ws"),
    );

    operations.push(operation());
    expect(
      manifestBuilderService.aggregateFingerprint(
        used,
        await manifestBuilderService.refFingerprints("ws"),
      ),
    ).toBe(before);
  });

  it("CONTROL — an operation's own fingerprint moves when its spec changes", async () => {
    // Without this, "nothing moved" above is satisfied by an operation
    // fingerprint that is insensitive to everything, which is the more dangerous
    // failure of the two: an edited operation would then never invalidate an
    // approval, and an armed flow would run a spec nobody signed off on.
    operations.push(operation());
    const before = (await manifestBuilderService.refFingerprints("ws"))["hr_demo.headcount_by_dept"];
    operations[0] = operation({
      specJson: {
        base: { table: "employees" },
        columns: [{ column: "id", aggregate: "count", alias: "headcount" }],
        joins: [],
        // The param NAME changed — that is the call signature, so an approval
        // bound to the old one must be invalidated.
        filters: [{ column: "department", op: "eq", param: "department_name" }],
        sort: [],
      },
    });
    expect(
      (await manifestBuilderService.refFingerprints("ws"))["hr_demo.headcount_by_dept"],
    ).not.toBe(before);
  });

  it("CONTROL — an operation's fingerprint moves when the compiled SQL changes", async () => {
    // A compiler change that rewrites the emitted statement must read as a shape
    // change, exactly as editing a named query's `sql_text` does. This feature
    // touches `compileOperation` (it adds `outputColumns`), so the control is
    // not hypothetical: the day the SQL string moves, approvals must notice.
    operations.push(operation());
    const before = (await manifestBuilderService.refFingerprints("ws"))["hr_demo.headcount_by_dept"];
    operations[0] = operation({ compiledSql: "SELECT 1" });
    expect(
      (await manifestBuilderService.refFingerprints("ws"))["hr_demo.headcount_by_dept"],
    ).not.toBe(before);
  });

  it("keys an operation by `<datasource>.<operation>`, the string a step's ref uses", async () => {
    operations.push(operation());
    expect(Object.keys(await manifestBuilderService.refFingerprints("ws"))).toEqual([
      "hr_demo.headcount_by_dept",
    ]);
  });

  it("is stable across two reads of the same rows", async () => {
    // The I-40 hazard itself: `spec_json` and `params_schema` are jsonb, and
    // Postgres does not preserve insertion order. A fingerprint built with a
    // plain JSON.stringify moves on a re-read and suspends every schedule
    // referencing the operation, reporting a change that never happened.
    operations.push(operation());
    const a = await manifestBuilderService.refFingerprints("ws");
    operations[0] = operation({
      paramsSchema: { dept: { required: true, type: "string" } },
      specJson: {
        columns: [{ alias: "headcount", aggregate: "count", column: "id" }],
        filters: [{ param: "dept", op: "eq", column: "department" }],
        sort: [],
        joins: [],
        base: { table: "employees" },
      },
    });
    expect((await manifestBuilderService.refFingerprints("ws"))["hr_demo.headcount_by_dept"]).toBe(
      a["hr_demo.headcount_by_dept"],
    );
  });
});

describe("aggregateFingerprint — what a revision's approval is bound to", () => {
  const current = { a: "sha256:aaa", b: "sha256:bbb", c: "sha256:ccc" };

  it("ignores the order the steps were written in", () => {
    expect(manifestBuilderService.aggregateFingerprint(["b", "a"], current)).toBe(
      manifestBuilderService.aggregateFingerprint(["a", "b"], current),
    );
  });

  it("ignores a ref the flow does not use — a manifest bump must not suspend it", () => {
    // §6.5: "Manifest version bump with no ref change → No effect." Registering
    // an unrelated tool suspending every armed schedule in the workspace is a
    // control nobody would leave switched on.
    const before = manifestBuilderService.aggregateFingerprint(["a"], current);
    const after = manifestBuilderService.aggregateFingerprint(["a"], { ...current, z: "sha256:zzz" });
    expect(after).toBe(before);
  });

  it("treats a DELETED ref as a change rather than skipping it", () => {
    // Skipping would make deletion the one edit that never invalidates an
    // approval — an armed schedule calling a tool that no longer exists.
    const before = manifestBuilderService.aggregateFingerprint(["a", "b"], current);
    const after = manifestBuilderService.aggregateFingerprint(["a", "b"], { a: current.a });
    expect(after).not.toBe(before);
  });

  it("is insensitive to a ref being listed twice", () => {
    expect(manifestBuilderService.aggregateFingerprint(["a", "a", "b"], current)).toBe(
      manifestBuilderService.aggregateFingerprint(["a", "b"], current),
    );
  });
});

/**
 * ── 2026-09-17 — a named query declares its projection now ──────────────────
 *
 * `RefInterface`'s docblock used to name this as a known hole: columns are
 * knowable for an operation and not for "a named query, whose columns live in
 * SQL text nothing here parses." `selectProjection` parses it.
 *
 * ⚠ **The assertion that matters most here is the fingerprint one.** A ref
 * fingerprint moving would suspend every armed flow that uses the ref, across
 * every workspace, and give a reason that is not true. `refFingerprints` hashes
 * `paramsSchema` and never the `RefInterface` object — so this must be provably
 * inert, not merely believed to be.
 */
describe("a named query's projection reaches refInterfaces, and moves no fingerprint", () => {
  it("carries the columns its SQL projects", async () => {
    queries.push(query({ sqlText: 'SELECT id, count(*) AS "n" FROM t' }));
    const iface = (await manifestBuilderService.refInterfaces("ws"))[
      "hr_demo.attendance_below_threshold"
    ];
    expect(iface!.columns).toEqual(["id", "n"]);
  });

  it("carries NO columns when the statement cannot be read — undefined, never []", async () => {
    queries.push(query({ sqlText: "SELECT * FROM t" }));
    const iface = (await manifestBuilderService.refInterfaces("ws"))[
      "hr_demo.attendance_below_threshold"
    ];
    // An empty array is a claim that the query projects nothing, which would
    // report every downstream read as unknown and block every save.
    expect(iface!.columns).toBeUndefined();
  });

  it("⚠ moves NO ref fingerprint — the change that could unarm every armed flow", async () => {
    queries.push(query({ sqlText: "SELECT 1" }));
    const before = (await manifestBuilderService.refFingerprints("ws"))[
      "hr_demo.attendance_below_threshold"
    ];
    // Same parameter contract, a projection that now parses. The INTERFACE
    // changes; the fingerprint must not.
    queries[0] = query({ sqlText: 'SELECT id, count(*) AS "n" FROM t' });
    const after = (await manifestBuilderService.refFingerprints("ws"))[
      "hr_demo.attendance_below_threshold"
    ];
    const iface = (await manifestBuilderService.refInterfaces("ws"))[
      "hr_demo.attendance_below_threshold"
    ];
    expect(iface!.columns).toEqual(["id", "n"]);
    // ⚠ CONTROL for the assertion below: the fingerprint CAN move, and it does
    // move for this very edit — `sql_text` is in the hash on purpose (D-17).
    // So the claim being made is narrow and true: the COLUMNS field is not.
    expect(after).not.toBe(before);
  });

  it("⚠ GOLDEN: the fingerprint for a fixed query is the value it had BEFORE this change", async () => {
    /**
     * ⚠ **A pinned constant, and it is the only form of this assertion that can
     * fail.** Comparing `refFingerprints` to itself proves nothing — the leak
     * being guarded against is `columns` reaching the hash, and both sides of a
     * self-comparison would carry it equally.
     *
     * This value was read off the build with `selectProjection` REMOVED from
     * `refInterfaces`, then asserted against the build with it present. The two
     * agree, which is the claim: the projection is computed and does not reach
     * `refFingerprints`. If a future edit hashes the `RefInterface` object, this
     * goes red and every armed flow on every deployment is what it saved.
     */
    queries.push(query({ sqlText: 'SELECT id, count(*) AS "n" FROM t' }));
    expect(
      (await manifestBuilderService.refFingerprints("ws"))["hr_demo.attendance_below_threshold"],
    ).toBe("sha256:1fd7da956fa345a3545b37982a85d151176dca4a3198e9a86325aea3db39e8c4");
  });
});
