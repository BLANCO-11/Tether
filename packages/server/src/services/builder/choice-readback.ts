/**
 * The readback of CHOICES (compiled-builder phase 8, task 1; P6): for every step and every bound input of a revision, what was
 * chosen, from how many options, and by whom — so an approver reads the decisions, never the jq. Derived from WHAT IS STORED (the
 * model that runs, the confirmed GoalSpec, the build's questions) and the catalogue, never from the builder's own narration.
 *
 * Who chose, in the words the approver sees:
 * - `llm`    — the understanding call picked it (a reader or an action), with the goal's words it picked it for;
 * - `goal`   — a constant quoted from the goal;
 * - `person` — the person answered it, or built it by hand on the canvas;
 * - `code`   — the solver wired it by type, where the engine listed other options too;
 * - `forced` — the engine listed exactly one option.
 *
 * ⚠ Confidence: none is recorded. No chooser in this builder yields a calibrated one (the LLM's picks carry no probability, and
 * laya decides nothing here — phase 6), so the field is `null` and says so — never a number made up to fill the column.
 * Least-certain first: a model's pick among many, then code's among several, then answers and quotes, then forced.
 */
import { apply, describeComb, engineReaderKinds, legalMoves, type CatalogueSnapshot, type EFlow, type EStep } from "@foundry/flow-edit";
import { fieldTyIn, specMatch, type StoredBuild } from "./spec-match.js";
import { NONE_FIT, UNSAID, type GoalSpec } from "./goal-spec.js";

export type ChosenBy = "llm" | "goal" | "person" | "code" | "forced";
export interface Choice {
  stepId?: string;
  port?: string;
  /** What was decided, in plain English: "reads …", "sends to …", "keep rows where …". */
  what: string;
  chosen: string;
  /** How many options the engine listed for this decision (1 = forced). `null` where they cannot be counted from what is stored. */
  options: number | null;
  by: ChosenBy;
  /** The goal's or the person's own words this choice rests on. */
  quote?: string;
  confidence: null;
}
export interface ChoiceReadback {
  /** The confirmed GoalSpec's readback (the person's words back to them), when the revision was built from a goal. */
  goal: { text: string; readback: string[] } | null;
  /** Translation validation (D-303) re-run on the stored revision: empty when the flow does what the spec says. */
  specMatch: string[];
  choices: Choice[];
}

const RANK: Record<ChosenBy, number> = { llm: 0, code: 1, person: 2, goal: 2, forced: 3 };
const sourceWords = (b: { source: unknown }) => {
  const s = b.source as { from: string; inputId?: string; stepId?: string; field?: string; value?: unknown } | null;
  if (!s) return "not set";
  return s.from === "input" ? `the run's input ${s.inputId}` : s.from === "step" ? `${s.stepId}.${s.field}` : s.from === "whole" ? `${s.stepId}, as text` : JSON.stringify(s.value);
};

/** How many sources the engine lists for this port with it unbound — the options this choice was made from. */
function portOptions(f: EFlow, cat: CatalogueSnapshot, stepId: string, port: string): number | null {
  const r = apply(f, { op: "unbind", stepId, port }, cat);
  if (!r.ok) return null;
  const m = legalMoves(r.flow, cat).find((x) => x.op === "bind" && x.stepId === stepId && x.port === port) as { sources: unknown[]; literal: unknown } | undefined;
  return m ? m.sources.length + (m.literal ? 1 : 0) : null;
}

export function choiceReadback(model: { steps: unknown[]; inputs?: unknown[]; output?: { stepId: string }; schedule?: { cron: string } | null }, build: (StoredBuild & { goalSpec?: { goal?: string; readback?: string[]; spec: GoalSpec } | null }) | null, cat: CatalogueSnapshot): ChoiceReadback {
  const f = engineReaderKinds({ ...(model as unknown as EFlow), inputs: (model.inputs ?? []) as EFlow["inputs"], holes: [] });
  const spec = build?.goalSpec?.spec;
  const byHand = !spec; // no confirmed goal: the revision was built by a person (canvas) or before the compiled builder
  const answers = build?.trace?.questions ?? [];
  const readers = Object.values(cat.refs).filter((r) => r.kind === "query" || r.kind === "operation").length;
  const tools = Object.values(cat.refs).filter((r) => r.kind === "tool").length;
  const out: Choice[] = [];
  const who = (n: number | null, picked: ChosenBy): ChosenBy => (byHand ? "person" : n === 1 ? "forced" : picked);

  for (const s of f.steps as EStep[]) {
    if (s.kind === "datasource" || s.kind === "tool") {
      const ref = s.ref ?? "(not chosen)";
      const asked = s.kind === "datasource" ? spec?.sources : spec?.sinks;
      const hit = asked?.find((x) => x.ref === ref && x.ref !== NONE_FIT && x.ref !== UNSAID);
      const n = s.kind === "datasource" ? readers : tools;
      out.push({ stepId: s.id, what: s.kind === "datasource" ? "reads" : `calls${s.kind === "tool" && s.over ? `, once per row of ${s.over.stepId}` : ""}`, chosen: ref, options: n, by: who(n, hit ? "llm" : "code"), ...(hit ? { quote: hit.quote } : {}), confidence: null });
      for (const b of s.inputs.filter((x) => x.source)) {
        const src = b.source!;
        if (src.from === "literal") {
          const v = spec?.values.find((x) => x.fills === `${s.ref}.${b.name}`);
          const answered = answers.find((q) => q.answer !== undefined && (q.holeId.includes(`${s.id}_${b.name}`) || q.holeId.includes(`${s.id}.${b.name}`)));
          const by: ChosenBy = byHand ? "person" : b.provenance?.from === "person" || answered ? "person" : b.provenance?.from === "catalogue" ? "forced" : "goal";
          const quote = b.provenance?.quote ?? v?.quote ?? answered?.answer;
          out.push({ stepId: s.id, port: b.name, what: `sets ${b.name} to`, chosen: sourceWords(b), options: null, by, ...(quote ? { quote } : {}), confidence: null });
        } else {
          const n = portOptions(f, cat, s.id, b.name);
          out.push({ stepId: s.id, port: b.name, what: `fills ${b.name} from`, chosen: sourceWords(b), options: n, by: who(n, "code"), confidence: null });
        }
      }
    } else if (s.kind === "transform") {
      const shape = spec?.shapes?.find((sh) => sh.over === s.from);
      s.pipeline.forEach((c, k) => {
        const st = shape?.stages[k] as { quote?: string } | undefined;
        const cond = c.op === "filter" ? spec?.conditions.find((x) => x.field && JSON.stringify(c).includes(`"${x.field.slice(x.field.lastIndexOf(".") + 1)}"`)) : undefined;
        const quote = st?.quote ?? cond?.quote;
        out.push({ stepId: s.id, what: k === 0 ? `from ${s.from}` : "then", chosen: describeComb(c), options: null, by: byHand ? "person" : quote ? "llm" : "code", ...(quote ? { quote } : {}), confidence: null });
      });
    } else if (s.kind === "approval") {
      out.push({ stepId: s.id, what: "a person approves before the next step", chosen: s.summary, options: null, by: byHand ? "person" : "code", confidence: null });
    } else if (s.kind === "branch") {
      const words = s.conditions?.length ? s.conditions.map((c) => `${c.left.stepId} has ${c.op === "any" ? "rows" : "no rows"}`).join(" and ") : `otherwise (${s.elseOf} does not hold)`;
      const q = spec?.conditions.find((c) => !c.field || c.by !== undefined)?.quote;
      out.push({ stepId: s.id, what: s.elseOf ? "otherwise, when" : "only when", chosen: words, options: null, by: byHand ? "person" : q ? "llm" : "code", ...(q ? { quote: q } : {}), confidence: null });
    } else if (s.kind === "merge") {
      out.push({ stepId: s.id, what: "one value from whichever ran of", chosen: s.sources.join(", "), options: null, by: byHand ? "person" : "code", confidence: null });
    } else if (s.kind === "for_each") {
      // Phase F (D-361): the loop's settings are what an approver is asked to trust — how many at once, and what one failure does.
      out.push({ stepId: s.id, what: "runs the steps inside once per row of", chosen: `${s.over.stepId} — ${s.concurrency} at a time, ${s.onError === "stop" ? "stops the run if one item fails" : "keeps going if one item fails"}`, options: null, by: byHand ? "person" : "code", confidence: null });
    } else if (s.kind === "collect") {
      out.push({ stepId: s.id, what: `one row per item of ${s.loop}, each with the result of`, chosen: s.result, options: null, by: byHand ? "person" : "code", confidence: null });
    }
  }
  if (f.output) out.push({ stepId: f.output.stepId, what: "the flow's result is", chosen: f.output.stepId, options: null, by: byHand ? "person" : "code", confidence: null });
  if (f.schedule) out.push({ what: "runs on the schedule", chosen: f.schedule.cron, options: null, by: byHand ? "person" : spec?.schedule ? "llm" : "code", ...(spec?.schedule ? { quote: spec.schedule.quote } : {}), confidence: null });

  const order = out.map((c, i) => ({ c, i })).sort((a, b) => RANK[a.c.by] - RANK[b.c.by] || (b.c.options ?? 0) - (a.c.options ?? 0) || a.i - b.i).map((x) => x.c);
  return {
    goal: build?.goalSpec ? { text: build.goalSpec.goal ?? "", readback: build.goalSpec.readback ?? [] } : null,
    specMatch: build?.goalSpec ? specMatch(model as never, build, (ref, input) => cat.refs[ref]?.params.find((p) => p.name === input)?.selects, fieldTyIn(cat.refs)) : [],
    choices: order,
  };
}
