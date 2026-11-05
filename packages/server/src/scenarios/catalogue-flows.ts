/**
 * `pnpm catalogue:flows` — REBUILD THE DEPLOYMENT'S FLOWS, realistically named.
 *
 * ── Why a rebuild rather than a rename ──────────────────────────────────────
 *
 * The deployment held 34 flows called `UAT Finance 1 1788808617143` and so on.
 * Renaming them would have left the defects they were built with: every one was
 * authored against a catalogue of ONE reader per domain that projected no
 * contact address, and 14 of their 29 transform steps read a column the reader
 * does not return — most of them running GREEN, because a jq read of an absent
 * key is null rather than an error.
 *
 * So they are rebuilt against the new catalogue, through the REAL chat builder,
 * from the kind of sentence a person types. Nothing here calls a repo to write a
 * flow: every flow in the deployment came out of `flowChatService.turn`.
 *
 * ── ⚠ WHAT IT JUDGES, AND WHAT IT DOES NOT ─────────────────────────────────
 *
 * It judges NOTHING about whether an automation is good — `uat-domains.ts` says
 * why at length and the same applies: a model judging a model is two draws from
 * one distribution, and an implementer eyeballing their own output with the
 * answer in front of them is worse. It prints what happened, per turn, in full.
 *
 * What it DOES check, because these are mechanical:
 *
 *   · did the flow end up with the declared RESULT its last message asked for
 *   · does every transform read only columns its reader actually returns
 *     (the defect this whole day was about — checked with the same
 *     `checkRefOutputFields` the validator runs)
 *
 * ⚠ Nothing is approved and nothing is armed. Triggers are created DISABLED —
 * gate 1 requires a successful run before one can be enabled, and arming a
 * flow from a seed script is how a schedule parks a run in an inbox at 03:00.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowChatService } from "../services/flow-chat.service.js";
import { triggerService, createTriggerSchema } from "../services/trigger.service.js";
import { flowTemplateService } from "../services/flow-template.service.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { checkRefOutputFields } from "../services/flow-ref-columns.js";
import { systemAuthor } from "../services/revision-author.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { pool } from "../db/index.js";

const AUTHOR = systemAuthor("catalogue:flows");

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Spec {
  /** The flow's name. Realistic — this is half of what the rebuild is for. */
  name: string;
  /** What a person types. Deliberately unpolished; it names no ref and no tool. */
  open: string;
  /** Follow-ups, each its own turn — "do two things" is what `more` is for. */
  then?: string[];
  /** A trigger to create, DISABLED. Omitted where firing it makes no sense. */
  trigger?: { name: string; type: "manual" | "webhook" | "api" };
  /** Snapshot this one as a template once it is built. */
  template?: boolean;
}

/**
 * ⚠ THE FLOWS. Three per domain, and the SHAPES are chosen, not the wording.
 *
 * Each domain gets one of each: a CHASE (read → shape → notify the people in
 * the rows), a REPORT whose answer is returned rather than sent (read → shape →
 * `llm_complete`, declared as the result — the "hand it back over the API" case
 * that had no expression before today), and a QUIET one (read → shape → post to
 * a channel, or raise a ticket). That is the variety a single reader per domain
 * made impossible.
 */
const DOMAINS: Record<string, Spec[]> = {
  Finance: [
    {
      name: "Chase overdue invoices",
      open: "email each vendor about their invoices that are past the due date",
      then: ["the result of this automation should be the list we emailed"],
      trigger: { name: "Chase invoices now", type: "manual" },
      template: true,
    },
    {
      name: "Vendor spend report",
      open: "summarise what we have spent per vendor this quarter into a short report",
      then: ["return that summary as this automation's result — do not email it"],
      trigger: { name: "Vendor spend over the API", type: "api" },
    },
    {
      name: "Expense claims to review",
      open: "post the recent expense claims to the finance channel so somebody looks at them",
    },
  ],
  "Customer Support": [
    {
      name: "Chase tickets with no reply",
      open: "email the assignee about open tickets that nobody has replied to yet",
      then: ["the result should be the tickets we chased"],
      trigger: { name: "Chase tickets now", type: "manual" },
      template: true,
    },
    {
      name: "Open ticket digest",
      open: "write me a short digest of the tickets opened this week",
      then: ["return the digest as the result rather than emailing it"],
      trigger: { name: "Digest over the API", type: "api" },
    },
    {
      name: "Unhappy customers to call",
      open: "raise a ticket for the customers who gave us a low satisfaction score",
    },
  ],
  "Orders & Fulfilment": [
    {
      name: "Tell customers their order is late",
      open: "email the customer when their order is past the promised date",
      then: ["the result of this automation should be the customers we told"],
      trigger: { name: "Notify late orders now", type: "manual" },
      template: true,
    },
    {
      name: "Fulfilment digest",
      open: "summarise the orders that are past their promised date into a paragraph",
      then: ["return that paragraph as this automation's result"],
      trigger: { name: "Fulfilment digest over the API", type: "api" },
    },
    {
      name: "Low stock warning",
      open: "post to the fulfilment channel when stock is running low",
    },
  ],
  Recruitment: [
    {
      name: "Chase offers before they expire",
      open: "email the candidate and the hiring manager about offers about to expire",
      then: ["the result should be the offers we chased"],
      trigger: { name: "Chase offers now", type: "manual" },
      template: true,
    },
    {
      name: "Pipeline report",
      open: "write a short report on the applications that have gone quiet",
      then: ["return the report as this automation's result"],
      trigger: { name: "Pipeline report over the API", type: "api" },
    },
    {
      name: "Stale roles to review",
      open: "raise a ticket for the roles that have been open the longest",
    },
  ],
};

type Built = {
  domain: string;
  name: string;
  flowId: string | null;
  steps: string[];
  output: string | null;
  turns: Array<{ message: string; status: string; secs: number; changes: string[]; reason: string }>;
  columnFindings: string[];
  trigger: string | null;
  template: string | null;
};

function changeLines(findings: unknown): string[] {
  if (!Array.isArray(findings)) return [];
  return findings.filter((f): f is string => typeof f === "string");
}

function reasonOf(turn: Record<string, unknown>): string {
  const r = turn.resultJson as { reason?: unknown; message?: unknown } | null;
  const v = r?.reason ?? r?.message;
  return typeof v === "string" ? v : "";
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--domain="))?.split("=")[1];
  const purge = process.argv.includes("--purge");

  const provider = await resolveGenerationProvider();
  console.log(`\n${c.b("catalogue:flows")} — rebuilding through the real chat builder\n`);
  // ⚠ The RESOLVED model, never the env var: `/ai-provider` overrides it, and
  // printing the env's model beside a result files it under the wrong name.
  console.log(`  ${c.dim("model")}  ${provider.model} ${c.dim(`(${provider.source})`)}`);

  const workspaces = await workspaceRepo.list();

  // ── 0. the old flows ──────────────────────────────────────────────────────
  //
  // ⚠ `--purge` only, and only flows whose name starts `UAT `. A seed script
  // that deletes by "everything I did not make" is one rename away from taking
  // somebody's working state with it.
  if (purge) {
    let removed = 0;
    for (const ws of workspaces) {
      if (ws.deletedAt) continue;
      for (const f of await flowRepo.listByWorkspace(ws.id)) {
        if (!f.name.startsWith("UAT ")) continue;
        if (f.armedRevision != null) {
          console.log(`  ${c.warn("kept")} ${f.name} — it is armed, so it is not junk`);
          continue;
        }
        await flowService.remove(ws.id, f.id);
        removed++;
      }
    }
    console.log(`  ${c.dim("purged")} ${removed} flow(s) named "UAT …"\n`);
  }

  const built: Built[] = [];

  for (const [domain, specs] of Object.entries(DOMAINS)) {
    if (only && domain !== only) continue;
    const ws = workspaces.find((w) => w.name === domain && !w.deletedAt);
    if (!ws) {
      console.log(`\n${c.bad(`no "${domain}" workspace`)}`);
      continue;
    }
    const interfaces = await manifestBuilderService.refInterfaces(ws.id);

    console.log(`\n${"─".repeat(78)}\n${c.b(domain)}  ${c.dim(ws.id)}`);

    for (const spec of specs) {
      const row: Built = {
        domain, name: spec.name, flowId: null, steps: [], output: null,
        turns: [], columnFindings: [], trigger: null, template: null,
      };
      built.push(row);

      const thread = await flowChatService.createThread(ws.id, { name: spec.name }, AUTHOR);
      console.log(`\n  ${c.b(spec.name)}  ${c.dim(thread.id)}`);

      for (const message of [spec.open, ...(spec.then ?? [])]) {
        console.log(`     ${c.b("you →")} ${message}`);
        const t0 = Date.now();
        let out: Awaited<ReturnType<typeof flowChatService.turn>> | null = null;
        let threw = "";
        try {
          out = await flowChatService.turn(ws.id, thread.id, { message }, AUTHOR);
        } catch (e) {
          // ⚠ Recorded, never swallowed: a throw from the turn path is the most
          // important thing this script can find, and a catch would make it
          // look like a bad answer.
          threw = (e as Error).message;
        }
        const secs = (Date.now() - t0) / 1000;
        const turn = (out?.turn ?? {}) as unknown as Record<string, unknown>;
        const status = threw ? `THREW: ${threw}` : String(turn.status ?? "?");
        row.flowId = out?.flowId ?? row.flowId;

        const changes = changeLines(turn.findingsJson);
        const reason = reasonOf(turn);
        row.turns.push({ message, status, secs, changes, reason });

        const tint =
          status === "applied" ? c.ok
          : status.startsWith("THREW") || status === "failed" ? c.bad
          : c.warn;
        console.log(`     ${c.b("foundry →")} ${tint(status)} ${c.dim(`${secs.toFixed(1)}s`)}`);
        for (const l of changes) console.log(`        ${c.dim("·")} ${l}`);
        if (reason && !changes.length) console.log(`        ${c.dim(reason.slice(0, 300))}`);
        if (status.startsWith("THREW")) break;
      }

      if (!row.flowId) {
        console.log(`     ${c.bad("no flow was created")}`);
        continue;
      }

      // ── the model it ended up with ──────────────────────────────────────
      const flow = await flowRepo.get(ws.id, row.flowId);
      const rev = flow ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
      const model = (rev?.modelJson ?? {}) as {
        steps?: Array<{ id: string; kind: string }>;
        output?: { stepId?: string };
      };
      row.steps = (model.steps ?? []).map((s) => `${s.id}:${s.kind}`);
      row.output = model.output?.stepId ?? null;

      // ⚠ The SAME check the validator runs. It cannot fire on a saved
      // revision (`writeRevision` refuses one that fails it), so a finding here
      // would mean the check is reachable from a path that skips `assertValid`
      // — which is worth knowing loudly rather than assuming.
      row.columnFindings = checkRefOutputFields(model as never, interfaces).map((f) => f.message);

      console.log(
        `     ${c.dim("steps")} ${row.steps.join(" → ") || "none"}` +
          `\n     ${c.dim("result")} ${row.output ? c.ok(row.output) : c.warn("none declared")}`,
      );
      for (const f of row.columnFindings) console.log(`     ${c.bad("column")} ${f.slice(0, 200)}`);

      // ── the trigger, DISABLED ────────────────────────────────────────────
      if (spec.trigger) {
        try {
          const t = await triggerService.createForFlow(
            ws.id,
            row.flowId,
            createTriggerSchema.parse({ name: spec.trigger.name, type: spec.trigger.type }),
          );
          row.trigger = `${t.type}:${t.name}`;
          console.log(`     ${c.dim("trigger")} ${t.type} "${t.name}" ${c.dim("(disabled — gate 1 needs a successful run first)")}`);
        } catch (e) {
          console.log(`     ${c.warn("trigger")} ${(e as Error).message.slice(0, 200)}`);
        }
      }

      // ── the template ─────────────────────────────────────────────────────
      if (spec.template) {
        try {
          const t = await flowTemplateService.saveFromFlow(ws.id, row.flowId, {
            name: spec.name,
            description: spec.open,
          });
          row.template = t.name;
          console.log(`     ${c.dim("template")} saved as "${t.name}"`);
        } catch (e) {
          console.log(`     ${c.warn("template")} ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }
  }

  // ── the report ────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(78)}\n${c.b("what was built")}\n`);
  for (const b of built) {
    const stat = b.flowId ? (b.steps.length ? c.ok("ok") : c.warn("empty")) : c.bad("none");
    console.log(
      `  ${stat}  ${b.domain.padEnd(20)} ${b.name.padEnd(34)} ` +
        `${String(b.steps.length).padStart(2)} step(s) · result ${b.output ?? "—"}` +
        `${b.trigger ? ` · ${b.trigger}` : ""}${b.template ? " · template" : ""}`,
    );
  }

  const withFlow = built.filter((b) => b.flowId && b.steps.length);
  const withResult = built.filter((b) => b.output);
  const asked = Object.values(DOMAINS).flat().filter((s) => s.then?.length).length;
  const badCols = built.filter((b) => b.columnFindings.length);

  console.log(`\n${c.b("summary")}`);
  console.log(`  flows built           ${withFlow.length} of ${built.length}`);
  console.log(`  declared a result     ${withResult.length} of ${asked} that were asked to`);
  console.log(`  triggers created      ${built.filter((b) => b.trigger).length}`);
  console.log(`  templates saved       ${built.filter((b) => b.template).length}`);
  console.log(
    `  column defects        ${badCols.length}` +
      (badCols.length ? `  ${c.bad("← a saved revision should be unable to carry one")}` : ""),
  );
  console.log(
    `\n${c.dim("Nothing is approved and nothing is armed. Every trigger is disabled:")}\n` +
      `${c.dim("gate 1 requires a successful run before one can be enabled.")}`,
  );

  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
