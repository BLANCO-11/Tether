/**
 * MEASURES which `execution.*` fields Pebble actually resolves on this engine.
 *
 * ⚠ Written because a chat-built flow shipped `{{ execution.startedAt }}`. The
 * root `execution` is on D-22's allowlist, so it passed every static check,
 * compiled, deployed — and died at RUNTIME with `Unable to find 'startedAt'`.
 * D-22 governs ROOTS and FUNCTIONS; nothing has ever checked the field under a
 * root that is allowed.
 *
 * ⚠ **The list this produces must be MEASURED, never written from memory** —
 * the discipline I-118 exists for, where three of seven allowlisted "functions"
 * were jq's vocabulary rather than Pebble's and the prompt taught a runtime
 * failure. So: one Log task per candidate, `allowFailure` so a bad one fails
 * only itself, and the answer read from which tasks succeeded.
 *
 * Deployed to `foundry.system`, which by construction can never obtain an
 * execution token (D-09), so this probe cannot touch a tenant.
 */
import { kestra } from "../services/kestra-client.service.js";

const NS = "foundry.system";
const ID = "expression-probe";

/** Plausible spellings, right and wrong. The wrong ones are the point. */
const CANDIDATES = [
  "id", "startDate", "originalId", "state", "namespace", "flowId",
  "flowRevision", "url", "labels",
  // The ones a model reaches for, and the one that actually shipped:
  "startedAt", "startTime", "started", "start_date", "createdAt", "timestamp",
];

const yaml = `id: ${ID}
namespace: ${NS}
tasks:
${CANDIDATES.map((c) => `  - id: f_${c}
    type: io.kestra.plugin.core.log.Log
    allowFailure: true
    message: "{{ ${process.env.PROBE_ROOT ?? 'execution'}.${c} }}"`).join("\n")}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await kestra.deployFlow({ value: NS } as never, ID, yaml);
  const ex: any = await kestra.startExecution({ value: NS } as never, ID);
  console.log("execution:", ex?.id ?? JSON.stringify(ex).slice(0, 200));
  const execId = ex?.id;
  if (!execId) { console.log("could not start; deployed only"); return; }

  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const e: any = await kestra.getExecution(execId);
    if (!["SUCCESS", "FAILED", "WARNING", "KILLED"].includes(e?.state?.current)) continue;
    console.log(`\nstate: ${e.state.current}\n`);
    const ok: string[] = [];
    const bad: string[] = [];
    for (const t of e.taskRunList ?? []) {
      const name = String(t.taskId).replace(/^f_/, "");
      (t.state?.current === "SUCCESS" ? ok : bad).push(name);
    }
    console.log("RESOLVES:      " + ok.join(", "));
    console.log("DOES NOT:      " + bad.join(", "));
    return;
  }
  console.log("never settled");
}
main().catch((e) => { console.error(String(e)); process.exitCode = 1; });
