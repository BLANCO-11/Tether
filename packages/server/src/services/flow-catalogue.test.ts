/**
 * The catalogue's `triggers` section (Phase 8) — what the manual palette may
 * offer beyond callable refs.
 *
 * ── Why a section at all ────────────────────────────────────────────────────
 *
 * The palette's callable refs come from `refFingerprints`/`refInterfaces`, and
 * a trigger is NOT a ref: it is a flow-model declaration (`webhook`/`api` →
 * `{ name }`), materialized as a `triggers` row at approval (Phase 6). So it
 * cannot ride the `entries` list without pretending to be a callable — it is a
 * second, smaller list served beside it, with its own contract:
 *
 *   * `webhook` + `api` only — manual and poll are not LLM-creatable and not
 *     declarable (D-07), so they must never reach the palette;
 *   * sorted deterministically by type then name, so the palette does not
 *     reshuffle between reads;
 *   * ALWAYS present — `[]` when the workspace has none — so the client never
 *     branches on key presence;
 *   * schedules are NOT included: a schedule is flow-level, has no name of its
 *     own to declare by, and inserting another flow's cron into this flow is
 *     nonsense (the per-flow SchedulePane stays the entry point).
 *
 * The last block pins the OTHER sections byte-identical, so this section is a
 * pure addition and not a quiet reformat of the payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const DS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const fingerprints: Record<string, string> = {};
const interfaces: Record<
  string,
  { kind: "tool" | "query" | "operation"; signature: string; params: Array<{ name: string; type: string; required: boolean }> }
> = {};
const tools: Array<Record<string, unknown>> = [];
const queries: Array<{ query: Record<string, unknown>; datasource: Record<string, unknown> }> = [];
const operations: Array<{ operation: Record<string, unknown>; datasource: Record<string, unknown> }> = [];
const workspaceTriggers: Array<Record<string, unknown>> = [];

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: async () => tools },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByWorkspace: async () => queries },
}));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByWorkspace: async () => operations },
}));
vi.mock("../repositories/trigger.repo.js", () => ({
  triggerRepo: { listByWorkspace: async () => workspaceTriggers },
}));
vi.mock("./manifest-builder.service.js", () => ({
  manifestBuilderService: {
    refFingerprints: async () => fingerprints,
    refInterfaces: async () => interfaces,
  },
}));

const { flowCatalogueService } = await import("./flow-catalogue.service.js");

/** One ref's meta row, shaped like the repo rows the service joins on. */
beforeEach(() => {
  for (const m of [fingerprints, interfaces]) for (const k of Object.keys(m)) delete m[k];
  tools.length = 0;
  queries.length = 0;
  operations.length = 0;
  workspaceTriggers.length = 0;

  fingerprints["mail_send"] = "sha256:1111";
  fingerprints["hr_demo.headcount"] = "sha256:2222";
  fingerprints["hr_demo.attendance_by_dept"] = "sha256:3333";
  interfaces["mail_send"] = {
    kind: "tool",
    signature: "mail_send(to_email: string)",
    params: [{ name: "to_email", type: "string", required: true }],
  };
  interfaces["hr_demo.headcount"] = {
    kind: "query",
    signature: "hr_demo.headcount()",
    params: [],
  };
  interfaces["hr_demo.attendance_by_dept"] = {
    kind: "operation",
    signature: "hr_demo.attendance_by_dept(period: string)",
    params: [{ name: "period", type: "string", required: false }],
  };
  tools.push({
    name: "mail_send",
    description: "Sends email",
    url: "https://api.example.com/mail/send",
    paramsSchema: { to_email: { type: "string", required: true, description: "Recipient address" } },
  });
  queries.push({
    // `sqlText` is the stored, hand-written text — a named query has no spec, so
    // it carries SQL and no readback, and the entry below asserts exactly that.
    query: {
      name: "headcount",
      description: "Active headcount",
      paramsSchema: {},
      sqlText: "SELECT count(*) FROM employees WHERE active",
    },
    datasource: { name: "hr_demo", id: DS },
  });
  operations.push({
    operation: {
      name: "attendance_by_dept",
      description: null,
      paramsSchema: { period: { type: "string", required: false, description: null } },
      compiledSql: 'SELECT "dept" FROM "attendance"',
      // The readback is computed from THIS, never from the SQL above.
      specJson: { base: { table: "attendance" }, columns: [{ column: "dept", alias: "dept" }] },
    },
    datasource: { name: "hr_demo", id: DS },
  });
});

describe("catalogue triggers — webhook and api, sorted, manual/poll excluded", () => {
  it("lists webhook+api rows sorted by type then name, in workspace order", async () => {
    workspaceTriggers.push(
      { name: "zebra-webhook", type: "webhook" },
      { name: "alpha-api", type: "api" },
      { name: "manual-start", type: "manual" },
      { name: "poll-everything", type: "poll" },
      { name: "beta-webhook", type: "webhook" },
      { name: "gamma-api", type: "api" },
      { name: "schedule-nightly", type: "schedule" },
    );

    const cat = await flowCatalogueService.forWorkspace("ws-1");

    // "api" < "webhook"; within a type, name ascending. Insertion order is
    // deliberately scrambled above to prove the sort, not the repo order.
    expect(cat.triggers).toEqual([
      { name: "alpha-api", type: "api" },
      { name: "gamma-api", type: "api" },
      { name: "beta-webhook", type: "webhook" },
      { name: "zebra-webhook", type: "webhook" },
    ]);
  });

  it("is always present — empty array when the workspace has no webhook/api triggers", async () => {
    // A workspace with only manual/poll/schedule rows still gets the key.
    workspaceTriggers.push(
      { name: "manual-start", type: "manual" },
      { name: "poll-everything", type: "poll" },
    );

    const cat = await flowCatalogueService.forWorkspace("ws-empty");

    expect(Object.keys(cat)).toContain("triggers");
    expect(cat.triggers).toEqual([]);
  });

  it("the rest of the payload is byte-identical with and without triggers", async () => {
    const without = await flowCatalogueService.forWorkspace("ws-2");
    const { triggers: _t1, ...restWithout } = without;

    workspaceTriggers.push(
      { name: "alpha-api", type: "api" },
      { name: "zebra-webhook", type: "webhook" },
      { name: "manual-start", type: "manual" },
    );

    const withTriggers = await flowCatalogueService.forWorkspace("ws-2");
    const { triggers, ...restWith } = withTriggers;

    expect(triggers).toEqual([
      { name: "alpha-api", type: "api" },
      { name: "zebra-webhook", type: "webhook" },
    ]);
    // Deep equality AND serialized equality: key order is part of the contract
    // for a payload the drafter/palette consume by shape.
    expect(restWith).toEqual(restWithout);
    expect(JSON.stringify(restWith)).toBe(JSON.stringify(restWithout));
  });

  it("entries stay ref-driven and unchanged by the triggers section", async () => {
    workspaceTriggers.push({ name: "alpha-api", type: "api" });

    const cat = await flowCatalogueService.forWorkspace("ws-3");

    expect(cat.entries).toEqual([
      {
        ref: "hr_demo.attendance_by_dept",
        kind: "operation",
        stepKind: "query",
        description: null,
        service: null,
        params: [{ name: "period", type: "string", required: false, description: null }],
        datasource: "hr_demo",
        datasourceId: DS,
        sql: 'SELECT "dept" FROM "attendance"',
        readback: expect.arrayContaining([expect.objectContaining({ label: "From" })]),
      },
      {
        ref: "hr_demo.headcount",
        kind: "query",
        stepKind: "datasource",
        description: "Active headcount",
        service: null,
        params: [],
        datasource: "hr_demo",
        datasourceId: DS,
        sql: "SELECT count(*) FROM employees WHERE active",
        // ⚠ A named query is hand-written SQL with no spec to describe, so it
        // gets no readback. Asserted as null rather than omitted: an absent key
        // and a null one read the same in a diff and mean different things.
        readback: null,
      },
    ]);
    expect(cat.drift).toEqual([]);
  });

  it("demo mail tools are executable, not authorable: no entries, no drift", async () => {
    // `mail_send` is in fingerprints, interfaces AND the tool rows (a healthy
    // registration), yet the palette must not offer simulated delivery beside
    // the real thing. `mail_send_template` never even reaches fingerprints
    // here — absence is absence, same contract.
    const cat = await flowCatalogueService.forWorkspace("ws-4");

    expect(cat.entries.map((e) => e.ref)).not.toContain("mail_send");
    expect(cat.entries.map((e) => e.ref)).not.toContain("mail_send_template");
    // Still a healthy registration: fingerprints and interfaces agree, so the
    // exclusion is an authoring filter, not a breakage — existing flows keep
    // validating and executing against the untouched ref.
    expect(cat.drift).toEqual([]);
  });
});
