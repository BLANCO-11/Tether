/**
 * Assign one identity to every workspace, as a super admin would from
 * /organization.
 *
 * ⚠ **By SUBJECT, never by email.** `workspace_members.subject` is keyed on the
 * token's `oid` for an Entra account, and the 2026-08-21 incident is exactly
 * what happens when that is got wrong: the row exists, the person signs in, and
 * the refusal says "you are not a member of this workspace" with the assignment
 * sitting right there.
 */
import { http, log, head, SUPER } from "./uat-lifecycle.js";

const SUBJECT = process.argv[2]!;
const EMAIL = process.argv[3]!;
const ROLE = process.argv[4] ?? "admin";

async function main() {
  head(`ASSIGN ${EMAIL} (${SUBJECT}) as ${ROLE}`);
  const ws = await http("GET", "/workspaces", undefined, SUPER);
  for (const w of ws.body?.workspaces ?? []) {
    const r = await http("POST", `/workspaces/${w.id}/members`,
      { subject: SUBJECT, email: EMAIL, role: ROLE }, SUPER);
    log(`${String(w.name).padEnd(22)} → HTTP ${r.status}` +
      (r.status >= 400 ? `  ${JSON.stringify(r.body).slice(0, 160)}` : `  ${r.body?.member?.role}`));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
