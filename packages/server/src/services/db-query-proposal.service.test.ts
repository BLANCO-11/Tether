/**
 * THE QUERY PROPOSER — the dynamic-read path beside the operation proposer.
 *
 * Mirrors the operation proposer's contract: a shape-checked proposal or an
 * un-retried refusal, nothing written, isolation asserted on the module's
 * source. `checkSqlShape` is NOT mocked — the safety argument is that a
 * proposal passes the same rules a hand-written query does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InferenceError, type InferenceClient } from "./inference.service.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import type { SchemaRow } from "../repositories/schema.repo.js";
import {
  parseQueryProposalResponse,
  proposeQuery,
  type QueryProposalOk,
} from "./db-query-proposal.service.js";

vi.mock("../repositories/schema.repo.js", () => ({ schemaRepo: { listByDatasource: vi.fn() } }));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByDatasource: vi.fn(), create: vi.fn(), get: vi.fn() },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByDatasource: vi.fn(), upsertByName: vi.fn() },
}));
vi.mock("../repositories/datasource.repo.js", () => ({ datasourceRepo: { get: vi.fn() } }));

class Recorder implements InferenceClient {
  readonly prompts: string[] = [];
  constructor(private readonly reply: (n: number) => string) {}
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.reply(this.prompts.length);
  }
  get count() {
    return this.prompts.length;
  }
}

class Failing implements InferenceClient {
  calls = 0;
  async complete(): Promise<string> {
    this.calls++;
    throw new InferenceError("connect ECONNREFUSED", "propose-query:ds1");
  }
}

function row(
  entityName: string,
  columnName: string | null,
  columnType: string | null,
  extra: Partial<SchemaRow> = {},
): SchemaRow {
  return {
    id: `${entityName}.${columnName ?? "_"}`,
    datasourceId: "ds1",
    entityType: "table",
    entitySchema: null,
    entityName,
    columnName,
    columnType,
    isPrimaryKey: false,
    isForeignKey: false,
    foreignKeyReference: null,
    nullable: true,
    characterMaximumLength: null,
    rowCountEstimate: null,
    nullPercentage: null,
    extractedAt: new Date("2026-08-27T00:00:00Z"),
    ...extra,
  } as SchemaRow;
}

const SCHEMA: SchemaRow[] = [
  row("expense_claims", null, null),
  row("expense_claims", "claim_code", "text"),
  row("expense_claims", "amount_cents", "integer"),
  row("expense_claims", "category", "text"),
  row("expense_claims", "claim_date", "date"),
  row("expense_claims", "status", "text"),
  row("expense_claims", "employee_id", "uuid", {
    isForeignKey: true,
    foreignKeyReference: "employees.id",
  }),
  row("expense_policy", null, null),
  row("expense_policy", "category", "text"),
  row("expense_policy", "limit_cents", "integer"),
  row("employees", null, null),
  row("employees", "id", "uuid", { isPrimaryKey: true }),
  row("employees", "full_name", "text"),
  row("employees", "work_email", "text"),
];

const GOOD_SQL =
  "SELECT ec.claim_code, e.full_name AS employee_name, e.work_email AS employee_email, " +
  "ec.amount_cents, ep.limit_cents, (ec.amount_cents - ep.limit_cents) AS over_by_cents " +
  "FROM expense_claims ec JOIN employees e ON e.id = ec.employee_id " +
  "JOIN expense_policy ep ON ep.category = ec.category " +
  "WHERE ec.claim_date >= $1 AND ec.claim_date < $2 AND ec.status <> 'rejected' " +
  "AND ec.amount_cents > ep.limit_cents ORDER BY ec.claim_code LIMIT 500";

const okReply = (name = "claims_over_policy") =>
  JSON.stringify({
    status: "ok",
    name,
    description: "Claims over their category policy limit, with the claimant and the overage.",
    sqlText: GOOD_SQL,
    paramOrder: ["from_date", "to_date"],
    paramsSchema: {
      from_date: { type: "string", required: true, description: "Start of the period, YYYY-MM-DD." },
      to_date: { type: "string", required: true, description: "End of the period, YYYY-MM-DD." },
    },
  });

const REFUSAL = JSON.stringify({
  status: "insufficient_schema",
  missing: ["a claim date column"],
  reason: "no column in the introspected schema carries a date; a period read cannot be expressed",
});

const NEED = "claims over their category policy limit with the claimant and how far over each is";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(schemaRepo.listByDatasource).mockResolvedValue(SCHEMA);
  vi.mocked(dbOperationRepo.listByDatasource).mockResolvedValue([]);
  vi.mocked(datasourceQueryRepo.listByDatasource).mockResolvedValue([]);
  vi.mocked(datasourceRepo.get).mockResolvedValue({
    id: "ds1",
    name: "finance_demo",
    type: "postgres",
  } as never);
});

describe("channel 1 — a SQL proposal", () => {
  it("returns shape-checked SQL the save path would accept", async () => {
    const client = new Recorder(() => okReply());
    const out = (await proposeQuery(
      { workspaceId: "ws", dsId: "ds1", need: NEED },
      client,
    )) as QueryProposalOk;

    expect(out.status).toBe("ok");
    expect(out.name).toBe("claims_over_policy");
    expect(out.sqlText).toContain("amount_cents > ep.limit_cents");
    expect(out.attempts).toBe(1);
    expect(out.maxPerRequest).toBeGreaterThan(0);
    expect(client.count).toBe(1);
  });

  it("retries a write-shaped answer with the finding fed back verbatim", async () => {
    const bad = JSON.stringify({
      status: "ok",
      name: "claims_over_policy",
      description: "x",
      sqlText: "DELETE FROM expense_claims WHERE claim_date >= $1",
      paramOrder: ["from_date"],
      paramsSchema: {
        from_date: { type: "string", required: true, description: "Start, YYYY-MM-DD." },
      },
    });
    const client = new Recorder((n) => (n === 1 ? bad : okReply()));
    const out = (await proposeQuery(
      { workspaceId: "ws", dsId: "ds1", need: NEED },
      client,
    )) as QueryProposalOk;

    expect(out.status).toBe("ok");
    expect(out.attempts).toBe(2);
    expect(client.prompts[1]).toContain("YOUR PREVIOUS ANSWER WAS REJECTED");
  });

  it("writes nothing — no query row is created as a side effect", async () => {
    const client = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    expect(datasourceQueryRepo.upsertByName).not.toHaveBeenCalled();
    expect(dbOperationRepo.create).not.toHaveBeenCalled();
  });

  it("409s on a datasource with no introspected schema", async () => {
    vi.mocked(schemaRepo.listByDatasource).mockResolvedValue([]);
    const client = new Recorder(() => okReply());
    await expect(proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(client.count).toBe(0);
  });

  it("a gateway failure burns no attempt and surfaces as 502", async () => {
    await expect(
      proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, new Failing()),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("channel 2 — a refusal", () => {
  it("returns after ONE call and is never retried", async () => {
    const client = new Recorder(() => REFUSAL);
    const out = await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    expect(out.status).toBe("insufficient_schema");
    expect(client.count).toBe(1);
  });
});

describe("the prompt's isolation, asserted on the SOURCE", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./db-query-proposal.service.ts", import.meta.url)),
    "utf8",
  );

  it("is reading the proposer", () => {
    expect(source.length).toBeGreaterThan(5000);
    expect(source).toContain("export async function proposeQuery");
  });

  it("never touches a connection string, a handle, or a data row", () => {
    const code = source
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    for (const name of [
      "connectionString",
      "connection_string",
      "datasourceRepo",
      "rowCount",
      "SAMPLE",
      "sampleRows",
    ]) {
      expect(code).not.toContain(name);
    }
  });

  it("renders every schema identifier DOUBLE-QUOTED, and the worked example too", () => {
    // The prompt half of I-118. A model copies what it is shown: shown
    // `public.User` it wrote `FROM public.User`, which Postgres folds to
    // `public.user`. Asserted on the prompt actually sent, not on the source.
    const client = new Recorder(() => okReply());
    return proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client).then(() => {
      const prompt = client.prompts[0]!;
      expect(prompt).toContain('"expense_claims"');
      expect(prompt).toContain('"amount_cents"');
      // ...and nowhere is an identifier offered bare for copying.
      expect(prompt).not.toMatch(/^\s{4}amount_cents:/m);
      expect(prompt).not.toMatch(/^\s{2}expense_claims$/m);
      // The rule, and the example it is taught by.
      expect(prompt).toContain("DOUBLE-QUOTE EVERY TABLE AND COLUMN IDENTIFIER");
      expect(prompt).toContain('FROM \\"public\\".\\"invoices\\"');
      // Scope: keywords, functions and parameters are explicitly out.
      expect(prompt).toContain("Do NOT quote SQL keywords");
    });
  });

  it("retries SQL whose identifiers are real but written bare", async () => {
    // Every column named below is real and correctly spelled — `checkSqlShape`
    // passes it, and it cannot run. This is the wiring test for the check half.
    const PASCAL: SchemaRow[] = [
      row("User", null, null),
      row("User", "id", "uuid"),
      row("User", "firstName", "text"),
    ];
    vi.mocked(schemaRepo.listByDatasource).mockResolvedValue(PASCAL);
    const bare = JSON.stringify({
      status: "ok",
      name: "recent_users",
      description: "x",
      sqlText: "SELECT id, firstName FROM public.User LIMIT 500",
      paramOrder: [],
      paramsSchema: {},
    });
    const quoted = JSON.stringify({
      status: "ok",
      name: "recent_users",
      description: "x",
      sqlText: 'SELECT "u"."id", "u"."firstName" FROM "public"."User" AS "u" LIMIT 500',
      paramOrder: [],
      paramsSchema: {},
    });
    const client = new Recorder((n) => (n === 1 ? bare : quoted));
    const out = (await proposeQuery(
      { workspaceId: "ws", dsId: "ds1", need: NEED },
      client,
    )) as QueryProposalOk;

    expect(out.status).toBe("ok");
    expect(out.attempts).toBe(2);
    expect(client.prompts[1]).toContain("unquoted_identifier");
    expect(client.prompts[1]).toContain("firstName");
  });

  it("does not rewrite the model's SQL — a proposal is returned verbatim", () => {
    // Refuse, never repair: the SQL a person approves is the SQL the model wrote.
    const client = new Recorder(() => okReply());
    return proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client).then((out) => {
      expect((out as QueryProposalOk).sqlText).toBe(GOOD_SQL);
    });
  });

  it("parses fenced responses but rejects a status-less one", () => {
    expect(parseQueryProposalResponse("```json\n" + okReply() + "\n```").status).toBe("ok");
    expect(() =>
      parseQueryProposalResponse(JSON.stringify({ name: "x", sqlText: "SELECT 1" })),
    ).toThrow(/neither channel/);
  });
});

/**
 * ── 2026-09-17 — the consuming step's contract reaches the prompt ────────────
 *
 * ⚠ **Asserted on the bytes actually sent**, like the quoting rule above, and
 * for the same reason: the defect this closes was a value that existed on one
 * side of a call and never arrived on the other. A test on the source would
 * pass against a `wanted` that is accepted and then dropped.
 *
 * The measured failure: a draft's transform read `candidate_email,
 * candidate_name, job_title` while this proposer — given only the four words
 * "candidates with job offers" against 46 tables and 667 columns — returned SQL
 * projecting `first_name, last_name, offer_id`. Both answers reasonable, nothing
 * reconciling them, and the report came out null in every field.
 */
describe("REQUIRED COLUMNS — the interface the consuming step already reads", () => {
  const WANTED = ["candidate_email", "candidate_name", "job_title"];

  it("renders every requested name into the prompt", async () => {
    const client = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED, wanted: WANTED }, client);
    const prompt = client.prompts[0]!;
    expect(prompt).toContain("REQUIRED COLUMNS — the consuming step reads these key names");
    for (const c of WANTED) expect(prompt).toMatch(new RegExp(`^  ${c}$`, "m"));
  });

  it("tells the model to ALIAS to those names rather than look for them", async () => {
    // The names are the drafter's invention — `candidate_email` may be
    // `"u"."email"` two joins away. A model told only "return these columns"
    // searches the schema for them, finds nothing, and refuses a query it could
    // have written.
    const client = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED, wanted: WANTED }, client);
    const prompt = client.prompts[0]!;
    expect(prompt).toMatch(/ALIASED to that exact/);
    expect(prompt).toMatch(/NOT names you will find/);
    // And that omitting beats guessing — the failure mode a report cannot show.
    expect(prompt).toMatch(/OMIT that column/);
    expect(prompt).toMatch(/nearest-looking column/);
  });

  /**
   * ⚠ The heading is ABSENT, not empty, when there is no consuming step. The
   * other caller is a person on the datasource page, where the need really is
   * the whole brief — and an empty `REQUIRED COLUMNS` reads as "this query must
   * return nothing".
   */
  it("renders NO heading when there is no contract", async () => {
    const client = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    // ⚠ The HEADING, not the phrase: the rules block names `REQUIRED COLUMNS`
    // conditionally ("if ... is present"), which is correct and must stay.
    expect(client.prompts[0]!).not.toContain(
      "REQUIRED COLUMNS — the consuming step reads these key names",
    );
  });

  it("CONTROL: the two prompts differ only by that block", async () => {
    // Without this, a `wanted` that silently replaced the NEED, or reordered the
    // schema, would satisfy every assertion above.
    const withC = new Recorder(() => okReply());
    const without = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED, wanted: WANTED }, withC);
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, without);
    const stripped = withC.prompts[0]!.replace(
      /\nREQUIRED COLUMNS — the consuming step reads these key names\n(?:  .*\n?)*/,
      "",
    );
    expect(stripped.trimEnd()).toBe(without.prompts[0]!.trimEnd());
  });
});

describe("the step's bound parameters (build:measure R07)", () => {
  const PARAMS = [{ name: "from_date", fedBy: "a value" }, { name: "to_date", fedBy: "a value" }];
  it("are rendered, and a proposal naming others is RE-ASKED with the finding", async () => {
    const client = new Recorder((n) => (n === 1 ? okReply().replace(/to_date/g, "until") : okReply()));
    const r = await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED, params: PARAMS }, client);
    expect(r.status).toBe("ok");
    expect(client.count).toBe(2);
    expect(client.prompts[0]).toContain("REQUIRED PARAMETERS");
    expect(client.prompts[0]).toContain("  from_date — a value");
    expect(client.prompts[1]).toMatch(/param_contract: .*your SQL asks for "until"/);
  });
  it("CONTROL: with no params the prompt carries no such block and one call suffices", async () => {
    const client = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    expect(client.count).toBe(1);
    expect(client.prompts[0]).not.toContain("REQUIRED PARAMETERS");
  });
});

describe("a step that binds NOTHING (build:measure r8 S1)", () => {
  it("says so, and an invented parameter is re-asked", async () => {
    const noParams = okReply().replace(/\$1/g, "now()").replace(/\$2/g, "now()").replace(/"paramOrder":\["from_date","to_date"\]/, '"paramOrder":[]').replace(/"paramsSchema":\{.*?\}\}\}/, '"paramsSchema":{}}');
    const client = new Recorder((n) => (n === 1 ? okReply() : noParams));
    const r = await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED, params: [] }, client);
    expect(client.prompts[0]).toContain("REQUIRED PARAMETERS — NONE");
    expect(client.count).toBe(2);
    expect(client.prompts[1]).toMatch(/passes NO parameters/);
    expect(r.status).toBe("ok");
  });
});

describe("the SQLite dialect block", () => {
  it("is added for a sqlite datasource and ABSENT otherwise, so Postgres prompts do not move", async () => {
    const pg = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED }, pg);
    expect(pg.prompts[0]).not.toContain("THIS DATABASE IS SQLITE");

    const lite = new Recorder(() => okReply());
    await proposeQuery({ workspaceId: "ws", dsId: "ds1", need: NEED, dialect: "sqlite" }, lite);
    expect(lite.prompts[0]).toContain("THIS DATABASE IS SQLITE");
    expect(lite.prompts[0]).toContain("strftime");
    // Everything else is identical: the block is inserted, nothing is rewritten.
    expect(lite.prompts[0]!.replace(/DIALECT — THIS DATABASE IS SQLITE[\s\S]*?Foundry binds and translates them for SQLite\.\n\n/, "")).toBe(pg.prompts[0]);
  });
});
