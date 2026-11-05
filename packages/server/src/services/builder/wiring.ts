/**
 * Phase Y (D-343, I-310, I-313, I-314): how the parts of a goal CONNECT — asked of the spec's own parts, once they are known and
 * checked, in one small strict call (the shape call's pattern: `goal-spec.ts` `shapeSchema`). The spec says what is read, what is
 * shaped and what is done; the wiring says:
 *   - `paths`: a condition on a list — "when it has rows" / "when it has none" (the engine's `When`, exactly: `add_branch`,
 *     `add_otherwise`) — each quoting the goal's words for it; or (phase C) a comparison of ONE value — the list's count, or its one
 *     number — with a value the goal states (`compare`, a Decide), or the rows divided by a test on one field (`split`: its actions
 *     take the matching rows, and actions on `rest:<p>` the rest);
 *   - per action: what it TAKES (a reader's rows, one of the shaped lists, an earlier action's output, or nothing), which path it
 *     is on (or `otherwise` — the path taken when none of the stated ones holds), and whether a person approves it first (quoted);
 *   - per value, when two actions share a tool: which action it belongs to.
 * Every choice is an enum built from THIS spec, so the model can only name a part the spec has; code then checks each quote is the
 * person's words and each reference points backwards (an action takes only what exists before it). Nothing here knows any tool,
 * reader or phrasing.
 *
 * Unsaid is a real answer: `takes: "unsaid"` leaves the choice to the solver's constrained choice over the listed bind candidates
 * (never the latest step — I-314), and no paths means none.
 */
import { S, type Schema } from "./strict-schema.js";
import type { BuilderCatalogue, GoalSpec } from "./goal-spec.js";
import { COND_TESTS, shortAbout, TEST_WORDS, VALUED_TESTS, type CondTest } from "./goal-spec.js";
import { CMP, GROUP_ROWS, STAGE_REF, stageNames, type Stage } from "./shape.js";

export const MAX_PATHS = 3;

/**
 * A list a path tests or an action takes: a reader's rows (`reader:<source index>`), a shaped list (`list:<shape index>`), or —
 * when the goal CHANGES an automation (Z6, I-323) — one of its existing steps (`step:<id>`).
 */
export type ListKey = `reader:${number}` | `list:${number}` | `step:${string}`;
/**
 * Phase F (D-381): `item` — the current item of the goal's for-each (an action inside it); `each` — the for-each's output, one row
 * per item with what happened (an action after it: "then post a summary").
 */
export type TakesKey = ListKey | `action:${number}` | "nothing" | "unsaid" | "item" | "each";
/**
 * A path's subject: a list it tests, an EXISTING condition path of the automation being changed (`in:<branch id>`), or (phase F)
 * `item` — one item of the goal's for-each, compared on one of its fields (a Decide inside the loop).
 */
export type PathSubject = ListKey | `in:${string}` | "item";
/**
 * Z6: what an automation being changed already has, as keys the wiring may name — its lists (readers and shapes), the steps that
 * prepare content (a model's text), and its condition paths. Built by code from its steps; words are for the prompt only.
 */
export interface WiringExisting {
  /** `ref`: the reader a `datasource` step reads — so an edit may filter and shape the rows the flow ALREADY reads (2026-10-01). */
  lists: Array<{ key: `step:${string}`; words: string; ref?: string }>;
  producers: Array<{ key: `step:${string}`; words: string }>;
  paths: Array<{ key: `in:${string}`; words: string }>;
}
export type WiringCmp = "gt" | "ge" | "lt" | "le" | "eq" | "ne";
export const WIRING_CMPS: WiringCmp[] = ["gt", "ge", "lt", "le", "eq", "ne"];
/** A comparison's opposite — "has none of (total > 5)" is "total ≤ 5". */
const NEGATE: Record<WiringCmp, WiringCmp> = { gt: "le", ge: "lt", lt: "ge", le: "gt", eq: "ne", ne: "eq" };
export interface WiringPath {
  quote: string; subject: PathSubject;
  /** `any`/`none`: has rows / has none. `compare` (a Decide) and `split` (phase C) carry `measure`, `cmp` and `value`. */
  test: "any" | "none" | "compare" | "split";
  /** compare: `count`, `value` (the list's one number) or a field of its one record; split: the row field tested. */
  measure?: string;
  cmp?: WiringCmp;
  /** The goal's own words for the value compared with — a constant is the person's, never invented. */
  value?: string;
  /**
   * builder-behaviour P1 (R10): a condition on ONE item — EVERY test the plan states, all holding (a field of the item: its test, and
   * the value, another field, or an input it compares with). The single `measure/cmp/value` form held one comparison only: a second
   * test was lost, and a yes/no test, a test against an input or against another field could not be stated (B15: lost in silence).
   */
  where?: ItemTest[];
  /** builder-behaviour P1: the plan input the compared value came from (a split by a given number) — so the input is known used. */
  input?: string;
}
/** One test of an item's field — the plan's own test, bare field names (fields of the item). */
export interface ItemTest { field: string; test: string; value?: string; against?: string; input?: string; /** A fact the read is written to return: what it holds, in the plan's words. */ about?: string }
/** An action's path: always (null), path `p`, `otherwise` (none of the chain's paths held), or the REST of split `p`. */
export type ActionPath = number | "otherwise" | `rest:${number}` | null;
/** Phase F (D-381): the goal does something FOR EACH item of a list — its words, and the list. */
export interface WiringEach { quote: string; over: ListKey }
export interface Wiring {
  paths: WiringPath[];
  /** Phase F: the goal's for-each, or absent. Actions with `per: "item"` run once per item of it. */
  each?: WiringEach;
  /** `drafts` (Z8, I-326): wording written from the goal for the action's heading inputs (and, when it carries no data or a file carries it, its message). */
  actions: Array<{ takes: TakesKey; path: ActionPath; approve: string | null; drafts?: Record<string, string>; /** Phase F: runs once per item of `each`. */ per?: "item";
    /** builder-behaviour P1 (R6): the condition this action runs on was NOT kept — its words. Never placed as if it ran always. */ orphan?: string;
    /** Phase F: the goal's own words saying HOW OFTEN it happens ("in one message", "to each of them") — a claim like any other, quoted. */ perWords?: string;
    /** P7 (R24): the item's field that IS what it sends — a group's own rows (`GROUP_ROWS`), for an action done per group. */ content?: string }>;
  /** Value index → action (sink) index, for a value whose tool more than one action uses. */
  valueAction?: Record<number, number>;
  /** The goal's own words for the otherwise when it said it as the opposite of a condition ("if it doesn't") — a claim, quoted. */
  otherwise?: string;
}

/**
 * Whether path `p` has anything to do on it — the ONE rule the solver places a condition by and the wiring answer is checked by: an
 * action on the path, or (a split over the rows, not an item) on its rest.
 */
export const pathHasActions = (w: Wiring, p: number): boolean =>
  w.actions.some((a) => a.path === p || (w.paths[p]?.subject !== "item" && a.path === `rest:${p}`));

/**
 * What a wiring answer leaves UNSAID that the goal's words decide (2026-10-02, a user's "if the amount is over 10000 ask me to
 * approve before emailing …, otherwise email … straight away": both actions came back `always`, so the condition guarded nothing
 * and every invoice would get both emails). Each a sentence for the wiring call to fix — never a question for the person.
 */
export function wiringFindings(w: Wiring, spec: GoalSpec): string[] {
  const acts = spec.sinks.map((x, i) => `${key(i)} (“${x.quote}”)`).join(", ");
  return w.paths.flatMap((path, p) => (pathHasActions(w, p) ? [] : [
    `the condition path:${p} (“${path.quote}”) has no action on it: give the action the goal does when it holds \`path:${p}\`${path.subject !== "item" && path.test === "split" ? `, and the one it does for the rest \`rest:${p}\`` : ", and the one it does otherwise `otherwise`"} — the actions are ${acts}`,
  ]));
}

const key = (i: number) => `a${i}`;
/** The spec's lists, as the keys an enum offers: every kept reader's rows, and every shape. */
export function listKeys(spec: GoalSpec): ListKey[] {
  return [...spec.sources.map((_, i) => `reader:${i}` as const), ...(spec.shapes ?? []).map((_, k) => `list:${k}` as const)];
}
/** Values whose tool is used by more than one action — the only ones whose action is not already their `fills`. */
export function sharedValues(spec: GoalSpec): number[] {
  return spec.values.map((v, i) => ({ v, i })).filter(({ v }) => {
    if (!v.fills || v.fills === "none") return false;
    const ref = v.fills.slice(0, v.fills.lastIndexOf("."));
    return spec.sinks.filter((x) => x.ref === ref).length > 1;
  }).map(({ i }) => i);
}
/**
 * Z8: the inputs of action `i` whose WORDS may be drafted from the goal — declared a heading (a subject, a title) or a message — that
 * no value of this action fills. A message is kept only when the action carries no data (`checkWiring`): otherwise it is the data.
 */
export function draftablePorts(spec: GoalSpec, cat: BuilderCatalogue, i: number, valueAction: Record<number, number> | undefined = spec.wiring?.valueAction): string[] {
  const x = spec.sinks[i];
  if (!x) return [];
  const item = cat.items.find((it) => it.ref === x.ref);
  const shared = spec.sinks.filter((s) => s.ref === x.ref).length > 1;
  // A value is this action's when it is not shared, when the wiring says so, or — not yet wired — when its words are in this action's own
  // clause (the quoted post text of `post "…" to #ops`).
  const mine = (v: GoalSpec["values"][number], vi: number) => !shared || valueAction?.[vi] === i || (valueAction?.[vi] === undefined && !!v.quote.trim() && x.quote.toLowerCase().includes(v.quote.toLowerCase()));
  const filled = new Set(spec.values.filter((v, vi) => v.fills?.startsWith(`${x.ref}.`) && mine(v, vi)).map((v) => v.fills!.slice(v.fills!.lastIndexOf(".") + 1)));
  return (item?.params ?? []).filter((p) => (p.heading || p.message) && !filled.has(p.name)).map((p) => p.name);
}

/** Is `port` of component `ref` declared a heading (a subject, a title)? A heading is always drafted (Z8); a message only sometimes. */
export const headingPort = (cat: BuilderCatalogue, ref: string, port: string) => !!cat.items.find((it) => it.ref === ref)?.params?.find((q) => q.name === port)?.heading;

/**
 * The earlier actions action `i` may take the output of: only those whose component is DECLARED to prepare content (`modelText` —
 * a summary, a draft) — a post's or a send's reply is a status, not something to carry on (the live run took the post's reply as the
 * summary's input). From the catalogue's declaration, never a tool's name.
 */
export const producers = (spec: GoalSpec, cat: BuilderCatalogue, i: number) =>
  spec.sinks.slice(0, i).map((x, j) => ({ x, j })).filter(({ x }) => !!cat.items.find((it) => it.ref === x.ref)?.modelText).map(({ j }) => j);

const lcq = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Two quotes are the same words of the goal: one contains the other, once case and punctuation are set aside. */
/** A shape made only of filters, each comparing a field with a value the goal states — the goal's own test of the rows. */
const valueTest = (sh: { stages: Array<{ op: string; field?: string | null; value?: string | null }> }) => sh.stages.length > 0 && sh.stages.every((st) => st.op === "filter" && !!st.field && !!st.value?.trim());
/** A shape whose every stage is a COMPLETE row test — a value the goal states, or a test that takes none (a flag, presence). */
const rowTest = (sh: { stages: Array<{ op: string; field?: string | null; value?: string | null; test?: string | null }> }) =>
  sh.stages.length > 0 && sh.stages.every((st) => st.op === "filter" && !!st.field && (!!st.value?.trim() || (!!st.test && !VALUED_TESTS.has(st.test as CondTest))));
const sameWords = (a: string, b: string) => !!lcq(a) && !!lcq(b) && (lcq(a).includes(lcq(b)) || lcq(b).includes(lcq(a)));

/**
 * Phase C: shapes the wiring's own conditions make, so they are NOT built as lists of their own — by structure, never by words.
 * Once the wiring states a split on field f of reader R, a shape over R that is ONE filter on f is a side of that split written
 * by hand (its "rest" a second hand-written filter that can drift); once it states a Decide on the count of R, a shape over R that
 * is ONE count is the count the Decide takes itself. A shape a path tests (its subject) is never superseded.
 */
export function supersededShapes(spec: GoalSpec): Map<number, string> {
  const out = new Map<number, string>();
  const paths = spec.wiring?.paths ?? [];
  // A shape is judged AS BUILT — cut where its stages restate a condition (`restatedCuts`): "count them, then keep the count above 5"
  // is the count, and the count is the condition's.
  const cuts = restatedCuts(spec);
  // A condition on EACH ITEM of a loop (2026-10-02): a one-filter list over the loop's rows on the field the condition compares is
  // that condition, either side of it — the shape call and the wiring call wrote one test twice ("if the amount is over 10000" and
  // "otherwise" as lists, and as the per-item path), and the lists were reported as "read by no action" to the person.
  const each = spec.wiring?.each;
  const loopRows = each?.over.startsWith("reader:") ? spec.sources[Number(each.over.slice(7))]?.ref : undefined;
  for (const p of paths) {
    if (p.subject !== "item" || p.test !== "compare" || !p.measure || !loopRows) continue;
    (spec.shapes ?? []).forEach((sh, si) => {
      const stages = sh.stages.slice(0, cuts.get(si) ?? sh.stages.length);
      if (sh.over !== loopRows || stages.length !== 1 || paths.some((q) => q.subject === `list:${si}`) || each?.over === `list:${si}`) return;
      const st = stages[0]!;
      if (st.op === "filter" && st.field?.split(".").pop() === p.measure) out.set(si, `one side of the condition “${p.quote}”, which each item is tested by itself`);
    });
  }
  for (const p of paths) {
    if (p.test !== "split" && !(p.test === "compare" && p.measure === "count")) continue;
    const over = p.subject.startsWith("reader:") ? spec.sources[Number(p.subject.slice(7))]?.ref : undefined;
    if (!over) continue;
    (spec.shapes ?? []).forEach((sh, si) => {
      const stages = sh.stages.slice(0, cuts.get(si) ?? sh.stages.length);
      if (sh.over !== over || stages.length !== 1 || paths.some((q) => q.subject === `list:${si}`)) return;
      const st = stages[0]!;
      if (p.test === "split" && st.op === "filter" && st.field?.split(".").pop() === p.measure) out.set(si, `one side of the split “${p.quote}”, which the split makes itself — its rest generated, never written`);
      // A count is a `count` stage, or a key-less group whose only measure is a count of the rows — the same number, two spellings.
      // A count of a FIELD is that count too when its words are the condition's own ("more than 5 invoices are overdue", spelt
      // count(invoice_number)): the condition's words are not a shape (`inPathsOnly`'s rule) — the goal states ONE number.
      const counts = st.op === "group" && !st.by?.length && !!st.measures?.length && st.measures.every((m) => m.fn === "count");
      const isCount = st.op === "count" || (counts && st.measures!.every((m) => !m.field || m.field === "none")) || (counts && sameWords(st.quote, p.quote));
      if (p.test === "compare" && isCount) out.set(si, `the count the condition “${p.quote}” takes itself`);
    });
  }
  return out;
}

/**
 * The shapes NOTHING reads — no action takes the list, no condition tests it, no for-each runs over it (a list the same as another is
 * read through that one). Such a list is not built: a filter nobody reads does nothing and reads back as if it did (2026-10-01: a
 * goal's "if urgent … otherwise …" came back both as a condition on each item AND as three lists, and only the condition was read).
 * Empty when the goal has no actions — there the lists are the result.
 */
export function unreadShapes(spec: GoalSpec): Set<number> {
  const w = spec.wiring;
  const out = new Set<number>();
  if (!w?.actions.length) return out;
  const same = sameShapes(spec);
  const read = new Set<number>();
  const note = (k: string | undefined) => { if (k?.startsWith("list:")) { const n = Number(k.slice(5)); read.add(same.get(n) ?? n); } };
  for (const a of w.actions) note(a.takes);
  for (const p of w.paths) note(p.subject);
  note(w.each?.over);
  (spec.shapes ?? []).forEach((_, si) => { if (!read.has(si) && !read.has(same.get(si) ?? si)) out.add(si); });
  return out;
}

/** Stages that need ROWS: after a key-less total (one record) there are none, so such a stage can only be a condition restated. */
const NEEDS_ROWS = new Set(["filter", "sort", "limit", "distinct", "first", "group", "count"]);
/**
 * Phase C: where each shape stops being a list, by structure — from the first stage that needs rows AFTER a key-less `group` (the
 * total over all the rows, ONE record). "The total … over 20" as a shape's last stage is the condition the wiring states, not a
 * list step (it could never be built: a filter over one record has no rows). The stages from the cut are the condition's.
 */
export function restatedCuts(spec: GoalSpec): Map<number, number> {
  const out = new Map<number, number>();
  // Which lists a has-rows / has-none condition tests: such a list stops before a trailing COUNT — the condition already asks what the
  // count answers (2026-10-01: "if any …" became "Counts the rows", and "has rows" was asked of one number, which has none).
  const askedRows = new Set((spec.wiring?.paths ?? []).filter((p) => (p.test === "any" || p.test === "none") && p.subject.startsWith("list:")).map((p) => Number(p.subject.slice(5))));
  const onlyCounts = (st: Stage) =>
    st.op === "count" || (st.op === "group" && !st.by?.length && !!st.measures?.length && st.measures.every((m) => m.fn === "count" && !m.field));
  (spec.shapes ?? []).forEach((sh, si) => {
    const g = sh.stages.findIndex((st) => st.op === "group" && !st.by?.length);
    const k = g < 0 ? -1 : sh.stages.findIndex((st, j) => j > g && NEEDS_ROWS.has(st.op));
    if (k > 0) { out.set(si, k); return; }
    const last = sh.stages.length - 1;
    if (askedRows.has(si) && last > 0 && onlyCounts(sh.stages[last]!)) out.set(si, last);
  });
  return out;
}
/**
 * A shape identical to an earlier one over the same rows, once cut (`restatedCuts`) — "more than 20 …" and its "otherwise" written
 * as two lists that are the same total — is that earlier list, built once: shape index → the earlier index.
 */
export function sameShapes(spec: GoalSpec): Map<number, number> {
  const cuts = restatedCuts(spec), out = new Map<number, number>(), seen = new Map<string, number>();
  const strip = (st: object) => Object.fromEntries(Object.entries(st).filter(([k]) => k !== "quote"));
  (spec.shapes ?? []).forEach((sh, si) => {
    const key = JSON.stringify([sh.over, sh.stages.slice(0, cuts.get(si) ?? sh.stages.length).map(strip)]);
    if (seen.has(key)) out.set(si, seen.get(key)!); else seen.set(key, si);
  });
  return out;
}

/** What a comparison may measure: how many rows, a list's one number, or a row field of a reader this goal reads — names, never words. */
export function measures(spec: GoalSpec, cat: BuilderCatalogue): string[] {
  const fields = spec.sources.flatMap((x) => cat.items.find((it) => it.ref === x.ref)?.fields?.map((f) => f.name) ?? []);
  // P7 (R24): a group's measures are fields of ITS rows (an item of a for-each over groups) — "if a team's total is above …".
  const grouped = (spec.shapes ?? []).flatMap((sh) => stageNames(sh.stages).flat());
  return ["count", "value", ...new Set([...fields, ...grouped])];
}

export function wiringSchema(spec: GoalSpec, cat: BuilderCatalogue, existing?: WiringExisting): Schema {
  const lists = [...listKeys(spec), ...(existing?.lists.map((x) => x.key) ?? [])];
  const had = existing?.producers.map((x) => x.key) ?? [];
  const actions: Record<string, Schema> = {};
  spec.sinks.forEach((_, i) => {
    actions[key(i)] = S.obj({
      takes: S.oneOf([...lists, ...had, ...producers(spec, cat, i).map((j) => `action:${j}`), "nothing", "unsaid", ...(lists.length ? ["item", "each"] : [])]),
      path: S.oneOf(["always", ...Array.from({ length: MAX_PATHS }, (_, p) => `path:${p}`), "otherwise", ...Array.from({ length: MAX_PATHS }, (_, p) => `rest:${p}`)]),
      ...(lists.length ? {
        per: S.oneOf(["once", "each_item"], "each_item: it happens once for EACH item of `each`; once: one time"),
        per_words: S.str("the goal's words that say how often it happens (\"in one message\", \"to each of them\"), copied exactly; empty when it does not say"),
      } : {}),
      approve: S.nullable(S.str("the goal's words asking a person to approve this action before it runs, copied exactly; null when it does not")),
      ...(draftablePorts(spec, cat, i).length ? { drafts: S.obj(Object.fromEntries(draftablePorts(spec, cat, i).map((p) => [p, headingPort(cat, spec.sinks[i]!.ref, p) ? S.str(`a few plain words for \`${p}\` saying what is sent, written from the goal`) : S.nullable(S.str(`short words for \`${p}\`, written from the goal`))]))) } : {}),
    });
  });
  const shared = sharedValues(spec);
  const values: Record<string, Schema> = {};
  for (const vi of shared) {
    const ref = spec.values[vi]!.fills!.slice(0, spec.values[vi]!.fills!.lastIndexOf("."));
    values[`v${vi}`] = S.oneOf(spec.sinks.map((x, j) => (x.ref === ref ? `action:${j}` : null)).filter((x): x is string => !!x));
  }
  const subjects = [...lists, ...(existing?.paths.map((x) => x.key) ?? [])];
  return S.obj({
    ...(lists.length ? { each: S.nullable(S.obj({ quote: S.str("the goal's words saying it does something for EACH item, copied exactly (\"for each overdue loan\")"), over: S.oneOf(lists) })) } : {}),
    paths: S.arr(S.obj({
      quote: S.str("the goal's words for this condition, copied exactly (\"if there are any\", \"when nothing is overdue\")"),
      subject: S.oneOf(subjects.length ? [...subjects, ...(lists.length ? ["item"] : [])] : ["reader:0"]),
      test: S.oneOf(["has_rows", "has_none", "compare", "split"]),
      measure: S.nullable(S.oneOf(measures(spec, cat), "compare: `count` (how many rows), `value` (the list's one number, e.g. a total) or a row field (some row has it); split: the row field tested. null otherwise")),
      cmp: S.nullable(S.oneOf(WIRING_CMPS, "compare / split: gt (more than), ge (at least), lt (less than), le (at most), eq, ne. null otherwise")),
      value: S.nullable(S.str("compare / split: the goal's words for the value compared with, copied exactly (\"10,000\", \"7\"). null otherwise")),
    }), MAX_PATHS),
    actions: S.obj(actions),
    ...(shared.length ? { values: S.obj(values) } : {}),
  });
}

/** The model's reply, in the schema's shape. */
export interface WiringReply {
  each?: { quote: string; over: string } | null;
  paths: Array<{ quote: string; subject: string; test: "has_rows" | "has_none" | "compare" | "split"; measure?: string | null; cmp?: WiringCmp | null; value?: string | null }>;
  actions: Record<string, { takes: string; path: string; approve: string | null; drafts?: Record<string, string | null>; per?: "once" | "each_item"; per_words?: string }>;
  values?: Record<string, string>;
}

/**
 * The code half: every reference must point at a part THIS spec has, an action may take only an earlier action, every quote must
 * be the person's words, and `otherwise` needs a stated path to be the alternative to. A failed claim is dropped and named — the
 * action then takes `unsaid`, or runs always — never repaired.
 */
export function checkWiring(w: Wiring | undefined, spec: GoalSpec, quoted: (q: string) => boolean, cat: BuilderCatalogue, existing?: WiringExisting): { wiring: Wiring | undefined; dropped: Array<{ what: string; why: string }> } {
  if (!w) return { wiring: undefined, dropped: [] };
  const dropped: Array<{ what: string; why: string }> = [];
  const lists = new Set<string>([...listKeys(spec), ...(existing?.lists.map((x) => x.key) ?? [])]);
  const had = new Set<string>(existing?.producers.map((x) => x.key) ?? []);
  const inPaths = new Set<string>(existing?.paths.map((x) => x.key) ?? []);
  // Phase F (D-381): the for-each is the person's words over a list this goal has — else dropped, named, and its actions run once.
  let each = w.each;
  if (each) {
    const why = !quoted(each.quote) ? "not in the goal" : !lists.has(each.over) ? "it names a list this goal does not have" : null;
    if (why) { dropped.push({ what: `for each “${each.quote}”`, why }); each = undefined; }
  }
  // A condition's words are not a shape: a path testing a list whose ONLY words are the path's own ("If nothing is overdue" as a shape
  // of its own) tests the rows that list is read from — the condition, stated once, never a list of nothing (the live run placed
  // neither). Matched on the person's words; the source is the shape's own `over`.
  const inPathsOnly = (p: Wiring["paths"][number]): Wiring["paths"][number] => {
    if (!p.subject.startsWith("list:")) return p;
    const sh = (spec.shapes ?? [])[Number(p.subject.slice(5))];
    const src = sh ? spec.sources.findIndex((x) => x.ref === sh.over) : -1;
    // Phase C: a comparison needs its list. The ONE redirect is structural: "the count of" a list that is itself only a count is the
    // count of the rows it counts (a one-record list has nothing to count). A value compared keeps its list — it IS the total.
    if (p.test === "compare") {
      if (p.measure !== "count" || !sh || src < 0 || sh.stages.length !== 1 || sh.stages[0]!.op !== "count") return p;
      dropped.push({ what: `condition “${p.quote}” on ${p.subject}`, why: `that list is only a count — the condition counts the rows of ${sh.over}` });
      return { ...p, subject: `reader:${src}` };
    }
    // A list whose stages compare to a value the goal states is the goal's own test, not the condition's framing: its rows are what
    // the condition asks about ("If any of them is from Contoso Ltd" over "customer name is Contoso Ltd"), so it keeps its list.
    // …and a list an ACTION takes (or the for-each runs over) is read for its rows — a real list, whatever its words (2026-10-01: the
    // list "over_budget is true" an email took was moved off, and the condition asked whether the reader had any row at all).
    const readByAction = w.actions.some((a) => a.takes === p.subject) || w.each?.over === p.subject;
    if (!sh || src < 0 || !sh.stages.length || valueTest(sh) || readByAction || !sh.stages.every((st) => sameWords(st.quote, p.quote))) return p;
    dropped.push({ what: `condition “${p.quote}” on ${p.subject}`, why: `that list is only this condition's words — it tests the rows of ${sh.over}` });
    return { ...p, subject: `reader:${src}` };
  };
  // Phase C: a VALUE compared on a reader's rows, when exactly one shape over that reader is a total (a key-less group), is that
  // total — the rows have no one value; the shape made it. By structure, stated.
  const toTotal = (p: Wiring["paths"][number]): Wiring["paths"][number] => {
    if (p.test !== "compare" || p.measure === "count" || !p.subject.startsWith("reader:")) return p;
    const over = spec.sources[Number(p.subject.slice(7))]?.ref;
    const totals = (spec.shapes ?? []).map((sh, si) => ({ sh, si })).filter(({ sh }) => sh.over === over && sh.stages.some((st) => st.op === "group" && !st.by?.length));
    if (totals.length !== 1) return p;
    dropped.push({ what: `condition “${p.quote}” on ${p.subject}`, why: `those rows have no one value to compare — the total over them is list:${totals[0]!.si}` });
    return { ...p, subject: `list:${totals[0]!.si}` };
  };
  // Phase C: the stages a shape restates after a total (`restatedCuts`) ARE a comparison — "count them, keep the count above 5" —
  // and they are never built as a list. When exactly one condition tests those rows (the shape, or the reader it is over) and only
  // asks whether they have rows, the comparison is that condition's: it becomes the comparison, never dropped in silence. By
  // structure: the tail is one filter on the total's measure; a count of the rows is compared on the reader, any other total on
  // the shape.
  const fromTail = (ps: Wiring["paths"]): Wiring["paths"] => {
    const out = [...ps];
    for (const [si, k] of restatedCuts(spec)) {
      const sh = spec.shapes![si]!, tail = sh.stages.slice(k), g = sh.stages.findIndex((st) => st.op === "group" && !st.by?.length);
      const ref = tail.length === 1 && tail[0]!.op === "filter" ? STAGE_REF.exec(tail[0]!.field ?? "") : null;
      const cmp = tail[0]?.test ? CMP[tail[0].test] : undefined;
      if (!ref || Number(ref[1]) !== g || !cmp || !tail[0]!.value?.trim()) continue;
      const m = sh.stages[g]!.measures?.[Number(ref[2] ?? 0)];
      const src = spec.sources.findIndex((x) => x.ref === sh.over);
      if (!m || src < 0) continue;
      const claims = (p: Wiring["paths"][number]) => p.subject === `list:${si}` || p.subject === `reader:${src}`;
      if (out.some((p) => claims(p) && (p.test === "compare" || p.test === "split"))) continue; // the condition states its own
      const asks = out.map((p, i) => ({ p, i })).filter(({ p }) => claims(p) && (p.test === "any" || p.test === "none"));
      if (asks.length !== 1) continue;
      const { p, i } = asks[0]!;
      const counts = m.fn === "count" && !m.field;
      const c = p.test === "none" ? NEGATE[cmp] : cmp;
      dropped.push({ what: `condition “${p.quote}” (${p.test === "none" ? "has no rows" : "has rows"})`, why: `list:${si} states the comparison (“${tail[0]!.quote}”) after its total — the condition compares ${counts ? "the count of the rows" : "that total"} instead` });
      out[i] = { ...p, subject: counts ? `reader:${src}` : `list:${si}`, test: "compare", measure: counts ? "count" : "value", cmp: c, value: tail[0]!.value! };
    }
    return out;
  };
  // A has-rows / has-none question asked of a READER, whose words hold the words of exactly ONE value test over those rows, asks
  // about that test's rows: "If any of them is from Contoso Ltd" is the list "is from Contoso Ltd", not "there are tickets" (UAT
  // 2026-09-30: both links of an if/else-if tested the reader, so the IF always held and the ELSE IF never ran). By words, stated.
  const toShape = (p: Wiring["paths"][number]): Wiring["paths"][number] => {
    if ((p.test !== "any" && p.test !== "none") || !p.subject.startsWith("reader:")) return p;
    const over = spec.sources[Number(p.subject.slice(7))]?.ref;
    const said = lcq(p.quote);
    const hits = (spec.shapes ?? []).map((sh, si) => ({ sh, si })).filter(({ sh }) => sh.over === over && valueTest(sh) && sh.stages.every((st) => !!lcq(st.quote) && said.includes(lcq(st.quote))));
    if (hits.length !== 1) return p;
    dropped.push({ what: `condition “${p.quote}” on ${p.subject}`, why: `its words are list:${hits[0]!.si}'s (${hits[0]!.sh.stages.map((st) => `“${st.quote}”`).join(", ")}) — it tests those rows` });
    return { ...p, subject: `list:${hits[0]!.si}` };
  };
  // One phrase, one claim: a comparison on a reader's FIELD whose words are a list's own test of that same field restates the list —
  // "if any center is over spending" is the list "over_budget is true" having rows, not a second test with the words as its value
  // (2026-10-01: compared `over_budget = "over spending"`, it could never be placed). By structure: same reader, same field, same words.
  const toSameTest = (p: Wiring["paths"][number]): Wiring["paths"][number] => {
    if (p.test !== "compare" || !p.measure || p.measure === "count" || p.measure === "value" || !p.subject.startsWith("reader:")) return p;
    const over = spec.sources[Number(p.subject.slice(7))]?.ref;
    const field = (x?: string | null) => (x ?? "").slice((x ?? "").lastIndexOf(".") + 1);
    const hits = (spec.shapes ?? []).map((sh, si) => ({ sh, si })).filter(({ sh }) => sh.over === over && rowTest(sh)
      && sh.stages.some((st) => field(st.field) === p.measure && sameWords(st.quote, p.quote)));
    if (hits.length !== 1) return p;
    dropped.push({ what: `condition “${p.quote}” comparing ${p.measure}`, why: `its words are list:${hits[0]!.si}'s own test of ${p.measure} — it asks whether that list has rows` });
    return { quote: p.quote, subject: `list:${hits[0]!.si}`, test: "any" };
  };
  const mapped = fromTail(w.paths).map(toSameTest).map(toShape).map(toTotal).map(inPathsOnly);
  const paths = mapped.filter((p) => {
    if (!quoted(p.quote)) { dropped.push({ what: `condition “${p.quote}”`, why: "not in the goal" }); return false; }
    // Phase F: a condition on ONE item compares one of its fields — inside the for-each, so there must be one.
    if (p.subject === "item") {
      // A test a reader ALREADY applies holds for every item it gives (2026-10-01: "if a cost centre is over budget" was the written
      // read's own rule AND a per-item compare of budget with budget, which could not be built and moved the email out of the loop).
      const byReader = [...spec.conditions.filter((c) => c.by && spec.sources.some((x) => x.ref === c.by)).map((c) => c.quote), ...(spec.covered ?? []).map((c) => c.quote)];
      // P7 (E06): a condition with an ALTERNATIVE on the item (another condition of its chain, or an otherwise) is the flow's own —
      // a read giving "only those rows" would leave the alternative nothing to run on ("for every P1 … page, for every P2 … ticket":
      // the read claimed "P1", the P1 condition was dropped, and both actions were lost).
      const alternatives = mapped.filter((x) => x.subject === "item").length > 1 || w.actions.some((a) => a.per === "item" && a.path === "otherwise");
      // The reader's words HOLD the condition's — never the other way: a read of "devices" does not apply "if a site has more than 2
      // offline devices" because the condition names devices (2026-10-04: the per-site test was dropped, and the email with it).
      if (!alternatives && byReader.some((q) => !!lcq(q) && !!lcq(p.quote) && lcq(q).includes(lcq(p.quote)))) { dropped.push({ what: `condition “${p.quote}” on each item`, why: "the reader already gives only those rows — every item holds it" }); return false; }
      const why = !each ? "it tests an item, and the goal has no for each"
        : p.test !== "compare" ? "one item is not a list — a condition on it compares one of its fields"
        : p.measure === "count" || p.measure === "value" ? "one item has no count or total — a condition on it compares one of its fields" : null;
      if (why) { dropped.push({ what: `condition “${p.quote}”`, why }); return false; }
    } else if (!lists.has(p.subject) && !inPaths.has(p.subject)) { dropped.push({ what: `condition “${p.quote}”`, why: "it tests a list this goal does not have" }); return false; }
    // builder-behaviour P1 (R10): an item condition stated as its tests — each a field of the rows, a known test, and what it compares
    // with: the goal's own value, another field, or an input. Judged test by test; the one-compare form below is for the rest.
    if (p.subject === "item" && p.where?.length) {
      const fields = measures(spec, cat);
      const bad = p.where.map((t) => (!fields.includes(t.field) ? `“${t.field}” is not a field of these rows`
        : !(COND_TESTS as readonly string[]).includes(t.test) ? `“${t.test}” is not a test`
        : t.against && !fields.includes(t.against) ? `“${t.against}” is not a field of these rows`
        : VALUED_TESTS.has(t.test as CondTest) && !t.value?.trim() && !t.against && !t.input ? `it does not say what “${t.field}” is compared with`
        : t.value?.trim() && !t.input && !quoted(t.value) ? `the value “${t.value}” is not in the goal` : null)).find((x) => x);
      if (bad) { dropped.push({ what: `condition “${p.quote}”`, why: bad }); return false; }
      return true;
    }
    // Phase C: a comparison states what it compares, how, and with what — and the value is the person's own words, never invented.
    if (p.test === "compare" || p.test === "split") {
      const why = !p.measure?.trim() ? `it does not say what is ${p.test === "split" ? "tested on each row" : "compared"}`
        : !measures(spec, cat).includes(p.measure) ? `“${p.measure}” is not a field of these rows (nor \`count\` or \`value\`)`
        : !p.cmp || !WIRING_CMPS.includes(p.cmp) ? "it does not say how the value is compared"
        : !p.value?.trim() ? "it does not say what the value is compared with"
        : !quoted(p.value) ? `the value “${p.value}” is not in the goal`
        : p.subject.startsWith("in:") ? "an existing path is not a list to compare" : null;
      if (why) { dropped.push({ what: `condition “${p.quote}”`, why }); return false; }
    }
    return true;
  });
  // Paths renumbered after drops: an action on a dropped path runs on none of them (stated), never silently on another.
  const renum = new Map(mapped.map((p, i) => [i, paths.indexOf(p)]));
  const actions = spec.sinks.map((x, i) => {
    const a = w.actions[i] ?? { takes: "unsaid" as TakesKey, path: null, approve: null };
    let takes = a.takes;
    if (takes.startsWith("action:")) {
      const j = Number(takes.split(":")[1]);
      if (!(j >= 0 && j < i)) { dropped.push({ what: `${x.ref} takes ${takes}`, why: "an action takes only an earlier one's output" }); takes = "unsaid"; }
      else if (!producers(spec, cat, i).includes(j)) { dropped.push({ what: `${x.ref} takes ${takes}`, why: `${spec.sinks[j]!.ref} prepares nothing to carry on — its reply is a status` }); takes = "unsaid"; }
    }
    else if ((takes.startsWith("reader:") || takes.startsWith("list:")) && !lists.has(takes)) { dropped.push({ what: `${x.ref} takes ${takes}`, why: "not a list this goal has" }); takes = "unsaid"; }
    else if (takes.startsWith("step:") && !lists.has(takes) && !had.has(takes)) { dropped.push({ what: `${x.ref} takes ${takes}`, why: "not a list or prepared text the automation has" }); takes = "unsaid"; }
    let path = a.path;
    let orphan: string | undefined;
    if (typeof path === "number") { const n = renum.get(path) ?? -1; if (n < 0) { dropped.push({ what: `${x.ref} on path ${path}`, why: "that condition was not kept" }); orphan = mapped[path]?.quote ?? "its condition"; path = null; } else path = n; }
    if (typeof path === "string" && path.startsWith("rest:")) {
      const n = renum.get(Number(path.slice(5))) ?? -1;
      if (n < 0 || paths[n]!.test !== "split") { dropped.push({ what: `${x.ref} on ${path}`, why: "that is not a split that was kept — only a split has a rest" }); path = null; } else path = `rest:${n}`;
    }
    // Phase F (D-381): an action runs once per item when the goal says so, or when it is on a condition of the item (it is inside).
    const onItem = typeof path === "number" && paths[path]?.subject === "item";
    let per: "item" | undefined = a.per === "item" || onItem ? "item" : undefined;
    if (per && !each) { dropped.push({ what: `${x.ref} for each item`, why: "the goal has no for each" }); per = undefined; }
    // A condition OUTSIDE the for-each decides once, for the whole run: it cannot guard one item's action — nor an item's the rest.
    if (per && path !== null && !onItem && path !== "otherwise") { dropped.push({ what: `${x.ref} on ${typeof path === "number" ? `condition “${paths[path]?.quote}”` : path}`, why: "that condition is decided once for the run, and this action runs for each item — a condition on the item compares one of its fields" }); path = null; }
    // `otherwise` is the alternative to a CHAIN of conditions — of the item's when the action runs per item, else the run's; a split's
    // other side is its rest, not an otherwise.
    const scope = paths.filter((p) => p.test !== "split" && (p.subject === "item") === !!per);
    if (path === "otherwise" && !scope.length) { dropped.push({ what: `${x.ref} otherwise`, why: paths.some((p) => (p.subject === "item") === !!per) ? "a split's other rows are its rest (`rest:`), not an otherwise" : per ? "no condition on the item for it to be the alternative to" : "there is no condition for it to be the alternative to" }); orphan = "otherwise"; path = null; }
    // What an item's action takes: the item (the for-each's own list, per item, IS the item); the for-each's output only after it.
    if (per && each && takes === each.over) takes = "item";
    if (takes === "item" && !per) { dropped.push({ what: `${x.ref} takes the item`, why: "it runs once, not for each item" }); takes = "unsaid"; }
    if (takes === "each" && (per || !each)) { dropped.push({ what: `${x.ref} takes the for each's output`, why: per ? "it runs for each item; the output is one row per item, after the for each" : "the goal has no for each" }); takes = "unsaid"; }
    // How often, in the person's words — a claim like the rest: kept only when quoted.
    let perWords = a.perWords;
    if (perWords && !quoted(perWords)) { dropped.push({ what: `how often ${x.ref} runs (“${perWords}”)`, why: "not in the goal" }); perWords = undefined; }
    let approve = a.approve;
    if (approve && !quoted(approve)) { dropped.push({ what: `approval before ${x.ref} (“${approve}”)`, why: "not in the goal" }); approve = null; }
    // Z8: a draft is words for a heading (or, for an action carrying no data, its message) — and states nothing the goal does not:
    // every number and address in it must be the person's own. Anything else is dropped, named; the input is then asked.
    const may = new Set(draftablePorts(spec, cat, i, w.valueAction));
    const isHeading = (p: string) => !!cat.items.find((it) => it.ref === x.ref)?.params?.find((q) => q.name === p)?.heading;
    const drafts: Record<string, string> = {};
    // …or one line beside a FILE that carries the data: a value this action states fills a port that needs a port only a step's
    // output fills (declared — "a csv report"). The rows go in the file; the message is then words of its own.
    const ps = cat.items.find((it) => it.ref === x.ref)?.params ?? [];
    const filed = spec.values.some((v) => !!v.fills?.startsWith(`${x.ref}.`) && ps.some((q) => q.name === v.fills!.slice(v.fills!.lastIndexOf(".") + 1) && !!q.needs && !!ps.find((r) => r.name === q.needs)?.fromStep));
    for (const [p, t] of Object.entries(a.drafts ?? {})) {
      const facts = t.match(/[\w.+-]+@[\w.-]+|\d[\d,.]*/g) ?? [];
      const why = !may.has(p) ? "not an input whose words are drafted"
        : !isHeading(p) && takes !== "nothing" && !filed ? "this action carries data, so that is its content, not a draft"
        : t.length > 200 ? "too long for a draft"
        : facts.find((fct) => !quoted(fct)) ? `it states “${facts.find((fct) => !quoted(fct))}”, which the goal does not` : null;
      if (why) dropped.push({ what: `draft for ${x.ref}.${p} (“${t}”)`, why }); else drafts[p] = t;
    }
    // P7 (R24): what an action per group sends is a field of its item — only per item, and only the field a group carries its rows in.
    const content = per && a.content === GROUP_ROWS ? a.content : undefined;
    return { takes, path, approve, ...(Object.keys(drafts).length ? { drafts } : {}), ...(per ? { per } : {}), ...(perWords ? { perWords } : {}), ...(orphan ? { orphan } : {}), ...(content ? { content } : {}) };
  });
  const shared = new Set(sharedValues(spec));
  const valueAction: Record<number, number> = {};
  for (const [k, j] of Object.entries(w.valueAction ?? {})) {
    const vi = Number(k), v = spec.values[vi];
    if (!v || !shared.has(vi) || spec.sinks[j]?.ref !== v.fills!.slice(0, v.fills!.lastIndexOf("."))) continue;
    valueAction[vi] = j;
  }
  // A for-each with no action inside does nothing per item: stated, and dropped.
  if (each && !actions.some((a) => a.per)) { dropped.push({ what: `for each “${each.quote}”`, why: "no action happens for each item" }); each = undefined; }
  // The otherwise's own words are kept only as the person's words, and only while an action runs otherwise.
  const otherwise = w.otherwise && quoted(w.otherwise) && actions.some((a) => a.path === "otherwise") ? w.otherwise : undefined;
  return { wiring: { ...(each ? { each } : {}), paths, actions, ...(Object.keys(valueAction).length ? { valueAction } : {}), ...(otherwise ? { otherwise } : {}) }, dropped };
}

/** The wiring in the readback: each path, what each action takes, and each approval — so the person confirms the connections too. */
export function wiringReadback(w: Wiring | undefined, spec: GoalSpec, cat: BuilderCatalogue): string[] {
  if (!w) return [];
  const about = (ref: string) => shortAbout(cat.items.find((i) => i.ref === ref)?.about ?? ref);
  const listWords = (k: string) => {
    const [kind, n] = k.split(":") as [string, string];
    if (kind === "reader") { const s = spec.sources[Number(n)]; return s ? `the rows of ${about(s.ref)}` : k; }
    if (kind === "list") { const sh = (spec.shapes ?? [])[Number(n)]; return sh ? `the list “${sh.stages.at(-1)?.quote ?? sh.over}”` : k; }
    if (kind === "action") { const x = spec.sinks[Number(n)]; return x ? `the output of “${x.quote}”` : k; }
    if (kind === "step") return `${n} (already in the automation)`;
    if (kind === "in") return `the existing path ${n}`;
    if (k === "item") return "the item";
    if (k === "each") return "what happened to each item (one row per item)";
    return k;
  };
  const lines: string[] = [];
  const CMP_WORDS: Record<WiringCmp, string> = { gt: "is more than", ge: "is at least", lt: "is less than", le: "is at most", eq: "is", ne: "is not" };
  const measureWords = (p: WiringPath) => p.measure === "count" ? `the number of ${listWords(p.subject).replace(/^the rows of /, "")}` : p.measure === "value" ? listWords(p.subject) : `${p.measure} of ${listWords(p.subject)}`;
  // Phase F: the for-each first — what it runs over, in the person's words — so the per-item lines below read as its body.
  if (w.each) lines.push(`For each of ${listWords(w.each.over)} — for “${w.each.quote}”: ${spec.sinks.filter((_, i) => w.actions[i]?.per).map((x) => `“${x.quote}”`).join(", ")}`);
  // builder-behaviour P1: an item's tests read as themselves, all of them — a fact the read returns in its own words.
  const itemTest = (t: ItemTest) => t.about && (t.test === "is_true" || t.test === "is_false") ? `${t.test === "is_false" ? "not " : ""}“${t.about}”`
    : `its ${t.field} ${TEST_WORDS[t.test as CondTest] ?? t.test}${t.against ? ` its ${t.against}` : t.input ? ` the input “${spec.inputs?.find((i) => i.id === t.input)?.words ?? t.input}”` : t.value ? ` ${t.value}` : ""}`;
  w.paths.forEach((p) => lines.push(p.subject === "item" && p.where?.length ? `When, for each item: ${p.where.map(itemTest).join(" and ")} — for “${p.quote}”`
    : p.subject === "item" ? `When, for each item: its ${p.measure} ${CMP_WORDS[p.cmp!]} ${p.value} — for “${p.quote}”`
    : p.subject.startsWith("in:") ? `When: ${listWords(p.subject)} — for “${p.quote}”`
    // A reader's row field is a row test: it holds when some row passes (the engine's `decideField`).
    : p.test === "compare" && p.subject.startsWith("reader:") && p.measure !== "count" && p.measure !== "value" ? `When: at least one of ${listWords(p.subject)} passes “${p.measure} ${CMP_WORDS[p.cmp!]} ${p.value}” — for “${p.quote}”`
    : p.test === "compare" ? `When: ${measureWords(p)} ${CMP_WORDS[p.cmp!]} ${p.value} — for “${p.quote}”`
    : p.test === "split" ? `Split: ${listWords(p.subject)} where ${p.measure} ${CMP_WORDS[p.cmp!]} ${p.value}, and the rest — for “${p.quote}”`
    : `When: ${listWords(p.subject)} ${p.test === "any" ? "has rows" : "has none"} — for “${p.quote}”`));
  spec.sinks.forEach((x, i) => {
    const a = w.actions[i];
    if (!a) return;
    const on = typeof a.path === "number" ? (w.paths[a.path]?.test === "split" ? ` — the rows that match “${w.paths[a.path]?.quote}”` : ` — only when “${w.paths[a.path]?.quote}”`)
      : a.path === "otherwise" ? " — otherwise" : typeof a.path === "string" ? ` — the rest (not “${w.paths[Number(a.path.slice(5))]?.quote}”)` : "";
    const takes = a.takes === "nothing" ? "only the words the goal gives" : a.takes === "unsaid" ? null : listWords(a.takes);
    const each = a.per ? ` — once for each item${a.perWords ? ` (“${a.perWords}”)` : ""}` : a.perWords ? ` — once, for all of them (“${a.perWords}”)` : "";
    if (takes || on || each) lines.push(`“${x.quote}”${takes ? ` takes ${takes}` : ""}${each}${on}`);
    if (a.approve) lines.push(a.per === "item" ? `Before “${x.quote}”, once for all the items: a person approves them together, before any is done — for “${a.approve}”` : `Before “${x.quote}”: a person approves — for “${a.approve}”`);
    for (const [p, t] of Object.entries(a.drafts ?? {})) lines.push(`${p} of “${x.quote}”: “${t}” (drafted from your goal — change it if you like)`);
  });
  return lines;
}

/** The wiring's own quotes, so `unaccountedClauses` counts the goal's condition and approval words as used. */
export const wiringQuotes = (w: Wiring | undefined) => (w ? [...(w.each ? [w.each.quote] : []), ...(w.otherwise ? [w.otherwise] : []), ...w.paths.map((p) => p.quote), ...w.actions.flatMap((a) => [...(a.approve ? [a.approve] : []), ...(a.perWords ? [a.perWords] : [])])] : []);

/** The reply that states no connection — no paths, every action `unsaid` and `always` — for the prompt's own actions (a stub's, or a caller that wants none). */
export function unsaidWiringFor(prompt: string): WiringReply {
  const ids = [...prompt.matchAll(/^- (a\d+): /gm)].map((m) => m[1]!);
  // Phase F: with lists to name, the schema also asks for the for-each (none) and, per action, how often (once).
  const lists = /^- (reader:\d+|list:\d+|step:\S+: the rows)/m.test(prompt);
  return { ...(lists ? { each: null } : {}), paths: [], actions: Object.fromEntries(ids.map((k) => [k, { takes: "unsaid", path: "always", approve: null, ...(lists ? { per: "once" as const, per_words: "" } : {}) }])) };
}

/** Z6: an automation's existing parts as wiring keys — from its steps, by code. */
export function existingParts(f: { steps: Array<{ id: string; kind: string; ref?: string; from?: string; conditions?: Array<{ left: { stepId: string }; op: string }>; elseOf?: string }> }, modelText: (ref: string) => boolean): WiringExisting {
  const words = (b: (typeof f.steps)[number]) => b.conditions?.length ? `the path where ${b.conditions.map((c) => `${c.left.stepId} ${c.op === "any" ? "has rows" : "has no rows"}`).join(" and ")}` : `the otherwise path (none of the conditions before it holds)`;
  return {
    lists: f.steps.filter((s) => s.kind === "datasource" || s.kind === "transform").map((s) => ({ key: `step:${s.id}` as const, words: s.kind === "datasource" ? `the rows ${s.id} reads (${s.ref ?? "not chosen"})` : `the rows of ${s.id}, shaped from ${s.from}`, ...(s.kind === "datasource" && s.ref ? { ref: s.ref } : {}) })),
    producers: f.steps.filter((s) => s.kind === "tool" && !!s.ref && modelText(s.ref)).map((s) => ({ key: `step:${s.id}` as const, words: `the text ${s.id} writes (${s.ref})` })),
    paths: f.steps.filter((s) => s.kind === "branch").map((s) => ({ key: `in:${s.id}` as const, words: words(s) })),
  };
}

/**
 * A for-each whose OWN words carry lists' tests runs over those lists (2026-10-01: "for each open order that was promised before
 * 20 june 2026 and hasn't shipped at all" came back as three one-filter lists, read by nothing, and a loop over every row — the
 * apology went to every customer). Decided by code, not asked of a model: the lists over the loop's rows whose every stage the
 * loop's words quote are merged, in order, into ONE list, and the loop runs over it. Only filters merge — a total, a sort or a cut
 * changes what the rows are, and stays its own list. Every list key is re-pointed after the merge.
 */
export function loopOverItsWords(spec: GoalSpec): GoalSpec {
  const w = spec.wiring, each = w?.each, shapes = spec.shapes ?? [];
  if (!w || !each || !shapes.length) return spec;
  const lower = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const words = lower(each.quote);
  const over = each.over.startsWith("reader:") ? spec.sources[Number(each.over.slice(7))]?.ref
    : each.over.startsWith("list:") ? shapes[Number(each.over.slice(5))]?.over : undefined;
  if (!over) return spec;
  const read = new Set<number>();
  const note = (k?: string) => { if (k?.startsWith("list:")) read.add(Number(k.slice(5))); };
  for (const a of w.actions) note(a.takes);
  for (const p of w.paths) note(p.subject);
  const target = each.over.startsWith("list:") ? Number(each.over.slice(5)) : -1;
  const merge = shapes.flatMap((sh, si) => (si !== target && !read.has(si) && sh.over === over && sh.stages.length
    && sh.stages.every((st) => st.op === "filter" && !!st.quote.trim() && words.includes(lower(st.quote))) ? [si] : []));
  if (!merge.length) return spec;
  const into = target >= 0 ? target : merge[0]!;
  const gone = new Set(merge.filter((si) => si !== into));
  const stages = [...(target >= 0 ? shapes[target]!.stages : []), ...merge.flatMap((si) => shapes[si]!.stages)];
  // Re-index: a removed list's key now names the merged one; every later list moves down by the removed lists before it.
  const at = (si: number) => (gone.has(si) ? into : si) - [...gone].filter((g) => g < (gone.has(si) ? into : si)).length;
  const re = <K extends string | undefined>(k: K): K => (k?.startsWith("list:") ? (`list:${at(Number(k.slice(5)))}` as K) : k);
  const kept = shapes.map((sh, si) => (si === into ? { ...sh, stages } : sh)).filter((_, si) => !gone.has(si));
  return {
    ...spec,
    shapes: kept,
    wiring: {
      ...w,
      each: { ...each, over: `list:${at(into)}` as ListKey },
      actions: w.actions.map((a) => ({ ...a, takes: re(a.takes) })),
      paths: w.paths.map((p) => ({ ...p, subject: re(p.subject) })),
    },
  };
}
