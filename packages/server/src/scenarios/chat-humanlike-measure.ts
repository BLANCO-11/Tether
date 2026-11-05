/**
 * `pnpm chat:humanlike` — how does the chat builder behave when the person is
 * VAGUE, which is how people actually type?
 *
 * ── Why this exists beside `chat:measure` ────────────────────────────────────
 *
 * `chat:measure` sends what its own docblock calls *"scenario 1's own proven
 * messages"*: sentences chosen because they are known to work. That is the
 * right way to measure whether the machinery holds together, and it is the
 * wrong way to answer *"can a person who does not already know the answer get
 * one?"* — every sentence in it was written by somebody who did.
 *
 * So every probe here is underspecified on purpose, and the two statuses that
 * only exist to meet a vague person — `needs_input` and `ambiguous_referent` —
 * are exercised for the first time anywhere in this repository.
 *
 * ── It is a MEASUREMENT, not a gate ─────────────────────────────────────────
 *
 * Exits non-zero only if the harness could not run. A turn the model answered
 * badly is a number to read. Same posture as `chat:measure`, `draft:measure`
 * and `kestra:refusal`.
 *
 * ── ⚠ THE JUDGE IS THE MODEL UNDER TEST ─────────────────────────────────────
 *
 * Asked for deliberately, recorded here rather than softened, and the full
 * argument is in `chat-humanlike-adjudicate.ts`. The short form: a model
 * grading its own output shares its own blind spots, so no judged figure below
 * is independent evidence. `CONTROLS` — five planted replies with verdicts
 * declared before any run, three bad and two good — are what stand between that
 * and an unfalsifiable score. **If they do not separate, this run prints the
 * judged half as VOID.** The observable half needs no judgement and stands
 * either way.
 *
 * ── The follow-up turn, and why the answer is not mine ──────────────────────
 *
 * A probe that ASKS gets one follow-up, answered with the builder's **own first
 * offered option, verbatim**. Never a sentence written here: an answer I compose
 * is an answer tuned to the question, which would measure my reading of it
 * rather than the builder's. A question that is asked well and still leads
 * nowhere is worse for a person than a guess, and nothing else measures that.
 *
 * ⚠ When a question offers no options at all, no follow-up is sent and the run
 * records `no-options` — scored as neither resolved nor unresolved, because a
 * free-text question answered by this harness would be the harness answering
 * itself.
 *
 *   pnpm --filter @foundry/server chat:humanlike
 *   pnpm --filter @foundry/server chat:humanlike --rounds=1
 *   pnpm --filter @foundry/server chat:humanlike --keep
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { FlowEditOp } from "@foundry/flow-edit";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowChatService } from "../services/flow-chat.service.js";
import { inference } from "../services/inference.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { systemAuthor } from "../services/revision-author.js";
import type { FlowModel } from "../services/flow-compiler.service.js";
import {
  CONTROLS,
  PROBES,
  behaviourOf,
  buildJudgePrompt,
  inventedRefs,
  judgeIsUsable,
  mentionsGap,
  parseVerdict,
  tally,
  type ControlOutcome,
  type Probe,
  type ProbeResult,
  type Verdict,
} from "./chat-humanlike-adjudicate.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const AUTHOR = systemAuthor("chat:humanlike");
const KEEP = process.argv.includes("--keep");
const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? "2");
/**
 * ⚠ `--probes=P07,P08` narrows the run. For ITERATING ON THE HARNESS only —
 * a partial run's rates are not comparable with a full one's, so the header
 * says so on screen rather than leaving a reader to notice the count.
 */
const ONLY = (process.argv.find((a) => a.startsWith("--probes="))?.split("=")[1] ?? "")
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter(Boolean);

/**
 * The flow a mid-edit probe lands on.
 *
 * ⚠ **Authored directly, never built by a conversation.** Building it with
 * chat turns would put the model's own earlier choices into the state the probe
 * is measured against, so a probe would be answering a flow it had written —
 * and a bad turn early would change what every later probe means. This model is
 * fixed, so `change the filter` is ambiguous between the same two steps every
 * time.
 *
 * ⚠ **Two filter-shaped steps is the point of the Finance one.**
 * `ambiguous_referent` cannot fire unless there is a genuine ambiguity to
 * detect; a base flow with one filter would report the status's absence as a
 * finding about the model when it was a property of the fixture.
 */
function baseModel(workspace: "HR" | "Finance", id: string): FlowModel {
  if (workspace === "HR") {
    return {
      id,
      name: id,
      steps: [
        {
          id: "fetch",
          kind: "datasource",
          ref: "hr_demo.attendance_below_threshold",
          paramsExpr: '[{"period": "{{ inputs.period }}"}]',
        },
        {
          id: "notify",
          kind: "tool",
          ref: "mail_send",
          paramsExpr:
            '[{"recipients": ["hr-ops@acme-hr.example"], "sender": "foundry@acme-hr.example", "subject": "Attendance", "body": {{ json(outputs.fetch.body).results[0].data | jq(\'tostring | @json\') | first }}}]',
          dependsOn: ["fetch"],
        },
      ],
      inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
    } as unknown as FlowModel;
  }
  return {
    id,
    name: id,
    steps: [
      {
        id: "fetch",
        kind: "datasource",
        ref: "finance_demo.invoices_overdue",
        paramsExpr: '[{"as_of": "{{ inputs.as_of }}"}]',
      },
      {
        id: "big_ones",
        kind: "transform",
        expr: "{{ json(outputs.fetch.body).results[0].data | jq('[.[] | select(.amount_cents > 100000)]') | first }}",
        dependsOn: ["fetch"],
      },
      {
        id: "old_ones",
        kind: "transform",
        expr: "{{ outputs.big_ones.value | jq('[.[] | select(.days_overdue > 30)]') | first }}",
        dependsOn: ["big_ones"],
      },
      {
        id: "send_note",
        kind: "tool",
        ref: "mail_send",
        paramsExpr:
          '[{"recipients": ["ap@acme-fin.example"], "sender": "foundry@acme-fin.example", "subject": "Overdue invoices", "body": {{ outputs.old_ones.value | jq(\'tostring | @json\') | first }}}]',
        dependsOn: ["old_ones"],
      },
    ],
    inputs: [{ id: "as_of", type: "STRING", defaults: "2026-06-30" }],
  } as unknown as FlowModel;
}

/** A one-line description of the flow, for the judge's context. */
function summarise(model: FlowModel | null): string {
  if (!model) return "empty — nothing has been built yet";
  const steps = (model as unknown as { steps: Array<{ id: string; kind: string; ref?: string }> }).steps;
  return steps.map((s) => `${s.id} (${s.kind}${s.ref ? ` ${s.ref}` : ""})`).join(" → ");
}

type TurnRow = {
  status: string;
  reply: string;
  options: string[];
  opRefs: string[];
  /**
   * The op the model REACHED FOR, even on a turn that refused it.
   *
   * ⚠ Recorded because a refusal names what is wrong with an op and never
   * which op it was, so a run reporting only the sentence cannot tell "the
   * model produced nonsense" from "the model produced a reasonable op the
   * engine has no home for". Those need opposite fixes.
   */
  op: string;
};

/**
 * What the person would SEE.
 *
 * ⚠ Assembled from the columns the client renders, not from a field invented
 * here: `findingsJson[0]` carries `describeOp` on an applied turn and the
 * question payload on a `needs_input`, and `refusalJson` carries the refusal.
 * A judge shown anything else would be judging a view no person has.
 */
function replyOf(turn: Record<string, unknown>): TurnRow {
  const findings = (turn.findingsJson ?? null) as string[] | null;
  const refusal = (turn.refusalJson ?? null) as { missing?: string[]; reason?: string } | null;
  const op = (turn.opJson ?? null) as FlowEditOp | null;
  const opRefs: string[] = [];
  const step = (op as unknown as { step?: { ref?: string } } | null)?.step;
  if (step?.ref) opRefs.push(step.ref);

  const options: string[] = [];
  /**
   * ⚠ **EVERY findings line, not the first** — 2026-09-06, and this harness
   * misreported a real finding because of it. An `ambiguous_referent` files the
   * question and then one line per candidate, so reading `[0]` showed the word
   * `big_ones` alone and the run was written up as "one candidate, no
   * question". Both candidates were there. A harness that shows less than the
   * person sees will make the product look worse in one place and better in
   * another, and there is no way to tell which from the output.
   */
  let reply = (findings ?? []).filter(Boolean).join("\n");
  try {
    const parsed = JSON.parse(reply) as {
      text?: string;
      questions?: Array<{ question?: string; options?: Array<{ label?: string; value?: string }> }>;
    };
    if (parsed && (parsed.text || parsed.questions)) {
      const qs = (parsed.questions ?? []).map((q) => {
        const opts = (q.options ?? []).map((o) => o.label ?? o.value ?? "").filter(Boolean);
        for (const o of q.options ?? []) if (o.value ?? o.label) options.push(o.value ?? o.label!);
        return `${q.question ?? ""}${opts.length ? `  [${opts.join(" | ")}]` : ""}`;
      });
      reply = [parsed.text ?? "", ...qs].filter(Boolean).join("\n");
    }
  } catch {
    /* not a question payload — the findings line is the reply */
  }
  const candidates = (turn.candidatesJson ?? null) as string[] | null;
  if (candidates?.length) {
    reply = `${reply}\n(candidates: ${candidates.join(", ")})`;
    options.push(...candidates);
  }
  if (refusal) reply = `${reply}\nmissing: ${(refusal.missing ?? []).join(", ")} — ${refusal.reason ?? ""}`.trim();
  return { status: String(turn.status ?? ""), reply: reply.trim() || "(no text)", options, opRefs, op: (op as { op?: string } | null)?.op ?? "—" };
}

type Run = ProbeResult & {
  workspace: string;
  op: string;
  followUp: "resolved" | "unresolved" | "no-options" | "n/a";
  followUpStatus: string;
  flowSummary: string;
};

async function main() {
  const provider = await resolveGenerationProvider();
  const all = await workspaceRepo.list();
  const wsOf: Record<string, { id: string; refs: Set<string> }> = {};
  for (const name of ["HR", "Finance"]) {
    const w = all.find((x) => x.name === name);
    if (!w) {
      console.error(c.bad(`\nno "${name}" workspace — run \`pnpm demo:seed\` and \`pnpm finance:seed\`.\n`));
      process.exit(1);
    }
    wsOf[name] = { id: w.id, refs: new Set(Object.keys(await manifestBuilderService.refFingerprints(w.id))) };
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log("chat:humanlike  " + c.dim("does the builder cope with the way people actually type?"));
  console.log("═".repeat(80));
  console.log(`  ${c.dim("model    ")} ${provider.model}${provider.source === "configured" ? c.dim("  (set on /ai-provider)") : ""}`);
  console.log(`  ${c.dim("judge    ")} ${provider.model} ${c.warn("— the model under test grades itself; controls decide whether that is readable")}`);
  console.log(`  ${c.dim("probes   ")} ${PROBES.length} × ${ROUNDS} round(s), ${PROBES.filter((p) => p.start === "empty").length} from empty · ${PROBES.filter((p) => p.start === "mid_edit").length} mid-edit\n`);

  const SELECTED = ONLY.length ? PROBES.filter((p) => ONLY.includes(p.id)) : PROBES;
  if (ONLY.length) {
    console.log(c.warn(`  ⚠ PARTIAL RUN — ${SELECTED.length} of ${PROBES.length} probes. Rates are not comparable with a full run.\n`));
  }

  const runs: Run[] = [];
  let harnessBroke = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(c.b(`\n── round ${round} ${"─".repeat(62)}`));
    for (const probe of SELECTED) {
      const ws = wsOf[probe.workspace]!;
      const tag = `chat-hl-${probe.id.toLowerCase()}-r${round}-${Date.now().toString(36)}`;
      let flowId: string | null = null;
      let threadId: string | null = null;
      const started = Date.now();
      try {
        let model: FlowModel | null = null;
        if (probe.start === "mid_edit") {
          model = baseModel(probe.workspace, tag);
          const created = await flowService.create(ws.id, { name: tag, model, author: AUTHOR });
          flowId = created.flow.id;
        }
        const thread = await flowChatService.createThread(
          ws.id,
          { name: tag, ...(flowId ? { flowId } : {}) } as never,
          AUTHOR,
        );
        threadId = thread.id;

        const outcome = await flowChatService.turn(ws.id, thread.id, { message: probe.text }, AUTHOR);
        flowId = outcome.flowId ?? flowId;
        const row = replyOf(outcome.turn as unknown as Record<string, unknown>);
        const behaviour = behaviourOf(row.status);

        // The follow-up — only when it asked, and only in its own words.
        let followUp: Run["followUp"] = "n/a";
        let followUpStatus = "—";
        if (behaviour === "asked") {
          if (!row.options.length) {
            followUp = "no-options";
          } else {
            const answer = row.options[0]!;
            const second = await flowChatService.turn(ws.id, thread.id, { message: answer }, AUTHOR);
            // ⚠ **The follow-up is often what CREATES the flow**, because the
            // first turn asked a question and applied nothing. Reading `flowId`
            // only from the first turn left two real flows behind in Finance —
            // a cleanup that runs, reports nothing and cleans nothing.
            flowId = second.flowId ?? flowId;
            followUpStatus = String((second.turn as unknown as { status: string }).status);
            followUp = followUpStatus === "applied" ? "resolved" : "unresolved";
          }
        }

        const invented = inventedRefs(row.opRefs, ws.refs);
        runs.push({
          probeId: probe.id,
          round,
          workspace: probe.workspace,
          op: row.op,
          status: row.status,
          behaviour,
          clarificationRounds: behaviour === "asked" ? 1 : 0,
          mentionedGap: mentionsGap(row.reply, probe),
          invented,
          verdict: null,
          secs: Math.round((Date.now() - started) / 100) / 10,
          reply: row.reply,
          followUp,
          followUpStatus,
          flowSummary: summarise(model),
        });
        const mark =
          behaviour === "asked" ? c.ok("ASKED  ") : behaviour === "guessed" ? c.warn("GUESSED") : c.dim("neither");
        console.log(
          `  ${probe.id} ${mark} ${c.dim(row.status.padEnd(20))} ${invented.length ? c.bad("invented:" + invented.join(",")) : ""} ${c.dim(probe.text.slice(0, 42))}`,
        );
      } catch (e) {
        // A throw is the HARNESS failing, never the model: `turn` answers a bad
        // reply, a refusal and an ambiguity by finishing the turn.
        harnessBroke++;
        console.log(`  ${probe.id} ${c.bad("HARNESS")} ${(e as Error).message.slice(0, 70)}`);
      } finally {
        if (!KEEP) {
          if (threadId) await flowChatRepo.deleteThread(wsOf[probe.workspace]!.id, threadId).catch(() => {});
          if (flowId) await flowService.remove(wsOf[probe.workspace]!.id, flowId).catch(() => {});
        }
      }
    }
  }

  // ── Judging, controls mixed in blind ───────────────────────────────────────
  console.log(c.b(`\n── judging ${"─".repeat(64)}`));
  const probeById = new Map(PROBES.map((p) => [p.id, p]));

  async function judge(text: string, gap: string, flowSummary: string, reply: string): Promise<Verdict | null> {
    const out = await inference.complete(buildJudgePrompt({ text, gap, flowSummary, reply }), {
      label: "chat-humanlike:judge",
    });
    return parseVerdict(typeof out === "string" ? out : ((out as { text?: string }).text ?? ""));
  }

  const controlOutcomes: ControlOutcome[] = [];
  for (const ctl of CONTROLS) {
    const p = probeById.get(ctl.probeId)!;
    const v = await judge(p.text, p.gap, p.start === "empty" ? "empty — nothing built yet" : "an existing flow", ctl.reply);
    const agreed = v ? v.gapAddressed === ctl.expectGapAddressed : false;
    controlOutcomes.push({ id: ctl.id, expected: ctl.expectGapAddressed, got: v?.gapAddressed ?? null, agreed });
    console.log(
      `  ${agreed ? c.ok("✓") : c.bad("✗")} ${ctl.id.padEnd(30)} expected ${String(ctl.expectGapAddressed).padEnd(5)} got ${String(v?.gapAddressed ?? "unreadable")}`,
    );
  }
  const usable = judgeIsUsable(controlOutcomes);
  console.log(
    usable
      ? c.ok("\n  the judge separated good from bad in BOTH directions — judged figures are readable, with the self-grading caveat")
      : c.bad("\n  ⚠ the judge did NOT separate both directions — every judged figure below is VOID; read the observable half only"),
  );

  if (usable) {
    for (const r of runs) {
      const p = probeById.get(r.probeId)!;
      r.verdict = await judge(p.text, p.gap, r.flowSummary, r.reply);
    }
  }

  // ── The report ─────────────────────────────────────────────────────────────
  const t = tally(runs);
  console.log(c.b(`\n── observable — no judgement anywhere in these ${"─".repeat(38)}`));
  console.log(`  turns            ${t.n}`);
  console.log(`  ASKED            ${t.asked}   ${c.dim("needs_input / ambiguous_referent")}`);
  console.log(`  GUESSED          ${t.guessed}   ${c.dim("applied — it committed to a reading")}`);
  console.log(`  neither          ${t.neither}   ${c.dim("declined, refused, or the turn failed")}`);
  console.log(c.dim("  ── the two cross-tabs, because neither rate is the score ──"));
  console.log(`  asked where a default WAS available    ${t.askedWhereDefaultExisted}`);
  console.log(`  guessed where NO default was available ${t.guessedWhereNoDefault}`);
  console.log(`  reply touched the declared gap         ${t.mentionedGap} / ${t.n}`);
  console.log(`  committed to a ref no catalogue has    ${t.invented} ${t.invented ? c.bad("←") : ""}`);
  const asked = runs.filter((r) => r.behaviour === "asked");
  console.log(
    `  of the ${asked.length} that asked: ${asked.filter((r) => r.followUp === "resolved").length} resolved on the follow-up, ` +
      `${asked.filter((r) => r.followUp === "unresolved").length} did not, ${asked.filter((r) => r.followUp === "no-options").length} offered no options`,
  );
  console.log(
    usable && t.meanQuality !== null
      ? `\n  judged mean quality  ${t.meanQuality} / 5  ${c.warn("(self-graded — not independent evidence)")}`
      : `\n  judged mean quality  ${c.bad("VOID")}`,
  );

  const out = {
    takenAt: new Date().toISOString(),
    model: provider.model,
    judge: provider.model,
    judgeSelfGraded: true,
    judgeUsable: usable,
    rounds: ROUNDS,
    controls: controlOutcomes,
    tally: t,
    runs,
    harnessBroke,
  };
  const path = new URL(`../../../../.harness-results/chat-humanlike-${Date.now()}.json`, import.meta.url).pathname;
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(c.dim(`\n  raw results → ${path}\n`));

  if (harnessBroke) {
    console.error(c.bad(`  ${harnessBroke} turn(s) could not be held at all — the harness failed, not the model.\n`));
    process.exit(1);
  }
}

void main();
