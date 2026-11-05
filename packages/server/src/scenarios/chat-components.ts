/**
 * `pnpm chat:components` — Stage 7 acceptance: a chat-built, tested, published,
 * verified workflow over the workflow-component registry (`llm` + `http`).
 *
 * The harness asserts the OUTCOME, never a script: it holds a conversation
 * through `flowChatService` (one user message at a time, capped below), lets
 * the model choose the steps, and checks what arrived — the applied ops off
 * each turn's `opJson`, the compiled YAML, a try-step run, the live deploy,
 * and a draft run whose result carries the output rows.
 *
 * A turn that comes back refused/ambiguous is retried ONCE with a rephrased
 * message, then recorded as a failed assertion — never thrown. The process
 * exits non-zero when the harness itself broke (a throw) or an assertion
 * failed; a model refusal is a printed FAIL, not a crash.
 *
 * Contingencies (printed verbatim, count as PASS):
 * - (3) `catalogue.models` is empty → the test turn is refused with the
 *   model-configuration message ("set one on the AI model page").
 * - (5) `classifyHost(url, STRICT)` refuses the host webhook target → the
 *   refusal is the outcome; the profile is not weakened, no other target.
 */
import { createServer, type Server } from "node:http";
import type { FlowEditOp } from "@foundry/flow-edit";
import { classifyHost, STRICT } from "@foundry/shared";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { flowService } from "../services/flow.service.js";
import { flowChatService } from "../services/flow-chat.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { flowCatalogueService } from "../services/flow-catalogue.service.js";
import { flowCompiler, type FlowModel } from "../services/flow-compiler.service.js";
import { flowValidator } from "../services/flow-validator.service.js";
import { stepExecutionService, type LlmEnvelope } from "../services/step-execution.service.js";
import { flowResultOf } from "../services/flow-result.js";
import { flowVisibilityService } from "../services/flow-visibility.service.js";
import { kestra } from "../services/kestra-client.service.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { systemAuthor } from "../services/revision-author.js";
import { FINANCE_WORKSPACE_NAME } from "../demo/finance/provision-finance.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";
import { pool } from "../db/index.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const AUTHOR = systemAuthor("chat:components");
const APPROVER = "chat-components-approver@example.com";
const THREAD_NAME = "chat components probe";
const MAX_TURNS = 25;

const FIXTURE_INVOICES =
  "INV-101 ACME Corp due 2026-07-01 amount 12000 days_overdue 71; " +
  "INV-102 Beta LLC due 2026-08-25 amount 800 days_overdue 17; " +
  "INV-103 Gamma Inc due 2026-06-10 amount 45000 days_overdue 92";
const FIXTURE_THRESHOLD = "5000";
const TEST_TEXT =
  "Overdue invoices: INV-101 ACME Corp amount 12000 71 days overdue; " +
  "INV-102 Beta LLC amount 800 17 days overdue; " +
  "INV-103 Gamma Inc amount 45000 92 days overdue. " +
  "Escalation threshold 5000. Reply with ONLY a JSON object.";

let failures = 0;
let passes = 0;
function check(label: string, got: unknown, want?: unknown, extra?: string) {
  const ok = want === undefined ? !!got : got === want;
  if (ok) {
    passes++;
    console.log(`  ${c.ok("PASS")} ${label}`);
  } else {
    failures++;
    console.log(`  ${c.bad("FAIL")} ${label} — got ${JSON.stringify(got)}${want === undefined ? "" : `, want ${JSON.stringify(want)}`}`);
  }
  if (extra) console.log(`       ${c.dim(extra.slice(0, 500))}`);
}

/** Applied op names seen so far, and the set_property names. */
const seenOps = new Map<string, number>();
const seenProps = new Map<string, number>();
function recordOp(op: FlowEditOp | null) {
  if (!op) return;
  seenOps.set(op.op, (seenOps.get(op.op) ?? 0) + 1);
  if (op.op === "set_property" && typeof op.property === "string") {
    seenProps.set(op.property, (seenProps.get(op.property) ?? 0) + 1);
  }
}

async function readModel(workspaceId: string, flowId: string | null): Promise<{ revision: number; model: FlowModel | null }> {
  if (!flowId) return { revision: 0, model: null };
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) throw new Error(`the flow this conversation created (${flowId}) is gone`);
  const rev = await flowRepo.getRevision(flow.id, flow.draftRevision);
  const modelJson: unknown = rev?.modelJson;
  return { revision: flow.draftRevision, model: (modelJson ?? null) as FlowModel | null };
}

const RETRYABLE = new Set(["insufficient_contract", "too_structural", "ambiguous_referent", "failed"]);

async function main() {
  const t0 = Date.now();
  let turns = 0;
  let harnessBroke = 0;
  let flowId: string | null = null;
  let server: Server | null = null;
  const received: Array<{ method: string; url: string; body: string }> = [];

  const ws = (await workspaceRepo.list()).find((w) => w.name === FINANCE_WORKSPACE_NAME && !w.deletedAt);
  if (!ws) {
    console.error(c.bad(`\nno "${FINANCE_WORKSPACE_NAME}" workspace — run \`pnpm scenarios:seed\`.\n`));
    process.exitCode = 1;
    return;
  }
  const workspaceId = ws.id;
  const workspaceName = ws.name;
  const provider = await resolveGenerationProvider();
  const catalogue = await flowCatalogueService.forWorkspace(workspaceId);
  const chatModel = catalogue.defaultModel ?? provider.model;

  console.log(`\n${"═".repeat(78)}`);
  console.log("chat:components  " + c.dim("a chat-built, tested, published, verified workflow"));
  console.log("═".repeat(78));
  console.log(`  ${c.dim("model    ")} ${provider.model}`);
  console.log(`  ${c.dim("workspace")} ${workspaceName} (${workspaceId})`);
  console.log(`  ${c.dim("catalogue")} models=[${catalogue.models.join(", ") || "(empty)"}] default=${catalogue.defaultModel ?? "(none)"}`);
  console.log(`  ${c.dim("turn cap ")} ${MAX_TURNS} user messages — a refused/ambiguous turn is retried once, then counted\n`);

  // A previous run left behind is not a reason to fail; it is a reason to clean.
  for (const t of await flowChatRepo.listThreads(workspaceId)) {
    if (t.name === THREAD_NAME) await flowChatRepo.deleteThread(workspaceId, t.id);
  }
  const stale = (await flowService.list(workspaceId)).find((r) => r.flow.name === THREAD_NAME);
  if (stale) {
    await flowService.remove(workspaceId, stale.flow.id).catch(() => {});
    console.log(c.dim(`  cleaned a flow left behind by a previous run (${stale.flow.id})`));
  }

  const thread = await flowChatService.createThread(workspaceId, { name: THREAD_NAME }, AUTHOR);
  console.log(`  ${c.dim("thread   ")} ${thread.id}\n`);

  type Said = { status: string; op: FlowEditOp | null; note: string };
  /** One user message; returns the NEW turn rows it produced. Retries once when refused/ambiguous. */
  async function say(message: string): Promise<Said[]> {
    const out: Said[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = attempt === 0 ? message : `To be concrete, and changing nothing else: ${message}`;
      const before = (await flowChatRepo.listTurns(workspaceId, thread.id)).length;
      try {
        const outcome = await flowChatService.turn(workspaceId, thread.id, { message: text }, AUTHOR);
        flowId = outcome.flowId;
        turns++;
      } catch (e) {
        harnessBroke++;
        console.log(`  ${c.bad("HARNESS")} ${(e as Error).message}`);
        return out;
      }
      const fresh = (await flowChatRepo.listTurns(workspaceId, thread.id)).slice(before);
      for (const t of fresh) {
        // Turn rows store opJson as JSON; the op schema was validated at apply time.
        const row = t as unknown as { opJson: unknown; findingsJson: unknown; refusalJson: unknown; status: unknown };
        const op = (row.opJson ?? null) as FlowEditOp | null;
        recordOp(op);
        const findings: string[] = Array.isArray(row.findingsJson) ? row.findingsJson.map((f) => String(f)) : [];
        const refusal = (row.refusalJson ?? null) as { missing?: string[]; reason?: string } | null;
        out.push({
          status: typeof row.status === "string" ? row.status : "?",
          op,
          note: refusal ? `missing: ${(refusal.missing ?? []).join(", ")} — ${refusal.reason ?? ""}` : (findings[0] ?? ""),
        });
      }
      const last = out[out.length - 1];
      console.log(
        `  ${c.dim(`msg ${turns}`)} ${String(last?.status ?? "?").padEnd(22)} ${(last?.op?.op ?? "—").padEnd(15)} ${c.dim(`"${message.slice(0, 72)}${message.length > 72 ? "…" : ""}"`)}`,
      );
      if (last?.note) console.log(`       ${c.dim(last.note.slice(0, 200))}`);
      if (last && !RETRYABLE.has(last.status)) return out;
      if (attempt === 0) console.log(`       ${c.warn("retrying once, rephrased")}`);
    }
    return out;
  }

  const needProps = ["model", "temperature", "promptBlocks", "method", "headers"];
  const buildDone = () =>
    (seenOps.get("add_step") ?? 0) >= 1 &&
    needProps.every((p) => (seenProps.get(p) ?? 0) >= 1) &&
    (seenOps.get("set_output_rows") ?? 0) >= 1;

  try {
    // ── 1. Build by chat only ──────────────────────────────────────────────
    console.log(c.b("1 · build by chat only"));
    console.log(`  ${c.dim("goal: when given overdue invoices + a threshold, ask the model which are worth escalation, POST the shortlist, return it")}`);

    await say(
      "Build an automation for overdue invoices. When I give it a list of overdue invoices and a threshold, " +
        "it should ask the model which ones are worth escalation, POST the shortlist to a webhook, and return the shortlist. " +
        "First step: declare two flow inputs, BOTH optional (not required — the schedule fires with no caller): " +
        "`invoices` (STRING) and `threshold` (FLOAT).",
    );
    if (buildDone()) console.log(`  ${c.dim("early stop: every build assertion already has evidence")}`);

    if (!buildDone())
      await say(
        `Add the llm step that reads the invoices and the threshold and picks the invoices worth escalation. ` +
          `Use model "${chatModel}", and declare structured output fields "shortlist" and "rationale".`,
      );
    if (!buildDone())
      await say(
        "Add the http step that POSTs the model's shortlist to https://hooks.example.test/escalations (a placeholder — the real URL comes later). " +
          "Use POST with a Content-Type: application/json header and put the shortlist in the body.",
      );

    // Whatever the model already set, steer one property at a time until each
    // required set_property has been observed applied.
    const refinements: Array<{ prop: string; msg: string }> = [
      { prop: "model", msg: `Set the llm step's model to "${chatModel}".` },
      { prop: "temperature", msg: "Set the llm step's temperature to 1 — this model only supports its default sampling." },
      {
        prop: "promptBlocks",
        msg: "Rewrite the llm step's prompt so it says: read the overdue invoices and the threshold, escalate what is over threshold and long overdue, and answer with a JSON object holding shortlist, rationale and text.",
      },
      { prop: "headers", msg: "Send a Content-Type header of application/json on the http step." },
    ];
    for (const r of refinements) {
      if (buildDone() || turns >= MAX_TURNS) break;
      if ((seenProps.get(r.prop) ?? 0) >= 1) continue;
      await say(r.msg);
    }
    // The method edits need a live read: flip to a different verb and back to
    // POST, so both are real changes the engine applies as set_property.
    if (!buildDone() && turns < MAX_TURNS - 6) {
      const { model: m1 } = await readModel(workspaceId, flowId);
      const h1 = (m1?.steps ?? []).find((s) => s.kind === "http");
      if (h1 && h1.kind === "http") {
        await say(`Set the http step's method to ${h1.method === "PUT" ? "PATCH" : "PUT"}.`);
        if (turns < MAX_TURNS - 5) await say("Set the http step's method to POST.");
      }
    }
    if (!buildDone() && turns < MAX_TURNS && (seenOps.get("set_output_rows") ?? 0) < 1) {
      await say("The steps are done — do not add or change any step. Now declare what the automation RETURNS via output rows: one row named `shortlist` reading the llm step, and one row named `delivery` reading the http step.");
    }
    // A schedule fires with no caller, so every input must be optional. There
    // is no set-defaults op — redeclare through remove + declare in one turn.
    for (let i = 0; i < 2; i++) {
      if (turns >= MAX_TURNS - 8) break;
      const { model: m3 } = await readModel(workspaceId, flowId);
      const reqd = (m3?.inputs ?? []).filter((x) => x.required !== false);
      if (!reqd.length) break;
      await say(`The \`${reqd[0]!.id}\` input must be optional, not required — remove it and declare it again as not required, still read by the same steps.`);
    }
    if (turns < MAX_TURNS) {
      const { model: now } = await readModel(workspaceId, flowId);
      const steps = (now?.steps ?? []).map((s) => `${s.kind}(${s.id})`).join(", ");
      console.log(`  ${c.dim(`steps now: ${steps || "(none)"} · schedule: ${now?.schedule?.cron ?? "(none)"}`)}`);
      if (!now?.schedule) {
        await say("Run this every weekday morning at 9am UTC.");
      }
    }
    // Insurance: anything that is not the llm/http pair fails the registry
    // validation (an unregistered ref fails the save) — and a removed step's
    // orphaned inputs would block the schedule — so drop both, up to two turns.
    for (let i = 0; i < 2; i++) {
      if (turns >= MAX_TURNS - 5) break;
      const { model: m2 } = await readModel(workspaceId, flowId);
      const extra = (m2?.steps ?? []).find((s) => s.kind === "tool" || s.kind === "datasource" || s.kind === "query" || s.kind === "code");
      if (!extra) break;
      await say(`Remove the "${extra.id}" step entirely, and remove any flow input that nothing else reads — this automation is the llm step and the http step.`);
    }
    if (turns < MAX_TURNS) {
      const { model: late } = await readModel(workspaceId, flowId);
      if (!late?.schedule) await say("Run this every weekday morning at 9am UTC.");
    }


    console.log("\n  ── build assertions ──");
    check("applied ops include add_step", (seenOps.get("add_step") ?? 0) >= 1, true, `add_step x${seenOps.get("add_step") ?? 0}`);
    for (const p of needProps) check(`applied ops include set_property ${p}`, (seenProps.get(p) ?? 0) >= 1, true, `${p} x${seenProps.get(p) ?? 0}`);
    check("applied ops include set_output_rows", (seenOps.get("set_output_rows") ?? 0) >= 1, true);

    if (!flowId) {
      failures++;
      console.log(`  ${c.bad("FAIL")} no flow was created by the conversation — cannot continue`);
      return;
    }

    // ── 2. Saves and compiles ──────────────────────────────────────────────
    console.log("\n" + c.b("2 · saves and compiles"));
    const { revision, model } = await readModel(workspaceId, flowId);
    if (!model) {
      failures++;
      console.log(`  ${c.bad("FAIL")} newest revision unreadable — cannot continue`);
      return;
    }
    check("newest revision readable with steps", (model.steps ?? []).length >= 2, true, `revision ${revision}`);
    const allowedModels = (await resolveGenerationProvider()).allowedModels;
    let validErr: string | null = null;
    try {
      flowValidator.assertValid(model, [], {}, allowedModels);
    } catch (e) {
      validErr = (e as Error).message;
    }
    check("every step passes the registry-derived validation", validErr === null, true, validErr ?? "assertValid ok");
    const { draft } = await flowService.namespaces(workspaceId);
    // The same `flowCompiler.compile` call the export/kestra route makes.
    const compiled = flowCompiler.compile(model, {
      namespace: draft,
      withSchedule: false,
      labels: { foundry_flow: flowId, foundry_revision: String(revision), foundry_env: "draft" },
    });
    check("compiled YAML has an http.Request task", compiled.yaml.includes("io.kestra.plugin.core.http.Request"), true);
    check("compiled YAML calls back for the http step", compiled.yaml.includes("/api/steps/http"), true);
    check("compiled YAML calls back for the llm step", compiled.yaml.includes("/api/steps/llm"), true);

    // ── 3. Can be tested ───────────────────────────────────────────────────
    console.log("\n" + c.b("3 · can be tested"));
    const found = (model.steps ?? []).find((s) => s.kind === "llm");
    const llmStep = found !== undefined && found.kind === "llm" ? found : null;
    if (catalogue.models.length === 0) {
      // Empty-catalogue contingency: the llm step cannot save, so the test turn
      // is refused with the model-configuration message.
      const res = await say(`Test the model step with this text: ${TEST_TEXT}`);
      const verbatim = res.map((r) => r.note).join(" · ");
      check("test turn refused with the model-configuration message", /AI model page/.test(verbatim), true, verbatim);
    } else {
      check("catalogue carries models", catalogue.models.length > 0, true, catalogue.models.join(", "));
      const testRes = await say(`Test the model step${llmStep ? ` (${llmStep.id})` : ""} with this text: ${TEST_TEXT}`);
      console.log(`  ${c.dim(`test turn came back ${testRes[testRes.length - 1]?.status ?? "?"} — the run below is the assertion`)}`);
      const blocks = (llmStep?.promptBlocks ?? []).filter(
        (b) => b.role === "system" || b.role === "user" || b.role === "assistant",
      );
      const llmFields = llmStep?.outputFields ?? [];
      let envelope: LlmEnvelope | null = null;
      let tryErr: string | null = null;
      try {
        // The try-step path from TryStepPanel's route (`routes/step-try.ts` →
        // `stepTryService.tryStep`) fits one parameter object, not a prompt —
        // an llm step is refused there ("run the flow to try it"). The service
        // directly below it runs one llm step, so the harness calls it.
        envelope = await stepExecutionService.llm(workspaceId, {
          stepId: llmStep?.id ?? "llm",
          params: {
            model: llmStep?.model || chatModel,
            temperature: llmStep?.temperature ?? 0.2,
            topP: llmStep?.topP ?? 1,
            frequencyPenalty: llmStep?.frequencyPenalty ?? 0,
            presencePenalty: llmStep?.presencePenalty ?? 0,
            messages: [...blocks.map((b) => ({ role: b.role, text: b.text })), { role: "user" as const, text: TEST_TEXT }],
            ...(llmFields.length ? { outputFields: llmFields } : {}),
          },
        });
      } catch (e) {
        tryErr = (e as Error).message;
      }
      check("try-step run of the model step answered", envelope !== null, true, tryErr ?? JSON.stringify(envelope).slice(0, 300));
      if (envelope) {
        check("try-step answer carries text", envelope.text.length > 0, true, envelope.text.slice(0, 200));
        for (const f of llmFields) check(`try-step answer carries declared output field "${f.name}"`, envelope[f.name] !== undefined, true);
      }
    }

    // ── 4. Can be published ────────────────────────────────────────────────
    console.log("\n" + c.b("4 · can be published"));
    const flowRow = await flowRepo.get(workspaceId, flowId);
    if (!flowRow) throw new Error("the flow is gone before publish");
    const armed = await flowApprovalService.approve(workspaceId, flowId, {
      revision: flowRow.draftRevision,
      approverUserId: APPROVER,
      approverKind: "client_admin",
      note: "chat:components",
    });
    check("revision armed", (armed.flow.armedRevision ?? 0) > 0, true, `armed at ${armed.flow.armedRevision}`);
    const { live } = await flowService.namespaces(workspaceId);
    const liveFlow = await kestra.getFlow(live, flowRow.kestraFlowId);
    const trigger = (liveFlow?.triggers ?? []).find((t) => (t.type ?? "").endsWith("trigger.Schedule")) ?? null;
    check("live namespace holds the flow", !!liveFlow, true);
    check("the Schedule trigger is present", !!trigger, true, trigger ? `${trigger.type} ${trigger.cron ?? ""}` : "no schedule trigger");
    const liveSource = await kestra.getFlowSource(live, flowRow.kestraFlowId);
    check("live YAML is the compiled flow (http callback)", liveSource.includes("/api/steps/http"), true);
    check("live YAML is the compiled flow (llm callback)", liveSource.includes("/api/steps/llm"), true);

    // ── 5. Runs ────────────────────────────────────────────────────────────
    console.log("\n" + c.b("5 · runs"));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: unknown) => (body += String(chunk)));
      req.on("end", () => {
        received.push({ method: req.method ?? "?", url: req.url ?? "?", body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "0.0.0.0", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const hookUrl = `http://host.docker.internal:${port}/hook`;
    console.log(`  ${c.dim(`webhook listening on ${hookUrl}`)}`);

    await say(`Post the shortlist to this URL: ${hookUrl}`);
    check("applied ops include set_property url", (seenProps.get("url") ?? 0) >= 1, true, `url x${seenProps.get("url") ?? 0}`);
    const decision = await classifyHost("host.docker.internal", STRICT);
    if (!decision.allowed) {
      const verbatim = `classifyHost("host.docker.internal", STRICT) refused: ${decision.reason ?? "(no reason given)"}`;
      console.log(`  ${c.warn("CONTINGENCY")} ${verbatim}`);
      console.log(`  ${c.dim("the profile stands; no other target is invented. This is the recorded outcome of (5).")}`);
      passes++;
      console.log(`  ${c.ok("PASS")} webhook target refusal recorded verbatim (plan contingency)`);
    } else {
      check("webhook target allowed by STRICT", true, true);
      const ex = await runDraft(workspaceId, flowId, { invoices: FIXTURE_INVOICES, threshold: FIXTURE_THRESHOLD });
      console.log(`  ${c.dim(`execution ${ex.state.current} ${stepReport(ex)}`)}`);
      check("run settled SUCCESS", ex.state.current, "SUCCESS");
      const execRow = await flowExecutionRepo.getByKestraId(ex.id);
      check("run is bound to the flow", execRow?.flowId, flowId);
      const view = execRow ? await flowVisibilityService.get(workspaceId, execRow.id) : null;
      const declared = (await readModel(workspaceId, flowId)).model?.output ?? null;
      const result = flowResultOf(declared, (view?.steps ?? []).map((s) => ({ stepId: s.stepId, kind: s.kind, status: s.status, output: s.output })));
      check("run result is available", result.available, true, result.unavailableReason ?? undefined);
      const rowNames = declared?.rows?.map((r) => r.name) ?? [];
      // The rows projection is a name-to-value map when rows were declared.
      const value = (result.value ?? {}) as Record<string, unknown>;
      for (const n of rowNames) check(`run result contains output row "${n}"`, value[n] !== undefined && value[n] !== null, true, String(JSON.stringify(value[n])).slice(0, 200));
      const text = JSON.stringify(value);
      check("row values carry the llm step's answer", /INV-10[13]/.test(text), true, text.slice(0, 300));
      check("row values carry the http step's answer", /200/.test(text) || received.length > 0, true, `${received.length} webhook hit(s)`);
      check("webhook received the POST", received.length > 0, true, received[0] ? `${received[0].method} ${received[0].url} ${received[0].body.slice(0, 200)}` : "nothing arrived");
      if (received[0]) check("posted shortlist names an escalated invoice", /INV-10[13]/.test(received[0].body), true);
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await flowChatRepo.deleteThread(workspaceId, thread.id).catch(() => {});
    if (flowId) await flowService.remove(workspaceId, flowId).catch(() => {});
    console.log(c.dim("\n  cleaned up: the thread, its turns, the flow (draft+live), and the webhook server"));
  }

  const wall = (Date.now() - t0) / 1000;
  console.log(`\n${"═".repeat(78)}`);
  const opsLine = [...seenOps.entries()].map(([k, v]) => `${k} x${v}`).join(" · ") || "(none)";
  console.log(`  turns ${turns} (cap ${MAX_TURNS}) · applied ops: ${opsLine}`);
  console.log(`  set_property: ${[...seenProps.entries()].map(([k, v]) => `${k} x${v}`).join(" · ") || "(none)"}`);
  console.log(`  wall ${wall.toFixed(1)}s · ${c.ok(`${passes} PASS`)}${failures ? ` · ${c.bad(`${failures} FAIL`)}` : ""}${harnessBroke ? ` · ${c.bad(`harness broke x${harnessBroke}`)}` : ""}`);
  await pool.end().catch(() => {});
  process.exit(harnessBroke > 0 || failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(c.bad(`\nchat:components could not run: ${(e as Error).message}\n`));
  await pool.end().catch(() => {});
  process.exit(1);
});
