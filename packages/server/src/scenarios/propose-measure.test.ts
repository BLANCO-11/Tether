/**
 * `adjudicate()` is what SC-006's number IS — and it is the one part of
 * `propose-measure.ts` whose being wrong is invisible.
 *
 * ⚠ **The rest of that file reports; this function decides.** A harness that
 * printed the wrong tally would still print reasons beside it, and a reader would
 * notice. An adjudicator that scored a wrong operator as `unedited` produces a
 * clean number with nothing beside it to contradict — which is the exact shape of
 * *"a wrong answer nobody has a reason to doubt"* this repo refuses everywhere
 * else.
 *
 * It was perturbation-proved by hand once (an expectation's `ops` flipped to
 * `["gt"]`, which correctly reported *"used `lt`, wanted gt"*). This is that,
 * automated, plus the branches a live run does not reach: a thrown proposer, a
 * refusal on a satisfiable need, and a limit with no sort.
 */
import { describe, it, expect } from "vitest";
import { adjudicate, type Case } from "./propose-adjudicate.js";
import type { OperationProposal } from "../services/db-operation-proposal.service.js";
import type { DbOperationSpec } from "../services/db-operation.service.js";

const SPEC: DbOperationSpec = {
  base: { table: "attendance_monthly" },
  columns: [
    { column: "attendance_rate", alias: "attendance_rate" },
    { column: "full_name", alias: "employee_name" },
  ],
  joins: [{ table: "employees", onLeft: "employee_id", onRight: "id", kind: "inner" }],
  filters: [{ column: "attendance_rate", op: "lt", param: "min_rate" }],
  having: [],
  aggregateJoins: [],
  sort: [{ column: "attendance_rate", dir: "asc" }],
  limit: 500,
};

function ok(spec: DbOperationSpec = SPEC): OperationProposal {
  return {
    status: "ok",
    name: "low_attendance",
    description: "",
    spec,
    readback: [],
    outputColumns: [],
    ambiguousColumns: [],
    assumed: [],
    leftOut: [],
    values: [],
    covers: [],
    compiledSql: "SELECT 1",
    paramsSchema: {},
    attempts: 1,
    maxPerRequest: 3,
  };
}

const PROPOSE: Case = {
  name: "t",
  need: "n",
  want: "propose",
  expect: {
    base: ["attendance_monthly"],
    mustJoin: ["employees"],
    mustFilter: [{ column: "attendance_rate", ops: ["lt", "lte"] }],
    mustSelect: ["full_name", "attendance_rate"],
  },
};
const REFUSE: Case = { name: "t", need: "n", want: "refuse" };

/** A spec with one field replaced — so each test states only its own difference. */
const withSpec = (patch: Partial<DbOperationSpec>) => ok({ ...SPEC, ...patch });

describe("adjudicate — a satisfiable need", () => {
  it("is unedited when every declared essential is present", () => {
    const r = adjudicate(PROPOSE, ok());
    expect(r.verdict).toBe("unedited");
    expect(r.why).toEqual([]);
  });

  /**
   * ⚠ The control this whole file exists for. `lt` and `gt` on one column both
   * compile, both run, both return rows — and one emails everybody who attended
   * ENOUGH. Nothing else in the report distinguishes them.
   */
  it("is edited, NAMING the direction, when a filter's operator is the wrong way round", () => {
    const r = adjudicate(
      PROPOSE,
      withSpec({ filters: [{ column: "attendance_rate", op: "gt", param: "min_rate" }] }),
    );
    expect(r.verdict).toBe("edited");
    expect(r.why.join(" ")).toContain("used `gt`, wanted lt|lte");
    expect(r.why.join(" ")).toContain("changes the ANSWER");
  });

  it("is edited when a required filter is absent entirely", () => {
    const r = adjudicate(PROPOSE, withSpec({ filters: [] }));
    expect(r.verdict).toBe("edited");
    expect(r.why.join(" ")).toContain("no filter on `attendance_rate`");
  });

  it("is edited when the answer does not reach a table it needs", () => {
    const r = adjudicate(PROPOSE, withSpec({ joins: [] }));
    expect(r.verdict).toBe("edited");
    expect(r.why.join(" ")).toContain("does not reach `employees`");
  });

  it("is edited when a result column the reviewer needs is missing", () => {
    const r = adjudicate(
      PROPOSE,
      withSpec({ columns: [{ column: "attendance_rate", alias: "r" }] }),
    );
    expect(r.verdict).toBe("edited");
    expect(r.why.join(" ")).toContain("`full_name` is not in the result columns");
  });

  /**
   * ⚠ Checked on every proposing case, not only one whose need mentions a cap:
   * the prompt states the rule unconditionally, and "the first 500" of an
   * unordered read is an arbitrary 500 that can differ between two runs over
   * identical data.
   */
  it("is edited when a limit is set with no sort", () => {
    const r = adjudicate(PROPOSE, withSpec({ sort: [] }));
    expect(r.verdict).toBe("edited");
    expect(r.why.join(" ")).toContain("an arbitrary 500 rows");
  });

  /**
   * A different starting table is not an edit a person makes — it is a different
   * read. Scored `rejected`, and short-circuited so the report does not then list
   * six consequential complaints about a spec nobody would keep.
   */
  it("is REJECTED, not edited, on the wrong base table — and lists nothing else", () => {
    const r = adjudicate(PROPOSE, withSpec({ base: { table: "employees" } }));
    expect(r.verdict).toBe("rejected");
    expect(r.why).toHaveLength(1);
    expect(r.why[0]).toContain("base table is `employees`");
  });

  it("is REJECTED when it refuses a need this schema can express", () => {
    const r = adjudicate(PROPOSE, {
      status: "insufficient_schema",
      missing: ["x"],
      reason: "no such column",
      maxPerRequest: 3,
    });
    expect(r.verdict).toBe("rejected");
    expect(r.why[0]).toContain("refused a need this schema CAN express");
  });

  it("is REJECTED when the proposer gave up, and quotes why", () => {
    const r = adjudicate(PROPOSE, { thrown: "could not propose an operation that compiles" });
    expect(r.verdict).toBe("rejected");
    expect(r.why[0]).toContain("gave up");
    expect(r.why[0]).toContain("could not propose");
  });
});

describe("adjudicate — a need the schema cannot express", () => {
  it("scores a refusal as unedited, because it is the answer needing no edit", () => {
    const r = adjudicate(REFUSE, {
      status: "insufficient_schema",
      missing: ["a salary column"],
      reason: "nothing carries pay",
      maxPerRequest: 3,
    });
    expect(r.verdict).toBe("unedited");
    expect(r.why[0]).toContain("refused, correctly");
  });

  /**
   * ⚠ The plausible-but-wrong case, and the reason `want: "refuse"` exists at
   * all: it compiled, it has a readback, and it answers a different question.
   * It looks like a pass in every other column of the report.
   */
  it("REJECTS a proposal for it, however well the proposal compiles", () => {
    const r = adjudicate(REFUSE, ok());
    expect(r.verdict).toBe("rejected");
    expect(r.why[0]).toContain("cannot express");
    expect(r.why[0]).toContain("answers something else");
  });
});

describe("the controls", () => {
  /**
   * ⚠ Without this, every assertion above is satisfiable by an `adjudicate` that
   * returns `edited` for everything — six tests green, one number meaningless.
   */
  it("does not return one verdict for everything", () => {
    const verdicts = new Set([
      adjudicate(PROPOSE, ok()).verdict,
      adjudicate(PROPOSE, withSpec({ filters: [] })).verdict,
      adjudicate(PROPOSE, withSpec({ base: { table: "employees" } })).verdict,
    ]);
    expect(verdicts).toEqual(new Set(["unedited", "edited", "rejected"]));
  });

  /** And the refusal arm must not be the propose arm with a different label. */
  it("scores the SAME proposal oppositely depending on what the need wanted", () => {
    expect(adjudicate(PROPOSE, ok()).verdict).toBe("unedited");
    expect(adjudicate(REFUSE, ok()).verdict).toBe("rejected");
  });
});
