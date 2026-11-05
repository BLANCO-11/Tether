import type { SQL } from "drizzle-orm";
/**
 * Phase 2 — the read model behind the step graph.
 * archive/kestra-migration/progress/phase-2.md · 07 §7.3
 *
 * Phase 2's exit criterion is that an engineer diagnoses a **deliberately broken
 * step from the Foundry UI alone** — without opening `kestra-ui` and without
 * reading the tool call log. That sets the bar for what this returns: not "the
 * execution failed" but *which* step, with what input, against what response, and
 * what the engine logged while doing it.
 *
 * ── Why the assembly happens HERE and not in the client ──────────────────────
 *
 * Three reasons, in order of how badly each would bite:
 *
 *   1. **R5.** Clients never reach Kestra. If the browser fetched the execution
 *      itself, Kestra would need to be routable from a client — the boundary the
 *      whole `internal: true` network exists to hold.
 *   2. **D-07.** `begin`'s response body contains the execution token and Kestra
 *      persists task outputs. Redacting in the client would be theatre: the
 *      token would already have been sent over the wire. It is removed here,
 *      before the payload leaves the server.
 *   3. **R6.** Kestra owns status, timing and I/O; Foundry owns the pointer rows
 *      and its own metadata. Something has to join them, and doing it in the
 *      client would mean the client knowing both schemas.
 */
import { kestra, namespaceFor, KestraError, type KestraExecution, type KestraTaskRun } from "./kestra-client.service.js";
import { runnerEngineStatus, runnerSteps } from "./flow-visibility-runner.js";
import { runnerStepResultRepo } from "../repositories/runner-step-result.repo.js";
import { RUNNER_EXECUTION_PREFIX } from "./flow-runner.service.js";
import { flowExecutionRepo, flowStepRunRepo } from "../repositories/flow-execution.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { foldLoopItems, type RunRef } from "./flow-visibility-loops.js";
import { redactSecrets, redactJsonString, REDACTED } from "../utils/redact.js";

/**
 * Steps whose response body is redacted WHOLESALE rather than key-by-key.
 *
 * `begin` is the token mint. Key-name redaction already catches the `token`
 * field, and that is the real control — this is the belt to its braces, because
 * a future change to the `begin` response shape (a `credentials` object, a
 * differently-named field) would slip past a key match and nobody would notice
 * until it was rendered in a browser.
 *
 * Verified 2026-07-29 against a live execution: `begin` is the ONLY task whose
 * persisted output carries the token. Kestra stores response headers, not request
 * headers, so the `Authorization: Bearer` on every other step is not retained.
 * Do not treat that as permanent — the key-name pass runs over every step for
 * exactly that reason.
 */
const OPAQUE_STEPS = new Set(["begin"]);

export type StepStatus =
  | "created"
  | "running"
  | "paused"
  | "success"
  | "warning"
  | "failed"
  | "cancelled"
  | "skipped";

/** Kestra's state vocabulary → the UI's. Unknown states degrade to "running", never to "success". */
function toStatus(kestraState: string | undefined): StepStatus {
  switch (kestraState) {
    case "SUCCESS":
      return "success";
    case "WARNING":
      return "warning";
    case "FAILED":
      return "failed";
    case "KILLED":
    case "CANCELLED":
      return "cancelled";
    case "PAUSED":
      return "paused";
    case "SKIPPED":
      return "skipped";
    case "CREATED":
    case "QUEUED":
      return "created";
    default:
      // A state this code does not know about is IN DOUBT, and a green pill on a
      // step nobody understands is exactly the "enabled trigger means it ran
      // correctly" mistake CLAUDE.md warns about.
      return "running";
  }
}

export interface StepLog {
  timestamp: string;
  level: string;
  message: string;
}

export type StepCheck = {
  output: string;
  field?: string;
  rows?: number | null;
  empty?: number;
  verdict: "ok" | "partial" | "allowed" | "failed";
  reason?: string;
};

export interface StepView {
  /** The task id in the flow — stable across executions, so it addresses a STEP not a run. */
  stepId: string;
  /**
   * For each (phase F, D-367): on a LOOP's view, one entry per item in input order — its status, the steps it ran, the first
   * error, its result. On a body step's view, `perItem` counts the items it ran for and `loop` names its loop; its `output`
   * is null there, because one item's output is not the step's. See `flow-visibility-loops.ts`.
   */
  items?: import("./flow-visibility-loops.js").LoopItem[];
  perItem?: import("./flow-visibility-loops.js").PerItem;
  loop?: string;
  status: StepStatus;
  /**
   * `tool` / `datasource` / `query` / `agent` … — the DECLARED kind, from
   * `flow_steps` at the execution's own revision, falling back to the Foundry
   * pointer row.
   *
   * ⚠ **That order is a safety fix, not a preference** (I-52). It used to read
   * the pointer row and only the pointer row, and a pointer row exists only for
   * a step that called back into Foundry. An `agent` step that failed while
   * Kestra was still *rendering its expression* never called anything, so its
   * kind came back `null`, it drew as an unclassified engine task — and
   * `seamOf(null, …)` returns `null`, so **the model-seam badge vanished from
   * the one node in the flow that sends this workspace's data to an external
   * model.** A privacy marker that disappears exactly when a step goes wrong is
   * a marker that fails open, and Stage 2's rule is that it fails closed.
   *
   * Null now means only what it should: a task the flow model never declared —
   * `begin`, `complete`, an `_await` pause. See `platform` below.
   */
  kind: string | null;
  /**
   * True for a task the COMPILER emitted rather than a step anybody wrote.
   *
   * `begin` (mints the execution credential, re-checks the approval gate, takes
   * the M3 slot), `complete` (writes the terminal row, burns the credential),
   * and — for every `agent` step — the `_await` pause and its `_await_check`.
   * So a two-step flow with one agent step is **six** Kestra tasks, which is
   * correct and reads as inexplicable if the picture does not say which four are
   * the platform's.
   *
   * ⚠ Reported, never filtered. `begin` is where the approval gate and the
   * budget check happen; a run that failed there failed for a reason worth
   * seeing, and hiding it would make the most important failure the invisible
   * one.
   */
  platform: boolean;
  /**
   * The catalogue entry this step calls — a tool name or a named query. Null for
   * kinds that reference nothing (`code`, `transform`, `approval`) and for any
   * step whose revision could not be read.
   *
   * ── Why the read surface grew a field ────────────────────────────────────
   *
   * The canvas marks every node that sends data to an external model: an `agent`
   * step, or a `tool` step whose ref is `llm_complete`. `kind` alone answers the
   * first and cannot answer the second, so without this the run view would draw
   * an `llm_complete` call as an ordinary tool — a **false negative on a privacy
   * marker**, which is worse than not marking at all.
   *
   * It is not a redaction concern: a ref is a name from the workspace's own
   * catalogue, already rendered on `/tools` and inside the manifest. It is joined
   * from `flow_steps` at the execution's OWN revision (R5/§6.5 — approval binds
   * to a revision), never from the flow's current draft, or a run would be
   * described using a definition it did not execute.
   */
  ref: string | null;
  /**
   * `sandbox` | `production` | null — which database this `datasource` or
   * `query` step read (Stage 4, D-52 — both kinds dial the read-only DSN
   * through `runSqlBatch`, so both stamp the same field). Null for every other
   * kind, and for a step that never reached Foundry.
   *
   * ── Why it is on the run and not only on the datasource ───────────────────
   *
   * "Does this workspace have a sandbox" is a question about configuration
   * today; "did THIS run read the tenant's database" is a question about an
   * event that already happened, and only the second one can be answered after
   * somebody has provisioned a sandbox in the meantime. Read from
   * `flow_step_runs.read_from`, which is stamped at callback time.
   */
  readFrom: string | null;
  /**
   * How many times the engine ran this task. `> 1` means a `retry:` block fired.
   *
   * Derived from `attempts.length`, because there is no scalar to read — see
   * `KestraTaskRun.attempts`. It read a non-existent `tr.attempt` until Stage 4,
   * which made the UI's "attempt N" badge unreachable.
   */
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** Where the step called, and with what method. Never the credential it used. */
  request: { uri: string; method: string } | null;
  /** HTTP status for `http.Request` steps. */
  responseCode: number | null;
  /** The step's own output, REDACTED. `body` is Kestra's JSON string; `value` is a native task's rendered output. */
  output: { body?: string; value?: string; [k: string]: unknown } | null;
  /**
   * What the step was GIVEN — `{params, inputs}` after binding, REDACTED. Runner runs only (pi-runtime P4): a Kestra
   * task's rendered inputs are not retained. Absent rather than null where the engine cannot say.
   */
  input?: { params?: Record<string, unknown>; inputs?: Record<string, unknown> } | null;
  /**
   * What the step returned, checked against what it declared (flow-runner checks.py): per output, and per field
   * that was empty in some or every row. Runner runs only; names and counts, never a value.
   */
  checks?: StepCheck[] | null;
  /**
   * The runner's own word for how this step ended (pi-runtime P5/P7) — finer than `status`: `not_taken` (the other
   * side of a branch), `waiting` (an approval), `partial` (a loop where some items failed), `rejected`, `expired`.
   * Runner runs only.
   */
  outcome?: string | null;
  /** Why it did not run, for `not_taken` and `skipped` ("route took path 1", "not run: find failed"). */
  reason?: string | null;
  /** Present when the step failed. The single most important field for the exit criterion. */
  error: string | null;
  logs: StepLog[];
  /** Foundry-side metadata Kestra has no concept of. */
  kestraTaskrunId: string | null;
  auditVerdict: string | null;
  oracleScore: number | null;
}

export interface ExecutionView {
  /** Foundry's id. The client never sees a Kestra execution id — it is not addressable by a client (R5). */
  id: string;
  workspaceId: string;
  /**
   * FOUNDRY's flow id — the uuid `/flows/:flowId` takes, `FAFlow.id` carries and
   * `replayOfId` is drawn from. An identifier, and usable as one.
   *
   * ⚠ It used to be `kestraFlowId`, the engine's slug (I-23). Nothing broke,
   * because the only consumers rendered it as a label — and that is the point:
   * two id spaces under one name type-check, read correctly and stay wrong. A
   * client filtering this list by the uuid it holds got **zero rows**, which is
   * indistinguishable from "this flow has never run", and a deleted-and-recreated
   * flow reuses the slug so two different flows became one.
   *
   * **NULL for flowless history.** `flow_executions.flow_id` is nullable
   * (`ON DELETE SET NULL`, and Phase-1 runs predate the `flows` table), so a run
   * whose flow has been deleted keeps its record and loses its link. Use
   * `flowName` for the label in that case — never this.
   */
  flowId: string | null;
  /**
   * The flow's slug, for DISPLAY. Never null — `flow_executions.kestra_flow_id`
   * is `NOT NULL`, and it is copied onto the row at `begin`, so it survives the
   * flow being deleted.
   *
   * Not an address: reaching a flow in Kestra needs the namespace as well, and
   * the namespace is not on this view and must not be added (R5, I-22). This
   * field exists so that removing the slug from `flowId` did not cost the UI its
   * only human-readable name for a run.
   */
  flowName: string;
  /**
   * The flow's `name` as it was at the moment THIS run began — frozen, so a
   * later rename never relabels a run that already happened. Null for any run
   * from before this column existed; the client falls back to `flowName` (the
   * slug) for those, same as it always has.
   */
  flowNameSnapshot: string | null;
  /**
   * The flow's `id` as it was at the moment THIS run began — frozen, same
   * rule as `flowNameSnapshot` immediately above, applied to the id instead
   * of the name. Null for any run from before this column existed; the
   * client falls back to `flowId` (the live pointer, itself null if the flow
   * has since been deleted) for those.
   */
  flowIdSnapshot: string | null;
  status: string;
  /** Kestra's live state, which can lead the Foundry row: `complete` is a task and a failure never reaches it. */
  engineStatus: StepStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputs: Record<string, unknown>;
  steps: StepView[];
  /** Topology from Kestra, not inferred from step order. */
  graph: { nodes: Array<{ id: string; type: string | null }>; edges: Array<{ source: string; target: string }> } | null;
  /** Set when Kestra could not be reached; the Foundry-side fields are still populated. */
  engineUnavailable?: string;
  /**
   * The run this one is a REPLAY of, and the step it resumed from (6.1). Null for
   * an ordinary run.
   *
   * Surfaced because two `succeeded` rows with no link between them read as two
   * working runs — the same misreading D-14 exists to prevent, one level along.
   * A Foundry id, so it is a link a client can follow; the engine's id for the
   * original is still not addressable (R5).
   */
  replayOfId: string | null;
  replayFromStep: string | null;
  /**
   * True when this draft run was started with the admin production opt-in — its reads used production, not test
   * data. Execution-level because a runner step does not record which database it read; `readFrom` per step stays
   * the finer answer where the engine has it.
   */
  usedProductionData: boolean;
  /** The Pi builder's automatic test after a build turn, not a run a person started. */
  autoTest: boolean;
  /** Who asked — GAPS §1.1b. `schedule` | `trigger` | `user` | `replay` | `system` | `unknown`. */
  requestedBy: string | null;
  requestedByKind: string;
  /** Whose own account it acted as (0124); NULL = the workspace's connections only. */
  actsAsSubject: string | null;
  /** Set when what it did is not this viewer's to see — see `statusOnly`. */
  dataHidden?: true;
}

function histories(tr: KestraTaskRun): Array<{ state: string; date: string }> {
  return tr.state.histories ?? [];
}

function timing(tr: KestraTaskRun) {
  const h = histories(tr);
  if (!h.length) return { startedAt: null, endedAt: null, durationMs: null };
  const startedAt = h[0].date;
  const last = h[h.length - 1];
  const terminal = ["SUCCESS", "WARNING", "FAILED", "KILLED", "CANCELLED"].includes(last.state);
  return {
    startedAt,
    endedAt: terminal ? last.date : null,
    durationMs: terminal ? Date.parse(last.date) - Date.parse(startedAt) : null,
  };
}

/**
 * Strip credentials from one taskrun's outputs.
 *
 * Two passes, deliberately overlapping. The key-name pass runs over EVERY step
 * (see `utils/redact.ts` for why matching names beats matching values); the
 * opaque-step pass replaces the whole body for the token mint.
 */
function redactOutputs(taskId: string, outputs: Record<string, unknown> | undefined) {
  if (!outputs) return null;
  const out = redactSecrets(outputs) as Record<string, unknown>;

  // `outputs.body` is a JSON *string*, so the object walk above never enters it.
  if (typeof out.body === "string") out.body = redactJsonString(out.body);
  if (typeof out.value === "string") out.value = redactJsonString(out.value);

  if (OPAQUE_STEPS.has(taskId)) {
    if ("body" in out) out.body = REDACTED;
    if ("value" in out) out.value = REDACTED;
  }
  return out;
}

/** The message a human needs. Kestra puts the failure in the taskrun's ERROR logs. */
function errorFor(tr: KestraTaskRun, logs: StepLog[]): string | null {
  if (!["FAILED", "WARNING"].includes(tr.state.current)) return null;
  const errs = logs.filter((l) => l.level === "ERROR");
  if (errs.length) return errs.map((l) => l.message).join("\n");
  return `step ${tr.state.current.toLowerCase()} with no error log`;
}

/**
 * The HTTP status of a FAILED `http.Request` step.
 *
 * Kestra populates `outputs.code` only on success — a failed step has no outputs
 * at all, and the status is prose inside the error log
 * (`Failed http request with response code '502' and body:…`). Without this the
 * UI shows `http=—` on precisely the step someone opened the page to understand.
 */
const HTTP_CODE_IN_ERROR = /response code '(\d{3})'/;

function responseCodeFor(tr: KestraTaskRun, error: string | null): number | null {
  if (typeof tr.outputs?.code === "number") return tr.outputs.code as number;
  const m = error?.match(HTTP_CODE_IN_ERROR);
  return m ? Number(m[1]) : null;
}

/**
 * Exported for `flow-visibility.test.ts` and for nothing else.
 *
 * Justified by the bug that made it necessary: this function read a
 * `tr.attempt` scalar Kestra does not publish, so `?? 1` was the only branch
 * that ever ran and the UI's retry badge was unreachable for two phases. It was
 * invisible to review (the field is declared on the type), invisible to the
 * typechecker, and invisible to every test — because nothing emitted a `retry:`
 * block, so no fixture ever had more than one attempt.
 */
export function buildSteps(
  execution: KestraExecution,
  logsByTask: Map<string, StepLog[]>,
  pointers: Map<string, { kind: string; kestraTaskrunId: string | null; auditVerdict: string | null; oracleScore: number | null; readFrom: string | null }>,
  /**
   * `stepId → {kind, ref}`, from `flow_steps` at the execution's own revision.
   *
   * A separate map from `pointers` rather than a field on it, because the two
   * have different origins and different failure modes: a pointer row exists
   * only for steps that called back into Foundry, while this comes from the
   * immutable revision and exists whether or not the step ever ran. Empty when
   * the execution predates the `flows` model (Phase-1 history has no revision).
   *
   * ⚠ It is also what decides `platform`: a task with no entry here is one the
   * compiler emitted, not one anybody declared.
   */
  declared: Map<string, { kind: string; ref: string | null }> = new Map(),
): StepView[] {
  // A FAILED http.Request has no outputs, so the URI it called is only in the
  // task definition. Recovered from the flow graph so the detail panel can still
  // say WHERE the step went — the first thing anyone asks about a 502.
  const runs = execution.taskRunList ?? [];
  // For each (D-367): a loop's body reports one taskrun per item; folded to one view per step, the items on the loop's view.
  return foldLoopItems(runs.map((tr) => {
    const logs = logsByTask.get(tr.taskId) ?? [];
    const outputs = redactOutputs(tr.taskId, tr.outputs);
    const pointer = pointers.get(tr.taskId);
    const error = errorFor(tr, logs);
    const uri =
      typeof tr.outputs?.uri === "string"
        ? (tr.outputs.uri as string)
        : (logs.find((l) => l.message.startsWith("Request '"))?.message.match(/Request '([^']+)'/)?.[1] ?? null);
    const model = declared.get(tr.taskId);
    return {
      stepId: tr.taskId,
      status: toStatus(tr.state.current),
      // The DECLARATION first — see the field's docblock. The pointer row is the
      // fallback, and it is the only source for an execution old enough to have
      // no revision behind it.
      kind: model?.kind ?? pointer?.kind ?? null,
      ref: model?.ref ?? null,
      // ⚠ Empty `declared` means the revision could not be read, not that every
      // task is the platform's. Claiming otherwise would label a whole run as
      // machinery on Phase-1 history.
      platform: declared.size > 0 && !model,
      attempt: tr.attempts?.length ?? 1,
      ...timing(tr),
      request: uri ? { uri, method: "POST" } : null,
      responseCode: responseCodeFor(tr, error),
      output: outputs,
      error,
      logs,
      kestraTaskrunId: pointer?.kestraTaskrunId ?? tr.id,
      auditVerdict: pointer?.auditVerdict ?? null,
      oracleScore: pointer?.oracleScore ?? null,
      readFrom: pointer?.readFrom ?? null,
    };
  }), runs as RunRef[], (taskId) => declared.get(taskId)?.kind === "for_each");
}

/**
 * Kestra's graph → the UI's step graph.
 *
 * Kestra addresses nodes by a hierarchical uid (`root.begin`) and includes two
 * synthetic ones, `GraphClusterRoot` and `GraphClusterEnd`, that are not steps.
 * Both are dropped, and edges are kept only where BOTH ends are real tasks — so a
 * seven-task linear flow yields seven nodes and six edges rather than nine and
 * eight.
 *
 * Nodes are keyed by `task.id`, the same key as `taskRunList[].taskId` and
 * `flow_step_runs.step_id`, so the graph, the runtime state and Foundry's
 * pointers all join on one identifier.
 */
function toStepGraph(raw: Awaited<ReturnType<typeof kestra.getFlowGraph>>): ExecutionView["graph"] {
  const uidToStep = new Map<string, string>();
  const nodes: Array<{ id: string; type: string | null }> = [];

  for (const n of raw.nodes ?? []) {
    const stepId = n.task?.id;
    const uid = n.uid ?? n.id;
    if (!stepId || !uid) continue; // root / end markers carry no task
    uidToStep.set(uid, stepId);
    nodes.push({ id: stepId, type: n.task?.type ?? null });
  }

  const seen = new Set<string>();
  const edges: Array<{ source: string; target: string }> = [];
  for (const e of raw.edges ?? []) {
    const source = uidToStep.get(e.source);
    const target = uidToStep.get(e.target);
    if (!source || !target) continue;
    const key = `${source}→${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source, target });
  }
  return { nodes, edges };
}

/**
 * Live engine state for the KESTRA runs among `rows`, keyed by Kestra execution id. A flow-runner run has no engine
 * record (its row is its status), so a page with no Kestra run asks Kestra nothing — it used to ask on every list,
 * ~0.2s for nothing on a deployment whose runs are all Forge's (2026-10-11).
 */
export async function engineStates(workspaceId: string, rows: Array<{ kestraExecutionId: string }>, limit: number): Promise<Map<string, StepStatus>> {
  const engineState = new Map<string, StepStatus>();
  if (rows.every((r) => r.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX))) return engineState;
  const workspace = await workspaceRepo.get(workspaceId);
  if (workspace?.slug && workspace.tenantSlug) {
    try {
      const ns = namespaceFor(workspace.tenantSlug, workspace.slug);
      // Not `size: limit`. Foundry rows and Kestra executions are not the same
      // set — a run refused at `begin` has a Foundry row and no Kestra record,
      // and a purged one is the reverse — so asking for exactly `limit` engine
      // rows leaves the tail of a short page with no live state.
      //
      // `listExecutions` sorts newest-first. It has to: Kestra's default is
      // OLDEST first, which returned a window that did not overlap this page at
      // all once the instance had more than `size` executions, leaving every
      // row's `engineStatus` null (I-12).
      const page = await kestra.listExecutions(ns, { size: Math.min(Math.max(limit, 50), 200) });
      for (const e of page.results ?? []) engineState.set(e.id, toStatus(e.state.current));
    } catch (e) {
      // A list that renders without live state is far better than a list that
      // 500s because the engine is restarting — but say so. A silent catch here
      // is what let I-12 present as "engineStatus is just null sometimes".
      console.warn(`[flow-visibility] engine state unavailable for workspace ${workspaceId}: ${(e as Error).message}`);
    }
  }

  return engineState;
}

/**
 * The Foundry-side half of an execution view — everything readable without
 * asking the engine anything.
 *
 * ⚠ It is ONE function on purpose. `list()` and `get()` used to build this shape
 * separately, and I-23 was therefore two identical bugs rather than one: both
 * set `flowId: r.kestraFlowId`, and fixing either alone would have left the two
 * routes disagreeing about what `flowId` means — which is worse than both being
 * wrong, because then only one of them is worth trusting and nothing says which.
 *
 * Exported so the mapping is testable without a database or an engine: the field
 * that was wrong is a pure projection of a row, and the test that catches it
 * coming back has to be able to see it.
 */
export function executionBase(r: {
  id: string;
  workspaceId: string;
  flowId: string | null;
  kestraFlowId: string;
  flowNameSnapshot: string | null;
  flowIdSnapshot: string | null;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  inputsJson: unknown;
  replayOfId: string | null;
  replayFromStep: string | null;
  requestedBy: string | null;
  /**
   * Nullable on the ROW and never on the view — this function defaults it to
   * `unknown`, so a client cannot receive a run with no answer to "who asked".
   * The 111 rows that predate migration 0029 are exactly that case.
   */
  requestedByKind: string | null;
  useProdOverride?: boolean | null;
  autoTest?: boolean | null;
  actsAsSubject?: string | null;
}): Omit<ExecutionView, "engineStatus" | "steps" | "graph"> {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    flowId: r.flowId ?? null,
    flowName: r.kestraFlowId,
    flowNameSnapshot: r.flowNameSnapshot ?? null,
    flowIdSnapshot: r.flowIdSnapshot ?? null,
    status: r.status,
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    durationMs: r.startedAt && r.endedAt ? r.endedAt.getTime() - r.startedAt.getTime() : null,
    inputs: (r.inputsJson ?? {}) as Record<string, unknown>,
    replayOfId: r.replayOfId ?? null,
    replayFromStep: r.replayFromStep ?? null,
    usedProductionData: r.useProdOverride === true,
    autoTest: r.autoTest === true,
    /**
     * Who asked for this run — GAPS §1.1b, D-70.
     *
     * ⚠ On the SUMMARY, not just the detail, and reported for every run
     * including the boring ones. A field that appears only when a person was
     * involved is a field nobody builds a habit of reading — the same argument
     * `readFrom` makes (D-52). `schedule`, `trigger` and `system` are answers,
     * and `unknown` means the record predates the column rather than that
     * nobody asked.
     */
    requestedBy: r.requestedBy ?? null,
    requestedByKind: r.requestedByKind ?? "unknown",
    actsAsSubject: r.actsAsSubject ?? null,
  };
}

/**
 * A run as somebody shows it when it acted as ANOTHER person's own account (sharing-boundaries D4): that it ran, when,
 * and how it ended — no inputs, no steps, nothing it read or sent. `dataHidden` says so, so a page can explain rather
 * than draw an empty run.
 */
export function statusOnly<T extends { inputs: Record<string, unknown>; steps?: StepView[] }>(view: T): T & { dataHidden: true } {
  return { ...view, inputs: {}, ...(view.steps ? { steps: [] } : {}), dataHidden: true };
}

export const flowVisibilityService = {
  /**
   * Executions for a workspace, newest first.
   *
   * Foundry rows are the index — they carry the workspace, which Kestra has no
   * concept of. `engineStatus` is filled in from one Kestra search rather than
   * one call per row.
   */
  async list(workspaceId: string, limit = 50, visible?: SQL) {
    const rows = await flowExecutionRepo.listByWorkspace(workspaceId, limit, visible);
    if (!rows.length) return [];

    const engineState = await engineStates(workspaceId, rows, limit);

    return rows.map((r) => ({
      ...executionBase(r),
      // A runner run has no engine record; its row IS its status (the runner closes it with `complete`).
      engineStatus: r.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX)
        ? runnerEngineStatus(r.status)
        : engineState.get(r.kestraExecutionId) ?? null,
    }));
  },

  /**
   * One execution, fully assembled.
   *
   * Returns `null` when the id is unknown **or belongs to another workspace** —
   * the same answer for both, so this cannot be used to probe which ids exist.
   */
  async get(workspaceId: string, flowExecutionId: string): Promise<ExecutionView | null> {
    const row = await flowExecutionRepo.get(flowExecutionId);
    if (!row || row.workspaceId !== workspaceId) return null;

    // A flow-runner run (pi-runtime P4): Foundry holds its whole record — never ask Kestra, which has none.
    if (row.kestraExecutionId.startsWith(RUNNER_EXECUTION_PREFIX)) {
      return {
        ...executionBase(row),
        engineStatus: runnerEngineStatus(row.status),
        steps: runnerSteps(await runnerStepResultRepo.listForExecution(row.id)),
        graph: null,
      };
    }

    const pointerRows = await flowStepRunRepo.listByExecution(row.id);
    const pointers = new Map(
      pointerRows.map((p) => [
        p.stepId,
        {
          kind: p.kind,
          kestraTaskrunId: p.kestraTaskrunId,
          auditVerdict: p.auditVerdict,
          oracleScore: p.oracleScore,
          readFrom: p.readFrom,
        },
      ]),
    );

    // The refs of the revision THIS execution ran, not the flow's current draft.
    // Approval binds to a revision (§6.5) and an armed flow's draft can be
    // several edits ahead, so reading the draft would describe a run using steps
    // it never executed — and the seam badge would then be a claim about the
    // wrong definition. Degrades to an empty map: pre-`flows` history carries no
    // `flow_id`/`flow_revision`, and every ref is then honestly unknown.
    const declared = new Map<string, { kind: string; ref: string | null }>();
    if (row.flowId && row.flowRevision != null) {
      try {
        for (const s of await flowRepo.listSteps(row.flowId, row.flowRevision)) {
          const cfg = (s.configJson ?? {}) as { ref?: unknown };
          declared.set(s.stepId, {
            kind: s.kind,
            ref: typeof cfg.ref === "string" ? cfg.ref : null,
          });
        }
      } catch (e) {
        // Never fail the run view over an annotation. Logged rather than
        // swallowed: a silent catch here is how "the seam badge is just missing
        // sometimes" would become the reported symptom.
        console.warn(
          `[flow-visibility] could not read step refs for execution ${row.id} ` +
            `(flow ${row.flowId} v${row.flowRevision}): ${(e as Error).message}`,
        );
      }
    }

    const base: ExecutionView = {
      ...executionBase(row),
      engineStatus: "running",
      steps: [],
      graph: null,
    };

    let execution: KestraExecution;
    try {
      execution = await kestra.getExecution(row.kestraExecutionId);
    } catch (e) {
      // Degrade, do not fail. The Foundry-side record is real information and an
      // engineer looking at a broken run should not be told "unavailable"
      // because the engine is mid-restart.
      return {
        ...base,
        engineUnavailable:
          e instanceof KestraError && e.status === 404
            ? "this execution is no longer in Kestra — the retention policy purges after KESTRA_RETENTION_DAYS (O4)"
            : `Kestra is unreachable: ${(e as Error).message}`,
      };
    }

    const logsByTask = new Map<string, StepLog[]>();
    try {
      for (const l of await kestra.getExecutionLogs(row.kestraExecutionId)) {
        if (!l.taskId) continue;
        const list = logsByTask.get(l.taskId) ?? [];
        list.push({ timestamp: l.timestamp, level: l.level, message: l.message });
        logsByTask.set(l.taskId, list);
      }
    } catch {
      // Logs are the nice-to-have; state and I/O are the load-bearing part.
    }

    let graph: ExecutionView["graph"] = null;
    try {
      graph = toStepGraph(await kestra.getFlowGraph(execution.namespace, execution.flowId));
    } catch {
      // The graph is topology; without it the UI falls back to task order.
    }

    const engineStatus = toStatus(execution.state.current);

    // Close a stale `running` row while we are here.
    //
    // `complete` is a task in the flow, so a FAILED execution never reaches it
    // and its Foundry row stays `running` for ever, silently holding an M3 budget
    // slot (ISSUES.md I-10). `begin` reconciles on the refusal path, but that is
    // the last possible moment; this is the earliest free one — the engine has
    // just been asked for the state, so the write costs nothing extra and the
    // leak closes as soon as anyone LOOKS at the run.
    //
    // Kestra's status is copied, never inferred (R6).
    const terminal: Record<string, "succeeded" | "failed" | "cancelled"> = {
      success: "succeeded",
      warning: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
    };
    const settled = terminal[engineStatus];
    if (settled && row.status === "running") {
      await flowExecutionRepo.update(row.id, { status: settled, endedAt: new Date() });
      base.status = settled;
    }

    return {
      ...base,
      engineStatus,
      steps: buildSteps(execution, logsByTask, pointers, declared),
      graph,
    };
  },
};
