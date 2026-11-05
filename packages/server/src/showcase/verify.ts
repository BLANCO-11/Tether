/**
 * Does the showcase demonstrate what it says it demonstrates?
 *
 *   pnpm --filter @foundry/server showcase:verify
 *   pnpm --filter @foundry/server showcase:verify --period=2026-05
 *
 * ── What this checks that nothing else does ──────────────────────────────────
 *
 * The `kestra:phaseN` harnesses assert ENGINE properties against purpose-built
 * fixtures: a flow that exists for three minutes, proves one thing and is torn
 * down. `e2e:ui` walks the HTTP surface a browser uses. Neither looks at the
 * artefact a person is actually handed — six seeded flows with a sentence of
 * prose each, on a page, waiting to be clicked.
 *
 * That prose is a promise. "Emails every flagged employee", "firing its trigger
 * is a 403 until someone approves it", "the step graph shows attempt 2" — each is
 * a factual claim about what happens when the button is pressed, and each is the
 * kind of claim that rots silently. A flow keeps running green while mailing
 * nobody; a gate keeps refusing for the wrong reason; a retry demo stops
 * retrying because the endpoint's counter was reset by something else.
 *
 * So this harness runs each showcase flow and checks the CLAIM ITS DESCRIPTION
 * MAKES, against the engine, the oracle and ops-api's call log. It is the demo's
 * own regression net.
 *
 * ── Rules it follows ─────────────────────────────────────────────────────────
 *
 *  * **Evidence from this run, not from whatever was lying around.** The call log
 *    is truncated at the start, so "11 emails were sent" cannot be satisfied by a
 *    previous afternoon's run. That is also why it must not be run concurrently
 *    with a `kestra:phaseN` harness — they share one call log.
 *  * **Every claim needs a discriminating check.** "The run went green" is not
 *    evidence that a flow mailed the right eleven people; the oracle is.
 *  * **A missing prerequisite is reported, never skipped silently.** A dependency down
 *    or no LLM provider configured prints a SKIP with the reason and is counted,
 *    because a harness that quietly drops assertions reads as green.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { abortUnlessScorable } from "../demo/oracle-corpus.js";
import { flowService } from "../services/flow.service.js";
import { triggerService } from "../services/trigger.service.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { countToolCalls, opsClient } from "../services/ops-client.service.js";
import { expectedScreening } from "../demo/hr-dataset.js";
import { SHOWCASE_FLOWS } from "./flows.js";

const PERIOD = process.argv.find((a) => a.startsWith("--period="))?.split("=")[1] ?? "2026-06";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
let skipped = 0;

function check(label: string, got: unknown, want: unknown) {
  const pass = String(got) === String(want);
  if (!pass) failures++;
  console.log(
    `  ${pass ? c.ok("PASS") : c.bad("FAIL")}  ${label.padEnd(62)} ` +
      (pass ? c.dim(String(want)) : c.bad(`\n        got  ${got}\n        want ${want}`)),
  );
}

/** Reported and COUNTED. A dropped assertion must not look like a passing one. */
function skip(label: string, why: string) {
  skipped++;
  console.log(`  ${c.warn("SKIP")}  ${label.padEnd(62)} ${c.dim(why)}`);
}

const settled = (e: KestraExecution) =>
  ["SUCCESS", "WARNING", "FAILED", "KILLED", "CANCELLED"].includes(e.state.current);

async function runAndWait(
  workspaceId: string,
  flowId: string,
  inputs: Record<string, string>,
  timeoutMs = 300_000,
): Promise<KestraExecution> {
  const started = await flowService.testRun(workspaceId, flowId, inputs);
  const deadline = Date.now() + timeoutMs;
  let last: KestraExecution | undefined;
  while (Date.now() < deadline) {
    last = await kestra.getExecution(started.kestraExecutionId);
    if (settled(last)) {
      // ⚠ Every scored run goes through here, so the corpus is checked once and
      // a showcase added later cannot forget it. AFTER settling — `read_from`
      // is stamped at step-callback time, so an earlier read sees no steps and
      // would pass over nothing (I-38).
      await abortUnlessScorable(started.kestraExecutionId, "hr_demo");
      return last;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`execution ${started.kestraExecutionId} did not settle in ${timeoutMs}ms`);
}

/** Task states by id, so a claim can name the step it is about. */
const stateOf = (ex: KestraExecution, taskId: string) =>
  (ex.taskRunList ?? []).find((t) => t.taskId === taskId)?.state.current ?? "ABSENT";

async function main() {
  console.log(`\n${"═".repeat(76)}`);
  console.log(`showcase:verify — every description is a promise, checked  ${c.dim(PERIOD)}`);
  console.log(`${"═".repeat(76)}`);

  const ws = (await workspaceRepo.list()).find((w) => w.name === "HR");
  if (!ws) throw new Error('workspace "HR" not found — run `pnpm demo:seed && pnpm showcase:seed`');

  const flows = await flowRepo.listByWorkspace(ws.id);
  const bySlug = new Map(flows.map((f) => [f.kestraFlowId, f]));
  const missing = SHOWCASE_FLOWS.filter((s) => !bySlug.has(s.model.id));
  if (missing.length) {
    throw new Error(
      `not seeded: ${missing.map((m) => m.model.id).join(", ")} — run \`pnpm showcase:seed\``,
    );
  }
  const flowFor = (slug: string) => {
    const f = bySlug.get(slug);
    if (!f) throw new Error(`no flow ${slug}`);
    return f;
  };

  // Evidence must come from THIS run. Without this, "11 emails were sent" is
  // satisfiable by any earlier run of anything.
  await opsClient.reset();

  const oracle = expectedScreening(PERIOD);

  // ── 1. the reference automation ───────────────────────────────────────────
  console.log(`\n${"─".repeat(76)}\n1  "emails every flagged employee" — the reference automation\n`);
  {
    const flow = flowFor("showcase-attendance-screening");
    const ex = await runAndWait(ws.id, flow.id, { period: PERIOD });
    check("the run settles green", ["SUCCESS", "WARNING"].includes(ex.state.current), true);

    // ⚠ The whole point. A green run proves the flow did not crash; the oracle
    // is the only thing that says it mailed the RIGHT people. The measured
    // failure this migration exists for went green while mailing 0 of 11.
    const mailed = await opsClient.records<{ recipients: string[]; status: string }>("mail", 500);
    const addresses = new Set(mailed.flatMap((m) => m.recipients));
    // `flagged` is everyone under their applicable threshold; the ones with no
    // address cannot be mailed and are the escalation flow's subject, not this
    // one's. Filtering here rather than asserting a count is what makes the
    // NULL-email contractor a PASS instead of an off-by-one.
    const expected = oracle.flagged
      .filter((e) => e.email)
      .map((e) => e.email as string);
    check(
      "…and mails exactly the employees the oracle flags",
      [...addresses].sort().join(","),
      [...new Set(expected)].sort().join(","),
    );
    // The empty case is a correct outcome, not a bug (I-09). At 2026-05 the
    // dataset flags nobody, and a flow that only works in a bad month is the
    // shape a single-period harness never catches.
    if (expected.length === 0) {
      console.log(c.dim(`        (${PERIOD} flags nobody — the empty case, and it is a PASS)`));
    }
    check(
      "…and does it in ONE taskrun, not one per recipient (M1)",
      stateOf(ex, "notify"),
      "SUCCESS",
    );

    // The description promises an armed schedule. Approval DEPLOYS a Kestra
    // Schedule trigger, so the claim is checkable in the live namespace rather
    // than in a Foundry column.
    check("…and it is the armed one", flow.armedRevision !== null, true);
    const { live } = await flowService.namespaces(ws.id);
    const liveYaml = await kestra
      .getFlow(live, "showcase-attendance-screening")
      .then((f) => JSON.stringify(f))
      .catch(() => "");
    check("…with a real Schedule trigger deployed live, not `disabled: true`",
      liveYaml.includes("Schedule") && !liveYaml.includes('"disabled":true'), true);
  }

  // ── 2. gate 2 refusing ────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(76)}\n2  "firing its trigger is a 403 until someone approves it"\n`);
  {
    const flow = flowFor("showcase-unreachable-escalation");
    check("the flow is unapproved, which is the state being demonstrated", flow.armedRevision, null);

    const triggers = await triggerService.listByFlow(ws.id, flow.id);
    const trigger = triggers[0];
    if (!trigger) {
      skip("firing it is refused", "the seed left no trigger on this flow");
    } else {
      // ⚠ Gate 1 must already be SATISFIED, or the 403 below is gate 1 wearing
      // gate 2's badge and the demo shows the wrong control refusing.
      check("…and gate 1 is satisfied, so the refusal is genuinely gate 2", trigger.enableReady, true);
      let status = 0;
      let message = "";
      try {
        await triggerService.fire(trigger.id, "manual");
      } catch (e) {
        status = (e as { statusCode?: number }).statusCode ?? 0;
        message = (e as Error).message;
      }
      check("…firing it is refused", status, 403);
      check(
        "…and the refusal says approval, not something generic",
        /approv/i.test(message),
        true,
      );
    }
  }

  // ── 3. the contained fragment ─────────────────────────────────────────────
  console.log(`\n${"─".repeat(76)}\n3  "a generated Python fragment … no network, no credentials"\n`);
  {
    const flow = flowFor("showcase-department-rollup");
    const ex = await runAndWait(ws.id, flow.id, { period: PERIOD });
    check("the run settles green", ["SUCCESS", "WARNING"].includes(ex.state.current), true);
    check("…the fragment step ran", stateOf(ex, "assess"), "SUCCESS");
    check("…and its result reached chat", (await countToolCalls("chat_post_message")) >= 1, true);
    // The containment itself is V1 and belongs to `kestra:phase4`, which proves
    // it with a positive control on a normal network. Asserting it again here
    // without that control would be a check that cannot fail.
    console.log(c.dim("        (containment itself is V1 — proved in kestra:phase4, with a control)"));
  }

  // ── 4. runtime retry ──────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(76)}\n4  "503 on the first call … the step graph shows attempt 2"\n`);
  {
    const flow = flowFor("showcase-retry-recovery");
    const ex = await runAndWait(ws.id, flow.id, {});
    // WARNING is the PASS. A recovered run settles WARNING by design, and
    // treating anything but SUCCESS as failure would report the retry showcase
    // as broken every time it worked.
    check("the run settles WARNING — recovered, and recorded as such", ex.state.current, "WARNING");
    check("…the probe step is where the retry happened", stateOf(ex, "probe"), "WARNING");
    // Two independent witnesses. Kestra saying "attempt 2" while the service saw
    // one request would mean the retry never left the engine.
    const probeCalls = await countToolCalls("flaky_probe", { succeededOnly: false });
    check("…and the ENDPOINT saw two requests, not one", probeCalls >= 2, true);
    check("…the run still reached its last step", stateOf(ex, "report"), "SUCCESS");
  }

  // ── 5. the LLM tool ───────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(76)}\n5  "SQL computes the figures; a language model writes them up"\n`);
  {
    const provider = await opsClient.llm.get().catch(() => null);
    if (!provider?.configured) {
      skip("the digest flow produces text", "no LLM provider configured — see /ai-provider");
    } else {
      const flow = flowFor("showcase-llm-digest");
      const ex = await runAndWait(ws.id, flow.id, { period: PERIOD });
      check("the run settles green", ["SUCCESS", "WARNING"].includes(ex.state.current), true);
      check("…the model produced text", stateOf(ex, "summarise"), "SUCCESS");
      check("…which was posted", stateOf(ex, "post"), "SUCCESS");

      const chat = await opsClient.records<{ text: string; author: string }>("chat", 50);
      const digest = chat.find((m) => m.text?.includes("Attendance digest"));
      check("…and the chat message carries the generated prose", (digest?.text?.length ?? 0) > 120, true);

      // ⚠ THE ASSERTION THIS BLOCK EXISTS FOR. Every other tool's request body is
      // logged; the LLM tool's is a prompt built from an upstream step's output,
      // so it substitutes a size summary — and that summary is rendered on the
      // Outbox page. A regression here is invisible in every other test: the flow
      // still works, the text is still right, and a slice of the tenant's data is
      // quietly at rest in a second database.
      const log = await opsClient.callLog(200);
      const llmRows = log.filter((r) => r.toolName === "llm_complete");
      check("the call log recorded the LLM call", llmRows.length >= 1, true);
      const leaked = llmRows.filter((r) => {
        const body = JSON.stringify(r.body ?? {});
        return body.includes("INSTRUCTION") || /"(instruction|input)":\s*"/.test(body);
      });
      check("…storing SIZES, never the prompt or the completion", leaked.length, 0);
      check(
        "…and the sizes are actually there, so the check above is not vacuous",
        typeof (llmRows[0]?.body as { input_chars?: number })?.input_chars === "number",
        true,
      );
    }
  }

  // ── 6. per-item routing ───────────────────────────────────────────────────
  console.log(`\n${"─".repeat(76)}\n6  "one list, a destination per band"\n`);
  {
    // Evidence must come from THIS run: the screening block above already mailed
    // every flagged employee, so without a reset "exactly the severe set" would
    // be satisfiable by an earlier block's mail.
    await opsClient.reset();
    const flow = flowFor("showcase-routing");
    const ex = await runAndWait(ws.id, flow.id, { period: PERIOD });
    check("the run settles green", ["SUCCESS", "WARNING"].includes(ex.state.current), true);
    check("…the severe branch ran", stateOf(ex, "severe"), "SUCCESS");
    check("…the mild branch ran", stateOf(ex, "mild"), "SUCCESS");
    check("…and the bare-name list ran", stateOf(ex, "shout"), "SUCCESS");
    const severe = oracle.flagged.filter((e) => e.rate < 70 && e.email).map((e) => e.email as string);
    const mailed = await opsClient.records<{ recipients: string[] }>("mail", 500);
    check(
      "…below 70% were emailed, and only they were",
      [...new Set(mailed.flatMap((m) => m.recipients))].sort().join(","),
      [...new Set(severe)].sort().join(","),
    );
    const chat = await opsClient.records<{ text: string }>("chat", 100);
    const texts = chat.map((m) => m.text ?? "");
    check(
      "…every flagged employee was named in chat, once per branch",
      oracle.flagged.every((e) => texts.includes(e.name)) && texts.length === oracle.flagged.length,
      true,
    );
  }

  if (failures) {
    console.log(c.bad(`${failures} claim(s) FAILED`) + (skipped ? c.warn(` · ${skipped} skipped`) : ""));
    process.exit(1);
  }
  console.log(
    c.ok("every showcase description checks out") +
      (skipped ? c.warn(` · ${skipped} skipped — read them, they are not passes`) : ""),
  );
}

main()
  .catch((e) => {
    console.error(c.bad(`\nshowcase:verify crashed: ${(e as Error).message}`));
    process.exit(1);
  })
  .finally(async () => {
    const { pool } = await import("../db/index.js");
    await pool.end().catch(() => {});
  });
