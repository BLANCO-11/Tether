/**
 * **The adjudication behind SC-006's number** — pure, and in its own module for
 * exactly the reason `db-operation-readback.ts` is.
 *
 * ⚠ **`propose-measure.ts` calls `main()` at import.** So the alternative — a
 * test importing the harness to reach this function — would fire the harness's
 * live model calls and its `process.exit` inside the test run. Nothing in this
 * file touches a database, a gateway or `process`, so it can be asserted
 * directly and the harness stays a script.
 *
 * Everything here is a REVIEWER'S requirement expressed as data, never a shape
 * check: `mustFilter` carries the operator **direction**, because `lt` and `gt`
 * on one column both compile, both return rows, and are indistinguishable in
 * every other column of the report.
 *
 * Asserted by `propose-measure.test.ts`, with a control that it does not return
 * one verdict for everything.
 */
import type { OperationProposal } from "../services/db-operation-proposal.service.js";
import { AGGREGATES, type DbOperationSpec } from "../services/db-operation.service.js";

/**
 * What a reviewer would have to see for a proposal to need no edit.
 *
 * ⚠ **Every field here is a REVIEWER'S requirement, not a shape check.** `base`
 * is a set because more than one table can be a defensible starting point for the
 * same need; `mustJoin` is what the need cannot be answered without; `mustFilter`
 * carries the **operator direction**, because `lt` and `gt` on the same column
 * are the plausible-but-wrong case spec.md names and they are indistinguishable
 * in every other column of this report.
 */
export interface Expect {
  /** Any one of these is an acceptable base table. */
  base: string[];
  /** Tables the answer cannot be produced without. */
  mustJoin?: string[];
  /** A filter on this column with an operator in this set. */
  mustFilter?: Array<{ column: string; ops: string[] }>;
  /** Result columns the reviewer needs to see, by the SOURCE column they read. */
  mustSelect?: string[];
  /** At least one column carrying this aggregate. */
  mustAggregate?: (typeof AGGREGATES)[number];
  /** The need says which end of the sort it wants. */
  mustSort?: { column: string; dir: "asc" | "desc" };
}

export interface Case {
  name: string;
  need: string;
  /**
   * `propose` — the schema can express it, and the expectation says what a
   * reviewer needs. `refuse` — it cannot, and a proposal is the wrong answer
   * however well it compiles.
   */
  want: "propose" | "refuse";
  expect?: Expect;
  /** Why a refusal is right — printed, so the reader can disagree with it. */
  because?: string;
  /**
   * A case whose correct answer the PROMPT does not authorise. Reported in its
   * own block and excluded from the headline rate, because folding it in would
   * make the rate a statement about this harness's case selection rather than
   * about the proposer.
   */
  hard?: boolean;
}


export type Verdict = "unedited" | "edited" | "rejected";

/** Every result column's SOURCE column name, aggregate or not. */
function sourceColumns(spec: DbOperationSpec): string[] {
  return spec.columns.map((col) => col.column ?? col.alias);
}

/**
 * The adjudication, and it is deliberately dumb code rather than a judgement.
 *
 * ⚠ Returns the REASONS too, never just the verdict. `2 edited` is a tally
 * nobody can act on; *"filter on attendance_rate used `gt`, wanted lt|lte"* is
 * the sentence that changes a prompt rule.
 */
export function adjudicate(kase: Case, got: OperationProposal | { thrown: string }): {
  verdict: Verdict;
  why: string[];
} {
  const why: string[] = [];

  if ("thrown" in got) {
    // Three answers that would not compile. Not a refusal — a failure.
    return { verdict: "rejected", why: [`the proposer gave up: ${got.thrown}`] };
  }

  if (got.status === "insufficient_schema") {
    if (kase.want === "refuse") {
      return { verdict: "unedited", why: [`refused, correctly: ${got.reason}`] };
    }
    return {
      verdict: "rejected",
      why: [`refused a need this schema CAN express: ${got.reason}`],
    };
  }

  if (kase.want === "refuse") {
    // ⚠ The plausible-but-wrong case, and the one that looks like a pass
    // everywhere else: it compiled, it has a readback, and it answers a
    // different question than the one asked.
    return {
      verdict: "rejected",
      why: [
        `proposed \`${got.name}\` for a need this schema cannot express — ` +
          `it compiles and answers something else`,
      ],
    };
  }

  const e = kase.expect!;
  const spec = got.spec;
  const joins = (spec.joins ?? []).map((j) => j.table);
  const filters = spec.filters ?? [];
  const sort = spec.sort ?? [];
  const cols = sourceColumns(spec);

  if (!e.base.includes(spec.base.table)) {
    // A different starting table is not an edit — it is a different read.
    return {
      verdict: "rejected",
      why: [`base table is \`${spec.base.table}\`, wanted one of ${e.base.join(" | ")}`],
    };
  }

  for (const t of e.mustJoin ?? []) {
    if (t !== spec.base.table && !joins.includes(t)) {
      why.push(`does not reach \`${t}\` — the need cannot be answered without it`);
    }
  }
  for (const f of e.mustFilter ?? []) {
    const hit = filters.find((x) => x.column === f.column);
    if (!hit) why.push(`no filter on \`${f.column}\``);
    else if (!f.ops.includes(hit.op)) {
      why.push(
        `filter on \`${f.column}\` used \`${hit.op}\`, wanted ${f.ops.join("|")} — ` +
          `this one changes the ANSWER`,
      );
    }
  }
  for (const s of e.mustSelect ?? []) {
    if (!cols.includes(s)) why.push(`\`${s}\` is not in the result columns`);
  }
  if (e.mustAggregate && !spec.columns.some((col) => col.aggregate === e.mustAggregate)) {
    why.push(`no column carries \`${e.mustAggregate}\` — the need asked how many`);
  }
  if (e.mustSort) {
    const hit = sort.find((x) => x.column === e.mustSort!.column);
    if (!hit) why.push(`not sorted by \`${e.mustSort.column}\``);
    else if (hit.dir !== e.mustSort.dir) {
      why.push(`sorted \`${hit.dir}\` by \`${e.mustSort.column}\`, wanted \`${e.mustSort.dir}\``);
    }
  }

  /**
   * ⚠ Checked on EVERY proposing case, not just the one whose need mentions a
   * cap — it is a rule the prompt states unconditionally ("if you set a limit,
   * ALSO set a sort"), and an unsorted limit is an arbitrary N that can differ
   * between two runs over identical data.
   */
  if (spec.limit !== undefined && sort.length === 0) {
    why.push(`limit ${spec.limit} with no sort — an arbitrary ${spec.limit} rows`);
  }

  return { verdict: why.length ? "edited" : "unedited", why };
}
