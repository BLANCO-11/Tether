/**
 * `pnpm uat:run` — DRAFT-RUN a flow the chat builder authored, and say what
 * the email did.
 *
 * ⚠ This is the second half of `uat-domains.ts`. That harness proves a flow can
 * be BUILT; a built flow is not a working flow, and the swap rehearsal is the
 * standing reminder that a green run is not a correct one. So this reports the
 * per-task states AND what landed in the Email box, which is the only place a
 * draft run's mail can be.
 *
 * ⚠ It also closes the loop on the draft-capture control (migration 0058) with
 * real data rather than a mocked transport: the flow under test names
 * `foundry_email_send`, the REAL tool, and the assertion is that nothing was
 * delivered.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { runDraft, stepReport } from "./kestra-draft-run.js";
import { db, pool } from "../db/index.js";
import { emailSends } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function main() {
  const wsName = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const flowNeedle = process.argv.find((a) => a.startsWith("--flow="))?.split("=")[1];
  const inputs: Record<string, string> = {};
  for (const a of process.argv) {
    const m = /^--input\.([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a);
    if (m) inputs[m[1]] = m[2];
  }

  const ws = (await workspaceRepo.list()).find((w) => w.name === wsName && !w.deletedAt);
  if (!ws) throw new Error(`no workspace named "${wsName}"`);
  const flows = await flowRepo.listByWorkspace(ws.id);
  const flow = flows.find((f) => (flowNeedle ? f.name.includes(flowNeedle) : true));
  if (!flow) throw new Error(`no flow matching "${flowNeedle}" in ${ws.name}`);

  const rev = await flowRepo.getRevision(flow.id, flow.draftRevision);
  const steps = ((rev?.modelJson as { steps?: Array<{ id: string; kind: string; ref?: string }> })?.steps) ?? [];

  console.log(`\n${c.b("uat:run")}  ${ws.name} / ${flow.name}\n`);
  for (const s of steps) console.log(`  ${s.kind}${s.ref ? `(${s.ref})` : ""}  ${s.id}`);
  console.log(`\n  ${c.dim("inputs")} ${JSON.stringify(inputs)}`);

  const before = await db
    .select({ id: emailSends.id })
    .from(emailSends)
    .where(eq(emailSends.workspaceId, ws.id));

  const ex = await runDraft(ws.id, flow.id, inputs);
  const tint = ex.state.current === "SUCCESS" ? c.ok : ex.state.current === "PAUSED" ? c.warn : c.bad;
  console.log(`\n  ${c.b("execution")} ${tint(ex.state.current)}  ${c.dim(ex.id)}`);
  console.log(`  ${stepReport(ex)}`);

  // ── What the email did ─────────────────────────────────────────────────────
  const after = await db
    .select()
    .from(emailSends)
    .where(eq(emailSends.workspaceId, ws.id))
    .orderBy(desc(emailSends.createdAt));
  const seen = new Set(before.map((r) => r.id));
  const fresh = after.filter((r) => !seen.has(r.id));

  console.log(`\n  ${c.b("email")}  ${fresh.length} new row(s) in this workspace`);
  for (const r of fresh) {
    const t = r.outcome === "captured" ? c.ok : r.outcome === "sent" ? c.bad : c.warn;
    console.log(
      `    ${t(String(r.outcome).padEnd(9))} to ${(r.recipients ?? []).join(", ") || "—"}  ` +
        `${c.dim(`"${r.subject ?? ""}"`)}`,
    );
    if (r.failureReason) console.log(`      ${c.dim(r.failureReason.slice(0, 300))}`);
    if (r.capturedBody) console.log(`      ${c.dim(`body held, ${r.capturedBody.length} bytes`)}`);
  }

  // ⚠ The one assertion this harness makes, and it is about SAFETY rather than
  // correctness: a draft run must not have delivered anything.
  const delivered = fresh.filter((r) => r.outcome === "sent");
  if (delivered.length) {
    console.log(`\n  ${c.bad(`✗ ${delivered.length} message(s) were DELIVERED on a draft run`)}`);
    process.exitCode = 1;
  } else if (fresh.length) {
    console.log(`\n  ${c.ok("✓ nothing was delivered — a draft run held every message")}`);
  } else {
    console.log(`\n  ${c.warn("no email was attempted at all")}`);
  }

  await pool.end();
}

if (process.argv[1] && process.argv[1].endsWith("uat-run.ts")) {
  main().catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
