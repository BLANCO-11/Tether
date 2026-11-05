/**
 * A date that cannot exist — caught before the database refuses it.
 * `specs/20260827-053157-proposed-db-operations/` P6 · I-118 · D-205
 *
 * ── The failure, from a real run ─────────────────────────────────────────────
 *
 * A drafted flow read a proposed DB operation whose `period_start`/`period_end`
 * filters are `type: date`. The person gave it a MONTH — `{"period": "2026-06"}`
 * — and the drafter bound the end of the range by pasting a day onto it:
 *
 *     "period_end": "{{ inputs.period }}-31"
 *
 * June has 30 days. Postgres refused the whole read, the step answered 502, and
 * Kestra execution `7cwL1ris` failed 0.4 s in with:
 *
 *     date/time field value out of range: "2026-06-31"
 *
 * ⚠ **The literal `2026-06-31` appears NOWHERE in the flow.** It is produced at
 * render time from a template and a two-character suffix, which is why this is a
 * check over the EXPRESSION rather than a validation of a value: by the time the
 * bad date exists, the only thing left to do with it is fail.
 *
 * ── Why the expression cannot be fixed in place ──────────────────────────────
 *
 * `ALLOWED_CALLS` is `{json, jq, first, length, toJson}` (`toJson` since 2026-09-26: it serialises, it computes nothing). There is no date function, no
 * date filter, and no arithmetic — so *"the last day of the month a person named"*
 * is genuinely not expressible here, and a model that needs one has no correct
 * way to write it. That is what makes this a teachable rule with exactly two
 * remedies rather than a style preference: declare the input AS a date and pass
 * it through, or compute the range in a `code` step. The finding says both, for
 * the reason `checkBulkToolInput`'s docblock records — a finding that names one
 * of two remedies moves the model to whichever it named.
 *
 * ⚠ **The rule half lives in `EXPRESSION_RULES`** and reaches all three prompts
 * (draft, refine, chat) from one definition. I-118 is why both halves exist: the
 * prompt is what the model obeys, the check is what catches it when the model
 * does not.
 *
 * ── What is deliberately NOT flagged ────────────────────────────────────────
 *
 * A day of **28 or less pasted onto a template is left alone**, because every
 * month has 28 days and the expression is therefore correct. `-01` in particular
 * is the ordinary, right way to name the first of a month and firing on it would
 * train a reader to ignore this finding (I-38 from the other end: a control that
 * fires on correct code is worse than one that fires on nothing, because it gets
 * switched off). `{{ inputs.year }}-12-31` is not flagged either — December has
 * 31 days, so that expression cannot fail.
 *
 * ⚠ **February is checked at 29, not 28.** A leap year makes `-02-29` legal, so
 * flagging it would be wrong in one year out of four; `-02-30` and `-02-31`
 * cannot exist in any year and are flagged. The check refuses only what is
 * impossible, never what is merely unlikely.
 */
import { EXPRESSION_FIELDS } from "./flow-expression.service.js";

/** Days in each month, indexed 1..12. February is 29 — see the docblock. */
const MAX_DAY: Record<number, number> = {
  1: 31,
  2: 29,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
};

/** The largest day every month has. A pasted day at or below this cannot fail. */
const ALWAYS_VALID_DAY = 28;

/** A fully literal `YYYY-MM-DD` anywhere in an expression. */
const LITERAL_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/g;

/**
 * A literal date tail pasted onto the end of a template: `}}-31`, `}}-02-30`.
 * The month group is optional — `}}-31` is a day appended to something whose
 * month is not knowable, which is the failing case.
 */
const PASTED_TAIL_RE = /\}\}-(\d{2})(?:-(\d{2}))?(?!\d)/g;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  if (month !== 2) return day <= MAX_DAY[month]!;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= (leap ? 29 : 28);
}

function finding(who: string, field: string, wrote: string, why: string): string {
  return (
    `step "${who}".${field} builds a date that cannot exist: ${wrote}. ${why} The database ` +
    `refuses the whole read with \`date/time field value out of range\` — execution 7cwL1ris ` +
    `failed that way 0.4 s in, on a step that was correct in every other respect. There is no ` +
    `date function in an expression (\`json\`, \`jq\`, \`first\` and \`length\` are all there ` +
    `is), so the last day of a month cannot be computed here at all. Either declare the flow ` +
    `input AS a date and pass it straight to the parameter, or add a \`code\` step whose Python ` +
    `computes the range and bind the parameter to its output — date arithmetic is arithmetic.`
  );
}

/**
 * Every impossible date an expression would render, over every expression field.
 *
 * ⚠ Type-blind ON PURPOSE, and that is what keeps it in `SHAPE_CHECKS`. Scoping
 * it to parameters a ref declares as `type: date` would need the workspace's
 * param schemas, which would make it impure and put it out of reach of the one
 * list every path that accepts a model shares (`flow-model-findings.ts`). It
 * costs nothing: a day pasted onto a template is a latent bug wherever it
 * appears, because it can only mean *"day 31 of a month I do not know"*, and a
 * fully impossible literal is wrong in any position at all.
 */
export function checkConstructedDates(steps: Array<Record<string, unknown>>): string[] {
  const findings: string[] = [];

  for (const step of steps) {
    const who = typeof step.id === "string" ? step.id : "<unnamed step>";

    for (const field of EXPRESSION_FIELDS) {
      const value = step[field];
      if (typeof value !== "string") continue;

      for (const m of value.matchAll(LITERAL_DATE_RE)) {
        const [whole, y, mo, d] = m;
        if (isRealDate(Number(y), Number(mo), Number(d))) continue;
        findings.push(
          finding(who, field, `the literal \`${whole}\``, `That day is not in that month.`),
        );
      }

      for (const m of value.matchAll(PASTED_TAIL_RE)) {
        const first = Number(m[1]);
        const second = m[2] === undefined ? undefined : Number(m[2]);

        if (second === undefined) {
          // `}}-31` — a day appended to a template. The month is whatever the
          // template renders, so the only safe days are the ones every month has.
          if (first <= ALWAYS_VALID_DAY) continue;
          findings.push(
            finding(
              who,
              field,
              `it appends \`-${m[1]}\` to a template`,
              `Not every month has ${first} days, so this renders a real date for some ` +
                `values and an impossible one for others — it would work on a January and ` +
                `fail on a June.`,
            ),
          );
          continue;
        }

        // `}}-02-30` — the month is literal too, so this is decidable outright.
        if (first >= 1 && first <= 12 && second >= 1 && second <= MAX_DAY[first]!) continue;
        findings.push(
          finding(
            who,
            field,
            `it appends \`-${m[1]}-${m[2]}\` to a template`,
            `There is no such day in month ${m[1]}.`,
          ),
        );
      }
    }
  }

  return [...new Set(findings)];
}
