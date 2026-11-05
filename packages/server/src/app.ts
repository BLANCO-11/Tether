import express from "express";
import { healthRouter } from "./routes/health.js";
import { signalsRouter } from "./routes/signals.js";
import { platformObservabilityRouter, workspaceObservabilityRouter } from "./routes/observability.js";
import { enginePluginsRouter } from "./routes/engine-plugins.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { workspaceSecretsRouter } from "./routes/workspace-secrets.js";
import { credentialsRouter } from "./routes/credentials.js";
import { toolsRouter } from "./routes/tools.js";
import { pluginPlatformRouter, pluginWorkspaceRouter } from "./routes/plugins.js";
import { datasourcesRouter } from "./routes/datasources.js";
import { workspaceFilesRouter } from "./routes/workspace-files.js";
import { flowTriggersRouter, webhookRouter, apiTriggerRouter } from "./routes/triggers.js";
import { flowsRouter } from "./routes/flows.js";
import { flowChatRouter } from "./routes/flow-chat.js";
import { piBuilderRouter } from "./routes/pi-builder.js";
import { forgeToolsRouter } from "./routes/forge-tools.js";
import { approvalsRouter } from "./routes/approvals.js";
import { membersRouter } from "./routes/members.js";
import { rolesRouter } from "./routes/roles.js";
import { platformRolesRouter } from "./routes/platform-roles.js";
import { permissionsRouter } from "./routes/permissions.js";
import { memberCapabilitiesRouter } from "./routes/member-capabilities.js";
import { budgetsRouter } from "./routes/budgets.js";
import { localUsersRouter, localAuthRouter } from "./routes/local-users.js";
import { platformRouter } from "./routes/platform.js";
import { meRouter } from "./routes/me.js";
import { reportsRouter } from "./routes/reports.js";
import { invitationsRouter } from "./routes/invitations.js";
import { stepApprovalsRouter } from "./routes/step-approvals.js";
import { generationProviderRouter } from "./routes/generation-provider.js";
import { oracleRouter } from "./routes/oracle.js";
import { stepsRouter } from "./routes/steps.js";
import { executionsRouter } from "./routes/executions.js";
import { flowExecutionsRouter } from "./routes/flow-executions.js";
import { flowTemplatesRouter, fragmentCandidatesRouter } from "./routes/flow-templates.js";
import { flowPositionsRouter } from "./routes/flow-positions.js";
import { flowFlagsRouter } from "./routes/flow-flags.js";
import { flowPhasesRouter } from "./routes/flow-phases.js";
import { approvalRequestsRouter } from "./routes/approval-requests.js";
import { auditEventsRouter } from "./routes/audit-events.js";
import { catalogueRouter, catalogueAccessRequestsRouter } from "./routes/catalogue.js";
import { stepTryRouter } from "./routes/step-try.js";
import { mailRouter } from "./routes/mail.js";
import { requireWebKey, webRouter } from "./routes/web.js";
import { llmCompleteRouter, requireLlmKey, runtimeModelRouter } from "./routes/runtime-model.js";
import { incidentsRouter } from "./routes/incidents.js";
import { breakGlassRouter } from "./routes/break-glass.js";
import { releaseGatesRouter } from "./routes/release-gates.js";
import { reviewedTemplatesRouter } from "./routes/reviewed-templates.js";
import { resourcesRouter } from "./routes/resources.js";
import { emailBoxRouter } from "./routes/email-box.js";
import { pinsRouter } from "./routes/pins.js";
import { notificationsRouter } from "./routes/notifications.js";
import { projectsRouter } from "./routes/projects.js";
import { nextFiresRouter } from "./routes/next-fires.js";
import { searchRouter } from "./routes/search.js";
import { bootstrapRouter } from "./routes/bootstrap.js";
import { flowScenariosRouter } from "./routes/flow-scenarios.js";
import { attendanceRouter } from "./routes/attendance.js";
import { requireApiKey } from "./middleware/auth.middleware.js";
import { resolveIdentity } from "./middleware/identity.middleware.js";
import { usageContextMiddleware } from "./services/usage-context.js";
import { requireStepToken } from "./middleware/step-token.middleware.js";
import { stepFilesRouter } from "./routes/step-files.js";
import { requireMailKey } from "./middleware/mail-key.middleware.js";
import { errorHandler } from "./middleware/error.middleware.js";
import { wrapAsyncRoutes } from "./middleware/async-routes.js";
import { mountPermissionGuards } from "./middleware/mount-permission-guards.js";
import { recordMountPaths } from "./auth/express-mount.js";
import { express4Defaults } from "./middleware/express4-defaults.js";
import { requestId } from "./middleware/request-id.middleware.js";
import { callbackBodyLimit } from "./middleware/callback-body-limit.middleware.js";
import { config } from "./config/index.js";

export function createApp() {
  const app = express();
  // ⚠ Before the first `app.use`: the permission splice finds each route by its full path, and Express 5 keeps no
  // mount path on a layer — see `auth/express-mount.ts`.
  recordMountPaths(app);
  // Express 5 changed two defaults every route here was written against; keep the Express 4 ones.
  express4Defaults(app);

  /**
   * Every response is diagnosable against a server log line by this id.
   *
   * ⚠ **Mounted FIRST, and until step-payload-bounds it was not.** The comment
   * here used to claim *"mounted first, before anything that could
   * short-circuit"* while sitting directly BELOW `express.json`, which is
   * precisely a thing that short-circuits: body-parser's 413 answers without ever
   * reaching a route, so the one failure most likely to need correlating to a log
   * line was the one that could not be. Execution `05aca859-…` is the proof — its
   * 413 body carried no id at all (spec D2).
   *
   * The parsers now come after, per-mount, so this ordering is what makes the
   * claim true rather than a comment asserting it.
   */
  app.use(requestId);

  /**
   * ⚠ **THE ORDER INSIDE THESE TWO MOUNTS IS THE FEATURE** — step-payload-bounds,
   * plan Decision 4. Read as: authenticate → bound the size → parse → route.
   *
   *   1. `requireStepToken` FIRST, so an unauthenticated caller learns **401** and
   *      nothing about our limits. Precedence, not decoration: a 413 to an
   *      anonymous caller is a free probe of the transport bound.
   *   2. `callbackBodyLimit` SECOND — above the parser, which is the only position
   *      from which the refusal can happen before the body is allocated, and the
   *      only one where the size, the limit and the execution still exist to name.
   *   3. `express.json({ limit })` THIRD, at the callback cap rather than the
   *      process-wide 2 MB. This is what stops the transport being the binding
   *      constraint (Decision 1); it is also the backstop for a chunked request,
   *      which sends no `Content-Length` for step 2 to read.
   *
   * ⚠ Both sit ABOVE `resolveIdentity`'s consumers by construction and neither
   * router reads `req.user` — `app.ts` already records why a blanket identity
   * requirement would break Kestra's callbacks and every harness.
   *
   * ⚠ `/api/executions` keeps its mixed per-route auth, so `callbackBodyLimit`
   * runs there with no `req.stepAuth` and the refusal names no execution. That is
   * deliberate: the guard has nothing to name, and the message says "a step
   * callback" instead of "this run" rather than reading an id out of the body it
   * is refusing to parse.
   */
  // A step's saved files: its own size limit, mounted before `/api/steps` so the 5 MB step-call limit never sees them.
  app.use("/api/steps/files", requireStepToken, stepFilesRouter);
  const callbackJson = express.json({ limit: config.steps.callbackMaxBytes });
  app.use(
    "/api/steps",
    requireStepToken,
    callbackBodyLimit(config.steps.callbackMaxBytes),
    callbackJson,
    stepsRouter,
  );
  app.use(
    "/api/executions",
    callbackBodyLimit(config.steps.callbackMaxBytes),
    callbackJson,
    executionsRouter,
  );

  /**
   * The process-wide parser, for everything that is NOT a Kestra callback.
   *
   * ⚠ Mounted HERE rather than at the top, and it stays at 2 MB. Raising this
   * instead would have widened every other route in the process by 2.5× —
   * including the two public receivers — for a reason that applies to neither.
   * The two-limit shape is the point (Decision 1); do not collapse it.
   */
  app.use(express.json({ limit: "2mb" }));

  // Permissive CORS for the local Next.js client (Sprint 1 dev).
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
    res.header(
      "Access-Control-Allow-Headers",
      "content-type,x-api-key,authorization,x-foundry-identity",
    );
    res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).send();
    next();
  });

  // Who is asking — Stage 9.1. Resolved for EVERY route and required by none of
  // them here; `requireIdentity` is applied per route, on the ones that record a
  // person. A blanket requirement would break Kestra's step callbacks and every
  // harness, which hold the API key and no session. See identity.middleware.ts.
  //
  // Mounted above the routers and below CORS, so a preflight never has to carry
  // a token.
  app.use(resolveIdentity);
  // Who and which workspace a request is for, for usage recorded deep inside it (P-OBS).
  app.use(usageContextMiddleware);

  // Health endpoints are open (used by probes and the dashboard status pill).
  app.use("/api", healthRouter);

  // Public webhook receiver (unauthenticated by design — token in the URL).
  app.use("/api/triggers", webhookRouter);
  // Phase 6 — public programmatic receiver. Same no-API-key rule as the
  // webhook one: the token is in the URL, and the api receiver additionally
  // requires the trigger's workspace credential (kind `api`) as a Bearer
  // token, checked through the credential-provider seam.
  app.use("/api/triggers", apiTriggerRouter);
  // `/api/stubs` (the dummy-tool template server) was mounted here and is deleted.
  // It served `tools.dummy_response_template` interpolated with request fields, so a
  // tool built on it returned one fixed shape however it was called. Nothing ever
  // created such a tool — every registered tool runs real SQL.
  //
  // `/stub-api` was mounted here and is GONE — not renamed, moved. The fourteen
  // HR/mail/chat/ticketing endpoints are `packages/ops-api` on :4004 now, with
  // their own database, their own least-privilege role and authentication on
  // every route. Mounting them here meant a tool call terminated in the process
  // holding PARENT_API_KEY and CREDENTIAL_ENC_KEY, on a
  // connection to the database holding `workspace_secrets`. Do not re-add a
  // tool endpoint to this app; a tool that runs in the control plane is not a
  // tool, it is a privileged internal function with a URL.

  // "Is the system still doing its job?" (GAPS §6.1). Deliberately NOT on the
  // open health router: it names workspaces and flows, which is a description of
  // the customer base. See routes/signals.ts.
  //
  // ⚠ Mounted at its EXACT path, never `app.use("/api", requireApiKey, …)`.
  // That form attaches `requireApiKey` to every `/api/*` request that reaches
  // this line, not just this router's routes — which silently put the Kestra
  // callbacks (`/api/steps/*`, `/api/executions/begin`, authenticated by the
  // execution token and the callback secret, deliberately NOT by the parent key)
  // behind the parent API key. Every flow then failed at `begin` with a 401 and
  // no `flow_executions` row was ever written. See ISSUES.md I-65.
  app.use("/api/signals", requireApiKey, signalsRouter);
  app.use("/api/observability", requireApiKey, platformObservabilityRouter);

  // What the execution engine can do, read from the engine. ⚠ NOT under
  // `/workspaces/:ws`: plugins are a property of the engine's BUILD, not of a
  // tenant, and Kestra has no tenant-scoped plugin endpoint (`/api/v1/main/
  // plugins` is a 404). A workspace-scoped URL would state a per-workspace
  // registry that does not exist. See routes/engine-plugins.ts and D-111.
  app.use("/api/engine", requireApiKey, enginePluginsRouter);

  // The one model connection (gateway, key, enabled models, default) for workflows, the builder and Forge — AI models →
  // Models. It lived in ops-api behind `/api/ops/llm/*` until 2026-10-30.
  app.use("/api/runtime-model", requireApiKey, runtimeModelRouter);

  // Model pricing (2026-11-04: the model routes moved to `/api/runtime-model` above). Deployment-wide, so not under
  // `/workspaces/:ws`; its writes are gated by `requirePlatformPermission("platform.generation.write")`.
  app.use("/api/generation", requireApiKey, generationProviderRouter);

  // The correctness oracle. A TEST surface: it computes the right answer from
  // the dataset definition, independently of any flow. Nothing in the product
  // may call it — see routes/oracle.ts.
  app.use("/api/test-oracle", requireApiKey, oracleRouter);

  // REAL email delivery — the `foundry_email_send` tool's endpoint.
  //
  // ⚠ At its EXACT path, never `app.use("/api", requireMailKey, …)`. See the
  // warning on `/api/signals` above: that form attaches the gate to every
  // `/api/*` request reaching this line, and here it would put the Kestra
  // callbacks behind a mail key they do not hold.
  //
  // ⚠ Gated by `requireMailKey`, NOT `requireApiKey`, and mounted OUTSIDE the
  // parent-API-key block for that reason. The step executor calls this like any
  // other tool, so whatever credential it presents is stored in
  // `workspace_secrets` and rides along on every email step in every flow —
  // `PARENT_API_KEY` must never be that credential (plan.md Decision 5). The
  // mail key is derived from it but is not it, and buys this one route.
  app.use("/api/mail", requireMailKey, mailRouter);

  // `web_fetch` (2026-10-30): the same shape as the mail route — its own derived key, outside the parent-API-key block,
  // the workspace read from the run named by `x-foundry-run`.
  app.use("/api/web", requireWebKey, webRouter);
  // `llm_complete` (2026-10-30, was ops-api's `/llm/complete`): the same shape again — its own derived key.
  app.use("/api/llm", requireLlmKey, llmCompleteRouter);

  // ── Kestra callbacks ──────────────────────────────────────────────────────
  // Mounted BEFORE the parent-API-key block and deliberately outside it.
  //
  // /api/steps/* is guarded by requireStepToken and nothing else: tenancy is
  // resolved FROM the execution token (R3), so the global parent API key — which
  // names no tenant — must not authenticate here however privileged it is.
  //
  // /api/executions has mixed auth and applies it per route: `begin` uses the one
  // secret Kestra holds (R2), because it is the call that MINTS the token;
  // everything after uses the token itself.
  // ── Kestra callbacks: MOUNTED NEAR THE TOP OF createApp ───────────────────
  //
  // ⚠ They used to be here, and step-payload-bounds moved them ABOVE the
  // process-wide parser (plan Decision 4) — a parser mounted above them refuses
  // an 8 MB callback before their own, larger, limit is ever consulted, which is
  // the whole defect. Nothing about their AUTH changed: `/api/steps/*` is still
  // `requireStepToken` and nothing else, and `/api/executions` still applies its
  // mixed auth per route. See the block at the top of this function.


  // Everything else requires the parent API key.
  app.use(
    "/api/workspaces/:workspaceId/flow-executions",
    requireApiKey,
    flowExecutionsRouter,
  );
  // Every trigger binds to a FLOW. The script-bound mount was removed with
  // `scripts` in Phase 4 (task 4.11), and `triggerService` no longer has a
  // script branch at all — so "a timer can only fire an approved revision"
  // holds because there is no second backend left that could fire anything.
  app.use(
    "/api/workspaces/:workspaceId/flows/:flowId/triggers",
    requireApiKey,
    flowTriggersRouter,
  );
  // Workspace membership and roles (GAPS §1.1) — what makes the two approval
  // routers below refuse somebody who has not been granted the role, rather than
  // only refusing self-approval. Workspace-scoped with no cross-workspace
  // listing, for the same reason templates have none (D-27): a membership list
  // is a list of the people who work on one tenant's automations.
  // Deployment-level, so no `:workspaceId`. Both are behind the API key like
  // everything else; `/api/me` additionally requires an identity (it answers a
  // question about a person) and `/api/platform` additionally requires a super
  // admin (it spans tenants). See their route files.
  app.use("/api/me", requireApiKey, meRouter);
  // The cost report spans workspaces: identity-only in the route map, `reports.read` checked per workspace inside.
  app.use("/api/reports", requireApiKey, reportsRouter);
  // Admin simplify phase 2: invite by email with workspaces + roles chosen in advance. Checked per workspace inside.
  app.use("/api/invitations", requireApiKey, invitationsRouter);
  app.use("/api/platform", requireApiKey, platformRouter);
  /**
   * Connectors (plans/plugins-2026-10-27). Installing is deployment-wide (`platform.plugins.install`); connecting a
   * service and choosing its actions is per workspace (`plugins.enable`). Guards are spliced from the route map.
   */
  app.use("/api/plugins", requireApiKey, pluginPlatformRouter);
  app.use("/api/workspaces/:workspaceId/plugins", requireApiKey, pluginWorkspaceRouter);
  /**
   * The platform TIER — roles above a workspace. Mounted beside the existing
   * `/api/platform/users` rather than on its own prefix, because "the platform" is
   * one surface and a second prefix would be a second place to look.
   */
  app.use("/api/platform", requireApiKey, platformRolesRouter);
  app.use("/api/permissions", requireApiKey, permissionsRouter);
  /**
   * ⚠ **TWO MOUNTS, AND THE SPLIT IS DELIBERATE AND VISIBLE FROM HERE.**
   * `/api/local-users` is the admin surface and is behind `requireSuperAdmin`
   * inside its own router, beside every other membership write.
   * `/api/local-auth` is the SIGN-IN check — it answers before anybody has a
   * session, because it is what mints one, so it has only the API key and
   * carries its own throttle. Mounting the second under the first would put a
   * password-taking route inside a path a reader assumes is super-admin-gated.
   */
  app.use("/api/local-users", requireApiKey, localUsersRouter);
  app.use("/api/local-auth", requireApiKey, localAuthRouter);
  app.use("/api/workspaces/:workspaceId/members", requireApiKey, membersRouter);
  /**
   * Custom workspace roles. ⚠ The per-route permission guards are SPLICED from
   * `auth/route-permissions.ts` at the bottom of this function, not written on the
   * router — one declaration, checked by `route-permissions.test.ts`.
   */
  app.use("/api/workspaces/:workspaceId/roles", requireApiKey, rolesRouter);
  app.use("/api/workspaces/:workspaceId/member-capabilities", requireApiKey, memberCapabilitiesRouter);
  app.use("/api/workspaces/:workspaceId/budget", requireApiKey, budgetsRouter);
  app.use("/api/workspaces/:workspaceId/observability", requireApiKey, workspaceObservabilityRouter);

  // The only client-reachable path that writes to the LIVE Kestra namespace.
  app.use(
    "/api/workspaces/:workspaceId/flows/:flowId/approvals",
    requireApiKey,
    approvalsRouter,
  );
  // Gate 3 — a human decision on ONE execution, mid-flight. Distinct from the
  // route above in both subject and effect: that one approves a REVISION to run
  // unattended and deploys a Kestra Schedule; this one un-pauses (or kills) a run
  // that is already going, and never touches a namespace.
  app.use(
    "/api/workspaces/:workspaceId/step-approvals",
    requireApiKey,
    stepApprovalsRouter,
  );
  // Phase 6. Both are workspace-scoped with no cross-workspace listing — a
  // template carries ref names and contracts written against one tenant's data,
  // and a promotion candidate quotes those contracts verbatim.
  app.use("/api/workspaces/:workspaceId/flow-templates", requireApiKey, flowTemplatesRouter);
  app.use("/api/workspaces/:workspaceId/fragment-candidates", requireApiKey, fragmentCandidatesRouter);
  app.use("/api/workspaces/:workspaceId/flows", requireApiKey, flowsRouter);
  // Step positions (Phase 2, plan decision ② / D-150) — the DAG arrangement
  // mirror, OUTSIDE the revision. Mounted INSIDE `/flows` because positions are
  // a property of a flow, and neither handler touches `flow_revisions`: reads
  // return rows, writes replace the set. A drag must never create a revision.
  app.use(
    "/api/workspaces/:workspaceId/flows/:flowId/positions",
    requireApiKey,
    flowPositionsRouter,
  );
  // B-12 · Builder flags the readiness sheet resolves (S-10, S-13, law 6).
  app.use(
    "/api/workspaces/:workspaceId/flows/:flowId/flags",
    requireApiKey,
    flowFlagsRouter,
  );
  // B-11 · flow_phases — background frames for builder canvas (S-07).
  app.use(
    "/api/workspaces/:workspaceId/flows/:flowId/phases",
    requireApiKey,
    flowPhasesRouter,
  );
  // B-14 · Approvals inbox — unified queue (six types).
  app.use(
    "/api/workspaces/:workspaceId/approval-requests",
    requireApiKey,
    approvalRequestsRouter,
  );
  // B-15 · Audit explorer — immutable record (S-68).
  app.use("/api/workspaces/:workspaceId/audit-events", requireApiKey, auditEventsRouter);
  // B-16 · S-58/S-59/S-60 Break-glass & incidents — incidents, break_glass_sessions (Phase 14).
  // Mounted beside /approval-requests and /audit-events — all are workspace-scoped
  // reads over a single tenant's data, no cross-workspace listing (same reason
  // templates and members have none). Break-glass POST requires admin + real-data.
  app.use("/api/workspaces/:workspaceId/break-glass", requireApiKey, breakGlassRouter);
  app.use("/api/workspaces/:workspaceId/incidents", requireApiKey, incidentsRouter);
  // B-19 · S-24 Publish review gates — workspace default + per-flow override (Phase 07).
  // Workspace-scoped: every read filters WHERE workspace_id = ?. Disabled gates
  // still returned with enabled:false so UI can render "not enforced" rather than hiding;
  // satisfiedBy quoted verbatim when blocked (AC-07-5).
  app.use("/api/workspaces/:workspaceId/release-gates", requireApiKey, releaseGatesRouter);
  app.use("/api/workspaces/:workspaceId/flows/:flowId/release-gates", requireApiKey, releaseGatesRouter);
  // B-08 reviewed_templates + B-09 chips most-used derived.
  // Platform level, no workspace scoping — the 34 reviewed templates are the
  // platform catalogue; workspace copies stay in flow_templates (existing).
  // requireIdentity on every read, same as /api/me and /api/platform.
  // GET /api/templates?limit=3&kind=curated|mostUsed + ?q= + /:slug
  // GET /api/templates/suggestions?limit=4 reuses mostUsed 4 — S-01+S-03 share
  // one PromptComposer component when wired later.
  app.use("/api/templates", requireApiKey, reviewedTemplatesRouter);
  // Chat mode (Phase 2.8). Mounted BESIDE `/flows` rather than inside it, for the
  // same reason `/catalogue` is: under `/flows` the `/:flowId` route would
  // resolve "flow-chat" as a flow id. A thread is also not a flow — D-120, the
  // flow row appears at the first applied turn and never before.
  app.use("/api/workspaces/:workspaceId/flow-chat", requireApiKey, flowChatRouter);
  // Pi agent sandbox builder (hard-cut chat path). Sibling of flow-chat so :flowId never swallows it.
  // Forge's own tools (assistant mode's data reads): a per-conversation key, not the API key — see forge-tools.ts.
  app.use("/api/forge", forgeToolsRouter);
  app.use("/api/workspaces/:workspaceId/pi-builder", requireApiKey, piBuilderRouter);
  // Stage 5. Read-only, and mounted beside `/flows` rather than inside it —
  // under `/flows` the `/:flowId` route would resolve it as a flow named
  // "catalogue".
  app.use("/api/workspaces/:workspaceId/catalogue", requireApiKey, catalogueRouter);
  /**
   * T9 · try ONE component. Deliberately a sibling of `catalogue`, which is what
   * the builder reads to know a component's parameters, rather than of `flows` —
   * a try needs no flow and writes to none.
   */
  app.use("/api/workspaces/:workspaceId/steps", requireApiKey, stepTryRouter);

  // B-10 · S-04 access-requests literal path POST /workspaces/:ws/access-requests (ACC-) — same service as catalogue, mounted here for spec verbatim.
  app.use("/api/workspaces/:workspaceId/access-requests", requireApiKey, catalogueAccessRequestsRouter);
  app.use("/api/workspaces/:workspaceId/secrets", requireApiKey, workspaceSecretsRouter);
  // Phase 5 — the unified credential list over the secret/datasource/trigger
  // stores. Beside `/secrets` (which stays the secrets surface); this is the
  // read-mostly seam the Credentials page renders, and the only writes it
  // accepts are secret-backed kinds.
  app.use("/api/workspaces/:workspaceId/credentials", requireApiKey, credentialsRouter);
  app.use("/api/workspaces/:workspaceId/datasources", requireApiKey, datasourcesRouter);
  app.use("/api/workspaces/:workspaceId/files", requireApiKey, workspaceFilesRouter);
  app.use("/api/workspaces/:workspaceId/tools", requireApiKey, toolsRouter);
  // B-13 · S-48 Resource list — union of datasources+tools with ResourceCategory/status/owner/health/dependents
  app.use("/api/workspaces/:workspaceId/resources", requireApiKey, resourcesRouter);
  // The Email box — what an automation tried to email, and what was HELD
  // because the run was a draft. `requireApiKey` like every other tenant read.
  app.use("/api/workspaces/:workspaceId/email-box", requireApiKey, emailBoxRouter);
  // B-02 pins per-person oid — GET /workspaces/:ws/pins + POST /workspaces/:ws/pins/:flowId/toggle
  app.use("/api/workspaces/:workspaceId/pins", requireApiKey, pinsRouter);
  // Sharing boundaries: the signed-in person's own notices (an Admin opened your private work).
  app.use("/api/workspaces/:workspaceId/notifications", requireApiKey, notificationsRouter);
  app.use("/api/workspaces/:workspaceId/projects", requireApiKey, projectsRouter);
  // B-01 next-fire armed only 30d + overflow — GET /workspaces/:ws/next-fires?limit=4&window=30d honouring armed only D-18, derived in Foundry
  app.use("/api/workspaces/:workspaceId/next-fires", requireApiKey, nextFiresRouter);
  // B-30 search index 6 kinds workspace-scoped replacing STATIC_SEARCH_INDEX — GET /workspaces/:ws/search?q=
  app.use("/api/workspaces/:workspaceId/search", requireApiKey, searchRouter);
  // B-04 bootstrap 34 templates ready — GET /workspaces/:ws/bootstrap honest
  app.use("/api/workspaces/:workspaceId/bootstrap", requireApiKey, bootstrapRouter);
  // B-18 · flow_test_scenarios — S-20 Test scenario picker (5 equal radio Saved/Edge/AI/Manual/Real).
  // Mock-only: saved|edge-case|ai-generated|manual — real is namespace D-52, never a fixture.
  // Workspace-scoped, verified via flowRepo.get before listing; author role required.
  app.use("/api/workspaces/:workspaceId/flows/:flowId/scenarios", requireApiKey, flowScenariosRouter);
  // B-17 · S-42 My attendance status — per-employee aggregation (consumer, 02:00 IST).
  // Workspace-scoped per-person: subject derived from req.user.subject, never query param.
  // GET /workspaces/:ws/me/attendance?period=2026-07 and /workspaces/:ws/me/exceptions?period=
  app.use("/api/workspaces/:workspaceId/me", requireApiKey, attendanceRouter);
  app.use("/api/workspaces", requireApiKey, workspacesRouter);
  app.use(errorHandler);

  /**
   * ── ⚠ LAST, AND AFTER `errorHandler` ON PURPOSE ───────────────────────────
   *
   * `wrapAsyncRoutes` makes a rejected promise from any route handler call
   * `next(err)` instead of terminating the process — see that module's header
   * for the outage this closes. It walks what is mounted, so it must run once
   * everything is mounted; `errorHandler` is the destination those rejections
   * are being routed to, and is skipped by arity.
   *
   * ⚠ The count is not decoration. A walk that wrapped nothing would leave the
   * product exactly as broken while reading as fixed, so it is logged at boot
   * and `async-routes.test.ts` asserts a floor on it.
   */
  /**
   * ── ⚠ THE PERMISSION GUARD, AND IT MUST RUN BEFORE `wrapAsyncRoutes` ───────
   *
   * Every workspace-scoped route declares a permission in
   * `auth/route-permissions.ts`; this walks what is mounted and puts that route's
   * guard in front of its handlers. Before this existed, **106 of the 142
   * workspace-scoped routes carried no authorisation check at all** — anyone who
   * could sign in could delete another tenant's automations.
   *
   * ⚠ It runs BEFORE `wrapAsyncRoutes` so the guards it splices are themselves
   * wrapped: a guard is an async handler that reads the database, and an
   * unwrapped rejection in one would terminate the process (see that module's
   * header for the outage that caused).
   *
   * ⚠ **NEVER replace this with `app.use("/api", guard)`.** That attaches to
   * every `/api/*` request reaching the line and silently puts the Kestra step
   * callbacks behind the parent key, after which every flow dies at `begin`
   * with no `flow_executions` row (I-65).
   *
   * ⚠ The count is not decoration. A walk that guarded nothing would leave those
   * 106 routes exactly as open while the boot log read as if they were closed,
   * so it is logged here and `route-permissions.test.ts` asserts a floor on it.
   */
  const guarded = mountPermissionGuards(app);
  console.log(`[server] permission guard active on ${guarded} workspace-scoped routes`);

  const wrapped = wrapAsyncRoutes(app);
  console.log(`[server] async route guard active on ${wrapped} handlers`);
  return app;
}
