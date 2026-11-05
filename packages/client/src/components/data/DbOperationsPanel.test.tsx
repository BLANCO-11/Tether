// @vitest-environment jsdom
/**
 * The approval surface for a DB operation — proposed or hand-built.
 * proposed-db-operations · P2 · T17 · US2 scenarios 4a and 4b
 *
 * ── There was no test for this panel at all before this file ─────────────────
 *
 * It has held the create path since Phase 4. What P2 adds to it is a **review
 * surface a person is asked to approve**, and every property below is one a
 * screen can lose silently:
 *
 *  - A `note` dropped in JSX. `inner` and `left` produce the same readback
 *    `text` and different notes, so a rendering that omits `note` looks
 *    complete, reads fluently, and has thrown away the entire difference
 *    between "unmatched invoices are left out" and "kept, with a blank
 *    customer" (FR-023, SC-007).
 *  - The SQL becoming the primary artefact again, or disappearing. Both are
 *    failures and they are opposite failures (FR-011).
 *  - `maxPerRequest` hardcoded here. Then the screen states a bound the server
 *    does not hold, and the two drift apart quietly (FR-014, **D-189**).
 *  - A Retry button on a refusal. That is how *"no column carries a date"*
 *    becomes a confident `created_at` on attempt 2 (FR-008, D-171).
 *  - A cell of invented data appearing in the output-columns table. `lib/mock-rows.ts`
 *    was built during this feature and deleted as *"invented values wearing a
 *    real table's column names"* (FR-024, SC-008).
 *
 * ⚠ **Every readback sentence here is SERVER-RENDERED**, so this file asserts
 * that the client *displays* what it was given and composes nothing. The
 * sentences themselves are pinned by `db-operation-readback.test.ts`, which
 * enumerates every operator, join kind, aggregate and sort direction. A second
 * copy of those expectations here would be a second definition of what a spec
 * means — which is the exact thing FR-022 forbids.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const listOperations = vi.fn();
const createOperation = vi.fn();
const checkOperation = vi.fn();
const proposeOperation = vi.fn();
const deleteOperation = vi.fn();

/**
 * ⚠ **A WHOLE-MODULE REPLACEMENT — every read this panel makes must be listed
 * here.** An omitted name arrives `undefined`, `useAsync` invokes it, and the
 * panel crashes in EVERY test in this file. That is precisely what happened to
 * `tools/page.test.tsx` when `listPromptBoundaryWarnings` was added to that
 * page. Adding a `@/lib/api` call to `DbOperationsPanel` means adding it here.
 */
vi.mock("@/lib/api", () => ({
  listOperations: (...a: unknown[]) => listOperations(...a),
  createOperation: (...a: unknown[]) => createOperation(...a),
  checkOperation: (...a: unknown[]) => checkOperation(...a),
  proposeOperation: (...a: unknown[]) => proposeOperation(...a),
  deleteOperation: (...a: unknown[]) => deleteOperation(...a),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); } }));

import { DbOperationsPanel, REVIEW_CAVEAT } from "./DbOperationsPanel";
import { FoundryApiError, type FAReadbackClause } from "@/lib/foundry-client";
import type { AssetNode } from "@/lib/types";

/** Two introspected tables, in the tree shape the datasource page passes down. */
const SCHEMA: AssetNode[] = [
  {
    asset_type: "db_schema",
    name: "public",
    children: [
      {
        asset_type: "table",
        name: "invoices",
        children: [
          { asset_type: "column", name: "id" },
          { asset_type: "column", name: "amount" },
          { asset_type: "column", name: "due_date" },
          { asset_type: "column", name: "customer_id" },
        ],
      },
      {
        asset_type: "table",
        name: "customers",
        children: [
          { asset_type: "column", name: "id" },
          { asset_type: "column", name: "name" },
        ],
      },
    ],
  },
];

const SPEC = {
  base: { table: "invoices" },
  columns: [
    { column: "id", alias: "invoice_id" },
    { column: "name", alias: "customer_name" },
  ],
  joins: [{ table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" as const }],
  filters: [{ column: "due_date", op: "lt" as const, param: "as_of" }],
  sort: [{ column: "amount", dir: "desc" as const }],
  limit: 500,
};

/**
 * The two readback variants, **copied from `readback()`'s real output** rather
 * than invented — the join note is the sentence 4a is about.
 *
 * ⚠ These are FIXTURES OF THE WIRE, not expectations about wording. If
 * `readback()`'s phrasing changes, this file keeps passing and
 * `db-operation-readback.test.ts` is the one that decides whether the new
 * wording is right. What is asserted here is that whatever arrives is *shown*.
 */
const INNER_NOTE =
  "invoices with no matching row in customers are LEFT OUT of the result";
const LEFT_NOTE =
  "invoices with no matching row in customers are KEPT, with the customers columns blank";

function readbackWith(joinNote: string): FAReadbackClause[] {
  return [
    { label: "From", text: "invoices" },
    {
      label: "From",
      text: "each row matched to customers, by customer_id = customers.id",
      note: joinNote,
    },
    {
      label: "Kept when",
      text: "due_date is BEFORE the value you supply — for a number, LESS THAN it (as_of)",
    },
    { label: "You get", text: "invoice_id ← id · customer_name ← name" },
    { label: "Ordered by", text: "amount, largest first — for dates, most recent first" },
    { label: "At most", text: "500 rows" },
  ];
}

const OUTPUT_COLUMNS = [
  { alias: "invoice_id", source: "invoices.id", type: "integer" },
  { alias: "customer_name", source: "customers.name", type: "text" },
];

const COMPILED_SQL =
  'SELECT "invoices"."id" AS "invoice_id", "customers"."name" AS "customer_name" FROM "invoices"';

function proposal(over: Record<string, unknown> = {}) {
  return {
    status: "ok" as const,
    name: "overdue_invoices",
    description: "Invoices past their due date as of a supplied date.",
    spec: SPEC,
    readback: readbackWith(INNER_NOTE),
    outputColumns: OUTPUT_COLUMNS,
    ambiguousColumns: [],
    compiledSql: COMPILED_SQL,
    paramsSchema: { as_of: { type: "string", required: true } },
    attempts: 1,
    maxPerRequest: 3,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listOperations.mockResolvedValue([]);
  createOperation.mockResolvedValue({ id: "op1", name: "overdue_invoices" });
  proposeOperation.mockResolvedValue(proposal());
  deleteOperation.mockResolvedValue(undefined);
  checkOperation.mockResolvedValue({
    ok: true,
    compiledSql: COMPILED_SQL,
    paramsSchema: { as_of: { type: "string", required: true } },
    readback: readbackWith(INNER_NOTE),
    outputColumns: OUTPUT_COLUMNS,
    ambiguousColumns: [],
  });
});
afterEach(() => cleanup());

function mount(schema: AssetNode[] = SCHEMA) {
  return render(<DbOperationsPanel datasourceId="d1" schema={schema} />);
}

/** Open the propose form and ask once. */
async function ask(need = "overdue invoices with the customer name") {
  fireEvent.click(await screen.findByRole("button", { name: "Propose one for me" }));
  fireEvent.change(screen.getByLabelText("What do you need to read?"), { target: { value: need } });
  fireEvent.click(screen.getByRole("button", { name: "Propose a spec" }));
  await waitFor(() => expect(proposeOperation).toHaveBeenCalled());
}

describe("US2 4a — the join note reaches the screen", () => {
  it("renders the inner-join consequence, not only the join condition", async () => {
    mount();
    await ask();
    await screen.findByText(INNER_NOTE);
    // The decision itself is on screen too — a note with no clause above it is
    // a consequence of nothing.
    expect(screen.getByText(/each row matched to customers, by customer_id = customers\.id/))
      .toBeTruthy();
  });

  it("renders the LEFT-join consequence for the same spec shape — the two do not collapse", async () => {
    proposeOperation.mockResolvedValue(proposal({ readback: readbackWith(LEFT_NOTE) }));
    mount();
    await ask();
    await screen.findByText(LEFT_NOTE);
    // ⚠ The control that makes the pair meaningful: the OTHER sentence must be
    // absent. A rendering that printed both, or a generic "rows are joined",
    // would pass a one-sided assertion.
    expect(screen.queryByText(INNER_NOTE)).toBeNull();
  });

  it("renders EVERY clause it is given, in the order given — a label may repeat", async () => {
    mount();
    await ask();
    const clauses = readbackWith(INNER_NOTE);
    for (const c of clauses) {
      expect(screen.getByText(c.text), `clause "${c.text}" is missing`).toBeTruthy();
    }
    // Two `From` clauses, because each join carries its own note. A rendering
    // that grouped by label would show one.
    expect(screen.getAllByText("From")).toHaveLength(2);
  });
});

describe("US2 4b — no rows of data, and the caveat that says what this cannot check", () => {
  it("states that units and business meaning are not checked here", async () => {
    mount();
    await ask();
    await screen.findByText(REVIEW_CAVEAT);
  });

  it("does not imply the data was verified", async () => {
    mount();
    await ask();
    // FR-025's own bound. `verified`/`correct` beside an approve button is the
    // false reassurance this sentence exists to prevent.
    expect(REVIEW_CAVEAT).not.toMatch(/verified|correct|validated|accurate/i);
    expect(REVIEW_CAVEAT).toMatch(/not.*checked here/i);
    expect(REVIEW_CAVEAT).toMatch(/expectation/);
  });

  it("renders no cell that is not schema metadata (SC-008)", async () => {
    mount();
    await ask();
    const dialog = (await screen.findByText("What this will do")).closest("div")!.parentElement!;
    // Every cell in the review surface's table must be an alias, a resolved
    // source, or a source column type — all three come from the compiler. A
    // "sample values" column would put invented data on a screen wearing a real
    // table's column names, and would fire here.
    const allowed = new Set<string>([
      ...OUTPUT_COLUMNS.map((c) => c.alias),
      ...OUTPUT_COLUMNS.map((c) => c.source),
      ...OUTPUT_COLUMNS.map((c) => c.type),
    ]);
    const cells = dialog.querySelectorAll("td");
    expect(cells.length).toBeGreaterThan(0);
    for (const td of cells) {
      expect(allowed, `unexpected table cell "${td.textContent}"`).toContain(td.textContent);
    }
  });

  it("labels the type as the SOURCE column's, never as the output's (D-185)", async () => {
    mount();
    await ask();
    // `count` over a `text` column returns a number and `type` still reads
    // `text`, so "output type" would be a confident claim that is wrong for
    // every aggregate.
    await screen.findByText("Source column type");
    expect(screen.queryByText(/output type|returns a|result type/i)).toBeNull();
  });
});

describe("FR-011 — the readback leads and the SQL is collapsed, not removed", () => {
  it("orders the dialog readback → output columns → params → name → SQL", async () => {
    mount();
    await ask();
    const order = [
      await screen.findByText("What this will do"),
      screen.getByText("What comes back"),
      screen.getByText("Values it asks for"),
      screen.getByLabelText("Operation name"),
      screen.getByRole("button", { name: /Show the compiled SQL/ }),
    ];
    for (let i = 1; i < order.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING === 4
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & 4,
        `element ${i} does not follow element ${i - 1}`,
      ).toBeTruthy();
    }
  });

  it("hides the SQL until asked, and then shows it", async () => {
    mount();
    await ask();
    // Collapsed: not the primary artefact…
    expect(screen.queryByText(COMPILED_SQL)).toBeNull();
    // …and NOT removed. A reviewer who reads SQL catches what the readback
    // cannot say, and losing them is the opposite failure.
    fireEvent.click(screen.getByRole("button", { name: "Show the compiled SQL" }));
    await screen.findByText(COMPILED_SQL);
  });
});

describe("FR-010 / FR-013 / SC-004 — a proposal is not authorisation", () => {
  it("creates nothing when a proposal is shown", async () => {
    mount();
    await ask();
    await screen.findByText("What this will do");
    expect(createOperation).not.toHaveBeenCalled();
  });

  it("creates nothing when the proposal is discarded", async () => {
    mount();
    await ask();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText("What this will do")).toBeNull());
    expect(createOperation).not.toHaveBeenCalled();
  });

  it("submits the EDITED name and the spec, and carries no proposal id", async () => {
    mount();
    await ask();
    fireEvent.change(await screen.findByLabelText("Operation name"), {
      target: { value: "invoices_overdue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create operation" }));
    await waitFor(() => expect(createOperation).toHaveBeenCalled());
    const [dsId, body] = createOperation.mock.calls[0] as [string, Record<string, unknown>];
    expect(dsId).toBe("d1");
    expect(body.name).toBe("invoices_overdue");
    expect(body.spec).toEqual(SPEC);
    // ⚠ There is no field for one, and there must not be: the server re-runs
    // `check()` and `create()` on the SUBMITTED spec because this dialog is
    // editable by design (FR-013).
    expect(Object.keys(body).sort()).toEqual(["description", "name", "spec"]);
  });

  it("refuses a name that is not a plain identifier, before any request", async () => {
    mount();
    await ask();
    fireEvent.change(await screen.findByLabelText("Operation name"), {
      target: { value: "overdue.invoices" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create operation" }));
    await screen.findByText(/must be a plain identifier/);
    expect(createOperation).not.toHaveBeenCalled();
  });

  it("states that the name cannot be changed after saving (FR-012)", async () => {
    mount();
    await ask();
    await screen.findByText(
      "This name becomes part of every automation that uses it and cannot be changed later.",
    );
  });
});

describe("FR-008 / D-171 — a refusal is a success, and is never re-asked", () => {
  const REFUSAL = {
    status: "insufficient_schema" as const,
    missing: ["a due date or invoice date column"],
    reason: "no column in the introspected schema carries a date; overdue cannot be expressed",
    maxPerRequest: 3,
  };

  it("renders the reason and what is missing", async () => {
    proposeOperation.mockResolvedValue(REFUSAL);
    mount();
    await ask();
    await screen.findByText(REFUSAL.reason);
    expect(screen.getByText(REFUSAL.missing[0])).toBeTruthy();
  });

  it("offers NO retry, and does not re-ask on its own", async () => {
    proposeOperation.mockResolvedValue(REFUSAL);
    mount();
    await ask();
    await screen.findByText(REFUSAL.reason);
    for (const b of screen.getAllByRole("button")) {
      expect(b.textContent ?? "", "a refusal must offer no retry").not.toMatch(
        /retry|try again|ask again|regenerate/i,
      );
    }
    expect(proposeOperation).toHaveBeenCalledTimes(1);
  });

  it("does not render it as a failure", async () => {
    proposeOperation.mockResolvedValue(REFUSAL);
    mount();
    await ask();
    await screen.findByText(REFUSAL.reason);
    // Same rule `policy-copy.test.ts` holds for the policy refusals: a correct
    // refusal presented as an error is the product's most defensible moment
    // reading as it breaking.
    expect(screen.queryByText(/couldn't propose a spec/i)).toBeNull();
  });
});

describe("the two real failures — and neither gets a retry either", () => {
  it("renders a 409's message, which names the re-scan", async () => {
    proposeOperation.mockRejectedValue(
      new FoundryApiError(
        "this datasource has no introspected schema — run a schema refresh (re-scan) first",
        409,
      ),
    );
    mount();
    await ask();
    await screen.findByText(/schema refresh \(re-scan\)/);
  });

  it("renders a 422's findings verbatim, and offers no retry", async () => {
    proposeOperation.mockRejectedValue(
      new FoundryApiError("could not produce a spec that compiles in 3 attempts", 422, [
        { message: 'unknown column "invoice_date" on invoices; available: id, amount, due_date' },
      ]),
    );
    mount();
    await ask();
    // The findings are the only actionable part of this failure, so they are
    // rendered rather than flattened into the sentence above them (I-57).
    await screen.findByText(/unknown column "invoice_date"/);
    for (const b of screen.getAllByRole("button")) {
      expect(b.textContent ?? "").not.toMatch(/retry|try again|ask again/i);
    }
  });
});

describe("FR-014 / D-189 — the bound comes from the server", () => {
  it("states the bound the RESPONSE carries, not a number from this file", async () => {
    proposeOperation.mockResolvedValue(proposal({ maxPerRequest: 2 }));
    mount();
    await ask();
    // ⚠ The whole point. A hardcoded `3` would render "1 of 3" here and be a
    // second definition of a server bound.
    await screen.findByText("1 of 2 proposals used");
    expect(screen.queryByText(/of 3 proposals used/)).toBeNull();
  });

  it("says nothing numeric before the first response", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Propose one for me" }));
    // The number arrives WITH a response, and there is nothing to bound before
    // one has. Inventing a figure to fill the gap is the hardcode this decision
    // exists to avoid.
    expect(screen.queryByText(/proposals used/)).toBeNull();
  });

  it("stops at the bound and SAYS it has stopped", async () => {
    proposeOperation.mockResolvedValue(proposal({ maxPerRequest: 1 }));
    mount();
    await ask();
    await screen.findByText("1 of 1 proposals used");
    // ⚠ Never a silent stop: a surface that quietly stops offering proposals
    // reads as "there is nothing more to propose", which is the opposite of
    // true and the reader cannot tell (`step-payload-bounds` FR-012).
    await screen.findByText(/That is all 1 proposals for this visit/);
    expect(
      (screen.getByRole("button", { name: "Propose another" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("counts a REFUSAL against the bound too", async () => {
    proposeOperation.mockResolvedValue({
      status: "insufficient_schema",
      missing: ["a date column"],
      reason: "nothing here carries a date",
      maxPerRequest: 3,
    });
    mount();
    await ask();
    // A refusal costs an inference call and a person's attention. A surface
    // counting only proposals would offer N+1.
    await screen.findByText("1 of 3 proposals used");
  });
});

describe("FR-026 / T14 — the hand-built spec gets the same review surface", () => {
  it("renders the readback and output columns from check(), not only for proposals", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New operation" }));
    fireEvent.change(screen.getByLabelText("Column 1"), { target: { value: "id" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(checkOperation).toHaveBeenCalled());
    // ⚠ Not a bonus. A readback only proposals got would be two review
    // standards for one artefact, chosen by who happened to author it — and the
    // weaker standard would be the one applied to every spec nobody proposed.
    await screen.findByText(INNER_NOTE);
    expect(screen.getByText("Source column type")).toBeTruthy();
  });

  it("carries the same caveat and the same immutable-name sentence", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New operation" }));
    await screen.findByText(REVIEW_CAVEAT);
    expect(
      screen.getByText(
        "This name becomes part of every automation that uses it and cannot be changed later.",
      ),
    ).toBeTruthy();
  });

  it("collapses the SQL in the builder too", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New operation" }));
    fireEvent.change(screen.getByLabelText("Column 1"), { target: { value: "id" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(checkOperation).toHaveBeenCalled());
    await screen.findByText(INNER_NOTE);
    expect(screen.queryByText(COMPILED_SQL)).toBeNull();
  });

  it("leaves the refused branch alone — findings, and no readback", async () => {
    checkOperation.mockResolvedValue({
      ok: false,
      problems: [
        {
          code: "unknown_column",
          message: 'unknown column "inovice_id"',
          identifier: "inovice_id",
          available: ["id", "amount"],
        },
      ],
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New operation" }));
    fireEvent.change(screen.getByLabelText("Column 1"), { target: { value: "id" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await screen.findByText(/unknown column "inovice_id"/);
    // ⚠ A spec that will not compile has no readback. Rendering one from an
    // invalid spec is a confident English sentence describing something that
    // cannot run.
    expect(screen.queryByText(INNER_NOTE)).toBeNull();
    expect(screen.getByText(/available: id, amount/)).toBeTruthy();
  });
});

describe("no schema, no proposal", () => {
  it("does not offer propose, and says why", async () => {
    mount([]);
    await screen.findByText(/hasn't read this source's schema/);
    expect(screen.queryByRole("button", { name: "Propose one for me" })).toBeNull();
    // The server would answer 409. A button that leads to a refusal is worse
    // than an absence with the reason beside it, because the reason arrives
    // after the click instead of before it.
    expect(proposeOperation).not.toHaveBeenCalled();
  });
});

/** A saved operation, shaped the way `listOperations` actually returns one. */
function savedOperation(over: Record<string, unknown> = {}) {
  return {
    id: "op1",
    datasourceId: "d1",
    name: "overdue_invoices",
    ref: "invoices_demo.overdue_invoices",
    description: "Invoices past their due date as of a supplied date.",
    spec: SPEC,
    compiledSql: COMPILED_SQL,
    paramsSchema: { as_of: { type: "string", required: true } },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("row expand/collapse — the operation's own detail (FR-001…FR-007)", () => {
  it("starts collapsed and shows no detail until clicked (FR-006)", async () => {
    listOperations.mockResolvedValue([savedOperation()]);
    mount();
    await screen.findByText("overdue_invoices");
    expect(screen.queryByText(COMPILED_SQL)).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /overdue_invoices/, expanded: false })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("expands on click to show the target, joins and compiled SQL, and collapses again (FR-001, FR-002, FR-003)", async () => {
    listOperations.mockResolvedValue([savedOperation()]);
    mount();
    const header = await screen.findByRole("button", { name: /overdue_invoices/, expanded: false });

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("invoices")).toBeTruthy();
    expect(screen.getByText(/inner join customers on customer_id = id/)).toBeTruthy();
    expect(screen.getByText(COMPILED_SQL)).toBeTruthy();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(COMPILED_SQL)).toBeNull();
  });

  it("expands each row independently — opening one does not close another (FR-005)", async () => {
    listOperations.mockResolvedValue([
      savedOperation({ id: "op1", name: "overdue_invoices", ref: "invoices_demo.overdue_invoices" }),
      savedOperation({
        id: "op2",
        name: "customer_totals",
        ref: "invoices_demo.customer_totals",
        spec: { ...SPEC, joins: [], filters: [] },
      }),
    ]);
    mount();
    const first = await screen.findByRole("button", { name: /overdue_invoices/, expanded: false });
    const second = screen.getByRole("button", { name: /customer_totals/, expanded: false });

    fireEvent.click(first);
    fireEvent.click(second);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
  });

  it("issues no additional request when a row is expanded (FR-004)", async () => {
    listOperations.mockResolvedValue([savedOperation()]);
    mount();
    const header = await screen.findByRole("button", { name: /overdue_invoices/, expanded: false });
    fireEvent.click(header);
    await screen.findByText(COMPILED_SQL);
    expect(listOperations).toHaveBeenCalledTimes(1);
    expect(checkOperation).not.toHaveBeenCalled();
    expect(proposeOperation).not.toHaveBeenCalled();
  });
});

/**
 * ── The source-read controls ────────────────────────────────────────────────
 *
 * A render test passes just as well when a forbidden thing is present and
 * merely unreached on the path the test happens to walk. These read the module
 * off disk — the idiom `db-operation-proposal.service.test.ts` uses for FR-006,
 * and `ui-honesty-check.sh`'s for the client.
 */
describe("what this module must not contain", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, "DbOperationsPanel.tsx"), "utf8");
  /**
   * ⚠ **BOTH FILES, and this is a correction rather than thoroughness.**
   *
   * The review surface was extracted into `OperationReview.tsx` mid-P3 so a chat
   * turn could render the identical dialog (D-195) — and that moved the readback
   * rendering, the output-columns table and FR-025's caveat out from under greps
   * that were still scanning only the panel. They kept passing, over a file that
   * no longer contained the thing they were about.
   *
   * `ui-honesty-check.sh`'s two matching assertions went RED at the same moment,
   * which is what a check that names its subject is supposed to do. These did
   * not, because "this file does not contain X" stays true when X leaves.
   */
  const review = readFileSync(join(here, "OperationReview.tsx"), "utf8");

  /**
   * ⚠ **CODE ONLY — comments stripped first**, which is D-188's rule and the
   * third time this exact trap has fired in this feature.
   *
   * `OperationReview.tsx`'s docblock names `lib/mock-rows.ts` in the sentence
   * explaining why it was deleted, so the SC-008 grep below matched its own
   * justification. A test satisfiable by **removing the explanation** is pointed
   * the wrong way — the same mistake `ui-honesty-check.sh`'s check 6 records
   * ("a check that fails on its own justification teaches people to delete the
   * justification") and I-62's *"state what is forbidden, not a pattern that
   * resembles it"*.
   */
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const source = `${code(panel)}\n${code(review)}`;

  it("is long enough for these greps to mean anything", () => {
    // The control on the controls: a renamed or moved file would read as an
    // empty string and every assertion below would pass over nothing (I-38).
    expect(panel.length).toBeGreaterThan(15_000);
    expect(review.length).toBeGreaterThan(5_000);
    expect(panel).toContain("ProposalFlow");
    // ⚠ Names the SUBJECT of each file, so neither can be emptied or renamed
    // away while the combined string still satisfies the assertions below.
    expect(review).toContain("export function ProposalReview");
    expect(review).toContain("REVIEW_CAVEAT");
    // ⚠ The control on the comment-stripper: if it ever ate the whole file, the
    // three `not.toMatch` assertions below would pass over an empty string.
    expect(source).toContain("export function ProposalReview");
    expect(source).toContain("setCap(r.maxPerRequest)");
    expect(source.length).toBeGreaterThan(8_000);
  });

  it("takes the proposal bound from the response and defines no copy of it", () => {
    expect(panel).toContain("setCap(r.maxPerRequest)");
    // ⚠ `maxPerRequest: 3` or `cap = 3` anywhere in this file is the second
    // definition D-189 exists to prevent.
    expect(source).not.toMatch(/maxPerRequest\s*[:=]\s*\d/);
    expect(source).not.toMatch(/MAX_PROPOSALS/);
  });

  it("builds no rows of data (FR-024, SC-008)", () => {
    // `lib/mock-rows.ts` was built during this feature and deleted. The panel
    // is served schema metadata only, and there is no endpoint on this path
    // that returns a row — so a sample row here could only be invented.
    expect(source).not.toMatch(/mock-rows|sampleRows|previewRows|fakeRow|Math\.random/);
  });

  it("composes no readback sentence of its own (FR-022)", () => {
    // The readback has ONE implementation, server-side. A phrase from
    // `db-operation-readback.ts`'s vocabulary appearing here would be the
    // beginning of the second one.
    expect(source).not.toMatch(/LEFT OUT|KEPT, with|EXACTLY the value|NO LIMIT/);
  });
});


/**
 * Removing a saved reader.
 *
 * ⚠ **The refusal is the subject, not the delete.** Deleting a reader is quiet
 * in the worst way: it does not fail the edit, the compile or the deploy, it
 * fails the next RUN of every flow that names it — on a flow that may be armed
 * and firing on a schedule, for somebody who did not press the button. So what
 * these assert is that the 409 reaches the person with its flow names, and that
 * `force` is reachable only after it has.
 */
describe("removing a saved operation", () => {
  const SAVED = [
    {
      id: "op1",
      name: "invoices_past_due",
      ref: "finance_demo.invoices_past_due",
      spec: {
        base: { schema: "public", table: "invoices" },
        columns: [],
        filters: [{ column: "due", op: "lt", param: "as_of" }],
        joins: [],
        having: [],
        sort: [],
      },
    },
  ];

  const confirmSpy = () => vi.spyOn(window, "confirm");

  afterEach(() => vi.restoreAllMocks());

  it("removes after one confirmation when nothing reads it", async () => {
    listOperations.mockResolvedValue(SAVED);
    const confirm = confirmSpy().mockReturnValue(true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove invoices_past_due" }));
    await waitFor(() => expect(deleteOperation).toHaveBeenCalledWith("d1", "invoices_past_due"));
    // ⚠ ONE confirmation and NO force — the flow that asks twice is the refusal
    // path below, and a delete that force-deletes on the happy path would make
    // the whole gate decorative.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteOperation).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the confirmation is declined", async () => {
    listOperations.mockResolvedValue(SAVED);
    confirmSpy().mockReturnValue(false);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove invoices_past_due" }));
    await waitFor(() => expect(screen.getByText("invoices_past_due")).toBeTruthy());
    expect(deleteOperation).not.toHaveBeenCalled();
  });

  /**
   * ⚠ The whole point. The server's 409 names the flows; the second dialog
   * quotes it verbatim, so the person decides against the actual consequence
   * rather than against the word "referenced".
   */
  it("shows the server's flow list on a 409, then forces only if confirmed again", async () => {
    listOperations.mockResolvedValue(SAVED);
    const refusal = new FoundryApiError(
      '"invoices_past_due" is still read by 2 automation(s): Chase overdue, Weekly digest.',
      409,
    );
    deleteOperation.mockRejectedValueOnce(refusal).mockResolvedValueOnce(undefined);
    const confirm = confirmSpy().mockReturnValue(true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove invoices_past_due" }));

    await waitFor(() => expect(deleteOperation).toHaveBeenCalledTimes(2));
    // The second dialog carries the server's sentence, flow names included.
    expect(confirm.mock.calls[1][0]).toContain("Chase overdue, Weekly digest");
    expect(deleteOperation).toHaveBeenLastCalledWith("d1", "invoices_past_due", { force: true });
  });

  it("declining the second dialog leaves the reader in place", async () => {
    listOperations.mockResolvedValue(SAVED);
    deleteOperation.mockRejectedValueOnce(
      new FoundryApiError("still read by 1 automation(s): Chase overdue.", 409),
    );
    confirmSpy().mockReturnValueOnce(true).mockReturnValueOnce(false);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove invoices_past_due" }));
    await waitFor(() => expect(deleteOperation).toHaveBeenCalledTimes(1));
    // ⚠ Never a `force` call. A second dialog that deletes whatever the answer
    // is would be a confirmation in name only.
    expect(deleteOperation).not.toHaveBeenCalledWith("d1", "invoices_past_due", { force: true });
  });

  /**
   * ⚠ CONTROL. A non-409 must NOT offer the force path — otherwise a transport
   * error, a 500 or a 403 becomes a second dialog offering to break automations
   * over a failure that had nothing to do with references.
   */
  it("CONTROL: a non-409 failure never offers to force", async () => {
    listOperations.mockResolvedValue(SAVED);
    deleteOperation.mockRejectedValue(new FoundryApiError("boom", 500));
    const confirm = confirmSpy().mockReturnValue(true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove invoices_past_due" }));
    await waitFor(() => expect(deleteOperation).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
