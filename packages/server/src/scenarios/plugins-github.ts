/**
 * Plugins, phase 4 — the LIVE half of the OAuth proof (plans/plugins-2026-10-27, decision 5): GitHub, signed in through
 * Foundry's own screen, used by a workflow. The mock-provider half (refresh after expiry) is
 * `services/plugin-oauth.service.test.ts`; a GitHub OAuth app's token does not expire, so it cannot show a refresh.
 *
 * Needs, done by a PERSON in the browser first (the secret is never typed anywhere but Foundry's screen):
 *   1. an OAuth app at github.com/settings/applications/new with the return address Foundry shows;
 *   2. its client id + secret on /apps/github → "Sign-in app" (scope narrowed to `repo`);
 *   3. "Connect with GitHub" in the workspace under test — a WORKSPACE connection, not "only for me".
 *
 * Then: ./scripts/harness-in-net.sh packages/server/src/scenarios/plugins-github.ts
 *   GITHUB_TEST_REPO=owner/name (default BLANCO-11/foundry-connector-test) — a throwaway private repo.
 *
 * Proves: the sign-in connection is accepted by GitHub (who it is); a TEST run records the issue and creates nothing;
 * a LIVE run creates exactly that issue; a search runs in both. ⚠ Leaves the created issue open, named as a test.
 * `main()` runs at import.
 */
import { config } from "../config/index.js";
import { pluginRepo } from "../repositories/plugin.repo.js";
import { pluginService } from "../services/plugin.service.js";
import { invokePluginTool } from "../services/plugin-connector.service.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { piFlowService } from "../services/pi-flow.service.js";
import { flowRunnerService, type PiBundle } from "../services/flow-runner.service.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import type { RunnerStepResult } from "../repositories/runner-step-result.repo.js";

const PIECE = "@activepieces/piece-github";
const [OWNER, REPO] = (process.env.GITHUB_TEST_REPO ?? "BLANCO-11/foundry-connector-test").split("/") as [string, string];
const ACTOR = { subject: "plugins-github-harness", email: null };
const REQUESTER = { actor: "plugins-github", subject: null, kind: "system" as const };
const FLOW = "Connector test — open a GitHub issue";

let failed = 0;
const ok = (c: unknown, what: string, detail?: unknown) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${what}${detail !== undefined ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  if (!c) failed++;
};

function bundle(title: string): PiBundle {
  const step = (id: string, description: string, uses: string[], outputs: string[], extra: Record<string, unknown> = {}) => ({
    id,
    description,
    entry: `steps/${id}/main.py`,
    params: { title: "$input.title" },
    outputs,
    uses,
    ...extra,
  });
  return {
    workflow: {
      name: FLOW,
      inputs: { title: { type: "string", description: "The issue's title", default: title } },
      steps: [
        step("open_issue", "Opens an issue in the test repository", ["tool:github_create_issue_ai"], ["issue", "raw"]),
        step("list_issues", "Lists the repository's open issues", ["tool:github_list_repository_issues"], ["issues"], {
          allow_empty: [{ output: "issues", reason: "a new repository has no issues, and a test run opens none" }],
        }),
      ],
    },
    files: {
      "steps/open_issue/main.py": [
        "import foundry",
        "def run(params, inputs):",
        `    r = foundry.call('github_create_issue_ai', {'owner': '${OWNER}', 'repo': '${REPO}', 'title': params['title'], 'body': 'Opened by Foundry\\'s connector test. Safe to close.'})`,
        "    return {'issue': [{'title': params['title'], 'performed': not r.get('captured', False)}], 'raw': r}",
        "",
      ].join("\n"),
      "steps/list_issues/main.py": [
        "import foundry",
        "def run(params, inputs):",
        `    r = foundry.call('github_list_repository_issues', {'owner': '${OWNER}', 'repo': '${REPO}', 'state': 'open'})`,
        "    items = r if isinstance(r, list) else (r.get('issues') or r.get('items') or r.get('data') or [])",
        "    return {'issues': [{'number': i.get('number'), 'title': i.get('title')} for i in items if isinstance(i, dict)]}",
        "",
      ].join("\n"),
    },
  };
}

const out = (steps: RunnerStepResult[], id: string) => steps.find((s) => s.stepId === id)?.outputJson as Record<string, unknown> | undefined;

/** Read GitHub directly through the connection (a SEARCH runs in any mode) — the outside world, not the flow's view. */
async function issueTitles(workspaceId: string): Promise<string[]> {
  const tool = (await toolRepo.listByWorkspace(workspaceId)).find((t) => t.name === "github_list_repository_issues")!;
  const { results } = await invokePluginTool(workspaceId, tool, [{ owner: OWNER, repo: REPO, state: "all" }]);
  if (!results[0]?.ok) throw new Error(results[0]?.error ?? "no answer");
  const data = results[0].data as unknown;
  // GitHub's piece answers `{items: […]}`.
  const items = Array.isArray(data) ? data : ((data as { items?: unknown[]; issues?: unknown[] })?.items ?? (data as { issues?: unknown[] })?.issues ?? []);
  return (items as Array<{ title?: string }>).map((i) => String(i.title ?? ""));
}

async function main() {
  console.log(`plugins phase 4 · GitHub · ${OWNER}/${REPO} · connectors ${config.plugins.enabled ? "on" : "off"}`);
  if (!config.plugins.enabled) {
    ok(false, "connectors are on for this process (PLUGINS_CONNECTOR_URL and PLUGINS_CONNECTOR_SECRET set)");
    process.exit(1);
  }

  // ── 0. the sign-in connection a person made in the browser ──
  console.log("\n0  the connection");
  // A sign-in is what phase 4 proves; a key (personal access token) proves the same workflow path, and the run says
  // which it used rather than passing one off as the other.
  const all = (await pluginRepo.listConnectionsForPiece(PIECE)).filter((c) => !c.ownerSubject).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const conn = all.find((c) => c.authType === "OAUTH2") ?? all[0];
  ok(!!conn, "a workspace connection to GitHub exists", all.map((c) => `${c.label} (${c.authType})`));
  if (!conn) process.exit(1);
  console.log(`  using "${conn.label}" — ${conn.authType === "OAUTH2" ? "made by signing in" : `a ${conn.authType} connection, NOT a sign-in: the OAuth half of phase 4 is not proven by this run`}`);
  const workspaceId = conn.workspaceId;
  if (conn.authType === "OAUTH2") ok(conn.fieldNames.includes("access_token") && !conn.fieldNames.some((f) => /client_secret/.test(f)), "the connection holds a token and no client secret", conn.fieldNames);
  const tested = await pluginService.testConnection(workspaceId, conn.id, ACTOR);
  ok(tested.checked && tested.valid, `GitHub accepts it: "${tested.connection.lastTestMessage}"`);

  // ── switch on three actions through it ──
  await pluginService.setActions(workspaceId, PIECE, { connectionId: conn.id, actions: ["create_issue_ai", "list_repository_issues", "get_authenticated_user"] }, ACTOR);
  const tools = (await toolRepo.listByWorkspace(workspaceId)).filter((t) => t.url?.startsWith(`plugin://${PIECE}@`) && t.isActive !== false);
  ok(["github_create_issue_ai", "github_list_repository_issues"].every((n) => tools.some((t) => t.name === n)), "create and list are tools of this workspace", tools.map((t) => t.name));

  const title = `Foundry connector test ${new Date().toISOString()}`;
  let before: string[];
  try {
    before = await issueTitles(workspaceId);
  } catch (e) {
    ok(false, `the test repository ${OWNER}/${REPO} can be read`, (e as Error).message);
    process.exit(1);
  }
  ok(!before.includes(title), `read the repository directly: ${before.length} issue(s), none with this title`);

  const prior = (await flowRepo.listByWorkspace(workspaceId)).find((f) => f.name === FLOW);
  const saved = await piFlowService.save({
    workspaceId,
    flowId: prior?.id ?? null,
    bundle: bundle(title),
    name: FLOW,
    description: "Opens an issue in a throwaway GitHub repository and lists the open issues.",
    author: { createdBy: "plugins-github", createdByKind: "system" },
  });

  // ── 1. TEST run: nothing on GitHub changes ──
  console.log("\n1  test run (draft)");
  const draft = await flowRunnerService.startDraftRun({ workspaceId, flowId: saved.flowId, bundle: bundle(title), inputs: { title }, requester: REQUESTER });
  const d = await flowRunnerService.waitForRun(draft.flowExecutionId, 180_000);
  console.log(`    ${d.status}: ${d.steps.map((s) => `${s.stepId}=${s.status}`).join(" ")}`);
  ok(d.status === "succeeded", `the test run succeeds (${d.status})`, d.steps.filter((s) => s.status !== "succeeded").map((s) => s.error));
  const cap = out(d.steps, "open_issue")?.raw as Record<string, unknown> | undefined;
  ok(cap?.captured === true && JSON.stringify(cap).includes(title), "creating the issue came back CAPTURED, naming the title", cap);
  ok(!(await issueTitles(workspaceId)).includes(title), "…and GitHub has NO such issue");
  ok(Array.isArray(out(d.steps, "list_issues")?.issues), "listing issues (a SEARCH) really ran in the test run", out(d.steps, "list_issues"));

  // ── 2. approve, then a LIVE run: the issue exists ──
  console.log("\n2  approve, then a live run");
  const approved = await flowApprovalService.approve(workspaceId, saved.flowId, {
    revision: saved.revision,
    approverUserId: "plugins-github-approver",
    approverKind: "client_admin",
    note: "connector test",
  } as never);
  ok((approved.flow.armedRevision ?? 0) === saved.revision, `approved (revision ${approved.flow.armedRevision})`);
  const live = await flowRunnerService.startLiveRun({ workspaceId, flowId: saved.flowId, inputs: { title }, requester: REQUESTER });
  const l = await flowRunnerService.waitForRun(live.flowExecutionId, 180_000);
  console.log(`    ${l.status}: ${l.steps.map((s) => `${s.stepId}=${s.status}`).join(" ")}`);
  ok(l.status === "succeeded", `the live run succeeds (${l.status})`, l.steps.filter((s) => s.status !== "succeeded").map((s) => s.error));
  const made = out(l.steps, "open_issue")?.raw as Record<string, unknown> | undefined;
  ok(made && !made.captured && (made.number || made.html_url || made.id), "the issue was CREATED (GitHub's own answer)", made && { number: made.number, url: made.html_url });
  // ⚠ GitHub's issue list trails a create by a moment (measured 2026-10-28: the list step, run straight after, saw
  // none). So the direct read waits up to 15 s, and the in-flow list is reported, not asserted — its timing is
  // GitHub's, not Foundry's.
  let after: string[] = [];
  for (let i = 0; i < 15; i++) {
    after = await issueTitles(workspaceId);
    if (after.includes(title)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok(after.filter((t) => t === title).length === 1, "…and GitHub has exactly one issue with this title");
  const listed = out(l.steps, "list_issues")?.issues as Array<{ title: string }> | undefined;
  console.log(`  note the flow's own list step, run straight after the create, ${listed?.some((i) => i.title === title) ? "already saw it" : "did not see it yet (GitHub's list lags a create)"}`);

  await flowApprovalService.revoke(workspaceId, saved.flowId, { revokedBy: "plugins-github", reason: "connector test finished" } as never).catch((e) => console.log(`  (revoke: ${(e as Error).message})`));
  console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
