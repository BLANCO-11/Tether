// packages/flow-edit/src/index.ts — the model a person builds on the canvas, and
// every operation that changes it. Programme 3, Stage 5.
//
// ── Why this is a PACKAGE rather than a file in the client (D-121) ───────────
//
// It lived at `packages/client/src/lib/flow-authoring.ts` until foundations
// Phase 2.1, which moved it here unchanged. That file is now a re-export shim,
// for the same reason `packages/server/src/utils/redact.ts` is one: the ~8 call
// sites keep their import path, and the reason lives where someone following an
// import will find it.
//
// The move is not tidying. Chat mode edits a flow with these same operations,
// server-side, and the alternative was a server-side COPY of `spliceApproval`.
// A copy cannot be pinned against this one — server tests cannot resolve the
// client's `@/` alias — so it would drift, silently, each half passing its own
// tests. And `spliceApproval` is deliberately the SINGLE gate-placement
// implementation, because an appended gate compiles, deploys and stops nothing:
// two implementations of "before, not after" is one implementation and one bug.
//
// Moving it also deletes three duplications the comments below already
// acknowledge as client-side copies of server constants — `ID_RE`,
// `RESERVED_STEP_IDS` and `EXPECTABLE_KINDS`.
//
// ── This file is PURE, and that is the whole design ──────────────────────────
//
// No React, no fetch, no DOM. Dragging an edge, deleting a node and splicing a
// gate are graph operations, and a graph operation that lives inside a component
// can only be tested by rendering one. Every rule that matters here — a cycle is
// refused, a deleted step takes its inbound edges with it, a gate is inserted
// BEFORE its target and never after — is a property of a function in this file.
//
// ── The shape is the DRAFTER's response, deliberately ────────────────────────
//
// `AuthoredFlow` mirrors `draftResponseSchema` on the server, not
// `flowModelSchema`. That is the point of the whole approach: a canvas-authored
// flow is posted as `authored` and goes through `authorFlow()`, which runs the
// same parse, the same D-22 expression allowlist, the same `splitDraft` and the
// same `validateModel` that a generated draft does. So a `code` step here
// carries a CONTRACT and no code, and `outputKeys` is derived server-side from
// `contract.output` — never sent, never editable, and therefore incapable of
// disagreeing with the contract the fragment is judged against.
//
// ⚠ The corollary: this file must NOT gain a `code` field. If a canvas could
// supply a fragment body it would be supplying code that no contract describes,
// which is the one thing per-step generation exists to prevent.
// `scripts/ui-honesty-check.sh` asserts that on THIS path — it used to grep
// `lib/flow-authoring.ts`, and over a re-export shim it would have found nothing
// and passed vacuously, which is a check that cannot fail (I-38).

// The node-type registry — one definition of every component's properties,
// inputs and outputs (`node-types.ts`). Re-exported here so every importer of
// this package reads the registry from the same path as the model.
export * from "./node-types.js";
// The expression renderers (Stage 3.2) — the client panel, the server compiler
// and the stored-model upgrade render from this one module. `BranchTest` lives
// here now (moved from `node-types.ts` with the `BRANCH_TESTS` table).
export * from "./render.js";
export * from "./typecheck/index.js";
export * from "./ir/index.js";
// The stored-model upgrade (Stage 3.4) — v1 history reads through this.
export { normaliseModel } from "./model-version.js";
// The per-step inventory for the chat prompt — one honest paragraph per step
// (`inventory.ts`). Exported so `buildChatPrompt` can tell the model what each
// step has set instead of letting it invent references from raw JSON.
export { describeStepInventory } from "./inventory.js";
import type { Source, InputBinding, VariableType } from "./node-types.js";
import type { BranchTest } from "./render.js";
export type StepKind =
  | "tool"
  | "datasource"
  | "query"
  | "transform"
  | "code"
  | "approval"
  | "branch"
  /** Where the arms come back together. See the `merge` member of `AuthoredStep`. */
  | "merge"
  | "llm"
  | "http"
  /** Wave 2/3 — declared in `node-types.ts`, `runtime: null`, never offered. */
  | "classifier"
  | "extract"
  | "listop"
  | "iteration"
  | "loop"
  /**
   * For each (compiled-builder phase F, D-361): the box, and its output. Built ONLY by the engine's own moves (the canvas and
   * the chat builder) — `engineOnly` in the registry keeps them off the legacy palette. `iteration`/`loop` above are older
   * declarations (never runnable) and are not these.
   */
  | "for_each"
  | "collect";
export type ContractFieldType = "string" | "number" | "boolean" | "object" | "array" | "any";

/**
 * A date-shape hint on a `string` contract field — what the string IS, so a
 * turn deriving one shape from another is typed, not prose-lottery.
 * `date` is `YYYY-MM-DD`, `month` is `YYYY-MM`, `datetime` is an ISO
 * timestamp, `text` is plain. Absent reads as `text`.
 */
export type ContractFieldFormat = "date" | "month" | "datetime" | "text";

export type ContractField = {
  name: string;
  type: ContractFieldType;
  description?: string;
  items?: ContractFieldType;
  format?: ContractFieldFormat;
};

/**
 * One callable parameter of a tool/query/operation ref, as served by
 * `GET …/catalogue` (`flow-catalogue.service.ts`) — the name a `paramsExpr`
 * must supply, the wire type, whether the call must supply it, and the
 * per-parameter prose the manifest used to drop (I-40).
 *
 * Canonical home for the client property rows (NAME · SOURCE · type): the
 * rows read this, never a second copy. Additive — nothing else reads it yet.
 */
export type CatalogueParam = {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
};

 /** A user-named static value: an agent context parameter or a tool extra input. */
 export type NamedParam = {
   name: string;
   value: string;
   description?: string;
 };

export type StepContract = {
  purpose: string;
  input: ContractField[];
  output: ContractField[];
};

/**
 * A step's runtime retry — foundations, D-32.
 *
 * ⚠ **Bounds mirror the server's `retrySchema`, which is the authority.** They
 * are here so the form can refuse before a save rather than after: 2–5 attempts
 * (one attempt is not a retry, and five is where a transient failure stops being
 * transient), 1–300s interval, 10–3600s ceiling.
 *
 * ⚠ **Only `tool`, `datasource`, `query` and `code` may carry one.** The
 * compiler refuses the rest by name and says why — an `agent` retry re-runs a
 * conversation, an `approval` retry re-opens a question a person already
 * answered, a `transform` is pure so a retry does nothing.
 */
export type StepRetry = {
  maxAttempts: number;
  backoff?: "constant" | "exponential";
  intervalSeconds?: number;
  maxDurationSeconds?: number;
};

/** The kinds the compiler will accept a `retry` on. A MIRROR of its
 *  `RETRYABLE_KINDS`; the compiler refuses anything else with its own reason. */
export const RETRYABLE_KINDS: readonly StepKind[] = ["tool", "datasource", "query", "code", "llm", "http"];

/**
 * The kinds a `merge` may name as a source — the ones whose output is a JSON
 * value, so that ONE spelling (`json(outputs.<merge>.value)`) reads the result
 * whichever arm actually ran.
 *
 * ⚠ **A MIRROR of the server's `MERGE_SOURCE_KINDS`, exactly as `RETRYABLE_KINDS`
 * above mirrors its `RETRYABLE_KINDS`** — and the server refuses anything else
 * with its own reason, naming the step. This exists so the inspector can offer
 * a correct pick list rather than let someone choose a step and discover at save
 * time that it produces nothing.
 *
 * The mirror used to list ten spellings, including kinds with no emitter — which
 * is how the inspector offered merges over steps that compile to nothing. It is
 * the server's four now; `llm`/`http` stay OUT (deferred: a merge coalesces raw
 * task outputs with one `json(outputs.<merge>.value)` read, and there is no
 * envelope derivation for the Foundry-callback kinds yet).
 * The absentees are the point — `code` (its `vars.result` is an object, not
 * JSON text), `approval` and `branch` (no output at all), and `merge` itself.
 */
export const MERGE_SOURCE_KINDS: readonly StepKind[] = [
  "tool", "datasource", "query", "transform",
];

/**
 * A person's label and prose, on every kind.
 *
 * ⚠ **`name` IS NOT `id`.** The id is the address — `dependsOn` names it,
 * `outputs.<id>` resolves through it, D-123's flat step-id space is about it —
 * so renaming an id repoints every expression that mentions it, which is why
 * the inspector has always treated a rename as creating a new step. Nothing
 * resolves through `name`, so it is free to change.
 *
 * ⚠ **Neither is in the server's `structureHash`, so neither unarms a flow.**
 * Relabelling a step does not change what the engine runs.
 */
export type StepLabel = {
  /** A person's word for this step. Not an identifier. */
  name?: string;
  /** What this step is for, in prose. Read by people; never by the compiler. */
  description?: string;
};

export type AuthoredStep = StepLabel &
  (
  | {
      kind: "datasource" | "query" | "tool";
      id: string;
      ref: string;
      paramsExpr: string;
      /**
       * Caller-supplied values beyond the endpoint schema (tool steps).
       * Authored in the inspector; merged into the first params object at run.
       */
      extraInputs?: NamedParam[];
      /**
       * Typed bindings (Stage 3) — carried beside `paramsExpr` through the
       * cutover and read by no one yet. `paramsExpr` stays the source of truth
       * until `normaliseModel` lands; the server strips these on save.
       */
      inputs?: InputBinding[];
      /**
       * A read that lives in the WORKFLOW rather than in the data source: the
       * step's own statement, the datasource it runs against, and the binding
       * its placeholders need. The executor runs this text verbatim and never
       * resolves `ref` to a stored reader; `checkSqlShape` still refuses a
       * write, at save and again at execution.
       *
       * ⚠ Carried here so an edit op can move them with the step. These are
       * data to this package, which decides nothing about them — the server's
       * `checkStepLocalSql` owns the rules.
       */
      sql?: string;
      datasourceRef?: string;
      sqlParamOrder?: string[];
      sqlParamsSchema?: Record<string, unknown>;
      over?: { stepId: string; field: string } | null;
      where?: { field: string; test: BranchTest; value?: string } | null;
      dependsOn?: string[];
      timeoutSeconds?: number;
      retry?: StepRetry;
    }
  | {
      kind: "transform";
      id: string;
      /**
       * The hand-written template. Absent on a drafted `{from, program, fields}`
       * reshape until `splitDraft` lowers it (phase 3 step 2) — the drafter
       * writes the jq program only and never the Pebble around it.
       */
      expr?: string;
      /** The step whose output the program reads (`.` inside the program). */
      from?: string;
      /** A jq program over `from`'s output — lowered to `expr` by the server. */
      program?: string;
      /** The declared output fields; downstream reads are held to them (FT0302). */
      fields?: string[];
      /** Stage 3 — carried beside `expr`, read by no one yet. */
      mode?: "expression" | "template";
      templateText?: string;
      dependsOn?: string[];
    }
  | {
      kind: "code";
      id: string;
      inputExpr: string;
      contract: StepContract;
      /** Stage 3 — carried beside `inputExpr`, read by no one yet. */
      inputs?: InputBinding[];
      dependsOn?: string[];
      timeoutSeconds?: number;
      retry?: StepRetry;
    }
  /**
   * A conditional guard — foundations Phase 3. ONE arm and no `else`; arm
   * membership is an ordinary `dependsOn` edge, which is D-123 and is what lets
   * every function in this file stay unchanged.
   *
   * ⚠ `conditionExpr` is BUILT by `lib/flow-expr.ts`, never typed. D-22 is a good
   * boundary and a terrible text box.
   */
  | {
      kind: "branch";
      id: string;
      /**
       * ⚠ **OPTIONAL ONLY SO A TERMINAL `else` CAN EXIST.** A branch carrying
       * `elseOf` and no condition is the closing arm of an if/elif chain and has
       * nothing to test. The server refuses a conditionless branch that is not
       * an `else`, naming the step — so the optionality is not a hole here
       * either.
       */
      conditionExpr?: string;
      /** The typed test — what the compiler renders when `conditionExpr` is absent (`displayCondition`). */
      test?: { left: Source; operator: BranchTest; right?: string } | null;
      /**
       * The branch this one continues: `if` → `elif` → `elif` → `else`.
       *
       * ⚠ **THIS IS NOT WHAT D-123 REFUSED.** D-123 refused a per-step arm
       * marker that every step inside an arm would have to carry. This is ONE
       * field on the BRANCH, naming another branch by id — the same shape
       * `dependsOn` already has. Downstream steps carry nothing, and `armOf`
       * still computes arm membership from `dependsOn` alone, which is why every
       * edit function in this file is unchanged.
       *
       * ⚠ **It must round-trip.** A field the canvas reads and does not write
       * back turns an if/elif/else chain into three unrelated always-run guards
       * on the first save — and the flow still validates, so nothing says so.
       */
      elseOf?: string;
      dependsOn?: string[];
    }
  /**
   * Where the arms come back together — the shared tail after a branch.
   *
   * ⚠ **`armOf` stops here, and that one exemption is the whole mechanism.**
   * Without it a step placed after a branch is swallowed into that branch's arm
   * (arm membership is a blind `dependsOn` closure), so a shared tail had to be
   * duplicated into every arm and the copies drifted. A `transform` does not
   * solve it — it is swallowed identically.
   *
   * ⚠ Like `conditionExpr`, `sources` is BUILT — the inspector offers the
   * candidate steps as a pick list and writes ids. There is no expression here
   * and there must not be: the server derives the coalesce from each source's
   * kind, so a merge is never a route by which unvetted Pebble reaches the
   * compiler.
   */
  | {
      kind: "merge";
      id: string;
      /**
       * The steps whose results come back together, in PRIORITY ORDER — the
       * first that actually ran wins.
       *
       * ⚠ **The order is meaning, not presentation.** Reordering this list
       * changes which arm's result the tail acts on when more than one ran, so
       * the server hashes it as written rather than sorted, and an armed flow
       * whose merge was reordered correctly reads as changed.
       */
      sources: string[];
      dependsOn?: string[];
    }
  | {
      kind: "approval";
      id: string;
      /** The hand-written question. Optional: the typed `summary` (below) is what builders now write. */
      summaryExpr?: string;
      contextExpr?: string;
      /**
       * The typed question + evidence — what the compiler renders when `summaryExpr`
       * is absent (`displaySummary` / `displayContext`). `summary` is plain text and
       * may carry `{{ inputs.<id> }}`; `context` is the step whose rows the approver sees.
       */
      summary?: string;
      context?: Source | null;
      dependsOn?: string[];
      awaitSeconds?: number;
    }
  | {
      kind: "llm";
      id: string;
      model: string;
      tempPreset: "precise" | "balanced" | "creative" | "custom";
      temperature: number;
      topP: number;
      frequencyPenalty: number;
      presencePenalty: number;
      promptBlocks: Array<{ role: "system" | "user" | "assistant"; text: string }>;
      contextStepId?: string | null;
      outputFields: ContractField[];
      memoryEnabled: boolean;
      visionDetail: "high" | "low";
      reasoningSeparated: boolean;
      dependsOn?: string[];
      retry?: StepRetry;
    }
  | {
      kind: "http";
      id: string;
      method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      headers: Array<{ name: string; value: string }>;
      queryParams: Array<{ name: string; value: string }>;
      body: { kind: "none" | "json" | "form" | "binary" | "raw"; content: string; contentType?: string; fileVar?: string };
      auth: { kind: "none" | "api-key" | "basic" | "bearer" | "custom"; headerName?: string; secretRef?: string };
      timeouts?: { connectMs?: number; readMs?: number; writeMs?: number } | null;
      sslVerify: boolean;
      dependsOn?: string[];
      retry?: StepRetry;
    }
  /**
   * Wave-2/3 kinds — declared so the registry, the panel and chat share one
   * vocabulary; refused at save by name until their emitters land (Stage 4+).
   * `children`/`loopVars`/groups are nested records with no PropertyKind yet.
   */
  | {
      kind: "classifier";
      id: string;
      inputSource?: Source | null;
      model?: string;
      classes?: Array<{ title: string; description: string }>;
      instructions?: string;
      dependsOn?: string[];
      retry?: StepRetry;
    }
  | {
      kind: "extract";
      id: string;
      inputSource?: Source | null;
      model?: string;
      params?: ContractField[];
      instructions?: string;
      inferenceMode?: "function_call" | "prompt";
      memoryEnabled?: boolean;
      dependsOn?: string[];
      retry?: StepRetry;
    }
  | {
      kind: "listop";
      id: string;
      arraySource?: Source | null;
      filter?: { field: string; test: BranchTest; value?: string } | null;
      sort?: { field: string; dir: "asc" | "desc" } | null;
      selection?: { mode: "all" | "first-n" | "first" | "last"; n: number };
      dependsOn?: string[];
    }
  | {
      kind: "iteration";
      id: string;
      arraySource: Source;
      children: AuthoredStep[];
      mode?: "sequential" | "parallel";
      parallelCap?: number;
      onItemError?: "terminate" | "continue-null" | "remove-failed";
      dependsOn?: string[];
    }
  | {
      kind: "for_each";
      id: string;
      /** The top-level transform whose bounded list of records the body runs over, once per row. */
      over: { stepId: string; field: string };
      /** Items at once, 1…20. */
      concurrency: number;
      /** When an item fails: keep going (the others still run, the run ends "succeeded with failures") or stop the run. */
      onError: "continue" | "stop";
      dependsOn?: string[];
    }
  | {
      kind: "collect";
      id: string;
      /** The `for_each` this is the output of. */
      loop: string;
      /** The body step whose value is each row's `result` — one that runs for every item. */
      result: string;
      dependsOn?: string[];
    }
  | {
      kind: "loop";
      id: string;
      loopVars: Array<{ name: string; type: ContractFieldType; initial: Source }>;
      children: AuthoredStep[];
      conditionExpr?: string;
      maxCount: number;
      dependsOn?: string[];
    });
export type FlowInput = {
  id: string;
  type: "STRING" | "INT" | "FLOAT" | "BOOLEAN" | "DATE" | "DATETIME";
  defaults?: string;
  /**
   * A value derived from the run's firing time, resolved by the engine at run
   * creation. Mutually exclusive with `defaults` (enforced by the server's
   * `flowModelSchema`, which is what every revision passes through).
   */
  computed?: "priorMonth" | "currentMonth" | "priorDate" | "currentDate" | "currentYear" | "runTimestamp" | "currentMonthStart" | "priorMonthStart";
  required?: boolean;
  /** A STRING input's shape — `month` is `YYYY-MM` (phase 5, D-255). */
  format?: "month";
};

/**
 * One flow-level output row (Stage 4.5) — the End boundary's declaration of
 * what the automation returns. `name` is what an API caller receives;
 * `source` is where it is read from. A `null` source is explicitly unbound
 * (`unset` in the panel) — refused at save, never projected.
 */
export type FlowOutputRow = { name: string; type: VariableType; source: Source | null };

export type AuthoredFlow = {
  id: string;
  inputs?: FlowInput[];
  steps: AuthoredStep[];
  /** One paragraph for the person who will approve this. */
  notes?: string;
  /**
   * The flow's schedule — Phase 6. Mirrors `FlowSchedule` in the server
   * compiler (`flow-compiler.service.ts`), which owns the real rule:
   * `assertCron` (5–6 whitespace-separated cron fields) and an IANA-shaped
   * `timezone`. Kept lightweight here; the server is the source of truth.
   *
   * A schedule needs no name — it is the flow's own, Kestra owns the cron, and
   * no `triggers` row is ever materialised for it.
   */
  schedule?: { cron: string; timezone?: string };
  /**
   * WHAT THIS AUTOMATION RETURNS — 2026-09-08, rows since Stage 4.5. Mirrors
   * `FlowModel.output` on the server, which owns the real rule
   * (`checkFlowOutput`: every row's source must resolve to something that
   * produces a value — a step of an output-producing kind, a declared input,
   * or a literal).
   *
   * ⚠ **A flow-level field with no step subject of its own**, exactly like
   * `schedule`. It is what an API caller receives; without it, firing a trigger
   * answers `{fireId, started}` and the value has to be plucked out of the
   * execution by a hardcoded step id.
   *
   * `stepId` is the legacy single-step form pre-rows revisions carry — still
   * read, never written by new code (`set_output_rows` in Stage 6 writes
   * `rows`).
   */
  output?: { stepId?: string; description?: string; rows?: FlowOutputRow[] };
  /**
   * A webhook trigger declaration — Phase 6. `name` follows the SAME rule the
   * trigger API enforces (`createTriggerSchema` in trigger.service.ts): a
   * non-empty string of at most 255 characters. The name becomes a workspace
   * `triggers` row (materialised when the flow is saved), so it must not
   * collide with an existing trigger name.
   */
  webhook?: { name: string };
  /** An api trigger declaration — Phase 6. Same `name` rule as `webhook`. */
  api?: { name: string };
};

/** Mirrors the compiler's `ID_RE`. A copy outside the server so the form can say so before the server does. */
const ID_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** Mirrors `RESERVED_STEP_IDS` — the compiler emits tasks with these ids itself. */
export const RESERVED_STEP_IDS = new Set(["begin", "complete"]);

export function isValidStepId(id: string): boolean {
  return ID_RE.test(id) && !RESERVED_STEP_IDS.has(id);
}

/** A flow id may use hyphens where a step id may not — matching the compiler's two regexes. */
export function isValidFlowId(id: string): boolean {
  return /^[a-z][a-z0-9_-]{0,62}$/.test(id);
}

export function slugify(text: string, sep: "_" | "-" = "_"): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "")
    .slice(0, 63);
  // A leading digit fails `ID_RE`, and an empty string is not an id at all.
  return /^[a-z]/.test(s) ? s : `s_${s}`.slice(0, 63);
}

/** A free id derived from `base`: `send`, then `send_2`, `send_3`… */
export function uniqueStepId(flow: AuthoredFlow, base: string): string {
  const root = slugify(base) || "step";
  const taken = new Set(flow.steps.map((s) => s.id));
  // ⚠ Reserved ids are taken too. Without this an "add a step called complete"
  // produces a flow that fails to compile with a message about a task the person
  // never wrote.
  for (const r of RESERVED_STEP_IDS) taken.add(r);
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}_${n}`.slice(0, 63);
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}_${Date.now()}`.slice(0, 63);
}

// ── Graph reads ──────────────────────────────────────────────────────────────

export function dependenciesOf(step: AuthoredStep): string[] {
  return step.dependsOn ?? [];
}

/**
 * Is `target` reachable from `from` by following `dependsOn` forwards?
 *
 * Used to refuse a connection that would close a cycle. Iterative and
 * visited-guarded: the model being edited is not yet valid, so it may already
 * contain the cycle we are asking about.
 */
export function reaches(flow: AuthoredFlow, from: string, target: string): boolean {
  const downstream = new Map<string, string[]>();
  for (const s of flow.steps) {
    for (const d of dependenciesOf(s)) {
      downstream.set(d, [...(downstream.get(d) ?? []), s.id]);
    }
  }
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    for (const next of downstream.get(n) ?? []) {
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Every step that could be ADDED as an upstream of `stepId` — not itself, not
 * one it already runs after, and nothing downstream of it (which would cycle).
 *
 * ⚠ "Already a dependency" is checked on `stepId`'s own `dependsOn`, not on the
 * candidate's. The other direction reads plausibly and answers a different
 * question, and the symptom is a dropdown offering a link that `connect` then
 * refuses as a duplicate.
 */
export function candidateUpstream(flow: AuthoredFlow, stepId: string): AuthoredStep[] {
  const step = flow.steps.find((s) => s.id === stepId);
  const already = new Set(step ? dependenciesOf(step) : []);
  return flow.steps.filter(
    (s) => s.id !== stepId && !already.has(s.id) && !reaches(flow, stepId, s.id),
  );
}

/**
 * Every step that has already run when `stepId` runs — transitively reachable
 * backwards over `dependsOn`. Unlike `candidateUpstream` this is not the set a
 * connection may be ADDED to; it is the set whose outputs may already exist,
 * which is what a binding picker groups first. A step never reaches itself,
 * so it is never its own upstream even when the model already cycles.
 */
export function upstreamOf(flow: Pick<AuthoredFlow, "steps">, stepId: string): AuthoredStep[] {
  return flow.steps.filter((s) => s.id !== stepId && reaches(flow as AuthoredFlow, s.id, stepId));
}

// ── Graph writes. Every one returns a NEW flow; nothing here mutates ─────────

export type EditResult = { ok: true; flow: AuthoredFlow } | { ok: false; error: string };

export function addStep(flow: AuthoredFlow, step: AuthoredStep): EditResult {
  if (flow.steps.some((s) => s.id === step.id)) {
    return { ok: false, error: `this flow already has a step called "${step.id}"` };
  }
  if (!isValidStepId(step.id)) {
    return {
      ok: false,
      error: RESERVED_STEP_IDS.has(step.id)
        ? `"${step.id}" is reserved — the engine emits a task with that name`
        : `"${step.id}" is not a valid step id (lower-case letters, digits and underscores, starting with a letter)`,
    };
  }
  return { ok: true, flow: { ...flow, steps: [...flow.steps, step] } };
}

/**
 * Remove a step, and every reference to it.
 *
 * ⚠ Unlinking is not optional tidiness. Dropping the step alone leaves its
 * dependents pointing at something that no longer exists, which the compiler
 * refuses with `depends on unknown step` — a correct message about a step the
 * person did not touch.
 */
export function removeStep(flow: AuthoredFlow, stepId: string): EditResult {
  if (!flow.steps.some((s) => s.id === stepId)) {
    return { ok: false, error: `"${stepId}" is not in this flow` };
  }
  const steps = flow.steps
    .filter((s) => s.id !== stepId)
    .map((s) =>
      dependenciesOf(s).includes(stepId)
        ? { ...s, dependsOn: dependenciesOf(s).filter((d) => d !== stepId) }
        : s,
    );
  return { ok: true, flow: { ...flow, steps } };
}

export function connect(flow: AuthoredFlow, from: string, to: string): EditResult {
  if (from === to) return { ok: false, error: "a step cannot depend on itself" };
  const source = flow.steps.find((s) => s.id === from);
  const target = flow.steps.find((s) => s.id === to);
  if (!source || !target) return { ok: false, error: "both ends of a link must be steps in this flow" };
  if (dependenciesOf(target).includes(from)) {
    return { ok: false, error: `"${to}" already runs after "${from}"` };
  }
  // ⚠ The cycle check. A flow is a DAG and Kestra will not deploy anything else,
  // but the refusal has to happen HERE: dragged in the browser, a cycle is two
  // arrows that look fine, and the server's message names a compile error rather
  // than the link that closed the loop.
  if (reaches(flow, to, from)) {
    return {
      ok: false,
      error: `that would make a loop — "${from}" already runs after "${to}"`,
    };
  }
  const steps = flow.steps.map((s) =>
    s.id === to ? { ...s, dependsOn: [...dependenciesOf(s), from] } : s,
  );
  return { ok: true, flow: { ...flow, steps } };
}

/**
 * The drag-time half of `connect`: the same four refusals as sentences, or
 * `null` when the link would be accepted. `connect` stays the write path and
 * re-checks everything — this never authorises, it only names the reason
 * early, so the two MUST stay in lockstep (the test below asserts each
 * refusal twice: once here, once through `connect`).
 */
export function connectionRefusal(flow: AuthoredFlow, from: string, to: string): string | null {
  if (from === to) return "a step cannot depend on itself";
  const source = flow.steps.find((s) => s.id === from);
  const target = flow.steps.find((s) => s.id === to);
  if (!source || !target) return "both ends of a link must be steps in this flow";
  if (dependenciesOf(target).includes(from)) {
    return `"${to}" already runs after "${from}"`;
  }
  if (reaches(flow, to, from)) {
    return `that would make a loop — "${from}" already runs after "${to}"`;
  }
  return null;
}

export function disconnect(flow: AuthoredFlow, from: string, to: string): EditResult {
  const target = flow.steps.find((s) => s.id === to);
  if (!target || !dependenciesOf(target).includes(from)) {
    return { ok: false, error: `"${to}" does not run after "${from}"` };
  }
  const steps = flow.steps.map((s) =>
    s.id === to ? { ...s, dependsOn: dependenciesOf(s).filter((d) => d !== from) } : s,
  );
  return { ok: true, flow: { ...flow, steps } };
}

/**
 * Replace one step, keeping its position.
 *
 * Takes the whole step rather than a patch: the inspector is a form per kind and
 * a kind change rewrites every field anyway, so a partial merge would leave
 * `paramsExpr` on a step that is now a `transform`.
 */
export function replaceStep(flow: AuthoredFlow, stepId: string, next: AuthoredStep): EditResult {
  const at = flow.steps.findIndex((s) => s.id === stepId);
  if (at < 0) return { ok: false, error: `"${stepId}" is not in this flow` };
  if (next.id !== stepId) {
    if (flow.steps.some((s) => s.id === next.id)) {
      return { ok: false, error: `this flow already has a step called "${next.id}"` };
    }
    if (!isValidStepId(next.id)) {
      return { ok: false, error: `"${next.id}" is not a valid step id` };
    }
  }
  const steps = flow.steps.map((s, i) => {
    const base = i === at ? next : s;
    // A rename has to travel into every `dependsOn` that named the old id, or
    // the rename silently orphans the rest of the flow.
    if (next.id === stepId) return base;
    return dependenciesOf(base).includes(stepId)
      ? { ...base, dependsOn: dependenciesOf(base).map((d) => (d === stepId ? next.id : d)) }
      : base;
  });
  return { ok: true, flow: { ...flow, steps } };
}

/**
 * Put a human in front of a step — gate 3.
 *
 * ⚠ **SPLICED, never appended, and this is the only implementation.** Kestra
 * runs tasks in emission order, so a gate inserted after its target satisfies
 * every assertion about a pause existing and stops nothing: the email has
 * already gone. The gate therefore takes the target's dependencies, and the
 * target is repointed to depend on the gate alone.
 *
 * `FlowReview` had this logic inline for a whole stage. It is here now because
 * the canvas needs it too, and two implementations of "before, not after" is one
 * implementation and one bug waiting.
 */
export function spliceApproval(
  flow: AuthoredFlow,
  targetId: string,
  gate: { id?: string; summaryExpr?: string; contextExpr?: string; awaitSeconds?: number } = {},
): EditResult {
  const at = flow.steps.findIndex((s) => s.id === targetId);
  if (at < 0) return { ok: false, error: `"${targetId}" is not in this flow` };
  const target = flow.steps[at];
  if (target.kind === "approval") {
    return { ok: false, error: "a gate does not need a gate in front of it" };
  }
  const gateId = gate.id ?? `${targetId}_gate`;
  if (flow.steps.some((s) => s.id === gateId)) {
    return { ok: false, error: `this flow already has a step called "${gateId}"` };
  }
  if (!isValidStepId(gateId)) return { ok: false, error: `"${gateId}" is not a valid step id` };

  const step: AuthoredStep = {
    id: gateId,
    kind: "approval",
    // ⚠ A JSON STRING, quotes included. `summaryExpr` reads like a place for
    // free text and is not — an unquoted value produces a body Kestra rejects
    // with a 400 that names nothing (I-11).
    summaryExpr: gate.summaryExpr ?? JSON.stringify(`Approve before ${targetId} runs?`),
    ...(gate.contextExpr ? { contextExpr: gate.contextExpr } : {}),
    ...(dependenciesOf(target).length ? { dependsOn: [...dependenciesOf(target)] } : {}),
    awaitSeconds: gate.awaitSeconds ?? 86_400,
  };

  const steps = [
    ...flow.steps.slice(0, at),
    step,
    { ...target, dependsOn: [gateId] },
    ...flow.steps.slice(at + 1),
  ];
  return { ok: true, flow: { ...flow, steps } };
}

// ── Local findings: what the canvas can say before the server does ───────────

export type LocalFinding = { stepId?: string; message: string; blocking: boolean };

/**
 * Required parameters of a call that are not visible in its `paramsExpr`.
 * platform-coherence Phase 5.1 · I-106
 *
 * ⚠ **Never blocking, and the wording says why.** `lib/flow-expr.ts` builds a
 * `paramsExpr` with each parameter as a quoted JSON or jq key, so for anything
 * the inspector produced this match is exact by construction. But D-50 leaves a
 * raw escape hatch — a person may type an expression — and there a name can be
 * built by concatenation and be perfectly correct while invisible here.
 *
 * A guard with false positives gets widened, and the widening is what permits
 * the defect (I-62). So this reports what it can and cannot see, in those words,
 * and refuses nothing. The authority is the call itself failing at runtime, and
 * before that, the catalogue on screen.
 */
function missingParams(
  stepId: string,
  ref: string,
  paramsExpr: string,
  required: Map<string, string[]> | undefined,
): LocalFinding[] {
  const names = required?.get(ref);
  if (!names?.length) return [];
  // The key as `lib/flow-expr.ts` writes it — `"period":` in a JSON object, or
  // `"period":` inside the jq projection. One form, both builders.
  const absent = names.filter((n) => !new RegExp(`"${n}"\\s*:`).test(paramsExpr));
  if (!absent.length) return [];
  return [
    {
      stepId,
      message:
        `${absent.map((n) => `\`${n}\``).join(", ")} ${absent.length === 1 ? "is" : "are"} required by ` +
        `"${ref}" and cannot be seen in the parameters. If the expression was hand-written they may ` +
        `be in there — this only reads the ones the form writes.`,
      blocking: false,
    },
  ];
}

/**
 * Everything wrong with this flow that can be seen without the server.
 *
 * ⚠ This is a PREVIEW of the server's answer and never a substitute for it. The
 * authority is `authorFlow` → `flowService.writeRevision`, which owns D-22, the
 * caps and the ref check; if this function and the server ever disagree, the
 * server is right. What it buys is that a person building a flow sees "this step
 * has no upstream data" while placing it, rather than after a round trip.
 *
 * `caps` is passed in from `GET …/catalogue` rather than hardcoded, for the same
 * reason the ref list is: a second copy of a number is a number that drifts.
 */
export function localFindings(
  flow: AuthoredFlow,
  opts: {
    refs?: Set<string>;
    caps?: { steps: number; codeSteps: number; approvalSteps: number };
    /**
     * Required parameter names per ref, from `GET …/catalogue`.
     *
     * ⚠ Phase 5.1, I-106. Without it "no parameters set" was the only thing said
     * about a call's arguments, so a tool with three required parameters and one
     * of them mapped read as finished. The catalogue already carries `required`
     * per parameter and nothing was looking at it.
     */
    requiredParams?: Map<string, string[]>;
  } = {},
): LocalFinding[] {
  const out: LocalFinding[] = [];
  if (!flow.steps.length) {
    out.push({ message: "a flow needs at least one step", blocking: true });
  }
  if (!isValidFlowId(flow.id)) {
    out.push({ message: `"${flow.id}" is not a valid flow id`, blocking: true });
  }

  const ids = new Set(flow.steps.map((s) => s.id));
  for (const s of flow.steps) {
    for (const d of dependenciesOf(s)) {
      if (!ids.has(d)) {
        out.push({ stepId: s.id, message: `runs after "${d}", which is not in this flow`, blocking: true });
      }
    }
    if (s.kind === "tool" || s.kind === "datasource" || s.kind === "query") {
      if (!s.ref) out.push({ stepId: s.id, message: "no query or tool chosen yet", blocking: true });
      else if (opts.refs && !opts.refs.has(s.ref)) {
        out.push({ stepId: s.id, message: `"${s.ref}" is not registered in this workspace`, blocking: true });
      }
      if (!s.paramsExpr) out.push({ stepId: s.id, message: "no parameters set", blocking: true });
      else out.push(...missingParams(s.id, s.ref, s.paramsExpr, opts.requiredParams));
    }
    if (s.kind === "transform" && !s.expr) {
      out.push({ stepId: s.id, message: "no expression set", blocking: true });
    }
    if (s.kind === "code") {
      if (!s.contract.purpose.trim()) {
        out.push({ stepId: s.id, message: "a generated step needs a purpose", blocking: true });
      }
      if (!s.contract.output.length) {
        out.push({ stepId: s.id, message: "a generated step must declare what it returns", blocking: true });
      }
      if (!s.inputExpr) {
        out.push({ stepId: s.id, message: "no input payload set", blocking: true });
      }
    }
    if (s.kind === "approval" && !s.summaryExpr) {
      out.push({ stepId: s.id, message: "a gate needs a question", blocking: true });
    }
    if (s.kind === "llm") {
      if (!s.model.trim()) {
        out.push({ stepId: s.id, message: "no model chosen yet", blocking: true });
      }
      if (!s.promptBlocks.some((b) => b.text.trim())) {
        out.push({ stepId: s.id, message: "no prompt written yet", blocking: true });
      }
    }
    if (s.kind === "http" && !s.url.trim()) {
      out.push({ stepId: s.id, message: "no URL set yet", blocking: true });
    }
  }

  // ── ⚠ A step nothing feeds. Non-blocking, and it is a real shape ──────────
  //
  // A step with no `dependsOn` runs at the START, in parallel with the first
  // one. That is legal and sometimes exactly right — two queries that do not
  // depend on each other should run together. But it is almost never what
  // somebody meant when they placed a `tool` step fourth on the canvas, and
  // before Phase 5 nothing said so until the run produced an empty call.
  //
  // Said, never enforced: it is a judgement about intent, and the same argument
  // as the trailing-gate finding below.
  if (flow.steps.length > 1) {
    const first = flow.steps[0]?.id;
    for (const s of flow.steps) {
      if (s.id === first || dependenciesOf(s).length) continue;
      out.push({
        stepId: s.id,
        message:
          "nothing feeds this step, so it runs at the very start alongside the first one — " +
          "connect it to whichever step produces the data it needs",
        blocking: false,
      });
    }
  }

  // ⚠ Non-blocking, on purpose. A gate at the END of a flow is legal and
  // compiles; it just stops nothing, because Kestra runs tasks in emission
  // order and everything it was meant to gate has already run. That is a
  // judgement about intent, so it is said and not enforced.
  for (const s of flow.steps) {
    if (s.kind !== "approval") continue;
    const gates = flow.steps.some((t) => dependenciesOf(t).includes(s.id));
    if (!gates) {
      out.push({
        stepId: s.id,
        message:
          "nothing runs after this gate, so it stops nothing — a gate has to come BEFORE the step it guards",
        blocking: false,
      });
    }
  }

  const caps = opts.caps;
  if (caps) {
    const count = (k: StepKind) => flow.steps.filter((s) => s.kind === k).length;
    for (const [kind, cap] of [
      ["code", caps.codeSteps],
      ["approval", caps.approvalSteps],
    ] as const) {
      if (count(kind) > cap) {
        out.push({ message: `${count(kind)} \`${kind}\` steps — the cap is ${cap}`, blocking: true });
      }
    }
    if (flow.steps.length > caps.steps) {
      out.push({ message: `${flow.steps.length} steps — the cap is ${caps.steps}`, blocking: true });
    }
  }

  return out;
}

// ── Expectations — GAPS §2.3, D-68 ───────────────────────────────────────────

/**
 * The kinds whose output an expectation can read. Mirrors `EXPECTABLE_KINDS`
 * server-side.
 *
 * ⚠ A copy outside the server, and the same trade the `ID_RE` copy above makes:
 * the form can say "you cannot check an agent step" before the server does, which
 * is worth a duplicated five-element set. `index.test.ts` pins the list, so a
 * divergence is a failing test rather than a form that offers a step the server
 * will refuse.
 */
export const EXPECTABLE_KINDS: ReadonlySet<StepKind> = new Set([
  "datasource",
  "query",
  "tool",
  "code",
  "transform",
]);

export type ExpectOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "present"
  | "absent"
  | "contains";

/** `present`/`absent` are the only ops that compare against nothing. */
export const NULLARY_EXPECT_OPS: ReadonlySet<string> = new Set(["present", "absent"]);

export type ExpectationAssert =
  | { type: "rowCount"; op: "eq" | "gte" | "lte"; value: number }
  | { type: "field"; field: string; op: ExpectOp; value?: string | number | boolean }
  | {
      type: "rows";
      quantifier: "every" | "none";
      field: string;
      op: ExpectOp;
      value?: string | number | boolean;
    };

export type FlowExpectation = {
  id: string;
  stepId: string;
  select?: string;
  description?: string;
  assert: ExpectationAssert;
};

export type ExpectationEdit =
  | { ok: true; expectations: FlowExpectation[] }
  | { ok: false; error: string };

/** A field name, not a path — a dot is the first inch of an expression language. */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Add a claim, refusing the four ways it can be malformed before the server
 * has to.
 *
 * ⚠ Every refusal here is also enforced server-side (`checkFlowExpectations`
 * and the zod schema). This is the form telling somebody now rather than after
 * a round trip — it is **not** the control. A second implementation that was
 * the only enforcement would be exactly the shape `ui-honesty-check.sh` exists
 * to catch.
 */
export function addExpectation(
  existing: FlowExpectation[],
  steps: Array<{ id: string; kind: StepKind }>,
  e: FlowExpectation,
): ExpectationEdit {
  if (!ID_RE.test(e.id)) {
    return { ok: false, error: "a name must be lowercase letters, digits and underscores" };
  }
  if (existing.some((x) => x.id === e.id)) {
    // The verdict row is keyed on this, so two claims sharing a name means one
    // of them silently has no result.
    return { ok: false, error: `there is already an expectation called "${e.id}"` };
  }
  const step = steps.find((s) => s.id === e.stepId);
  if (!step) return { ok: false, error: `no step called "${e.stepId}"` };
  if (!EXPECTABLE_KINDS.has(step.kind)) {
    return {
      ok: false,
      error: `an \`${step.kind}\` step produces no output an expectation can read`,
    };
  }
  if (e.select !== undefined && !FIELD_RE.test(e.select)) {
    return { ok: false, error: "a field name, not a path — no dots" };
  }
  if (e.assert.type !== "rowCount") {
    if (!FIELD_RE.test(e.assert.field)) {
      return { ok: false, error: "a field name, not a path — no dots" };
    }
    const nullary = NULLARY_EXPECT_OPS.has(e.assert.op);
    if (!nullary && e.assert.value === undefined) {
      // Without this the comparison runs against `undefined`, and `neq` then
      // passes over anything — a claim that reports success by having no subject.
      return { ok: false, error: `"${e.assert.op}" needs a value to compare against` };
    }
    if (nullary && e.assert.value !== undefined) {
      return { ok: false, error: `"${e.assert.op}" compares against nothing` };
    }
  }
  return { ok: true, expectations: [...existing, e] };
}

export function removeExpectation(existing: FlowExpectation[], id: string): FlowExpectation[] {
  return existing.filter((e) => e.id !== id);
}

/**
 * A one-line English rendering of a claim, for a list.
 *
 * Written here rather than in the component so the run page, the flow page and
 * the canvas cannot describe the same claim three ways.
 */
export function describeExpectation(e: FlowExpectation): string {
  const where = e.select ? `${e.stepId}.${e.select}` : e.stepId;
  const a = e.assert;
  if (a.type === "rowCount") {
    const word = { eq: "exactly", gte: "at least", lte: "at most" }[a.op];
    return `${where} produces ${word} ${a.value} row(s)`;
  }
  const rhs = NULLARY_EXPECT_OPS.has(a.op) ? "" : ` ${JSON.stringify(a.value)}`;
  if (a.type === "field") return `${where}.${a.field} is ${a.op}${rhs}`;
  const q = a.quantifier === "every" ? "every row of" : "no row of";
  return `${q} ${where} has ${a.field} ${a.op}${rhs}`;
}

// ── Reading a STORED flow back into this shape (Phase 2.2, I-130) ─────────────
//
// Re-exported from `./from-model.js` rather than written here, because that
// direction has to read a stored step's generated `code` — and this file is the
// subject of `ui-honesty-check.sh`'s assertion that a canvas `code` step carries
// a contract and never code. Keeping the two shapes in two files is what lets
// that assertion stay pointed at the shape a person authors.
export { authoredFromModel } from "./from-model.js";
export type {
  AuthoredFromModel,
  FromModelOptions,
  FromModelResult,
  StoredContract,
  StoredFlow,
  StoredStep,
} from "./from-model.js";

// ── The thirteen chat ops (Phase 2.3) ────────────────────────────────────────
//
// A separate file because the ops are a LAYER over the edits above: each one
// delegates to `addStep`/`removeStep`/`spliceApproval` and friends, so a chat
// edit and a dragged edit are the same operation rather than two that agree.
export { applyOp, assertOnlyTouched, describeOp, describeOpRows, inputsReadBy, touchedBy, FLOW_EDIT_OPS, bindingDesync, applyDesyncRepair, checkCodeInputExpr } from "./ops.js";
export type { ApplyResult, BindingDesync, ChatFlowInput, FlowEditOp, OpChangeRow } from "./ops.js";
export * from "./engine/index.js";
