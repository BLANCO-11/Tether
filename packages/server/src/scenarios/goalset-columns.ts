/**
 * Offline column-read check for goalset rows (compiled-builder phase 0, I-275).
 *
 * A green run is not a correct run: a transform that reads a column its reader never returns
 * reads null, and `// 0` turns that into a plausible wrong answer. For each built model, runs
 * the PRODUCT'S own `checkRefOutputFields` (stage-aware, the one definition, D-249) against
 * the readers' real columns — named queries from `\gdesc`, operations from their spec —
 * which the product itself cannot see for named queries (they are `Rows<Json>`, I-271).
 *
 * PURE apart from reading two JSON files: no database, no gateway. Safe to import.
 */
import { checkRefOutputFields } from "../services/flow-ref-columns.js";
import type { FlowModel } from "../services/flow-compiler.service.js";

export type ReaderColumns = Record<string, string[]>;

export function missingColumnReads(model: unknown, columns: ReaderColumns): string[] {
  const interfaces = Object.fromEntries(Object.entries(columns).map(([ref, c]) => [ref, { columns: c }]));
  return checkRefOutputFields(model as FlowModel, interfaces).map((f) => (typeof f === "string" ? f : JSON.stringify(f)));
}
