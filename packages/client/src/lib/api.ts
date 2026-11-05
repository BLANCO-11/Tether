// src/lib/api.ts — the ONE place the UI talks to the backend.
//
// Every function here reaches `packages/server` through the same-origin proxy in
// `foundry-client.ts` (which injects PARENT_API_KEY server-side) and maps shapes
// via `adapters.ts`. There is no other data source.
// This file used to be half a product and half a lie. 66 of its 71 exported
// functions read or wrote `lib/mockdb.ts`, a localStorage-backed database seeded
// from `src/mocks/data.ts` — fabricated apps, API keys, employees, runs,
// automations, organizations and members. `/apps`, `/keys`, `/organization` and
// `/virtual-tables` were served entirely from the browser.
//
// The worst of it was not the mock; it was `faFallback(real, mock)`:
//
//     try { return await real() } catch { console.warn(…); return mock() }
//
// Ten call sites, including tools, triggers, datasources, run history and
// `whoami`. **Any** server error — a 500, a 404 from a deleted route, an expired
// session, a stopped container — was swallowed and answered with plausible
// fabricated rows, leaving a `console.warn` as the only trace. A demo could not
// distinguish the product from a browser cache, and neither could a developer:
// deleting a route did not break a page, it silently changed where the page got
// its data.
//
// That is the exact failure this codebase names everywhere else — a runtime's
// `llmConnected:true` false green, `generation-audit` marking `clean` a script
// that emailed 0 of 11 people, "an enabled trigger means it ran once, not
// correctly". A product whose thesis is "a silent wrong answer is the expensive
// failure" cannot ship its own.
//
// **So: a failed call now throws.** Pages render an error state. If you are
// looking at a row, a server produced it. Do not reintroduce a fallback.
//
// The connector catalogue moved to `lib/connectors.ts` — form schemas for
// assembling a DSN, which is static knowledge rather than tenant state. Read the
// header there before assuming it was an oversight.

import type { AccessPolicy } from "@foundry/shared/rules";
import { startOfDay } from "@/lib/stats";
import { foundryApi, resolveWorkspaceId, FoundryApiError } from "@/lib/foundry-client";
import type { MovableItem } from "@/lib/foundry-client";
import type { FDAuditEvent } from "@/lib/audit";
import type {
  FANotification,
  FADatasourceOperation,
  FADbOperationInput,
  FADbOperationSpec,
  FADbOperationCheck,
  FAOperationProposalResult,
  FAChatThread,
  FAChatTurn,
  FAStepApproval,
  FAFlowCatalogue,
  FAManifestWarnings,
  FAEmailSend,
  FARunCall,
  FAIncidentSeverity,
  FAIncidentStatus,
  FAIncident,
  FABreakGlassSession,
  FAReleaseGate,
  FAMemberCapability,
  FAWorkspaceRoleMember,
  FABudget,
} from "@/lib/foundry-client";
import { CONNECTORS, isFileConnector } from "@/lib/connectors";
import { UNRESOLVED_WORKSPACE } from "@/lib/workspace-choice";

export type {
  FAChatThread,
  FAChatTurn,
  FAManifestWarnings,
  FAEmailSend,
} from "@/lib/foundry-client";
// The reopen adapter (I-130). Through the local shim like every other call site
// in this package — see `lib/flow-authoring.ts` for why that file still exists.
import { authoredFromModel } from "@/lib/flow-authoring";
import type { AuthoredFlow, StoredContract, StoredFlow } from "@/lib/flow-authoring";
import {
  toolFromFA, toolInputToFA, connectionFromFA, assembleConnectionString, schemaEntitiesToAssetTree,
  triggerFromFA, triggerFireFromFA,
  flowExecutionSummaryFromFA, flowExecutionDetailFromFA, runFromFlowExecution, flowFromFA,
  runLabel, stepRunFromFA,
} from "@/lib/adapters";
import type { LocalUser, LocalUserAccess, Run, Tool, Trigger, TriggerFire, Workspace, ConnectorManifest, Connection, AssetNode, WorkspaceSecret, SecretAudit, SecretImpact, SecretRename, EnginePlugins, PluginCredentials, CredentialView, CredentialKind, FlowExecutionSummary, FlowExecutionDetail, FlowSummary, FlowRevisionSummary, FlowVersion, FlowDiff, FlowExpectation, SignalsReport, SignalState, FlowStepReview, FlowInputFormat, ComputedInputFn, WorkspaceMember, WorkspaceRole, WorkspaceRoleSummary, Me, PlatformUser, ToolProbe, ToolProbeDraft, ToolProbeMode, EmailBox, FiringOutcome, ConnectorMarketplace, WorkspaceConnector, ConnectionTestResult, ConnectorInstall, ConnectorOauthApp } from "@/lib/types";

// ---- Tools ------------------------------------------------------------------

export async function listTools(): Promise<Tool[]> {
  return (await foundryApi.listTools(await resolveWorkspaceId())).map(toolFromFA);
}

/**
 * One input shape for create and update, because there is one body builder.
 *
 * ⚠ `updateTool` used to hand-roll its own whitelist — `{name, description, url,
 * method}` derived from `patch.type`, and nothing else. It therefore dropped
 * `paramsSchema`, `secretEnvName`, `authStyle` and `authParamName` on every
 * save, so the tool edit form was a screen where four fields could be typed, a
 * success toast appeared, and the server was never told (foundations Phase 1.2,
 * I-124). A second body builder is how that happened; there is now one, and
 * `toolInputToFA` is it — including the cross-field credential rules, which the
 * whitelist could not have enforced because it never saw the credential.
 */
export type ToolInput = Pick<Tool, "name"> &
  Partial<
    Pick<
      Tool,
      "description" | "app" | "type" | "endpoint" | "method" | "params"
      | "secretEnvName" | "authStyle" | "authParamName"
      // Phase 7 — the oauth2_client_credentials fields. Same nullable
      // vocabulary as the rest: omitted on a PATCH leaves the stored value.
      | "tokenUrl" | "clientIdSecretRef" | "clientSecretSecretRef"
    >
  >;

export async function createTool(input: ToolInput): Promise<Tool> {
  const ws = await resolveWorkspaceId();
  return toolFromFA(await foundryApi.createTool(ws, toolInputToFA(input).body));
}

export async function updateTool(id: string, input: ToolInput): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.updateTool(ws, id, toolInputToFA(input).body);
}

export async function deleteTool(id: string): Promise<void> {
  await foundryApi.deleteTool(await resolveWorkspaceId(), id);
}

/**
 * Probe a saved tool, or the draft currently in the form.
 *
 * ⚠ **No `catch`, no fallback, no default probe object** — the `faFallback` rule.
 * A probe that fails to run must surface as a thrown error the panel renders as an
 * error; a caught failure returning `{ verdict: "unreachable" }` would be Foundry
 * inventing a statement about someone's endpoint. The server already distinguishes
 * the two cases by status code, and swallowing that here would throw the
 * distinction away at the last possible moment.
 */
export async function probeTool(input: {
  toolId?: string;
  draft?: ToolProbeDraft;
  mode?: ToolProbeMode;
  sampleParams?: Record<string, unknown>;
}): Promise<ToolProbe> {
  const ws = await resolveWorkspaceId();
  return foundryApi.probeTool(ws, input as unknown as Record<string, unknown>);
}

// ---- Triggers (nested under a FLOW) -----------------------------------------
//
// A trigger MUST bind to a flow. There is no unbound-trigger path: the old
// version fell back to a local draft when the workspace had no flow, which is how
// a trigger ended up attached to whatever happened to be generated last — and to
// a row no server knew about.
//
// `type: "schedule"` is refused by the server on purpose (D-18): a flow's cron
// lives on its MODEL and is armed by approving a revision, so a second timer path
// would fire behaviour no approval covers.

const triggerFlowIndex = new Map<string, string>();

async function loadTriggers(): Promise<Trigger[]> {
  const ws = await resolveWorkspaceId();
  triggerFlowIndex.clear();
  const out: Trigger[] = [];
  for (const f of await foundryApi.listFlows(ws)) {
    for (const t of await foundryApi.listFlowTriggers(ws, f.id)) {
      triggerFlowIndex.set(t.id, f.id);
      out.push(triggerFromFA(t));
    }
  }
  return out;
}

/** The flow a trigger belongs to. Throws rather than guessing — see above. */
async function flowForTrigger(id: string): Promise<string> {
  if (triggerFlowIndex.has(id)) return triggerFlowIndex.get(id)!;
  await loadTriggers();
  const flowId = triggerFlowIndex.get(id);
  if (!flowId) throw new Error(`trigger ${id} is not bound to any flow in this workspace`);
  return flowId;
}

export async function listTriggers(): Promise<Trigger[]> {
  return loadTriggers();
}

/**
 * Just this flow's triggers — the same per-flow route `loadTriggers()` fans out
 * across every flow for the global /triggers page, scoped to one. Populates
 * `triggerFlowIndex` for the rows it returns, so "Fire now" here resolves
 * without a separate workspace-wide load.
 */
export async function listFlowTriggers(flowId: string): Promise<Trigger[]> {
  const ws = await resolveWorkspaceId();
  const rows = await foundryApi.listFlowTriggers(ws, flowId);
  for (const t of rows) triggerFlowIndex.set(t.id, flowId);
  return rows.map(triggerFromFA);
}

/**
 * Create a trigger bound to a flow.
 *
 * ⚠ It takes the server's own `type`, not a UI icon (`issues.md` I-94). The old
 * signature took one of seven icons and ran them through `iconToAType`, which
 * mapped four of them onto a type that could not do what the icon promised —
 * Email and File upload became webhooks, Kafka and RabbitMQ became `poll`
 * triggers with no url. `lib/trigger-kinds.ts` is now the only source of what
 * may be created, and a test mirrors it against the server's list.
 *
 * ⚠ `config` is passed straight through. It used to be assembled from the
 * card's DISPLAY rows, so the key a value was stored under was whatever the row
 * happened to be labelled — which is how a webhook's address ended up under a
 * key nothing reads.
 */
export async function createTrigger(
  input: {
    name: string;
    type: "manual" | "webhook" | "poll" | "api";
    config?: Record<string, unknown>;
    flowId?: string;
  },
): Promise<Trigger> {
  const ws = await resolveWorkspaceId();
  const flowId = input.flowId ?? (await foundryApi.listFlows(ws))[0]?.id;
  if (!flowId) {
    throw new Error(
      "a trigger must be bound to a flow, and this workspace has none — create a flow first",
    );
  }
  const config = input.config ?? {};
  const t = await foundryApi.createTrigger(ws, flowId, {
    name: input.name,
    type: input.type,
    config,
    // Never armed on creation. The server also defaults this to false, because a
    // client omitting the field used to arm the trigger.
    enabled: false,
  });
  triggerFlowIndex.set(t.id, flowId);
  return triggerFromFA(t);
}

export async function updateTrigger(id: string, patch: Partial<Trigger>): Promise<void> {
  const flowId = await flowForTrigger(id);
  const ws = await resolveWorkspaceId();
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.state !== undefined) body.enabled = patch.state === "Live";
  if (patch.rows !== undefined) {
    const config: Record<string, unknown> = {};
    for (const r of patch.rows) config[r.label] = r.value;
    body.config = config;
  }
  await foundryApi.updateTrigger(ws, flowId, id, body);
}

/**
 * Set the values this trigger sends for the automation's declared inputs —
 * ui-upgrade Phase 7.4.
 *
 * ⚠ **The server MERGES this into `config.inputs`** rather than the client
 * sending the whole config back. `updateTrigger`'s `config` replaces wholesale,
 * so a browser round trip would drop every key it does not know about —
 * `draftedFrom` today, and whatever a later version adds. Sending only what
 * changed is what makes that impossible rather than merely unlikely.
 *
 * ⚠ **`""` clears an override**, putting the input back on the plan's own
 * default (D-107). It does not store an empty value.
 */
export async function setTriggerInputs(id: string, inputs: Record<string, string>): Promise<void> {
  const flowId = await flowForTrigger(id);
  await foundryApi.updateTrigger(await resolveWorkspaceId(), flowId, id, { inputs });
}

export async function deleteTrigger(id: string): Promise<void> {
  const flowId = await flowForTrigger(id);
  await foundryApi.deleteTrigger(await resolveWorkspaceId(), flowId, id);
  triggerFlowIndex.delete(id);
}

/**
 * A trigger's fire history — every attempt to start it, newest first.
 *
 * ⚠ This closes the last GAP `e2e:ui` reports: the route has existed since
 * Phase 3 and no client method reached it, so the audit trail was API-only. It
 * is the screen for "my automation is silent", and the two answers it separates
 * cannot be told apart anywhere else in the product: **no rows** means the
 * trigger never fired (it is not armed, or its schedule is on the flow model and
 * was never approved), while **rows with no run** means it fired and was refused
 * — gate 2, almost always. "Last started" on the card conflates them.
 */
export async function listTriggerFires(id: string): Promise<TriggerFire[]> {
  const flowId = await flowForTrigger(id);
  const ws = await resolveWorkspaceId();
  return (await foundryApi.listTriggerFires(ws, flowId, id)).map(triggerFireFromFA);
}

export async function setTriggerLive(id: string, live: boolean): Promise<void> {
  const flowId = await flowForTrigger(id);
  await foundryApi.updateTrigger(await resolveWorkspaceId(), flowId, id, { enabled: live });
}

/**
 * Fire a trigger — starts the flow's **approved live revision** in Kestra, or is
 * refused.
 *
 * The refusal is the interesting case and it is reported verbatim: a flow with no
 * approved revision cannot fire, and smoothing that into "no execution started"
 * would read as a transient glitch rather than as the approval gate doing its job.
 *
 * This used to fall back to fabricated per-kind sample payloads ("Delivered a
 * sample email to …") when the trigger had no flow. A green log line describing
 * work that never happened is the worst possible output for a test button.
 */
export async function testTrigger(
  id: string,
  inputs?: Record<string, string>,
): Promise<{ payload: Record<string, string>; log: string[] }> {
  const flowId = await flowForTrigger(id);
  const ws = await resolveWorkspaceId();
  try {
    const fired = await foundryApi.fireTrigger(ws, flowId, id, inputs);
    // `fired.kestraExecutionId` is read for PRESENCE only and deliberately not
    // shown or stored. The route returning it at all is drift (I-22) against the
    // invariant that a client is never handed engine addressing — executions are
    // addressed by their Foundry id (R5). Treating it as "something started" and
    // nothing more is what keeps that drift from growing a dependant.
    // `fired.started` is a boolean the server computes. It used to be
    // `fired.kestraExecutionId`, read for PRESENCE only because the route handed
    // over engine addressing it must not (I-22) — the field is gone from the wire
    // now, and what is left is the question the UI was actually asking.
    if (fired.started) {
      return {
        payload: { started: "true" },
        log: [
          "Fired the trigger — started the approved revision.",
          "Open History to watch it step by step.",
        ],
      };
    }
    return {
      payload: { started: "false" },
      log: ["Fired the trigger, but nothing started.", fired.error ?? ""].filter(Boolean),
    };
  } catch (e) {
    return {
      payload: { started: "false" },
      log: [`Could not fire: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/**
 * Fire a trigger with per-fire inputs — the run sheet's path.
 *
 * Mirrors `testTrigger`'s resolution (the workspace, then the trigger's flow)
 * but returns the fire result itself rather than test-button log lines: the
 * dialog reports the refusal verbatim, and the caller decides what "fired"
 * means for its screen.
 */
export async function fireTriggerWithInputs(
  id: string,
  inputs: Record<string, string>,
): Promise<{ fireId: string; started: boolean; error?: string }> {
  const flowId = await flowForTrigger(id);
  return foundryApi.fireTrigger(await resolveWorkspaceId(), flowId, id, inputs);
}

// ---- Runs / History ---------------------------------------------------------

export async function listFlowExecutions(limit = 50): Promise<FlowExecutionSummary[]> {
  const ws = await resolveWorkspaceId();
  return (await foundryApi.listFlowExecutions(ws, limit)).map(flowExecutionSummaryFromFA);
}

export async function getFlowExecution(id: string): Promise<FlowExecutionDetail> {
  const ws = await resolveWorkspaceId();
  return flowExecutionDetailFromFA(await foundryApi.getFlowExecution(ws, id));
}

/** Mint a single-use ticket for the step-progress socket (see `lib/flow-stream.ts`). */
export async function watchFlowExecution(id: string): Promise<{ ticket: string; expiresAt: string }> {
  const ws = await resolveWorkspaceId();
  return foundryApi.watchFlowExecution(ws, id);
}

/**
 * Flow executions as History rows.
 *
 * Each summary is fetched in FULL, because a history row that says "stopped at
 * `notify` — HTTP 400" needs the step list and a summary does not carry one. That
 * is N+1 requests against a local service for a page of ~50; when it stops being
 * acceptable the fix is a server-side projection, not dropping the detail — the
 * detail is the entire reason this page is worth having.
 */
export async function listFlowRuns(limit = 50): Promise<Run[]> {
  const ws = await resolveWorkspaceId();
  const summaries = await foundryApi.listFlowExecutions(ws, limit);
  const details = await Promise.all(
    summaries.map((s) =>
      foundryApi
        .getFlowExecution(ws, s.id)
        .then(flowExecutionDetailFromFA)
        // A single unreadable execution degrades to its summary rather than
        // failing the page — but it degrades to LESS DATA, never to invented data.
        .catch(() => flowExecutionSummaryFromFA(s)),
    ),
  );
  return details
    // ⚠ `runLabel`, not `d.flowId`. `flowId` is Foundry's uuid since I-23 was
    // fixed; passing it here would put a uuid in History's automation column,
    // which is how a correct id fix becomes a visible regression.
    .map((d) => runFromFlowExecution(d, runLabel(d)))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/**
 * A list run as a History row (2026-10-11). A flow-runner run arrives with its steps in light form, so the row needs
 * no request of its own; an engine (Kestra) run does not, and is fetched in full — as every run used to be.
 */
async function runOfListed(ws: string, e: import("@/lib/foundry-client").FAFlowExecutionSummary): Promise<Run> {
  if (e.steps) {
    const d = { ...flowExecutionSummaryFromFA(e), steps: e.steps.map(stepRunFromFA) } as FlowExecutionDetail;
    return runFromFlowExecution(d, runLabel(d));
  }
  const d = await foundryApi
    .getFlowExecution(ws, e.id)
    .then(flowExecutionDetailFromFA)
    .catch(() => flowExecutionSummaryFromFA(e));
  return runFromFlowExecution(d, runLabel(d));
}

export type RunsPage = { runs: Run[]; next: string | null; labels?: string[] };

/**
 * One page of History, newest first (2026-10-11): ONE request per page, not one per run. Filters are applied by the
 * server over every run — `name` the label a run is listed under, `from` a start time, `q` a piece of that label or of
 * the run's or workflow's id — so a search finds runs that are not on a loaded page.
 */
export async function listRunsPage(p: { before?: string; name?: string; from?: string; q?: string; limit?: number } = {}): Promise<RunsPage> {
  const ws = await resolveWorkspaceId();
  const page = await foundryApi.listFlowExecutionsPage(ws, p);
  return { runs: await Promise.all(page.executions.map((e) => runOfListed(ws, e))), next: page.next, ...(page.labels ? { labels: page.labels } : {}) };
}

// ---- Flows and approvals ----------------------------------------------------

/** The cron a revision declares, read from its stored model (D-18). */
function scheduleOfRevision(modelJson: unknown): string | null {
  const m = modelJson as { schedule?: { cron?: string } } | null;
  return m?.schedule?.cron ?? null;
}

/** The dashboard's "Coming up": the automations that fire on a timer, at most `limit`, plus how many there are. */
export async function listScheduledFlows(limit = 4): Promise<{ flows: { id: string; name: string; schedule: string }[]; total: number }> {
  const ws = await resolveWorkspaceId();
  return foundryApi.listScheduledFlows(ws, limit);
}

export async function listFlows(): Promise<FlowSummary[]> {
  const ws = await resolveWorkspaceId();
  return (await foundryApi.listFlows(ws)).map((f) => flowFromFA(f));
}

/**
 * P6 — per-flow last run (honest-empty). Used when a flow's summary carries no
 * `lastExecution`; bulk path `listFlowsWithLastExecution` is preferred for the
 * list view (one Kestra join, not N).
 */
export async function getFlowLastRun(flowId: string): Promise<FlowExecutionSummary | null> {
  const ws = await resolveWorkspaceId();
  const raw = await foundryApi.getFlowLastRun(ws, flowId);
  return raw ? flowExecutionSummaryFromFA(raw) : null;
}

/**
 * P6 — list flows enriched with their last execution. Primary join for
 * Running/Failed: one `listFlows` + one `listFlowExecutions` (newest 200),
 * grouped by `flowId`, newest `startedAt` wins. Honest-empty when unmatched —
 * tabs render `0`, predicate keeps count from being always-0.
 */
export async function listFlowsWithLastExecution(): Promise<FlowSummary[]> {
  const ws = await resolveWorkspaceId();
  const [rawFlows, executions] = await Promise.all([foundryApi.listFlows(ws), foundryApi.listFlowExecutions(ws, 200)]);
  const flows = rawFlows.map((f) => flowFromFA(f));
  const summaries = executions.map(flowExecutionSummaryFromFA);
  const lastByFlow = new Map<string, FlowExecutionSummary>();
  for (const e of summaries) {
    if (!e.flowId) continue;
    const cur = lastByFlow.get(e.flowId);
    if (!cur || (e.startedAt ?? "") > (cur.startedAt ?? "")) lastByFlow.set(e.flowId, e);
  }
  return flows.map((f) => {
    const last = lastByFlow.get(f.id);
    if (!last) return f;
    return {
      ...f,
      lastExecution: { id: last.id, status: last.status, engineStatus: last.engineStatus, startedAt: last.startedAt },
      lastRun: { status: last.status, engineStatus: last.engineStatus, startedAt: last.startedAt },
    };
  });
}

/**
 * P5 B-07 — list resources (datasources+tools) for the current workspace.
 * Used to hydrate resource names per flow (`manifest_refs_json` refs) when
 * `FlowSummary.resources` carries raw refs. Honest-empty when backend has
 * none — the Resources column then renders `—`.
 */
export async function listResources(): Promise<Array<{ id: string; name: string }>> {
  const ws = await resolveWorkspaceId();
  try {
    return await foundryApi.listResources(ws);
  } catch {
    // Honest-empty fallback: resource union may not exist on older backends; the
    // column still renders `—` rather than erroring the whole list.
    return [];
  }
}

/**
 * The saved DAG arrangement for one flow — `flow_step_positions`, OUTSIDE the
 * revision (plan decision ②, D-150). Keyed by step id.
 *
 * ⚠ A cosmetic drag must never create a revision: this read never touches
 * revisions and the write below never creates one. The server is dumb; the
 * client reconciles (drops deleted steps' rows, re-keys renamed ones) before
 * PUT, per D-150.
 */
export async function getFlowPositions(
  flowId: string,
): Promise<Map<string, { x: number; y: number }>> {
  const ws = await resolveWorkspaceId();
  const rows = await foundryApi.getFlowPositions(ws, flowId);
  return new Map(rows.map((p) => [p.stepId, { x: p.x, y: p.y }]));
}

/** Wholesale replace of one flow's arrangement rows (D-150(f)). */
export async function putFlowPositions(
  flowId: string,
  positions: Array<{ stepId: string; x: number; y: number }>,
): Promise<void> {
  const ws = await resolveWorkspaceId();
  // The API stores whole pixels; a layout or a pointer can hand over a fraction (I-318).
  await foundryApi.putFlowPositions(
    ws,
    flowId,
    positions.map((p) => ({ stepId: p.stepId, x: Math.round(p.x), y: Math.round(p.y) })),
  );
}

export type FlowPhase = { id: string; label: string; ordinal: number; flowRevisionId: string };
export type FlowFlag = { id: string; stepNumber: number | null; kind: string; title: string; consequence: string; blocking: boolean; status: string };

export async function listPhases(flowId: string, revision: string | number): Promise<FlowPhase[]> {
  const ws = await resolveWorkspaceId();
  return foundryApi.listPhases(ws, flowId, revision);
}

export async function listFlags(flowId: string, revision: string | number): Promise<{ flags: FlowFlag[]; canTest: boolean; canPublish: boolean }> {
  const ws = await resolveWorkspaceId();
  return foundryApi.listFlags(ws, flowId, revision);
}

/**
 * Approvals → versions, numbered in the order they were approved.
 *
 * ⚠ **ORDERED BY `approvedAt`, NOT by `revision`.** They usually agree and they
 * are not the same claim: a person may approve revision 9, edit, and then
 * approve revision 12 — but they may also arm an OLDER revision deliberately
 * (`flow-approval.service.ts` allows switching to any version, gate 1 having
 * been downgraded to a warning). Numbering by revision would then show v2
 * approved before v1. The ordinal is a fact about when somebody signed
 * something off, so it has to come from when they signed it.
 *
 * ⚠ **A revoked approval KEEPS its number.** `flow_approvals` is closed by
 * timestamp and never deleted, and renumbering after a revoke would silently
 * change which version an audit trail refers to. v2 stays v2 after it stops
 * running; `revokedAt` is what says it is no longer in service.
 *
 * Exported for its test — the ordering rule is the part worth pinning, and it
 * cannot be asserted through a page render.
 */
export function versionsFromApprovals(
  approvals: Array<{
    revision: number;
    approverUserId: string | null;
    note: string | null;
    approvedAt: string | null;
    revokedAt: string | null;
    staleReason: string | null;
  } | null>,
): FlowVersion[] {
  return approvals
    .filter((a): a is NonNullable<typeof a> => !!a)
    // ⚠ Null `approvedAt` sorts LAST rather than first: an unstamped row is not
    // evidence of being the earliest approval, and `""` would win an ascending
    // string compare against every real timestamp.
    .slice()
    .sort((a, b) => (a.approvedAt ?? "\uffff").localeCompare(b.approvedAt ?? "\uffff"))
    .map((a, i) => ({
      version: i + 1,
      revision: a.revision,
      approvedAt: a.approvedAt,
      approvedBy: a.approverUserId,
      note: a.note,
      revokedAt: a.revokedAt,
      staleReason: a.staleReason,
    }));
}

export async function getFlowDetail(flowId: string): Promise<{
  flow: FlowSummary;
  revisions: FlowRevisionSummary[];
  /**
   * ⚠ **THE VERSION LIST — approvals, numbered in approval order.**
   * A revision is an internal per-edit row; a version is an approval. See
   * `FlowVersion`. Empty for an automation nobody has approved, which is the
   * honest answer rather than `v1`.
   */
  versions: FlowVersion[];
  runs: Array<{
    id: string;
    status: string;
    engineStatus: string | null;
    revision: number | null;
    startedAt: string | null;
  }>;
  /**
   * What the designer was pointed at, and whether the draft used each one.
   *
   * ⚠ Passed straight through rather than flattened to a boolean like "the
   * selection was honoured". `used` has three states and the entries carry
   * `present` as well; collapsing them here would decide, in an adapter, a
   * question the screen exists to let a person judge.
   */
  pointedAt: Array<{
    kind: "datasource" | "tool";
    label: string;
    present: boolean;
    used: boolean | null;
  }> | null;
  /** Refs the draft uses that nothing pointed-at covers. */
  usedInstead: string[];
  /**
   * The draft's per-input controls (`GET …/flows/:id` `inputFormats`). `{}` when
   * the server predates the key — the drawer falls back to the declared type.
   */
  inputFormats: Record<string, FlowInputFormat>;
  /** rbac-observability: true for an Admin, who may move the automation to another owner. */
  canChangeOwner: boolean;
  /** May this person edit it. Absent from an older server, which is read as yes — the server still decides. */
  canChange: boolean;
  /** May this person manage it (sharing-boundaries phase 2). Absent from an older server: then whoever may edit it. */
  canManage: boolean;
  /** Plugins phase 9: may this person switch the draft on themselves, and if not, why. Null when a reviewer always does. */
  selfEnable: import("./foundry-client").FASelfEnable | null;
} | undefined> {
  const ws = await resolveWorkspaceId();
  try {
    const d = await foundryApi.getFlow(ws, flowId);
    // The armed revision's cron, not the draft's — the card says what runs
    // tonight, and after an edit those are different revisions.
    const shown = d.flow.armedRevision ?? d.flow.draftRevision;
    const model = d.revisions.find((r) => r.revision === shown)?.modelJson;
    return {
      flow: flowFromFA({ ...d.flow, approvalState: d.approvalState }, scheduleOfRevision(model)),
      revisions: d.revisions.map((r) => ({
        revision: r.revision,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        stepCount: ((r.modelJson as { steps?: unknown[] } | null)?.steps ?? []).length,
        structureHash: r.structureHash,
      })),
      versions: versionsFromApprovals(d.approvals),
      runs: d.executions.map((e) => ({
        id: e.id,
        status: e.status,
        engineStatus: e.engineStatus,
        revision: e.flowRevision,
        startedAt: e.startedAt,
      })),
      // ⚠ `?? null` and `?? []` are NOT the same defensive default said twice.
      // A missing `designedAgainst` means nothing was preferred; a missing
      // `usedInstead` means there is nothing to name. Defaulting the first to
      // `[]` would render an empty "pointed at" panel over every flow.
      pointedAt: d.designedAgainst ?? null,
      usedInstead: d.usedInstead ?? [],
      inputFormats: d.inputFormats ?? {},
      canChangeOwner: d.canChangeOwner === true,
      canChange: d.canChange !== false,
      canManage: d.canManage ?? d.canChange !== false,
      selfEnable: d.selfEnable ?? null,
    };
  } catch (e) {
    if (e instanceof FoundryApiError && e.status === 404) return undefined;
    throw e;
  }
}

export async function getFlowDiff(
  flowId: string,
  from?: number,
  to?: number,
): Promise<FlowDiff | null> {
  const ws = await resolveWorkspaceId();
  try {
    return await foundryApi.getFlowDiff(ws, flowId, to, from);
  } catch {
    // A missing diff must not blank the panel: approving and revoking still work
    // without it, and a page that refuses to render because a comparison failed
    // is a page that cannot be used to stop a schedule.
    return null;
  }
}

/**
 * Approve a revision.
 *
 * ⚠ No approver argument, deliberately (Stage 9.1). The server reads it from the
 * signed identity the Next proxy forwards, and refuses a body that names one.
 * The browser cannot say who approved, which is the whole point.
 */
/**
 * Publish a revision — and, with it, arm the capacity the flow was built in.
 *
 * ⚠ **IT RETURNS THE FIRING OUTCOME AND USED TO RETURN `void`.** Publish now
 * means "this workflow is ready to run in whatever capacity it was built in",
 * so the interesting half of the answer is which mechanisms are actually on.
 * Discarding it here would leave every caller reporting "Approved" over a
 * workflow that fires nothing — which is the defect, moved into the client.
 *
 * `null` when the server did not report (an older build). ⚠ **NOT `{armed: [],
 * held: [], …}`**: "nothing was armed" and "nobody said" are different
 * sentences, and defaulting to the first states a fact nobody established
 * (D-66).
 */
export async function approveFlowRevision(
  flowId: string,
  revision: number,
  note?: string,
): Promise<FiringOutcome | null> {
  const ws = await resolveWorkspaceId();
  const res = await foundryApi.approveFlowRevision(ws, flowId, { revision, note });
  return res.firing ?? null;
}

/** Usage, cost and run health for the active workspace (P-OBS). */
export async function getObservability(days = 30, scope?: "mine" | "workspace"): Promise<import("./types").Observability> {
  const ws = await resolveWorkspaceId();
  return foundryApi.getObservability(ws, days, scope);
}

/** Across the deployment — refused (403) for anyone but a platform administrator. */
/** The cost report (2026-10-26). See `lib/reports.ts`; the server decides who may open it. */
export const getReportSummary = (q: import("./reports").ReportQuery) => foundryApi.getReportSummary(q);
export const getReportRuns = (
  q: import("./reports").ReportQuery,
  page: { sort: import("./reports").RunSort; dir: "asc" | "desc"; offset: number; limit: number },
) => foundryApi.getReportRuns(q, page);
export const downloadReport = (q: import("./reports").ReportQuery) => foundryApi.downloadReport(q);
export const emailReport = (q: import("./reports").ReportQuery, body: { recipients: string[]; note?: string }) =>
  foundryApi.emailReport(q, body);

export async function getDeploymentObservability(days = 30): Promise<import("./types").Observability> {
  return foundryApi.getDeploymentObservability(days);
}

/** Run a Forge workflow's approved revision now, live: production data, mail delivered. Returns the run's id. */
export async function runFlowLive(flowId: string, inputs?: Record<string, string | number | boolean>): Promise<string> {
  const ws = await resolveWorkspaceId();
  return (await foundryApi.runFlowLive(ws, flowId, inputs)).flowExecutionId;
}

/** Switch your own workflow on yourself — allowed only when it uses nothing but your own things (plugins phase 9). */
export async function switchOnFlow(flowId: string, revision?: number): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.switchOnFlow(ws, flowId, revision);
}

/** While shared, may members edit it, or is it view-only (sharing-boundaries phase 2). */
export async function setFlowEditing(flowId: string, othersMayEdit: boolean): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.setFlowEditing(ws, flowId, othersMayEdit);
}

/** Your own notices in this workspace (sharing-boundaries), and marking them read. */
export async function listNotifications(): Promise<FANotification[]> {
  const ws = await resolveWorkspaceId();
  return (await foundryApi.listNotifications(ws)).notifications;
}

export async function markNotificationsRead(ids?: string[]): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.markNotificationsRead(ws, ids);
}

/** Ask a reviewer to approve your workflow (sharing-boundaries); `withdrawFlowReview` takes it back. */
export async function requestFlowReview(flowId: string, revision?: number): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.requestFlowReview(ws, flowId, revision);
}

export async function withdrawFlowReview(flowId: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.withdrawFlowReview(ws, flowId);
}

/** Switch your own workflow off (plugins phase 9). */
export async function switchOffFlow(flowId: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.switchOffFlow(ws, flowId);
}

export async function revokeFlowApproval(flowId: string, reason: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.revokeFlowApproval(ws, flowId, reason);
}

/**
 * Re-arm a turned-off flow in one click — no review round-trip.
 *
 * ⚠ **THROWS `FoundryApiError` WITH `status === 409` WHEN A PERSON NEEDS TO
 * LOOK.** That is the endpoint's contract (the draft moved on, or something
 * the flow depends on changed shape), and the caller routes it to `/publish`
 * instead of toasting a failure. Any other throw is the failure.
 */
export async function rearmFlowApproval(flowId: string): Promise<FiringOutcome | null> {
  const ws = await resolveWorkspaceId();
  const res = await foundryApi.rearmFlowApproval(ws, flowId);
  return res.firing ?? null;
}

/** Remove a revision from the version list. It is hidden, never destroyed. */
export async function hideFlowRevision(flowId: string, revision: number): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.hideFlowRevision(ws, flowId, revision);
}

/**
 * Start a run against the DRAFT namespace — the only way to satisfy gate 1.
 *
 * Mock by default. `useProductionData: true` is the per-run prod opt-in:
 * Confirm-gated in the UI, default OFF, admin-only server-side, and every use
 * audited as operation=`access` entity=`datasource`. Live runs ignore it.
 */
export async function testRunFlow(flowId: string, inputs?: Record<string, string>, opts?: { useProductionData?: boolean }): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.testRunFlow(ws, flowId, inputs, opts);
}

/**
 * Delete a flow and its deployments (Kestra first, then the Foundry row —
 * `flowService.remove`'s own ordering, so a delete can never leave a schedule
 * armed with no Foundry row left to see, approve or revoke it).
 */
export async function deleteFlow(flowId: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.deleteFlow(ws, flowId);
}

/** Copy a flow's draft model into a new unarmed draft with a fresh id and "(copy)" name. */
export async function duplicateFlow(flowId: string): Promise<{ flow: FlowSummary; revision: number }> {
  const ws = await resolveWorkspaceId();
  return foundryApi.duplicateFlow(ws, flowId);
}

/**
 * The prompt-boundary warnings for this workspace (guardrail port V4).
 *
 * ⚠ **It THROWS on failure and must keep doing so.** krt's version of this
 * function caught everything and returned `{items: []}` — which renders as "no
 * flagged content" when the truth is "the check did not run". That is the
 * deleted `faFallback` shape exactly, and it is worse here than on an ordinary
 * screen: the one thing this panel must never do is imply an absence of findings
 * it never obtained. The caller renders the failure (`PromptBoundaryWarnings`
 * takes an `error` prop for it).
 */
export async function listPromptBoundaryWarnings(): Promise<FAManifestWarnings> {
  const ws = await resolveWorkspaceId();
  const m = await foundryApi.getManifest(ws);
  // An older server that predates the detector sends no `warnings` at all.
  // Absent is treated as "nothing matched" rather than as an error: the field
  // being missing is a version fact, not a failed check, and the panel's empty
  // state already refuses to claim safety.
  return m.warnings ?? { items: [], truncated: false, total: 0, cap: 0 };
}

/**
 * REAL emails a run attempted.
 * email-send-tool T037
 *
 * Workspace resolved here so the caller only needs the execution id, following
 * `listPromptBoundaryWarnings` above. ⚠ It does **not** swallow a failure into an
 * empty list: an empty array means "this run emailed nothing", and a read that
 * failed must not be able to say that. `ToolActivity` renders the error.
 */
export async function emailsForRun(execId: string): Promise<FAEmailSend[]> {
  const ws = await resolveWorkspaceId();
  return foundryApi.emailsForRun(ws, execId);
}

/** What a run called — tools, reads, web addresses — from Foundry's own records. */
export async function callsForRun(execId: string): Promise<{ calls: FARunCall[]; truncated: boolean }> {
  const ws = await resolveWorkspaceId();
  return foundryApi.runCalls(ws, execId);
}

/**
 * The palette's source of truth: this workspace's callable refs with their
 * parameter descriptions, D-22's allowlist, the caps and the per-kind output
 * shapes.
 */
/**
 * Set the values — and/or the firing-time derivations — this automation's
 * declared inputs carry.
 *
 * ⚠ Values for DECLARED inputs and nothing else — see the client method's
 * docblock. It is not a way to re-ask a design. A `computed` entry answers an
 * input with a derivation instead of a literal, the same exclusivity the
 * server enforces.
 */
export async function confirmFlowInputs(
  flowId: string,
  values: Record<string, string>,
  computed?: Record<string, ComputedInputFn>,
): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.confirmFlowInputs(ws, flowId, values, computed);
}

export async function getFlowCatalogue(): Promise<FAFlowCatalogue> {
  const ws = await resolveWorkspaceId();
  return foundryApi.getFlowCatalogue(ws);
}

/**
 * This workspace's saved flow templates.
 *
 * ⚠ Resolves the workspace the way every other wrapper here does, rather than
 * taking one — `TemplateSurface` reads `activeFoundryWorkspaceId()` directly,
 * which is a synchronous best guess, and two different answers to "which
 * workspace" is how the door and the shelf would come to disagree about what
 * exists (D-197's shape). Templates are per workspace with no cross-workspace
 * listing (D-27), so the id is the whole query.
 */
export async function listFlowTemplates() {
  const ws = await resolveWorkspaceId();
  return foundryApi.listFlowTemplates(ws);
}

/**
 * Run ONE component on its own — T9.
 *
 * ⚠ Deliberately NOT wrapped in a try/catch that returns a shape. A try that
 * could not be sent, and a try whose call failed, are different answers and the
 * screen shows different words for them — swallowing the first into an empty
 * result is the `faFallback` shape (a failure rendering as an absence).
 */
/** The flow's incomplete working copy (D-319). Throws on a failed read — never `null` for "could not be read". */
/** The manual builder's three calls (compiled-builder phase 7, D-329) — the server lists and applies every action. */
/** One choice of a revision, as the server reads it back (compiled-builder phase 8, P6). */
export interface ChoiceView { stepId?: string; port?: string; what: string; chosen: string; options: number | null; by: "llm" | "goal" | "person" | "code" | "forced"; quote?: string; confidence: null }
export type ChoicesResult = { revision: number; goal: { text: string; readback: string[] } | null; specMatch: string[]; choices: ChoiceView[] } | { legacy: string };
export async function getFlowChoices(flowId: string, revision: number) {
  return foundryApi.getFlowChoices(await resolveWorkspaceId(), flowId, revision);
}
export async function createCanvasFlow(name: string) {
  return foundryApi.createCanvasFlow(await resolveWorkspaceId(), name);
}
export async function openCanvas(flowId: string) {
  return foundryApi.openCanvas(await resolveWorkspaceId(), flowId);
}
export async function canvasAct(flowId: string, body: { state: unknown; sig: string; actionId: string; value?: string }) {
  return foundryApi.canvasAct(await resolveWorkspaceId(), flowId, body);
}
export async function canvasSave(flowId: string, body: { state: unknown; sig: string }) {
  return foundryApi.canvasSave(await resolveWorkspaceId(), flowId, body);
}

export async function getIncompleteFlow(flowId: string) {
  const ws = await resolveWorkspaceId();
  return foundryApi.getIncompleteFlow(ws, flowId);
}

export async function getFlowIntegration(flowId: string) {
  const ws = await resolveWorkspaceId();
  return foundryApi.getFlowIntegration(ws, flowId);
}

export async function tryStep(body: {
  stepKind: string;
  ref: string;
  params: Record<string, unknown>;
}) {
  const ws = await resolveWorkspaceId();
  return foundryApi.tryStep(ws, body);
}

export async function getDatasourceSandbox(dsId: string) {
  const ws = await resolveWorkspaceId();
  return foundryApi.getDatasourceSandbox(ws, dsId);
}

/**
 * The steps of a revision, for review — kind, contract, and whether the step was
 * GENERATED or merely declared.
 *
 * That distinction is the review surface's whole job. Four of a five-step flow
 * are named references to reviewed SQL and registered tools; only the `code`
 * steps were written by a model, and a reviewer who cannot see which is which is
 * reviewing all five equally, or none of them.
 *
 * `contracts` (added Phase 6) is the per-step `contract_json` record — step id →
 * the contract a `code` step's fragment was generated from, EMPTY for every
 * other kind. It is what lets the review surface feed the model through the
 * same `authoredFromModel` adapter the canvas reopen and the server's chat
 * turn use, so the page and the builder cannot disagree about what a stored
 * flow is. The bytes come from the same `getFlowRevisionSteps` call the review
 * rows do, so a code step with no stored contract is honestly ABSENT — it can
 * be run and approved but not reopened for editing.
 */
export async function getFlowReview(
  flowId: string,
  revision: number,
): Promise<{ model: unknown; steps: FlowStepReview[]; contracts: Record<string, StoredContract> }> {
  const ws = await resolveWorkspaceId();
  const [detail, steps] = await Promise.all([
    foundryApi.getFlow(ws, flowId),
    foundryApi.getFlowRevisionSteps(ws, flowId, revision),
  ]);
  /**
   * ⚠ **`draftModel` FIRST, and the revisions list only as a fallback.**
   *
   * This line used to be the `.find(...)` alone, and it returned null for very
   * nearly every flow on the deployment: `revisions` honours `hidden_at`, a
   * chat turn writes its revision already hidden, so `revisions` is `[]` while
   * `draftRevision` is 1. A null model makes `authoredFromModel` unreachable,
   * and the step inspector then renders *"this draft could not be read as an
   * editable model"* under EVERY node — which is exactly how it was reported:
   * *"cant see any properties in inspector for any component"*.
   *
   * The fallback is kept and is not dead code: `draftModel` is the DRAFT's
   * model, and this function is also called for an older or armed revision,
   * where the list is the right source.
   */
  const model =
    revision === detail.flow.draftRevision && detail.draftModel != null
      ? detail.draftModel
      : (detail.revisions.find((r) => r.revision === revision)?.modelJson ?? null);
  const contracts: Record<string, StoredContract> = {};
  for (const s of steps) {
    if (s.kind === "code" && s.contractJson) contracts[s.stepId] = s.contractJson as StoredContract;
  }
  return {
    model,
    contracts,
    steps: steps
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((s) => {
        const cfg = (s.configJson ?? {}) as Record<string, unknown>;
        return {
          stepId: s.stepId,
          kind: s.kind,
          ordinal: s.ordinal,
          ref: typeof cfg.ref === "string" ? cfg.ref : null,
          dependsOn: Array.isArray(cfg.dependsOn) ? (cfg.dependsOn as string[]) : [],
          // `code` steps only. A `tool` step is not "generated" in any sense that
          // matters here: its params are an expression the drafter wrote, but the
          // thing being CALLED was registered and reviewed by a person.
          generated: s.kind === "code",
          contract: (s.contractJson ?? null) as FlowStepReview["contract"],
          codeLines:
            s.kind === "code" && typeof cfg.code === "string"
              ? (cfg.code as string).split("\n").length
              : null,
          retry: (cfg.retry ?? null) as FlowStepReview["retry"],
          awaitSeconds: typeof cfg.awaitSeconds === "number" ? cfg.awaitSeconds : null,
          // Zero backend change: `configJson` has carried this all along and the
          // projection simply dropped it (T8).
          paramsExpr: typeof cfg.paramsExpr === "string" ? cfg.paramsExpr : null,
          /**
           * ⚠ **T8's shape again, and the reason is sharper here.** `elseOf` and
           * `conditionExpr` have ridden in `configJson` since the chain landed,
           * and this projection dropped both — so `canvasFromModel` could not
           * see an if/elif/else chain while `canvasFromRawModel` could. That is
           * exactly the disagreement `canvas-model.test.ts` exists to prevent:
           * two pictures of one flow, one of them showing a fork and the other
           * three unrelated guards. Zero backend change.
           */
          elseOf: typeof cfg.elseOf === "string" ? cfg.elseOf : null,
          conditionExpr: typeof cfg.conditionExpr === "string" ? cfg.conditionExpr : null,
          // ⚠ A merge's links, and the third time this projection has dropped a
          // topology field it was already being handed. See `FlowStepReview`.
          sources: Array.isArray(cfg.sources) ? (cfg.sources as string[]) : null,
        };
      }),
  };
}

// ---- Chat mode (Phase 2) ----------------------------------------------------

/**
 * ⚠ **A turn's outcome is on the TURN, never on the HTTP status.** `status` is
 * one of `applied` · `ambiguous_referent` · `too_structural` ·
 * `insufficient_contract` · `failed`, and all five arrive 200. Treating a
 * refusal as an error is how a client renders the most useful diagnosis this
 * system produces as a failure — and then offers a Retry for it, which is the
 * one thing §6.7 forbids.
 */
/**
 * A conversation that opened with questions has a thread and no flow. Its goal goes
 * to the generation job (the skeleton pipeline and its live canvas), and the flow
 * the job seeds is bound to THAT thread, so the questions stay in the conversation.
 * The server never repoints a bound thread (409).
 */
export async function attachChatThreadFlow(threadId: string, flowId: string): Promise<FAChatThread> {
  const ws = await resolveWorkspaceId();
  return (await foundryApi.attachChatThreadFlow(ws, threadId, flowId)).thread;
}

export async function createChatThread(name: string, flowId?: string): Promise<FAChatThread> {
  const ws = await resolveWorkspaceId();
  // `flowId` binds the conversation to a flow the generation job already seeded
  // (Phase 3 — the split surface). Absent, the thread stays unbound and the
  // first APPLIED turn seeds the flow as before (D-120).
  return (await foundryApi.createChatThread(ws, { name, ...(flowId ? { flowId } : {}) })).thread;
}

/** Rename a flow. Metadata only — never a revision, so an approval survives it. */
export async function renameFlow(flowId: string, name: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.updateFlow(ws, flowId, { name });
}

/** Plugins 8.6 — what each connected service of a workflow runs as. */
export async function getFlowReadiness(flowId: string, revision: "approved" | "draft") {
  return foundryApi.getFlowReadiness(await resolveWorkspaceId(), flowId, revision);
}
export async function setMyAccount(flowId: string, piece: string, connectionId: string) {
  return foundryApi.setMyAccount(await resolveWorkspaceId(), flowId, piece, connectionId);
}
export async function getFlowActivation(flowId: string) {
  return foundryApi.getFlowActivation(await resolveWorkspaceId(), flowId);
}
export async function setFlowActivation(flowId: string, body: { on: boolean; cron?: string | null; timezone?: string | null }) {
  return foundryApi.setFlowActivation(await resolveWorkspaceId(), flowId, body);
}
/** Projects (sharing-boundaries phase 5). */
export async function listProjects() {
  return (await foundryApi.listProjects(await resolveWorkspaceId())).projects;
}
export async function getProject(projectId: string) {
  return (await foundryApi.getProject(await resolveWorkspaceId(), projectId)).project;
}
export async function createProject(body: { name: string; description?: string | null; instructions?: string }) {
  return (await foundryApi.createProject(await resolveWorkspaceId(), body)).project;
}
export async function updateProject(projectId: string, body: { name?: string; description?: string | null; instructions?: string }) {
  return (await foundryApi.updateProject(await resolveWorkspaceId(), projectId, body)).project;
}
export async function deleteProject(projectId: string) {
  return foundryApi.deleteProject(await resolveWorkspaceId(), projectId);
}
export async function addProjectMember(projectId: string, subject: string) {
  return (await foundryApi.addProjectMember(await resolveWorkspaceId(), projectId, subject)).project;
}
export async function removeProjectMember(projectId: string, subject: string) {
  return foundryApi.removeProjectMember(await resolveWorkspaceId(), projectId, subject);
}
export async function setProjectOwner(projectId: string, subject: string) {
  return (await foundryApi.setProjectOwner(await resolveWorkspaceId(), projectId, subject)).project;
}
export async function movePreview(item: MovableItem, to: string) {
  return foundryApi.movePreview(await resolveWorkspaceId(), item, to);
}
export async function moveItem(item: MovableItem, to: string) {
  return foundryApi.moveItem(await resolveWorkspaceId(), item, to);
}
export async function getFlowRunAs(flowId: string) {
  return foundryApi.getFlowRunAs(await resolveWorkspaceId(), flowId);
}
export async function setFlowRunAs(flowId: string, piece: string, connectionId: string) {
  return foundryApi.setFlowRunAs(await resolveWorkspaceId(), flowId, piece, connectionId);
}

/** rbac-observability — move an automation to another member of the workspace, or to nobody. Admin only. */
export async function setFlowOwner(flowId: string, subject: string | null): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.setFlowOwner(ws, flowId, subject);
}

/**
 * Persist chat config and/or design scope. Metadata only — never a revision,
 * so an approval survives a settings save the way it survives a rename.
 */
export async function updateFlowMeta(
  flowId: string,
  patch: { chatConfig?: unknown; designSelection?: unknown },
): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.updateFlowMeta(ws, flowId, patch);
}

/**
 * Save an edited model as a new revision.
 *
 * The narrow edits the review needs — delete a step, add a flow input — are
 * model edits, so they land here rather than in a step editor. What this
 * deliberately does NOT offer is editing an expression or a fragment body: those
 * are what the drafter and the contract are for, and a hand-edited fragment is
 * one whose contract no longer describes it.
 */
/**
 * Put the conversation's current version in the version list.
 *
 * WARNING A chat turn writes its revision HIDDEN, because one conversation is one
 * version and not one per sentence - measured at six revisions from five turns.
 * This is the "save" a person means: nothing new is written, the existing draft
 * simply joins the list.
 */
export async function saveFlowDraft(flowId: string): Promise<number> {
  const ws = await resolveWorkspaceId();
  const { revision } = await foundryApi.saveFlowDraft(ws, flowId);
  return revision;
}

/**
 * Triage level 1 — regenerate ONE `code` step's fragment from its contract
 * into a new revision. The same endpoint the server's own flows use: the
 * fragment is a function of its contract, so a contract the inspector changed
 * is regenerated here, never rewritten locally.
 */
export async function regenerateFlowStep(flowId: string, stepId: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.regenerateFlowStep(ws, flowId, stepId);
}

/**
 * Claims this flow's own shape implies — GAPS §2.3b.
 *
 * ⚠ A READ. Accepting one goes through `saveFlowModel` like any other edit, so a
 * claim never enters a flow without somebody having chosen it. The `caveat`
 * travels with the payload and must be rendered beside them: a suggestion
 * presented as a finding is the failure mode here.
 */
export async function expectationSuggestions(
  flowId: string,
): Promise<{ suggestions: Array<{ expectation: FlowExpectation; because: string }>; caveat: string }> {
  const ws = await resolveWorkspaceId();
  const r = await foundryApi.expectationSuggestions(ws, flowId);
  return {
    suggestions: r.suggestions.map((s) => ({
      expectation: s.expectation as unknown as FlowExpectation,
      because: s.because,
    })),
    caveat: r.caveat,
  };
}

/**
 * The operational signals — GAPS §6.1b.
 *
 * ⚠ An unrecognised state becomes `unknown`, never `ok`. A state this build has
 * not heard of is by definition one it cannot interpret, and the safe reading of
 * "I do not know" on a monitoring surface is not "fine".
 */
export async function listSignals(): Promise<SignalsReport> {
  const r = await foundryApi.signals();
  const toState = (s: string): SignalState =>
    s === "ok" || s === "warn" || s === "alarm" ? s : "unknown";
  return {
    state: toState(r.state),
    checkedAt: r.checkedAt,
    signals: r.signals.map((s) => ({ ...s, state: toState(s.state) })),
  };
}

// ---- Data sources -----------------------------------------------------------
//
// `connector_id` is a CATALOGUE key (see `lib/connectors.ts`), used to pick the
// DSN form. The server stores a type and an encrypted connection string; it does
// not store which catalogue entry produced them.

export async function listManifests(): Promise<ConnectorManifest[]> {
  return CONNECTORS;
}

/**
 * Register a datasource — and send the two fields this used to drop (I-123).
 *
 * ── `secret_env_name` ────────────────────────────────────────────────────────
 *
 * The env-var name this datasource's connection string is referenced by. It is
 * optional, and what omitting it actually costs is narrower than it sounds:
 *
 *   - `manifest-builder` renders no `<secretRef env=…/>` for the datasource, so
 *     the manifest — the drafter's whole view of the workspace — does not say the
 *     connection is credentialled at all; and
 *   - `GET …/secrets/audit` walks DECLARATIONS, so a datasource with no name
 *     declared is invisible to both halves of that audit: `/keys` cannot report
 *     its value missing, and the collision check cannot see it.
 *
 * ⚠ It does **not** mean "the DSN is never injected into an execution container".
 * That is the natural sentence to write and it describes a mechanism that no
 * longer exists: the monolithic executor was deleted in Kestra Phase 4, a `code`
 * fragment gets no environment at all, and `resolveForExecution` has no
 * production caller (I-120). Restating a deleted mechanism is how the comments in
 * `workspace-secret.service.ts` came to describe a control that does not run.
 *
 * ── `schema_allowlist` ───────────────────────────────────────────────────────
 *
 * Which schemas `refreshSchema` introspects. Defaulted to `public` by the server;
 * sent explicitly so the wizard's field is the one that decides. ⚠ It is an input
 * to `assertReadOnly` (D-40), not a display preference — naming a schema the
 * credential can write in is **refused**, and `FoundryApiError.findings` carries
 * the privilege that was found. Do not swallow it.
 */
export async function createConnection(input: {
  name: string;
  description?: string;
  connector_id: string;
  payload: Record<string, unknown>;
  secret_env_name?: string;
  schema_allowlist?: string[];
  /**
   * What this data source is ALLOWED to do. Omitted ⇒ the server's default,
   * which is `read`.
   *
   * ⚠ Passed through, never decided here. The browser has no say in what a
   * policy MEANS — `requiresReadOnlyTransaction` lives in the server and the
   * database enforces it — so this carries the person's choice and nothing else.
   */
  accessPolicy?: AccessPolicy;
  /**
   * For a FILE connector (SQLite): the database file. It is uploaded first and
   * registered by the id the server returns — the client never assembles, and
   * so can never point, a sqlite connection string.
   */
  file?: File;
}): Promise<Connection> {
  const ws = await resolveWorkspaceId();
  const manifest = CONNECTORS.find((m) => m.id === input.connector_id);
  if (isFileConnector(manifest)) {
    if (!input.file) throw new Error("Choose the database file to upload first.");
    const uploaded = await foundryApi.uploadSqliteFile(ws, input.file, input.file.name);
    const ds = await foundryApi.createDatasource(ws, {
      name: input.name,
      type: "sqlite",
      sqliteFileId: uploaded.id,
      accessPolicy: "read",
      ...(input.secret_env_name ? { secretEnvName: input.secret_env_name } : {}),
    });
    await foundryApi.testDatasource(ws, ds.id).catch(() => null);
    await foundryApi.refreshSchema(ws, ds.id).catch(() => null);
    return connectionFromFA(await foundryApi.getDatasource(ws, ds.id).catch(() => ds));
  }
  const { type, connectionString } = assembleConnectionString(
    input.connector_id,
    input.payload,
    manifest,
  );
  const ds = await foundryApi.createDatasource(ws, {
    name: input.name,
    type,
    connectionString,
    // Omitted rather than sent empty: `secretEnvName` is regex-validated
    // server-side, so `""` is a 400 on a field nobody filled in.
    ...(input.secret_env_name ? { secretEnvName: input.secret_env_name } : {}),
    ...(input.schema_allowlist?.length ? { schemaAllowlist: input.schema_allowlist } : {}),
    ...(input.accessPolicy ? { accessPolicy: input.accessPolicy } : {}),
  });
  // Test + introspect so the row lands with a schema. These are allowed to fail
  // without failing creation — an unreachable source is a real state the list
  // renders, not a reason to lose the registration.
  await foundryApi.testDatasource(ws, ds.id).catch(() => null);
  await foundryApi.refreshSchema(ws, ds.id).catch(() => null);
  return connectionFromFA(await foundryApi.getDatasource(ws, ds.id).catch(() => ds));
}

/**
 * What a TEST run of this flow will actually READ, per datasource it names.
 *
 * ⚠ **There is no choice here and this is not a picker.** Selection is bound to
 * the Kestra namespace (D-52): a draft run reads the sandbox where one exists
 * and production where it does not, `stepBatchSchema` has no field for it, and
 * nothing in a request can change it. The deleted source picker sent
 * byte-identical requests for both of its cards, which is why it went. This
 * reports the answer the namespace already decided.
 *
 * `mockStatus`/`mockError` ride along from the fixture row when the server
 * serves them (mock endpoint missing ⇒ null, and the sandbox answer stands —
 * the server slices land in parallel, so a 404 here is "not yet", not "no").
 *
 * ⚠ **It THROWS rather than returning an empty list.** "This flow reads no
 * datasource" and "we could not find out" are different facts, and rendering
 * the second as the first is the shape that removed `faFallback` — worst here,
 * because the fact in question is whether real records are about to be read.
 */
export type FlowReadSource = {
  name: string;
  hasSandbox: boolean;
  dbName: string | null;
  /**
   * Mock readiness off the fixture row. `"none"`: the server answered and this datasource has NO mock data — a draft run
   * refuses. `null`: the mock status could not be read, so what the run will do is unknown. Never read either as "reads
   * real records": a draft run reads production only through the explicit opt-in (`runMockBatch` refuses otherwise).
   */
  mockStatus?: "building" | "ready" | "failed" | "none" | null;
  /** The fixture build failure reason, when `mockStatus === "failed"`. */
  mockError?: string | null;
};
export async function flowReadSources(
  refs: string[],
): Promise<FlowReadSource[]> {
  const wanted = [...new Set(refs.map((r) => r.split(".")[0]!).filter(Boolean))].sort();
  if (wanted.length === 0) return [];
  const ws = await resolveWorkspaceId();
  const all = await foundryApi.listDatasources(ws);
  const hits = all.filter((d) => wanted.includes(d.name));
  return Promise.all(
    hits.map(async (d) => {
      const s = await foundryApi.getDatasourceSandbox(ws, d.id);
      // ⚠ Two different absences: the endpoint answered "no fixture" (`none` — the run refuses) versus the read failed
      // (`null` — unknown). Collapsing them used to render a datasource with no mock as "reads real records".
      const m = await foundryApi.getDatasourceMock(ws, d.id).catch(() => null);
      return {
        name: d.name,
        hasSandbox: s.hasSandbox,
        dbName: s.dbName,
        mockStatus: m ? (m.status ?? "none") : null,
        mockError: m?.error ?? null,
      };
    }),
  );
}

export async function listConnections(): Promise<Connection[]> {
  return (await foundryApi.listDatasources(await resolveWorkspaceId())).map(connectionFromFA);
}

export async function getConnection(id: string): Promise<Connection | undefined> {
  const ws = await resolveWorkspaceId();
  try {
    return connectionFromFA(await foundryApi.getDatasource(ws, id));
  } catch (e) {
    if (e instanceof FoundryApiError && e.status === 404) return undefined;
    throw e;
  }
}

export async function getConnectionMetadata(id: string): Promise<AssetNode[]> {
  const ws = await resolveWorkspaceId();
  let entities = await foundryApi.getSchema(ws, id);
  if (!entities.length) {
    // Never introspected, or introspection failed. Try once, then report what is
    // actually there — an empty tree is a true answer.
    await foundryApi.refreshSchema(ws, id).catch(() => null);
    entities = await foundryApi.getSchema(ws, id).catch(() => []);
  }
  return schemaEntitiesToAssetTree(entities, id);
}

/**
 * Replace this data source's column declarations (P5-I11). The server re-reads the schema with them and refuses — naming the
 * column — any it cannot honour, so the saved set is always one that applies.
 */
export async function setConnectionColumnTags(id: string, tags: Record<string, string>): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.updateDatasource(ws, id, { columnTags: tags });
}

export async function refreshConnectionSchema(id: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.refreshSchema(ws, id);
}

export async function testConnection(id: string): Promise<void> {
  const ws = await resolveWorkspaceId();
  await foundryApi.testDatasource(ws, id);
}
/**
 * Mock-data readiness off the fixture row (`mock_status`/`mock_error`). Null
 * status = no fixture row was ever built (not yet onboarded) — distinct from
 * `failed`, which names its reason.
 */
export async function getDatasourceMock(dsId: string) {
  const ws = await resolveWorkspaceId();
  return foundryApi.getDatasourceMock(ws, dsId);
}
/**
 * One page of MOCK rows (10/table in the viewer). This endpoint never serves
 * production — there is no prod-preview endpoint, and the detail page must
 * never grow one.
 */
/**
 * Rebuild this datasource's mock dataset on purpose.
 *
 * ⚠ Distinct from the automatic build on introspection, which DECLINES when a
 * fixture already exists. A person pressing "rebuild" is saying they want a
 * fresh one, so the server forces a new version.
 */
export async function rebuildDatasourceMock(dsId: string) {
  const ws = await resolveWorkspaceId();
  return foundryApi.rebuildDatasourceMock(ws, dsId);
}
export async function getDatasourceMockRows(dsId: string, table: string, page: number, pageSize = 10) {
  const ws = await resolveWorkspaceId();
  return foundryApi.getDatasourceMockRows(ws, dsId, table, page, pageSize);
}
/** Draft step SQL from the introspected schema alone — the model never sees rows. */
export async function proposeDatasourceSql(dsId: string, need: string) {
  const ws = await resolveWorkspaceId();
  return foundryApi.proposeDatasourceSql(ws, dsId, need);
}
/**
 * Attach (or detach, with null) the credential NAME this datasource is
 * referenced by. Names only — values are write-only and never read back, and
 * there is deliberately no endpoint that returns one.
 */
export async function setDatasourceCredentialName(dsId: string, secretEnvName: string | null): Promise<Connection> {
  const ws = await resolveWorkspaceId();
  return connectionFromFA(await foundryApi.updateDatasource(ws, dsId, { secretEnvName }));
}

/**
 * Give a SQLite data source a different database file: upload, then point the
 * row at it. The server checks the new file is this workspace's and unclaimed,
 * and drops the old one.
 */
export async function replaceSqliteFile(id: string, file: File): Promise<Connection> {
  const ws = await resolveWorkspaceId();
  const uploaded = await foundryApi.uploadSqliteFile(ws, file, file.name);
  const ds = await foundryApi.updateDatasource(ws, id, { sqliteFileId: uploaded.id });
  await foundryApi.testDatasource(ws, id).catch(() => null);
  await foundryApi.refreshSchema(ws, id).catch(() => null);
  return connectionFromFA(await foundryApi.getDatasource(ws, id).catch(() => ds));
}

export async function deleteConnection(id: string): Promise<void> {
  await foundryApi.deleteDatasource(await resolveWorkspaceId(), id);
}

/**
 * Pause a data source — **stop showing it to the model** — or resume it.
 *
 * ⚠ **Resuming sends `null`, not a status.** Pause writes `"paused"` into
 * `resource_status`; what the row held before was whatever the server derives
 * from its connection, so clearing the column is the only way back that does
 * not invent a lifecycle state nobody chose. The server's
 * `updateDatasourceSchema` is nullable for exactly this, and says so.
 *
 * ⚠ It does NOT stop anything running. A paused source leaves the manifest and
 * the callable catalogue, so nothing new gets designed against it; every flow
 * already built on it keeps validating and keeps executing, and no armed
 * automation is suspended. Delete is the destructive one.
 */
export async function setDatasourcePaused(id: string, paused: boolean): Promise<Connection> {
  const ws = await resolveWorkspaceId();
  return connectionFromFA(
    await foundryApi.updateDatasource(ws, id, { resourceStatus: paused ? "paused" : null }),
  );
}

// ---- Gate 3: step approvals ---------------------------------------------------
//
// A human decision on ONE execution, mid-flight. Not the same thing as approving
// a revision to run unattended — an armed flow with an approval step still stops
// for a person every run.
//
// ⚠ Rejecting KILLS the run. That is not a harsh default, it is the only correct
// one: Kestra's Pause has no "resume down another branch", so un-pausing a
// rejected run would execute every downstream step — the send would happen,
// having been refused. There is no undo, and a second decision is a 409.
//
// ⚠ The DECIDER is verified since Stage 9.1 — taken from the signed identity the
// proxy forwards, and refused if sent in the body. That still is NOT separation
// of duties and must never be labelled as such: there are no roles, and unlike
// gate 2 there is nobody to compare the decider against (an execution has no
// author). Verifying a name makes it true; it does not make it a control.

export async function listPendingApprovals(): Promise<FAStepApproval[]> {
  return foundryApi.listPendingApprovals(await resolveWorkspaceId());
}

export async function listExecutionApprovals(executionId: string): Promise<FAStepApproval[]> {
  return foundryApi.listExecutionApprovals(await resolveWorkspaceId(), executionId);
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected",
  note?: string,
  /** `question` rows only, keyed by question id. A gate that sends this gets a 400. */
  answers?: Record<string, string | string[]>,
): Promise<FAStepApproval> {
  return foundryApi.decideApproval(await resolveWorkspaceId(), approvalId, {
    decision,
    note,
    answers,
  });
}

// ---- DB operations (Phase 4) ------------------------------------------------
//
// Saved, named, read-only components a `query` step references by
// `<datasource>.<operation>`. The spec is compiled server-side; nothing here
// ever builds or executes SQL, and no endpoint on this path returns data rows.

export async function listOperations(datasourceId: string): Promise<FADatasourceOperation[]> {
  return foundryApi.listOperations(await resolveWorkspaceId(), datasourceId);
}

export async function createOperation(
  datasourceId: string,
  input: FADbOperationInput,
): Promise<FADatasourceOperation> {
  return foundryApi.createOperation(await resolveWorkspaceId(), datasourceId, input);
}

/**
 * Compile-without-save — the builder's SQL preview.
 *
 * ⚠ A refused spec comes back as a VERDICT, not an error: the endpoint always
 * resolves, and `ok: false` carries the structured findings (offending
 * identifier + available schema). Render the problems beside the spec that
 * produced them — the message names the rule and `identifier`/`available` say
 * which identifier broke it and what the schema actually offers.
 */
/**
 * Delete a saved reader. See `foundryApi.deleteOperation` — a 409 naming the
 * flows that read it is the expected answer, not a failure to be swallowed.
 */
export async function deleteOperation(
  datasourceId: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  return foundryApi.deleteOperation(await resolveWorkspaceId(), datasourceId, name, opts);
}

export async function checkOperation(
  datasourceId: string,
  spec: FADbOperationSpec,
): Promise<FADbOperationCheck> {
  return foundryApi.checkOperation(await resolveWorkspaceId(), datasourceId, spec);
}

/**
 * Propose an operation from one sentence — the server reads the introspected
 * schema and answers with a spec, or refuses and names what is missing.
 *
 * ⚠ **Creates nothing** (FR-010). An approved proposal is saved by calling
 * `createOperation` with the reviewed spec, which compiles it again.
 *
 * ⚠ **`status: "insufficient_schema"` is a 200 and a SUCCESS**, not an error —
 * and it MUST NOT be re-asked. Re-asking is how *"no column carries a date"*
 * becomes a confident `created_at` on attempt 2 (FR-008). No Retry button.
 */
export async function proposeOperation(
  datasourceId: string,
  need: string,
): Promise<FAOperationProposalResult> {
  return foundryApi.proposeOperation(await resolveWorkspaceId(), datasourceId, need);
}

// ---- Secrets ----------------------------------------------------------------
//
// The credential model, exactly as the server holds it: a name → an encrypted
// value, per workspace. Tools and datasources reference an entry by its ENV-VAR
// NAME, which is also what the manifest renders — one identifier, so the
// manifest, the prompt, the `-e` flag and the row cannot disagree.
//
// There is deliberately NO endpoint that returns a value, and no `?reveal=`. The
// list reports PRESENCE (`hasValue`), never content. Do not add one "for the UI":
// that is how a credential reaches a devtools network log.

export async function listSecrets(): Promise<WorkspaceSecret[]> {
  return foundryApi.listSecrets(await resolveWorkspaceId());
}

/**
 * Which declared secrets have no stored value, and which names collide.
 *
 * This is the answer to "why did my tool call 401?" before anyone has to ask.
 * A collision is not last-write-wins: it fails the execution with a 409, because
 * a shadowed credential must present as a wrong key rather than as a silent
 * misconfiguration.
 */
export async function auditSecrets(): Promise<SecretAudit> {
  return foundryApi.auditSecrets(await resolveWorkspaceId());
}

/** The Email box. See `EmailBox` in `types.ts` for what `captured` means. */
export async function getEmailBox(limit = 100): Promise<EmailBox> {
  const wsId = await resolveWorkspaceId();
  const box = await foundryApi.getEmailBox(wsId, limit);
  // A held file is opened one at a time from its own route (2026-10-13); the list never carries file contents.
  return {
    ...box,
    foundry: (box.foundry ?? []).map((m) => ({
      ...m,
      attachments: (m.attachments ?? []).map((a) => ({ ...a, href: a.held ? emailAttachmentUrl(wsId, m.id, a.position) : null })),
    })),
  };
}

/** A held message's attachment, through the proxy: the file, `?inline=1` to show it, `?preview=1` for a table. */
export function emailAttachmentUrl(wsId: string, sendId: string, position: number): string {
  return `/api/foundry/workspaces/${wsId}/email-box/${encodeURIComponent(sendId)}/attachments/${position}`;
}

/** Empty this workspace's never-delivered messages (held, refused, failed). Delivered ones stay. */
export async function clearUndeliveredEmails(): Promise<{ ok: true; cleared: number }> {
  return foundryApi.clearUndeliveredEmails(await resolveWorkspaceId());
}

/** Remove one never-delivered message. */
export async function deleteEmail(id: string): Promise<{ ok: true; cleared: number }> {
  return foundryApi.deleteEmail(await resolveWorkspaceId(), id);
}

export async function createSecret(input: {
  name: string;
  value: string;
  description?: string;
  sandboxValue?: string;
}): Promise<WorkspaceSecret> {
  return foundryApi.createSecret(await resolveWorkspaceId(), input);
}

/**
 * What renaming this secret would break, WITHOUT doing it.
 *
 * ⚠ Call this BEFORE a rename, not after. A secret is referenced by its env-var
 * NAME — from tools, and for the agent key from the runtime — so renaming the row
 * leaves those references pointing at a name nothing holds. Nothing refuses, no
 * fingerprint moves, no flow is suspended and no manifest changes. The first sign
 * is a 401 inside a run, hours later.
 */
export async function secretImpact(id: string, newName?: string): Promise<SecretImpact> {
  return foundryApi.secretImpact(await resolveWorkspaceId(), id, newName);
}

/**
 * ⚠ Returns `{ secret, rename }`, and a rename that orphans a reference is
 * refused by the SERVER with a 409 unless `confirmOrphans` is true. That refusal
 * is the control — this function cannot forget it, and neither can a future
 * caller. Ask `secretImpact`, show what breaks, then send the flag.
 */
export async function updateSecret(
  id: string,
  input: {
    name?: string;
    value?: string;
    description?: string;
    sandboxValue?: string | null;
    confirmOrphans?: boolean;
  },
): Promise<{ secret: WorkspaceSecret; rename: SecretRename | null }> {
  return foundryApi.updateSecret(await resolveWorkspaceId(), id, input);
}

export async function deleteSecret(id: string): Promise<void> {
  await foundryApi.deleteSecret(await resolveWorkspaceId(), id);
}

// ---- Credentials (Phase 5, D-01) -------------------------------------------
//
// The unified view across the stores the vault-relay seam owns — one list, one
// search, one modal. `ref` is the env-var name for secrets, the datasource name
// for a DSN, the trigger name for webhook/api. Values never return; `hasValue`
// does. The seam owns the secret store; database/webhook/api rows come from the
// datasource/trigger stores and refuse writes here with a clean 409 (their
// values are managed on the owning pages).

export async function listCredentials(): Promise<CredentialView[]> {
  return foundryApi.listCredentials(await resolveWorkspaceId());
}

/**
 * Create-or-update by ref. `value` omitted → keep the stored one (an edit); a
 * rotate always sends a fresh value. The server's error envelope surfaces in
 * the modal — including the clean 409 for kinds the seam does not own.
 */
export async function upsertCredential(input: {
  kind: CredentialKind;
  name: string;
  label?: string;
  value?: string;
}): Promise<void> {
  await foundryApi.upsertCredential(await resolveWorkspaceId(), input);
}

/** Remove a credential the seam owns. Kinds it does not own refuse with a 409. */
export async function deleteCredential(ref: string): Promise<void> {
  await foundryApi.deleteCredential(await resolveWorkspaceId(), ref);
}

// ---- Identity ---------------------------------------------------------------

// ---- Derived (Dashboard) ----------------------------------------------------
//
// B-03 This month generic — run aggregates for dashboard; flagship demo truth not borrowed.
// B-05 Health derived — no green "all healthy" tile without server health model.
//
// Aggregates whatever `listRuns()` returns, so the numbers describe the
// workspace's real timeline. The app/key health tiles are gone with the mock that
// invented them: there is no server-side app-health model, and a green "5 of 5
// apps working" computed from localStorage is worse than no tile at all.
//
// ⚠ **`homeSummary()` was DELETED with `/home`** (2026-08-04) rather than left as
// an export with no caller. It computed a strict subset of what `dashboardSummary`
// already computes, from the same two calls — so keeping it would have been a
// second definition of "runs today" free to drift from the one on screen.

/** A run as the dashboard lists it. `partial` (some items failed) is its own outcome here — see `HealthRow`. */
export type HealthOutcome = "done" | "partial" | "stopped" | "running";

export type HealthRow = {
  id: string;
  automation: string;
  outcome: HealthOutcome;
  startedBy: import("@/lib/foundry-client").FAStartedBy;
  startedAt: string | null;
  /** Null while running — the row counts up from `startedAt` instead. */
  durationMs: number | null;
  items: { done: number; total: number } | null;
};

export type DashboardData = Omit<import("@/lib/foundry-client").FAFlowRunsSummary, "recent" | "running"> & {
  /** The last few runs, newest first. */
  recent: HealthRow[];
  /** Runs in flight right now. */
  running: HealthRow[];
};

/** How many recent runs the dashboard lists. */
export const DASHBOARD_RECENT = 10;

/**
 * A run's outcome on the dashboard, from the engine's own status — never `flow_executions.status` (D-13).
 * `warning` is "partly done"; anything not yet terminal is still running.
 */
export function healthOutcome(engineStatus: string | null): HealthOutcome {
  if (engineStatus === "success") return "done";
  if (engineStatus === "warning") return "partial";
  if (engineStatus == null || engineStatus === "running" || engineStatus === "created" || engineStatus === "paused") return "running";
  return "stopped";
}

function healthRowOf(e: import("@/lib/foundry-client").FAHealthRun): HealthRow {
  return {
    id: e.id,
    automation: runLabel(e),
    outcome: healthOutcome(e.engineStatus),
    startedBy: e.startedBy,
    startedAt: e.startedAt,
    durationMs: e.durationMs,
    items: e.items ?? null,
  };
}

/**
 * The dashboard's "Runs and health" (2026-10-23): ONE read. The server counts the period and the one before it, the
 * per-day (or per-hour, for today) series, and sends the last DASHBOARD_RECENT runs plus any still going, each with
 * what started it. "Today" is the viewer's day: the start of it is sent from here, in their time zone.
 */
export async function dashboardSummary(opts: {
  range: import("@/lib/foundry-client").FAHealthRange;
  env: import("@/lib/foundry-client").FARunEnv;
  scope: import("@/lib/foundry-client").FARunScope;
}): Promise<DashboardData> {
  const ws = await resolveWorkspaceId();
  const dayStart = new Date(startOfDay(Date.now())).toISOString();
  const s = await foundryApi.flowExecutionsSummary(ws, { dayStart, recent: DASHBOARD_RECENT, ...opts });
  return { ...s, recent: s.recent.map(healthRowOf), running: s.running.map(healthRowOf) };
}

// ---- Workspaces -------------------------------------------------------------
//
// Real CRUD against `/api/workspaces`. This used to be `mockdb`, which meant the
// workspace SWITCHER — the control that scopes every other page — was reading
// localStorage while the pages it scoped read the server. Creating a workspace
// appeared to work and then nothing in it existed.
//
// There is no org or membership model server-side, so `getOrganization` and
// `listMembers` are gone rather than faked. There is no "archive" either: the
// server offers delete, and pretending to archive by hiding a row locally left
// the workspace fully live.

export async function listWorkspaces(opts?: { counts?: boolean }): Promise<Workspace[]> {
  return (await foundryApi.listWorkspaces(opts)).map((w) => ({
    id: w.id,
    name: w.name,
    purpose: w.description ?? undefined,
    assistant: w.assistant === true,
    agentChanges: w.agentChanges === true,
    selfEnable: w.selfEnable !== false,
    webAccess: w.webAccess !== false,
    restricted: w.restricted === true,
    kind: w.kind ?? null,
    ...(w.counts ? { counts: w.counts } : {}),
  }));
}

/** Restricted workspaces the person is outside of: names and admins only (the platform tier and super admins). */
export async function listClosedWorkspaces(): Promise<import("./types").ClosedWorkspace[]> {
  return (await foundryApi.listClosedWorkspaces()).map((w) => ({ id: w.id, name: w.name, admins: w.admins ?? [] }));
}

/** Restrict a workspace or open it up — its own admins only; the server refuses anyone else and says why. */
export async function setWorkspaceRestricted(id: string, restricted: boolean): Promise<void> {
  await foundryApi.setWorkspaceRestricted(id, restricted);
}

/** A super admin asks for emergency access to a restricted workspace. Returns what the server said about telling its admins. */
export async function startEmergencyAccess(input: { workspaceId: string; reason: string; hours: 1 | 2 | 4 }): Promise<{ notified: string; expiresAt: string }> {
  const r = await foundryApi.startEmergencyAccess(input);
  return { notified: r.notified, expiresAt: r.access.expiresAt };
}

export async function listEmergencyAccess(workspaceId: string): Promise<import("./types").EmergencyAccess[]> {
  return (await foundryApi.listEmergencyAccess(workspaceId)).map((a) => ({ ...a, open: a.open === true }));
}

export async function endEmergencyAccess(workspaceId: string, accessId: string): Promise<void> {
  await foundryApi.endEmergencyAccess(workspaceId, accessId);
}

/** A person creating a workspace says what it is for (its purpose) and chooses whether Forge is also an assistant. */
export async function createWorkspace(input: { name: string; purpose: string; assistant: boolean; restricted?: boolean }): Promise<Workspace> {
  const w = await foundryApi.createWorkspace({
    name: input.name,
    description: input.purpose,
    assistant: input.assistant,
    ...(input.restricted ? { restricted: true } : {}),
  });
  return { id: w.id, name: w.name, purpose: w.description ?? undefined, assistant: w.assistant === true, restricted: w.restricted === true };
}

/** Change a workspace's purpose or assistant mode (super admin; the server records the change in its audit log). */
export async function updateWorkspaceSetup(id: string, input: { purpose?: string; assistant?: boolean; agentChanges?: boolean; selfEnable?: boolean; webAccess?: boolean }): Promise<void> {
  await foundryApi.updateWorkspace(id, {
    ...(input.purpose !== undefined ? { description: input.purpose } : {}),
    ...(input.assistant !== undefined ? { assistant: input.assistant } : {}),
    ...(input.agentChanges !== undefined ? { agentChanges: input.agentChanges } : {}),
    ...(input.selfEnable !== undefined ? { selfEnable: input.selfEnable } : {}),
    ...(input.webAccess !== undefined ? { webAccess: input.webAccess } : {}),
  });
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await foundryApi.updateWorkspace(id, { name });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await foundryApi.deleteWorkspace(id);
}

// ⚠ `activeWorkspaceId` WAS RE-EXPORTED HERE, and it is deleted rather than
// rewired (I-103, Phase 1.3). It read localStorage directly and had no consumers
// at all — this re-export included — while all 58 scoped calls in this file
// resolve through `resolveWorkspaceId()`. Two functions answering "which
// workspace am I in" is the defect; a re-export of the losing one is how a third
// consumer would have found it. The display answer is
// `activeFoundryWorkspaceId()` from `lib/foundry-client.ts`, which reports the
// cache these calls actually use.

// ── Workspace membership and roles (GAPS §1.1) ───────────────────────────────
//
// These take an explicit workspace id rather than resolving the active one:
// /organization is the page that shows ALL workspaces, so the panel is rendered
// per row and "the current workspace" is the wrong subject there.
//
// ⚠ **THEY STILL GO THROUGH `scopedWorkspace`, AND THAT IS NOT A CONTRADICTION.**
// It translates ONE value — the `UNRESOLVED_WORKSPACE` placeholder — and passes
// every real id straight through, so `/organization`'s per-row subject is untouched.
// What it closes is the other caller: a page reading the active workspace hands these the workspace
// CONTEXT value, which is the placeholder until the resolver answers.
export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return (await foundryApi.listMembers(await scopedWorkspace(workspaceId))).map((m) => ({
    id: m.id,
    subject: m.subject,
    email: m.email,
    role: m.role,
    grantedBy: m.grantedBy,
  }));
}

// ⚠ `claimWorkspace` was here and is DELETED. It made the first signed-in
// caller the admin of any unclaimed workspace; assignment by a super admin
// replaced it, and `ui-honesty-check.sh` fails if it comes back.

export async function grantMember(
  workspaceId: string,
  body: { subject: string; email: string; role: WorkspaceRole },
): Promise<WorkspaceMember> {
  const m = await foundryApi.grantMember(await scopedWorkspace(workspaceId), body);
  return { id: m.id, subject: m.subject, email: m.email, role: m.role, grantedBy: m.grantedBy };
}

export async function revokeMember(workspaceId: string, subject: string): Promise<void> {
  await foundryApi.revokeMember(await scopedWorkspace(workspaceId), subject);
}

// Audit explorer (S-68, Phase 13) — two views of one immutable record.
// `audit_events` is append-only; the UI renders Plain English and Raw events
// from the same rows. When the table does not exist yet, callers receive a
// thrown error and render the honest unavailable state — B-15.
/**
 * Translate the workspace PLACEHOLDER into the resolved workspace.
 *
 * ── ⚠ WHY ANY FUNCTION NEEDS THIS ───────────────────────────────────────────
 *
 * Almost every scoped call in this file awaits `resolveWorkspaceId()` itself and
 * so never sees a placeholder. The exceptions are the handful a PAGE calls with
 * the workspace-context value as an argument: on first render that value is
 * `UNRESOLVED_WORKSPACE`, which is not a uuid.
 *
 * On 2026-09-08 `GET /api/me?workspaceId=ws_it` reached Postgres, answered
 * `22P02`, and — because `/api/me`'s async handler forwarded nothing — **took
 * the API server down fifteen times**. It presented as *"the new admin cannot
 * see the domains"*, *"the workflows page shows for a moment"* and *"fetch
 * failed"*, because every request in flight died with it.
 *
 * ⚠ The server half is the real fix (`middleware/async-routes.ts`): such a
 * rejection is now a 400 and can take nothing down. This is the other half —
 * do not ask a question with a placeholder in it — and neither makes the other
 * unnecessary. One 400 per page load is still a broken screen.
 *
 * ⚠ **A resolution failure is NOT swallowed.** For `getMe` in particular,
 * answering without a workspace returns no `capabilities`, and every admin page
 * reads a missing capability as *"you are not an admin"* — a wrong answer that
 * looks authoritative on the screen where being wrong matters most.
 *
 * ⚠ `workspace-placeholder.test.ts` asserts that the set of functions a page
 * hands the raw context value to is EXACTLY the set that calls this. A new one
 * added without it turns that test red instead of reintroducing the defect.
 */
async function scopedWorkspace(id: string): Promise<string>;
async function scopedWorkspace(id: string | undefined): Promise<string | undefined>;
async function scopedWorkspace(id: string | undefined): Promise<string | undefined> {
  return id === UNRESOLVED_WORKSPACE ? await resolveWorkspaceId() : id;
}

export async function listAuditEvents(workspaceId: string): Promise<FDAuditEvent[]> {
  return foundryApi.listAuditEvents(await scopedWorkspace(workspaceId)) as Promise<FDAuditEvent[]>;
}
/** One page of the audit record, filtered on the server; `total` is how many the filter matches. */
export async function listAuditPage(
  workspaceId: string,
  p: { q?: string; from?: string; to?: string; limit?: number; offset?: number },
): Promise<{ events: FDAuditEvent[]; total: number }> {
  return foundryApi.listAuditPage(await scopedWorkspace(workspaceId), p) as Promise<{ events: FDAuditEvent[]; total: number }>;
}
// ── Deployment level: who I am, and who this API has seen ────────────────────

/**
 * ⚠ The one place the client learns whether it is a super admin. Never
 * `useSession().user.roles` — see `Me`.
 * With `workspaceId` it also returns `capabilities` (B-06) so admin-cap holders
 * pass the admin gate without being superAdmin.
 */
export async function getMe(workspaceId?: string): Promise<Me> {
  // ⚠ See `scopedWorkspace` — the placeholder must never reach the wire.
  return foundryApi.me(await scopedWorkspace(workspaceId));
}

/**
 * Identities this API has seen, most recent first, WITH the server's caveat.
 *
 * ⚠ The caveat travels with the data rather than being restated in the
 * component, because presenting this as a list of verified users is the failure
 * mode here — the same reason fragment promotion serves its caveat in the
 * payload.
 */
export async function listPlatformUsers(): Promise<{ users: PlatformUser[]; caveat: string }> {
  const r = await foundryApi.listPlatformUsers();
  return {
    users: r.users.map((u) => ({
      subject: u.subject,
      email: u.email,
      name: u.name,
      firstSeenAt: u.firstSeenAt,
      lastSeenAt: u.lastSeenAt,
    })),
    caveat: r.caveat,
  };
}

// ---- The engine's plugin registry (ui-upgrade Phase 9, D-111) ---------------
//
// ⚠ **No `resolveWorkspaceId()`, and that is the point.** Every other read in
// this file is scoped to a workspace. Plugins are a property of the ENGINE'S
// BUILD — Kestra has no per-tenant plugin endpoint, and every workspace on this
// deployment sees the same list. Adding a workspace here would state a registry
// that does not exist.
//
// ⚠ The browser never reaches Kestra: it publishes no port and cannot have one,
// and `kestra-ui` has no tenant isolation. This is a shaped server-side read,
// not a proxy, and it carries no Kestra URL (R5).
export async function listEnginePlugins(): Promise<EnginePlugins> {
  return foundryApi.enginePlugins();
}

/**
 * What one plugin needs in order to authenticate, read from the engine's own
 * schema rather than from a list maintained here.
 *
 * ⚠ Not workspace-scoped, for the same reason `listEnginePlugins` is not: a
 * plugin is a property of the engine's BUILD, and every workspace on this
 * deployment sees the same answer.
 */
export async function pluginCredentials(name: string): Promise<PluginCredentials> {
  return foundryApi.pluginCredentials(name);
}

// ── Local accounts ──────────────────────────────────────────────────────────
//
// ⚠ There is deliberately no wrapper for the sign-in check. `auth.ts` calls
// `POST /api/local-auth/verify` server-side with `PARENT_API_KEY`, because the
// browser must never be the thing that submits a password to a route that
// answers "yes, and here is who that is".

export async function listLocalUsers(): Promise<LocalUser[]> {
  const { users } = await foundryApi.listLocalUsers();
  return users;
}

export async function createLocalUser(input: {
  username: string;
  password: string;
  email?: string;
  name?: string;
}): Promise<LocalUser> {
  const { user } = await foundryApi.createLocalUser(input);
  return user;
}

export async function setLocalUserPassword(id: string, password: string): Promise<void> {
  await foundryApi.setLocalUserPassword(id, password);
}

export async function updateLocalUser(
  id: string,
  input: { username?: string; email?: string | null; name?: string | null },
): Promise<LocalUser> {
  const { user } = await foundryApi.updateLocalUser(id, input);
  return user;
}

export async function deleteLocalUser(id: string): Promise<LocalUser> {
  const { user } = await foundryApi.deleteLocalUser(id);
  return user;
}

export async function setLocalUserActive(id: string, isActive: boolean): Promise<LocalUser> {
  const { user } = await foundryApi.setLocalUserActive(id, isActive);
  return user;
}

/**
 * ── Workspace access for one local account ──────────────────────────────────
 *
 * ⚠ These are NOT `grantMember`/`revokeMember` with a different name. Those
 * take a caller-supplied `subject` and `email`; these take an account ID, and
 * the server derives both from the row. The reason is in the route: a local
 * account that has never signed in is absent from `platform_users`, so the
 * members picker cannot offer it — and an account with no email could not be
 * granted at all, because `grantSchema` validates with `.email()` and the
 * `<username>@local` fallback fails it.
 */
export async function listLocalUserAccess(id: string): Promise<LocalUserAccess[]> {
  return foundryApi.listLocalUserAccess(id);
}

export async function grantLocalUserAccess(
  id: string,
  workspaceId: string,
  role: WorkspaceRole,
): Promise<void> {
  await foundryApi.grantLocalUserAccess(id, workspaceId, role);
}

export async function revokeLocalUserAccess(id: string, workspaceId: string): Promise<void> {
  await foundryApi.revokeLocalUserAccess(id, workspaceId);
}

// ── Admin revamp: incidents, break-glass, release gates, capabilities, budget ──
// Every wrapper resolves the placeholder through `scopedWorkspace` and unwraps
// the envelope key — see `listAuditEvents` above.
export async function listIncidents(workspaceId: string): Promise<FAIncident[]> {
  return (await foundryApi.listIncidents(await scopedWorkspace(workspaceId))).incidents;
}
export async function createIncident(
  workspaceId: string,
  body: { id: string; title: string; severity: FAIncidentSeverity; ownerSubject?: string },
): Promise<FAIncident> {
  return (
    await foundryApi.createIncident(await scopedWorkspace(workspaceId), body)
  ).incident;
}
export async function transitionIncident(
  workspaceId: string,
  id: string,
  status: FAIncidentStatus,
): Promise<FAIncident> {
  return (
    await foundryApi.transitionIncident(await scopedWorkspace(workspaceId), id, status)
  ).incident;
}
export async function activeBreakGlass(workspaceId: string): Promise<FABreakGlassSession[]> {
  return (await foundryApi.activeBreakGlass(await scopedWorkspace(workspaceId))).sessions;
}
export async function activateBreakGlass(
  workspaceId: string,
  body: {
    incidentId: string;
    scope: "hris-unmasked" | "payroll-restricted";
    durationHours: 1 | 2 | 4;
    justification: string;
    acknowledged: true;
  },
): Promise<FABreakGlassSession> {
  return (
    await foundryApi.activateBreakGlass(await scopedWorkspace(workspaceId), body)
  ).session;
}
export async function revokeBreakGlass(
  workspaceId: string,
  id: string,
): Promise<FABreakGlassSession> {
  return (
    await foundryApi.revokeBreakGlass(await scopedWorkspace(workspaceId), id)
  ).session;
}
export async function listReleaseGates(
  workspaceId: string,
  flowId?: string,
): Promise<FAReleaseGate[]> {
  return (await foundryApi.listReleaseGates(await scopedWorkspace(workspaceId), flowId)).gates;
}
export async function setReleaseGateEnabled(
  workspaceId: string,
  gateId: string,
  enabled: boolean,
): Promise<FAReleaseGate> {
  return (
    await foundryApi.setReleaseGateEnabled(await scopedWorkspace(workspaceId), gateId, enabled)
  ).gate;
}
export async function listMemberCapabilities(
  workspaceId: string,
): Promise<FAMemberCapability[]> {
  return (await foundryApi.listMemberCapabilities(await scopedWorkspace(workspaceId))).capabilities;
}
export async function grantMemberCapability(
  workspaceId: string,
  subject: string,
  capability: string,
): Promise<{ ok: true }> {
  return foundryApi.grantMemberCapability(await scopedWorkspace(workspaceId), subject, capability);
}
export async function revokeMemberCapability(
  workspaceId: string,
  subject: string,
  capability: string,
): Promise<{ ok: true }> {
  return foundryApi.revokeMemberCapability(await scopedWorkspace(workspaceId), subject, capability);
}
/**
 * ── ⚠ CUSTOM ROLES — THESE SIX EXIST FOR ONE REASON: `scopedWorkspace` ────────
 *
 * `WorkspaceRolesPanel` and `RoleHolders` called `foundryApi.*` DIRECTLY with the
 * workspace-context value. On first render that value is `UNRESOLVED_WORKSPACE`
 * (`ws_it`), so `GET /api/workspaces/ws_it/roles` went to the wire, answered
 * `22P02`, and the roles list rendered *"could not be read"* — the reported
 * *"built-in role descriptions sometimes do not load; reloading fixes it"*.
 *
 * ⚠ **IT WAS INTERMITTENT BECAUSE THE RECOVERY WAS A COINCIDENCE.** Nothing in
 * the panel retried; what sometimes saved it was `app/(app)/layout.tsx`'s
 * `key={workspaceId}` remounting `<main>` when the real id landed. Whether that
 * happened before or after the read depended on whether `_wsId` was already
 * warm — which is exactly why a hard load failed and a reload did not.
 *
 * ⚠ **`workspace-placeholder.test.ts`'s CONTROL WAS ALREADY RED ON THIS**, naming
 * `listWorkspaceRoles`, `createWorkspaceRole` and `retireWorkspaceRole`. The
 * guard was right and nobody had run it; the fix is the one it asks for — route
 * the call through a function that translates the placeholder — and not a
 * widening of the guard.
 */
export async function listWorkspaceRoles(workspaceId: string): Promise<WorkspaceRoleSummary[]> {
  const r = await foundryApi.listWorkspaceRoles(await scopedWorkspace(workspaceId));
  return r.roles as unknown as WorkspaceRoleSummary[];
}
export async function createWorkspaceRole(
  workspaceId: string,
  body: { name: string; description?: string | null; permissions: string[] },
): Promise<void> {
  await foundryApi.createWorkspaceRole(await scopedWorkspace(workspaceId), body);
}
export async function retireWorkspaceRole(
  workspaceId: string,
  roleId: string,
  confirm = false,
): Promise<void> {
  await foundryApi.retireWorkspaceRole(await scopedWorkspace(workspaceId), roleId, confirm);
}
export async function listWorkspaceRoleMembers(
  workspaceId: string,
  roleId: string,
): Promise<FAWorkspaceRoleMember[]> {
  const r = await foundryApi.listWorkspaceRoleMembers(await scopedWorkspace(workspaceId), roleId);
  return r.members;
}
export async function assignWorkspaceRole(
  workspaceId: string,
  roleId: string,
  subject: string,
): Promise<void> {
  await foundryApi.assignWorkspaceRole(await scopedWorkspace(workspaceId), roleId, subject);
}
export async function unassignWorkspaceRole(
  workspaceId: string,
  roleId: string,
  subject: string,
): Promise<void> {
  await foundryApi.unassignWorkspaceRole(await scopedWorkspace(workspaceId), roleId, subject);
}
export async function getBudget(workspaceId: string): Promise<FABudget> {
  return foundryApi.getBudget(await scopedWorkspace(workspaceId));
}
export async function setBudget(
  workspaceId: string,
  body: { maxConcurrentExecutions?: number; maxTokensPerDay?: number | null },
): Promise<FABudget> {
  return foundryApi.setBudget(await scopedWorkspace(workspaceId), body);
}
export async function clearBudget(workspaceId: string): Promise<FABudget> {
  return foundryApi.clearBudget(await scopedWorkspace(workspaceId));
}
export async function getApprovalFigures(
  workspaceId: string,
): Promise<{ pendingYourApproval: number; inFlight: number }> {
  return foundryApi.getApprovalFigures(await scopedWorkspace(workspaceId));
}

// ── Connectors (plans/plugins-2026-10-27) ───────────────────────────────────────────────────────────────────────────
//
// ⚠ Two tiers. A workspace's connections and enabled actions are workspace-scoped like every read here; INSTALLING is
// deployment-wide, so those four carry no workspace (the `listEnginePlugins` reasoning, for a real registry this time).
// No function here returns a connection's value — create and rotate take one; everything answers names only.

export async function connectorMarketplace(): Promise<ConnectorMarketplace> {
  return foundryApi.connectorMarketplace(await resolveWorkspaceId());
}
export async function listWorkspaceConnectors(): Promise<WorkspaceConnector[]> {
  return foundryApi.workspaceConnectors(await resolveWorkspaceId());
}
export async function createConnectorConnection(short: string, body: { label: string; authType?: string; fields: Record<string, string | number | boolean>; asMe?: boolean }) {
  return foundryApi.createConnection(await resolveWorkspaceId(), short, body);
}
export async function updateConnectorConnection(id: string, body: { label?: string; fields?: Record<string, string | number | boolean> }) {
  return foundryApi.updateConnection(await resolveWorkspaceId(), id, body);
}
export async function testConnectorConnection(id: string): Promise<ConnectionTestResult> {
  return foundryApi.testConnection(await resolveWorkspaceId(), id);
}
export async function deleteConnectorConnection(id: string): Promise<void> {
  await foundryApi.deleteConnection(await resolveWorkspaceId(), id);
}
export async function setConnectorActions(short: string, connectionId: string, actions: string[]): Promise<WorkspaceConnector> {
  return foundryApi.setConnectorActions(await resolveWorkspaceId(), short, { connectionId, actions });
}
/** Declared API calls on a connector: this workspace's, and the packs offered for it. */
export async function listDeclaredCalls(short: string) {
  return foundryApi.declaredCalls(await resolveWorkspaceId(), short);
}
export async function declareCall(short: string, connectionId: string, call: import("./types").DeclaredCallInput) {
  return foundryApi.declareCall(await resolveWorkspaceId(), short, { connectionId, call });
}
export async function enableCallPack(short: string, pack: string, connectionId: string) {
  return foundryApi.enableCallPack(await resolveWorkspaceId(), short, pack, connectionId);
}
export async function removeDeclaredCall(short: string, name: string) {
  return foundryApi.removeDeclaredCall(await resolveWorkspaceId(), short, name);
}
// For me (plans/personal-actions-2026-10-29).
export async function personalConnector(short: string) {
  return foundryApi.personalConnector(await resolveWorkspaceId(), short);
}
export async function setMyConnectorActions(short: string, actions: string[]) {
  return foundryApi.setMyConnectorActions(await resolveWorkspaceId(), short, actions);
}
export async function enableMyCallPack(short: string, pack: string) {
  return foundryApi.enableMyCallPack(await resolveWorkspaceId(), short, pack);
}
export async function removeMyDeclaredCall(short: string, name: string) {
  return foundryApi.removeMyDeclaredCall(await resolveWorkspaceId(), short, name);
}
export async function setPersonalUse(short: string, allowed: boolean) {
  return foundryApi.setPersonalUse(await resolveWorkspaceId(), short, allowed);
}
export async function listConnectorInstalls(): Promise<ConnectorInstall[]> {
  return foundryApi.connectorInstalls();
}
export async function installConnector(piece: string, opts: { version?: string; hosts?: string[] } = {}): Promise<ConnectorInstall> {
  return foundryApi.installConnector({ piece, ...opts });
}
export async function setConnectorHosts(short: string, hosts: string[]): Promise<ConnectorInstall> {
  return foundryApi.setConnectorHosts(short, hosts);
}
export async function upgradeConnector(short: string, version: string) {
  return foundryApi.upgradeConnector(short, version);
}
export async function uninstallConnector(short: string): Promise<void> {
  await foundryApi.uninstallConnector(short);
}

export async function connectorOauthApp(short: string): Promise<ConnectorOauthApp> {
  return foundryApi.connectorOauthApp(short);
}
export async function setConnectorOauthApp(short: string, body: { useSignInApp?: boolean; clientId?: string; clientSecret?: string; scopes?: string[] }): Promise<ConnectorOauthApp> {
  return foundryApi.setConnectorOauthApp(short, body);
}
export async function removeConnectorOauthApp(short: string): Promise<void> {
  return foundryApi.removeConnectorOauthApp(short);
}
export async function startConnectorOauth(short: string, body: { label?: string; connectionId?: string; asMe?: boolean; props?: Record<string, string | number | boolean> }) {
  return foundryApi.startConnectorOauth(await resolveWorkspaceId(), short, body);
}
