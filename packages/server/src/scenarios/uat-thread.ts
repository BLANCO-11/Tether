/** UAT lifecycle · send turns to a NAMED thread: uat-thread <threadId> <msg…> */
import { http, load, log, head } from "./uat-lifecycle.js";
async function main() {
  const st = load();
  const [threadId, ...msgs] = process.argv.slice(2);
  head(`THREAD ${threadId}`);
  for (const message of msgs) {
    const r = await http("POST",
      `/workspaces/${st.workspaceId}/flow-chat/threads/${threadId}/turns`, { message });
    const t = r.body?.turn ?? {};
    log(`── status=${t.status}`);
    log(`   said: ${message}`);
    if (t.findingsJson?.length) log(`   back: ${JSON.stringify(t.findingsJson).slice(0, 500)}`);
    if (t.opJson) log(`   op:   ${JSON.stringify(t.opJson).slice(0, 500)}`);
    log("");
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
