/**
 * **A MEASUREMENT, not a gate** — `pnpm --filter @foundry/server propose:measure`.
 *
 * *Of N need statements over a known schema, how many proposals would a reviewer
 * accept unedited, how many would they edit, and how many would they reject?*
 * (proposed-db-operations **SC-006**, T23.)
 *
 * ── The problem with SC-006, stated rather than worked around ────────────────
 *
 * SC-006 asks for a **reviewer's** three-way split. A harness is not a reviewer,
 * and the two ways to fake one are both worse than useless:
 *
 *  * **An implementer eyeballing the output afterwards.** The most biased
 *    reviewer available, judging their own system, with the answer already in
 *    front of them. Every borderline case resolves toward "fine".
 *  * **A model judging a model.** Two draws from the same distribution. It
 *    agrees with the proposal for the same reasons the proposal was made.
 *
 * So the split is adjudicated against an **expectation declared before the
 * proposal is seen** — written into `CASES` below from the schema alone, in the
 * commit that created this file, and readable in `git log` as having preceded any
 * run. That is what makes the number something other than an opinion: the
 * expectations cannot be quietly relaxed to fit a disappointing result without
 * the relaxation being in the diff.
 *
 * ⚠ **What the number therefore IS, precisely.** It is agreement with a declared
 * expectation, not a person's acceptance. The two come apart in both directions:
 *
 *  * A real reviewer may **accept** something filed here as `edited` — an extra
 *    column nobody minds, a different but equally good alias.
 *  * A real reviewer may **reject** something filed here as `unedited` — wrong in
 *    a way the expectation did not think to forbid.
 *
 * The first is the common one, so **`edited` here is an UPPER bound on the edit
 * rate a person would report, and `unedited` is a LOWER bound.** Which is the
 * safe direction for a number that gates a reliability claim, and is why the
 * harness is built this way round.
 *
 * ── The controls, which are the half that makes the rest mean anything ───────
 *
 * Four needs the schema can express, and **three it cannot**. Without the
 * refusal cases a 100% propose rate is indistinguishable from a component that
 * always proposes something — and *always proposing something* is the exact
 * failure the `insufficient_schema` channel exists to prevent (FR-007). Two of
 * the three are clean: no column in `hr_demo` carries a salary or a performance
 * rating, and the prompt authorises a refusal in those words.
 *
 * The third is deliberately **hard, and expected to fail**: comparing a column
 * to *another column* (`attendance_rate < min_attendance_rate`) is not
 * expressible, because a filter compares a column to a **param** and there is no
 * column-to-column form. Every table and column the need mentions exists, so the
 * refusal is not the one the prompt describes. It is recorded as
 * `hard: true` and reported separately — a case a measurement is not allowed to
 * quietly drop because it is the one that will look bad.
 *
 * ── SC-006's own warning, which this file must print and not soften ──────────
 *
 * ⚠ **A high unedited rate is AMBIGUOUS.** It means the proposals matched the
 * expectations, or it means the expectations were written by the same hand that
 * wrote the prompt. It is never a quality score, and it is never evidence that a
 * surface may describe this as reliable. Read it beside SC-007's exhaustive
 * readback test and FR-025's on-screen bound — the two things that hold when the
 * proposal is wrong.
 *
 * ── Writes nothing ───────────────────────────────────────────────────────────
 *
 * `proposeOperation` persists nothing by construction (FR-010/SC-004), and this
 * file adds no `create` call. A proposal-quality harness that saved its proposals
 * would leave N operations on a real datasource and change the `takenNames` the
 * next run is prompted with.
 *
 * ⚠ **Exits non-zero only if the harness could not run.** A rate is a number to
 * read. Same posture as `kestra:refusal`, `outline:measure` and `draft:measure`.
 *
 * ── Why `--rounds` is not optional to READ, only to pass ────────────────────
 *
 * ⚠ **The first two runs of this file disagreed.** Identical harness, identical
 * cases, identical model: `5 unedited / 1 edited` then `6 unedited / 0 edited` —
 * the headcount case failed to compile on its first attempt in one run and not in
 * the other. At n = 6 a single case moving is the whole difference between two
 * numbers a reader would quote differently.
 *
 * So the default is **3 rounds**, and the report prints the per-round split
 * rather than only the pooled one. A single-round figure is not wrong, it is
 * *precision-free*, and the version of this file that could only produce one
 * would have reported `6 / 0 / 0` with nothing on screen to suggest that a
 * second run might not.
 *
 *   pnpm --filter @foundry/server propose:measure
 *   pnpm --filter @foundry/server propose:measure --rounds=1
 *   pnpm --filter @foundry/server propose:measure --workspace=HR --datasource=hr_demo
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import {
  proposeOperation,
  MAX_PROPOSALS_PER_REQUEST,
  type OperationProposal,
} from "../services/db-operation-proposal.service.js";
import {
  adjudicate,
  type Case,
  type Verdict,
} from "./propose-adjudicate.js";

/**
 * ⚠ **Declared against `hr_demo`'s 7 introspected tables and nothing else** —
 * `attendance_daily`, `attendance_monthly`, `departments`, `employees`,
 * `leave_requests`, `offices`, `policy_thresholds`. Written before the first
 * proposal was requested. The needs are phrased the way a person asks, not the
 * way the form is shaped: none of them names a table, a column, an operator or a
 * join, because a need statement that spelled the answer would measure
 * transcription rather than proposal.
 */
const CASES: Case[] = [
  {
    name: "attendance defaulters",
    need:
      "the employees whose monthly attendance rate fell below a threshold I supply, " +
      "with their name and work email so I can contact them",
    want: "propose",
    expect: {
      base: ["attendance_monthly"],
      mustJoin: ["employees"],
      // ⚠ `lt`/`lte` only. `gt` compiles, runs, returns rows, and emails
      // everybody who attended ENOUGH — the defect no other column here shows.
      mustFilter: [{ column: "attendance_rate", ops: ["lt", "lte"] }],
      mustSelect: ["full_name", "work_email", "attendance_rate"],
    },
  },
  {
    name: "leave in a window",
    need:
      "approved leave requests that fall in a date range I give, with the employee's " +
      "name and the type of leave",
    want: "propose",
    expect: {
      base: ["leave_requests"],
      mustJoin: ["employees"],
      // The status filter is the one a reviewer would notice missing: without it
      // the read answers "all leave" and the need said approved.
      mustFilter: [
        { column: "status", ops: ["eq"] },
        { column: "start_date", ops: ["gte", "gt", "lte", "lt"] },
      ],
      mustSelect: ["full_name", "leave_type"],
    },
  },
  {
    name: "headcount per department",
    need: "how many employees each department currently has, for employees in a status I supply",
    want: "propose",
    expect: {
      base: ["employees", "departments"],
      mustJoin: ["departments", "employees"],
      mustFilter: [{ column: "status", ops: ["eq"] }],
      mustSelect: ["name"],
      mustAggregate: "count",
    },
  },
  {
    name: "roster by office region, newest first",
    need:
      "the people based in an office region I name, most recently hired first, " +
      "capped at a sensible number of rows",
    want: "propose",
    expect: {
      base: ["employees"],
      mustJoin: ["offices"],
      mustFilter: [{ column: "region", ops: ["eq"] }],
      mustSelect: ["full_name", "hire_date"],
      mustSort: { column: "hire_date", dir: "desc" },
    },
  },

  // ── the three the schema cannot express ────────────────────────────────────
  {
    name: "salary above department average",
    need: "employees earning more than the average salary in their department",
    want: "refuse",
    because:
      "no column in any of the 7 tables carries pay, salary or compensation — and " +
      "the nearest-looking column, policy_thresholds.min_attendance_rate, is a rate",
  },
  {
    name: "low performance ratings",
    need: "employees whose last performance review scored below a number I supply",
    want: "refuse",
    because: "there is no reviews, ratings or appraisals table; nothing carries a score",
  },
  {
    name: "below their OWN department's threshold",
    need:
      "employees whose monthly attendance rate is below the minimum attendance rate " +
      "their own department's policy requires",
    want: "refuse",
    hard: true,
    because:
      "every table and column exists — but a filter compares a column to a PARAM, and " +
      "there is no column-to-column form, so `attendance_rate < min_attendance_rate` " +
      "cannot be expressed. ⚠ The prompt's refusal channel is worded for missing DATA, " +
      "not for an inexpressible COMPARISON, so a refusal here is not the one it asks for",
  },
];
import { inference, type InferenceClient } from "../services/inference.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

async function main() {
  const wsName = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1] ?? "HR";
  const dsName =
    process.argv.find((a) => a.startsWith("--datasource="))?.split("=")[1] ?? "hr_demo";
  const rounds = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 3);

  const ws = (await workspaceRepo.list()).find((w) => w.name === wsName);
  if (!ws) {
    console.error(c.bad(`no workspace named "${wsName}" — pass --workspace=<name>`));
    process.exit(1);
  }
  const ds = (await datasourceRepo.listByWorkspace(ws.id)).find((d) => d.name === dsName);
  if (!ds) {
    console.error(c.bad(`no datasource named "${dsName}" in ${wsName}`));
    process.exit(1);
  }

  /**
   * ⚠ **The fixture is asserted, not assumed.** Every expectation in `CASES` was
   * written against a specific 7-table schema. If this datasource has been
   * reseeded with different tables, the expectations are measuring nothing and
   * the honest outcome is to stop — a rate computed against a schema the
   * expectations do not describe is a wrong answer nobody has a reason to doubt.
   */
  const schemaRows = await schemaRepo.listByDatasource(ds.id);
  const tables = [
    ...new Set(schemaRows.filter((r) => r.entityType === "table").map((r) => r.entityName)),
  ].sort();
  const WANT_TABLES = [
    "attendance_daily",
    "attendance_monthly",
    "departments",
    "employees",
    "leave_requests",
    "offices",
    "policy_thresholds",
  ];
  const missing = WANT_TABLES.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.error(
      c.bad(`\n  ${dsName} does not carry the schema these expectations were written against.`) +
        `\n  missing: ${missing.join(", ")}` +
        `\n  present: ${tables.join(", ") || "(nothing introspected)"}\n`,
    );
    process.exit(1);
  }

  const provider = await resolveGenerationProvider();
  const existing = await dbOperationRepo.listByDatasource(ds.id);
  console.log(
    `\n  ${c.dim("model      ")} ${provider.model}` +
      (provider.source === "configured" ? c.dim("  (set on /ai-provider)") : ""),
  );
  console.log(`  ${c.dim("datasource ")} ${wsName} / ${dsName}  ${c.dim(`(${tables.length} tables)`)}`);
  console.log(`  ${c.dim("cases      ")} ${CASES.length}  ${c.dim(
    `(${CASES.filter((k) => k.want === "propose").length} expressible, ` +
      `${CASES.filter((k) => k.want === "refuse").length} not)`,
  )}`);
  console.log(`  ${c.dim("operations ")} ${existing.length} already on this datasource`);
  console.log(`  ${c.dim("rounds     ")} ${rounds}\n`);

  const rows: Array<{
    round: number;
    kase: Case;
    verdict: Verdict;
    why: string[];
    calls: number;
    secs: number;
    attempts: number | null;
    readback: string[];
    name: string | null;
  }> = [];

  for (let round = 1; round <= rounds; round++) {
   if (rounds > 1) console.log(`  ${c.dim(`── round ${round} ─────────────────────────────────────────────`)}`);
   for (const kase of CASES) {
    let calls = 0;
    const counter: InferenceClient = {
      async complete(prompt, opts) {
        calls++;
        return inference.complete(prompt, opts);
      },
    };
    const t0 = Date.now();
    let got: OperationProposal | { thrown: string };
    try {
      got = await proposeOperation({ workspaceId: ws.id, dsId: ds.id, need: kase.need }, counter);
    } catch (e) {
      got = { thrown: (e as Error).message };
    }
    const secs = (Date.now() - t0) / 1000;
    const { verdict, why } = adjudicate(kase, got);

    const ok = !("thrown" in got) && got.status === "ok";
    rows.push({
      round,
      kase,
      verdict,
      why,
      calls,
      secs,
      attempts: ok ? (got as { attempts: number }).attempts : null,
      // ⚠ The readback, verbatim from `check()` — so a reader can DISAGREE with
      // the adjudication above rather than take it on trust. It is the artefact
      // FR-011 puts in front of the person, so it is the artefact this report
      // shows; the compiled SQL is not printed, for the same reason the surface
      // collapses it.
      readback: ok
        ? (got as { readback: Array<{ label: string; text: string; note?: string }> }).readback.map(
            (r) => `${r.label}: ${r.text}${r.note ? `  (${r.note})` : ""}`,
          )
        : [],
      name: ok ? (got as { name: string }).name : null,
    });

    const tag =
      verdict === "unedited" ? c.ok("unedited") : verdict === "edited" ? c.warn("edited  ") : c.bad("rejected");
    console.log(
      `  ${tag}  ${kase.name.padEnd(38)} ${calls} call(s)  ${secs.toFixed(1)}s` +
        (kase.hard ? c.dim("  [HARD]") : ""),
    );
    for (const w of why) console.log(`            ${c.dim(w)}`);
   }
  }

  // ── the split ──────────────────────────────────────────────────────────────
  //
  // ⚠ The HARD case is excluded from the headline and reported under it. Folding
  // it in would make the rate a statement about which cases this harness chose.
  const headline = rows.filter((r) => !r.kase.hard);
  const tally = (v: Verdict) => headline.filter((r) => r.verdict === v).length;
  const n = headline.length;

  console.log(`\n  ${c.dim("── SC-006 · agreement with a pre-declared expectation ───")}`);

  /**
   * ⚠ **Per round FIRST, pooled second.** The pooled figure is the one a reader
   * quotes, and it is the one that hides the finding: if round 1 says 4/0/0 and
   * round 2 says 3/1/0, the pooled 7/1/0 reads as a stable 87% when the truth is
   * that one case in four flips. Printing the rounds above the pool makes the
   * spread impossible to quote away.
   */
  if (rounds > 1) {
    for (let r = 1; r <= rounds; r++) {
      const set = headline.filter((x) => x.round === r);
      const t = (v: Verdict) => set.filter((x) => x.verdict === v).length;
      console.log(
        `  ${c.dim(`round ${r}`)}  ${c.ok(`${t("unedited")} unedited`)} · ` +
          `${c.warn(`${t("edited")} edited`)} · ${c.bad(`${t("rejected")} rejected`)}`,
      );
    }
    const spread = new Set(
      Array.from({ length: rounds }, (_, i) =>
        headline.filter((x) => x.round === i + 1 && x.verdict === "unedited").length,
      ),
    );
    console.log(
      spread.size > 1
        ? `  ${c.warn("the rounds DISAGREE")} ${c.dim("— the split is not reproducible at this n.")}`
        : `  ${c.dim(`${rounds} rounds agreed — which is evidence of stability, not of correctness.`)}`,
    );
  }

  console.log(
    `  ${c.dim("pooled ")} ${c.ok(`${tally("unedited")} unedited`)} · ${c.warn(`${tally("edited")} edited`)} · ` +
      `${c.bad(`${tally("rejected")} rejected`)}   ${c.dim(`n = ${n} (${CASES.length - CASES.filter((k) => k.hard).length} cases × ${rounds} rounds)`)}`,
  );
  console.log(
    `  ${c.dim(`n = ${n} is a READING, not a rate — it is too small to carry a percentage,`)}` +
      `\n  ${c.dim("and the expectations were written by the same hand as the prompt.")}`,
  );

  /**
   * ⚠ **Split by arm, because the headline mixes two different questions.**
   *
   * A correct refusal lands in `unedited` — it is the answer needing no edit —
   * so a headline of "5 of 6 unedited" over 4 expressible cases and 2 refusals
   * is arithmetic over two populations. *Did it propose well* and *did it refuse
   * when it should* fail independently and are fixed by different changes: the
   * first by the form's rules, the second by the refusal channel's wording. A
   * component that proposed badly and refused perfectly would score the same as
   * the reverse, and only one of those is safe.
   */
  const arm = (want: "propose" | "refuse", v: Verdict) =>
    headline.filter((r) => r.kase.want === want && r.verdict === v).length;
  const armN = (want: "propose" | "refuse") =>
    headline.filter((r) => r.kase.want === want).length;
  console.log(
    `\n  ${c.dim("proposing  ")} ${arm("propose", "unedited")} unedited · ` +
      `${arm("propose", "edited")} edited · ${arm("propose", "rejected")} rejected` +
      `   ${c.dim(`n = ${armN("propose")}`)}`,
  );
  console.log(
    `  ${c.dim("refusing   ")} ${arm("refuse", "unedited")} correct · ` +
      `${arm("refuse", "rejected")} proposed anyway` +
      `   ${c.dim(`n = ${armN("refuse")}`)}` +
      `\n  ${c.dim("a correct refusal needs no edit, so it lands in `unedited` — which is why")}` +
      `\n  ${c.dim("the headline above must not be read as a proposal-quality figure.")}`,
  );

  const hard = rows.filter((r) => r.kase.hard);
  if (hard.length) {
    console.log(`\n  ${c.dim("── the case the prompt does not authorise ───────────────")}`);
    for (const r of hard) {
      console.log(
        `  ${r.verdict === "unedited" ? c.ok("refused") : c.bad(r.verdict)}  ${r.kase.name}` +
          (rounds > 1 ? c.dim(`  (round ${r.round})`) : ""),
      );
      console.log(`       ${c.dim(r.kase.because ?? "")}`);
      for (const w of r.why) console.log(`       ${c.dim(w)}`);
    }
  }

  console.log(
    `\n  ${c.dim("── the readbacks, so you can disagree with the above ────")}` +
      (rounds > 1 ? `\n  ${c.dim(`(round ${rounds} only — they differ between rounds, which is the point above)`)}` : ""),
  );
  for (const r of rows) {
    if (r.round !== rounds) continue;
    if (!r.readback.length) continue;
    console.log(`  ${r.kase.name} ${c.dim(`→ ${r.name}`)}`);
    for (const line of r.readback) console.log(`       ${c.dim(line)}`);
  }

  /**
   * ⚠ The reading, stated rather than left to the reader — SC-006's own warning,
   * because the intuitive reading of a good split is the wrong one.
   */
  console.log(
    `\n  ${c.warn("⚠ this is NOT a quality score.")} ${c.dim("A high unedited count means the")}` +
      `\n  ${c.dim("proposals matched the expectations — OR that the expectations were written")}` +
      `\n  ${c.dim("by the same hand that wrote the prompt. It is never evidence that a surface")}` +
      `\n  ${c.dim("may call this reliable. What holds when a proposal IS wrong is elsewhere:")}` +
      `\n  ${c.dim("the readback above (SC-007 pins it for every join kind and filter op), the")}` +
      `\n  ${c.dim(`caveat beside the approve action (FR-025), and the ${MAX_PROPOSALS_PER_REQUEST}-per-request bound`)}` +
      `\n  ${c.dim("that stops a queue of proposals becoming a queue of clicks (FR-014).")}\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(c.bad(`the harness could not run: ${(e as Error).message}`));
  process.exit(1);
});
