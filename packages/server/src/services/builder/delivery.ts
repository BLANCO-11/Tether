/**
 * Slice 5f (E5.9): WHERE the result goes and WHO receives it is the person's decision — the one part of a goal the builder never
 * asked about. Questions came only from what it had placed (a port with no value, an unclear word, a filter with no constant), so a
 * decision it never placed produced no question: a stated unmet ("names no action"), a `none_fit` refusal, or a sink the model
 * picked whose port was then asked in the engine's vocabulary. 19 of 30 failing tuned `asks` rows.
 *
 * PURE, and read from the ports' declared TYPES only — never a tool's or a field's name:
 *   - an `Address` port delivers to a person;
 *   - a text port closed to a listed set (`OneOf`) delivers to a named place;
 *   - a tool whose output is model-written text (`modelText`) delivers nothing — it is not the action, it prepares one.
 *
 * Two findings, both answered BEFORE building, in the one round of the person's words that is re-understood once (`correct`):
 *   - `ask`: the spec says nothing about what to do with the rows (no action, or only `unsaid`), or its action goes to a named
 *     place and the goal says nothing about which — the person is asked, once, what should happen and who should get it.
 *   - `notes`: the goal says who, and the chosen action cannot reach them (a person, or "me", for an action that only posts to a
 *     listed place). A finding of code, given to the model with the re-understanding — never the person's words, so nothing in
 *     it can be quoted into the spec. Never repaired here.
 */
import { literalFits, TypeOf as T, type CatalogueSnapshot, type Ty } from "@foundry/flow-edit";
import { FILLS_NONE, NONE_FIT, UNSAID, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { S } from "./strict-schema.js";
import { parseStrict } from "./strict-schema.js";
import type { Chooser } from "./build.js";

const bare = (t: Ty): Ty => (t.t === "Option" ? t.of : t);
const elemOf = (t: Ty): Ty => { const b = bare(t); return b.t === "List" ? bare(b.of) : b; };
const isAddress = (t: Ty) => elemOf(t).t === "Address";
/** The listed values of a port closed to a set, or null. */
const closedSet = (t: Ty): string[] | null => {
  const e = elemOf(t);
  if (e.t !== "Text") return null;
  const one = (e as { refine?: Array<{ r: string; values?: string[] }> }).refine?.find((r) => r.r === "OneOf");
  return one?.values ?? null;
};

export interface DeliveryFindings {
  ask: boolean;
  /** The actions the person may choose among (refs), for a caller that shows choices. */
  options: string[];
  notes: string[];
}

/** The actions of this catalogue that DO something (not model-written text), by ref. */
export const actionsOf = (cat: CatalogueSnapshot): string[] => Object.entries(cat.refs).filter(([, s]) => s.kind === "tool" && !s.modelText).map(([r]) => r);

export function deliveryFindings(spec: GoalSpec, cat: CatalogueSnapshot): DeliveryFindings {
  const options = actionsOf(cat);
  const none: DeliveryFindings = { ask: false, options, notes: [] };
  // A goal refused for a missing component, or reading nothing, has no delivery to settle.
  if ([...spec.sources, ...spec.sinks].some((x) => x.ref === NONE_FIT) || spec.missing) return none;
  if (!spec.sources.length) return none;
  const acts = spec.sinks.map((x) => x.ref).filter((r) => r !== UNSAID && cat.refs[r] && !cat.refs[r]!.modelText);
  const who = spec.values.filter((v) => v.role === "recipient" || v.role === "channel");
  // No action: a flow whose result is the data is complete as it is (2026-09-27: "get me a list" became an email nobody asked for).
  // Asked only when the goal DID ask for something to be done and said it vaguely (`unsaid`); settled from its words when it names who.
  // ⚠ Except on a SCHEDULE: a result is returned to whoever CALLS the flow, and a scheduled run has no caller — so a scheduled flow
  // that only reads delivers to nobody, and where it should go is asked (E5.13: "daily list of late orders" completed, seen by no one).
  if (!acts.length) {
    if (!spec.sinks.some((x) => x.ref === UNSAID) && !spec.schedule) return none;
    return who.length ? { ask: false, options, notes: [`no action was chosen; the goal names who receives it (“${who[0]!.quote}”)`] } : { ask: true, options, notes: [] };
  }
  const notes: string[] = [];
  let ask = false;
  for (const ref of acts) {
    const params = cat.refs[ref]!.params;
    const addr = params.filter((p) => isAddress(p.ty));
    const closed = params.map((p) => ({ p, set: closedSet(p.ty) })).filter((x): x is { p: typeof params[number]; set: string[] } => !!x.set);
    if (addr.length || !closed.length) continue; // reaches a person, or has no destination of its own: nothing to settle here
    const mine = who.filter((v) => !v.fills || v.fills === FILLS_NONE || v.fills.startsWith(`${ref}.`));
    // A PERSON for an action that only posts to a listed place: it cannot reach them.
    for (const v of mine.filter((x) => x.role === "recipient")) {
      notes.push(`\`${ref}\` delivers only to one of the listed values of \`${closed[0]!.p.name}\` (${closed[0]!.set.join(", ")}); it cannot reach ${v.from === "requester" ? `the person who runs it (“${v.quote}”)` : `“${v.quote}”`}`);
    }
    // Nothing in the goal says which place, and the catalogue states none: which place is the person's to say.
    if (!mine.length && closed.every((c) => c.p.default === undefined)) ask = true;
  }
  return { ask, options, notes };
}

export const DELIVERY_ASK = "What should happen with what it finds, and who should get it?";

/**
 * Slice 5f, E5.10: the answer fills ITS slot — the action and who receives it — and nothing else is re-decided. Re-reading the whole
 * goal with the answer (the first version) let the model keep `unsaid`, or turn a finding into `none_fit`: 5 of 6 answered goals lost
 * the answer. Here code settles it by the answer's TYPE where it can; only when several actions fit is there a call, whose schema is
 * that one slot (an action among those that fit, and which of its ports receives it). Sources, conditions, shapes and every other
 * value are carried over untouched.
 *
 * `answer`: the person's reply to the delivery question, or null when only code's findings (a person for an action that cannot reach
 * them) are being settled — then who receives it is the goal's own words, already in the spec.
 * Returns the patched spec (for `checkSpec` over `texts`, which the caller extends with the answer) and the calls it made.
 */
export async function settleDelivery(spec: GoalSpec, answer: string | null, goal: string, items: BuilderCatalogue, cat: CatalogueSnapshot, chooser: Chooser): Promise<{ spec: GoalSpec; calls: number } | null> {
  const offered = new Set(items.items.filter((i) => i.kind === "tool").map((i) => i.ref));
  const acts = actionsOf(cat).filter((r) => offered.has(r));
  const destOf = (ref: string) => cat.refs[ref]!.params.filter((p) => isAddress(p.ty) || closedSet(p.ty));
  const addrOf = (ref: string) => cat.refs[ref]!.params.filter((p) => isAddress(p.ty));
  const personPort = (ref: string) => { const a = addrOf(ref); return a.find((p) => p.required && !p.fallsBackToRequester) ?? a.find((p) => !p.fallsBackToRequester) ?? a[0]; };
  // Who receives it, and in which role, as the person (or the goal) said it.
  const said = answer?.trim() || null;
  const goalWho = spec.values.find((v) => v.role === "recipient") ?? spec.values.find((v) => v.role === "channel");
  let pick: { ref: string; port: string; role: "recipient" | "channel"; requester?: boolean } | null = null;
  let cands: string[];
  if (said) {
    // A value one action's listed set holds: that action, that port — the person named the place.
    const listed = acts.flatMap((r) => cat.refs[r]!.params.filter((p) => closedSet(p.ty)?.includes(said)).map((p) => ({ ref: r, port: p.name })));
    if (listed.length === 1) pick = { ...listed[0]!, role: "channel" };
    // An address, or words for people: an action that reaches a PERSON (an Address port).
    // An address: the actions that reach a person. Several listed matches: those actions. Other words: every action — which one is
    // the one-slot call's to read from the answer.
    cands = pick ? [] : literalFits(said, T.address(), cat) === null ? acts.filter((r) => addrOf(r).length) : listed.length ? [...new Set(listed.map((x) => x.ref))] : acts;
  } else {
    if (!goalWho) return null;
    // The goal's own words for who: a place → the actions that post to a listed place; a person → those that reach one.
    cands = goalWho.role === "channel" ? acts.filter((r) => cat.refs[r]!.params.some((p) => closedSet(p.ty))) : acts.filter((r) => addrOf(r).length);
  }
  if (!pick && cands.length === 1) {
    const place = !said && goalWho?.role === "channel" ? cat.refs[cands[0]!]!.params.find((p) => closedSet(p.ty)) : undefined;
    const port = place ?? personPort(cands[0]!);
    if (port) pick = { ref: cands[0]!, port: port.name, role: place ? "channel" : "recipient" };
  }
  let calls = 0;
  if (!pick && cands.length > 1) {
    const pairs = cands.flatMap((r) => destOf(r).map((p) => `${r}.${p.name}`));
    // An answer that IS an address names who, by type: the call chooses only the action and port (E5.13 — offered the choice, it
    // read “leah@…” as "the person who runs it", and the address was then asked for again).
    // By SHAPE, not by `literalFits`: a reserved domain is refused as a literal (a live run will not mail it), but it still names who.
    const isAddr = !!said && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(said);
    const schema = S.obj({ action: S.oneOf(cands), receives_it: S.oneOf(pairs), ...(said && !isAddr ? { who: S.oneOf(["the person who runs it", "whoever the answer names"]) } : {}) });
    const list = cands.map((r) => `- ${r}: ${items.items.find((i) => i.ref === r)?.about ?? r}\n    ports that receive it: ${destOf(r).map((p) => p.name).join(", ")}`).join("\n");
    const who = said ?? (goalWho!.from === "requester" ? "the person who runs it" : goalWho!.quote);
    const prompt = ["A person's automation goal must deliver its result. Choose the ONE action below that delivers it to who they said, and the port of that action that receives it. Nothing else.", "", "ACTIONS", list, "", "GOAL", goal, "", said ? `ASKED: ${DELIVERY_ASK}\nTHEY ANSWERED: ${said}` : `WHO RECEIVES IT (the goal's words): ${who}`].join("\n");
    const raw = await chooser(prompt, { name: "delivery_slot", schema }, "builder:delivery");
    calls++;
    const r = parseStrict<{ action: string; receives_it: string; who?: string }>(schema, raw, "builder:delivery");
    if (!r.receives_it.startsWith(`${r.action}.`)) return { spec, calls };
    const port = r.receives_it.slice(r.action.length + 1);
    pick = { ref: r.action, port, role: closedSet(cat.refs[r.action]!.params.find((p) => p.name === port)!.ty) ? "channel" : "recipient", ...(r.who === "the person who runs it" ? { requester: true } : {}) };
  }
  if (!pick) return { spec, calls };
  // The slot, replaced: the delivering actions (those with a destination, and `unsaid`) give way to the chosen one; a tool that only
  // prepares (model-written text) and one with no destination stay. The words for the action are the goal's where it had any.
  const delivering = (r: string) => r === UNSAID || (!!said && r === NONE_FIT) || (!!cat.refs[r] && !cat.refs[r]!.modelText && destOf(r).length > 0);
  const quote = spec.sinks.find((x) => delivering(x.ref) && x.quote.trim())?.quote ?? said ?? "";
  const sinks = [...spec.sinks.filter((x) => !delivering(x.ref) && x.ref !== pick!.ref), { ref: pick.ref, quote }];
  const kept = spec.values.filter((v) => !(v.role === "recipient" || v.role === "channel") || (!said && v !== goalWho));
  const falls = !!cat.refs[pick.ref]!.params.find((p) => p.name === pick!.port)?.fallsBackToRequester;
  const whoValue: GoalSpec["values"][number] = said && pick.requester
    ? { role: "recipient", from: "requester", quote: said, fills: falls ? `${pick.ref}.${pick.port}` : FILLS_NONE }
    : said
    ? { role: pick.role, from: "goal", quote: said, fills: `${pick.ref}.${pick.port}` }
    : { ...goalWho!, fills: goalWho!.from === "requester" && cat.refs[pick.ref]!.params.find((p) => p.name === pick!.port)?.fallsBackToRequester ? `${pick.ref}.${pick.port}` : goalWho!.from === "requester" ? FILLS_NONE : `${pick.ref}.${pick.port}` };
  // `missing` named an absent ACTION only where the answer has now supplied one; an absent reader stays absent.
  const missing = spec.sources.some((x) => x.ref === NONE_FIT) ? spec.missing : null;
  return { spec: { ...spec, sinks, values: [...kept, whoValue], missing }, calls };
}
