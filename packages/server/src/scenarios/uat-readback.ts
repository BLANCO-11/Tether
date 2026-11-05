/**
 * What does an APPROVER actually see?
 *
 * Renders, for two revisions of the same flow, exactly the text
 * `BusinessStepGrid` puts on screen — `ordinal`, `KIND · ref`, and
 * `contract.purpose` where one exists — beside the `RevisionDiff` payload.
 * The question is whether a reviewer who asked for a CONDITION could tell the
 * unconditional version from the conditional one.
 */
import { log, head } from "./uat-lifecycle.js";
import { flowRepo } from "../repositories/flow.repo.js";

const FLOW = process.argv[2]!;

function stepTitle(kind: string, ref: string | null) {
  const k = kind.replace(/_/g, " ").toUpperCase();
  return ref ? `${k} · ${ref}` : k;
}

async function show(rev: number) {
  const r = await flowRepo.getRevision(FLOW, rev);
  if (!r?.modelJson) { log(`revision ${rev}: none`); return; }
  const m = r.modelJson as any;
  log(`\n── revision ${rev} — "How it works", exactly as rendered ──────────`);
  m.steps.forEach((s: any, i: number) => {
    log(`   ${i + 1} · ${stepTitle(s.kind, s.ref ?? null)}`);
    if (s.contract?.purpose) log(`        ${s.contract.purpose}`);
  });
  log(`   [inputs: ${(m.inputs ?? []).map((x: any) => x.id).join(", ") || "none"}]`);
  log(`   [schedule: ${m.schedule ? `${m.schedule.cron} ${m.schedule.timezone ?? ""}` : "none"}]`);
}

async function main() {
  head("WHAT AN APPROVER SEES");
  for (const rev of process.argv.slice(3).map(Number)) await show(rev);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
