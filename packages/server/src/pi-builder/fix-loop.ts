/**
 * The automatic fix loop's pure pieces: the prompt a fix turn is told, and when another round is pointless.
 * Pure: values in, values out.
 */

/** The prompt for an automatic fix turn: the failure verbatim (I-57: never paraphrase a finding). */
export function fixPrompt(detail: string): string {
  return [
    "Tether checked and test-ran the workflow, and it did not pass. The result, verbatim:",
    "",
    detail,
    "",
    "Fix exactly what failed and change nothing else. Do not ask the person; this is your own work to correct.",
    "Keep every source the goal names — its tables, its Files, its tools. Never swap one for another to get past the test. If the failure cannot be fixed without that, change nothing and say why in one sentence.",
  ].join("\n");
}

/** A fix round failed exactly as the round before it: another round is the model arguing with the same check. */
export function noProgress(previous: string | null, now: string | null): boolean {
  if (!previous?.trim() || !now?.trim()) return false;
  return previous.trim() === now.trim();
}

/** 2026-11-03: where a test result goes. A run that could not start is an outage, not a fault in the workflow: never Forge's to fix. */
export type FailureRoute = "ready" | "person" | "outage" | "forge";
export function routeFailure(run: { ok: boolean; emptyData: boolean; infra: boolean }): FailureRoute {
  if (run.ok) return "ready";
  if (run.infra) return "outage";
  if (run.emptyData) return "person";
  return "forge";
}

const SOURCE = /^(read|file|tool):/;
function sourcesOf(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const x of node) sourcesOf(x, into);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "uses") {
        for (const u of Array.isArray(v) ? v : [v]) if (typeof u === "string" && SOURCE.test(u)) into.add(u);
      }
      sourcesOf(v, into);
    }
  }
  return into;
}
/** 2026-11-03: the sources (read:, file:, tool:) a workflow used before a fix and uses nowhere after it. Moving one between steps is not dropping it. */
export function droppedSources(before: unknown, after: unknown): string[] {
  const now = sourcesOf(after, new Set());
  return [...sourcesOf(before, new Set())].filter((u) => !now.has(u));
}

/** `file:Headcount.xlsx` -> `file "Headcount.xlsx"`, joined with ", ". */
export function sourceList(entries: string[]): string {
  return entries.map((u) => { const i = u.indexOf(":"); return `${u.slice(0, i)} "${u.slice(i + 1)}"`; }).join(", ");
}
