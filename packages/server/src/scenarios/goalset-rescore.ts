/**
 * Offline rescore of a `goalset:measure` build pass (compiled-builder phase 0). No database, no gateway.
 *
 *   tsx src/scenarios/goalset-rescore.ts --rows=rows.json --goals=a.json,b.json --columns=reader-columns.json
 *       [--rerun=rerun-rows.json] [--false-positive=R02#1:prepare_weekly_summary,…] [--v2=D20,R08:builds,…] --out=score.json
 *
 * Reports SEPARATE numbers, because one strict pass rate hides which half failed:
 *   - `strict`      the frozen labels, questions and build together (`goalset-score`)
 *   - `build`       right outcome · green run · no read of a column the reader never returns (I-275)
 *   - `questions`   no redundant / unneeded / loop / silent-guess
 * and, when `--v2` is given, the same three under the corrected labels, marked POST-HOC in the output.
 *
 * `--rerun` rows replace the same (id, round) rows from `--rows`; every replacement is listed in the output.
 * `--false-positive` marks a column finding a person adjudicated as wrong (I-276), listed in the output too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { scoreBuild, type Goal, type Observation, type Score } from "./goalset-score.js";
import { missingColumnReads, type ReaderColumns } from "./goalset-columns.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const list = (k: string) => (arg(k) ?? "").split(",").filter(Boolean);

const QUESTION_KINDS = new Set(["redundant_question", "unneeded_question", "loop", "silent_guess", "unmatched_question"]);
const GREEN = new Set(["SUCCESS", "PAUSED"]);

type Row = {
  id: string; round: number; outcomeLabel: string; status?: string; run?: string; runError?: string; harness?: string;
  questions: Array<{ question: string; slot: string | null }>; refs?: string[]; model?: unknown;
};

function observe(r: Row): Observation {
  return { status: r.status ?? "harness", questions: r.questions.map((q) => ({ text: q.question, slot: q.slot })), refusedFor: [], refs: r.refs, run: r.run };
}

function halves(g: Goal, r: Row, colFindings: string[]) {
  const s: Score = scoreBuild(g, observe(r));
  const q = s.failures.filter((f) => QUESTION_KINDS.has(f.kind));
  const b = s.failures.filter((f) => !QUESTION_KINDS.has(f.kind));
  // A missing-column read is a build failure only where a flow was built and ran.
  const col = r.status === "ok" ? colFindings : [];
  const build = b.length === 0 && col.length === 0;
  return { strict: s.pass && col.length === 0, build, questions: q.length === 0, failures: [...s.failures.map((f) => `${f.kind}(${f.detail.slice(0, 80)})`), ...col.map((c) => `reads_missing_column(${c.slice(0, 120)})`)] };
}

function main() {
  const goals: Goal[] = list("goals").flatMap((p) => JSON.parse(readFileSync(p, "utf8")));
  const byId = new Map(goals.map((g) => [g.id, g]));
  const columns: ReaderColumns = JSON.parse(readFileSync(arg("columns")!, "utf8"));
  let rows: Row[] = JSON.parse(readFileSync(arg("rows")!, "utf8")).rows;
  const replaced: string[] = [];
  if (arg("rerun")) {
    for (const rr of JSON.parse(readFileSync(arg("rerun")!, "utf8")).rows as Row[]) {
      const i = rows.findIndex((r) => r.id === rr.id && r.round === rr.round);
      if (i >= 0) { replaced.push(`${rr.id}#${rr.round}: was ${rows[i]!.run ?? rows[i]!.status} (${(rows[i]!.runError ?? "").slice(0, 80)})`); rows[i] = rr; }
    }
  }
  const fp = new Set(list("false-positive")); // `ID#round:stepId`
  const v2 = new Map(list("v2").map((e) => { const [id, o] = e.split(":"); return [id!, o as Goal["label"]["outcome"]]; }));

  const scored = rows.filter((r) => !r.harness && byId.has(r.id));
  const excluded = rows.filter((r) => r.harness).map((r) => `${r.id}#${r.round}: ${r.harness}`);
  const perRow = scored.map((r) => {
    const g = byId.get(r.id)!;
    const cols = r.model ? missingColumnReads(r.model, columns) : [];
    const kept = cols.filter((c) => { try { return !fp.has(`${r.id}#${r.round}:${JSON.parse(c).stepId}`); } catch { return true; } });
    const v1 = halves(g, r, kept);
    // v2: the named-reader check is dropped for EVERY goal (reader lists were too narrow, and meaningless
    // schema-only, D-311). The missing-column check stands in for "read the wrong data".
    const g2: Goal = { ...g, label: { ...g.label, outcome: v2.get(r.id) ?? g.label.outcome, expect: { ...g.label.expect, readers: [] } } };
    const s2 = v2.size ? halves(g2, r, kept) : v1;
    return { id: r.id, round: r.round, label: g.label.outcome, status: r.status, run: r.run, v1, v2: s2, runGreen: GREEN.has(r.run ?? ""), columnFindings: cols.length, columnFindingsKept: kept.length };
  });

  const rate = (xs: boolean[]) => `${xs.filter(Boolean).length}/${xs.length}`;
  const block = (k: "v1" | "v2") => ({
    strict: rate(perRow.map((r) => r[k].strict)),
    build: rate(perRow.map((r) => r[k].build)),
    questions: rate(perRow.map((r) => r[k].questions)),
    buildByLabel: Object.fromEntries(["builds", "asks", "cannot"].map((o) => [o, rate(perRow.filter((r) => (k === "v2" && v2.has(r.id) ? v2.get(r.id) : r.label) === o).map((r) => r[k].build))])),
  });
  const failureTally = perRow.flatMap((r) => r.v1.failures.map((f) => f.replace(/\(.*$/, ""))).reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
  const out = {
    rows: rows.length, scored: scored.length, excluded, replaced, falsePositives: [...fp],
    v1: block("v1"),
    ...(v2.size ? { v2: { POST_HOC: "labels changed after seeing results (LABEL-DOUBTS.md); pending the user's review", readerNameCheck: "dropped for all goals", changed: [...v2].map(([k, v]) => `${k}→${v}`), ...block("v2") } } : {}),
    greenRunsWithMissingColumnReads: perRow.filter((r) => r.runGreen && r.columnFindingsKept > 0).map((r) => `${r.id}#${r.round}`),
    failureTally,
    perRow,
  };
  const { perRow: _p, ...head } = out;
  console.log(JSON.stringify(head, null, 1));
  writeFileSync(arg("out")!, JSON.stringify(out, null, 1));
}
main();
