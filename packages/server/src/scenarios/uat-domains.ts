/**
 * `pnpm uat:domains` — DRIVE THE REAL CHAT BUILDER, on the real deployment,
 * with the kind of sentence an actual person types.
 *
 * ── Why this is a new file and not a flag on `chat:measure` ──────────────────
 *
 * `chat-measure.ts` says in its own header that scenario 1 must stay byte for
 * byte, because its numbers are a comparable series. This asks a different
 * question, so it gets a different file.
 *
 *   `chat:measure`   Does the turn engine behave? Instrumented, one thread,
 *                    declared expectations, model-call accounting.
 *   `uat:domains`    Can somebody who has never seen this product get a valid
 *                    automation out of it, in four different domains, from one
 *                    vague sentence?
 *
 * ── ⚠ WHAT MAKES THE PROMPTS HONEST ─────────────────────────────────────────
 *
 * They are deliberately **underspecified and unpolished**. Nobody types "create
 * a datasource step reading invoices_overdue and a tool step calling
 * test_email_send"; they type "email me the invoices that are overdue". Writing
 * prompts that name the machinery would measure this harness's knowledge of the
 * catalogue, not the product's ability to interpret a request.
 *
 * ⚠ **And they name NO ref, NO table and NO tool.** That is the point after the
 * catalogue reset: every datasource on this deployment has ZERO readers, so a
 * turn has to notice the gap and offer to build the reader (`needs_component`,
 * D-179) before it can build anything. A prompt naming a reader would route
 * straight past the path most worth testing.
 *
 * ── ⚠ IT JUDGES NOTHING ITSELF, AND THAT IS DELIBERATE ──────────────────────
 *
 * There is no scoring here. `propose-measure.ts` can adjudicate because its
 * expectations were declared in the commit that created the file, before any
 * proposal was seen. There is no such thing for "is this a good automation" —
 * a model judging a model is two draws from one distribution, and an
 * implementer eyeballing their own output with the answer in front of them is
 * worse. So this prints WHAT HAPPENED, per turn, in full, and a person reads
 * it. Any number it invented would be a number about itself.
 *
 * ⚠ Nothing is armed and nothing is approved. It writes draft revisions only.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { dbOperationService } from "../services/db-operation.service.js";
import { proposeOperation } from "../services/db-operation-proposal.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowChatService } from "../services/flow-chat.service.js";
import { systemAuthor } from "../services/revision-author.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { pool } from "../db/index.js";

const AUTHOR = systemAuthor("uat:domains");

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Conversation {
  /** What a person would type first. */
  open: string;
}

/**
 * ⚠ **ACCEPTING A `needs_component` OFFER IS NOT A CHAT MESSAGE, and finding
 * that out is worth writing down.**
 *
 * The first version of this harness answered the offer by typing *"yes please
 * build it"*, which is what a person would naturally do. The turn came back
 * `needs_input` with three options, one of them **"Attendance compliance
 * workflow"** — in the FINANCE workspace. So a conversational "yes" does not
 * accept the offer, and the thing it does instead is worse than a refusal.
 *
 * What the UI actually does is three calls (`ChatPanel.tsx`'s
 * `NeedsComponent`), and this reproduces them exactly so the journey being
 * measured is the journey a person takes:
 *
 *   1. `proposeOperation(dsId, need)` — the need seeded from the step's own
 *      words, underscores to spaces, byte for byte as that component does it.
 *   2. a person reads the READBACK and approves it.
 *   3. `createOperation(dsId, { name, spec })` — the SUBMITTED spec, compiled
 *      again server-side. No proposal id travels.
 *   4. the ORIGINAL message is re-sent, and now resolves.
 *
 * ⚠ Step 2 is the one this harness cannot honestly perform. It approves every
 * proposal unread, so the readback is PRINTED IN FULL and a person reads it
 * afterwards. `propose-measure.ts` is the harness that adjudicates proposals
 * against expectations declared before they were seen; this one is not it.
 */
interface AcceptedComponent {
  ref: string;
  need: string;
  name: string;
  readback: string[];
  sql: string;
  attempts: number;
  outcome: "created" | "refused" | "failed";
  detail: string;
}

/**
 * ⚠ THE PROMPTS. Four domains, and the phrasing is the subject under test.
 *
 * Each set opens with the plainest possible form of the job the domain exists
 * to do, then two that are vaguer or ask for more than one thing — because "do
 * two things" is exactly what the `more` continuation was built for and what
 * used to be silently truncated.
 */
const DOMAINS: Record<string, Conversation[]> = {
  Finance: [
    { open: "email me a list of invoices that are overdue" },
    { open: "every week send me the unpaid invoices and a short summary of them" },
    { open: "which customers owe us the most? send it to my email" },
  ],
  "Customer Support": [
    { open: "email me the support tickets that missed their target" },
    { open: "send me a daily digest of open tickets, with a paragraph explaining it" },
    { open: "who has been waiting the longest for a reply?" },
  ],
  "Orders & Fulfilment": [
    { open: "email me the orders that are past their promised date" },
    { open: "let me know about orders we have not shipped yet, and summarise it" },
    { open: "tell customers when their order is late" },
  ],
  Recruitment: [
    { open: "remind me about offers that are about to expire" },
    { open: "email me a summary of where every candidate is in the process" },
    { open: "which roles have been open the longest?" },
  ],
};

type TurnRow = {
  domain: string;
  convo: number;
  seq: number;
  message: string;
  status: string;
  ops: string[];
  changes: string[];
  reason: string;
  steps: number;
  secs: number;
};

/** `describeOp` lines the turn recorded, one per applied op. */
function changeLines(findings: unknown): string[] {
  if (!Array.isArray(findings)) return [];
  return findings
    .map((f) => (typeof f === "string" ? f : typeof f === "object" && f ? JSON.stringify(f) : ""))
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * The one sentence a person would read off a non-`applied` turn.
 *
 * ⚠ It reads the turn's OWN recorded fields, never a re-derivation: a refusal's
 * reason is the most useful diagnosis this system produces, and paraphrasing it
 * here would report a sentence nobody was actually shown.
 */
function reasonOf(t: Record<string, unknown>): string {
  const r = t.refusalJson as { reason?: string; message?: string } | null;
  if (r?.reason) return r.reason;
  if (r?.message) return r.message;
  const f = t.findingsJson;
  if (Array.isArray(f) && f.length) return changeLines(f).join(" · ");
  return "";
}

/**
 * Reproduce the three calls `NeedsComponent` makes, then say what happened.
 *
 * ⚠ The `need` is seeded the way that component seeds its own box — the step's
 * own words with underscores turned to spaces — rather than a sentence this
 * file invents. A better-worded need would measure this harness's prompting,
 * not the product's.
 */
async function acceptOffer(
  workspaceId: string,
  ref: string,
): Promise<AcceptedComponent> {
  const dsName = ref.slice(0, ref.indexOf("."));
  const wanted = ref.slice(ref.indexOf(".") + 1);
  const need = wanted.replace(/_/g, " ");
  const base: AcceptedComponent = {
    ref, need, name: wanted, readback: [], sql: "", attempts: 0,
    outcome: "failed", detail: "",
  };

  const ds = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === dsName);
  if (!ds) return { ...base, detail: `no datasource named "${dsName}" in this workspace` };

  let proposal;
  try {
    proposal = await proposeOperation({ workspaceId, dsId: ds.id, need });
  } catch (e) {
    return { ...base, detail: `proposeOperation threw: ${(e as Error).message}` };
  }

  if (proposal.status !== "ok") {
    // ⚠ A refusal is a RESULT, not an error. Re-asking a correct "this schema
    // cannot express that" is how it becomes a plausible-looking column on
    // attempt 2, so nothing here retries.
    return {
      ...base,
      outcome: "refused",
      detail: `insufficient_schema — ${proposal.reason} (missing: ${proposal.missing.join(", ") || "—"})`,
    };
  }

  const readback = proposal.readback.map((r) =>
    typeof r === "string" ? r : `${(r as { text?: string }).text ?? JSON.stringify(r)}`,
  );

  try {
    await dbOperationService.create(workspaceId, ds.id, {
      name: proposal.name,
      ...(proposal.description.trim() ? { description: proposal.description.trim() } : {}),
      spec: proposal.spec,
    } as never);
  } catch (e) {
    return {
      ...base, name: proposal.name, readback, sql: proposal.compiledSql,
      attempts: proposal.attempts,
      detail: `createOperation refused: ${(e as Error).message}`,
    };
  }

  return {
    ...base,
    name: proposal.name,
    readback,
    sql: proposal.compiledSql,
    attempts: proposal.attempts,
    outcome: "created",
    detail: "",
  };
}

/** The ref a `needs_component` turn was blocked on. */
function refFromOp(op: unknown): string | null {
  const o = op as { ref?: string; step?: { ref?: string } } | null;
  const ref = o?.ref ?? o?.step?.ref ?? null;
  return typeof ref === "string" && ref.includes(".") ? ref : null;
}

async function main() {
  const only = process.argv.find((a) => a.startsWith("--domain="))?.split("=")[1];

  const provider = await resolveGenerationProvider();
  console.log(`\n${c.b("uat:domains")} — the chat builder, on vague human sentences\n`);
  // ⚠ The RESOLVED model, never the env var. `/ai-provider` overrides it, and
  // printing the env's model beside a number the override produced files the
  // reading under the wrong model's name.
  console.log(`  ${c.dim("model")}    ${provider.model}  ${c.dim(`(${provider.source})`)}`);

  const workspaces = await workspaceRepo.list();
  const rows: TurnRow[] = [];
  const built: Array<{ domain: string; name: string; flowId: string; steps: string[] }> = [];
  const accepted: Array<AcceptedComponent & { domain: string }> = [];

  for (const [domain, conversations] of Object.entries(DOMAINS)) {
    if (only && domain !== only) continue;
    const ws = workspaces.find((w) => w.name === domain && !w.deletedAt);
    if (!ws) {
      console.log(`\n${c.bad(`no "${domain}" workspace`)} — run the seeds first`);
      continue;
    }

    console.log(`\n${"─".repeat(78)}\n${c.b(domain)}  ${c.dim(ws.id)}`);

    for (const [ci, convo] of conversations.entries()) {
      const name = `UAT ${domain} ${ci + 1} ${Date.now()}`;
      const thread = await flowChatService.createThread(ws.id, { name }, AUTHOR);

      console.log(`\n  ${c.b(`#${ci + 1}`)} ${c.dim("thread")} ${thread.id}`);

      let flowId: string | null = null;

      /**
       * ⚠ The loop is the JOURNEY, not a retry.
       *
       * A `needs_component` turn is an OFFER, so the conversation continues by
       * building the reader and re-sending the SAME message — which is what
       * `NeedsComponent`'s `onCreated` does. Bounded at two component builds:
       * a third would mean the turn is asking for a new reader every time,
       * which is a finding rather than something to keep paying for.
       */
      let message = convo.open;
      let componentsBuilt = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        console.log(`\n     ${c.b("you →")} ${message}`);
        const t0 = Date.now();
        let out: Awaited<ReturnType<typeof flowChatService.turn>> | null = null;
        let threw = "";
        try {
          out = await flowChatService.turn(ws.id, thread.id, { message }, AUTHOR);
        } catch (e) {
          // ⚠ Recorded, not swallowed. A throw from the turn path is the single
          // most important thing this harness can find, and a silent catch
          // would make it look like a bad answer.
          threw = (e as Error).message;
        }
        const secs = (Date.now() - t0) / 1000;

        const turnRow = (out?.turn ?? {}) as unknown as Record<string, unknown>;
        const status = threw ? `THREW: ${threw}` : String(turnRow.status ?? "?");
        flowId = out?.flowId ?? flowId;

        const state = flowId ? await flowRepo.get(ws.id, flowId) : null;
        const model = state
          ? ((await flowRepo.getRevision(state.id, state.draftRevision))?.modelJson as
              | { steps?: Array<{ id: string; kind: string; ref?: string }> }
              | undefined)
          : undefined;
        const steps = model?.steps ?? [];

        const op = turnRow.opJson as { op?: string } | null;
        const changes = changeLines(turnRow.findingsJson);
        const reason = reasonOf(turnRow);

        rows.push({
          domain, convo: ci + 1, seq: attempt + 1, message, status,
          ops: op?.op ? [op.op] : [],
          changes, reason, steps: steps.length, secs,
        });

        const tint =
          status === "applied" ? c.ok
          : status.startsWith("THREW") || status === "failed" ? c.bad
          : c.warn;
        console.log(
          `     ${c.b("foundry →")} ${tint(status)}  ${c.dim(`${secs.toFixed(1)}s · ${steps.length} step(s)`)}`,
        );
        for (const line of changes) console.log(`        ${c.dim("·")} ${line}`);
        if (reason && !changes.length) console.log(`        ${c.dim(reason.slice(0, 400))}`);

        // ── Accept the offer, exactly as the UI does ─────────────────────────
        if (status === "needs_component" && componentsBuilt < 2) {
          const ref = refFromOp(turnRow.opJson);
          if (!ref) {
            console.log(`        ${c.bad("the offer named no ref — cannot accept it")}`);
            break;
          }
          const acc = await acceptOffer(ws.id, ref);
          accepted.push({ domain, ...acc });
          const at = acc.outcome === "created" ? c.ok : acc.outcome === "refused" ? c.warn : c.bad;
          console.log(
            `        ${c.b("build the reader →")} ${at(acc.outcome)} ${c.dim(`"${acc.name}" · ${acc.attempts} inference call(s)`)}`,
          );
          for (const r of acc.readback) console.log(`           ${c.dim("readback:")} ${r}`);
          if (acc.detail) console.log(`           ${c.dim(acc.detail.slice(0, 300))}`);
          if (acc.outcome !== "created") break;
          componentsBuilt++;
          // ⚠ The ORIGINAL message, re-sent. Not a rephrasing — the whole claim
          // is that the request was answerable and the reader was missing.
          continue;
        }
        break;
      }

      if (flowId) {
        const f = await flowRepo.get(ws.id, flowId);
        const m = f ? ((await flowRepo.getRevision(f.id, f.draftRevision))?.modelJson as
          | { steps?: Array<{ id: string; kind: string; ref?: string }> }
          | undefined) : undefined;
        built.push({
          domain,
          name: f?.name ?? name,
          flowId,
          steps: (m?.steps ?? []).map((s) => `${s.kind}${s.ref ? `(${s.ref})` : ""}:${s.id}`),
        });
      }
    }
  }

  // ── What happened, counted. NOT scored. ────────────────────────────────────
  console.log(`\n${"═".repeat(78)}\n${c.b("Every turn")}\n`);
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${s}`);
  }
  const secs = rows.map((r) => r.secs).sort((a, b) => a - b);
  if (secs.length) {
    console.log(
      `\n  ${c.dim("seconds per turn")}  median ${secs[Math.floor(secs.length / 2)].toFixed(1)}` +
        `  min ${secs[0].toFixed(1)}  max ${secs[secs.length - 1].toFixed(1)}`,
    );
  }

  if (accepted.length) {
    console.log(`\n${c.b("Readers built to answer a needs_component offer")}\n`);
    for (const a of accepted) {
      const at = a.outcome === "created" ? c.ok : a.outcome === "refused" ? c.warn : c.bad;
      console.log(`  ${at(a.outcome.padEnd(8))} ${a.domain}  ${c.b(a.name)}  ${c.dim(`need: "${a.need}"`)}`);
      for (const r of a.readback) console.log(`     ${r}`);
      if (a.sql) console.log(`     ${c.dim(a.sql.replace(/\s+/g, " ").slice(0, 240))}`);
      if (a.detail) console.log(`     ${c.dim(a.detail.slice(0, 300))}`);
    }
  }

  console.log(`\n${c.b("What got built")}  ${c.dim("(drafts only — nothing approved, nothing armed)")}\n`);
  if (!built.length) console.log(`  ${c.bad("nothing")}`);
  for (const b of built) {
    console.log(`  ${c.b(b.name)}  ${c.dim(b.flowId)}`);
    if (!b.steps.length) console.log(`     ${c.bad("no steps")}`);
    for (const s of b.steps) console.log(`     ${s}`);
  }

  console.log(
    `\n${"═".repeat(78)}\n` +
      `  ${c.dim("This harness SCORES NOTHING. There is no honest way for it to judge whether")}\n` +
      `  ${c.dim("an automation is good: a model judging a model is two draws from one")}\n` +
      `  ${c.dim("distribution. Read the turns above.")}\n`,
  );

  void flowService;
  void flowChatRepo;
  await pool.end();
}

if (process.argv[1] && process.argv[1].endsWith("uat-domains.ts")) {
  main().catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
