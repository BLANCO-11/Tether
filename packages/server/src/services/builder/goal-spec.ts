/**
 * The GoalSpec (compiled-builder phase 4, task 1; D-304): what a goal ASKS FOR, in the catalogue's terms — which readers it
 * names, which actions it wants, the values it states, its conditions and schedule — with every claim tied to the words of
 * the goal that make it. The model fills this in under a strict schema whose enums are the workspace's own components
 * (D-307); code checks each quote against the text, renders the readback, and derives the outcome. The person confirms the
 * readback before anything is built, and the confirmed spec is stored with the revision.
 *
 * ⚠ Nothing a model writes is shown to the person as prose: the readback is assembled from the catalogue's own descriptions,
 * the spec's enum choices, and verbatim quotes of the person's words (the DB-operation readback's idiom).
 */
import { checkWiring, restatedCuts, sameShapes, unreadShapes, wiringQuotes, wiringReadback, type Wiring, type WiringExisting } from "./wiring.js";
import { cronProblem } from "@foundry/flow-edit";
import { ENUM_BUDGET, enumCount, S, type Schema } from "./strict-schema.js";
import { isPeriod, relativeWords, type Relative, type SpecInput } from "./inputs.js";
import { AGG_FNS, checkShapes, DERIVE_FNS, INPUT_REF, SHAPE_OPS, shapeReadback, stageRefs, type Shape } from "./shape.js";

/** One component the builder may choose, as the person and the model read it. */
export interface CatalogueItem {
  ref: string; kind: "reader" | "tool"; about: string;
  /** The component's parameters as the catalogue describes them — what a stated value can be mapped to (D-322, `fills`). */
  params?: Array<{ name: string; about: string; /** D-323: the value the catalogue STATES — never the person's question. */ default?: string; /** Carries words a person reads (declared). */ message?: boolean; /** A subject or a title (declared) — drafted from the goal when unsaid (Z8). */ heading?: boolean; /** The only values it takes (I-301). */ values?: string[]; /** Only a step's output fills it — never a stated value (declared). */ fromStep?: boolean; /** Builds nothing without this port (declared: a file's format needs its rows). */ needs?: string }>;
  /** A tool called with GET: it looks something up and changes nothing — never one of the goal's actions. */
  lookup?: boolean;
  /** A tool whose output is model-written text: it prepares a result, it delivers nothing (declared). */
  modelText?: boolean;
  /** A reader's row fields, with their types in words — what a condition the flow applies may test (D-326). */
  fields?: Array<{ name: string; ty: string; /** The only values the field holds, when known (I-301: declared, or observed). */ values?: string[] }>;
}
/** `tables`: the readers built from the schema (D-311, slice 5d), by ref — what the build lowers a table-reader step with. */
/** `tables`: every read that carries its own form — a table reader, or a read written for one flow (with its parameters). */
export interface BuilderCatalogue { items: CatalogueItem[]; tables?: Record<string, { datasource: string; spec: unknown; sql: string; tables: string[]; paramOrder?: string[]; paramsSchema?: Record<string, unknown> }> }

export const VALUE_ROLES = ["recipient", "channel", "period", "date", "threshold", "count", "subject", "text", "other"] as const;
/** Where a value comes from: stated in the goal (quoted), the requester's own address (D-310), asked now, or asked each run. */
export const VALUE_FROM = ["goal", "requester", "ask_person", "flow_input", "earlier"] as const;
/**
 * What the MODEL may say a value comes from (E5.5, 2026-09-27): never `ask_person`. Which questions to ask is the builder's
 * decision, made by code from what the finished flow still needs — the model's asks were ~24 of ~30 unneeded or repeated
 * questions, and removing them took the replayed builds from 2/16 to 8/16. `ask_person` stays in `VALUE_FROM` only so an older
 * spec still type-checks; `checkSpec` drops it.
 */
export const MODEL_VALUE_FROM = ["goal", "requester", "flow_input", "earlier"] as const;
export const NONE_FIT = "none_fit";
/**
 * Slice 5f: the goal does not say what should happen with the data — no action, or only a verb ("flag", "chase", "remind") more than
 * one listed action could do. Distinct from `none_fit` (it says what, and nothing here does it): `unsaid` is a question, never a
 * refusal. Its quote may be empty (there may be no words for it).
 */
export const UNSAID = "unsaid";
export const UNCLEAR_ABOUT = ["data", "action", "condition", "value"] as const;

/**
 * builder-behaviour P1 (R4): a summary a WRITTEN read computes — one row per group (`by`, its columns), each carrying the measures
 * (named by code), in the asked order, at most `limit` rows. Computed by the read, never by the flow over capped rows.
 */
export interface SpecSummary { over: string; quote: string; by: string[]; measures: Array<{ name: string; fn: string; field: string | null; words: string; counts?: string | null; bands?: Array<{ test: string; value: string; then: number; words: string }> }>; sort?: { by: string; dir: "asc" | "desc" }; limit?: number; /** the goal's words for each grouping (parallel to `by`) — what an unclear flag is held against, never asked */ byWords?: string[] }
/**
 * P10 (bands, generic): a measure labelling each row by the first matching band of a field, counting its weight —
 * any thresholded bucketing ("hours → 0.5/1", "amount → small/large", "age → bands"), never one scenario's shape.
 */
export interface SpecBandMeasure { name: string; fn: "band_count"; field: string | null; words: string; counts?: string | null; bands: Array<{ test: string; value: string; then: number; words: string }> }
/** builder-behaviour P7 (R15): a `rows` recipient's address field — `n/a` (not a rows recipient), `none` (no field holds it). */
export const RECIPIENT_FIELD_NA = "n/a", RECIPIENT_FIELD_NONE = "none";

export interface GoalSpec {
  sources: Array<{ ref: string; quote: string }>;
  sinks: Array<{ ref: string; quote: string }>;
  /** `fills`: the `ref.param` this value is for, or `none` (D-322) — the model's READING of which input the words belong to; code
   *  then checks the words against that port's type. Absent on specs stored before D-322. */
  /** `named`: a number a comparison needs that the goal only NAMES ("below the threshold") — a read input, asked, never its words. */
  /** `input` / `relative` / `days` (builder-inputs P1): the plan input this value carries to a reader's or a written read's parameter. */
  values: Array<{ role: (typeof VALUE_ROLES)[number]; from: (typeof VALUE_FROM)[number]; quote: string; fills?: string; named?: boolean; as?: string; input?: string; relative?: Relative; days?: number;
    /** builder-behaviour P7 (R15), a `rows` recipient only: the address field the plan chose for those people (`none`: no field is theirs). */
    field?: string }>;
  /** builder-inputs P1: what the automation must be told, separate from whether its value is known — and where code placed it. */
  inputs?: SpecInput[];
  /** builder-inputs P1: parts of the plan code could not lower — each stated unmet, never dropped in silence. */
  planGaps?: string[];
  /** A written read's parameters the AUTOMATION fills each run — the day it runs, or the moment it runs (`RUN_PARAMS`). */
  runParams?: Array<{ fills: string; at: "day" | "time" }>;
  /** builder-behaviour P1 (R4): what a WRITTEN read computes over its rows — its contract (a saved reader's is lowered to stages). */
  summary?: SpecSummary;
  /** builder-behaviour P3 (R7): the goal's words that only join the others or say why — nobody's data (the plan's `joining`). */
  joining?: string[];
  /** `by`: the reader that already selects exactly these rows (its description says so), or `the_flow` when the flow must apply it (I-299). */
  /**
   * D-326, for a condition the FLOW applies: `field` (`reader.field`, or `none`), `test`, and `value` — the goal's own words for the
   * compared value, copied exactly ("critical", "80"), or empty for a true/false or an empty/present test. Nothing else.
   */
  conditions: Array<{ quote: string; by?: string; field?: string; test?: CondTest; value?: string }>;
  schedule: { cron: string; quote: string } | null;
  /** What the goal needs that no component here provides, in the model's words — shown as a quote-less gap, never as advice. */
  missing: string | null;
  /**
   * E5.5: the goal's words the model could NOT tie to one listed component, field or value — a vague reference ("the usual chase",
   * "that attendance thing") or a vague measure it could not make a condition ("forever"). The one thing only the model can know;
   * what happens next is code's: the person is asked what they mean, the goal is re-understood once, and anything still unclear
   * is stated unmet — never built as a guess. Absent on specs stored before it.
   */
  /** `assumed`: set by code, never the model — what a written read took these words as; the person is asked to confirm it. */
  /** `missing`: set by code — why a written read could not give these words (no column holds it, …); said with the question. */
  /** `read`: set by code — the written read whose interpretation `assumed` is, so a confirmation is credited to that read. */
  unclear?: Array<{ quote: string; about: (typeof UNCLEAR_ABOUT)[number]; assumed?: string; missing?: string; read?: string }>;
  /**
   * Set by code, never the model's spec call: the person's words a WRITTEN READ implements (2026-10-01) — what it said it expresses
   * (`covers`), or an interpretation of it the person confirmed (`as`). A definition the person gave ("if 0 hours on a working day
   * then that's a leave") is the read's rule; without this it was filed as "nothing built here does it" once it was settled.
   * Kept only while `by` is a source of the spec and the words are the person's.
   */
  covered?: Array<{ quote: string; by: string; as?: string }>;
  /**
   * Slice 5e: what the flow does to a reader's rows, in the engine's own combinators (`shape.ts`). Absent on specs stored before it,
   * whose `conditions` with a field are still built as filters.
   */
  shapes?: Shape[];
  /** Phase Y: how the parts connect — paths, what each action takes, approvals, values per action (`wiring.ts`). Absent before it. */
  wiring?: Wiring;
}

/** At most this many actions in one goal (phase Y: a goal with a condition and its otherwise names five — I-310 had them cut at 4). */
export const MAX_SINKS = 6;
/** The strict schema for one workspace: readers and tools as enums, each with the explicit exit `none_fit` (D-307). */
export const FILLS_NONE = "none";
/** A condition no chosen reader already applies: the flow must (I-299). */
export const BY_FLOW = "the_flow";
/** What a condition the flow applies can test (D-326): a flag, a value the goal quotes, or presence. No implied constants. */
export const COND_TESTS = ["is_true", "is_false", "equals", "not_equals", "below", "above", "at_most", "at_least", "is_empty", "not_empty", "date_passed", "date_not_passed", "older_than_days", "within_days"] as const;
/** Tests that compare a date with the DAY THE FLOW RUNS (slice 5d) — computed at firing time, never a value anyone types. */
export const RUN_DAY_TESTS: ReadonlySet<CondTest> = new Set(["date_passed", "date_not_passed"]);
export type CondTest = (typeof COND_TESTS)[number];
/** Tests that compare with a value — which must then be the goal's own words. */
export const VALUED_TESTS: ReadonlySet<CondTest> = new Set(["equals", "not_equals", "below", "above", "at_most", "at_least", "older_than_days", "within_days"]);
export const ORDERING_TESTS: ReadonlySet<CondTest> = new Set(["below", "above", "at_most", "at_least", "older_than_days", "within_days"]);
/** Tests whose value is a number of DAYS before the day the flow runs (slice 5d). */
export const DAYS_TESTS: ReadonlySet<CondTest> = new Set(["older_than_days", "within_days"]);
/** A condition the flow applies whose value the goal did not SAY: code asks the person what counts (E5.5). */
export const needsValue = (c: GoalSpec["conditions"][number]) =>
  (!c.by || c.by === BY_FLOW) && !!c.field && c.field !== FILLS_NONE && !!c.test && VALUED_TESTS.has(c.test) && !c.value?.trim();
/** Every `reader.field` a condition may test: the catalogue's own row fields, nothing composed. */
export const fieldPairs = (cat: BuilderCatalogue) => cat.items.filter((i) => i.kind === "reader").flatMap((i) => (i.fields ?? []).map((f) => `${i.ref}.${f.name}`));
/** Every `ref.param` a value may fill: the catalogue's own parameters, nothing composed. */
export const paramPairs = (cat: BuilderCatalogue) => cat.items.flatMap((i) => (i.params ?? []).map((p) => `${i.ref}.${p.name}`));
/** At most this many sources, and conditions a goal states. */
export const MAX_SOURCES = 4;
/**
 * How many values a goal can state, from the catalogue: every parameter of each action it may name (`MAX_SINKS` of them), every
 * parameter of each reader it may read, and a threshold per condition. A fixed 8 was fewer than three emails each with a recipient,
 * a sender and a subject — the model had to leave some out, and a value named twice (one address for three emails) went first
 * (2026-09-30: "from finance-bot@…" said three times, the sender asked).
 */
export const maxValues = (cat: BuilderCatalogue) => {
  const most = (kind: "reader" | "tool") => Math.max(0, ...cat.items.filter((i) => i.kind === kind).map((i) => i.params?.length ?? 0));
  return MAX_SINKS * most("tool") + MAX_SOURCES * most("reader") + MAX_SOURCES;
};
export function goalSpecSchema(cat: BuilderCatalogue): Schema {
  const readers = cat.items.filter((i) => i.kind === "reader").map((i) => i.ref);
  const tools = cat.items.filter((i) => i.kind === "tool").map((i) => i.ref);
  const pairs = paramPairs(cat);
  return S.obj({
    sources: S.arr(S.obj({ ref: S.oneOf([...readers, NONE_FIT]), quote: S.str("the goal's own words that ask for this data, copied exactly") }), MAX_SOURCES),
    sinks: S.arr(S.obj({ ref: S.oneOf([...tools, NONE_FIT, UNSAID]), quote: S.str("the goal's own words that ask for this action, copied exactly; for `unsaid`, the vague words, or empty when there are none") }), MAX_SINKS),
    values: S.arr(S.obj({ role: S.oneOf([...VALUE_ROLES]), from: S.oneOf([...MODEL_VALUE_FROM]), quote: S.str("the goal's words for this value, copied exactly; for `requester` the word that means the person (\"me\"); for `earlier` the value exactly as listed under VALUES ALREADY IN THIS AUTOMATION"), fills: S.oneOf([...pairs, FILLS_NONE]) }), maxValues(cat)),
    conditions: S.arr(S.obj({
      quote: S.str("the goal's words for rows a chosen reader ALREADY selects, copied exactly"),
      by: S.oneOf(readers.length ? readers : [NONE_FIT]),
    }), 3),
    schedule: S.nullable(S.obj({ cron: S.str("five fields: minute hour day month weekday"), quote: S.str("the goal's words that say when, copied exactly") })),
    missing: S.nullable(S.str("what the goal needs that none of the listed components provides")),
    unclear: S.arr(S.obj({ quote: S.str("the goal's words you could not tie to one listed component, field or value, copied exactly"), about: S.oneOf([...UNCLEAR_ABOUT]) }), 4),
  });
}

/** Lower-case, curly quotes straightened, whitespace collapsed — the comparison a quote is checked under. */
export const norm = (t: string) => t.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
/** Is `quote` the person's own words? Verbatim (modulo case and spacing) in the goal or a correction, and not empty. */
export const quoted = (quote: string, texts: string[]) => {
  const q = norm(quote).replace(/^["'.,;:!?…]+|["'.,;:!?…]+$/g, "");
  if (!q) return false;
  // An ELIDED quote (“post ... to linkedin”) is the person's words with a gap: every fragment verbatim, in order, within ONE text.
  // Each fragment is still copied, so nothing un-said passes; rejecting it discarded R21's refusal along with its sink (2026-09-27).
  const parts = q.split(/\s*(?:\.{3}|…)\s*/).filter(Boolean);
  return texts.some((t) => {
    const n = norm(t);
    let at = 0;
    for (const p of parts) { const i = n.indexOf(p, at); if (i < 0) return false; at = i + p.length; }
    return true;
  });
};

/**
 * Is `value` a WHOLE word or phrase of the person's words? A compared value is short, and a substring match lets "0" pass because the goal
 * says "2026-06-30" (D-326) — so it must stand on word boundaries.
 */
/** Every phrase the person put in quotation marks ("…", “…”), across their words, each once. Apostrophes are not quotes. */
export const quotedPhrases = (texts: string[]): string[] =>
  [...new Set(texts.flatMap((t) => [...t.matchAll(/"([^"\n]{2,200})"|“([^”\n]{2,200})”/g)].map((m) => (m[1] ?? m[2]!).trim())).filter(Boolean))];

export const quotedWord = (value: string, texts: string[]) => {
  const v = norm(value).replace(/^["'.,;:!?]+|["'.,;:!?]+$/g, "");
  if (!v) return false;
  const re = new RegExp(`(^|[^a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
  return texts.some((t) => re.test(norm(t)));
};
/** S6 delta-only (2026-10-08): is this unclear flag anchored to settled words — quotes the automation already placed, frozen facts on replan. Exact-norm membership only, never fuzzy: a miss re-asks (a correction settles it once), while a fuzzy hit would swallow a paraphrase in silence. Fuzzy `sameWords` stays for new-question dedup only. */
export const settledMatch = (quote: string, settled: readonly string[]): boolean => {
  const q = norm(quote);
  return !!q && settled.some((s) => norm(s) === q);
};

/** Tests that compare a field's text with a value for sameness — the ones a value domain decides (I-301). */
export const SAME_TESTS: ReadonlySet<CondTest> = new Set(["equals", "not_equals"]);
/** A reader field's value domain (I-301), or `null` when unknown. */
export const domainOf = (cat: BuilderCatalogue, field: string): string[] | null => {
  const at = field.lastIndexOf("."), item = cat.items.find((i) => i.ref === field.slice(0, at));
  return item?.fields?.find((f) => f.name === field.slice(at + 1))?.values ?? null;
};
/** Whether a field is open text: the kind of column whose values nothing here knows — an equality on it is read back as unchecked. */
export const openText = (cat: BuilderCatalogue, field: string): boolean => {
  const at = field.lastIndexOf("."), f = cat.items.find((i) => i.ref === field.slice(0, at))?.fields?.find((x) => x.name === field.slice(at + 1));
  return !!f && !f.values && /^(Option<)?Text>?$/.test(f.ty);
};
/**
 * I-301, checked by CODE: a compared value on a field whose domain is KNOWN must be one of its values. The model may map the person's
 * word onto one (“fulfilled” → `shipped`) — the readback shows both, so the person can reject it; case differences are the member.
 * A value outside the domain answers `outside`: it is cleared, and the person is asked with the real values.
 */
export function inDomain(cat: BuilderCatalogue, field: string, value: string): { member: string } | { outside: string[] } | null {
  const values = domainOf(cat, field);
  if (!values) return null;
  // Then the ONE reading the port reader uses ("interns" → Intern, "annual leaves" → Annual Leave): two readers of "which known
  // value do these words name" that disagree asked "which counts as interns?" over a member the words plainly name.
  const hit = values.find((v) => v === value.trim()) ?? values.find((v) => v.toLowerCase() === value.trim().toLowerCase());
  return hit !== undefined ? { member: hit } : { outside: values };
}

export interface CheckedSpec {
  spec: GoalSpec;
  /** Claims removed because their quote is not the person's words, or their component is not in the catalogue. */
  dropped: Array<{ what: string; why: string }>;
  /**
   * Clauses of the goal that no claim in the spec quotes and nothing dropped states: part of what the person asked for that the
   * model left out WITHOUT saying so (2026-09-27: "…, create a well structured report for it" vanished). Never silent: read back and
   * unmet, so the flow is never complete doing less than asked. Absent on specs checked before it.
   */
  unaccounted?: string[];
  /** Clauses of the person's ANSWERS nothing in the spec uses — stated in the readback, not unmet (they explain; they are not work). */
  unused?: string[];
  /** The goal's own words, for reading a value in their context (a date's year the goal names once). Absent on older traces. */
  texts?: string[];
}

/**
 * The code half of the spec: every quote must be the person's words, every ref a component here, a schedule a valid cron.
 * A failed claim is DROPPED and named, never repaired. A value is only ever the person's words: one they did not say is dropped
 * (the parameter stays open, and the BUILDER decides whether to ask); vague words never fill a parameter, and when they fill none
 * they are kept, so the solver states them unmet rather than letting them vanish (R13's “too long”, E5.5).
 */
/**
 * `known` (Z5, I-322): the values already in the automation being changed — what the person gave before, on its steps. A value
 * `from: "earlier"` must be exactly one of them; anything else is dropped, the same bound a goal quote is held to.
 * `settled` (S6 delta-only, 2026-10-08): quotes the head revision placed — frozen facts on replan. An unclear flag anchored to
 * one (exact-norm `settledMatch`, never fuzzy) is hard-dropped, never asked. Held ONLY against unclear flags; default empty.
 */
export function checkSpec(raw: GoalSpec, texts: string[], cat: BuilderCatalogue, known: string[] = [], existing?: WiringExisting, settled: string[] = []): CheckedSpec {
  const dropped: CheckedSpec["dropped"] = [];
  const has = (ref: string, kind: CatalogueItem["kind"]) => ref === NONE_FIT || (kind === "tool" && ref === UNSAID) || cat.items.some((i) => i.ref === ref && i.kind === kind);
  const keep = (what: string, ok: boolean, why: string) => { if (!ok) dropped.push({ what, why }); return ok; };
  const refs = (xs: GoalSpec["sources"], kind: CatalogueItem["kind"]) =>
    xs.filter((x) => keep(`${kind} ${x.ref}`, has(x.ref, kind), "not a component in this workspace") && keep(`${kind} ${x.ref}`, (x.ref === UNSAID && !x.quote.trim()) || quoted(x.quote, texts), `“${x.quote}” is not in the goal`));
  // D-323: a parameter the catalogue STATES a value for is never asked — the model sometimes asks anyway (E5.3, 2026-09-27: R11 asked
  // for `prod_env`, `stale_key`, `missing_state`; R16 and D17 for `cancelled_status`). Dropped, stated; the solver binds the default.
  const stated = (fills?: string) => { if (!fills || fills === FILLS_NONE) return undefined; const ref = fills.slice(0, fills.lastIndexOf(".")), port = fills.slice(fills.lastIndexOf(".") + 1); return cat.items.find((i) => i.ref === ref)?.params?.find((p) => p.name === port)?.default; };
  const asked = raw.values.filter((v) => {
    if (v.from !== "ask_person") return true;
    const d = stated(v.fills);
    dropped.push({ what: `${v.role} → ${v.fills ?? FILLS_NONE}`, why: d !== undefined ? `the catalogue states it (“${d}”), so it is not asked` : "what to ask is the builder's to decide, from what the flow still needs" });
    return false;
  });
  // A value with NO role that fills NOTHING is words the spec could not place: no parameter takes it and no test can use an unroled
  // value. Code cannot tell "all the cost centers" (a description) from "VIP customers only" (a restriction nothing built) — so the
  // person is asked what they mean, before anything is built on them (E5.5), never "unused" after (2026-10-01, 47d1e01e).
  const unplaced: Array<{ quote: string; about: "value" }> = [];
  const values = asked.flatMap((v): GoalSpec["values"] => {
    // The person who runs it is a PERSON: they can receive something, never be its wording, period or threshold.
    if (v.from === "requester" && v.role !== "recipient") { dropped.push({ what: `${v.role} “${v.quote}”`, why: "only a recipient can be the person who runs it — the parameter stays open" }); return []; }
    // builder-inputs P1: a value carrying a plan INPUT is already typed and placed by code — none of the word rules below apply to it
    // (they guessed, from the words alone, whether a value was vague, relative or unplaced; the plan now says so). Still the person's words.
    if (v.input) return v.from === "goal" && !quoted(v.quote, texts) ? (dropped.push({ what: `${v.role} “${v.quote}”`, why: "not in the goal — the parameter stays open" }), []) : [v];
    if (v.role === "other" && (!v.fills || v.fills === FILLS_NONE) && v.from === "goal" && quoted(v.quote, texts)) { unplaced.push({ quote: v.quote, about: "value" }); return []; }
    if (v.from === "earlier") return known.some((k) => norm(k) === norm(v.quote)) ? [v] : (dropped.push({ what: `${v.role} “${v.quote}”`, why: "not a value already in this automation" }), []);
    if (v.from === "goal" && !quoted(v.quote, texts)) { dropped.push({ what: `${v.role} “${v.quote}”`, why: "not in the goal — the parameter stays open" }); return []; }
    // A message's WORDS are the person's only when they quote them ("say “we're on it”"). Words that DESCRIBE the message ("a well
    // structured report", "nicely") are not its text: filling a message port with them sends the description itself (2026-09-27, a
    // chat build: “a well structured report of it” became the email's body). Dropped, stated; the action is given the data instead.
    const toMessage = !v.fills || v.fills === FILLS_NONE || !!cat.items.find((i) => i.ref === v.fills!.slice(0, v.fills!.lastIndexOf(".")))?.params?.find((p) => p.name === v.fills!.slice(v.fills!.lastIndexOf(".") + 1))?.message;
    if (v.from === "goal" && v.role === "text" && toMessage && !inQuotes(v.quote, texts)) { dropped.push({ what: `text “${v.quote}”`, why: "it describes the message rather than giving its words — the message is the data" }); return []; }
    // Step 5 (builder-IR): no silent repair — the relative period/date the model stated stands as written.
    // A value no flow can hold is reported by validatePlan / the coverage checks, never rewritten here.
    return [v];
  });
  const conditions = raw.conditions.filter((c) => keep(`condition “${c.quote}”`, quoted(c.quote, texts), "not in the goal"));
  let schedule = raw.schedule;
  if (schedule && (!keep("schedule", quoted(schedule.quote, texts), `“${schedule.quote}” is not in the goal`) || !keep("schedule", !cronProblem(schedule.cron), cronProblem(schedule.cron) ?? ""))) schedule = null;
  const sources = refs(raw.sources, "reader"), sinks = refs(raw.sinks, "tool");
  // A value's `fills` must name a parameter of a component the spec KEPT — mapping a value onto a component the goal does not use
  // (or that was just dropped) would wire the person's words into nothing they confirmed.
  const kept = new Set([...sources, ...sinks].map((x) => x.ref));
  // A condition said to be applied by a reader holds only if that reader is one this goal READS; otherwise the flow must apply it.
  for (const [i, c] of conditions.entries()) {
    if (!c.by || c.by === BY_FLOW) continue;
    if (!sources.some((x) => x.ref === c.by)) { dropped.push({ what: `condition “${c.quote}” → ${c.by}`, why: "not a reader this goal uses, so the flow must apply it" }); conditions[i] = { ...c, by: BY_FLOW }; }
  }
  // D-326: a condition the FLOW applies tests one field of a reader this goal reads, and compares with the goal's own words or with
  // nothing (a flag, presence). An unstated value ("running late" = "> 0") is never supplied here: the test is dropped, stated, and
  // the condition stays unmet.
  const fields = new Set(fieldPairs(cat));
  // The readers a condition or a shape may test: the ones this goal reads, and — in an EDIT — the ones the automation already reads
  // (2026-10-01: "make sure we only get employees with more than 10 working days" could filter nothing, because the reader was
  // already in the flow and not among this message's sources; "10" was left over as an unused value).
  const usable = [...new Set([...sources.map((x) => x.ref), ...(existing?.lists ?? []).flatMap((l) => (l.ref ? [l.ref] : []))])];
  // Step 5 (builder-IR): DELETED — the 0/1 `counted`/`quantified`/`derivedOk` derivation rewrote the model's stated
  // values from the goal's words (a second authority over a count's value). The model's value stands as written;
  // a count that states nothing is reported by the coverage checks, never derived here.
  // Step 5 (builder-IR): no silent repair — the model's stated member mapping and values stand as written.
  // A value outside the field's known values is reported by the coverage checks, never rewritten or cleared here.
  for (const [i, c] of conditions.entries()) {
    if (c.by && c.by !== BY_FLOW) continue;
    if (!c.field || c.field === FILLS_NONE || !c.test) continue;
    const reader = c.field.slice(0, c.field.lastIndexOf("."));
    const why = !fields.has(c.field) || !usable.includes(reader) ? "not a field of a reader this goal uses"
      : VALUED_TESTS.has(c.test) && c.value?.trim() && !quotedWord(c.value, texts) ? `its value “${c.value}” is not the goal's words`
      : !VALUED_TESTS.has(c.test) && c.value?.trim() ? "a true/false or presence test takes no value" : null;
    if (why) { dropped.push({ what: `condition “${c.quote}” → ${c.field} ${c.test}${c.value ? ` ${c.value}` : ""}`, why }); conditions[i] = { quote: c.quote, by: BY_FLOW, field: FILLS_NONE }; continue; }
  }
  const checkedShapes = checkShapes(raw.shapes, {
    sources: usable, fields, quoted: (q) => quoted(q, texts), quotedWord: (v) => quotedWord(v, texts),
    valued: VALUED_TESTS, ordering: ORDERING_TESTS, vague: () => null,
    domain: (field, test, value) => (SAME_TESTS.has(test) ? inDomain(cat, field, value) : null),
    nullable: (field) => {
      const ty = cat.items.find((it) => it.ref === field.slice(0, field.lastIndexOf(".")))?.fields?.find((f) => f.name === field.slice(field.lastIndexOf(".") + 1))?.ty;
      return ty === undefined || ty.startsWith("Option<");
    },
  });
  dropped.push(...checkedShapes.dropped);
  // Step 5 (builder-IR): no silent repair — the model's stated values and tests stand as written
  // (the `quantified` 0/1 derivation and the `withStatedDay` test rewrite are deleted).
  const shapes = checkedShapes.shapes;
  // Nothing is sent: a recipient has nothing to receive (2026-09-27, "get me a list" read back "Who receives it: you"). Dropped, stated.
  // A model's text delivers nothing either: only an action that is not model-written text receives anyone.
  const delivers = sinks.some((x) => x.ref === UNSAID || x.ref === NONE_FIT || !cat.items.find((i) => i.ref === x.ref)?.modelText);
  if (!delivers) for (let i = values.length - 1; i >= 0; i--) if (values[i]!.role === "recipient" || values[i]!.role === "channel") { dropped.push({ what: `${values[i]!.role} “${values[i]!.quote}”`, why: "nothing is sent, so nobody receives it" }); values.splice(i, 1); }
  const pairs = new Set(paramPairs(cat));
  for (const [i, v] of values.entries()) {
    if (!v.fills || v.fills === FILLS_NONE) continue;
    const ref = v.fills.slice(0, v.fills.lastIndexOf("."));
    if (!pairs.has(v.fills) || !kept.has(ref)) { dropped.push({ what: `${v.role} → ${v.fills}`, why: "not a parameter of a component this goal uses" }); values[i] = { ...v, fills: FILLS_NONE }; }
  }
  // `missing` names an ABSENT COMPONENT (a `none_fit` source or sink) — or is D-321's refusal of a non-additive edit. A
  // `missing` beside no `none_fit` is an unstated detail filed as an absence: dropped, because an unstated value is a
  // question (`ask_person`), and filing it under `missing` would turn an `asks` goal into a `cannot`.
  let missing = raw.missing?.trim() || null;
  if (missing && missing !== EDIT_NOT_ADDITIVE && ![...sources, ...sinks].some((x) => x.ref === NONE_FIT)) { dropped.push({ what: `missing “${missing}”`, why: "no component was found absent; an unstated value is asked, not missing" }); missing = null; }
  // An unclear flag on words the spec ALSO tied to something precise contradicts itself (E5.5, unclear-r2: "weekly", "the support
  // channel", "the account owner"): a value, the schedule, or a condition with a field and test (whose own "what counts" question is
  // the more precise one). Dropped, stated. Kept when the words are tied to nothing, or only to a component choice — the model
  // picking a reader it is unsure of is exactly what the person must settle.
  const lc = (t: string) => t.toLowerCase().trim();
  // Words that NAME a field of a reader this spec reads are that field (2026-10-01: "with their email and department name" asked
  // "what do you mean by email?" over rows with `email` and `department_name`): the field's own words, or a one-word name that ends
  // exactly ONE field's name ("email" → `work_email`). Read from the reader's declared fields, never from what a word usually means.
  const readFields = sources.flatMap((x) => cat.items.find((i) => i.ref === x.ref)?.fields ?? []).map((fd) => fd.name.toLowerCase());
  const namesAField = (q: string) => {
    const w = lc(q).replace(/^(their|its|the|his|her)\s+/, "").replace(/\s+/g, "_");
    if (readFields.includes(w)) return true;
    // Word by word, a plural and its singular are one word ("vendor name" is `vendors_name`, a joined table's column) — English forms.
    const stem = (n: string) => n.split("_").map((t) => t.replace(/(ies)$/, "y").replace(/(ses|xes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/(?<!s)s$/, "")).join("_");
    if (readFields.some((n) => stem(n) === stem(w))) return true;
    return !w.includes("_") && readFields.filter((n) => n.endsWith(`_${w}`)).length === 1;
  };
  const declaredBy = (q: string) => {
    const w = lc(q).replace(/^(an?|the|their|its)\s+/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !!w && sources.some((x) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(lc(cat.items.find((i) => i.ref === x.ref)?.about ?? "")));
  };
  const overlaps = (a: string, b: string) => !!a.trim() && !!b.trim() && (lc(a).includes(lc(b)) || lc(b).includes(lc(a)));
  // A flag on words the summary already ties down contradicts itself the same way: a measure's words, its grouping, or the
  // summary's own quote are placed, never the person's to explain ("for each employee" asked as unclear over a per-employee
  // summary, 2026-10-06). A measure with no field is unbuilt work — stated unmet by the coverage check, never asked as unclear.
  const bandArms = (raw.summary?.measures ?? []).flatMap((m) => m.bands ?? []);
  // A question is settled by the summary's band arms only when it quotes a
  // band's own label (`b.words`) — the model's typed words, never English
  // keywords. Weight/edge numbers alone never settle: too common.
  const summaryWords = [
    ...(raw.summary?.measures ?? []).map((m) => m.words),
    ...(raw.summary?.by ?? []),
    ...(raw.summary?.byWords ?? []),
    ...(raw.summary?.quote ? [raw.summary.quote] : []),
    ...bandArms.map((b) => b.words).filter((w) => w.trim()),
  ];
  /** For-each / per-X grouping the summary or wiring already places — never "what do you mean by for each employee?". */
  const eachPlaced = !!(raw.summary?.by?.length || raw.summary?.byWords?.length || raw.wiring?.each);
  const eachSettled = (q: string) =>
    eachPlaced && (/\bfor\s+each\b|\bfor\s+every\b|\beach\s+\w+|\bper\s+\w+/i.test(q) || (raw.summary?.byWords ?? []).some((w) => overlaps(q, w)));
  const precise = [...values.map((v) => v.quote), ...(schedule ? [schedule.quote] : []), ...conditions.filter((c) => c.field && c.field !== FILLS_NONE && c.test).map((c) => c.quote), ...shapes.flatMap((sh) => sh.stages.map((x) => x.quote))];
  const unclear = [...(raw.unclear ?? []), ...unplaced.filter((x) => !(raw.unclear ?? []).some((u) => overlaps(u.quote, x.quote)))].filter((u) => keep(`unclear “${u.quote}”`, quoted(u.quote, texts), "not in the goal")
    // a READ's own question (`read` set) was judged where it was made — what it took the data's words to mean is never
    // settled by an action or value whose words happen to hold them.
    && keep(`unclear “${u.quote}”`, (!!(u as { read?: string }).read) || !precise.some((p: string) => overlaps(p, u.quote)), "the spec already ties these words to a value, the schedule, a condition or a stage")
    // nor by the read's OWN field names or description — the read named them after these very words.
    && keep(`unclear “${u.quote}”`, (!!(u as { read?: string }).read) || !namesAField(u.quote), "these words name a field of the rows it reads")
    // Words a reader this spec reads DECLARES of every row it gives ("Every open ticket …" settles "open", 2026-10-01): its own
    // description, as whole words — the declaration answers them, so nobody is asked.
    && keep(`unclear “${u.quote}”`, (!!(u as { read?: string }).read) || !declaredBy(u.quote), "the reader it reads says this of every row it gives")
    && keep(`unclear “${u.quote}”`, !/^(about\s+)?(it|its|them|they|their|this|that|these|those|him|her|his)$/i.test(u.quote.trim()), "a pronoun refers to what the goal already says")
    && keep(`unclear “${u.quote}”`, (!!(u as { read?: string }).read) || !summaryWords.some((p) => overlaps(p, u.quote)), "the summary already ties these words to a measure, a grouping or its own quote")
    && keep(`unclear “${u.quote}”`, (!!(u as { read?: string }).read) || !eachSettled(u.quote), "the summary already groups for-each / per-item")
    && keep(`unclear “${u.quote}”`, (!!(u as { read?: string }).read) || !settledMatch(u.quote, settled), "the automation already has these words as built"));
  // Z7 (I-324): a phrase the person QUOTED lands or is stated — never dropped in silence. One inside an action's own clause is that
  // action's words: it fills the action's one message port nothing else fills (the report: `post "No overdue invoices this week" to
  // #finance-ops` kept the channel and lost the words; the question that followed replaced them). Anything else is stated.
  const valueAction = { ...(raw.wiring?.valueAction ?? {}) } as Record<number, number>;
  // A value of a tool used by more than one action belongs to the action whose own clause holds its words, when exactly one does —
  // the person's words decide, over the model's guess (the live run gave `#finance-ops` to the other post and then asked for it).
  for (const [vi, v] of values.entries()) {
    const ref = v.fills && v.fills !== FILLS_NONE ? v.fills.slice(0, v.fills.lastIndexOf(".")) : "";
    if (!ref || sinks.filter((x) => x.ref === ref).length < 2 || !v.quote.trim()) continue;
    // The SAME words for the same input, more than once, are one per action (each action's own recipient, F05): the words cannot
    // tell them apart, and giving all of them to the one action whose clause holds the words leaves the others' input empty.
    if (values.filter((o) => o.fills === v.fills && lc(o.quote) === lc(v.quote)).length > 1) continue;
    const holders = sinks.flatMap((x, j) => (x.ref === ref && lc(x.quote).includes(lc(v.quote)) ? [j] : []));
    if (holders.length === 1) valueAction[vi] = holders[0]!;
  }
  for (const q of quotedPhrases(texts)) {
    if (values.some((v) => v.from === "goal" && overlaps(v.quote, q)) || conditions.some((c) => c.value && overlaps(c.value, q))) continue;
    const owners = sinks.flatMap((x, j) => (x.quote && lc(x.quote).includes(lc(q)) ? [j] : []));
    const j = owners.length === 1 ? owners[0]! : -1;
    const ref = j >= 0 ? sinks[j]!.ref : "";
    const shared = sinks.filter((x) => x.ref === ref).length > 1;
    const own = (vi: number) => !shared || valueAction[vi] === j;
    const open = (cat.items.find((i) => i.ref === ref)?.params ?? []).filter((p) => p.message && !values.some((v, vi) => v.fills === `${ref}.${p.name}` && own(vi)));
    if (open.length !== 1) { dropped.push({ what: `“${q}”`, why: j < 0 ? "quoted in the goal, but no one action's words contain it — nothing uses it" : `quoted in the goal; ${ref} has ${open.length ? "several" : "no"} open text inputs, so it is not placed` }); continue; }
    values.push({ role: "text", from: "goal", quote: q, fills: `${ref}.${open[0]!.name}` });
    if (shared) valueAction[values.length - 1] = j;
  }
  // What a written read implements of the person's words: theirs, and owned by a read this spec still reads — else stated, dropped.
  // Bookkeeping, not the person's claim: an entry that no longer holds is dropped SILENTLY (a "Left out" line would report a read's
  // revision as something of theirs that was lost). One entry per quote.
  // A band cover is often a goal clause (accounting split), not a separately typed answer — keep it when
  // it still sits inside the goal text even if `quoted` is picky about punctuation.
  const coveredInTexts = (q: string) => {
    if (quoted(q, texts)) return true;
    const g = norm(texts[0] ?? "");
    const qn = norm(q).replace(/^["'.,;:!?…]+|["'.,;:!?…]+$/g, "");
    return !!qn && !!g && g.includes(qn);
  };
  const covered = (raw.covered ?? []).filter((c, k, all) => coveredInTexts(c.quote) && sources.some((x) => x.ref === c.by) && all.findIndex((o) => norm(o.quote) === norm(c.quote)) === k);
  const base: GoalSpec = { sources, sinks, values, conditions, schedule, missing, ...(unclear.length ? { unclear } : {}), ...(shapes.length ? { shapes } : {}), ...(covered.length ? { covered } : {}), ...(raw.inputs?.length ? { inputs: raw.inputs } : {}), ...(raw.planGaps?.length ? { planGaps: raw.planGaps } : {}), ...(raw.runParams?.length ? { runParams: raw.runParams } : {}), ...(raw.summary ? { summary: raw.summary } : {}), ...(raw.joining?.length ? { joining: raw.joining } : {}) };
  // Phase Y: the wiring refers to THESE kept parts by index, so it is checked last, against them.
  const wired = checkWiring(raw.wiring ? { ...raw.wiring, valueAction } : raw.wiring, base, (q) => quoted(q, texts), cat, existing);
  dropped.push(...wired.dropped);
  // The person an approval asks is not someone the action sends to: "ask ME to approve it first" names the approver. A recipient
  // tied to no input whose words are inside an approval's own words is that approver — dropped, stated (2026-09-30: "me" read as a
  // fourth recipient left "a recipient is not tied to one of the 3 actions"). Positions renumbered, so `valueAction` still points
  // at the same values.
  const approvals = (wired.wiring?.actions ?? []).map((a) => a.approve).filter((q): q is string => !!q).map((q) => ` ${q.toLowerCase().replace(/[^a-z0-9@. ]+/g, " ")} `);
  const approver = (v: GoalSpec["values"][number]) => v.role === "recipient" && (!v.fills || v.fills === FILLS_NONE) && !!v.quote.trim()
    && approvals.some((q) => q.includes(` ${v.quote.toLowerCase().trim()} `));
  const stayed = base.values.map((v, i) => ({ v, i })).filter(({ v }) => { if (!approver(v)) return true; dropped.push({ what: `recipient “${v.quote}”`, why: "the person asked to approve, not someone it is sent to" }); return false; });
  if (stayed.length !== base.values.length && wired.wiring) {
    const at = new Map(stayed.map(({ i }, j) => [i, j]));
    const va = wired.wiring.valueAction;
    wired.wiring = { ...wired.wiring, ...(va ? { valueAction: Object.fromEntries(Object.entries(va).flatMap(([k, a]) => (at.has(Number(k)) ? [[at.get(Number(k))!, a]] : []))) } : {}) };
  }
  let spec: GoalSpec = { ...base, values: stayed.map(({ v }) => v), ...(wired.wiring ? { wiring: wired.wiring } : {}) };
  // The GOAL's clauses are work: one nothing does is unmet. An ANSWER's clauses explain the goal's words — one nothing uses is stated
  // in the readback ("From your answers, not used"), never filed as unmet: as unmet it came back as a question after every
  // re-reading, growing, while the person explained the same thing three times (2026-10-01). Something the person ADDS is part of
  // the goal (`continueBuild` extends it), and is held to the goal's rule.
  const account = accountingOf(texts[0] ?? "", spec, dropped, namesAField);
  const unaccounted = account.unaccounted;
  const unused = [...new Set(texts.slice(1).flatMap((t) => unaccountedClauses(t, spec, dropped, namesAField)))];
  return { spec, dropped, ...(unaccounted.length ? { unaccounted } : {}), ...(unused.length ? { unused } : {}), texts: [...texts] };
}

/** The goal's own clauses — split on its punctuation and joining words — each at least three words (the accounting's split). */
export function goalClauses(goal: string): string[] {
  const n = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  // A "." between two digits is a decimal ("9.5+ hours"), never the end of a clause — split there and "if someone worked 9" became
  // a clause nobody wrote, reported as not built.
  return goal.split(/[,;!?\n]|(?<!\d)\.|\.(?!\d)|->|→|\band then\b|\bthen\b|\band\b/i).map((c) => c.trim()).filter((c) => n(c).split(" ").length >= 3);
}

/**
 * RETIRED 2026-10-07: English-vocabulary tokenising (generic stop-words, singular folding) behind the old
 * word-overlap gates. No gate ranks or matches on it anymore. Do not reuse for ranking.
 */
const GENERIC_WORDS = new Set([
  "the", "and", "for", "are", "was", "has", "had", "his", "her", "its", "our", "but", "not", "who", "how", "why", "all",
  "any", "can", "may", "too", "own", "let", "otherwise", "else", "then", "than", "also", "when", "where", "while", "what",
  "with", "from", "into", "have", "will", "would", "should", "could", "none", "some", "zero", "never", "this", "that",
  "these", "those", "they", "them", "their", "there", "here", "very", "more", "most", "many", "much", "only", "just",
  "still", "each", "every", "about", "after", "before", "because", "don't", "dont", "table", "tables", "list", "lists",
  "view", "views", "sheet", "sheets", "report", "reports", "data", "row", "rows", "record", "records", "step", "steps",
  "action", "actions", "thing", "things", "part", "parts", "read", "reads", "reader", "readers", "tool", "tools",
  "component", "components", "automation", "flow", "flows", "field", "fields", "column", "columns", "value", "values",
  "name", "names", "item", "items", "anything", "something", "everything",
]);
export function matchWords(text: string): string[] {
  const one = (w: string) => w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y`
    : w.length > 4 && /(s|x|ch|sh)es$/.test(w) ? w.slice(0, -2)
    : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
  return [...new Set(norm(text).split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w))
    .map(one).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)))];
}
/**
 * RETIRED 2026-10-07: the half-overlap test behind the old `none_fit` re-ask, direction target, and narrow recall.
 * No caller ranks on it anymore — kept exported only so existing imports keep parsing. Do not reuse for ranking.
 */
export function wordsCover(text: string, candidates: Iterable<string>, ratio = 0.5): boolean {
  const want = matchWords(text);
  if (!want.length) return false;
  const need = Math.ceil(want.length * ratio);
  return [...candidates].some((c) => { const have = new Set(matchWords(c)); return want.filter((w) => have.has(w)).length >= need; });
}
/** RETIRED 2026-10-07: a component's bag of words behind the old overlap gates. No caller reads it anymore. */
export const componentWords = (i: CatalogueItem): string =>
  [i.ref, i.about, ...(i.fields ?? []).map((f) => f.name), ...(i.params ?? []).map((p) => p.name)].join(" ");
/**
 * P2 (RC-3, 2026-10-07): the listed components of `kind` that could carry a `none_fit` quote — a STRUCTURED
 * shortlist, never a guess ranked by word overlap. Catalogue order; already-chosen refs excluded by the
 * caller in plan.ts; declared Address types untouched here. A lookup is never a candidate: it changes
 * nothing, and the plan's enum excludes it too. Empty only when nothing is offered (genuinely absent) —
 * callers then emit a question naming what the workspace HAS, never a refusal and never silence.
 * Kept name + signature: plan.ts and goal-spec.test.ts call it unchanged.
 */
export const noneFitCandidates = (quote: string, kind: CatalogueItem["kind"], cat: BuilderCatalogue): string[] =>
  quote.trim() ? cat.items.filter((i) => i.kind === kind && !i.lookup).map((i) => i.ref) : [];


// A clause that only says NOTHING happens ("otherwise do nothing", "else nothing") asks for no step: doing nothing does it.
const NOTHING = /^(otherwise|else|if not|or else)?[\s,]*(just\s+)?(do\s+)?(nothing|no action)(\s+(else|happens))?[.!]?$/i;
// A clause that only NAMES fields the read rows carry ("with the vendor name", "including the hostname") is done by reading them:
// every field of a read row travels with it. The names are the reader's declared fields (`namesAField`), never a word list.
const CARRIES = /^(with|including|incl|showing|listing|plus|along with)\s+(.+)$/i;
// Joining words, and the quantifiers a condition is made of ("if there are none" is the other side of "if there are any": its
// words are a branch's structure, carried by the wiring, not work of their own).
const JOINING = new Set(["otherwise", "else", "then", "also", "when", "that", "this", "they", "them", "their", "there", "with", "from", "into", "have", "will", "would", "should", "could", "none", "some", "zero", "never"]);


export function specHasReadProjection(spec: GoalSpec): boolean {
  return !!(spec.summary || spec.sources.length || (spec.covered?.length ?? 0) > 0);
}

export function specHasRunMonthInput(spec: GoalSpec): boolean {
  return (spec.inputs ?? []).some(
    (i) => i.relative === "this_month" || (i.fill === "from_run_date" && i.kind === "month"),
  );
}

/** Is this clause accounted for by any of `quotes`? (False: nothing states it — the accounting's raw answer.) */
function uncoveredBy(c: string, quotes: string[], namesAField: (words: string) => boolean): boolean {
  const onlyFields = (x: string) => { const m = CARRIES.exec(x.trim()); return !!m && m[2]!.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean).every(namesAField); };
  if (NOTHING.test(c.trim()) || onlyFields(c)) return false;
  const cw = c.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const isContent = (w: string) => w.length > 3 && !JOINING.has(w);
  // A quote that holds the clause, or lies inside it and says something, accounts for it. A quote of joining words alone claims
  // nothing (2026-10-02: a stage quoted “otherwise” accounted for all of “otherwise email the reminder straight away”, and the
  // email that clause asks for was never stated lost).
  if (quotes.some((q) => q.includes(cw) || (cw.includes(q) && q.split(" ").some(isContent)))) return false;
  const content = cw.split(" ").filter(isContent);
  // Only structure: accounted for by a quote sharing two of its words (one longer than three letters) — the condition it belongs to.
  if (!content.length) { const words = new Set(cw.split(" ")); return !quotes.some((q) => q.split(" ").filter((w) => words.has(w)).length >= 2 && q.split(" ").some((w) => w.length > 3 && words.has(w))); }
  const touching = quotes.filter((q) => q.split(" ").some((w) => content.includes(w)));
  const got = new Set(touching.flatMap((q) => q.split(" ")));
  return !(touching.length && content.every((w) => got.has(w)));
}

/**
 * An exclusion OPERATOR: closed-class function words that remove rows — a negated
 * auxiliary (`don't`/`dont`, `doesn't`, …), `cannot`/`not`, `without`, `except`.
 * Never a field, table, value or label, so no domain vocabulary (Step 6). `none`,
 * `never` and `nothing` are deliberately absent: they say what a branch does
 * ("if there are none", "otherwise do nothing"), not which rows are excluded.
 */
const EXCLUSION_OP = /\b(don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|couldn'?t|wouldn'?t|shouldn'?t|hasn'?t|haven'?t|hadn'?t|won'?t|cannot|not|without|except)\b/i;
/**
 * The goal's clauses — split on its own punctuation and joining words, three words or more — that no quote in the spec (kept or
 * dropped-and-stated) covers, and the DIRECTIONS among them. Structural: a clause is accounted for when it lies inside a quote,
 * or every content word of it is in the quotes that touch it. No vocabulary beyond joining words: nothing here knows what a
 * clause is about. A DIRECTION (P3, RC-4: "leave the otherwise arm empty") is never an obligation: asking what NOTHING should
 * do is not accounting — `checkSpec` stands it up instead (satisfied, or a stated removal).
 * A row exclusion the spec lowers NOWHERE (no `Plan.rows[]`/condition test, no shape filter, no unclear question quoting it)
 * stays unaccounted: a written read's `covered` claim and band/summary words never lower a row test, so word-overlap with them
 * can never cover one (2026-10-08, flow ea74b355: "dont include days where …" was claimed by `covered[]` with `conditions: []`
 * and no filter, and built as complete). Code may refuse or ask; never silently drop.
 */
function accountingOf(goal: string, spec: GoalSpec, dropped: CheckedSpec["dropped"], namesAField: (words: string) => boolean): { unaccounted: string[]; directions: Array<{ clause: string; target: string }> } {
  const clean = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  // The quotes that lower, ask, branch on, or state a row test: a condition, a shape
  // filter stage (`Plan.rows[]`/`conditions[]` lower to `{ op: "filter" }` stages —
  // group/sort/limit stages compute, they never exclude rows), an unclear question,
  // the wiring's paths, a stated drop, or the source/sink/value whose words it shares.
  // A row exclusion lowered NOWHERE (no condition/filter/unclear quote touching it)
  // stays unaccounted: `covered` claims and band/summary words never lower a row
  // test, so overlap with them can never cover one (2026-10-08, flow ea74b355).
  const strict = [
    ...spec.sources.map((x) => x.quote), ...spec.sinks.map((x) => x.quote), ...spec.values.map((v) => v.quote), ...spec.conditions.map((c) => c.quote),
    ...(spec.shapes ?? []).flatMap((sh) => sh.stages.filter((st) => st.op === "filter").map((x) => x.quote)), ...(spec.unclear ?? []).map((u) => u.quote),
    ...wiringQuotes(spec.wiring),
    ...dropped.flatMap((d) => [...d.what.matchAll(/“([^”]+)”/g)].map((m) => m[1]!)),
  ].map(clean).filter(Boolean);
  // Every quote the accounting counts: the spec's claims, and the dropped ones that STATED themselves in the readback.
  const quotes = [
    ...strict,
    ...(spec.shapes ?? []).flatMap((sh) => sh.stages.filter((st) => st.op !== "filter").map((x) => x.quote)), ...(spec.schedule ? [spec.schedule.quote] : []),
    ...(spec.covered ?? []).map((c) => c.quote),
    // The summary's own words cover "need a report of …" shreds that lie inside it (UAT column-list goals).
    ...(spec.summary ? [spec.summary.quote, ...(spec.summary.byWords ?? [])] : []),
  ].map(clean).filter(Boolean);
  if (!spec.schedule) {
    quotes.push(
      "when it is started",
      "runs when you start it",
      "when i start it",
      "when the workflow is triggered",
      "when workflow is triggered",
    );
  }
  for (const i of spec.inputs ?? []) {
    if (i.relative === "this_month" || (i.fill === "from_run_date" && i.kind === "month")) {
      quotes.push(i.words, "the month it runs", "month of run day", "month of the run day", "take the month of run day as input for period");
    }
  }
  const unaccounted: string[] = [];
  const directions: Array<{ clause: string; target: string }> = [];
  for (const c of goalClauses(goal)) {
    if (uncoveredBy(c, EXCLUSION_OP.test(c) ? strict : quotes, namesAField)) unaccounted.push(c);
  }
  return { unaccounted, directions };
}

export function unaccountedClauses(goal: string, spec: GoalSpec, dropped: CheckedSpec["dropped"], namesAField: (words: string) => boolean = () => false): string[] {
  return accountingOf(goal, spec, dropped, namesAField).unaccounted;
}

/** Are these words inside quotation marks in the person's text — a message they wrote, not one they described? */
export const inQuotes = (quote: string, texts: string[]) => {
  const q = norm(quote).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (!q) return false;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return texts.some((t) => new RegExp(`["“‘'][^"”’']*${esc}[^"“‘']*["”’']`).test(t.toLowerCase().replace(/\s+/g, " ")));
};


export type SpecOutcome = "build" | "asks" | "cannot";
/**
 * Why this workspace cannot build the goal, one line each — empty when it can. The ONE test of "cannot": `specOutcome`
 * decides from it and a refused build reports it, so a refusal always says what it refused on.
 */
export function cannotReasons(spec: GoalSpec): string[] {
  return [
    ...spec.sources.filter((x) => x.ref === NONE_FIT).map((x) => `No reader here provides “${x.quote}”.`),
    ...spec.sinks.filter((x) => x.ref === NONE_FIT).map((x) => `No action here does “${x.quote}”.`),
    ...(spec.missing ? [spec.missing] : []),
  ];
}
/** What the confirmed spec says will happen: a component is missing (cannot), a value must be asked (asks), or build. */
export function specOutcome(spec: GoalSpec): SpecOutcome {
  if (cannotReasons(spec).length) return "cannot";
  if (spec.values.some((v) => v.from === "ask_person") || spec.unclear?.length || spec.sinks.some((x) => x.ref === UNSAID)) return "asks";
  return "build";
}

export const TEST_WORDS: Record<CondTest, string> = { is_true: "is true", is_false: "is false", equals: "is", not_equals: "is not", below: "is below", above: "is above", at_most: "is at most", at_least: "is at least", is_empty: "is empty", not_empty: "is present", date_passed: "is before the day it runs", date_not_passed: "is the day it runs or later", older_than_days: "is more days before the day it runs than", within_days: "is within this many days before the day it runs:" };
const ROLE_WORD: Record<GoalSpec["values"][number]["role"], string> = { recipient: "Who receives it", channel: "Which channel", period: "Which period", date: "Which date", threshold: "The threshold", count: "How many", subject: "The subject", text: "The wording", other: "A value" };
const FROM_WORDS = (v: GoalSpec["values"][number]) =>
  v.from === "goal" ? `“${v.quote}”, from your goal` : v.from === "earlier" ? `“${v.quote}”, as given before` : v.from === "requester" ? "you — the person who runs it" : v.from === "flow_input" ? (v.relative && v.relative !== "none" ? `“${v.quote}”, worked out when it runs (${relativeWords(v.relative, v.days)})` : v.quote ? `“${v.quote}”, given each time it runs` : "asked each time it runs") : "I will ask you";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** A cron in words, for the shapes a goal states (daily / weekly / monthly at a time); anything else is shown as fields. */
export function cronWords(cron: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  const at = /^\d+$/.test(h ?? "") && /^\d+$/.test(m ?? "") ? `at ${h!.padStart(2, "0")}:${m!.padStart(2, "0")}` : null;
  if (at && dom === "*" && mon === "*" && dow === "*") return `every day ${at}`;
  if (at && dom === "*" && mon === "*" && /^[0-6]$/.test(dow ?? "")) return `every ${WEEKDAYS[Number(dow)]} ${at}`;
  if (at && /^\d+$/.test(dom ?? "") && mon === "*" && dow === "*") return `on day ${dom} of every month ${at}`;
  return `on the schedule \`${cron}\` (minute hour day month weekday)`;
}

/** A catalogue description as the person reads it: its first sentence, at most ~100 characters (the rest is written for a model). */
export const shortAbout = (about: string) => {
  const first = about.split(/(?<=[.!?])\s|\s[—–-]\s/)[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 97).replace(/\s+\S*$/, "")}…` : first;
};

/** I-301: an equality on text whose values nothing here knows is never presented as verified. */
const unchecked = (cat: BuilderCatalogue, field: string, test: CondTest | undefined, value: string | undefined) =>
  test && SAME_TESTS.has(test) && value?.trim() && openText(cat, field) ? ` — could not check that “${value.trim()}” is a value of \`${field.slice(field.lastIndexOf(".") + 1)}\`` : "";

/** The readback the person confirms: every line from the catalogue, an enum, or their own quoted words. */
export function readback(checked: CheckedSpec, cat: BuilderCatalogue): string[] {
  const { spec } = checked;
  const about = (ref: string) => shortAbout(cat.items.find((i) => i.ref === ref)?.about ?? ref);
  const lines: string[] = [];
  for (const s of spec.sources) lines.push(s.ref === NONE_FIT ? `Reads: nothing here provides “${s.quote}”` : `Reads: ${about(s.ref)} (${s.ref}) — for “${s.quote}”`);
  for (const s of spec.sinks) lines.push(s.ref === NONE_FIT ? `Does: nothing here can “${s.quote}”` : s.ref === UNSAID ? `Does: not said${s.quote ? ` (“${s.quote}”)` : ""} — I will ask you what should happen and who should get it` : `Does: ${about(s.ref)} (${s.ref}) — for “${s.quote}”`);
  // Which parameter each value goes into, in words the person can check — "“nicely” → the email's body" is a claim they can reject;
  // "A value: “nicely”" was not (D04: a tone word became an email's whole body, confirmed unseen).
  // builder-inputs P1: an input a flow filter compares with — how it is given, said once; a stage names it by its words, never its id.
  const inputOf = (id: string) => spec.inputs?.find((i) => i.id === id);
  const namedInputs = (l: string) => l.replace(/“input:([a-z0-9_]+)”/g, (m, id: string) => { const i = inputOf(id); return i ? `the input “${i.words}”` : m; });
  // builder-behaviour P1 (R4): what the written read computes over its rows.
  if (spec.summary) {
    const sm = spec.summary, FN: Record<string, string> = { count: "how many", sum: "the total of", avg: "the average of", min: "the smallest", max: "the largest", distinct_count: "how many different" };
    lines.push(`Computes: ${sm.by.length ? `one row per ${sm.by.map((b) => `\`${b}\``).join(" and ")}` : "one row over all the rows"}, with ${sm.measures.map((m) => `${FN[m.fn] ?? m.fn}${m.field ? ` \`${m.field}\`` : m.fn === "count" ? " rows" : ""} (as \`${m.name}\`)`).join(", ")}${sm.sort ? ` — ${sm.sort.dir === "desc" ? "largest" : "smallest"} \`${sm.sort.by}\` first` : ""}${sm.limit ? ` — the first ${sm.limit} only` : ""} — for “${sm.quote}”`);
  }
  for (const i of spec.inputs ?? []) if (i.at === "flow") lines.push(i.fill === "given" ? `Input: “${i.words}”, from your goal`
    : i.fill === "from_run_date" ? `Input: “${i.words}”, worked out when it runs (${relativeWords(i.relative, i.days)})`
    : `Input: “${i.words}”, given each time it runs${i.kind === "month" ? " — as any day of that month (only its month is used)" : isPeriod(i.kind) ? " — as a first and a last day" : ""}`);
  // A month a person gives is a DATE read by its month — said wherever it is asked, never only on the flow's own filter.
  const monthNote = (v: GoalSpec["values"][number]) => (v.from === "flow_input" && (!v.relative || v.relative === "none") && v.input && inputOf(v.input)?.kind === "month" ? " — as any day of that month (only its month is used)" : "");
  for (const v of spec.values) lines.push(`${ROLE_WORD[v.role]}: ${FROM_WORDS(v)}${monthNote(v)}${v.fills && v.fills !== FILLS_NONE ? ` → \`${v.fills.slice(v.fills.lastIndexOf(".") + 1)}\` of ${v.fills.slice(0, v.fills.lastIndexOf("."))}` : ""}`);
  // A condition with nothing to test whose words ARE a stated path is the path — the wiring's line says it; "not built" would be false.
  const onPath = (q: string) => (spec.wiring?.paths ?? []).some((p) => { const a = q.toLowerCase().trim(), b = p.quote.toLowerCase().trim(); return !!a && !!b && (a.includes(b) || b.includes(a)); });
  for (const c of spec.conditions) if (!((!c.field || c.field === FILLS_NONE) && !(c.by && c.by !== BY_FLOW) && onPath(c.quote))) lines.push(c.by && c.by !== BY_FLOW ? `Only when: “${c.quote}” — already how ${c.by} selects its rows`
    : c.field && c.field !== FILLS_NONE && c.test ? `Only when: “${c.quote}” — keeps rows where \`${c.field.slice(c.field.lastIndexOf(".") + 1)}\` ${TEST_WORDS[c.test]}${c.value ? ` “${c.value}”` : needsValue(c) ? " — I will ask you what counts" : ""}${unchecked(cat, c.field, c.test, c.value)}`
    : `Only when: “${c.quote}” — not built: nothing here states how to test it`);
  // Phase C: a shape is read back as it is BUILT — stages that restate a condition (after a total) and repeated shapes are the
  // condition's, said once by its own line; a list nothing reads is not built (`unreadShapes`), so it is not read back as a step —
  // what it asked for is the condition's or the reader's line, or stated as not done.
  const cuts = restatedCuts(spec), same = sameShapes(spec), unread = unreadShapes(spec);
  for (const [si, sh0] of (spec.shapes ?? []).entries()) {
    if (same.has(si) || unread.has(si)) continue;
    const sh = cuts.has(si) ? { ...sh0, stages: sh0.stages.slice(0, cuts.get(si)) } : sh0;
    lines.push(...shapeReadback(sh, VALUED_TESTS).map((l, k) => { const st = sh.stages[k]!; return `Then (${sh.over}): ${namedInputs(l)}${st.op === "filter" && st.field && !INPUT_REF.test(st.value ?? "") ? unchecked(cat, st.field, st.test ?? undefined, st.value ?? undefined) : ""}`; }));
  }
  lines.push(...wiringReadback(spec.wiring, spec, cat));
  // Unscheduled is a fact about the flow, never silent (E5.13, D10: a watch built with no schedule never ran): it runs when started.
  if (spec.schedule) lines.push(`Runs: ${cronWords(spec.schedule.cron)} — for “${spec.schedule.quote}”`);
  else if (spec.sources.some((x) => x.ref !== NONE_FIT)) lines.push("Runs: when it is started (by you, or by a call to it) — nothing runs it on its own");
  if (spec.missing) lines.push(`Not available in this workspace: ${spec.missing}`);
  for (const c of spec.covered ?? []) lines.push(`Done by the read ${c.by}: “${c.quote}”${c.as ? ` — as ${c.as}` : ""}`);
  for (const u of spec.unclear ?? []) lines.push(u.assumed ? `Assumed: “${u.quote}” read as ${u.assumed} — I will ask you to confirm before building on it` : u.missing ? `Not in the data: “${u.quote}” — ${u.missing}. I will ask you what you mean` : `Unclear: “${u.quote}” — I will ask you what you mean before building on it`);
  for (const d of checked.dropped) lines.push(`Left out: ${d.what} (${d.why})`);
  for (const c of checked.unaccounted ?? []) lines.push(`Not built: “${c}” — nothing here does this yet`);
  for (const c of checked.unused ?? []) lines.push(`From your answers, not used: “${c}”`);
  if (!lines.length) lines.push("Nothing in this goal matched a component here.");
  return lines;
}

/** The intent prompt. The catalogue is listed once, stable; the goal (and any correction) come LAST. */
/**
 * `current`: the automation as it is, when the message is an EDIT of a non-empty flow (D-321). An edit only ADDS — the spec
 * lists what the change adds, and a request to change or remove what is there is a stated `cannot` with `missing` naming it,
 * so it is refused in the readback rather than attempted.
 */
export const EDIT_NOT_ADDITIVE = "a change to or removal of an existing step";
export function goalSpecPrompt(goal: string, cat: BuilderCatalogue, correction?: { previous: string[]; text: string }, current?: string[], known?: string[]): string {
  const list = (kind: CatalogueItem["kind"]) => cat.items.filter((i) => i.kind === kind).map((i) => `- ${i.ref}: ${i.about}${i.params?.length ? `\n    params: ${i.params.map((p) => `${p.name}${p.about ? ` (${p.about})` : ""}${p.default !== undefined ? ` [set by the catalogue: ${p.default}]` : ""}${p.values ? ` [one of: ${p.values.join(", ")}]` : ""}`).join("; ")}` : ""}${i.fields?.length ? `\n    fields: ${i.fields.map((f) => `${f.name} (${f.values ? `one of: ${f.values.join(", ")}` : f.ty})`).join("; ")}` : ""}`).join("\n") || "- (none)";
  return [
    "You map a person's automation goal onto the components of ONE workspace. You do not design the automation; you say what the goal asks for.",
    "Rules:",
    "- A reader whose ref has `.table.` is a table's own rows (with the rows it refers to, and counts of the rows that refer to it); the others were saved for a purpose. Prefer a saved reader whose description already gives the rows the goal asks for; otherwise choose the table whose rows hold the data.",
    "- `sources`: the readers the goal's data comes from. `sinks`: the actions it wants done. Choose only from the lists; if the goal needs something no listed component provides, use `none_fit` and say what in `missing`.",
    "- `sinks` are ONLY what the goal asks to be DONE — sent, posted, created, paged. A goal that asks to get, see, list or report on data (\"show me the open requests\", \"a summary of this week's sign-ups\") has NO sink: the flow's result is the data itself. Never add an action the goal does not ask for; \"me\" in \"get me\" is who asked, not someone to send to.",
    "- Each action the goal asks for is its OWN sink entry, in the order the goal says them — the same component asked for twice (two posts, to two channels; one when something holds and one otherwise) is two entries, each quoting its own words.",
    "- `unsaid` (a sink): the goal asks for something to be done, but only with a vague verb that more than one listed action could do (\"deal with it\", \"take care of these\") — quote those words; the person will be asked which.",
    "- Every `quote` is copied EXACTLY from the goal — the words that make that claim. Never paraphrase; a quote that is not in the goal is discarded.",
    "- `values`: each value the goal SAYS (who receives it, a period, a threshold …). `from`: `goal` when the goal states it (quote it), `requester` when it means the person themself (\"me\", \"my inbox\"), `flow_input` when the goal says it changes each run. List only what the goal says: a value it leaves unsaid is NOT listed — the builder decides what to ask.",
    "- Never invent a value. Vague words (\"plenty\", \"before long\", \"ages\") are still the goal's words: list them as said (`from` `goal`, quoted), never turned into a number.",
    "- `missing` is ONLY for a component no list provides (with `none_fit`). A value the goal leaves unsaid is never `missing`.",
    "- `unclear`: the goal's words you cannot tie to ONE listed component, field or value with confidence — a vague reference (\"the regular report\", \"that list we talked about\", \"the right folks\") or a vague measure you could not make a condition (\"for ages\"). Quote them exactly; the person will be asked what they mean. Do not pick a component for them. Words you DID tie to a value, the schedule, a condition, or the summary (its grouping, a measure, what each result row carries) are not unclear, and schedule words (\"each fortnight\") never are. Empty when everything is clear.",
    "- What the builder does itself is NEVER missing: filtering, sorting, ranking, \"top N\", counting, grouping and picking fields are built from a reader's rows, so choose the reader whose rows HOLD the data even if it is not already filtered or ranked; a person approving before an action is a built-in step, so list the action it guards.",
    "- A verb that means telling someone (\"alert\", \"notify\", \"keep me posted\", \"send word\") is served by an action that sends a message; choose one of those rather than `none_fit`.",
    "- `fills`: the parameter (`ref.param`, from the params listed under a component you chose) that this value is for — e.g. the words for a reporting month fill that reader's month parameter; `none` when it is for none of them.",
    "- `conditions`: ONLY words for rows a reader you chose ALREADY selects (its description says so): `by` is that reader. Everything the flow itself must do to the rows goes in `shapes`.",
    "- What the flow does to the rows is NEVER `unclear` and NEVER `missing` when it is mechanical shaping: an UNAMBIGUOUS sort, limit, or group-by (\"sort by date\", \"top 10\", \"group by team\"). A threshold or a boundary the words leave open (\"oversized orders\", \"urgent\") stays askable — flag it `unclear`, never guess a number for it.",
    "- What the flow does to the rows — which of them, grouped how, in what order, how many — is decided in the NEXT step, from the readers you choose here. Sort, limit and group-by words are never `unclear` when they name their target plainly; threshold/boundary words stay `unclear` whenever the goal leaves the amount open.",
    "- `schedule`: whenever the goal says when or how often it runs (\"hourly\", \"each fortnight\", \"every weekday at noon\") — those words are the schedule, never a value.",
    "",
    "READERS",
    list("reader"),
    "",
    "ACTIONS",
    list("tool"),
    "",
    ...(current ? [
      "THIS IS A CHANGE TO AN EXISTING AUTOMATION",
      `- List ONLY what the change adds: the readers and actions it adds, the values those need. What is already there is kept as it is.`,
      "- Keeping only some of the rows it already reads (\"only the ones who …\", \"just those over …\") ADDS a test on those rows — it is never a change to what is there. Its words are what the flow does to the rows (next step), so they are not `missing`.",
      `- If the change asks to alter or remove something already there (a different reader, action or value, or taking a step away), set \`missing\` to exactly "${EDIT_NOT_ADDITIVE}" and add nothing.`,
      "THE AUTOMATION AS IT IS",
      ...current,
      "",
    ] : []),
    ...(known?.length ? [
      "VALUES ALREADY IN THIS AUTOMATION (given before — where each is used)",
      ...known,
      "- A value the change needs that is one of these (the same person, address, channel …) is `from` `earlier`, quoted exactly as listed — never asked again. Only when the change's words point at it or it is the same kind of value for the same purpose.",
      "",
    ] : []),
    ...(correction ? ["WHAT YOU UNDERSTOOD BEFORE", ...correction.previous.map((l) => `- ${l}`), "", "THE PERSON'S CORRECTION", correction.text, ""] : []),
    "GOAL",
    goal,
  ].join("\n");
}

/**
 * Slice 5e — the SECOND call: what the flow does to the chosen readers' rows. Its field enums are ONLY those readers' fields (and
 * the earlier stages' outputs), so the schema stays small however large the workspace is — the gateway refuses a schema with more
 * than 1000 enum values in total, which one call over every reader's fields exceeded on the three largest workspaces (measured,
 * shape-tuned-r1: 18 of 42 builds refused before the model saw them).
 */
export function shapeSchema(cat: BuilderCatalogue, readers: string[]): Schema {
  const fieldRefs = [...fieldPairs({ items: cat.items.filter((i) => readers.includes(i.ref)) }), ...stageRefs()];
  // The field list appears in FOUR slots, and the gateway counts each (2026-10-01: one SQLite table joined to the tables it refers to
  // gave ~220 fields → 1140 enum values, refused before the model saw it). Past the budget, the secondary slots (against, by, a
  // measure's field) — then, on a reader wider still, `field` too — become plain strings. Nothing is trusted for that: `checkShapes`
  // checks every field the reply names (`refOk`) and refuses an unknown one by name, enum or not.
  const shaped = (field: Schema, other: Schema) => schemaOf(field, other, readers);
  const full = shaped(S.oneOf(fieldRefs), S.oneOf(fieldRefs));
  if (enumCount(full) <= ENUM_BUDGET) return full;
  const named = "a field: `reader.field` from the READERS list, or `stage:<k>` / `stage:<k>:<j>`";
  const primary = shaped(S.oneOf(fieldRefs), S.str(named));
  return enumCount(primary) <= ENUM_BUDGET ? primary : shaped(S.str(named), S.str(named));
}

/** The shape schema with the field slots as given — an enum of the readers' fields, or plain strings past the budget. */
function schemaOf(field: Schema, other: Schema, readers: string[]): Schema {
  return S.obj({
    shapes: S.arr(S.obj({
      over: S.oneOf(readers.length ? readers : [NONE_FIT]),
      stages: S.arr(S.obj({
        op: S.oneOf([...SHAPE_OPS]),
        quote: S.str("the goal's words this stage comes from, copied exactly"),
        field: S.nullable(field),
        test: S.nullable(S.oneOf([...COND_TESTS])),
        value: S.nullable(S.str("the goal's own words for a compared value, a number of rows, or a number in a calculation; empty when it does not say")),
        against: S.nullable(other),
        fn: S.nullable(S.oneOf([...DERIVE_FNS])),
        by: S.nullable(S.arr(other, 2)),
        measures: S.nullable(S.arr(S.obj({ fn: S.oneOf([...AGG_FNS]), field: S.nullable(other) }), 4)),
        dir: S.nullable(S.oneOf(["asc", "desc"])),
      }), 8),
    }), 3),
  });
}

