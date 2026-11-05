/**
 * Prove-before-cover — shared helpers for workflow-wide builder intelligence.
 *
 * A clause is covered only when a built artifact's evidence (aliases, ports, …)
 * actually implements it. Banded reads are the first consumer; sinks/schedule
 * reuse the same shapes with different evidence.
 */
import { factName } from "./plan.js";

/** Arm shape for prove helpers — only `then` is required; callers may pass plan BandArm or looser readNeed arms. */
type ArmLike = { then: number; words?: string; test?: string; value?: string };


/** True when the next contract (incl. projection) differs — rewrite required. */
export function shouldRewrite(prev: unknown, next: unknown): boolean {
  return JSON.stringify(prev) !== JSON.stringify(next);
}

/**
 * Clauses whose evidence tokens appear in `aliases` (or generic `tokens`).
 * Generic substring match only: a clause is proven when one of its own words
 * appears in the evidence blob. No label/edge carve-outs.
 */
export function clausesProvenBy(
  clauses: readonly string[],
  evidence: { aliases?: readonly string[]; tokens?: readonly string[] },
): string[] {
  const blob = [...(evidence.aliases ?? []), ...(evidence.tokens ?? [])].map((a) => a.toLowerCase()).join(" ");
  if (!blob.trim()) return [];
  return clauses.filter((quote) => {
    const words = quote.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return words.length > 0 && words.some((w) => blob.includes(w));
  });
}

/**
 * Column contract line for the propose need — names the outputs the person asked
 * for. Columns come from the typed inputs only: the group-by fields, the
 * measure words the model itself wrote, and extra columns the caller passes.
 * No labels mined from the goal's words.
 */
export function bandReturnContract(
  texts: readonly string[],
  measures: Array<{ words: string; bands?: readonly ArmLike[] }>,
  groupBy: Array<{ field: string; words: string }> = [],
  extraCols: readonly string[] = [],
): string {
  void texts;
  const keys = groupBy
    .map((g) => {
      const col = g.field.split(".").filter(Boolean).at(-1) ?? g.field;
      if (!col || col === "new_read" || col === "any") return null;
      return col;
    })
    .filter((x): x is string => !!x);
  const asked = extraCols.map((c) => c.replace(/\s+/g, "_").replace(/_+/g, "_"));
  const cols = [...new Set([...keys, ...asked, ...measures.map((m) => factName(m.words) || m.words)])];
  return `Return these columns (one per asked output): ${cols.join(", ")}. Each banded measure is its own column — never one indicator that collapses several.`;
}
