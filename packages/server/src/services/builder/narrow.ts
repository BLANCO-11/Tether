/**
 * Narrowing a LARGE catalogue before the understanding call (compiled-builder phase 5, M12 — E5.12). The goal-spec call lists the
 * whole catalogue and enumerates every `ref.param` and `ref.field` pair, so at 10× today's largest workspace its strict schema is
 * over the gateway's 1000-enum limit and every build is refused before a model sees it. So, when — and only when — the full
 * schema would not fit, one small call first picks the readers and actions the goal is about from a COMPACT list (ref and a short
 * description, nothing else); the spec call then sees only those. The shape call's pattern (its enums are only the chosen readers'
 * fields), one step earlier.
 *
 * A catalogue whose own compact list is still over the limit is picked in two steps: a PART of it first (components grouped by the
 * ref's prefix — a datasource, a tool family — and split so no enum exceeds `PART_LIMIT`), then components within the parts chosen.
 *
 * ⚠ Only a model can say which components a goal is about ("alert" is served by a messaging action), so this is a model call, never
 * a word match. What it narrows is stated: `Understood.narrowed` records the count, and a component it left out is simply absent
 * from the spec's enums — the spec call then answers `none_fit` for it, which reads back as a gap, never as a guess.
 */
import type { Chooser } from "./build.js";
import { shortAbout, type BuilderCatalogue } from "./goal-spec.js";
import { clauses, planPrompt, planSchema } from "./plan.js";
import { S, parseStrict, type Schema } from "./strict-schema.js";

/** The gateway refuses a schema with more enum values than this (measured: shape-tuned-r1). */
export const GATEWAY_ENUM_LIMIT = 1000;
/** Narrow when the full plan schema would come within this of the limit — headroom for the enums the plan itself adds. */
export const NARROW_AT = 800;
/** The plan prompt a narrowed catalogue may grow to: the plan prompt runs larger than the old spec prompt, same decode guard. */
export const PROMPT_BUDGET = 40_000;
/** At most this many components of each kind are kept for the plan call. */
export const KEEP_MAX = 12;
/** No part of a two-step pick is larger than this. */
export const PART_LIMIT = 200;

/** Every enum value in a JSON schema, summed — what the gateway's limit counts. */
export const enumCount = (s: unknown): number => {
  if (!s || typeof s !== "object") return 0;
  let n = Array.isArray((s as { enum?: unknown[] }).enum) ? (s as { enum: unknown[] }).enum.length : 0;
  for (const v of Object.values(s as Record<string, unknown>)) if (v && typeof v === "object") n += enumCount(v);
  return n;
};

/**
 * Whether the understanding call needs a narrower catalogue than `cat` — measured against
 * the LIVE plan schema (S1), never the retired goal-spec schema. Clause ids add a handful
 * of enums, so the goal-free measure stands in for every goal.
 */
export const needsNarrowing = (cat: BuilderCatalogue) => enumCount(planSchema(cat, [])) > NARROW_AT;

const line = (i: BuilderCatalogue["items"][number]) => `- ${i.ref}: ${shortAbout(i.about)}`;
const prefix = (ref: string) => (ref.includes(".") ? ref.slice(0, ref.indexOf(".")) : ref.split("_")[0]!);

function pickPrompt(goal: string, items: BuilderCatalogue["items"], current: string[] | undefined): string {
  const list = (k: "reader" | "tool") => items.filter((i) => i.kind === k).map(line).join("\n") || "- (none)";
  return [
    "A person describes an automation. List the components of this workspace it could use — the readers its data could come from, and the actions it asks to be done. You are NOT building it; a later step decides the details.",
    "Rules:",
    `- Choose at most ${KEEP_MAX} of each. Include every component that might be the right one — a later step chooses among them, and one you leave out cannot be used.`,
    "- A verb that means telling someone (\"alert\", \"notify\", \"keep me posted\") is served by an action that sends a message.",
    "- Words that say WHO gets the result (\"to me\", \"to the team\", \"let the owners know\") ask for it to be delivered: include every action that could deliver it to them, of every kind (a message, a post, a ticket …).",
    "- A goal that only asks to get, see or list data, and names nobody to get it, asks for no action.",
    "",
    "READERS", list("reader"), "", "ACTIONS", list("tool"), "",
    ...(current ? ["THE AUTOMATION AS IT IS (this message changes it)", ...current, ""] : []),
    "GOAL", goal,
  ].join("\n");
}

/** Parts of a list no larger than PART_LIMIT, grouped by ref prefix. */
function partsOf(items: BuilderCatalogue["items"]): Array<{ id: string; label: string; members: BuilderCatalogue["items"] }> {
  const byPrefix = new Map<string, BuilderCatalogue["items"]>();
  for (const i of items) { const k = `${i.kind}:${prefix(i.ref)}`; byPrefix.set(k, [...(byPrefix.get(k) ?? []), i]); }
  const parts: Array<{ id: string; label: string; members: BuilderCatalogue["items"] }> = [];
  for (const [k, ms] of byPrefix) for (let j = 0; j < ms.length; j += PART_LIMIT) {
    const chunk = ms.slice(j, j + PART_LIMIT);
    parts.push({ id: `p${parts.length + 1}`, label: `${k.startsWith("tool:") ? "actions" : "readers"} ${k.slice(k.indexOf(":") + 1)} — ${chunk.length} (e.g. ${chunk.slice(0, 3).map((x) => `${x.ref}: ${shortAbout(x.about)}`).join("; ")})`, members: chunk });
  }
  return parts;
}

/**
 * The catalogue the understanding call sees: `cat` itself when it fits, else the components one small call picked. `calls` is how
 * many model calls the narrowing made (0, 1 or 2).
 */
export async function narrowCatalogue(goal: string, cat: BuilderCatalogue, chooser: Chooser, current?: string[]): Promise<{ items: BuilderCatalogue; calls: number; narrowed?: { from: number; to: number } }> {
  if (!needsNarrowing(cat)) return { items: cat, calls: 0 };
  let pool = cat.items, calls = 0;
  if (pool.length > GATEWAY_ENUM_LIMIT - 100) {
    const parts = partsOf(pool);
    const schema: Schema = S.obj({ parts: S.arr(S.oneOf(parts.map((p) => p.id)), 8, "the parts that hold the components the goal could use") });
    const prompt = [
      "A person describes an automation. This workspace's components are listed in PARTS; choose the parts that hold the readers its data could come from and the actions it asks to be done. Choose every part that might hold the right one.",
      "", "PARTS", ...parts.map((p) => `- ${p.id}: ${p.label}`), "", "GOAL", goal,
    ].join("\n");
    const got = parseStrict<{ parts: string[] }>(schema, await chooser(prompt, { name: "goal_parts", schema }, "builder:narrow:parts"), "builder:narrow:parts");
    calls++;
    pool = parts.filter((p) => got.parts.includes(p.id)).flatMap((p) => p.members);
  }
  const readers = pool.filter((i) => i.kind === "reader").map((i) => i.ref), tools = pool.filter((i) => i.kind === "tool").map((i) => i.ref);
  const schema: Schema = S.obj({
    readers: readers.length ? S.arr(S.oneOf(readers), KEEP_MAX) : S.arr(S.oneOf(["none"]), 0),
    actions: tools.length ? S.arr(S.oneOf(tools), KEEP_MAX) : S.arr(S.oneOf(["none"]), 0),
  });
  const got = parseStrict<{ readers: string[]; actions: string[] }>(schema, await chooser(pickPrompt(goal, pool, current), { name: "goal_components", schema }, "builder:narrow"), "builder:narrow");
  calls++;
  const keep = new Set([...got.readers, ...got.actions]);
  // Recall, by code: a reader the model picked names a DATA AREA (its datasource); that area's other readers are kept too, in
  // catalogue order, while the plan schema and prompt stay within budget (S1: the LIVE call's budget, never the retired spec's).
  // Measured (E5.12): every reader the pick missed at 10× was a sibling of one it kept — the model keeps few, and a reader left out cannot be used.
  const cs = clauses(goal);
  const over = (view: BuilderCatalogue) => enumCount(planSchema(view, cs)) > NARROW_AT || planPrompt(goal, view, cs).length > PROMPT_BUDGET;
  const areas = new Set(cat.items.filter((i) => i.kind === "reader" && keep.has(i.ref)).map((i) => prefix(i.ref)));
  for (const i of cat.items) {
    if (i.kind !== "reader" || keep.has(i.ref) || !areas.has(prefix(i.ref))) continue;
    keep.add(i.ref);
    const view = { items: cat.items.filter((x) => keep.has(x.ref)) };
    if (over(view)) { keep.delete(i.ref); break; }
  }
  // …and whole DATA AREAS stay together (P2, RC-3, 2026-10-07): the goal's sources are named by the catalogue's own
  // prefix areas, never by word overlap — a component left out of the view is absent from the plan schema, so the
  // plan's `none_fit` shortlist (offered components in catalogue order) could never name it. Areas the pick missed
  // stay out only when the budget forces it: same sibling-area rule as above, but seeded from the goal's own areas
  // rather than the pick's. No model call, no English-vocabulary ranking.
  {
    const goalAreas = new Set(cat.items.filter((i) => i.kind === "reader").map((i) => prefix(i.ref)).filter((a) => goal.toLowerCase().includes(a.toLowerCase().replace(/_/g, " ")) || goal.toLowerCase().replace(/_/g, " ").includes(a.toLowerCase().replace(/_/g, " "))));
    for (const i of cat.items) {
      if (i.kind !== "reader" || keep.has(i.ref) || !goalAreas.has(prefix(i.ref))) continue;
      keep.add(i.ref);
      const view = { items: cat.items.filter((x) => keep.has(x.ref)) };
      if (over(view)) { keep.delete(i.ref); break; }
    }
  }
  const items = cat.items.filter((i) => keep.has(i.ref));
  // Table readers (`tables`) travel with the items they describe; the others are dropped from the view, never from the workspace.
  const tables = cat.tables ? Object.fromEntries(Object.entries(cat.tables).filter(([r]) => keep.has(r))) : undefined;
  return { items: { items, ...(tables && Object.keys(tables).length ? { tables } : {}) }, calls, narrowed: { from: cat.items.length, to: items.length } };
}
