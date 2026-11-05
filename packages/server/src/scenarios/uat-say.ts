/** `uat:say` — send ONE more message to an existing UAT thread. */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowChatRepo } from "../repositories/flow-chat.repo.js";
import { flowChatService } from "../services/flow-chat.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { pool } from "../db/index.js";

async function main() {
  const wsName = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const threadNeedle = process.argv.find((a) => a.startsWith("--thread="))?.split("=")[1];
  const message = process.argv.find((a) => a.startsWith("--message="))?.slice("--message=".length);
  if (!wsName || !message) throw new Error("need --workspace= and --message=");

  const ws = (await workspaceRepo.list()).find((w) => w.name === wsName && !w.deletedAt);
  if (!ws) throw new Error(`no workspace "${wsName}"`);
  const threads = await flowChatRepo.listThreads(ws.id);
  const thread = threads.find((t) => (threadNeedle ? t.name.includes(threadNeedle) : true));
  if (!thread) throw new Error(`no thread matching "${threadNeedle}"`);

  console.log(`thread ${thread.name}\nyou → ${message}`);
  const out = await flowChatService.turn(ws.id, thread.id, { message }, systemAuthor("uat:say"));
  const t = out.turn as unknown as Record<string, unknown>;
  console.log(`foundry → ${t.status}`);
  for (const f of (Array.isArray(t.findingsJson) ? t.findingsJson : [])) console.log(`   · ${typeof f === "string" ? f : JSON.stringify(f)}`);
  if (t.refusalJson) console.log(`   ${JSON.stringify(t.refusalJson).slice(0, 400)}`);

  if (out.flowId) {
    const f = await flowRepo.get(ws.id, out.flowId);
    const rev = f ? await flowRepo.getRevision(f.id, f.draftRevision) : null;
    const steps = ((rev?.modelJson as { steps?: Array<{ id: string; kind: string; ref?: string; paramsExpr?: string }> })?.steps) ?? [];
    for (const s of steps) {
      console.log(`   ${s.kind}${s.ref ? `(${s.ref})` : ""}  ${s.id}`);
      if (s.paramsExpr) console.log(`      params: ${s.paramsExpr.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  await pool.end();
}
if (process.argv[1] && process.argv[1].endsWith("uat-say.ts")) {
  main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
}
