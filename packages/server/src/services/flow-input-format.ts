/**
 * What kind of control a declared flow input deserves — derived, never guessed
 * from its name.
 *
 * ── The report ───────────────────────────────────────────────────────────────
 *
 * *"the period value should be settable using UI only, nothing manually text
 * input should be there for things like this."* Every declared input on
 * `/triggers` rendered the same free text box, so a month, a timestamp, a count
 * and a flag were four identical fields, and the only thing standing between a
 * person and `2026-6` — or `2026-06-31`, which is D-205's own failing run — was
 * their typing.
 *
 * ── ⚠ THE DECLARED TYPE IS NOT ENOUGH, AND THAT IS MEASURED ─────────────────
 *
 * Read off this deployment's own revisions: `as_of` is `DATETIME` in one flow
 * and `STRING` in three, two of those carrying an ISO timestamp as their
 * default. So a control chosen from `type` alone hands a text box to three of
 * the four timestamps in the product. The type is a declaration and is trusted
 * where it is specific; `STRING` is what the drafter emits when it has not
 * decided, and it means *keep looking*.
 *
 * ── ⚠ NOT FROM THE NAME ─────────────────────────────────────────────────────
 *
 * `period` → month is exactly the inference this repo refuses elsewhere:
 * deriving meaning from a field name is I-121's failure, where `url` is a
 * credential for a Slack webhook and not for an HTTP call. An input called
 * `period` may be a fiscal quarter, a free-text label or a number of days. So
 * the second source of evidence is **how the flow already uses it**:
 *
 *     "period_end": "{{ inputs.period }}-31"
 *
 * A day pasted onto a template can only mean the template renders `YYYY-MM` —
 * that is the same reading `checkConstructedDates` makes to call the expression
 * a bug, applied here to learn what the input IS. The flow saying so is
 * evidence; the word "period" is a coincidence that usually holds.
 *
 * ⚠ The two readings must stay in agreement about the pattern, and there is a
 * test asserting that the expression D-205 fires on is the expression this reads
 * a month out of. They are deliberately separate functions — one reports a
 * defect, one chooses a widget, and merging them would make a rendering decision
 * a place where a finding can be lost.
 *
 * ── ⚠ WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 *
 * It chooses a control. It does not validate, coerce or reject a value: the
 * stored value is whatever it already was, and the CLIENT falls back to a text
 * box when the value it holds does not fit the control this names. A picker that
 * silently blanks an override it could not parse would destroy a real setting to
 * make a widget look tidy.
 */

import { EXPRESSION_FIELDS } from "./flow-expression.service.js";

/** The controls a client can offer. `text` is the honest fallback, not a failure. */
export type FlowInputFormat = "month" | "date" | "datetime" | "number" | "boolean" | "text";

/** `2026-06` */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `2026-06-29` */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `2026-06-29T10:00:00Z`, `2026-09-04T11:21:39.237Z`, and the offset forms. */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const BOOLEAN_RE = /^(true|false)$/i;

/**
 * A day (and optionally a month) pasted onto a template that renders THIS input.
 * `{{ inputs.period }}-31` ⇒ `period` is a month. The id is escaped because an
 * input id is a caller's string, and a `.` in it would otherwise match anything.
 */
function usedAsMonthPrefix(id: string, steps: Array<Record<string, unknown>>): boolean {
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\{\\{[^{}]*\\binputs\\.${safe}\\b[^{}]*\\}\\}-\\d{2}`);
  for (const step of steps) {
    for (const field of EXPRESSION_FIELDS) {
      const v = step[field];
      if (typeof v === "string" && re.test(v)) return true;
    }
  }
  return false;
}

/** The shape of a value we can actually see — the weakest evidence, used last. */
function formatOfValue(value: string | null | undefined): FlowInputFormat | null {
  if (typeof value !== "string" || value === "") return null;
  if (MONTH_RE.test(value)) return "month";
  if (DATE_RE.test(value)) return "date";
  if (DATETIME_RE.test(value)) return "datetime";
  if (NUMBER_RE.test(value)) return "number";
  if (BOOLEAN_RE.test(value)) return "boolean";
  return null;
}

/**
 * ⚠ Ordered by how much the source KNOWS, strongest first: a declaration, then
 * what the flow does with it, then what the value looks like. A value-shape
 * reading first would let one `2026-06` default turn a genuinely free-text input
 * into a month picker for ever.
 */
export function flowInputFormat(
  input: { id: string; type?: string; format?: string },
  steps: Array<Record<string, unknown>>,
  value?: string | null,
): FlowInputFormat {
  // A DECLARED shape wins (phase 5, D-255) — the same fact the run routes
  // enforce, so the form and the refusal cannot disagree.
  if (input.format === "month") return "month";
  switch ((input.type ?? "").toUpperCase()) {
    case "DATE":
      return "date";
    case "DATETIME":
      return "datetime";
    case "INT":
    case "FLOAT":
      return "number";
    case "BOOLEAN":
      return "boolean";
  }
  if (usedAsMonthPrefix(input.id, steps)) return "month";
  return formatOfValue(value) ?? "text";
}
