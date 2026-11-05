/**
 * A workflow that compares the workspace's TABLES with one of its FILES cannot be judged on test data (2026-11-03).
 *
 * A test run reads mock rows invented from each table's shape (`mock_employee_id_007`), while a workspace File is the
 * real one. So a step matching table rows against a File — employees against a headcount sheet — keeps nothing on test
 * data however right it is (chat eb205c03). An empty result there is expected; the test that means something is one on
 * real data. A workflow that reads tables only stays consistent on test data: the mock rows agree with each other.
 *
 * Pure: workflow in, the File names it compares against out.
 */

type Json = unknown;

function usesOf(v: Json, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) usesOf(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.uses)) for (const u of o.uses) if (typeof u === "string") out.push(u);
    for (const x of Object.values(o)) if (x && typeof x === "object") usesOf(x, out);
  }
  return out;
}

/** The workspace Files a workflow reads beside its tables; [] when it reads only one kind. */
export function filesBesideTables(workflow: Json): string[] {
  const uses = usesOf((workflow as { steps?: unknown } | null)?.steps);
  if (!uses.some((u) => u.startsWith("read:"))) return [];
  return [...new Set(uses.filter((u) => u.startsWith("file:")).map((u) => u.slice("file:".length)))];
}

/**
 * The red banner after an empty test run of a workflow that matches tables against a File (2026-11-03).
 * On test data that result says nothing, so it is inconclusive, not failed.
 */
export function inconclusiveSummary(files: string[]): string {
  return `Inconclusive on test data: this workflow compares its tables with ${files.map((f) => `"${f}"`).join(", ")}, which invented test rows cannot match. Test it on real data.`;
}

/**
 * The reads that came back with 0 rows, named in a failed step's error text (2026-11-03).
 * The runner writes them as `0 row(s) from read NAME`. Deduped, in order of appearance.
 */
export function emptyReadsOf(steps: { status: string; error: string | null }[]): string[] {
  const out = new Set<string>();
  for (const st of steps) {
    if (st.status !== "failed" || !st.error) continue;
    for (const m of st.error.matchAll(/(\d+) row\(s\) from read ([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)) {
      if (Number(m[1]) === 0) out.add(m[2]);
    }
  }
  return [...out];
}

/**
 * Outputs a workflow declared `allow_empty` that came back empty in a run that succeeded, as "step.output".
 * On invented data that proves nothing: the step may have sent nothing only because the rows were invented.
 */
export function allowedEmptyOutputs(
  workflow: unknown,
  steps: { stepId: string; status: string; outputJson: unknown; scope?: string }[],
): string[] {
  const list = (workflow as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(list)) return [];
  const empty = (v: unknown) =>
    v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
  const out: string[] = [];
  for (const st of list as { id?: string; allow_empty?: { output?: string }[] }[]) {
    if (!st || !st.id || !Array.isArray(st.allow_empty)) continue;
    const res = steps.find((r) => r.stepId === st.id && r.status === "succeeded" && (r.scope ?? "") === "");
    if (!res) continue;
    const json = res.outputJson && typeof res.outputJson === "object" ? (res.outputJson as Record<string, unknown>) : {};
    for (const a of st.allow_empty) {
      if (a?.output && empty(json[a.output])) out.push(`${st.id}.${a.output}`);
    }
  }
  return out;
}

/**
 * Whether an empty test on invented data needs a real-data test instead (2026-11-03).
 * "no-rows": a read found nothing for these values. "files": tables compared with a File. Otherwise null.
 */
export function realDataVerdict(input: {
  realData: boolean;
  emptyData: boolean;
  emptyReads: string[];
  files: string[];
  inputs: Record<string, unknown>;
}): { kind: "no-rows" | "files"; summary: string } | null {
  if (input.realData || !input.emptyData) return null;
  if (input.emptyReads.length) {
    const values = Object.entries(input.inputs).map(([k, v]) => `${k} = ${String(v)}`).join(", ");
    return {
      kind: "no-rows",
      summary:
        `The test data has no rows from ${input.emptyReads.join(", ")}${values ? ` for ${values}` : ""}. ` +
        `Test data is invented and only covers some dates and values, so this test cannot judge the workflow. Run the test on real data (an admin can start it).`,
    };
  }
  if (input.files.length) return { kind: "files", summary: inconclusiveSummary(input.files) };
  return null;
}

export type TableSize = { datasource: string; name: string; rows: number | null };

/**
 * The tables at or above `threshold` rows that a workflow read through SQL, largest first. A test can pass on 10
 * invented rows while production holds 100,000+, so these are the reads a test cannot vouch for.
 * A table counts when a read on its datasource names it as a whole identifier, case-insensitively.
 */
export function largeTablesRead(reads: unknown, tables: TableSize[], threshold = 50_000): { name: string; rows: number }[] {
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) return [];
  const sqls: { datasource: string; sql: string }[] = [];
  for (const read of Object.values(reads as Record<string, unknown>)) {
    if (!read || typeof read !== "object") continue;
    const r = read as Record<string, unknown>;
    if (typeof r.datasource === "string" && typeof r.sql === "string") sqls.push({ datasource: r.datasource, sql: r.sql });
  }
  const best = new Map<string, number>();
  for (const t of tables) {
    if (typeof t.rows !== "number" || t.rows < threshold) continue;
    const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "i");
    if (!sqls.some((s) => s.datasource === t.datasource && re.test(s.sql))) continue;
    best.set(t.name, Math.max(best.get(t.name) ?? 0, t.rows));
  }
  return [...best].map(([name, rows]) => ({ name, rows })).sort((a, b) => b.rows - a.rows);
}
