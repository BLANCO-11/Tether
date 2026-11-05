/**
 * Read dry-run (Strategy B Phase 3): execute compiled SQL with LIMIT, return
 * redacted shape (row count + column names) — never sample cell values into
 * prompts. Executor is injected so unit tests need no database.
 */
import { intentIrEnabled } from "./intent-ir.js";

export interface DryRunResult {
  ok: boolean;
  rowCount: number;
  columns: string[];
  /** Human preview line — no row payloads. */
  preview: string;
  error?: string;
}

export type DryRunExecutor = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const DEFAULT_LIMIT = 5;

/** Ensure SQL has a small LIMIT for preview (append if absent). */
export function withPreviewLimit(sql: string, limit = DEFAULT_LIMIT): string {
  if (/\blimit\s+\d+/i.test(sql)) return sql;
  return `${sql.replace(/;\s*$/, "")} LIMIT ${limit}`;
}

/**
 * Run a dry-run. On success, `preview` is like "will read ~N rows (cols: a, b)".
 * Cell values are discarded after counting.
 */
export async function dryRunRead(
  sql: string,
  params: unknown[],
  exec: DryRunExecutor,
  opts: { limit?: number; label?: string } = {},
): Promise<DryRunResult> {
  const limited = withPreviewLimit(sql, opts.limit ?? DEFAULT_LIMIT);
  const label = opts.label ?? "the read";
  try {
    const { rows } = await exec(limited, params);
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    const rowCount = rows.length;
    // Do not include any cell values in preview.
    const preview =
      rowCount === 0
        ? `${label}: 0 rows in preview — confirm the filter`
        : `${label}: ~${rowCount} row(s) in preview (columns: ${columns.slice(0, 12).join(", ") || "—"})`;
    return { ok: true, rowCount, columns, preview };
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    return { ok: false, rowCount: 0, columns: [], preview: `${label}: dry-run failed — ${error}`, error };
  }
}

/** Build preview lines for several reads. */
export function previewLines(results: DryRunResult[]): string[] {
  return results.map((r) => r.preview);
}

/**
 * Strategy B Phase 3: optional dry-run after reads compile. Caller supplies a
 * read-only executor (sandbox/fixture). No-op when BUILDER_INTENT_IR is off.
 */
export async function previewCompiledReads(
  reads: Array<{ label: string; sql: string; params?: unknown[] }>,
  exec: DryRunExecutor,
): Promise<DryRunResult[]> {
  if (!intentIrEnabled()) return [];
  const out: DryRunResult[] = [];
  for (const r of reads) out.push(await dryRunRead(r.sql, r.params ?? [], exec, { label: r.label }));
  return out;
}
