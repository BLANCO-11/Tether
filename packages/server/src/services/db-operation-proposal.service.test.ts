/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROPOSER — FR-005…FR-010, FR-018, SC-002, SC-004
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the one place in the product where a model's output leads to a
 * database read, so what is asserted here is chosen accordingly. Three groups:
 *
 *  1. **The two channels behave like the two that already exist.** A refusal is a
 *     success, returns after ONE call, and is never retried. A `check()` finding
 *     is the other kind of answer and IS retried, fed back verbatim.
 *  2. **Nothing is written.** A propose call that is not followed by a save
 *     leaves no row — asserted on the repository, not inferred from the return
 *     value.
 *  3. **The isolation is asserted against the module's SOURCE.** A behavioural
 *     test passes just as well when a forbidden field is present and merely
 *     unused, and the next person to touch the function will use it (D-54).
 *
 * ⚠ **`dbOperationService.check` is NOT mocked, deliberately.** The whole safety
 * argument is that a proposal is compiled by the same deterministic code a
 * hand-built spec is, so a test that stubbed the compiler would assert the
 * plumbing and skip the property. `compileOperation` is pure; only the repos are
 * stubbed.
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
  MAX_PROPOSALS_PER_REQUEST,
  findingForRetry,
  parseProposalResponse,
  proposeOperation,
  type OperationProposalOk,
} from "./db-operation-proposal.service.js";
import { FILTER_OPS, JOIN_KINDS } from "./db-operation.service.js";
import { UNTRUSTED_OPEN } from "../prompt-boundary/envelope.js";

// ── mocks: the repositories only ─────────────────────────────────────────────

vi.mock("../repositories/schema.repo.js", () => ({ schemaRepo: { listByDatasource: vi.fn() } }));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: { listByDatasource: vi.fn(), create: vi.fn(), get: vi.fn() },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { listByDatasource: vi.fn() },
}));
vi.mock("../repositories/datasource.repo.js", () => ({ datasourceRepo: { get: vi.fn() } }));

// ── fixtures ─────────────────────────────────────────────────────────────────

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
    throw new InferenceError("connect ECONNREFUSED", "propose:ds1");
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
  row("invoices", null, null),
  row("invoices", "id", "uuid", { isPrimaryKey: true }),
  row("invoices", "amount", "numeric"),
  row("invoices", "due_date", "date"),
  row("invoices", "customer_id", "uuid", {
    isForeignKey: true,
    foreignKeyReference: "customers.id",
  }),
  row("customers", null, null),
  row("customers", "id", "uuid", { isPrimaryKey: true }),
  row("customers", "name", "text"),
];

const GOOD_SPEC = {
  base: { table: "invoices" },
  columns: [
    { column: "id", alias: "invoice_id" },
    { column: "amount", alias: "amount" },
    { column: "name", alias: "customer_name" },
  ],
  joins: [{ table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" }],
  filters: [{ column: "due_date", op: "lt", param: "as_of" }],
  sort: [{ column: "amount", dir: "desc" }],
  limit: 500,
};

const okReply = (name = "overdue_invoices", spec: unknown = GOOD_SPEC) =>
  JSON.stringify({ status: "ok", name, description: "Overdue invoices with the customer name.", spec });

const REFUSAL = JSON.stringify({
  status: "insufficient_schema",
  missing: ["a due date or invoice date column"],
  reason: "no column in the introspected schema carries a date; overdue cannot be expressed",
});

const NEED = "read invoices that are overdue as of a given date, with the customer's name";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(schemaRepo.listByDatasource).mockResolvedValue(SCHEMA);
  vi.mocked(dbOperationRepo.listByDatasource).mockResolvedValue([]);
  vi.mocked(datasourceQueryRepo.listByDatasource).mockResolvedValue([]);
  vi.mocked(datasourceRepo.get).mockResolvedValue({
    id: "ds1",
    name: "billing_db",
    type: "postgres",
  } as never);
});

// ── 1. the two channels ──────────────────────────────────────────────────────

describe("channel 1 — a proposal", () => {
  it("returns the compiled spec with its readback, output columns and derived params", async () => {
    const client = new Recorder(() => okReply());
    const out = (await proposeOperation(
      { workspaceId: "ws", dsId: "ds1", need: NEED },
      client,
    )) as OperationProposalOk;

    expect(out.status).toBe("ok");
    expect(out.name).toBe("overdue_invoices");
    expect(out.attempts).toBe(1);
    expect(out.maxPerRequest).toBe(MAX_PROPOSALS_PER_REQUEST);

    // ⚠ SELECT-only by construction — the safety argument, asserted rather than
    // assumed, and from the SQL the real compiler emitted.
    expect(out.compiledSql.startsWith("SELECT ")).toBe(true);
    expect(out.compiledSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);

    // Params are DERIVED from the filters, never taken from the model.
    expect(Object.keys(out.paramsSchema)).toEqual(["as_of"]);

    // The readback and the provenance both came back — FR-026's additive fields.
    expect(out.readback.map((c) => c.label)).toContain("Kept when");
    // Provenance only: `nullable` is pinned in db-operation-nullability.test.ts.
    expect(out.outputColumns.map(({ nullable: _n, ...c }) => c)).toEqual([
      { alias: "invoice_id", source: "invoices.id", type: "uuid" },
      { alias: "amount", source: "invoices.amount", type: "numeric" },
      { alias: "customer_name", source: "customers.name", type: "text" },
    ]);
  });

  it("⚠ SC-004 — writes NOTHING", async () => {
    const client = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    // Asserted on the repository, not inferred from the return value. A stray
    // write here surfaces weeks later as a ref nobody remembers creating.
    expect(dbOperationRepo.create).not.toHaveBeenCalled();
    expect(vi.mocked(dbOperationRepo.listByDatasource).mock.calls.length).toBe(1);
  });
});

describe("a REVISION — the read as it stands, revised in place", () => {
  it("shows the read as it stands BEFORE the need, keeps the shared prefix byte-identical, and asks for its parameter names kept", async () => {
    const plain = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, plain);
    const rev = new Recorder(() => okReply());
    const spec = { base: { table: "invoices" }, columns: [], joins: [], filters: [{ column: "due_date", op: "lt", param: "as_of" }], having: [], aggregateJoins: [], sort: [] };
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED, revise: { name: "overdue_invoices", spec: spec as never } }, rev);
    const p = rev.prompts[0]!;
    expect(p).toContain("THE READ AS IT STANDS — REVISE THIS ONE");
    expect(p).toContain(JSON.stringify(spec));
    expect(p).toMatch(/KEEP every parameter whose meaning is unchanged/);
    expect(p.indexOf("THE READ AS IT STANDS")).toBeLessThan(p.indexOf("\nNEED\n"));
    // CONTROL: a first write carries no revision block, and both share everything above it.
    const q = plain.prompts[0]!;
    expect(q).not.toContain("THE READ AS IT STANDS");
    const head = q.slice(0, q.indexOf("\nNEED\n"));
    expect(p.startsWith(head)).toBe(true);
  });
  it("the rules steer a named MONTH to one month filter, never a start and an end", async () => {
    const c = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, c);
    expect(c.prompts[0]).toMatch(/A calendar month[\s\S]*ONE "month" filter/);
    expect(c.prompts[0]).not.toMatch(/a period's start and end as two params/);
  });
});

describe("channel 2 — insufficient_schema", () => {
  it("⚠ FR-008 — returns after ONE call and is never re-asked", async () => {
    const client = new Recorder(() => REFUSAL);
    const out = await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);

    expect(out.status).toBe("insufficient_schema");
    // ⚠ THE ASSERTION THIS FILE EXISTS FOR. Re-asking is how "no column in this
    // schema carries a date" becomes a plausible-looking `created_at` on attempt
    // 2 — a spec that compiles, runs, returns rows, and answers a different
    // question. `MAX_PROPOSAL_ATTEMPTS` is 3, so a loop that retried would show
    // up here as 3.
    expect(client.count).toBe(1);
  });

  it("passes `missing` and `reason` through unchanged, and carries the bound", async () => {
    const client = new Recorder(() => REFUSAL);
    const out = await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    if (out.status !== "insufficient_schema") throw new Error("expected a refusal");
    expect(out.missing).toEqual(["a due date or invoice date column"]);
    expect(out.reason).toContain("no column in the introspected schema carries a date");
    // FR-014 — a refusal spends one of the N too, so the bound travels with it.
    expect(out.maxPerRequest).toBe(MAX_PROPOSALS_PER_REQUEST);
  });

  it("⚠ a status-less response is REJECTED, never read as a proposal", async () => {
    // A bare spec with no `status`. If this were read as `ok`, the refusal
    // channel would quietly stop existing — the failure the whole module is
    // shaped around.
    expect(() => parseProposalResponse(JSON.stringify(GOOD_SPEC))).toThrow(/neither channel/);
    const client = new Recorder(() => JSON.stringify(GOOD_SPEC));
    await expect(
      proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client),
    ).rejects.toThrow(/could not propose/);
    expect(client.count).toBe(3);
  });

  it("a malformed reply names WHERE it is wrong and what was written there — so the retry can fix that field (2026-10-01)", () => {
    const bad = { ...GOOD_SPEC, aggregateJoins: [{ table: "payments", groupBy: "invoice_id", onLeft: "id", kind: "left", aggregates: [{ column: "invoices amount", aggregate: "sum", alias: "paid" }] }] };
    let msg = "";
    try { parseProposalResponse(okReply("x", bad)); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/spec\.aggregateJoins\.0\.aggregates\.0\.column = "invoices amount": column /);
    // CONTROL: the refusal channel's own fields are not listed against a reply that claims `ok`.
    expect(msg).not.toMatch(/missing|reason/);
  });

  it("the THIRD answer: a read with what it assumed and left out, passed through — and [] when the reply names none", async () => {
    const withNotes = JSON.stringify({ status: "ok", name: "overdue_invoices", spec: GOOD_SPEC, assumed: [{ words: "late", as: "due_date before the date given" }], left_out: [{ words: "with penalties", why: "no penalty column" }] });
    const a = await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, new Recorder(() => withNotes));
    if (a.status !== "ok") throw new Error("expected a read");
    expect(a.assumed).toEqual([{ words: "late", as: "due_date before the date given" }]);
    expect(a.leftOut).toEqual([{ words: "with penalties", why: "no penalty column" }]);
    const b = await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, new Recorder(() => okReply()));
    if (b.status !== "ok") throw new Error("expected a read");
    expect([b.assumed, b.leftOut]).toEqual([[], []]);
  });

  it("tolerates a markdown fence and surrounding prose", async () => {
    // Re-asking over formatting spends an attempt on nothing.
    const client = new Recorder(() => "Here you go:\n```json\n" + okReply() + "\n```\nHope that helps.");
    const out = await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    expect(out.status).toBe("ok");
    expect(client.count).toBe(1);
  });
});

// ── 2. findings are fed back verbatim ────────────────────────────────────────

describe("FR-009 — a check() finding is fed back VERBATIM", () => {
  it("quotes the compiler's own sentence, adds nothing, and succeeds on attempt 2", async () => {
    const bad = { ...GOOD_SPEC, columns: [{ column: "no_such_column", alias: "x" }] };
    const client = new Recorder((n) => (n === 1 ? okReply("overdue_invoices", bad) : okReply()));

    const out = (await proposeOperation(
      { workspaceId: "ws", dsId: "ds1", need: NEED },
      client,
    )) as OperationProposalOk;

    expect(out.status).toBe("ok");
    expect(out.attempts).toBe(2);

    // ⚠ I-57: 25 of 26 findings in a measured run were a scanner bug, handed to
    // a model as fact. The rule that keeps that honest is that nothing here
    // paraphrases a finding or appends advice — so the compiler's exact sentence
    // must appear in the retry prompt.
    const retry = client.prompts[1]!;
    expect(retry).toContain('no column "no_such_column"');
    expect(retry).toContain("every identifier must resolve against the introspected schema");
    // And what WAS available travels with it, which is the actionable half.
    expect(retry).toContain("YOUR PREVIOUS ANSWER WAS REJECTED");
  });

  it("a NAME is code's to make: a taken one gets a free one, a spelled-out one becomes an identifier — no second call (2026-10-01)", async () => {
    vi.mocked(dbOperationRepo.listByDatasource).mockResolvedValue([{ name: "overdue_invoices" }] as never);
    vi.mocked(datasourceQueryRepo.listByDatasource).mockResolvedValue([{ name: "open_invoices" }] as never);
    const taken = new Recorder(() => okReply("overdue_invoices"));
    const a = (await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, taken)) as OperationProposalOk;
    expect(a.name).toBe("overdue_invoices_2");
    expect(taken.prompts).toHaveLength(1);
    // Both kinds of reader share one namespace: a step ref is `<ds>.<name>` whichever kind it resolves to, so a collision with a
    // NAMED QUERY is a collision too.
    const query = new Recorder(() => okReply("open_invoices"));
    expect(((await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, query)) as OperationProposalOk).name).toBe("open_invoices_2");
    // A name with a space or a leading digit — what spent all three attempts on 2026-10-01 — is made one.
    const spaced = new Recorder(() => okReply("2 Six day shift over ten_hours"));
    const c = (await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, spaced)) as OperationProposalOk;
    expect(c.name).toBe("read_2_six_day_shift_over_ten_hours");
    expect(spaced.prompts).toHaveLength(1);
  });

  it("gives up after three attempts with the findings attached, not with a refusal", async () => {
    const bad = { ...GOOD_SPEC, columns: [{ column: "nope", alias: "x" }] };
    const client = new Recorder(() => okReply("overdue_invoices", bad));
    await expect(
      proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(client.count).toBe(3);
  });
});

// ── 3. the refusals that are not the model's ─────────────────────────────────

describe("the failures that are not a bad proposal", () => {
  it("⚠ 409 on an un-introspected datasource, and spends NO inference call", async () => {
    vi.mocked(schemaRepo.listByDatasource).mockResolvedValue([]);
    const client = new Recorder(() => okReply());
    await expect(
      proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Every identifier would be unresolvable, so all three attempts would be
    // spent discovering that.
    expect(client.count).toBe(0);
  });

  it("names the re-scan as the fix, because that is the action", async () => {
    vi.mocked(schemaRepo.listByDatasource).mockResolvedValue([]);
    await expect(
      proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, new Recorder(() => okReply())),
    ).rejects.toThrow(/schema refresh \(re-scan\)/);
  });

  it("⚠ 502 on an unreachable gateway, consuming NO attempt", async () => {
    const client = new Failing();
    await expect(
      proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client),
    ).rejects.toMatchObject({ statusCode: 502 });
    // Infrastructure, not a bad proposal. A retry loop here would spend three
    // calls against a gateway that is not answering.
    expect(client.calls).toBe(1);
  });
});

// ── 4. the prompt ───────────────────────────────────────────────────────────

describe("the prompt", () => {
  it("puts NEED last, and keeps the first prompt a byte-exact PREFIX of the retry", async () => {
    const bad = { ...GOOD_SPEC, columns: [{ column: "nope", alias: "x" }] };
    const client = new Recorder((n) => (n === 1 ? okReply("overdue_invoices", bad) : okReply()));
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);

    const first = client.prompts[0]!;
    const retry = client.prompts[1]!;
    expect(first.trimEnd().endsWith(NEED)).toBe(true);
    // Findings go AFTER the need, so the shared prefix is byte-identical and
    // caches — the rule `buildDraftPrompt` follows for the same reason.
    expect(retry.startsWith(first)).toBe(true);
  });

  it("renders the enums FROM the exported arrays, so the prompt cannot fall behind", async () => {
    const client = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    const prompt = client.prompts[0]!;
    // ⚠ A ninth filter operator added to FILTER_OPS reaches the prompt on its
    // own. The alternative is a retyped list that silently stops matching the
    // vocabulary the compiler accepts.
    expect(prompt).toContain(FILTER_OPS.join(", "));
    expect(prompt).toContain(JOIN_KINDS.join(", "));
  });

  it("wraps the schema in the provenance envelope", async () => {
    const client = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    const prompt = client.prompts[0]!;
    // Column and table names are tenant-authored text reaching a prompt, which
    // is what the envelope exists for.
    expect(prompt).toContain(UNTRUSTED_OPEN);
    expect(prompt).toContain("PROVENANCE");
  });

  it("carries the foreign keys, which are what make a correct join possible", async () => {
    const client = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    expect(client.prompts[0]).toContain("fk to customers.id");
  });

  it("⚠ carries NO row of data and no credential", async () => {
    const client = new Recorder(() => okReply());
    await proposeOperation({ workspaceId: "ws", dsId: "ds1", need: NEED }, client);
    const prompt = client.prompts[0]!;
    // D-54: shown real rows to imitate, the output stops being derived from the
    // schema and starts being derived from a sample.
    for (const forbidden of ["postgres://", "mysql://", "password", "connectionString", "dsn"]) {
      expect(prompt.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(prompt).toContain("YOU HAVE NOT SEEN A SINGLE ROW OF DATA");
  });
});

// ── 5. FR-006 / FR-018 — the isolation, against the module's own source ──────

describe("FR-006 — the proposer's isolation, asserted on its SOURCE", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./db-operation-proposal.service.ts", import.meta.url)),
    "utf8",
  );

  /**
   * ⚠ **CODE ONLY.** This module's docblock explains at length why it does not
   * import `datasourceRepo` and what a `connectionString` would cost — so a
   * prose-scanning version of these assertions fails on the explanation, and is
   * satisfiable by deleting it. That is the wrong direction, and
   * `db-operation-readback.test.ts` records the same mistake.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  /** ⚠ The control: the file this read is really the proposer. */
  it("and the file it read is really the proposer", () => {
    expect(source.length).toBeGreaterThan(5000);
    expect(code).toContain("export async function proposeOperation");
    expect(code).toContain("insufficient_schema");
    expect(code.length).toBeGreaterThan(2000);
  });

  it("names no DSN, connection string, database handle or row fetch", () => {
    for (const forbidden of [
      "connectionString",
      "datasourceRepo",
      "postgres://",
      "mysql://",
      "pg.Pool",
      "createPool",
      "db.select",
      "sql`",
      "process.env",
    ]) {
      expect(code, `the proposer must not name ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reads ONE datasource's schema, by the parameter it was given", () => {
    // `listByDatasource(opts.dsId)` and nothing else — there is no
    // `listByWorkspace` here, which is the shape that would reach a second
    // datasource's schema.
    expect(code).toContain("schemaRepo.listByDatasource(opts.dsId)");
    expect(code).not.toContain("listByWorkspace");
  });

  it("⚠ FR-018 — imports nothing from the generation module", () => {
    // The proposer must not be able to reach a draft, a flow model or the
    // automation goal. Asserted as an ABSENCE, the way `flow-refine.service.ts`
    // protects the same property.
    expect(code).not.toContain("flow-generation.service");
    for (const forbidden of ["draftFlow", "authorFlow", "generateFlow", "buildDraftPrompt", "FlowModel"]) {
      expect(code, `the proposer must not name ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("⚠ SC-002 — emits no SQL and offers the model nowhere to put any", () => {
    // The model fills in a form; `compileOperation` is the only thing in this
    // system that turns a form into SQL.
    //
    // ⚠ The first version of this test forbade the word `SELECT` outright and
    // failed on the PROMPT line that tells the model its form is *"compiled to a
    // read-only SELECT by code"* — a sentence whose whole job is to say that SQL
    // is not the model's to write. A test satisfiable by deleting that line is
    // pointed the wrong way, so the assertion is now on the CLAUSES an emitter
    // cannot do without, plus an exact-count on the one legitimate mention.
    for (const forbidden of [" FROM ", " WHERE ", " GROUP BY ", " ORDER BY ", " JOIN ", "$1"]) {
      expect(code, `the proposer must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // Exactly one mention, and it is the prompt's own disclaimer. A second
    // occurrence anywhere in this module fails this test — which is the point.
    expect(code.match(/SELECT/g) ?? []).toHaveLength(1);
    expect(code).toContain("read-only SELECT by code");
    expect(code).toContain("You are NOT writing SQL");
  });

  it("⚠ offers the model no FIELD that could carry SQL", () => {
    // The `ok` channel accepts `status`, `name`, `description` and `spec`. A
    // response field a model could put a statement in is the beginning of the
    // second path, and it would be additive and invisible.
    for (const forbidden of ["sql:", '"sql"', "sqlText", "rawSql", "statement:"]) {
      expect(code, `the proposal response must not accept ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain("spec: dbOperationSpecSchema");
  });
});

// ── 6. the route's ordering hazard, given a control ─────────────────────────

/**
 * ⚠ T09 documents this in a comment, and a comment is not a control.
 *
 * `/operations/check` and `/operations/propose` are LITERAL paths that must be
 * declared before `/:dsId/operations/:name`, or `:name` captures the words
 * "check" and "propose". Express matches on method as well as path, so today's
 * `GET`/`PATCH`/`DELETE` on `:name` cannot shadow a `POST` — but a `POST` on
 * `:name` declared above them would swallow both, and the symptom is a 404 that
 * reads like a missing operation rather than a routing mistake.
 */
describe("the propose route is declared where it has to be", () => {
  const router = readFileSync(
    fileURLToPath(new URL("../routes/datasources.ts", import.meta.url)),
    "utf8",
  );

  /** ⚠ The control: the file this read is really the datasources router. */
  it("and the file it read is really the datasources router", () => {
    expect(router.length).toBeGreaterThan(3000);
    expect(router).toContain("export const datasourcesRouter");
    expect(router).toContain('"/:dsId/operations/:name"');
  });

  it("declares both literal operation paths BEFORE the :name handlers", () => {
    const named = router.indexOf('"/:dsId/operations/:name"');
    const check = router.indexOf('"/:dsId/operations/check"');
    const propose = router.indexOf('"/:dsId/operations/propose"');
    expect(check).toBeGreaterThan(-1);
    expect(propose).toBeGreaterThan(-1);
    expect(check).toBeLessThan(named);
    expect(propose).toBeLessThan(named);
  });

  it("⚠ has no POST on /:dsId/operations/:name — the one thing that would shadow both", () => {
    // If this ever becomes needed, it must be declared BELOW check and propose.
    expect(router).not.toMatch(/datasourcesRouter\.post\(\s*"\/:dsId\/operations\/:name"/);
  });

  it("routes the 404 through the redacted datasource view, not the repository", () => {
    // `datasourceService.get` returns `toPublic`, which never returns the
    // connection string — which is what lets the proposer stay without
    // `datasourceRepo` at all (FR-005).
    expect(router).toContain("datasourceService.get(req.params.workspaceId, req.params.dsId)");
    expect(router).toContain("needSchema.parse(req.body)");
  });
});

describe("findingForRetry — a retry is told where an absent column lives", () => {
  const rows = [row("t", "a", "int"), row("t", "b", "date"), row("u", "b", "date"), row("u", "c", "text")];
  it("an unknown column carries the table's own columns and every table that has the name", () => {
    const t = findingForRetry({ code: "unknown_column", message: "no column \"b\" on w", identifier: "w.b", available: ["x", "y"] }, rows);
    expect(t).toBe("no column \"b\" on w — the columns there are: x, y — “b” is a column of t, u");
  });
  it("a name no table has says so", () => {
    expect(findingForRetry({ code: "unknown_column", message: "m", identifier: "zz" }, rows)).toBe("m — no table in the schema has a column “zz”");
  });
  it("CONTROL: any other finding is passed VERBATIM", () => {
    expect(findingForRetry({ code: "unknown_table", message: "no table \"q\"", identifier: "q", available: ["t"] }, rows)).toBe("no table \"q\"");
  });
});
