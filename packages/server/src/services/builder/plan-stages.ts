/**
 * Staged meaning calls (Strategy B Phase 2) — optional via BUILDER_PLAN_STAGES.
 * When on, planning is skeleton → bind → (reads filled elsewhere). Each stage is a
 * strict schema slice; code merges. Domain-free prompts (lending library).
 *
 * ⚠ Off by default even under BUILDER_INTENT_IR: until stages replace `goal_plan`
 * they only prepend two decode-bound calls (~10–15s) before the same full plan.
 */
import type { Chooser } from "./build.js";
import { NONE_FIT, UNCLEAR_ABOUT } from "./goal-spec.js";
import type { Plan } from "./plan.js";
import { S, parseStrict, type Schema } from "./strict-schema.js";
import { intentIrEnabled } from "./intent-ir.js";

/**
 * Additive skeleton→bind hints. Off by default even when BUILDER_INTENT_IR is on:
 * until stages *replace* the full `goal_plan` call they only add ~10–15s (two decode-bound
 * calls) before the same expensive plan. Opt in with `BUILDER_PLAN_STAGES=1` to measure.
 */
export function planStagesEnabled(): boolean {
  return intentIrEnabled()
    && (process.env.BUILDER_PLAN_STAGES === "1" || process.env.BUILDER_PLAN_STAGES === "true");
}

export interface PlanSkeleton {
  sources: Array<{ ref: string; quote: string }>;
  conditions: Array<{ quote: string; on?: string }>;
  actions: Array<{ ref: string; quote: string; on: string }>;
  unclear: Array<{ quote: string; about: string }>;
}

export interface PlanBind {
  recipients: Array<{ action: number; from: string; words: string }>;
  schedule: { cron: string; quote: string } | null;
  inputs: Array<{ name: string; words: string }>;
}

const skeletonSchema: Schema = S.obj({
  sources: S.arr(S.obj({ ref: S.str(), quote: S.str() })),
  conditions: S.arr(S.obj({ quote: S.str(), on: S.str() })),
  actions: S.arr(S.obj({ ref: S.str(), quote: S.str(), on: S.str() })),
  unclear: S.arr(S.obj({ quote: S.str(), about: S.str() })),
});

const bindSchema: Schema = S.obj({
  recipients: S.arr(S.obj({ action: S.num(), from: S.str(), words: S.str() })),
  schedule: S.nullable(S.obj({ cron: S.str(), quote: S.str() })),
  inputs: S.arr(S.obj({ name: S.str(), words: S.str() })),
});

function skeletonPrompt(goal: string, catalogueLines: string[]): string {
  return [
    "You outline ONE automation as STRUCTURE only (lending-library vocabulary in examples — never copy product domains).",
    "Return sources (catalogue refs), conditions, actions with on=always|if:N|otherwise, and unclear quotes.",
    "Do NOT invent cron, fills, or SQL. Copy quotes from the goal when you can.",
    "",
    "CATALOGUE",
    ...catalogueLines.slice(0, 80),
    "",
    "GOAL",
    goal,
  ].join("\n");
}

function bindPrompt(goal: string, skeleton: PlanSkeleton): string {
  return [
    "Bind recipients, optional schedule, and run inputs for this skeleton. Do not change sources/actions/conditions.",
    "recipient.from is one of: goal | requester | ask_person | flow_input.",
    "schedule is null-like empty cron when the goal does not say when it runs.",
    "",
    "SKELETON",
    JSON.stringify(skeleton),
    "",
    "GOAL",
    goal,
  ].join("\n");
}

/** Run staged plan calls. Returns null when stages are off (caller uses makePlan alone). */
export async function planStages(
  goal: string,
  catalogueLines: string[],
  chooser: Chooser,
): Promise<{ skeleton: PlanSkeleton; bind: PlanBind; calls: number } | null> {
  if (!planStagesEnabled()) return null;
  let calls = 0;
  const rawSk = await chooser(skeletonPrompt(goal, catalogueLines), { name: "goal_skeleton", schema: skeletonSchema }, "builder:plan:skeleton");
  calls++;
  const skeleton = parseStrict<PlanSkeleton>(skeletonSchema, rawSk, "builder:plan:skeleton");
  const rawBind = await chooser(bindPrompt(goal, skeleton), { name: "goal_bind", schema: bindSchema }, "builder:plan:bind");
  calls++;
  const bindRaw = parseStrict<{ recipients: PlanBind["recipients"]; schedule: { cron: string; quote: string } | null; inputs: PlanBind["inputs"] }>(
    bindSchema,
    rawBind,
    "builder:plan:bind",
  );
  const bind: PlanBind = {
    recipients: bindRaw.recipients ?? [],
    schedule: bindRaw.schedule?.cron ? bindRaw.schedule : null,
    inputs: bindRaw.inputs ?? [],
  };
  return { skeleton, bind, calls };
}

/** Merge staged outputs into a loose plan-shaped object for downstream adapters. */
export function mergeStages(skeleton: PlanSkeleton, bind: PlanBind): {
  sources: PlanSkeleton["sources"];
  conditions: PlanSkeleton["conditions"];
  actions: Array<PlanSkeleton["actions"][number] & { recipient?: PlanBind["recipients"][number] }>;
  schedule: PlanBind["schedule"];
  inputs: PlanBind["inputs"];
  unclear: PlanSkeleton["unclear"];
} {
  const actions = skeleton.actions.map((a, i) => ({
    ...a,
    ...(bind.recipients.find((r) => r.action === i) ? { recipient: bind.recipients.find((r) => r.action === i)! } : {}),
  }));
  return {
    sources: skeleton.sources,
    conditions: skeleton.conditions,
    actions,
    schedule: bind.schedule,
    inputs: bind.inputs,
    unclear: skeleton.unclear,
  };
}
/**
 * Assemble staged outputs into a FULL `Plan` the normal pipeline owns (S2).
 * Skeleton refs that name a catalogue component bind to it; ones that name
 * nothing become `none_fit` — the plan's own re-ask owns them from there, the
 * assembler never invents a ref. Bind recipients keep the model `from` enum
 * (`ask_person`/`flow_input` are bind-prompt relics: the full plan cannot say
 * them — `unsaid` until a question settles them). Bind inputs land on full
 * input rows with the catalogue's own ids. Every row carries the skeleton's
 * clauses (or the goal's first clause when the skeleton cited none), so
 * coverage and the re-ask gate read a staged plan exactly like a modelled one.
 * The caller runs `normalisePlan` + `planFindings` on the result — assembly
 * is shaping, never checking.
 */
export function assembleStagedPlan(
  skeleton: PlanSkeleton,
  bind: PlanBind,
  cat: { items: Array<{ kind: string; ref: string }> },
  cs: Array<{ id: string }>,
  planIds: { inputIds: readonly string[] },
): Plan {
  const has = (kind: string, ref: string) => cat.items.some((i) => i.kind === kind && i.ref === ref);
  const fallback = cs[0]?.id ? [cs[0]!.id] : [];
  const at = (ids: string[] | undefined) => (ids?.length ? ids : fallback);
  const from = (f: string): Plan["actions"][number]["recipient"]["from"] =>
    (["goal", "requester", "rows", "unsaid"] as const).includes(f as never) ? (f as never) : "unsaid";
  return {
    sources: skeleton.sources.map((s) => ({
      ref: has("reader", s.ref) ? s.ref : NONE_FIT,
      ...(s.quote ? { quote: s.quote } : {}),
      clauses: fallback,
    })),
    each: null,
    rows: [],
    schedule: bind.schedule?.cron?.trim()
      ? { cron: bind.schedule.cron, ...(bind.schedule.quote ? { quote: bind.schedule.quote } : {}), clauses: fallback }
      : null,
    conditions: skeleton.conditions.map((c) => ({
      quote: c.quote ?? "",
      clauses: fallback,
      over: "any_row" as const,
      where: [],
      count: null,
    })),
    actions: skeleton.actions.map((a, i) => {
      const r = bind.recipients.find((x) => x.action === i);
      return {
        ref: has("tool", a.ref) ? a.ref : NONE_FIT,
        quote: a.quote ?? "",
        clauses: fallback,
        on: "always" as const,
        per_item: false,
        sends: "words" as const,
        approve_first: null,
        heading: "",
        message: "",
        recipient: { from: from(r?.from ?? "unsaid"), words: r?.words ?? "", field: "n/a" as const },
      };
    }),
    summary: null,
    inputs: bind.inputs.map((x, i) => ({
      id: planIds.inputIds[i] ?? planIds.inputIds[0]!,
      words: x.words,
      kind: "text" as const,
      fill: "each_run" as const,
      relative: "none" as const,
      days: 0,
      fills: "none",
      clauses: fallback,
    })),
    values: [],
    unclear: skeleton.unclear.map((u) => ({ quote: u.quote, about: "data" as (typeof UNCLEAR_ABOUT)[number] })),
    missing: "",
    joining: [],
    spelling: [],
  };
}
