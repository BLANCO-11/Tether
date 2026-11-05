/**
 * Structured workflow output → a file the Email tool can attach: CSV or Excel.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Before it, a flow that wanted its rows as a file had to hand-write a `code`
 * step producing CSV text (`.csv_text` + `.filename`) and hope it read
 * `outputs.<id>.vars.result` one level deep enough — the miss that once sent
 * `attachments: [{}]` (flow-output-shape.ts, measured 2026-09-28). The rows
 * are already structured JSON when they reach the mail route; converting them
 * here keeps the format rules in one server-side place instead of in every
 * flow's jq.
 *
 * ── The two formats are built from ONE flattening ──────────────────────────
 *
 * `columnsOf` is the union of every row's keys in first-seen order, so CSV and
 * XLSX of the same rows carry the same columns in the same order. Cells:
 * strings/numbers/booleans pass through, null/undefined become empty (the same
 * thing Kestra's rendering does with a null key — an absent cell reads as
 * empty, never as the text "null"), and any nested structure is JSON — a cell
 * that says what it held beats a cell that says `[object Object]`.
 *
 * ⚠ **CSV is RFC 4180**: CRLF between records, quotes around anything holding
 * a quote, comma or line break, doubled quotes inside. Excel, Numbers and
 * `Papa.parse` all accept exactly that and nothing looser survives all three.
 *
 * ⚠ **No formula escaping, deliberately.** A cell beginning `=` is kept as
 * built. The text-attachment path (`mail-attachments.ts`) already accepts a
 * CSV a code step built, verbatim; neutralising `=` only here would make the
 * generated file differ from the hand-built one for the same rows, and the data
 * comes from the workspace's own databases either way.
 */

import { utils, write } from "xlsx";

/** One record of structured output — a row of `outputs.<step>.vars.result.results`, say. */
export type Row = Record<string, unknown>;

/** The built file: bytes for the transport, text when the format is text. */
export type BuiltFile = {
  /** The file's text for CSV; `null` for the binary XLSX. */
  text: string | null;
  /** The file's bytes — what `mail.service.ts` base64-encodes for Graph. */
  data: Buffer;
  /** Byte length of `data`. */
  bytes: number;
};

export type BuildCheck =
  | { ok: true; file: BuiltFile }
  | { ok: false; message: string; detail: Record<string, unknown> };

/**
 * A generated file's row ceiling. The attachment BYTES cap is the real bound
 * (mail-attachments.ts), but a refusal must arrive before the build, not
 * after a workbook write of a quarter-million rows — and a flow that needs
 * more rows than this is exporting a table, not reporting on one.
 */
export const MAX_GENERATED_ROWS = 50_000;

/** Columns are the union of every row's keys, in first-seen order. */
function columnsOf(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/** Flatten one cell — see the module header for the rules. */
function cell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  try {
    const json = JSON.stringify(value);
    // `undefined` from a replacer, or a cycle from a non-route caller.
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** RFC 4180 field: quote when the value holds a quote, comma or line break. */
function csvCell(value: string | number | boolean): string {
  const s = typeof value === "string" ? value : String(value);
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → RFC 4180 CSV text: a header record, one record per row, CRLF, trailing CRLF. */
export function rowsToCsv(rows: readonly Row[]): string {
  const columns = columnsOf(rows);
  const lines = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((c) => csvCell(cell(row[c]))).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** Rows → a one-sheet `.xlsx` workbook (same columns, same order, as the CSV). */
export function rowsToXlsx(rows: readonly Row[]): Buffer {
  const columns = columnsOf(rows);
  const aoa: Array<Array<string | number | boolean>> = [
    columns,
    ...rows.map((row) => columns.map((c) => cell(row[c]))),
  ];
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(aoa), "Sheet1");
  return write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Build a generated attachment, refusing by name rather than throwing — the
 * caller turns a refusal straight into the route's 422.
 */
export function buildRowsFile(format: "csv" | "xlsx", rows: readonly Row[]): BuildCheck {
  if (rows.length === 0) {
    return {
      ok: false,
      message: "attachment is empty",
      detail: { format, rule: "rows holds at least one record — an empty file reads as a report of nothing" },
    };
  }
  if (rows.length > MAX_GENERATED_ROWS) {
    return {
      ok: false,
      message: "too many rows to generate a file",
      detail: { actual: rows.length, allowed: MAX_GENERATED_ROWS, format },
    };
  }
  if (columnsOf(rows).length === 0) {
    return {
      ok: false,
      message: "attachment has no columns",
      detail: { format, rule: "every row is an empty object — there is nothing to write" },
    };
  }
  try {
    if (format === "csv") {
      const text = rowsToCsv(rows);
      const data = Buffer.from(text, "utf8");
      return { ok: true, file: { text, data, bytes: data.byteLength } };
    }
    const data = rowsToXlsx(rows);
    return { ok: true, file: { text: null, data, bytes: data.byteLength } };
  } catch (err) {
    return {
      ok: false,
      message: `could not generate the ${format.toUpperCase()} file`,
      detail: { format, reason: err instanceof Error ? err.message : String(err) },
    };
  }
}
