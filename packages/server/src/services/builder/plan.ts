/**
 * ONE plan owns a goal's whole structure (builder-stability P1-D13, 2026-10-02) — so there is nothing to reconcile.
 *
 * 1. `clauses`: code splits the goal into numbered clauses (C1…Cn) at its own joining words — deterministic, no model.
 * 2. `planSchema`: one strict reply holding every part — sources, the rows at all, the loop, the schedule, an if / else-if chain of
 *    conditions, every action with WHERE it runs (`on`, required), its approval and its recipient, and the values that fill an
 *    input — each part citing the clauses it implements.
 * 3. `planFindings`: coverage checked EXACTLY, asked back once (`makePlan`).
 * 4. `planToSpec`: the plan as the `GoalSpec` + `Wiring` the solver already builds from — lowered by code, so nothing after it changes.
 *
 * The written read (the proposer's SQL form) is NOT here: it is written after the plan, to a contract the plan fixes.
 * Measured: phase-1 EVIDENCE "one plan".
 */
const NUMBER_TESTS = new Set(["below", "above", "at_most", "at_least"]);
import { EDIT_NOT_ADDITIVE, NONE_FIT, noneFitCandidates, norm, goalClauses, RECIPIENT_FIELD_NA, RECIPIENT_FIELD_NONE, UNSAID, COND_TESTS, UNCLEAR_ABOUT, VALUE_ROLES, VALUE_FROM, MODEL_VALUE_FROM, FILLS_NONE, type BuilderCatalogue, type CatalogueItem, type CondTest, type GoalSpec, type SpecSummary } from "./goal-spec.js";
import { GROUP_ROWS, stageNames, type Shape, type Stage } from "./shape.js";
import type { ActionPath, ListKey, Wiring, WiringCmp, WiringExisting, WiringPath } from "./wiring.js";
import { isNewRead as isNewReadRef, newReadOf } from "./local-readers.js";
import { S, type Schema } from "./strict-schema.js";
import { declarationOf } from "../tool-declarations.js";
import { INPUT_FILLS, INPUT_IDS, INPUT_KINDS, RELATIVES, kindFor, testFor, type InputAt, type SpecInput } from "./inputs.js";
import { intentIrEnabled } from "./intent-ir.js";
import { planStages, mergeStages } from "./plan-stages.js";

export interface Clause { id: string; text: string }

/** Words that open a new clause. Kept with the clause they open. Longest first, so "for each" wins over "for". */
const OPENERS = ["for each", "for every", "and then", "else if", "otherwise", "unless", "before", "after", "then", "else", "when", "if"];
const OPENER_RE = new RegExp(`\\b(${OPENERS.map((o) => o.replace(" ", "\\s+")).join("|")})\\b`, "gi");

/** The goal's clauses, by code: split at punctuation that ends a phrase, then before each opener. Empty pieces are dropped. */
/** S4: a piece that is only a joiner ("and", "or", "then" left bare between clauses) is not work — dropped, ids renumber. */
const LONE_JOINER_RE = /^(and|and then|or|then|but|plus)$/i;
export function clauses(goal: string): Clause[] {
  // A stop ends a phrase only before a space or the end: "a.b@x.com" and "10.5" are one word.
  const pieces = goal.split(/[:;!?]+|[.,](?=\s|$)/).flatMap((part) => {
    const cuts: number[] = [0];
    for (const m of part.matchAll(OPENER_RE)) if (m.index! > 0) cuts.push(m.index!);
    return cuts.map((c, i) => part.slice(c, cuts[i + 1] ?? part.length));
  });
  return pieces.map((p) => p.trim()).filter((p) => /\w/.test(p) && !LONE_JOINER_RE.test(p)).map((text, i) => ({ id: `C${i + 1}`, text }));
}

export const MAX_CONDITIONS = 4;
export const ON = ["always", "otherwise", ...Array.from({ length: MAX_CONDITIONS }, (_, i) => `if:${i}`)] as const;
/** builder-behaviour P1 (B22): an action on the rows that do NOT pass condition N — the rest of a split. */
export const REST = Array.from({ length: MAX_CONDITIONS }, (_, i) => `rest:${i}`);
export const RECIPIENT_FROM = ["goal", "requester", "rows", "unsaid", "not_a_message"] as const;
/** What the MODEL may say: whether an action reaches a person at all is code's (the tool's declared address ports). */
const MODEL_RECIPIENT = ["goal", "requester", "rows", "unsaid"] as const;
/**
 * builder-behaviour P7 (R15): WHICH field of the rows holds the address of the people a `rows` recipient names — chosen by the plan
 * from the readers' declared Address fields (a closed list), `new_read` when a written read must return it, `none` when no listed
 * field holds THOSE people's address. Never ranked by word overlap (B24: "the customer's account manager" became `customer_email`).
 */
export const addressFields = (cat: BuilderCatalogue) =>
  cat.items.filter((i) => i.kind === "reader").flatMap((i) => (i.fields ?? []).filter((f) => /\bAddress\b/.test(f.ty)).map((f) => `${i.ref}.${f.name}`));

/** What may be chosen: readers, or the tools that DO something (a GET lookup changes nothing, so it is never one of the goal's actions). */
const offered = (cat: BuilderCatalogue, kind: CatalogueItem["kind"]) => cat.items.filter((i) => i.kind === kind && !i.lookup);
const refs = (cat: BuilderCatalogue, kind: CatalogueItem["kind"]) => [...offered(cat, kind).map((i) => i.ref), NONE_FIT, ...(kind === "tool" ? [UNSAID] : [])];
/**
 * Every input a stated value may fill: the offered components' own parameters — but never one a value cannot be. Who receives is
 * the action's `recipient`, never a value (an address input), and a port only a step's output fills (`fromStep`) takes no words
 * (2026-10-02: "email" filled `to`, and a phrase filled a CSV's rows — both by the plan's reading, both wrong by declaration).
 */
const ports = (cat: BuilderCatalogue, kinds: ReadonlyArray<CatalogueItem["kind"]> = ["reader", "tool"]) => kinds.flatMap((k) => offered(cat, k)).flatMap((i) => {
  const decl = declarationOf(i.ref, i.params ?? []).ports ?? {};
  return (i.params ?? []).filter((p) => !p.fromStep && !decl[p.name]?.address).map((p) => `${i.ref}.${p.name}`);
});
/** Whether a tool reaches a person: its declaration has an address port. Code's, never the model's. */
export const addressed = (cat: BuilderCatalogue, ref: string) => {
  const item = cat.items.find((i) => i.ref === ref);
  return !!item && Object.values(declarationOf(ref, item.params ?? []).ports ?? {}).some((d) => d.address);
};

/**
 * An EDIT of an existing automation (After Phase 4, 2026-10-02): the plan names the automation's own parts — its lists (`step:<id>`)
 * as a source's `list`, its prepared text or lists as what an action `takes`, its condition paths (`in:<id>`) as where an action
 * runs. Absent for a new goal, whose schema is unchanged.
 */
export interface PlanEdit { current: string[]; existing: WiringExisting }

export function planSchema(cat: BuilderCatalogue, cs: Clause[], edit?: PlanEdit): Schema {
  const body = planBody(cat, cs, edit);
  // builder-behaviour P1 (R4): a test may read a SUMMARY's measure (`summary:N`) — "if a team has more than 5".
  const fieldList = [...cat.items.filter((i) => i.kind === "reader").flatMap((i) => (i.fields ?? []).map((f) => `${i.ref}.${f.name}`)), "new_read", ...SUMMARY_REFS];
  return { ...body, $defs: { field: S.oneOf(fieldList) } } as unknown as Schema;
}

const QUOTE = S.str("the goal's exact words for this part, copied exactly");
/** builder-behaviour P1 (R4): a summary's measures, as a test or a sort names them. */
export const SUMMARY_REFS = ["summary:0", "summary:1", "summary:2", "summary:3"] as const;
const SUMMARY_FNS = ["count", "sum", "avg", "min", "max", "distinct_count"] as const;
/** builder-behaviour P10 (bands): counting rows BY BANDS of a field — each arm states a test, an edge, a weight and its own label; first match wins. */
export const BAND_TESTS = ["above", "at_least", "below", "at_most", "equals"] as const;
export interface BandArm { test: (typeof BAND_TESTS)[number]; value: string; then: number; words: string }
export const SENDS = ["rows", "computed", "words"] as const;

/** The value roles that choose or compare DATA — with inputs on, those are `inputs`, and `values` keeps only an action's inputs. */
const DATA_ROLES: ReadonlySet<string> = new Set(["period", "date", "threshold", "count"]);
function planBody(cat: BuilderCatalogue, cs: Clause[], edit?: PlanEdit): Schema {
  const inputRef: Record<string, Schema> = { input: S.oneOf(["none", ...INPUT_IDS], "the input (`inputs`) this test compares with — then `value` is empty; `none` when it compares with `value` or `against`") };
  const ex = edit?.existing;
  const listKeys = ex?.lists.map((l) => l.key) ?? [];
  const takeKeys = [...listKeys, ...(ex?.producers.map((x) => x.key) ?? [])];
  const cl = S.arr(S.oneOf(cs.map((c) => c.id)), cs.length, "the clauses this part implements");
  // ONE definition of the field list, referenced wherever a field is chosen: the gateway counts every enum occurrence.
  const fields = { $ref: "#/$defs/field" } as Schema;
  return S.obj({
    sources: S.arr(S.obj({ ref: S.oneOf(refs(cat, "reader")), quote: QUOTE, clauses: cl, ...(listKeys.length ? { list: S.oneOf(["new", ...listKeys], "`new`: read these rows; or the automation's existing list (ALREADY IN THE AUTOMATION) these rows ARE — then `ref` is the reader it reads") } : {}) }), 4),
    each: S.nullable(S.obj({ over: S.int("index into sources"), quote: QUOTE, clauses: cl,
      ...{ groups: S.bool("true when it goes through the SUMMARY's groups, one per group (\"for each branch, count the overdue loans; if a branch has more than 10 …\"), not the rows") } }, "the goal's for-each: what it goes through one item at a time")),
    rows: S.arr(S.obj({
      clauses: cl,
      field: fields, about: S.str("for a `new_read` field: what it holds; else empty"), test: S.oneOf([...COND_TESTS]),
      value: S.str("the compared value ONLY, copied exactly; empty for a test with no value"),
      against: S.str("when the goal compares this field with ANOTHER field of the same rows (\"kept longer than its loan period\", \"fined more than its cap\"): that field, as `ref.field` from the fields listed (`new_read` for a new read); then `value` is empty. Else empty"),
      ...inputRef,
    }), 4, "which rows the goal works on AT ALL (\"each overdue loan\", \"damaged books\") — tests every row must pass; a row failing them is not part of the automation, so it is never in a condition"),
    schedule: S.nullable(S.obj({ cron: S.str("five-field cron"), quote: QUOTE, clauses: cl }, "when the goal says when or how often it runs")),
    conditions: S.arr(S.obj({
      quote: QUOTE,
      clauses: cl,
      over: S.oneOf(["each_item", "any_row", "no_row", "row_count"], "each_item: tested on each item of the for-each; any_row / no_row: whether any row matches; row_count: how many rows match"),
      where: S.arr(S.obj({
        field: fields,
        about: S.str("for a `new_read` field: what the field holds, in a few words; else empty"),
        test: S.oneOf([...COND_TESTS]),
        value: S.str("the compared value ONLY — the goal's own word or number for it, copied exactly (\"damaged\", \"250\"); empty for a test with no value"),
        against: S.str("when the goal compares this field with ANOTHER field of the same rows (\"kept longer than its loan period\", \"fined more than its cap\"): that field, as `ref.field` from the fields listed (`new_read` for a new read); then `value` is empty. Else empty"),
        ...inputRef,
      }), 4, "ALL of these hold (each a single test of one field)"),
      count: S.nullable(S.obj({ test: S.oneOf(["above", "at_least", "below", "at_most", "equals"]), value: S.str() }, "row_count only: how many matching rows")),
    }), MAX_CONDITIONS, "an if / else-if chain, in the goal's order: the first that holds decides"),
    actions: S.arr(S.obj({
      ref: S.oneOf(refs(cat, "tool")),
      quote: QUOTE,
      clauses: cl,
      on: S.oneOf([...ON, ...REST, ...(ex?.paths.map((x) => x.key) ?? [])], `where it runs: \`if:N\` when condition N holds (the first that holds), \`otherwise\` when none holds, \`always\` regardless; \`rest:N\`: on the rows that do NOT pass condition N (\"send the others to the channel\") — condition N then divides the rows, its action takes the ones that pass${ex?.paths.length ? "; an `in:` key: on that existing path of the automation" : ""}`),
      ...(takeKeys.length ? { takes: S.oneOf(["auto", ...takeKeys], "`auto`: what this plan gives it; or an existing list or prepared text of the automation it sends") } : {}),
      per_item: S.bool("runs once per item of the for-each"),
      ...{ sends: S.oneOf([...SENDS], "what it carries: `rows` the rows themselves (inside a for-each over groups: that group's own rows — \"email its librarian the loans\"); `computed` a number or numbers computed from the rows (\"post how many\", \"the branch's count\"); `words` only the words of its message, or nothing") },
      approve_first: S.nullable(S.obj({ quote: QUOTE, clauses: cl }, "a person approves before it runs — the goal's words for that")),
      heading: S.str("a few plain words for what it sends, as its subject or title, written from the goal (\"Overdue loan reminder\"); empty for an action with no subject or title"),
      message: S.str("ONLY when the action carries nothing but words (\"email me that nothing is overdue\", \"post 'all clear'\"): those words, written from the goal; or, when the data goes as an attached file, one short line to go beside it (\"The overdue loans are attached.\"); empty otherwise"),
      recipient: S.obj({ from: S.oneOf([...MODEL_RECIPIENT]), words: S.str("the goal's words for who receives it, copied exactly; empty when unsaid"),
        ...{ field: S.oneOf([RECIPIENT_FIELD_NA, RECIPIENT_FIELD_NONE, "new_read", ...addressFields(cat)], "for `rows` only: the listed address field that holds THOSE people's address (`ref.field`) — `new_read` when a new read returns it; `none` when no listed field is theirs; `n/a` for any other `from`") } }),
    }), 6),
    ...{ summary: S.nullable(S.obj({
      quote: QUOTE, clauses: cl,
      over: S.int("index into sources: the rows summarised"),
      by: S.arr(S.obj({ field: fields, words: S.str("the goal's words for it (\"per shelf\": shelf)") }), 3, "what the rows are grouped by — one result row per value (\"per shelf\", \"for each branch\"); `new_read` with its words when no listed field holds it; empty for one result over all the rows (\"how many\", \"the total\")"),
      measures: S.arr(S.obj({ fn: S.oneOf([...SUMMARY_FNS, "band_count"]), field: fields, words: S.str("the goal's words for this measure"), counts: S.nullable(S.str("for `fn: band_count` only: the `words` of the single band this measure counts, copied exactly from that band's `words`. Leave empty to sum every band's weight (a total).")), bands: S.arr(S.obj({ test: S.oneOf([...BAND_TESTS]), value: S.str("the band edge, copied exactly"), then: S.num("the weight each row in this band counts"), words: S.str("the goal's words for this band") }), 4, "P10: `fn: band_count` only — the bands of `field`, first match wins") }), 4, "what each result row carries: a count (`field` `new_read`/any, it counts rows), or a total, average, smallest, largest, or number of different values of a field; or `band_count`: rows labelled by bands of a field, each counting its weight — plus its own label in `words`, the band it counts in `counts`, and the bands in `bands`"),
      sort: S.nullable(S.obj({ by: S.oneOf([...SUMMARY_REFS, "key:0", "key:1", "key:2"], "`summary:N`: the N-th measure; `key:N`: the N-th grouping field"), dir: S.oneOf(["asc", "desc"]) }, "the order the goal asks for (\"largest first\")")),
      limit: S.str("how many result rows the goal keeps (\"the first 3\": 3); else empty"),
    }, "what the goal computes OVER the rows — counts, totals, averages, per group or over all; null when it uses the rows as they are")) },
    ...{ inputs: S.arr(S.obj({
      id: S.oneOf([...INPUT_IDS]),
      words: S.str("the goal's exact words for this input, copied exactly — its value when the goal gives one (\"2027-03-03 to 2027-03-09\", \"under 40\"), else the words that name it (\"a date range\", \"the month I choose\")"),
      kind: S.oneOf([...INPUT_KINDS], "`date`: one day · `date_range`: a span of days (two ends) · `month`: one calendar month · `number` · `text`"),
      fill: S.oneOf([...INPUT_FILLS], "`given`: the goal's words state the value · `from_run_date`: the value is relative to when it runs (\"last month\", \"today\", \"the past 7 days\") — then `relative` · `each_run`: anything else — the person gives it each time it runs (said, or not said at all)"),
      relative: S.oneOf([...RELATIVES], "for `from_run_date` only: which value relative to the run date; else `none`"),
      days: S.int("for `last_n_days`, `days_ago` and `next_n_days` only: how many days; else 0"),
      fills: S.oneOf([...ports(cat, ["reader"]), FILLS_NONE], "the parameter (`ref.param`) of a chosen READER this input is, when the reader takes it; else `none`"),
      clauses: cl,
    }), INPUT_IDS.length, "every value the automation must be TOLD to choose or compare its data — a day, a span of days, a month, a number, a text. Named even when the goal gives no value (\"a specific date range\" is an input to be given each run). A test that compares with an input names it in `input`") },
    values: S.arr(S.obj({
      role: S.oneOf(VALUE_ROLES.filter((r) => r !== "recipient" && !DATA_ROLES.has(r)), "`channel`: a destination the goal names (\"#circulation\", \"the desk channel\"); `period` / `date`: when; `threshold` / `count`: a number tested; `subject`: a title; `text`: a message's words; `other`: any other input's value (a format, a status)"),
      from: S.oneOf([...MODEL_VALUE_FROM]),
      quote: S.str("the value ALONE, copied exactly from the goal — never the words around it (for `the subject line \"Weekly list\"`: Weekly list; for `status is open`: open)"),
      fills: S.oneOf([...ports(cat, ["tool"]), FILLS_NONE], "the input (`ref.param`) of a chosen component this value is for"),
      clauses: cl,
      ...{ as: S.str("when the input it fills lists its values ([one of: …]) and the goal names one in its own words: that listed value, exactly; else empty") },
      ...{ named: S.bool("true when the goal only NAMES this value without giving it (\"below the threshold\", \"for a month\", \"before the deadline\") — `quote` is the naming words; the person is asked for the value") },
    }), 8, "each value the goal states that fills an INPUT of a chosen component — a reader's period or date, a channel, a subject, a message's words. Not a value a test compares with (that is the test's), not who receives (that is the action's recipient)"),
    unclear: S.arr(S.obj({ quote: QUOTE, about: S.oneOf([...UNCLEAR_ABOUT]) }), 4, "the goal's words you cannot tie to ONE listed component, field or value with confidence — a vague reference (\"the usual report\", \"the right folks\") or a vague measure (\"for ages\"); the person will be asked what they mean. Empty when everything is clear"),
    missing: S.str("what the goal needs that no listed component provides, in a few words; empty when nothing is missing"),
    joining: S.arr(S.oneOf(cs.map((c) => c.id)), cs.length, "clauses that implement nothing themselves: words that only join the others, or that say WHY the person wants it (its purpose — \"this is to check how teams are doing\", \"so that we can follow up\") rather than what it does"),
    ...{ spelling: S.arr(S.obj({ said: S.str("a word of the goal as typed, copied exactly"), meant: S.str("the word the person meant") }), 8, "words of the goal that are MISSPELT (\"motnh\", \"threhold\", \"employess\"), each with the word meant. Only spelling slips — never a different word, never a word that is spelt right. Empty when none") },
    ...(edit ? { changes_existing: S.bool("true when the goal alters or removes something the automation already has (a different reader, action or value, or taking a step away) rather than adding — then plan nothing else") } : {}),
  });
}

/** builder-inputs P1: the rules for `inputs` — what the automation is told, separate from whether its value is known. */
const SUMMARY_RULES = [
  "- A person approves only SOME of the items or rows (\"if the fine is over 250 let me approve it before it goes\"): the action is TWO entries — one `on` that condition (`if:N`) with `approve_first`, and one `on: otherwise` without it. The others still happen, straight away.",
  "- Doing nothing is NOT an action: \"otherwise do nothing\" has no `actions` entry (its clause goes in `joining`); never `none_fit` for it.",
  "- An action that sends a number COMPUTED from the rows (\"post how many came back late\", \"email the total fines\") needs a `summary` — it sends the summary, never the rows themselves.",
  "- `sends` (each action): `computed` when it carries a number worked out from the rows — then there IS a `summary`; `rows` when it carries the rows; `words` when it carries only its message's words.",
  "- `each.groups` ONLY when an action is done ONCE PER GROUP: \"for each branch, count the overdue loans; if a branch has more than 10 email its librarian the loans\" goes through the summary's groups (the summary `by` the branch); \"its librarian\" is a field of the branch's rows; \"the loans\" are that branch's own rows (`sends: rows`).",
  "- A summary per group sent as ONE list (\"the average loan length per branch, email me the branches above 30 days and send the others to the channel\") has NO for-each: its condition tests the summary's rows (`any_row`, field `summary:N`), its action takes the ones that pass, and `rest:N` takes the others.",
  "- `summary`: what the goal COMPUTES over the rows — how many, a total, an average, per group (\"for each branch\", \"per shelf\") or over all of them — with the order and how many it keeps (\"largest first, the first 3\"). Null when the goal uses the rows as they are. A test of a measure (\"if a branch has more than 10\", \"branches above 30 days\") names it as `summary:N` in its field.",
  "- P10 (bands, generic): counting or bucketing rows BY BANDS of a field — any thresholded labelling. `fn: band_count` with `bands` (each: a test, the edge value, the weight `then` each row in the band counts, its own label in `words`, first match wins). State every band the goal has, including a zero-weight band. Every banded output carries its own label in the measure's `words` and names the band it counts in `counts` (copied exactly from that band's `words`); a measure that sums every band's weight (a total) leaves `counts` empty. Never split bands into conditions or rows.",
];
const INPUT_RULES = [
  "- `inputs`: every value the automation must be TOLD to choose or compare its data — a day, a span of days, a month, a number, a text. Name it even when the goal gives no value: \"for a date range\", \"between two dates\", \"for the month I pick\", \"below a threshold\" are each ONE input. A span of days is ONE `date_range` input, never two dates.",
  "- An input's `fill`: `given` when the goal's words state its value (\"2027-03-03 to 2027-03-09\", \"40\"); `from_run_date` when it is relative to when the automation runs (\"last month\", \"today\", \"the past 7 days\", \"the next 7 days\", \"3 days ago\") — choose `relative` (and `days` for `last_n_days`, `days_ago`, `next_n_days`); `each_run` otherwise — the person gives it each time it runs, whether the goal says so or says nothing about it.",
  "- A test that compares a field with an input names it in `input` and leaves `value` empty. An input a chosen reader takes as its own parameter names that parameter in `fills`. For a `new_read` source, an input that chooses its rows (its period, a number it keeps rows by) needs no test: the read is written to take it.",
  "- `values`: only an ACTION's inputs — a channel, a subject, a message's words. Never a day, period, number or text about the DATA: those are `inputs`.",
];
/**
 * The stable instruction block (S7): everything about HOW to lay out a plan
 * that never changes call to call — sent once as the `system` message, never
 * repeated inside the data prompt. The catalogue, goal, clauses, edit state
 */
export const PLAN_SYSTEM = [
  "You lay out the WHOLE structure of one automation goal, over the components of one workspace. One answer holds every part.",
  "The goal is split into numbered clauses. Every part you give cites the clauses it implements; every clause is cited by some part, or listed in `joining` when it only connects others.",
  "Rules:",
  "- `sources`: the readers the data comes from. Choose only from READERS; `none_fit` if none gives it.",
  "- `each`: the goal's for-each (\"for each\", \"every\", \"each of them\") — the source it goes through one item at a time; null when there is none.",
  "- `rows`: the tests that say which rows the goal is about at all (\"overdue loans\", \"damaged books\", \"reserved titles\"). Only what a chosen reader does not already select (its description says what it selects). A test in `rows` is never repeated in a condition.",
  "- `schedule`: the goal's words for when or how often it runs. Never an action.",
  "- `conditions`: what the goal tests to decide what happens (if / else if), in the goal's order. `where` lists every single test the goal's words put on the rows — \"a damaged reference book at the main branch\" is three tests, all holding. `over`: `each_item` for a test on each item of the for-each; `any_row` (\"if any\", \"if anyone\") / `no_row`; `row_count` with `count` (\"more than 10 overdue loans\").",
  "- A test's `value` is the value alone, never the field's name or other words. A test against ANOTHER field of the same rows (\"kept longer than its loan period\") names that field in `against` and has no `value`.",
  "- `actions`: every thing the goal asks to be DONE (sent, posted, created), each its OWN entry, in the goal's order — the same action asked for twice is two entries. Approving is not an action: it is `approve_first` on the action it guards.",
  "- `on` (required): `if:N` when the action is what happens when condition N holds; `otherwise` when the goal says it happens when none holds (\"otherwise\", \"else\"); `always` only when the goal says it happens regardless. An action said inside a condition's clause, or after it before the next \"otherwise\", is that condition's.",
  "- `per_item`: true when it happens once per item of the for-each.",
  "- `heading` / `message`: wording for the person to confirm — a heading always (a few plain words), a message only for an action that carries nothing but words, or one short line beside a file that carries the data. Never a name, number, date or address the goal does not state.",
  "- `recipient.from`: who it goes to or is for — `goal` ONLY when the goal writes out a literal address (an email, a `#channel` — copy those words), `requester` (\"me\"), `rows` (the people the rows are about, e.g. \"the borrower\" — copy those words), `unsaid` (the goal does not say). A named person, team, or role that is not a literal address is `rows`, never `goal`.",
  "- `recipient.field` (for `rows`): the address field that holds THOSE people's address — decided by STRUCTURE, never by matching words: the chosen source's declared Address field when exactly one is offered (`none` when none is); when several are offered, name the first in catalogue order and the person is asked which (the question names the offered fields). `new_read` when a written read must return it. Never borrow a nearby person's address by how its name reads.",
  "- A test that decides WHICH action happens belongs in that condition, never in `rows`: \"if the fine is over 250 …, otherwise …\" is a condition on the fine, and every overdue loan is still one of the rows.",
  "- A goal that only asks to see or get data has NO actions. `unsaid` (an action): the goal asks for something to be done only with a vague verb more than one listed action could do (\"deal with it\") — the person will be asked which.",
  ...INPUT_RULES,
  ...SUMMARY_RULES,
  "- Words that say HOW or BY WHAT something is sent or done (\"by email\", \"on chat\", \"as a ticket\") choose the action: they are that action's `quote`, never a value. A value fills an input of the action, not the choice of it.",
  "- Every `quote` is the goal's exact words for that part (\"let me approve it\", \"for each overdue loan\"), copied exactly — never paraphrased.",
  "- `unclear`: words you cannot tie to ONE listed component, field or value with confidence. Schedule words never are; words you placed are not; words that say WHAT an action sends (\"a summary\", \"an update\", \"the list\") are that action's heading or message, never unclear.",
  "- `missing`: only when a part of the goal has no listed component (then `none_fit` there).",
  "- A component fits by what it DOES. A value the goal names that is not among an input's listed values (\"post to #stacks-desk\" when that is not a listed channel) never makes the component unfit: choose it, and give the value as said — the person is then asked for a listed one.",
  "- `spelling`: each misspelt word of the goal with the word meant. Plan the goal as meant; quotes may copy either spelling.",
].join("\n");

export function planPrompt(goal: string, cat: BuilderCatalogue, cs: Clause[], edit?: PlanEdit): string {
  const list = (kind: CatalogueItem["kind"]) => offered(cat, kind).map((i) => `- ${i.ref}: ${i.about}${i.params?.length ? `\n    params: ${i.params.map((p) => `${p.name}${p.about ? ` (${p.about})` : ""}${p.default !== undefined ? ` [set by the catalogue: ${p.default}]` : ""}${p.values?.length ? ` [one of: ${p.values.join(", ")}]` : ""}`).join("; ")}` : ""}${i.fields?.length ? `\n    fields: ${i.fields.map((f) => `${f.name} (${f.values ? `one of: ${f.values.join(", ")}` : f.ty})`).join("; ")}` : ""}`).join("\n") || "- (none)";
  // (`PLAN_SYSTEM`). Same bytes, split across roles; absent system = old body.
  return [
    ...(edit ? [
      "- This goal CHANGES an automation that already exists (ALREADY IN THE AUTOMATION, below). Plan only what the goal ADDS; never repeat a part the automation has. Rows the automation already reads are a source with that `list` key (filter them with `rows`, test them in a condition); an action that sends what the automation already prepared `takes` that key; an action on one of its existing conditions runs `on` that `in:` key.",
      "",
      "ALREADY IN THE AUTOMATION", ...edit.current.map((l) => `- ${l.replace(/^-\s*/, "")}`),
      ...edit.existing.lists.map((x) => `- ${x.key}: ${x.words}${x.ref ? ` (rows of ${x.ref})` : ""}`), ...edit.existing.producers.map((x) => `- ${x.key}: ${x.words}`), ...edit.existing.paths.map((x) => `- ${x.key}: ${x.words}`),
      "",
    ] : []),
    "READERS", list("reader"), "",
    "ACTIONS", list("tool"), "",
    "GOAL", goal, "",
    "CLAUSES", ...cs.map((c) => `${c.id}: ${c.text}`),
  ].join("\n");
}

export interface Plan {
  /** `also`: set by CODE, never the model — the other saved readers that carry every field the plan tests on these rows. */
  /** `list`: an EDIT only — the automation's existing list (`step:<id>`) these rows are, never read again; `new` (or absent) reads them. */
  sources: Array<{ ref: string; quote?: string; clauses: string[]; also?: string[]; list?: string }>;
  /** `groups` (P7, R24): the for-each goes through the summary's groups, not the rows. */
  each: { over: number; quote?: string; clauses: string[]; groups?: boolean } | null;
  /** builder-behaviour P1 (R4): what the goal computes over the rows. */
  summary?: { quote?: string; clauses: string[]; over: number; by: Array<{ field: string; words: string }>; measures: Array<{ fn: (typeof SUMMARY_FNS)[number] | "band_count"; field: string; words: string; counts?: string | null; bands?: BandArm[] }>; sort: { by: string; dir: "asc" | "desc" } | null; limit: string } | null;
  /** builder-inputs P1: what the automation is told (`inputs.ts`). */
  inputs?: Array<{ id: string; kind: SpecInput["kind"]; words: string; fill: SpecInput["fill"]; relative?: SpecInput["relative"]; days?: number; fills?: string; clauses: string[] }>;
  /** `input`: the plan input a test compares with (builder-inputs P1) — then `value` is empty. */
  rows: Array<{ clauses: string[]; field: string; about: string; test: CondTest; value: string; against?: string; input?: string }>;
  schedule: { cron: string; quote?: string; clauses: string[] } | null;
  conditions: Array<{ quote?: string; clauses: string[]; over: "each_item" | "any_row" | "no_row" | "row_count"; where: Array<{ field: string; about: string; test: CondTest; value: string; against?: string; input?: string }>; count: { test: string; value: string } | null }>;
  actions: Array<{
    /** An EDIT only: an existing list or prepared text (`step:<id>`) the action sends; `auto` (or absent) derives it. */
    takes?: string; ref: string; quote?: string; clauses: string[]; on: (typeof ON)[number] | `in:${string}` | `rest:${number}`; per_item: boolean; approve_first: { quote?: string; clauses: string[] } | null; heading?: string; message?: string; recipient: { from: (typeof RECIPIENT_FROM)[number]; words: string; field?: string };
    /** P7 (R24, P1-I3): what it carries — the rows (a group's own rows, over groups), a number computed from them, or only words. */
    sends?: (typeof SENDS)[number] }>;
  values: Array<{ role: (typeof VALUE_ROLES)[number]; from: (typeof VALUE_FROM)[number]; quote: string; fills: string; clauses: string[]; named?: boolean; as?: string }>;
  /** A condition the goal SAID that is the otherwise ("if it doesn't") — its words, now the otherwise's. */
  otherwise_said?: { quote?: string; clauses: string[] };
  unclear?: Array<{ quote: string; about: (typeof UNCLEAR_ABOUT)[number] }>;
  missing: string;
  joining: string[];
  /** Misspelt words and the word meant, as the model stated them. */
  spelling?: Array<{ said: string; meant: string }>;
  /** An EDIT only: the goal alters or removes an existing part — a stated `cannot` (D-321: an edit is additive). */
  changes_existing?: boolean;
}

/**
 * P2 (RC-3): the marker of the `none_fit`-with-candidates question in a plan's findings. `makePlan` asks it back ONCE (its one
 * bounded re-ask, with the candidates named) and then accepts a `none_fit` that persists — so it is dropped from the findings
 * returned: never a gap, never a second ask.
 */
export const NONE_FIT_FINDING = "none_fit:";

/** Advisory gaps save with a warning note; blocking gaps hold the build unfinished. No verifier deleted, no bound
 * widened: only the terminal-`otherwise` shape is advisory — every other gap stays blocking. Marker prefix for
 * advisory findings — stripped before display, read by the gap plumbing. */
export const ADVISORY_PREFIX = "advisory: ";
/**
 * Terminal-`otherwise` advisory test (2026-10-08): `otherwise`-without-condition when `conditions.length == 0`
 * AND the plan holds a single terminal action. Then `otherwise` names no branch — the goal's words already place
 * the action — so the gap is advisory (saves with a note), never incomplete. Branching `otherwise` (conditions
 * exist, the action picks a losing arm) stays blocking. Structural only: holds on non-attendance domains too.
 */
export function isTerminalOtherwiseAdvisory(p: Plan): boolean {
  return p.conditions.length === 0 && p.actions.length === 1 && p.actions[0]?.on === "otherwise";
}
/** What the plan leaves wrong, by code — exact, never by word overlap. Each a sentence; empty when the plan is whole. */
export function planFindings(p: Plan, cs: Clause[], cat: BuilderCatalogue, extraTexts: readonly string[] = []): string[] {
  const out: string[] = [];
  const claimed = new Set([
    ...p.joining,
    ...(p.inputs ?? []).flatMap((i) => i.clauses),
    ...p.sources.flatMap((s) => s.clauses),
    ...(p.each?.clauses ?? []),
    ...(p.schedule?.clauses ?? []),
    ...p.rows.flatMap((r) => r.clauses),
    ...p.conditions.flatMap((c) => c.clauses),
    ...(p.otherwise_said?.clauses ?? []),
    ...p.actions.flatMap((a) => [...a.clauses, ...(a.approve_first?.clauses ?? [])]),
    ...(p.values ?? []).flatMap((v) => v.clauses),
    // Summary clauses are placed work (grouping + measures). Leaving them out of `claimed` made every band weight
    // clause "implemented by nothing" → "What do you mean by “Weight half = 0.5”?" over a plan that already had bands.
    ...(p.summary?.clauses ?? []),
  ]);
  // Band arms claim their own goal clauses by the model's own edge values/labels (exact substring),
  // even when the model forgot to cite them on `summary.clauses`.
  const banded = (p.summary?.measures ?? []).filter((m) => (m.fn as string) === "band_count" && m.bands?.length);
  if (banded.length || (p.summary?.by.length ?? 0) > 0 || p.each) {
    const markers = new Set<string>();
    for (const b of banded) {
      if (b.words.trim()) markers.add(b.words.toLowerCase());
      for (const a of b.bands!) {
        if (a.value.trim()) markers.add(a.value.toLowerCase());
        markers.add(String(a.then));
        if (a.words.trim()) markers.add(a.words.toLowerCase());
      }
    }
    for (const c of cs) {
      const low = c.text.toLowerCase();
      if (banded.length && [...markers].some((m) => m.length > 0 && low.includes(m))) claimed.add(c.id);
      if ((p.summary?.by.length || p.each) && /\bfor\s+each\b|\bfor\s+every\b|\beach\s+\w+|\bper\s+\w+/i.test(c.text)) claimed.add(c.id);
      if ((p.summary?.by ?? []).some((b) => b.words.trim() && low.includes(b.words.toLowerCase()))) claimed.add(c.id);
    }
  }
  for (const c of cs) if (!claimed.has(c.id)) out.push(`${c.id} (“${c.text}”) is implemented by nothing`);
  // P2 (RC-3, 2026-10-07): `none_fit` must justify itself — STRUCTURED, never by word overlap. A `none_fit`
  // part is asked back ONCE with the workspace's offered components named (catalogue order, already-chosen refs
  // first, lookups excluded by the shortlist), and accepted when it persists — a component truly absent raises
  // no question, exactly as before. Genuine ambiguity is that question, never a refusal and never a guess:
  // `makePlan` drops the marker from returned findings, and `planToSpec`'s stated `missing` refuses only there.
  for (const [kind, word, parts] of [["reader", "source", p.sources], ["tool", "action", p.actions]] as const) {
    for (const part of parts) {
      if (part.ref !== NONE_FIT) continue;
      const quote = part.quote?.trim() || part.clauses.map((id) => cs.find((c) => c.id === id)?.text ?? "").join(" ").trim();
      if (!quote) continue;
      // Already-chosen refs first (the model's likeliest miss is one it already picked elsewhere), then the
      // rest in catalogue order — a stable shortlist with no English-vocabulary ranking.
      const picked = parts.filter((x) => x.ref !== NONE_FIT).map((x) => x.ref);
      const all = noneFitCandidates(quote, kind, cat);
      const ordered = [...all.filter((r) => picked.includes(r)), ...all.filter((r) => !picked.includes(r))];
      const candidates = ordered.slice(0, 3);
      if (candidates.length) out.push(`${NONE_FIT_FINDING} the ${word} for “${quote}” is \`none_fit\` — could ${candidates.map((r) => `\`${r}\``).join(", ")} carry this (say what it does in the plan)? Keep \`none_fit\` only if none of them does`);
      else if (kind === "tool") {
        // No offered action at all: nothing to name, nothing to ask — the refusal path stands as before.
      }
    }
  }
  if (p.each && !p.sources[p.each.over]) out.push(`the for-each goes through source ${p.each.over}, which does not exist`);
  out.push(...inputFindings(p));
  // P2: every quote is the goal's exact words (planPrompt :219). Fragment-wise verbatim (live iteration): a fusion of two
  {
    const goalText = [cs.map((x) => x.text).join(" "), ...extraTexts].join(" ");
    // LIVE FIX (flow 77db92ec): clause-splitting eats delimiters (`,`, `.`, `:`), so the clause-joined text loses
    // punctuation the quote keeps ("Division," vs "Division"). Strip punctuation on both sides before comparing —
    // `@`/`.` survive for addresses and decimals ("a@b.example", "4.75").
    const strip = (t: string) => norm(t).replace(/[^a-z0-9@.\s]/g, " ").replace(/\s+/g, " ").trim();
    const verbatim = (q: string): boolean => {
      const n = strip(q).replace(/^[.,;:!?…]+|[.,;:!?…]+$/g, "").trim();
      if (!n) return true;
      const g = strip(goalText);
      if (g.includes(n)) return true;
      // A sentence-final dot survives `strip` (kept for decimals) but clause-splitting eats it ("employee." vs "employee"):
      // compare words with their trailing sentence punctuation trimmed (2026-10-06: a whole-goal source quote failed on its own words).
      const word = (w: string) => w.replace(/^[.,;:!?…]+|[.,;:!?…]+$/g, "");
      if (n.split(/\s+/).every((w) => w.length <= 3 || g.split(/\s+/).some((x) => word(x) === word(w)))) return true;
      // Step 4: strict verbatim — a quote is the goal's words or it is refused, never mined.
      return false;
    };
    for (const [where, quote] of [
      ...p.sources.map((s, i) => [`source ${i}`, s.quote] as const),
      ...p.actions.map((a, i) => [`action ${i}`, a.quote] as const),
      ...(p.unclear ?? []).map((u, i) => [`unclear ${i}`, u.quote] as const),
    ]) if (quote?.trim() && !verbatim(quote)) out.push(`${where} quote “${quote}” is not the goal's words verbatim`);
  }
  p.actions.forEach((a, i) => {
    const m = /^if:(\d+)$/.exec(a.on);
    // P2: `always` only when the goal says it happens regardless — with conditions present and no regardless/schedule words,
    // an always-action runs on every arm, a branch the plan invented. With NO conditions, `always` is the only correct `on`.
    if (a.on === "always" && p.conditions.length > 0) {
      const saidAll = cs.map((x) => x.text).join(" ").toLowerCase();
      if (!/daily|weekly|monthly|every (day|week|month|morning|evening)|each (day|week|month)|cron|at \d|monday|tuesday|wednesday|thursday|friday|regardless|always|every time|no matter|whatever happens|in all cases/i.test(saidAll))
        out.push(`action ${i} runs \`always\` but the goal states no regardless/schedule words`);
    }
    // P2: an action said inside a condition's clause is that condition's. An action whose clauses precede its condition's
    // earliest clause, or that stands after an otherwise-clause, runs on the wrong arm.
    {
      const m = /^if:(\d+)$/.exec(a.on);
      if (m && p.conditions[Number(m[1])]) {
        const condClauses = p.conditions[Number(m[1])]!.clauses;
        const firstCond = condClauses.map((id) => cs.findIndex((c) => c.id === id)).filter((x) => x >= 0).sort((x, y) => x - y)[0];
        const firstAct = a.clauses.map((id) => cs.findIndex((c) => c.id === id)).filter((x) => x >= 0).sort((x, y) => x - y)[0];
        if (firstCond !== undefined && firstAct !== undefined && firstAct < firstCond)
          out.push(`action ${i} is in an earlier clause than condition ${m[1]} but runs on it`);
      }
    }
    if (m && !p.conditions[Number(m[1])]) out.push(`action ${i} runs on condition ${m[1]}, which does not exist`);
    if (a.on === "otherwise" && !p.conditions.length) out.push(`${isTerminalOtherwiseAdvisory(p) ? ADVISORY_PREFIX : ""}action ${i} runs “otherwise” with no condition${isTerminalOtherwiseAdvisory(p) ? " — the goal states no condition, so it runs always" : ""}`);
    if (a.per_item && !p.each) out.push(`action ${i} runs per item with no for-each`);
    if (a.ref !== NONE_FIT && a.ref !== UNSAID && !a.heading?.trim() && cat.items.find((x) => x.ref === a.ref)?.params?.some((q) => q.heading)) out.push(`action ${i} has a subject or title and no \`heading\`: write a few plain words for it from the goal`);
    // A table or a new read can be WRITTEN to carry the address (joined in — `peopleInRows`); only a saved reader's rows are fixed.
    const field = a.recipient.field;
    if (a.recipient.from === "rows" && field && field !== RECIPIENT_FIELD_NONE) {
      const writable = p.sources.some((s) => s.ref.endsWith(".new_read") || s.ref.includes(".table."));
      if (field === RECIPIENT_FIELD_NA) out.push(`action ${i} goes to “${a.recipient.words}” from the rows: \`recipient.field\` names their address field, \`new_read\`, or \`none\``);
      else if (field === "new_read" ? !writable : !p.sources.some((s) => field.startsWith(`${s.ref}.`))) out.push(`action ${i}'s address field \`${field}\` is not ${field === "new_read" ? "a new read's" : "a field of a chosen source"}`);
    }
    // P7 (R15, 2026-10-07): people the goal NAMES are `rows` whether or not the data holds their address (`field` says which, or
    // `none`) — advising `unsaid` here turned "the customer's account manager" into nobody, and the email fell back to whoever
    // runs it. `goal` is ONLY a literal address the goal writes out (WRITTEN_ADDRESS): a named person, team, or role is `rows`.
    // No offered field is a question naming the remedy, never a refusal; several offered fields is a question naming them.
    if (a.recipient.from === "rows" && (field === RECIPIENT_FIELD_NONE || !field) && !p.sources.some((s) => cat.items.find((x) => x.ref === s.ref)?.fields?.some((f) => /\bAddress\b/.test(f.ty)) || s.ref.endsWith(".new_read") || s.ref.includes(".table.")))
      out.push(`action ${i} goes to “${a.recipient.words}” from the rows, but no chosen reader's rows carry an address — which address should carry them? Name its field in \`recipient.field\`, \`new_read\` when a written read returns it, or \`none\` when the rows hold no address for them`);
    if (a.recipient.from === "rows" && (field === RECIPIENT_FIELD_NONE || !field)) {
      const offered = p.sources.flatMap((s) => addressFields({ items: cat.items.filter((x) => x.ref === s.ref) }));
      if (offered.length > 1) out.push(`action ${i} goes to “${a.recipient.words}” from the rows, and several address fields are offered (${offered.slice(0, 4).map((f) => `\`${f}\``).join(", ")}) — which one holds THEIR address? Name it in \`recipient.field\`, or \`none\` when none does`);
    }
    if (a.recipient.from === "goal" && !WRITTEN_ADDRESS.test(a.recipient.words)) out.push(`action ${i}'s recipient “${a.recipient.words}” is not a literal address the goal writes out: people the goal names are \`rows\` — with \`field\` their address field (the chosen source's declared Address field, \`new_read\`, or \`none\`), never a nearby person's address by name`);
  });
  // A field compared with ANOTHER field: that field is one of the same rows (a chosen reader's, or the new read's).
  for (const t of [...p.rows, ...p.conditions.flatMap((c) => c.where)].filter((x) => x.against)) {
    // A summary measure (`summary:N`) is owned by the plan's summary — same rule as condition field checks (B20).
    const own = (f: string) => {
      const sm = /^summary:(\d)$/.exec(f);
      if (sm) return !!p.summary?.measures[Number(sm[1])];
      return f === "new_read" ? p.sources.some((x) => x.ref.endsWith(".new_read")) : p.sources.some((x) => cat.items.find((it) => it.ref === x.ref)?.fields?.some((fl) => `${x.ref}.${fl.name}` === f));
    };
    if (!own(t.against!)) out.push(`\`${t.against}\` (compared with ${t.field}) is not a field of a chosen source`);
  }
  p.conditions.forEach((c, i) => {
    if (!p.actions.some((a) => a.on === `if:${i}`)) out.push(`condition ${i} (${c.clauses.join(",")}) guards no action`);
    const chosen = new Set(p.sources.map((x) => x.ref));
    for (const w of c.where) {
      if (w.field === "new_read") { if (![...chosen].some((r) => r.endsWith(".new_read"))) out.push(`condition ${i} tests a new read's field with no new read chosen`); continue; }
      // A measure of the summary (`summary:N`) is the summary's, not a reader's (P7: refused here, the re-ask lost a right test — B20).
      const sm = /^summary:(\d)$/.exec(w.field);
      if (sm) { if (!p.summary?.measures[Number(sm[1])]) out.push(`condition ${i} tests ${w.field}, and the summary has no such measure`); continue; }
      const reader = w.field.slice(0, w.field.lastIndexOf("."));
      if (!chosen.has(reader)) out.push(`condition ${i} tests ${w.field}, whose reader is not a source`);

      const known = cat.items.find((x) => x.ref === reader)?.fields?.find((f) => `${reader}.${f.name}` === w.field)?.values;
      if (known && w.value && !known.includes(w.value)) out.push(`condition ${i}: “${w.value}” is not a value ${w.field} holds (${known.join(", ")})`);
    }
    if (!c.where.length && c.over === "each_item") out.push(`condition ${i} tests nothing on each item — the test that decides which action happens belongs in the condition, not in \`rows\``);
    const said = cs.map((x) => x.text.toLowerCase()).join(" ");
    for (const w of [...c.where, ...p.rows]) if (w.value && !w.against && !said.includes(w.value.toLowerCase())) out.push(`“${w.value}” is not in the goal's words: copy the value exactly as the goal says it`);
    if (c.over === "each_item" && c.where.some((w) => w.against)) out.push(`condition ${i} compares two fields of each item: that is a test of the rows — put it in \`rows\`, or test whether any row holds it`);
    if ((c.over === "row_count") !== !!c.count) out.push(`condition ${i}: a count goes with row_count, and only with it`);
    if (c.over === "each_item" && !p.each) out.push(`condition ${i} tests each item with no for-each`);
  });
  return out;
}

/**
 * builder-inputs P1-D4, at the plan: an input each test names exists; every input is USED (a test compares with it, a reader takes it,
 * or a written read is chosen to take it); and a condition that decides a per-item action tests the item — a test of the whole list
 * ("the list has rows") guarding an action done once per item holds for every item or none, so it decides nothing about any of them
 * (B1, 2026-10-03: "if they took leave that day … otherwise …" became exactly that, and both actions ran for everyone).
 */
export function inputFindings(p: Plan): string[] {
  const out: string[] = [];
  const ids = new Set((p.inputs ?? []).map((i) => i.id));
  const tests = [...p.rows, ...p.conditions.flatMap((c) => c.where)];
  for (const t of tests) if (t.input && t.input !== "none" && !ids.has(t.input)) out.push(`a test of ${t.field} compares with input ${t.input}, which is not in \`inputs\``);
  // P7 (P1-I3): an action that carries a number COMPUTED from the rows needs the summary that computes it — the plan states both, and
  // code holds them together (the rule alone was followed 10 of 10 on B07/B21; a plan that drops it is re-asked, never built as rows).
  p.actions.forEach((a, i) => { if (a.sends === "computed" && !p.summary?.measures.length) out.push(`action ${i} sends a number computed from the rows (\`sends: computed\`), and there is no \`summary\` saying what it computes`); });
  // P10 (bands, generic): a band_count measure names the banded field and at least one arm with a numeric edge and finite weight.
  (p.summary?.measures ?? []).forEach((m, i) => {
    if ((m.fn as string) !== "band_count") return;
    if (!m.field?.trim()) out.push(`summary measure ${i} counts by bands but names no field`);
    if (!m.bands?.length) out.push(`summary measure ${i} counts by bands with no bands: each band states its test, edge value and weight`);
    for (const [j, b] of (m.bands ?? []).entries()) {
      if (!b.value?.trim() || Number.isNaN(Number(b.value))) out.push(`summary measure ${i} band ${j} has no numeric edge value`);
      if (typeof b.then !== "number" || !Number.isFinite(b.then)) out.push(`summary measure ${i} band ${j} has no finite weight`);
    }
  });
  // P7 (E06): a test of a NEW read's field says what the field holds (`about`) — the read is written to return it, named from those
  // words; with none, the field cannot be named and the test (and every action on it) was dropped.
  for (const t of [...p.rows, ...p.conditions.flatMap((c) => c.where)]) if (t.field === "new_read" && !t.about?.trim()) out.push(`a test of a new read's field (${t.test}${t.value ? ` “${t.value}”` : ""}) says nothing of what the field holds: write it in \`about\``);
  // P7: the REST of a condition is the rows that do not pass a test of the rows; a test of each item has an `otherwise` instead.
  p.actions.forEach((a, i) => { const m = /^rest:(\d+)$/.exec(a.on); if (m && p.conditions[Number(m[1])]?.over === "each_item") out.push(`action ${i} runs on the rest of condition ${m[1]}, which tests each item: the others of a test of each item are \`otherwise\`; \`rest\` is for a test of the rows (\`any_row\`)`); });
  // P7 (R24): a for-each over GROUPS goes through the summary's groups — so the summary groups by something.
  if (p.each?.groups && !p.summary?.by.length) out.push(`the for-each goes through groups (\`each.groups\`), and the \`summary\` groups by nothing — name what it groups by in \`by\``);
  if (p.each?.groups && p.summary && p.each.over !== p.summary.over) out.push(`the for-each goes through the groups of source ${p.summary.over} (the summary's), not source ${p.each.over}`);
  for (const t of tests) { const i = (p.inputs ?? []).find((x) => x.id === t.input); if (i && !testFor(i.kind, t.test)) out.push(`the test “${t.test}” of ${t.field} cannot compare with input ${i.id} (a ${i.kind}): a ${i.kind} is compared by ${i.kind === "text" ? "equals or not_equals" : "equals, below, above, at_most or at_least"}`); }
  const written = p.sources.some((x) => isNewReadRef(x.ref));
  for (const i of p.inputs ?? []) if (!tests.some((t) => t.input === i.id) && (!i.fills || i.fills === FILLS_NONE) && !written)
    out.push(`input ${i.id} (“${i.words}”) is used by nothing: a test compares with it (\`input\`), or a reader takes it (\`fills\`)`);
  // builder-behaviour P1 (B22): a test of EACH item needs a for-each to be inside.
  p.conditions.forEach((c, k) => { if (c.over === "each_item" && !p.each) out.push(`condition ${k} (“${c.quote ?? ""}”) tests each item, and the goal has no for-each — a test of the rows as a whole is \`any_row\` (its actions take the rows that pass), and an action on the rows that do NOT pass is \`rest:${k}\``); });
  // builder-behaviour P1 (R4, B22): a test of a summary's measure needs that summary.
  for (const t of tests) { const m = /^summary:(\d)$/.exec(t.field); if (m && !p.summary?.measures[Number(m[1])]) out.push(`a test reads ${t.field}, and the plan's \`summary\` has no such measure — state the summary (what is computed, grouped by what), or test a field of the rows`); }
  // builder-behaviour P1 (R13, B04): on a schedule nobody starts the run, so nobody can give a value "each time it runs".
  if (p.schedule) for (const i of p.inputs ?? []) if (i.fill === "each_run")
    out.push(`input ${i.id} (“${i.words}”) is given each time it runs, and the automation runs on a schedule — nobody starts it to give a value: its \`fill\` is \`from_run_date\` (relative to the day it runs), or \`given\` (the goal states it)`);
  p.actions.forEach((a, k) => {
    const m = /^if:(\d+)$/.exec(a.on); const c = m ? p.conditions[Number(m[1])] : undefined;
    if (a.per_item && c && c.over !== "each_item" && c.over !== "row_count" && !c.where.length)
      out.push(`action ${k} runs for each item, and condition ${m![1]} (“${c.quote ?? ""}”) tests nothing about the item — a test of each item is \`each_item\` with the field that decides it (\`new_read\` with \`about\` when no listed field holds it)`);
  });
  return out;
}

const NEGATION: Record<string, string> = { above: "at_most", at_most: "above", below: "at_least", at_least: "below", equals: "not_equals", not_equals: "equals", is_true: "is_false", is_false: "is_true", is_empty: "not_empty", not_empty: "is_empty", date_passed: "date_not_passed", date_not_passed: "date_passed" };
// A date test keeps a value the goal states ("as of 30 june 2026"): it is the day compared with, in place of the run's own day.
const NO_VALUE = new Set(["is_true", "is_false", "is_empty", "not_empty"]);
/** A date test with a stated day is the ordering test against that day. */
const DATED: Record<string, string> = { date_passed: "below", date_not_passed: "at_least" };
type Test = { field: string; test: CondTest; value: string; against?: string; input?: string };
const testKey = (t: Test) => `${t.field} ${t.test} ${t.against ? `@${t.against}` : t.input ? `input:${t.input}` : t.value}`;

/**
 * One plan in its canonical form — each rule an EQUIVALENCE, so two plans that mean the same thing read the same:
 * - a test that takes no value carries none;
 * - a test every condition repeats is the rows the automation is about (`rows`), not a branch;
 * - the LAST condition, when it tests nothing left or is the exact negation of the only earlier one, is "otherwise";
 * - a for-each nothing is done for per item does nothing, and is dropped;
 * - a tool that reaches no person has no recipient (its declaration says so).
 */
/** The person who asked, in their own words ("me", "my inbox", "us"): the requester — language, not a workspace. */
const FIRST_PERSON = /^(me|myself|us|ourselves|(my|our)\b.*)$/i;
/** A clause that opens "otherwise" / "else" — but not "else if", which opens a condition of its own. */
const OTHERWISE = /^(otherwise|else(?!\s+if\b))\b/i;
/** An address, written out: an email, or a channel. */
const WRITTEN_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+|(^|\s)#[\w-]+/;

/** A test's `input`: `none`, empty, or an id no input has, is no input (the last is a finding, `planFindings`). */
const withInput = <T extends Test>(t: T): T => { if (t.input && t.input !== "none") return t; const { input: _drop, ...rest } = t; return rest as T; };

/** Step 4: the model's plan stands as written — code carries it through unchanged. */
export function normalisePlan(p0: Plan): Plan {
  return p0;
}

/** Coverage + liveness only — the model's band arms are source of truth.
 * Rejects arm sets that are structurally broken, whatever the weights:
 * (a) fewer than two arms, or any edge that is not a finite number;
 * (b) a DEAD arm — one whose covered values are all already covered by an
 * earlier arm in first-match order (a narrower `below` after a wider
 * `below` can never match). Weight order, magnitudes, decimal precision
 * and labels are never examined: a goal may put its heaviest weight on its
 * lowest band (or its lightest — the scale's direction is the model's).
 * Gaps are allowed — the emitted CASE has an `else`, so an uncovered value
 * counts 0 by the model's own design. Boundary membership (`below` vs
 * `at_most`, `at_least` vs `above`) is exact numeric comparison, not
 * tolerance: stated-precision neighbours are two different edges, and which
 * one first-matches is the model's choice.
 */
export function bandArmsConsistent(arms: BandArm[]): boolean {
  if (arms.length < 2) return false;
  type Span = { lo: number; loInc: boolean; hi: number; hiInc: boolean };
  const spanOf = (a: (typeof arms)[number]): Span | null => {
    const v = Number(a.value);
    if (!Number.isFinite(v)) return null;
    if (a.test === "below") return { lo: Number.NEGATIVE_INFINITY, loInc: false, hi: v, hiInc: false };
    if (a.test === "at_least") return { lo: v, loInc: true, hi: Number.POSITIVE_INFINITY, hiInc: false };
    if (a.test === "at_most") return { lo: Number.NEGATIVE_INFINITY, loInc: false, hi: v, hiInc: true };
    if (a.test === "above") return { lo: v, loInc: false, hi: Number.POSITIVE_INFINITY, hiInc: false };
    return { lo: v, loInc: true, hi: v, hiInc: true };
  };
  const spans = arms.map(spanOf);
  if (spans.some((s) => !s)) return false;
  // A later arm is dead when no value reaches it: sample below the smallest
  // edge, at each edge, between consecutive edges, and above the largest.
  // Each sample is owned by its first-matching arm (exact endpoint
  // comparison, no tolerance). An arm owning no sample is dead — every value
  // it covers is already covered by an earlier arm.
  const bounds = [...new Set(arms.map((a) => Number(a.value)))].sort((a, b) => a - b);
  const samples: number[] = [bounds[0]! - 1];
  for (let i = 0; i < bounds.length; i++) {
    samples.push(bounds[i]!);
    if (i + 1 < bounds.length) samples.push((bounds[i]! + bounds[i + 1]!) / 2);
  }
  samples.push(bounds[bounds.length - 1]! + 1);
  const covers = (s: Span, x: number): boolean =>
    (x > s.lo || (x === s.lo && s.loInc)) && (x < s.hi || (x === s.hi && s.hiInc));
  const ownedBy = new Set<number>();
  for (const x of samples) {
    for (let i = 0; i < arms.length; i++) {
      if (covers(spans[i]!, x)) { ownedBy.add(i); break; }
    }
  }
  for (let i = 0; i < arms.length; i++) {
    if (!ownedBy.has(i)) return false;
  }
  return true;
}






/**
 * The person's choice among readers that fit equally (`also`): every reference to `from` — the source's ref and each `from.<name>`
 * field or input — becomes `to`, in any structure (the plan, the spec lowered from it). Equal fit (`withAlternatives`) is what makes
 * a rename the whole change: the same fields, the same inputs.
 */
export function withReader<T>(x: T, from: string, to: string): T {
  const walk = (v: unknown): unknown => typeof v === "string" ? (v === from ? to : v.startsWith(`${from}.`) ? `${to}.${v.slice(from.length + 1)}` : v)
    : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, y]) => [k, walk(y)])) : v;
  return walk(x) as T;
}

/** The plan's STRUCTURE only — what must be the same on every run of one goal. Clause citations are left out (they may vary harmlessly). */
export function signature(p: Plan): string {
  const label = (s: Plan["sources"][number]) => (s.also?.length ? `one of ${[...new Set([s.ref, ...s.also])].sort().join(" | ")}` : s.ref);
  return JSON.stringify({
    sources: p.sources.map(label),
    each: p.each ? (p.sources[p.each.over] ? label(p.sources[p.each.over]!) : "?") : null,
    rows: p.rows.map((t) => `${t.field === "new_read" ? "new_read" : t.field.slice(t.field.lastIndexOf(".") + 1)} ${t.test} ${t.against ? `@${t.against.slice(t.against.lastIndexOf(".") + 1)}` : t.value}`.trim()).sort(),
    schedule: p.schedule?.cron ?? null,
    conditions: p.conditions.map((c) => `${c.over}[${c.where.map((w) => `${w.field === "new_read" ? "new_read" : w.field.slice(w.field.lastIndexOf(".") + 1)} ${w.test} ${w.value}`.trim()).sort().join(" & ")}]${c.count ? ` ${c.count.test} ${c.count.value}` : ""}`),
    actions: p.actions.map((a) => `${a.ref}@${a.on}${a.per_item ? "/each" : ""}${a.approve_first ? "+approve" : ""}→${a.recipient.from}`),
  });
}










/** The plan of one goal: one strict call, normalised, checked; asked again ONCE with exactly what it left wrong, kept if better. */
export async function makePlan(goal: string, cat: BuilderCatalogue, chooser: (prompt: string, schema: { name: string; schema: Schema }, label: string, model?: string, system?: string) => Promise<string>, parse: (schema: Schema, raw: string) => Plan, label = "builder:plan", edit?: PlanEdit, meanings: readonly string[] = []): Promise<{ plan: Plan; findings: string[]; asked: number }> {
  const cs = clauses(goal);
  const schema = planSchema(cat, cs, edit);
  // Strategy B Phase 2: optional skeleton→bind hint (`BUILDER_PLAN_STAGES=1`). Off by default — until stages
  // replace `goal_plan` they only add latency before the same full plan call.
  let stageAsked = 0;
  // S2: when stages are on, they REPLACE the monolith — skeleton→bind→assemble→normalise→findings, and only findings
  // the staged plan leaves wrong reach the full `goal_plan` (as its re-ask text, not a second whole plan). Off: today's path untouched.
  {
    const lines = cat.items.map((i) => `${i.ref} — ${i.about}`);
    try {
      const staged = await planStages(goal, lines, chooser);
      if (staged) {
        stageAsked = staged.calls;
        const { assembleStagedPlan } = await import("./plan-stages.js");
        const { INPUT_IDS } = await import("./inputs.js");
        const assembled = normalisePlan(assembleStagedPlan(staged.skeleton, staged.bind, cat, cs, { inputIds: INPUT_IDS }));
        const stagedFindings = planFindings(assembled, cs, cat, meanings);
        if (!stagedFindings.length) return { plan: assembled, findings: [], asked: stageAsked };
        if (stagedFindings.every((x) => x.startsWith(ADVISORY_PREFIX))) return { plan: assembled, findings: [], asked: stageAsked };
        // The staged plan stands where it is whole; only its complaints fall through to the full call, as the re-ask text.
        const prompt = planPrompt(goal, cat, cs, edit) + (meanings.length ? `\n\nWHAT THE PERSON SAID THEIR WORDS MEAN (their answers to questions about the GOAL). Read those words of the GOAL this way when you choose sources and fill values. They are not further parts of the goal: they add no clause — but the words they explain still need the part that carries them out.\n${meanings.map((m) => `- ${m}`).join("\n")}` : "");
        const full = normalisePlan(parse(schema, await chooser(`${prompt}\n\nAN EARLIER PASS LEFT THIS WRONG — answer again, fixing exactly this:\n${stagedFindings.map((x) => `- ${x}`).join("\n")}`, { name: "goal_plan", schema }, label, undefined, PLAN_SYSTEM)));
        const f2 = planFindings(full, cs, cat, meanings);
        const better = f2.length < stagedFindings.length;
        const kept = better ? full : assembled;
        return { plan: kept, findings: (better ? f2 : stagedFindings).filter((x) => !x.startsWith(NONE_FIT_FINDING) && !x.startsWith(ADVISORY_PREFIX)), asked: 1 + stageAsked };
      }
    } catch {
      // Staged failure must not block the full plan — fall through.
    }
  }
  let stageHint = "";
  // MEM2/MEM5 (2026-10-06): the person's answers about what their words mean are read as meanings — they add no clause, but the
  // words they explain still need the part that carries them out.
  const prompt = planPrompt(goal, cat, cs, edit) + stageHint + (meanings.length ? `\n\nWHAT THE PERSON SAID THEIR WORDS MEAN (their answers to questions about the GOAL). Read those words of the GOAL this way when you choose sources and fill values. They are not further parts of the goal: they add no clause — but the words they explain still need the part that carries them out.\n${meanings.map((m) => `- ${m}`).join("\n")}` : "");
  const first = normalisePlan(parse(schema, await chooser(prompt, { name: "goal_plan", schema }, label, undefined, PLAN_SYSTEM)));
  const f1 = planFindings(first, cs, cat, meanings);
  if (!f1.length) return { plan: first, findings: [], asked: 1 + stageAsked };
  // LATENCY (flow 77db92ec): the re-ask costs a full second plan call (23–30s live) and clears nothing when every finding is
  // structural — no clause cited, nothing the model could fix by re-answering (unbuildable bands, missing slots). Findings that
  // name a clause (`C\d+`) may clear on retry; purely structural ones are stated, never re-asked.
  const fixable = f1.some((f) => /^C\d+ /.test(f) || f.startsWith(NONE_FIT_FINDING));
  if (!fixable) return { plan: first, findings: f1.filter((x) => !x.startsWith(NONE_FIT_FINDING) && !x.startsWith(ADVISORY_PREFIX)), asked: 1 + stageAsked };
  const again = normalisePlan(parse(schema, await chooser(`${prompt}\n\nYOUR LAST ANSWER LEFT THIS WRONG — answer again, fixing exactly this:\n${f1.map((x) => `- ${x}`).join("\n")}`, { name: "goal_plan", schema }, `${label}:again`, undefined, PLAN_SYSTEM)));
  const f2 = planFindings(again, cs, cat, meanings);
  // P2 (RC-3): the `none_fit`-with-candidates question is asked by this ONE re-ask and never again — a `none_fit` that persists
  // is accepted, so its marker never leaves here as a gap (the other findings stand, exactly as before).
  const better = f2.length < f1.length;
  const kept = better ? again : first;
  // Advisory-only findings never persist as plan gaps: the note is already stated (`planToSpec` notes), so nothing
  // persists as unfinished without an askable question — same precedent as the `none_fit` marker above.
  return { plan: kept, findings: (better ? f2 : f1).filter((x) => !x.startsWith(NONE_FIT_FINDING) && !x.startsWith(ADVISORY_PREFIX)), asked: 2 + stageAsked };
}

// ── Lowering: the plan as the GoalSpec + Wiring the solver already builds from ─────────────────────────────────────────────────

/** The value role an input carries to a parameter — the role `readContract` and the readback already know. */
const ROLE_OF_KIND: Record<SpecInput["kind"], GoalSpec["values"][number]["role"]> = { date: "date", date_range: "period", month: "period", number: "threshold", text: "other" };
const CMP: Partial<Record<string, WiringCmp>> = { above: "gt", at_least: "ge", below: "lt", at_most: "le", equals: "eq", not_equals: "ne" };
const isNew = (ref: string) => ref.endsWith(".new_read");

/** The first input a tool's declaration marks an address, among its listed params — where a recipient goes. */
export function addressPort(cat: BuilderCatalogue, ref: string): string | undefined {
  const item = cat.items.find((i) => i.ref === ref);
  if (!item) return undefined;
  // In the DECLARATION's order (a send's `to` before its `cc`), among the params the catalogue lists.
  const ports = declarationOf(ref, item.params ?? []).ports ?? {};
  const listed = new Set((item.params ?? []).map((p) => p.name));
  return Object.entries(ports).find(([n, d]) => d.address && listed.has(n))?.[0];
}

/**
 * The plan, lowered by code. Every quote is a clause's own text (a substring of the person's words, so `checkSpec` admits it);
 * every condition becomes a shape the engine filters with and a path the wiring states; a new read's tests are ITS contract (values
 * it takes), never the flow's. Returns the spec and the lines the person should read beside it (readers that fit equally).
 */
/** A fact's column name, by code, from the plan's words for it — an identifier, never a column looked for in the schema. */
export const factName = (about: string) => about.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40).replace(/_$/, "") || "fact";

/**
 * Run-month period: the model states `kind: month` + `fill: from_run_date` + `relative`
 * on the plan's inputs directly. No code miner rewrites the plan from the goal's
 * words (`augmentPlanInputsFromGoal`, deleted).
 */
export function planToSpec(plan: Plan, cs: Clause[], cat: BuilderCatalogue, text0?: string, edit?: PlanEdit): { spec: GoalSpec; notes: string[] } {
  let p = plan;
  const text = (ids: string[], fallback = cs[0]?.text ?? "") => cs.find((c) => ids.includes(c.id))?.text ?? fallback;
  // A part's own quote when it is the person's words; else the text of the clause it implements (always theirs).
  // Against the person's own text — clauses lose the punctuation they were split at.
  const said = (text0 ?? cs.map((c) => c.text).join(" ")).toLowerCase();
  const q = (quote: string | undefined, ids: string[], fallback?: string) => (quote?.trim() && said.includes(quote.trim().toLowerCase()) ? quote.trim() : text(ids, fallback));
  const notes: string[] = [];
  // A TABLE whose rows are about the people sent to becomes a read WRITTEN for the goal (H06: a table's types say a field is an
  // address, never whose) — decided here, so the plan's tests on it are the read's from the start. Its fields keep their names.
  const toRows = p.actions.some((a) => a.recipient.from === "rows" && addressPort(cat, a.ref));
  // builder-behaviour P1 (R4): a SUMMARY over a table is computed by a read written for it — never by the flow over capped rows.
  const summarised = p.summary?.measures.length ? p.sources[p.summary.over]?.ref : undefined;
  const written = (ref: string) => { if (!(toRows || ref === summarised) || !ref.includes(".table.")) return ref; const nr = newReadOf(ref.slice(0, ref.indexOf(".table."))); return cat.items.some((i) => i.ref === nr) ? nr : ref; };
  const moved = new Map(p.sources.map((s) => [s.ref, written(s.ref)]));
  const field = (f: string) => { for (const [from, to] of moved) if (from !== to && f.startsWith(`${from}.`)) return `${to}.${f.slice(from.length + 1)}`; return f; };
  p = { ...p, sources: p.sources.map((s) => ({ ...s, ref: moved.get(s.ref)! })), rows: p.rows.map((t) => ({ ...t, field: field(t.field) })), conditions: p.conditions.map((c) => ({ ...c, where: c.where.map((w) => ({ ...w, field: field(w.field) })) })),
    ...(p.summary ? { summary: { ...p.summary, by: p.summary.by.map((b) => ({ ...b, field: field(b.field) })), measures: p.summary.measures.map((m) => ({ ...m, field: field(m.field) })) } } : {}) };
  // builder-behaviour P1 (R20): a test on a TABLE field of a datasource whose rows come from a read WRITTEN for the goal (and not from
  // that table itself) is the written read's own test — the read is written over those tables (B10: "8 hours" on
  // `attendance_day.hours_worked` was a flow filter on a table no step reads, so the read took no parameter for it and refused).
  const writtenRef = (f: string) => {
    if (!f.includes(".table.")) return undefined;
    const table = f.slice(0, f.lastIndexOf("."));
    if (p.sources.some((s) => s.ref === table)) return undefined;
    const ds = f.slice(0, f.indexOf(".table."));
    return p.sources.find((s) => isNewReadRef(s.ref) && s.ref.startsWith(`${ds}.`))?.ref;
  };
  // ONE form from here on: such a table field IS the written read's field of the same name (its column, which the read returns).
  const toRead = (f: string) => { const wr = writtenRef(f); return wr ? `${wr}.${f.slice(f.lastIndexOf(".") + 1)}` : f; };
  // A fact the read does not have yet ("new_read", with what it holds) is named once, here, by code — a column of the ONE written read.
  const writtenOnly = p.sources.filter((x) => isNewReadRef(x.ref));
  // P7 (E06): a test of EACH ITEM is a test of the for-each's own rows — with two new reads, its fact is the loop's read's column.
  const loopRead = p.each ? p.sources[p.each.over]?.ref : undefined;
  const named = (f: string, about?: string, item = false) => (f === "new_read" && about?.trim()
    ? (writtenOnly.length === 1 ? `${writtenOnly[0]!.ref}.${factName(about)}` : item && loopRead && isNewReadRef(loopRead) ? `${loopRead}.${factName(about)}` : toRead(f))
    : toRead(f));
  const mapT = <X extends { field: string; against?: string; about?: string }>(t: X, item = false): X => ({ ...t, field: named(t.field, t.about, item), ...(t.against ? { against: toRead(t.against) } : {}) });
  p = { ...p, rows: p.rows.map((t) => mapT(t)), conditions: p.conditions.map((c) => ({ ...c, where: c.where.map((t) => mapT(t, c.over === "each_item")) })),
    ...(p.summary ? { summary: { ...p.summary, by: p.summary.by.map((b) => ({ ...b, field: named(b.field, b.words) })), measures: p.summary.measures.map((m) => ({ ...m, field: toRead(m.field) })) } } : {}) };
  // builder-behaviour P1 (R4): the summary. Its measures are named by code; a test of one (`summary:N`) is the FLOW's — never the read's
  // own filter. On a written read it is a column the read returns; on a saved reader, the measure of the group stage placed below.
  let sum = p.summary?.measures.length ? p.summary : null;
  const sumRef = sum ? p.sources[sum.over]?.ref : undefined;
  // builder-behaviour P1 (R4, B21): rows ALSO used one by one (a for-each over them, an action per item) are kept as they are; the
  // summary is then the FLOW's own list over those same rows — never a read that returns only the summary, which leaves the loop
  // nothing to go through. Otherwise a written read computes it.
  // P7 (R24): a for-each over the summary's GROUPS goes through the summary's own rows — one per group — never the rows summarised
  // (B20: "for each team count …; if a team has more than 5 email its contact the list" looped over the TICKETS). The flow groups,
  // so each group can carry what an action per group reads: the address its recipient names, and its own rows when it sends them.
  const groupsLoop = !!sum && !!p.each?.groups && sum.by.length > 0 && p.each.over === sum.over;
  const rowsUsed = !!sum && !groupsLoop && (p.each?.over === sum.over || p.actions.some((a) => a.per_item));
  const sumWritten = !!sumRef && isNewReadRef(sumRef) && !rowsUsed && !groupsLoop;
  // Over a written read's rows, a measure of a column it has not named yet is a column it returns. The model states the
  // column (`ref.field`, a table column, or `new_read` with what it holds); code resolves it against the schema — never
  // a slug of the measure's words, which names no column and fails the emit. Slug naming is the last resort only.
  const schemaCol = (ds: string, f: string): string | null => {
    const bare = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
    if (!bare || bare === "new_read" || bare === "any") return null;
    const hit = cat.items.find((i) => i.kind === "reader" && i.ref.startsWith(`${ds}.`) && (i.fields ?? []).some((x) => x.name.toLowerCase() === bare));
    return hit ? `${sumRef}.${bare}` : null;
  };
  if (sum && sumRef && isNewReadRef(sumRef) && (rowsUsed || groupsLoop)) sum = { ...sum, measures: sum.measures.map((m) => {
    if (m.fn === "count" || m.field.startsWith(`${sumRef}.`)) return m;
    const ds = sumRef.slice(0, sumRef.indexOf("."));
    return { ...m, field: schemaCol(ds, m.field) ?? `${sumRef}.${factName(m.words)}` };
  }) };
  const bareF = (f: string) => f.slice(f.lastIndexOf(".") + 1);
  const ownField = (f: string) => !!sumRef && f.startsWith(`${sumRef}.`);
  const mNames: string[] = [];
  // A written read's measure of a column it has not named yet is named from the plan's WORDS for it; the read chooses the column.
  for (const m of sum?.measures ?? []) { const b = m.fn === "count" && !ownField(m.field) ? "count" : ownField(m.field) ? `${m.fn}_${bareF(m.field)}` : `${m.fn}_${factName(m.words).slice(0, 30).replace(/_$/, "")}`; let n = b; for (let k = 2; mNames.includes(n); k++) n = `${b}_${k}`; mNames.push(n); }
  const SUM_RE = /^summary:(\d)$/;
  if (sum && sumWritten) {
    const toCol = (f: string) => { const m = SUM_RE.exec(f); return m && mNames[Number(m[1])] ? `${sumRef}.${mNames[Number(m[1])]}` : f; };
    p = { ...p, rows: p.rows.map((t) => ({ ...t, field: toCol(t.field) })), conditions: p.conditions.map((c) => ({ ...c, where: c.where.map((w) => ({ ...w, field: toCol(w.field) })) })) };
  }
  const isMeasure = (f: string) => SUM_RE.test(f) || (sumWritten && mNames.some((n) => f === `${sumRef}.${n}`));
  const onRead = (f: string) => !isMeasure(f) && (f === "new_read" || p.sources.some((s) => isNewReadRef(s.ref) && f.startsWith(`${s.ref}.`)) || !!writtenRef(f));
  // builder-behaviour P1 (R21): a condition's test goes INTO a written read only when it alone decides which rows matter ("if anyone
  // took 3 or more … email them": those rows ARE the read's). Two or more conditions on the rows are a chain — each its OWN test of the
  // rows the read returns: the flow applies each, and the read returns the columns they test (B17: "above 80 … else if under 20%" both
  // went into the read, and the else-if could never be reached).
  const chained = p.conditions.filter((c) => c.over !== "each_item" && c.where.length).length > 1;
  // A condition an action takes the REST of DIVIDES its rows into those that pass and those that do not: the flow applies its test
  // (a test the read applied would drop the rest, which an action is waiting for). Said once — the read's tests, the flow's tests and
  // the condition's own `where` all read it (2026-10-04: "if a contract auto-renews … if it doesn't …" put the test in the read, and
  // the split then had no test to divide by).
  const dividing = (ci: number) => p.actions.some((a) => a.on === `rest:${ci}`);
  // builder-inputs P1-D3: WHERE each input goes is code's. A test on a saved reader's or a table's field → a flow filter against it; a
  // reader's own parameter → that parameter's value; else, with a read written for the goal → a parameter of that read; else nothing.
  const allTests = [...p.rows, ...p.conditions.flatMap((c) => c.where)];
  // A test the FLOW applies — to each item of the for-each, or one of a chain — is the flow's whatever field it reads: the read returns
  // that field, and the flow compares it (2026-10-04: "if one is over 10,000 …, otherwise …" on each invoice gave the read a
  // `threshold` parameter as well, which was then asked, and the input was "used by nothing").
  const flowTests = new Set(p.conditions.filter((c, ci) => c.over === "each_item" || dividing(ci) || (chained && c.where.length)).flatMap((c) => c.where));
  const writes = p.sources.some((s) => isNewReadRef(s.ref));
  const specInputs: SpecInput[] = (p.inputs ?? []).map((i) => {
    const at: InputAt = allTests.some((t) => t.input === i.id && (!onRead(t.field) || flowTests.has(t))) ? "flow" : i.fills ? "reader" : writes ? "read" : "none";
    return { id: i.id, kind: i.kind, words: i.words, fill: i.fill, ...(i.relative ? { relative: i.relative } : {}), ...(i.days ? { days: i.days } : {}), ...(i.fills ? { fills: i.fills } : {}), at };
  });
  const planGaps: string[] = inputFindings(p);
  // An EDIT's source that IS an existing list is not read again: its rows are that step (`step:<id>`), filtered by shapes over its reader.
  const exList = (s: Plan["sources"][number]) => (s.list && s.list !== "new" && edit?.existing.lists.some((l) => l.key === s.list) ? s.list as ListKey : undefined);
  const specIx: number[] = [];
  const sources: Array<{ ref: string; quote: string }> = [];
  p.sources.forEach((s, i) => { if (exList(s)) return; specIx[i] = sources.length; sources.push({ ref: s.ref, quote: q(s.quote, s.clauses) }); });
  const values: GoalSpec["values"] = (p.values ?? []).filter((v) => v.quote.trim() || v.from === "requester").map((v) => ({ role: v.role as GoalSpec["values"][number]["role"], from: v.from as GoalSpec["values"][number]["from"], quote: v.quote, fills: v.fills, ...(v.named ? { named: true } : {}), ...(v.as?.trim() ? { as: v.as.trim() } : {}) }));
  // An input a reader or a written read takes travels as a VALUE of that parameter (its fill says how it is given) — the path every
  // reader parameter already takes to its port. A flow input travels in the filter stages that name it (`input:<id>`).
  for (const i of specInputs) if (i.at === "reader" || i.at === "read") values.push({ role: ROLE_OF_KIND[i.kind], from: i.fill === "given" ? "goal" : "flow_input", quote: i.words, fills: i.at === "reader" ? i.fills! : FILLS_NONE, input: i.id, ...(i.relative ? { relative: i.relative } : {}), ...(i.days ? { days: i.days } : {}) });
  const shapes: Shape[] = [];
  const srcOf = (f: string) => (sum && SUM_RE.test(f) ? sum.over : p.sources.findIndex((s) => f.startsWith(`${s.ref}.`) || (f === "new_read" && isNew(s.ref))));
  // A saved reader's summary is the flow's group stage (its own SQL cannot be changed): placed after the rows' tests, then its order
  // and how many it keeps. A test of a measure there reads the group's output (`stage:<g>:<N>`).
  let sumGroup = -1;
  // A WRITTEN read groups and measures in SQL (its contract); its ORDER and how many it keeps are the flow's, over the read's grouped
  // rows — the read's form cannot sort by an aggregate (B09), and the groups are few. A saved reader's summary is all the flow's.
  const sumStages = (base: number): Stage[] => {
    if (!sum || !sumRef) return [];
    const quote = q(sum.quote, sum.clauses);
    const st: Stage[] = [];
    if (!sumWritten) {
      sumGroup = base;
      // P7 (R24): what each group carries for the actions done per group — the address field each recipient names, and its rows.
      const perGroup = groupsLoop ? p.actions.filter((a) => a.per_item) : [];
      const carry = [...new Set(perGroup.flatMap((a) => (a.recipient.from === "rows" && a.recipient.field && ownField(a.recipient.field) ? [a.recipient.field] : [])))];
      const rows = perGroup.some((a) => a.sends === "rows");
      st.push({ op: "group", quote, by: sum.by.map((b) => b.field).filter(ownField), measures: sum.measures.filter((m) => (m.fn as string) !== "band_count").map((m) => ({ fn: m.fn as (typeof SUMMARY_FNS)[number], field: ownField(m.field) ? m.field : null })), ...(carry.length ? { carry } : {}), ...(rows ? { rows: true } : {}) });
    }
    if (sum.sort) { const m = /^summary:(\d)$/.exec(sum.sort.by), k = /^key:(\d)$/.exec(sum.sort.by); const f = m ? (sumWritten ? `${sumRef}.${mNames[Number(m[1])]}` : `stage:${base}:${m[1]}`) : k ? sum.by[Number(k[1])]?.field : undefined; if (f) st.push({ op: "sort", quote, field: f, dir: sum.sort.dir }); }
    if (sum.limit.trim()) st.push({ op: "limit", quote, value: sum.limit.trim() });
    return st;
  };
  const measureRef = (f: string) => { const m = SUM_RE.exec(f); return m && sumGroup >= 0 ? `stage:${sumGroup}:${m[1]}` : f; };
  // Step 4: the model's test comparison types the value — a NUMBER comparison's
  // unstated value is a named threshold; anything else rides the test's own kind.
  const roleOf = (t: { test: string }): GoalSpec["values"][number]["role"] =>
    NUMBER_TESTS.has(t.test) ? "threshold" : "other";
  const stage = (t: Test & { clauses?: string[] }, fallback: string): Stage => ({ op: "filter", quote: text(t.clauses ?? [], fallback), field: measureRef(t.field), test: t.test as CondTest, value: t.input ? `input:${t.input}` : t.value || null, ...(t.against ? { against: t.against } : {}) });
  // A new read's tests are what it is written to give: each a value it takes (`fills: none`, the contract's parameters), its words covered.
  // A test on a written read's rows that the flow does not compare itself (the rows at all, or whether any row holds) is the read's.
  const readTests = [...p.rows, ...(chained ? [] : p.conditions.filter((c, ci) => c.over !== "each_item" && !dividing(ci)).flatMap((c) => c.where))].filter((t) => onRead(t.field));
  for (const t of readTests) {
    if (t.input) continue; // an input the read is chosen by is already its parameter (above)
    // builder-behaviour P1 (R9, B20): "older than 3 days" / "within 7 days" on the READ's field compares a date with the day N days
    // before the run day — a date the read takes, worked out when it runs (the flow filters' own rule, `daysBefore`), never a number.
    const nDays = (t.test === "older_than_days" || t.test === "within_days") ? Number(/\d+/.exec(t.value)?.[0] ?? NaN) : NaN;
    if (Number.isInteger(nDays) && nDays > 0) {
      const id = ["in_x", "in_y", "in_z"].find((x) => !specInputs.some((i) => i.id === x));
      if (id) {
        const words = text((t as { clauses?: string[] }).clauses ?? [], t.value);
        specInputs.push({ id, kind: "date", words, fill: "from_run_date", relative: "days_ago", days: nDays, at: "read" });
        values.push({ role: "date", from: "flow_input", quote: words, fills: FILLS_NONE, input: id, relative: "days_ago", days: nDays });
      }
      continue;
    }
    // A comparison with another field of the rows is the read's own rule, never a value it takes (FL02: "below its class minimum").
    // a NUMBER comparison with no value at all ("below the threshold", the value left empty) is the same named number,
    // quoted by its clause's words.
    if (!t.against && !t.value.trim() && NUMBER_TESTS.has(t.test)) {
      const words = text((t as { clauses?: string[] }).clauses ?? [], "");
      if (words.trim() && !values.some((v) => v.named && v.role === "threshold")) values.push({ role: "threshold", from: "goal", quote: words, fills: FILLS_NONE, named: true });
      continue;
    }
    if (t.against || !t.value.trim() || values.some((v) => v.quote.trim().toLowerCase() === t.value.trim().toLowerCase())) continue;
    // builder-behaviour P1 (B21): a read's PARAMETER is a value the person stated; one the goal's words do not hold ("no applications"
    // written as 0) is the read's own fixed rule — never a question put to the person for a number they never said.
    if (!said.includes(t.value.trim().toLowerCase())) continue;
    // the value of a NUMBER comparison that holds no number ("below threhold percentage") is a number the goal names
    // and does not give — the read takes it as a number input, and the person is asked for it. Known by the comparison, not the words.
    const named = NUMBER_TESTS.has(t.test) && roleOf(t) === "other";
    values.push({ role: named ? "threshold" : roleOf(t), from: "goal", quote: t.value, fills: FILLS_NONE, ...(named ? { named: true } : {}) });
  }
  // The rows each source contributes, after the tests that say which rows the goal is about at all.
  let sumList: ListKey | undefined;
  const listOf: ListKey[] = p.sources.map((s, i) => {
    const tests = p.rows.filter((t) => !onRead(t.field) && srcOf(t.field) === i);
    // The rows' tests, then a flow summary, then the tests of its measures (they read the summary's rows).
    const pre = tests.filter((t) => !isMeasure(t.field)), post = tests.filter((t) => isMeasure(t.field));
    const summed = sum && sum.over === i ? sumStages(pre.length) : [];
    const preSt = pre.map((t) => stage(t, q(s.quote, s.clauses)));
    if (summed.length && rowsUsed) {
      // Two lists: the rows (what the loop goes through), and their summary (what a once-only action or a test of a measure reads).
      shapes.push({ over: s.ref, stages: [...preSt, ...summed, ...post.map((t) => stage(t, q(s.quote, s.clauses)))] });
      sumList = `list:${shapes.length - 1}` as ListKey;
      if (!preSt.length) return exList(s) ?? `reader:${specIx[i]}` as ListKey;
      shapes.push({ over: s.ref, stages: preSt });
      return `list:${shapes.length - 1}` as ListKey;
    }
    if (!pre.length && !summed.length && !post.length) return exList(s) ?? `reader:${specIx[i]}` as ListKey;
    shapes.push({ over: s.ref, stages: [...preSt, ...summed, ...post.map((t) => stage(t, q(s.quote, s.clauses)))] });
    if (summed.length) sumList = `list:${shapes.length - 1}` as ListKey;
    return `list:${shapes.length - 1}` as ListKey;
  });
  const paths: WiringPath[] = [];
  const pathList: Array<ListKey | "item"> = [];
  p.conditions.forEach((c, ci) => {
    const quote = q(c.quote, c.clauses);
    const where = c.over === "each_item" ? c.where.filter((w) => w.field !== "new_read") : chained || dividing(ci) ? c.where.filter((w) => w.field !== "new_read") : c.where.filter((w) => !onRead(w.field));
    // A test of each item that cannot be built is stated, never dropped in silence (P1-D4): a field the written read does not have
    // yet (phase 2 names it in the read's contract), or an input compared per item (not lowered yet).
    // builder-behaviour P1 (R5): a test of each item on a fact the read does not have yet ("the candidate has an interview") is a
    // COLUMN the written read must return — named by code from the plan's words for it, and the read's contract requires it. Without
    // ONE written read to return it, it is stated unbuilt.
    const written = p.sources.filter((s) => isNewReadRef(s.ref));
    const factOf = (w: Plan["conditions"][number]["where"][number]) => {
      if (w.field === "new_read") return written.length === 1 && w.about.trim() ? `${written[0]!.ref}.${factName(w.about)}` : w.field;
      const wr = writtenRef(w.field); // a table column of the written read's datasource: a column the read returns (R20)
      return wr ? `${wr}.${w.field.slice(w.field.lastIndexOf(".") + 1)}` : w.field;
    };
    const itemWhere = c.over === "each_item" ? c.where.map((w) => ({ ...w, field: factOf(w) })) : c.where;
    if (c.over === "each_item") for (const w of itemWhere) if (w.field === "new_read") planGaps.push(`the test “${quote}” on each item is not built — it needs ${w.about ? `“${w.about}”` : "a field"} the read does not return`);
    // P7 (B16): the same for a test of the ROWS in a chain — a test that names no column is stated, never dropped (dropped, the branch
    // tested "the list has rows" of EVERY row, and each arm ran for all of them).
    if (c.over !== "each_item" && chained) for (const w of c.where) if (w.field === "new_read") planGaps.push(`the test “${quote}” is not built — it needs ${w.about ? `“${w.about}”` : "a field"} the read does not return`);
    if (c.over === "each_item") {
      const where = itemWhere.filter((w) => w.field !== "new_read");
      const w = where[0];
      const cmp = w ? CMP[w.test] : undefined;
      // builder-behaviour P1 (R10): EVERY test of the item, as the plan states it — never only the first.
      const bareOf = (f: string) => f.slice(f.lastIndexOf(".") + 1);
      // A measure of a saved reader's summary is named as the group stage names it; of a written read, it is already its column.
      const groupNames = sumGroup >= 0 ? stageNames(shapes.find((sh) => sh.over === sumRef && sh.stages[sumGroup]?.op === "group")?.stages ?? [])[sumGroup] ?? [] : [];
      const itemField = (f: string) => { const m = SUM_RE.exec(f); return m ? groupNames[Number(m[1])] ?? f : bareOf(f); };
      const all = where.map((t) => ({ field: itemField(t.field), test: t.test, ...(t.value?.trim() ? { value: t.value } : {}), ...(t.against ? { against: bareOf(t.against) } : {}), ...(t.input ? { input: t.input } : {}), ...(t.about?.trim() ? { about: t.about.trim() } : {}) }));
      paths.push({ quote, subject: "item", test: "compare", ...(w ? { measure: bareOf(w.field) } : {}), ...(cmp ? { cmp } : {}), ...(w?.value ? { value: w.value } : {}), ...(all.length ? { where: all } : {}) });
      pathList.push("item");
      return;
    }
    const i = Math.max(0, where.length ? srcOf(where[0]!.field) : 0);
    // A test of a summary's measure reads the summary's list (its rows are the groups).
    let subject: ListKey = sumList && where.some((w) => isMeasure(w.field)) ? sumList : listOf[i] ?? "reader:0";
    // builder-behaviour P1 (B22): an action on `rest:N` makes condition N a SPLIT of its list — the rows that pass, and the rest —
    // the engine's own split, on ONE field compared with ONE value. Anything else is stated unbuilt, never a near miss.
    if (p.actions.some((a) => a.on === `rest:${ci}`)) {
      const w = where[0];
      // A yes/no test splits as its field equals true / false ("if a contract auto-renews … if it doesn't", 2026-10-04: refused as
      // "not one value the goal states" — the value IS the test).
      const yesNo = w?.test === "is_true" ? "true" : w?.test === "is_false" ? "false" : undefined;
      const cmp = w ? (yesNo ? "eq" as const : CMP[w.test]) : undefined;
      const given = w?.input ? p.inputs?.find((x) => x.id === w.input && x.fill === "given")?.words : undefined;
      const value = yesNo ?? (w?.value?.trim() || given);
      if (where.length !== 1 || !cmp || !value) { planGaps.push(`“${quote}” divides the rows into the ones that pass and the rest only by ONE field compared with ONE value the goal states`); pathList.push(subject); paths.push({ quote, subject, test: "any" }); return; }
      const sumNames = SUM_RE.test(w!.field) && sumList ? stageNames(shapes[Number(sumList.slice(5))]!.stages)[sumGroup] ?? [] : [];
      const measure = SUM_RE.test(w!.field) ? sumNames[Number(SUM_RE.exec(w!.field)![1])] ?? w!.field : bareF(w!.field);
      paths.push({ quote, subject, test: "split", measure, cmp, value, ...(given && !w!.value?.trim() ? { input: w!.input } : {}) });
      pathList.push(subject);
      return;
    }
    if (where.length) {
      const base = subject.startsWith("list:") ? shapes[Number(subject.slice(5))]!.stages : [];
      shapes.push({ over: p.sources[i]!.ref, stages: [...base, ...where.map((w) => stage({ ...w, clauses: c.clauses }, quote))] });
      subject = `list:${shapes.length - 1}`;
    }
    pathList.push(subject);
    if (c.over === "row_count" && c.count) paths.push({ quote, subject, test: "compare", measure: "count", ...(CMP[c.count.test] ? { cmp: CMP[c.count.test] } : {}), value: c.count.value });
    else paths.push({ quote, subject, test: c.over === "no_row" ? "none" : "any" });
  });
  // An action on an existing path of the automation: that path (`in:<id>`), once, as the wiring states one.
  for (const a of p.actions) if (a.on.startsWith("in:") && !paths.some((x) => x.subject === a.on)) { paths.push({ quote: q(a.quote, a.clauses), subject: a.on as WiringPath["subject"], test: "any" }); pathList.push(a.on as ListKey); }
  const eachList = p.each ? (groupsLoop ? sumList : listOf[p.each.over]) : undefined;
  const sinks = p.actions.map((a) => ({ ref: a.ref, quote: a.ref === UNSAID && !a.quote?.trim() ? "" : q(a.quote, a.clauses, text(a.approve_first?.clauses ?? [])) }));
  // Terminal `otherwise` (2026-10-08): a single terminal action on `otherwise` with zero conditions has no branch
  // to be the alternative to — the goal's words already place it, so it runs always. Structural only
  // (`isTerminalOtherwiseAdvisory`): branching `otherwise` (conditions exist) still lowers as `otherwise` and blocks.
  const terminalOtherwise = isTerminalOtherwiseAdvisory(p);
  const actions: Wiring["actions"] = p.actions.map((a) => {
    const m = /^if:(\d+)$/.exec(a.on);
    const rest = /^rest:(\d+)$/.exec(a.on);
    const inPath = a.on.startsWith("in:") ? paths.findIndex((x) => x.subject === a.on) : -1;
    const path: ActionPath = terminalOtherwise ? null : m ? Number(m[1]) : rest ? `rest:${Number(rest[1])}` : inPath >= 0 ? inPath : a.on === "otherwise" ? "otherwise" as const : null;
    const on = m ? pathList[Number(m[1])] : rest ? pathList[Number(rest[1])] : undefined;
    // An existing list or text an action names is what it takes — unless it runs on a condition this plan states: then it acts on
    // that condition's rows (they ARE the named rows, tested), never the whole list again (E02: "when any are high risk also email
    // …" took every clause the automation reads). Prepared text (a producer) is not rows, and is taken as named.
    const named = a.takes && a.takes !== "auto" && !(on && on !== "item" && edit?.existing.lists.some((l) => l.key === a.takes)) ? a.takes : undefined;
    const takes = named ? named as ListKey
      : a.per_item && eachList ? "item" as const
      : on && on !== "item" ? on
      : a.on === "otherwise" && pathList.some((x) => x !== "item") && !terminalOtherwise ? "nothing" as const
      : a.on === "always" && sumList && rowsUsed ? sumList // once, beside a loop over the rows: it carries their summary
      : a.on === "always" && p.sources.length ? listOf[0]! : terminalOtherwise && p.sources.length ? listOf[0]! : "unsaid" as const;
    // Z8: wording drafted from the goal for the inputs declared a heading, and — when the action carries nothing but words — a message.
    const item = cat.items.find((x) => x.ref === a.ref);
    const drafts: Record<string, string> = {};
    for (const prm of item?.params ?? []) {
      if (prm.heading && a.heading?.trim()) drafts[prm.name] = a.heading.trim();
      // …and beside a file that carries the data (the solver uses it only then — a note, never words in place of the rows).
      else if (prm.message && !prm.heading && a.message?.trim()) drafts[prm.name] = a.message.trim();
    }
    return { takes, path, ...(Object.keys(drafts).length ? { drafts } : {}), approve: a.approve_first ? q(a.approve_first.quote, a.approve_first.clauses, sinks[p.actions.indexOf(a)]!.quote) : null, ...(a.per_item && eachList ? { per: "item" as const } : {}),
      // P7 (R24): an action per group that sends the rows sends THAT group's own rows (the group carries them).
      ...(groupsLoop && a.per_item && a.sends === "rows" ? { content: GROUP_ROWS } : {}) };
  });
  // Recipients: "me" is the requester; written out, or the people the rows are about (their words, `peopleInRows`), the goal's.
  // Each is the recipient of the ONE action it was planned for — recorded here, never re-derived from words (`recipientOf`).
  const recipientOf: Record<number, number> = {};
  p.actions.forEach((a, i) => {
    const port = addressPort(cat, a.ref);
    const r = a.recipient;
    // P7 (R15): an action not yet chosen (`unsaid`) still has the people the goal named — kept, loose, so the delivery question is
    // not asked about WHO (the goal said) and the chosen action receives them; dropped, a "forward to X" became a question about X.
    if (!port && a.ref === UNSAID && (r.from === "rows" || r.from === "goal") && r.words.trim()) {
      const field = r.from === "rows" && r.field && r.field !== RECIPIENT_FIELD_NA ? (r.field === RECIPIENT_FIELD_NONE || r.field === "new_read" ? r.field : r.field.slice(r.field.lastIndexOf(".") + 1)) : undefined;
      values.push({ role: "recipient", from: "goal", quote: r.words.trim(), fills: FILLS_NONE, ...(field ? { field } : {}) });
      return;
    }
    if (!port) return;
    if (r.from === "requester") { recipientOf[values.length] = i; values.push({ role: "recipient", from: "requester", quote: r.words.trim() || "me", fills: `${a.ref}.${port}` }); }
    else if ((r.from === "goal" || r.from === "rows") && r.words.trim()) {
      recipientOf[values.length] = i;
      // P7 (R15): the plan's chosen address field travels with the recipient — the solver binds it, never a field ranked by words.
      const field = r.from === "rows" && r.field && r.field !== RECIPIENT_FIELD_NA ? (r.field === RECIPIENT_FIELD_NONE || r.field === "new_read" ? r.field : r.field.slice(r.field.lastIndexOf(".") + 1)) : undefined;
      values.push({ role: "recipient", from: "goal", quote: r.words.trim(), fills: `${a.ref}.${port}`, ...(field ? { field } : {}) });
    }
  });
  // A value whose tool more than one action uses belongs to the action whose clause holds its words — a recipient to its own action.
  // (F05, 2026-10-02: "emailing the customer a reminder … otherwise email the reminder straight away" — both actions' "the customer"
  // went to the first, whose words hold it, and the second email had no recipient: it would have gone to whoever started the run.)
  const valueAction: Record<number, number> = {};
  values.forEach((v, vi) => {
    if (recipientOf[vi] !== undefined) { if (p.actions.filter((a) => a.ref === p.actions[recipientOf[vi]!]!.ref).length > 1) valueAction[vi] = recipientOf[vi]!; return; }
    const ref = v.fills && v.fills !== FILLS_NONE ? v.fills.slice(0, v.fills.lastIndexOf(".")) : null;
    const users = ref ? p.actions.map((a, j) => (a.ref === ref ? j : -1)).filter((j) => j >= 0) : [];
    if (users.length < 2) return;
    const own = users.find((j) => sinks[j]!.quote.toLowerCase().includes(v.quote.toLowerCase())) ?? users.find((j) => p.actions[j]!.recipient.words.trim() === v.quote.trim());
    if (own !== undefined) valueAction[vi] = own;
  });
  const wiring: Wiring = {
    ...(p.each && eachList ? { each: { quote: q(p.each.quote, p.each.clauses), over: eachList } } : {}),
    paths, actions, ...(Object.keys(valueAction).length ? { valueAction } : {}),
    ...(p.otherwise_said?.quote?.trim() || p.otherwise_said?.clauses.length ? { otherwise: q(p.otherwise_said.quote, p.otherwise_said.clauses) } : {}),
  };
  const missing = edit && p.changes_existing ? EDIT_NOT_ADDITIVE : [...p.sources, ...p.actions].some((x) => x.ref === NONE_FIT) ? (p.missing.trim() || "a part of the goal no listed component provides") : null;
  const findings = planFindings(p, cs, cat);
  if (terminalOtherwise) for (const f of findings.filter((x) => x.startsWith(ADVISORY_PREFIX))) notes.push(f.slice(ADVISORY_PREFIX.length));
  const unclear = [...(p.unclear ?? []).filter((u) => u.quote.trim()), ...findings.filter((f) => !f.startsWith(ADVISORY_PREFIX)).flatMap((f) => { const m = /^(C\d+) /.exec(f); const c = m ? cs.find((x) => x.id === m[1]) : undefined; return c ? [{ quote: c.text, about: "action" as const }] : []; })];
  // A written read's summary is its contract: the columns it groups by, the measures it returns (named above), its order, its limit.
  // P10 (bands over a saved reader, 2026-10-06): the summary still lowers — its words are placed work (grouping, measures), so
  // nothing about them is unclear; the scope finding (bands compute in a written read's SQL) states what the flow cannot do.
  // Stripping it nulled the summary, orphaned the grouping words into `unplaced`, and the person was asked what clear words mean.
  const limitN = sum ? Number(/\d+/.exec(sum.limit)?.[0] ?? NaN) : NaN;
  const banded = (sum?.measures ?? []).some((m) => (m.fn as string) === "band_count");
  const specSummary: SpecSummary | undefined = sum && sumRef && (sumWritten || banded) ? {
    over: sumWritten ? sumRef : p.sources[sum.over]?.ref ?? sumRef, quote: q(sum.quote, sum.clauses), by: sum.by.map((b) => b.field).filter((f) => sumWritten ? ownField(f) : true).map((f) => sumWritten ? bareF(f) : f), byWords: sum.by.map((b) => b.words).filter((w) => w.trim()),
    measures: sum.measures.map((m, j) => ({ name: mNames[j]!, fn: m.fn, field: sumWritten ? (ownField(m.field) ? bareF(m.field) : null) : m.field, words: m.words, ...((m as { counts?: string | null }).counts != null ? { counts: (m as { counts?: string | null }).counts } : {}), ...((m.fn as string) === "band_count" && m.bands ? { bands: m.bands } : {}) })),
  } : undefined;
  const joiningWords = p.joining.map((id) => cs.find((c) => c.id === id)?.text ?? "").filter((t) => t.trim());
  return { spec: { ...(specInputs.length ? { inputs: specInputs } : {}), ...(planGaps.length ? { planGaps } : {}), ...(specSummary ? { summary: specSummary } : {}), ...(joiningWords.length ? { joining: joiningWords } : {}), sources, sinks, values, conditions: [], schedule: p.schedule ? { cron: p.schedule.cron, quote: q(p.schedule.quote, p.schedule.clauses) } : null, missing, ...(unclear.length ? { unclear } : {}), shapes, wiring }, notes };
}
