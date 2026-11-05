/**
 * Chat's ANSWERS (phase X, D-335) — written by code, never by a model. A question about the automation is answered from the stored
 * flow; a question about what can be built is answered from the workspace's catalogue, in each component's own first sentence;
 * anything else gets a fixed line saying what chat is for. So an answer cannot describe a step that is not there or a component
 * the workspace does not have — the rule the deleted editor's prompt spent a paragraph asking a model to keep.
 *
 * Pure: a flow, a catalogue, lines out.
 */
import { armOfStep, chainOf, decideTest, INPUT_TYPES, loopOfStep, splitSide, type CatalogueSnapshot, type Comb, type EFlow, type Pred, type Ty } from "@foundry/flow-edit";

const CMP_SAID: Record<string, string> = { gt: "is more than", ge: "is at least", lt: "is less than", le: "is at most", eq: "is", ne: "is not" };
/** A typed test in words — the field, the comparison, the value; a `notNull` beside it is the null rule, not something to say. */
function predWords(p: Pred): string {
  if ("cmp" in p) { const side = (o: typeof p.left) => ("field" in o ? o.field.replace(/_/g, " ") : "input" in o ? `the ${o.input.replace(/_/g, " ")}` : String(o.lit.value)); return `${side(p.left)} ${CMP_SAID[p.cmp]} ${side(p.right)}`; }
  if ("and" in p) { const xs = p.and.filter((x) => !("notNull" in x)); return xs.map(predWords).join(" and "); }
  if ("or" in p) return p.or.map(predWords).join(" or ");
  if ("not" in p) return `not (${predWords(p.not)})`;
  if ("notNull" in p) return `${p.notNull.replace(/_/g, " ")} is set`;
  if ("isNull" in p) return `${p.isNull.replace(/_/g, " ")} is empty`;
  return `${p.isBlank.replace(/_/g, " ")} is blank`;
}
/** The goal's OWN words for a test, when the flow carries them — a condition built from the spec keeps its quote beside the
 * compared literal (UAT 2026-10-05, RC-5: "if due date is less than the days before 30" was the machine's structure, not the
 * person's "overdue by more than 30 days"). A path's literal instead wears its compared VALUE as the quote, so only a quote that
 * reads as words — more than the value itself, never a bare number or its unit — counts; else `null`, and the structure is said. */
function goalSaid(p: Pred): string | null {
  const words = (o: { lit?: { value: unknown; quote?: string } }) => {
    const q = o.lit?.quote?.trim();
    if (!q || !/\s/.test(q) || q === String(o.lit!.value).trim() || /^-?[\d.,]+(?:\s+[a-z%°]+)?$/i.test(q)) return null;
    return q.replace(/^if\s+/i, ""); // the sentence already says "If"
  };
  if ("cmp" in p) return ("lit" in p.left ? words(p.left) : null) ?? ("lit" in p.right ? words(p.right) : null);
  if ("and" in p) { for (const x of p.and) { const q = goalSaid(x); if (q) return q; } return null; }
  if ("or" in p) { for (const x of p.or) { const q = goalSaid(x); if (q) return q; } return null; }
  if ("not" in p) return goalSaid(p.not);
  return null;
}
/** A test in words: the person's own words quoted when the flow carries them, else the structure. */
const predSaid = (p: Pred): string => { const q = goalSaid(p); return q ? `“${q}”` : predWords(p); };
/** What a Decide compares, in words: "the number of rows", "the total of lines outstanding", or the field — a row test says it is
 * about SOME row ("a row has name is blanco"), or none (`none`: a has-none condition on it). The goal's own words win when carried. */
function decideWords(before: Comb[], where: Pred, anyRow?: boolean, none?: boolean): string {
  const said = goalSaid(where);
  if (said) return `“${said}”`;
  if (anyRow) return `${none ? "no row has" : "a row has"} ${predWords(where)}`;
  const test = "and" in where ? where.and.find((x) => "cmp" in x) ?? where : where;
  if (!("cmp" in test) || !("field" in test.left)) return predWords(where);
  const field = test.left.field;
  for (const st of before) if (st.op === "count" && st.as === field) return `the number of rows ${CMP_SAID[test.cmp]} ${"lit" in test.right ? test.right.lit.value : "…"}`;
  return predWords(where);
}
import type { Chooser } from "./build.js";
import { cronWords, shortAbout, type BuilderCatalogue, type CatalogueItem } from "./goal-spec.js";
import { S, parseStrict } from "./strict-schema.js";
import { isTableRef } from "./table-readers.js";

/** At most this many components of one kind are named in a capabilities answer; the rest are counted. */
export const LIST_MAX = 8;

const aboutOf = (items: BuilderCatalogue, ref: string | undefined) => {
  if (!ref) return "data not chosen yet";
  const item = items.items.find((i) => i.ref === ref);
  return item ? `${shortAbout(item.about)} (${ref})` : ref;
};

const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t).replace(/\.$/, "");
const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const baseTy = (t: Ty): Ty => (t.t === "Option" || t.t === "List" ? baseTy(t.of) : t);
/** What a list-shaping step does, in a verb — only the stages a person asked for; bounding and projecting are plumbing. */
const STAGE_VERB: Record<string, string> = { filter: "filters", group: "totals", summarize: "totals", sort: "sorts", count: "counts", distinct: "de-duplicates" };

/** What one action does, from what it DECLARES (its ports and flags) — never its name, never the catalogue's sales line.
 * `openPort` — a port of this step still holding a hole — so an UNBOUND recipient is said as unset instead of as the
 * requester fallback ("emails it to you" while the findings say it cannot send: UAT 2026-10-05, RC-5). */
function actionWords(s: Extract<EFlow["steps"][number], { kind: "tool" }>, cat: CatalogueSnapshot | undefined, openPort?: (stepId: string, port: string) => boolean): string {
  const sig = cat?.refs[s.ref];
  if (sig?.modelText) return "writes a summary of it";
  const lit = (name: string) => { const b = s.inputs.find((i) => i.name === name)?.source; return b?.from === "literal" ? b.value : b ? "field" : null; };
  // Who it goes to (I-316): the address port that CARRIES something — a list of addresses before a single one (the sender of a
  // message is one address; its recipients are a list) — else the port that falls back to whoever runs it, else the first.
  const addrs = (sig?.params ?? []).filter((p) => baseTy(p.ty).t === "Address");
  const isList = (t: Ty): boolean => t.t === "List" || (t.t === "Option" && isList(t.of));
  const bound = addrs.filter((p) => lit(p.name) !== null);
  const addr = [...bound].sort((a, b) => Number(isList(b.ty)) - Number(isList(a.ty)))[0] ?? addrs.find((p) => p.fallsBackToRequester) ?? addrs[0];
  if (addr) {
    // What the send is NAMED by, when its words are set — its declared heading (a subject, a title): two sends of one tool in one
    // flow are told apart by theirs (UAT 2026-10-05, RC-5: "it emails it to you. Then, it emails it to you" — two different emails).
    const head = (sig?.params ?? []).find((p) => p.heading && baseTy(p.ty).t === "Text" && !!lit(p.name) && lit(p.name) !== "field");
    const named = head ? `“${lit(head.name)}”` : null;
    const v = lit(addr.name);
    const who = s.over || v === "field" ? "each person in the list" : v;
    // BOUND: the flow says who receives it. UNBOUND: nobody does — an open hole on the port is what the findings speak of
    // ("not set", "cannot send"), so it is said as unset and never as the requester fallback; "you" is only the truth when
    // nothing disputed the fallback (the person asked for themselves — the run's starter).
    if (who !== null) return `emails ${named ? `${named} to ` : "it to "}${who}`;
    if (openPort?.(s.id, addr.name)) return `sends ${named ?? "it"}, the recipient not set yet`;
    return `emails ${named ? `${named} to ` : "it to "}${addr.fallsBackToRequester ? "you" : "someone still to choose"}`;
  }
  const chan = sig?.params.find((p) => (baseTy(p.ty) as { refine?: Array<{ r: string; values?: string[] }> }).refine?.some((r) => r.r === "OneOf" && r.values?.every((x) => x.startsWith("#"))));
  // What it posts: the goal's own fixed words when a text port carries them, else "it" (the data).
  const fixed = (sig?.params ?? []).find((p) => p !== chan && baseTy(p.ty).t === "Text" && !!lit(p.name) && lit(p.name) !== "field");
  if (chan) { const v = lit(chan.name); return `posts ${fixed ? `“${lit(fixed.name)}”` : "it"} to ${v && v !== "field" ? v : "a channel still to choose"}`; }
  return `then uses ${s.ref.replace(/[._]+/g, " ")}${s.over ? " for each row" : ""}`;
}

/**
 * The automation in one or two sentences a person reads (2026-09-28: "looks ugly and cluttered") — what it reads, what it does
 * with it, when it runs, and what is still undecided. Code-written from the flow; no step ids, no refs.
 */
export function describeFlow(f: EFlow, items: BuilderCatalogue, cat?: CatalogueSnapshot): string {
  if (!f.steps.length) return "Nothing is built yet.";
  const reads = f.steps.filter((s) => s.kind === "datasource").map((s) => { const it = items.items.find((i) => i.ref === s.ref); return it ? lowerFirst(shortAbout(it.about)) : "data still to choose"; });
  // A Decide's test and a Split's two filters ARE their conditions (phase C) — said on the condition, never as work on the rows.
  const conditional = (id: string) => !!decideTest(f, id) || !!splitSide(f, id);
  const verbs = [...new Set(f.steps.flatMap((s) => s.kind === "transform" && !conditional(s.id) ? s.pipeline.flatMap((st) => { const o = st as { op: string; where?: object }; if (o.op === "filter" && o.where && ("notNull" in o.where || "isNull" in o.where)) return []; return STAGE_VERB[o.op] ? [STAGE_VERB[o.op]!] : []; }) : []))];
  // Phase Y: a condition's actions are said ON their path — "If …, it …; otherwise it …" — never as one flat list of everything.
  const arms = armOfStep(f);
  // Phase F: a loop's actions are said ON the loop — "For each of the rows, it …" — never as if they ran once.
  const loops = loopOfStep(f);
  const toolsIn = (arm: string | undefined, loop?: string) => f.steps.filter((s): s is Extract<typeof s, { kind: "tool" }> => s.kind === "tool" && arms.get(s.id) === arm && loops.get(s.id) === loop);
  const gated = (arm: string | undefined) => f.steps.some((s) => s.kind === "approval" && arms.get(s.id) === arm);
  // A port still holding a HOLE is undecided — the same "not set" the findings report (UAT 2026-10-05, RC-5): an unbound
  // recipient with its hole open is said as unset, never as the requester fallback.
  const openPort = (stepId: string, port: string) => f.holes.some((h) => h.site.at === "port" && h.site.stepId === stepId && h.site.port === port);
  const act = (arm: string | undefined, loop?: string, part?: "before" | "after") => [...(gated(arm) && part !== "after" ? ["waits for a person to approve"] : []),
    ...toolsIn(arm, loop).filter((s) => !part || (part === "after") === afterLoop(s.id)).map((s) => actionWords(s, cat, openPort))];
  // An action placed after a loop runs once all the items are done: said after the loop ("Then, it …").
  const firstLoop = f.steps.findIndex((s) => s.kind === "for_each");
  const afterLoop = (id: string) => firstLoop >= 0 && f.steps.findIndex((s) => s.id === id) > firstLoop;
  const does = [...(verbs.length ? [`${listWords(verbs)} the rows`] : []), ...act(undefined, undefined, "before")];
  const then = act(undefined, undefined, "after");
  const first = `It reads ${listWords(reads) || "nothing yet"}${does.length ? `, ${listWords(does)}` : ""}.`;
  // A filter's rows are said by its own test ("there are rows where customer name is Contoso Ltd") — "the list has rows" twice in one
  // chain says nothing about which list (UAT 2026-09-30).
  const subjectWords = (stepId: string) => {
    const s = f.steps.find((x) => x.id === stepId);
    const st = s?.kind === "transform" && s.pipeline.length === 1 ? s.pipeline[0] : undefined;
    if (st?.op === "filter") return `there are rows where ${predSaid(st.where)}`;
    return s?.kind === "datasource" ? "there are rows" : "the list has rows";
  };
  const chain = (head: { id: string }, loop?: string) =>
    chainOf(f, head.id).map((id, k) => {
      const b = f.steps.find((x) => x.id === id) as Extract<EFlow["steps"][number], { kind: "branch" }>;
      const c = b.conditions?.[0];
      const d = c && decideTest(f, c.left.stepId), sp = c && splitSide(f, c.left.stepId);
      const what = act(id, loop);
      // A split's sides are not ifs: each is the rows it carries.
      if (sp) return `${sp.side === "matched" ? `For the rows where ${predSaid(sp.where)}` : "For the rest"}, it ${what.length ? listWords(what) : "does nothing"}.`;
      const when = !c ? null : d ? decideWords(d.before, d.where, d.anyRow, c.op === "none") : c.op === "any" ? subjectWords(c.left.stepId) : "there are none";
      return `${k === 0 ? "If" : when ? "Otherwise, if" : "Otherwise,"}${when ? ` ${when},` : ""} it ${what.length ? listWords(what) : "does nothing"}.`;
    }).join(" ");
  const heads = (loop: string | undefined) => f.steps.filter((s): s is Extract<typeof s, { kind: "branch" }> => s.kind === "branch" && !s.elseOf && loops.get(s.id) === loop);
  const paths = heads(undefined).map((h) => chain(h));
  // A condition inside a loop is decided for each item ("For each of the rows: if its qty is more than 30, it …").
  const perItem = f.steps.filter((s) => s.kind === "for_each").map((l) => {
    const always = act(undefined, l.id), inner = heads(l.id).map((h) => chain(h, l.id));
    const one = f.steps.filter((s) => loops.get(s.id) === l.id).length;
    return `For each of the rows${always.length ? `, it ${listWords(always)}` : ""}${inner.length ? `${always.length ? "; and" : ":"} ${inner.join(" ").replace(/^If/, "if")}` : always.length ? "." : one ? ", it prepares the item." : ", it does nothing yet."}`;
  });
  const runs = f.schedule ? `Runs ${cronWords(f.schedule.cron)}.` : "Runs when you start it.";
  const open = f.holes.length ? ` ${f.holes.length === 1 ? "One detail is" : `${f.holes.length} details are`} still to decide.` : "";
  return [first, ...perItem, ...(then.length ? [`Then, it ${listWords(then)}.`] : []), ...paths, runs].join(" ") + open;
}

/**
 * "What does this automation do?", step by step — the list folded beneath `describeFlow`'s sentence. Numbered, in plain words:
 * no step ids, no refs, and an action by what it declares rather than its catalogue line (2026-09-28).
 */
export function aboutFlow(f: EFlow, items: BuilderCatalogue, cat?: CatalogueSnapshot): string[] {
  if (!f.steps.length) return ["This automation has no steps yet. Tell me what it should do and I will build it."];
  const inLoop = loopOfStep(f);
  // The same hole check as `describeFlow`: an undecided port is said as unset, never as the fallback it would take.
  const openPort = (stepId: string, port: string) => f.holes.some((h) => h.site.at === "port" && h.site.stepId === stepId && h.site.port === port);
  const lines = f.steps.map((s, n) => {
    const verbs = s.kind === "transform" ? [...new Set(s.pipeline.flatMap((st) => { const o = st as { op: string; where?: object }; return o.op === "filter" && o.where && ("isNull" in o.where) ? ["keeps"] : STAGE_VERB[o.op] ? [STAGE_VERB[o.op]!] : []; }))] : [];
    const what =
      s.kind === "datasource" ? `Reads ${s.ref ? lowerFirst(shortAbout(items.items.find((i) => i.ref === s.ref)?.about ?? s.ref.replace(/[._]+/g, " "))) : "data still to choose"}`
      : s.kind === "tool" ? actionWords(s, cat, openPort).replace(/^./, (c) => c.toUpperCase())
      : s.kind === "transform" && decideTest(f, s.id) ? `Works out what the next condition tests (${decideWords(decideTest(f, s.id)!.before, decideTest(f, s.id)!.where, decideTest(f, s.id)!.anyRow)})`
      : s.kind === "transform" && splitSide(f, s.id) ? (splitSide(f, s.id)!.side === "matched" ? `Keeps the rows where ${predSaid(splitSide(f, s.id)!.where)}` : "Keeps the rest of the rows")
      : s.kind === "transform" ? (verbs.includes("keeps") ? "Keeps the rows it had to skip, so the run shows them" : verbs.length ? `${listWords(verbs).replace(/^./, (c) => c.toUpperCase())} the rows` : "Prepares the rows for the next step")
      : s.kind === "approval" ? "Waits for a person to approve"
      : s.kind === "branch" ? (s.conditions?.length ? "Continues only when the rows call for it" : "Otherwise, takes the other path")
      : s.kind === "for_each" ? `For each row, runs the steps below once — ${s.concurrency} at a time, ${s.onError === "stop" ? "stopping if one fails" : "going on if one fails"}`
      : s.kind === "collect" ? "Collects what happened to each item — one row per item"
      : "Takes whichever path ran";
    // Phase F: a step inside a loop runs once per item — said, so the numbered list does not read as running once.
    return `${n + 1}. ${what}${inLoop.has(s.id) ? " (for each item)" : ""}`;
  });
  return [`This automation has ${f.steps.length} step${f.steps.length === 1 ? "" : "s"}:`, ...lines];
}

const named = (xs: CatalogueItem[]) => {
  const shown = xs.slice(0, LIST_MAX).map((i) => `• ${shortAbout(i.about)}`);
  return xs.length > LIST_MAX ? [...shown, `• …and ${xs.length - LIST_MAX} more`] : shown;
};

/** At most this many tables are named per datasource; the rest are counted. */
export const TABLES_NAMED = 6;

/**
 * The tables readable directly, per DATASOURCE and by name (2026-10-01: "the rows of 28 tables directly" named neither the database
 * just added nor anything in it, so a person could not tell it was there). The datasource and table come from the reader's own
 * record — never parsed out of a spelling a saved reader could share.
 */
function tableLines(items: BuilderCatalogue, tables: CatalogueItem[], afterSaved: boolean): string[] {
  const by = new Map<string, string[]>();
  for (const t of tables) {
    const rec = items.tables?.[t.ref];
    const ds = rec?.datasource ?? t.ref.slice(0, t.ref.indexOf(".table."));
    const name = (rec?.tables?.[0] ?? t.ref.slice(t.ref.lastIndexOf(".") + 1)).replace(/_/g, " ");
    by.set(ds, [...(by.get(ds) ?? []), name]);
  }
  return [...by.entries()].map(([ds, names], i) => {
    const shown = names.slice(0, TABLES_NAMED);
    const rest = names.length - shown.length;
    const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : listWords(shown);
    return `• ${afterSaved && i === 0 ? "and, " : ""}from ${ds}, the rows of ${names.length} table${names.length === 1 ? "" : "s"} directly: ${list}`;
  });
}

/** "What can you build?" — what this workspace can read and do, from the catalogue's own words. */
export function capabilities(items: BuilderCatalogue): string[] {
  // A saved reader was made for a purpose and says so; a table reader is the table's own rows — listed after, and counted.
  const readers = items.items.filter((i) => i.kind === "reader");
  const saved = readers.filter((i) => !isTableRef(i.ref)), tables = readers.filter((i) => isTableRef(i.ref));
  const tools = items.items.filter((i) => i.kind === "tool");
  if (!readers.length && !tools.length) return ["This workspace has no data sources or actions yet, so there is nothing I can build here. Once some are added, tell me what you want automated."];
  return [
    "Here is what I can work with in this workspace.",
    "",
    "Data I can read:",
    ...(saved.length ? named(saved) : []),
    ...tableLines(items, tables, saved.length > 0),
    "",
    ...(tools.length ? ["Things I can do with it:", ...named(tools)] : ["It has no actions yet, so an automation here can read and report, but not send or create anything."]),
    "",
    "Pick one below to start, or tell me what you want — which data, what to do with it, and who should get it.",
  ];
}

/** A message that asks for nothing. */
export const CHAT_REPLY = ["I build and change automations. Tell me what you want automated, ask what I can build here, or ask what this automation does."];

// ── The overview: a capabilities answer a person reads (D-341) ─────────────

/** At most this many starters are offered. */
export const STARTERS_MAX = 4;
export interface Starter { label: string; value: string }
export interface OverviewGroup { title: string; items: string[] }
export interface Overview { intro: string; groups: OverviewGroup[]; starters: Starter[] }

/**
 * Is `text` free of specifics the workspace did not give? A channel (`#x`), a number, or a quoted value must appear in the
 * catalogue's own words; an address, a ref (`a.b`) or a field-like name (`a_b`) never appears at all. Structural — no vocabulary.
 */
export function grounded(text: string, catalogueText: string): boolean {
  const cat = catalogueText.toLowerCase();
  if (/\S+@\S+/.test(text)) return false;
  if (/\b[a-z]+_[a-z_]+\b/i.test(text) || /\b[a-z]+\.[a-z_]+\b/i.test(text)) return false;
  for (const tok of text.match(/#[\w-]+|\d[\d,.:%]*/g) ?? []) if (!cat.includes(tok.toLowerCase().replace(/[.,:]+$/, ""))) return false;
  return true;
}

/** At most this many themed groups, and ideas per group, in a capabilities answer. */
export const GROUPS_MAX = 3;
export const IDEAS_MAX = 3;
/** At most this many readers (saved first, then tables) and fields per reader are shown to the call that explores them. */
const EXPLORE_READERS = 24;
const EXPLORE_FIELDS = 14;

/**
 * The capabilities answer as a person reads it — written by ONE call over the workspace's LIVE catalogue, held by its schema and by
 * code (D-341; widened 2026-10-03, "a static response is being sent instead of an up-to-date catalogue discovery"):
 *   - what the call sees: every saved reader, every datasource TABLE with its fields, and every action — read fresh each turn.
 *     (It saw saved readers only, so a workspace whose data is all tables never reached the call and got the code-written list.)
 *   - `intro`: one or two sentences on what automations here can do, in the kinds of work;
 *   - `groups`: up to 3 areas of this workspace's data, each with up to 3 concrete automations it could run;
 *   - `starters`: up to 4 requests the person can send, each bound to a listed reader and an action (or none).
 * The inventory is the caller's, folded away. Code drops any line that invents a specific (`grounded`), runs long, or repeats.
 * `null` when the intro does not survive — the caller then answers with the code-written inventory alone.
 */
export async function overview(items: BuilderCatalogue, chooser: Chooser): Promise<{ overview: Overview | null; calls: number }> {
  const all = items.items.filter((i) => i.kind === "reader");
  const readers = [...all.filter((i) => !isTableRef(i.ref)), ...all.filter((i) => isTableRef(i.ref))].slice(0, EXPLORE_READERS);
  const tools = items.items.filter((i) => i.kind === "tool");
  if (!readers.length) return { overview: null, calls: 0 };
  const readerLine = (r: CatalogueItem) => {
    const fields = (r.fields ?? []).slice(0, EXPLORE_FIELDS).map((f) => f.name.replace(/_/g, " "));
    return `- ${r.ref}: ${r.about}${fields.length ? ` Fields: ${fields.join(", ")}${(r.fields?.length ?? 0) > fields.length ? ", …" : ""}.` : ""}`;
  };
  const toolLine = (t: CatalogueItem) => `- ${t.ref}: ${t.about.replace(/\s+/g, " ").slice(0, 400)}`;
  const catalogueText = [...readers.map(readerLine), ...tools.map(toolLine)].join("\n");
  const schema = S.obj({
    intro: S.str("one or two short sentences: what automations here can do"),
    groups: S.arr(S.obj({
      title: S.str("an area of this workspace's data, two to four words"),
      ideas: S.arr(S.str("one automation it could run, one short sentence"), IDEAS_MAX),
    }), GROUPS_MAX),
    starters: S.arr(S.obj({
      reader: S.oneOf(readers.map((r) => r.ref)),
      action: S.oneOf([...tools.map((t) => t.ref), "none"]),
      prompt: S.str("the request, one sentence in the person's own voice"),
    }), STARTERS_MAX),
  });
  const prompt = [
    "A person asked an automation builder what it can build. Explore the data and actions listed below — what each holds, how they relate, what is worth watching, chasing, reporting or acting on — and answer as the product would: briefly, concretely, in plain professional English, from ONLY what is listed.",
    "Write:",
    "- `intro`: ONE or TWO short sentences (under 40 words in all) saying what automations here can do — the kinds of work, not the components. No greeting, no list, no \"I'm excited\", no exclamation marks.",
    `- \`groups\`: up to ${GROUPS_MAX} areas of this data (\"Invoices and payments\", \"Expense claims\"), each with up to ${IDEAS_MAX} ideas — one short sentence each (under 15 words) naming a concrete automation the listed data and actions could run: what it watches or reports, and what it does. Each idea different.`,
    `- \`starters\`: up to ${STARTERS_MAX} requests the person could send as they would type them (\"Every Monday, email me …\", \"Show me …\"), each different, each using one listed reader and optionally one listed action.`,
    "Rules:",
    "- Only what the data and actions below can do. Never a component, channel, address, name or number that their descriptions do not give. Someone who receives something is \"me\" or \"the team\".",
    "- Plain words: never a component's id, a field's or table's raw name with underscores, or words like \"reader\", \"tool\", \"step\", \"table\", \"workspace catalogue\".",
    "",
    "DATA IT CAN READ",
    ...readers.map(readerLine),
    "",
    "THINGS IT CAN DO",
    ...(tools.length ? tools.map(toolLine) : ["- (none)"]),
  ].join("\n");
  try {
    const raw = await chooser(prompt, { name: "chat_overview", schema }, "chat:overview");
    const r = parseStrict<{ intro: string; groups: Array<{ title: string; ideas: string[] }>; starters: Array<{ reader: string; action: string; prompt: string }> }>(schema, raw, "chat:overview");
    const clean = (t: string) => t.replace(/\s+/g, " ").trim();
    const ok = (t: string, max: number) => t.length >= 3 && t.length <= max && grounded(t, catalogueText) && !/!/.test(t);
    const intro = clean(r.intro);
    // Two sentences at most: a third is the list this answer stopped being.
    if (!ok(intro, 280) || (intro.match(/[.?](\s|$)/g) ?? []).length > 2) return { overview: null, calls: 1 };
    const seenIdea = new Set<string>();
    const groups = r.groups
      .map((g) => ({ title: clean(g.title), items: g.ideas.map(clean).filter((t) => ok(t, 140) && !seenIdea.has(t.toLowerCase()) && seenIdea.add(t.toLowerCase())) }))
      .filter((g) => ok(g.title, 48) && g.items.length > 0)
      .slice(0, GROUPS_MAX);
    const seen = new Set<string>();
    const starters = r.starters.map((x) => ({ ...x, prompt: clean(x.prompt) }))
      .filter((x) => x.prompt.length >= 10 && ok(x.prompt, 160) && !seen.has(`${x.reader}|${x.action}`) && seen.add(`${x.reader}|${x.action}`))
      .map((x) => ({ label: x.prompt, value: x.prompt }));
    return { overview: { intro, groups, starters: starters.length ? starters : fallbackStarters(items) }, calls: 1 };
  } catch {
    return { overview: null, calls: 1 };
  }
}

/** The fallback: "Show me …" over the first saved readers, in their own words. */
export function codeStarters(readers: CatalogueItem[]): Starter[] {
  return readers.slice(0, 3).map((r) => { const a = shortAbout(r.about).replace(/\.$/, ""); const t = `Show me ${a.charAt(0).toLowerCase()}${a.slice(1)}`; return { label: t, value: t }; });
}

/** The code-written starters for a workspace, when the overview could not be written. */
export const fallbackStarters = (items: BuilderCatalogue): Starter[] => {
  const saved = codeStarters(items.items.filter((i) => i.kind === "reader" && !isTableRef(i.ref)));
  if (saved.length) return saved;
  // A workspace whose data is all tables: "Show me the <table>", in the table's own name.
  return items.items.filter((i) => i.kind === "reader" && isTableRef(i.ref)).slice(0, 3)
    .map((r) => { const t = `Show me the ${r.ref.slice(r.ref.lastIndexOf(".") + 1).replace(/_/g, " ")}`; return { label: t, value: t }; });
};

/** The full inventory, for "See everything I can use": the capabilities lines without the framing sentences. */
export const inventoryLines = (items: BuilderCatalogue): string[] => capabilities(items).filter((l) => l.startsWith("•") || l.endsWith(":"));


/**
 * What each run asks for and WHY — every input, the steps that read it, and what their component says it is for. Read off the flow
 * and the catalogue, never written by a model: the answer to "why is there period as start input?" is the reader that needs it
 * (2026-10-01, 47d1e01e: every question about the flow got the same summary).
 */
export function inputFacts(f: EFlow, items: BuilderCatalogue): string[] {
  const name = (ref?: string) => componentName(items, ref);
  return f.inputs.map((i) => {
    const how = i.computed ? `the day it runs${i.offsetDays ? `, ${Math.abs(i.offsetDays)} days ${i.offsetDays < 0 ? "before" : "after"}` : ""} (worked out when it runs, never asked)`
      : `asked each run as ${INPUT_TYPES.find(([t, fm]) => t === i.type && fm === i.format)?.[2] ?? i.type.toLowerCase()}${i.required === false ? " (optional)" : ""}${i.defaults !== undefined ? `, ${i.defaults} if not given` : ""}`;
    const readers = f.steps.flatMap((s) => {
      if ((s.kind === "tool" || s.kind === "datasource") && s.ref) return s.inputs.filter((b) => b.source?.from === "input" && b.source.inputId === i.id).map((b) => {
        const about = items.items.find((it) => it.ref === s.ref)?.params?.find((p) => p.name === b.name)?.about?.trim();
        return `${name(s.ref)} needs it as its ${b.name}${about ? ` (“${about}”)` : ""}`;
      });
      return s.kind === "transform" && JSON.stringify(s.pipeline).includes(`"input":"${i.id}"`) ? ["a filter compares with it"] : [];
    });
    return `${i.id} — ${how}. ${readers.length ? `${readers.join("; ")}.` : "No step reads it yet."}`;
  });
}

/** A component as a person knows it — its catalogue line's first sentence, without the full stop it ends a sentence with. */
const componentName = (items: BuilderCatalogue, ref?: string) => { const it = items.items.find((i) => i.ref === ref); return it ? shortAbout(it.about).replace(/[.\s]+$/, "") : (ref ?? "a step").replace(/[._]+/g, " "); };

/** What each reader in the flow takes — its declared inputs, in its own words: the bound on what a run input can change. */
export function readerFacts(f: EFlow, items: BuilderCatalogue): string[] {
  return f.steps.flatMap((s) => {
    if (s.kind !== "datasource" || !s.ref) return [];
    const it = items.items.find((i) => i.ref === s.ref);
    const ps = it?.params ?? [];
    return [`${componentName(items, s.ref)} takes ${ps.length ? ps.map((p) => `${p.name}${p.about?.trim() ? ` (“${p.about.trim()}”)` : ""}`).join(", ") : "nothing"}${ps.length ? " — and nothing else" : ""}.`];
  });
}

/**
 * S5 spec-grounded verification (2026-10-08): an `about_flow` message carrying a verifiable numeric or
 * operator claim is answered from the spec's own bands — yes/no with the
 * band's quoted value. Neutral questions keep the summary path. Structural: a number or operator in the
 * message selects the path; the spec's bands are the evidence. No domain words.
 */
export interface SpecClaim { measure: string; value: number; }
export const CLAIM_PATTERN = /0\.\d+|\d|<=|>=|<|>/;
export function hasVerifiableClaim(message: string): boolean {
  return CLAIM_PATTERN.test(message);
}
export function verifyAgainstBands(message: string, spec: { summary?: { measures?: Array<{ words: string; bands?: Array<{ test: string; value: string; then: number; words: string }> }> } }): string[] | null {
  if (!hasVerifiableClaim(message)) return null;
  const nums = message.match(/0\.\d+|\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const bands = (spec.summary?.measures ?? []).flatMap((m) => (m.bands ?? []).map((b) => ({ ...b, measure: m.words })));
  if (!bands.length) return null;
  const hit = bands.find((b) => nums.some((n) => n === b.then));
  if (!hit) return null;
  const name = hit.measure || hit.words || "the band";
  return [`Yes — ${name} counts ${hit.then} (band “${hit.words}”, ${hit.test} ${hit.value}).`];
}

/**
 * Spec-grounded step answer (2026-10-08): "what does read_1 do" / "what does the query return" is answered from the
 * STORED step — its `sqlSpec` (columns/aliases, `aggregateJoins[]` aggregates with `caseWhen` arms, filters, groupBy)
 * plus the goal-spec summary measures (bands/edges/words). Value-blind: schema + spec only, never cell values.
 * Step resolution is structural: `read_N`/`step_N` ids in the message, or the words "query"/"read step" selecting the
 * query step — never a regex on domain words. Returns null when no step resolves, and the caller keeps the summary path.
 */
export interface StepSpecLike {
  base?: { table?: string };
  columns?: Array<{ column?: string; alias?: string; compute?: unknown; aggregate?: string }>;
  aggregateJoins?: Array<{
    table?: string;
    groupBy?: string;
    aggregates?: Array<{ alias?: string; aggregate?: string; column?: string; compute?: { caseWhen?: { arms?: Array<{ op?: string; left?: unknown; right?: unknown; then?: unknown }>; else?: unknown } } }>;
    filters?: Array<{ column?: string; op?: string; param?: string; value?: unknown; against?: string }>;
  }>;
  filters?: Array<{ column?: string; op?: string; param?: string; value?: unknown; against?: string }>;
  distinct?: boolean;
  limit?: number;
}
export interface SummaryMeasuresLike {
  summary?: { measures?: Array<{ words?: string; counts?: string | null; bands?: Array<{ test?: string; value?: string; then?: number; words?: string }> }> };
}
const OP_WORDS: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠" };
const nodeWords = (n: unknown): string => {
  if (n == null) return "…";
  if (typeof n === "number" || typeof n === "boolean") return String(n);
  if (typeof n !== "object") return String(n);
  const o = n as Record<string, unknown>;
  if (typeof o.column === "string") return (o.column as string).split(".").at(-1) ?? (o.column as string);
  if (typeof o.number === "number") return String(o.number);
  if (typeof o.param === "string") return `“${o.param}”`;
  if (typeof o.value === "string" || typeof o.value === "number") return String(o.value);
  if (Array.isArray(o.coalesce)) { const first = (o.coalesce as unknown[]).find((x) => typeof x === "object" && x !== null && "column" in (x as object)); if (first) return nodeWords(first); }
  return "…";
};
/** The step a question asks about: an explicit `read_N`/`step_N` id, or the words "query"/"read step" selecting the query step. */
export function resolveStepRef(message: string, steps: Array<{ id: string; kind?: string }>): string | null {
  const ids = steps.map((s) => s.id);
  const m = message.toLowerCase().match(/\b(?:read|step)[_\s-]?(\d+)\b/);
  if (m) {
    const want = m[0]!.toLowerCase().replace(/[\s-]+/g, "_");
    const hit = ids.find((id) => id.toLowerCase() === want || id.toLowerCase() === `read_${m[1]}` || id.toLowerCase() === `step_${m[1]}`);
    return hit ?? null;
  }
  if (/\bquery\b|\bread step\b|\bread\b/.test(message.toLowerCase())) {
    const query = steps.find((s) => s.kind === "query" || s.kind === "datasource");
    return query?.id ?? null;
  }
  return null;
}
/**
 * What one stored step does, from its own form: the source it reads, what EACH output column computes (band edges
 * quoted from the spec), what rows it excludes (filters, if any), how rows group. Falls back to null when the step
 * carries no `sqlSpec` with columns — the caller keeps the existing summary path.
 */
export function stepFacts(stepId: string, step: { id?: string; kind?: string; ref?: string; datasourceRef?: string; sqlSpec?: unknown }, summary?: SummaryMeasuresLike["summary"]): string[] | null {
  const spec = step.sqlSpec as StepSpecLike | undefined;
  if (!spec || !Array.isArray(spec.columns) || !spec.columns.length) return null;
  const source = spec.base?.table ?? (typeof step.datasourceRef === "string" ? step.datasourceRef : undefined) ?? (typeof step.ref === "string" ? step.ref : "its source");
  const lines: string[] = [];
  lines.push(`${stepId} reads ${source}.`);
  const measures = summary?.measures ?? [];
  for (const col of spec.columns) {
    const alias = col.alias ?? col.column ?? "?";
    const agg = spec.aggregateJoins?.flatMap((j) => j.aggregates ?? []).find((a) => a.alias === alias || a.alias === col.column);
    const arms = agg?.compute?.caseWhen?.arms;
    if (arms?.length) {
      const armList = arms.map((a) => `${OP_WORDS[a.op ?? ""] ?? a.op ?? "?"} ${nodeWords(a.right)} → ${nodeWords(a.then)}`).join(", ");
      const elseW = agg?.compute?.caseWhen?.else !== undefined ? `, else ${nodeWords(agg.compute.caseWhen.else)}` : "";
      lines.push(`“${alias}” counts rows by first match [${armList}${elseW}].`);
    } else if (col.aggregate) {
      lines.push(`“${alias}” is ${col.aggregate} of ${col.column ?? "rows"}.`);
    } else if (col.column) {
      lines.push(`“${alias}” carries ${(col.column as string).split(".").at(-1) ?? col.column}.`);
    } else {
      lines.push(`“${alias}” is computed.`);
    }
  }
  const exclusions = [...(spec.filters ?? []), ...(spec.aggregateJoins?.flatMap((j) => j.filters ?? []) ?? [])];
  if (exclusions.length) lines.push(`It leaves out rows where ${exclusions.map((f) => `${(f.column ?? "?").split(".").at(-1) ?? f.column ?? "?"} ${OP_WORDS[f.op ?? ""] ?? f.op ?? "?"} ${f.against ? ((f.against as string).split(".").at(-1) ?? f.against) : f.param ? `“${f.param}”` : f.value !== undefined ? String(f.value) : "…"}`).join(" and ")}.`);
  const groups = (spec.aggregateJoins?.map((j) => j.groupBy).filter(Boolean) ?? []) as string[];
  if (groups.length) lines.push(`One row per ${groups.map((g) => g.split(".").at(-1) ?? g).join(" and ")}.`);
  for (const mm of measures) {
    if (!mm.bands?.length) continue;
    lines.push(`“${mm.words ?? "?"}” bands: ${mm.bands.map((b) => `“${b.words ?? "?"}” ${b.test ?? "?"} ${b.value ?? "?"} → ${b.then ?? "?"}`).join("; ")}.`);
  }
  return lines;
}
/**
 * An `about_flow` message answered from the stored step: resolves the step, then states it. Sibling of
 * `verifyAgainstBands` — tried first when a step resolves; numeric claims keep the band path. Null when no step
 * resolves or the step carries no readable form.
 */
export function answerStepAbout(message: string, steps: Array<{ id: string; kind?: string; ref?: string; datasourceRef?: string; sqlSpec?: unknown }>, summary?: SummaryMeasuresLike["summary"]): string[] | null {
  const id = resolveStepRef(message, steps);
  if (!id) return null;
  const step = steps.find((s) => s.id === id);
  if (!step) return null;
  return stepFacts(id, step, summary);
}
