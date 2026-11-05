"use client";

import { useMemo } from "react";

type Props = {
  output: Record<string, unknown> | null | undefined;
  title?: string;
};

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return value;
    }
  }
  return value;
}
function isTabularArray(v: unknown): v is Array<Record<string, unknown>> {
  return Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === "object" && e !== null && !Array.isArray(e));
}
function extractTabular(output: Record<string, unknown>): { columns: string[]; rows: Array<Record<string, unknown>> } | null {
  // Priority keys that commonly hold tabular data
  const priorityKeys = ["rows", "data", "records", "result", "items", "body", "value", "output"];
  for (const k of priorityKeys) {
    if (!(k in output)) continue;
    const parsed = tryParseJson(output[k]);
    if (isTabularArray(parsed)) {
      const cols = Array.from(new Set(parsed.flatMap((r) => Object.keys(r))));
      return { columns: cols, rows: parsed };
    }
    // columnar shape: { columns: string[], rows: [][] } or { columns: [...], rows: [{...}] }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).rows)) {
      const colsRaw = (parsed as Record<string, unknown>).columns;
      const rowsRaw = (parsed as Record<string, unknown>).rows as unknown[];
      if (Array.isArray(colsRaw) && colsRaw.every((c) => typeof c === "string")) {
        // rows could be arrays or objects
        if (rowsRaw.length > 0 && Array.isArray(rowsRaw[0])) {
          const columns = colsRaw as string[];
          const rows = (rowsRaw as unknown[][]).map((arr) => {
            const obj: Record<string, unknown> = {};
            columns.forEach((c, i) => (obj[c] = arr[i]));
            return obj;
          });
          return { columns, rows };
        }
        if (isTabularArray(rowsRaw)) {
          return { columns: colsRaw as string[], rows: rowsRaw as Array<Record<string, unknown>> };
        }
      }
      if (isTabularArray(rowsRaw)) {
        const cols = Array.from(new Set((rowsRaw as Array<Record<string, unknown>>).flatMap((r) => Object.keys(r))));
        return { columns: cols, rows: rowsRaw as Array<Record<string, unknown>> };
      }
    }
  }
  // Fallback: any array value that is tabular
  for (const v of Object.values(output)) {
    const parsed = tryParseJson(v);
    if (isTabularArray(parsed)) {
      const cols = Array.from(new Set(parsed.flatMap((r) => Object.keys(r))));
      return { columns: cols, rows: parsed };
    }
  }
  // Also check if output itself looks like tabular wrapped as { columns, rows } at top level
  if (Array.isArray((output as Record<string, unknown>).columns) && Array.isArray((output as Record<string, unknown>).rows)) {
    const colsRaw = (output as Record<string, unknown>).columns as unknown[];
    const rowsRaw = (output as Record<string, unknown>).rows as unknown[];
    if (colsRaw.every((c) => typeof c === "string")) {
      if (rowsRaw.length > 0 && Array.isArray(rowsRaw[0])) {
        const columns = colsRaw as string[];
        const rows = (rowsRaw as unknown[][]).map((arr) => {
          const obj: Record<string, unknown> = {};
          columns.forEach((c, i) => (obj[c] = arr[i]));
          return obj;
        });
        return { columns, rows };
      }
    }
  }
  // Check if output itself is a tabular array disguised as Record with numeric keys? unlikely
  return null;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function RunOutput({ output, title }: Props) {
  const tabular = useMemo(() => {
    if (!output) return null;
    return extractTabular(output);
  }, [output]);

  if (!output) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface-2 px-4 py-6 text-center text-sm text-muted">
        No output was retained for this step.
      </div>
    );
  }

  if (tabular && tabular.rows.length > 0) {
    const displayRows = tabular.rows.slice(0, 100);
    const truncated = tabular.rows.length > 100;
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {title && (
          <div className="border-b border-line px-4 py-2">
            <h4 className="text-xs font-semibold uppercase tracking-label text-muted">{title}</h4>
          </div>
        )}
        <div className="overflow-auto">
          <table className="w-full text-left text-xs" data-testid="run-output-table">
            <thead className="bg-surface-2">
              <tr>
                {tabular.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2 font-semibold text-text">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {displayRows.map((row, i) => (
                <tr key={i} className="hover:bg-surface-2/50">
                  {tabular.columns.map((c) => (
                    <td key={c} className="max-w-[240px] truncate px-3 py-1.5 font-mono text-text" title={formatCell(row[c])}>
                      {formatCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-line bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <span>
            {tabular.rows.length === 1 ? "1 row" : `${tabular.rows.length} rows`}
            {truncated ? " · showing first 100" : ""}
          </span>
          <span className="font-mono">{tabular.columns.length} columns</span>
        </div>
      </div>
    );
  }

  // Non-tabular or empty tabular -> clean JSON
  let pretty: string;
  try {
    // If body/value is a JSON string, pretty-print that instead of the envelope
    const bodyCandidate = output.body ?? output.value;
    if (typeof bodyCandidate === "string") {
      const parsed = tryParseJson(bodyCandidate);
      if (parsed !== bodyCandidate) {
        pretty = JSON.stringify(parsed, null, 2);
      } else {
        pretty = JSON.stringify(output, null, 2);
      }
    } else {
      pretty = JSON.stringify(output, null, 2);
    }
  } catch {
    pretty = String(output);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {title && (
        <div className="border-b border-line px-4 py-2">
          <h4 className="text-xs font-semibold uppercase tracking-label text-muted">{title}</h4>
        </div>
      )}
      <pre
        data-testid="run-output-json"
        className="max-h-[480px] overflow-auto bg-surface p-3 font-mono text-xs text-text"
      >
        {pretty}
      </pre>
    </div>
  );
}

export default RunOutput;
