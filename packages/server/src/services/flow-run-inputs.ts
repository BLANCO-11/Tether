/**
 * One rule for a run's supplied inputs, used by every route that starts a run
 * (phase 5 task 4, D-255): trigger fire (`validateFireInputs`) and `test-run`.
 *
 * Moved here from `trigger.service.ts` so `flow.service.ts` can use it without
 * a cycle. Two things changed on the way, both measured:
 *
 *  - ⚠ **DATE/DATETIME used to accept anything `new Date()` parses** —
 *    `01/08/2026` and `2026/08` included, which Kestra then refuses (or worse,
 *    reads as another day). Now DATE is `YYYY-MM-DD` and DATETIME is ISO.
 *  - **A `month` STRING must be `YYYY-MM`** — the history holds
 *    `period must be YYYY-MM, got "01/08/2026"`, `"2026/08"`, `"2026-06-30"`.
 *
 * The refusal names the input, the shape and what arrived, before any
 * execution, run request or fire row exists.
 */
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATETIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface DeclaredRunInput {
  id: string;
  type: string;
  format?: string;
}

/** The value normalised to the string the execution path sends, or null. */
export function coerceTypedInput(type: string, raw: unknown, format?: string): string | null {
  switch (type) {
    case "STRING": {
      const s = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
      if (s === null) return null;
      return format === "month" && !MONTH.test(s.trim()) ? null : s;
    }
    case "INT": {
      if (typeof raw === "string" && raw.trim() === "") return null;
      const n = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw.trim() : NaN);
      return Number.isInteger(n) ? String(n) : null;
    }
    case "FLOAT": {
      if (typeof raw === "string" && raw.trim() === "") return null;
      const n = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw.trim() : NaN);
      return Number.isFinite(n) ? String(n) : null;
    }
    case "BOOLEAN":
      if (raw === true || raw === "true") return "true";
      if (raw === false || raw === "false") return "false";
      return null;
    case "DATE":
    case "DATETIME": {
      if (typeof raw !== "string") return null;
      if (!(type === "DATE" ? DATE : DATETIME).test(raw.trim())) return null;
      // The original string is passed through — Kestra owns the exact grammar.
      return Number.isNaN(new Date(raw).getTime()) ? null : raw;
    }
    default:
      return null;
  }
}

/** What a person should have typed, in words. */
export function expectedShape(d: DeclaredRunInput): string {
  if (d.type === "STRING") return d.format === "month" ? "a month (YYYY-MM)" : "text";
  if (d.type === "DATE") return "a date (YYYY-MM-DD)";
  if (d.type === "DATETIME") return "a date and time (ISO, e.g. 2026-06-30T12:00:00Z)";
  if (d.type === "INT") return "a whole number";
  if (d.type === "FLOAT") return "a number";
  if (d.type === "BOOLEAN") return "true or false";
  return d.type;
}

/** Every supplied value that does not fit its declaration. Undeclared ids too. */
export function checkRunInputs(
  declared: ReadonlyArray<DeclaredRunInput>,
  supplied: Record<string, unknown>,
): Array<{ input: string; message: string }> {
  const byId = new Map(declared.map((d) => [d.id, d]));
  const issues: Array<{ input: string; message: string }> = [];
  for (const [id, raw] of Object.entries(supplied)) {
    const d = byId.get(id);
    if (!d) {
      issues.push({ input: id, message: `input "${id}" is not declared by this flow` });
      continue;
    }
    if (raw === undefined || raw === null) continue;
    if (coerceTypedInput(d.type, raw, d.format) === null) {
      issues.push({ input: id, message: `input "${id}" must be ${expectedShape(d)}, got ${JSON.stringify(raw)}` });
    }
  }
  return issues;
}
