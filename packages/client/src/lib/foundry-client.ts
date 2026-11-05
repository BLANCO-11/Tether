// src/lib/foundry-client.ts — the browser-side client for the Foundry Parent API
// (packages/server on :4000). Calls go to the same-origin proxy /api/foundry/*,
// which injects the API key server-side. This is the App A contract; src/lib/api.ts
// maps it to/from the UI's domain types via src/lib/adapters.ts.

import { filenameFrom, queryString } from "./reports";
import { clearWorkspaceChoice, storedWorkspaceChoice } from "@/lib/workspace-choice";
import type { ToolProbe, EmailBox, FiringOutcome, FlowInputFormat, ComputedInputFn, FlowSummary, ConnectorMarketplace, WorkspaceConnector, ConnectorConnection, ConnectionTestResult, ConnectorInstall, ConnectorOauthApp, DeclaredCallView, DeclaredCallPack,
  PersonalConnectorView, DeclaredCallInput } from "@/lib/types";

import { signInIfEnded } from "@/lib/session-expiry";
const PROXY = "/api/foundry";

// ---- App A public response shapes (from packages/server) --------------------
export interface FAWorkspace {
  id: string;
  name: string;
  description: string | null;
  /** Assistant mode: Forge does everyday tasks here too, and answers from the real data, read-only. */
  assistant?: boolean;
  /** Forge Agent may propose changes to connected services, each done only by the person's click. */
  agentChanges?: boolean;
  /** Members may switch on their own automations that use only their own things (plugins phase 9). */
  selfEnable?: boolean;
  /** Workflows and Forge may read public web addresses (`web_fetch`). On by default. */
  webAccess?: boolean;
  /** Closed to everyone its own admins did not add (restricted workspaces). */
  restricted?: boolean;
  /** `"fixture"` for a harness workspace; `null` for a real tenant. */
  kind: string | null;
  /** Only with `?with=counts`. */
  counts?: { workflows: number; live: number; datasources: number; members: number; lastRunAt: string | null };
  // ⚠ Two fields reporting an external runtime tenant were removed here (server
  // task 1.8, I-131). Both were permanently `null`/`false` — the code that would
  // have set them was never reachable — and no client file read either. A
  // declared field that can only hold one value is a capability the client can
  // see and never use.
  createdAt: string;
  updatedAt: string;
}
/** A restricted workspace the caller is outside of: the platform tier's view of it (restricted workspaces, phase 3). */
export interface FAClosedWorkspace {
  id: string;
  name: string;
  restricted: true;
  closed: true;
  admins: string[];
}
export interface FAEmergencyAccess {
  id: string;
  workspaceId: string;
  subject: string;
  email: string | null;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: string | null;
  /** Only from the workspace's list: open now (not ended, not expired). */
  open?: boolean;
}
export interface FATool {
  id: string;
  workspaceId: string;
  name: string;
  /** Always "real". Dummy tools are gone; the field is kept because the server
   *  still emits it to keep the manifest content-hash stable. */
  kind: "real";
  url: string | null;
  method: string | null;
  description: string | null;
  paramsSchema: unknown;
  secretEnvName: string | null;
  /** WS-B.4 — `toPublic` has always sent both; the client ignored them until I-124. */
  authStyle:
    | "bearer"
    | "header"
    | "query"
    | "basic"
    | "none"
    | "oauth2_client_credentials"
    | null;
  authParamName: string | null;
  /** Phase 7 — the oauth2_client_credentials fields. Nullable, per `toPublic`. */
  tokenUrl: string | null;
  clientIdSecretRef: string | null;
  clientSecretSecretRef: string | null;
  /**
   * Phase 7 — distinct flows (any revision) whose steps reference this tool,
   * computed from `flow_steps.manifest_refs_json`.
   */
  usedBy: number;
  /**
   * tool-probe P3 — the last probe of this tool **in the server process that
   * answered this request**, or `null`.
   *
   * ⚠ **`null` is the normal case, not an error case.** The marker has no column
   * (the P3 sign-off says no schema), so it is genuinely absent after a restart
   * and absent on another container. The page's rule is that absence renders
   * NOTHING — see `toolRow` in `tools/page.tsx`.
   *
   * ⚠ Optional on the wire so a server that predates the field reads the same as
   * one with no marker, rather than as `undefined` reaching a render branch.
   */
  lastProbe?: {
    at: string;
    verdict: string;
    mode: "live" | "reachability";
    status: number | null;
  } | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface FADatasource {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  secretEnvName: string | null;
  testStatus: string | null;
  lastTestedAt: string | null;
  supported: boolean;
  /** The owner's column declarations, `[schema.]table.column` → tag (P5-I11). */
  columnTags?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
/**
 * Mock-data readiness for one datasource, off `datasource_fixtures`
 * (`mock_status`/`mock_error`). The JSON mock file is a derived projection of
 * the fixture row — this status is the only thing the client keys on, never
 * the sandbox columns.
 *
 * `status: null` means no fixture row was ever built for this datasource (not
 * yet onboarded) — distinct from `failed`, which names its reason in `error`.
 */
export type FAMockStatus = "building" | "ready" | "failed";

/** What `POST …/mock/rebuild` answers. A decline is a state, not an error. */
export type FAMockBuildOutcome =
  | { started: true; version: number }
  | { started: false; why: string };

/** A stored SQLite upload — metadata only; the file itself never comes back. */
export interface SqliteFileUpload {
  id: string;
  filename: string | null;
  sizeBytes: number;
  sha256: string;
  tables: number;
  views: number;
}

export interface FADatasourceMock {
  status: FAMockStatus | null;
  error: string | null;
  version: number | null;
  fingerprint: string | null;
}
/** One page of mock rows. Mock rows only — this endpoint never serves production. */
export interface FAMockRowsPage {
  rows: Array<Record<string, unknown>>;
  total: number;
}
/**
 * A model-drafted step SQL proposal, from the introspected SCHEMA alone — the
 * model never sees real rows. Human-approved text is frozen into `step.sql`.
 * `insufficient_schema` is a 200 verdict, not an error (same rule as the
 * operation proposer).
 */
export type FADatasourceSqlProposal =
  | { status: "ok"; sql: string; notes?: string }
  | { status: "insufficient_schema"; reason: string };
/**
 * A named datasource query — half of the callable catalogue a flow is built from.
 *
 * `ref` is what a `datasource` step's `ref` field must say, and the server builds
 * it rather than the client concatenating `name`s: the ref is split at the FIRST
 * dot, so getting the boundary wrong produces a step that 404s at execution time.
 */
export interface FANamedQuery {
  id: string;
  datasourceId: string;
  name: string;
  ref: string;
  description: string | null;
  sqlText: string;
  /** Ordered — index i binds `$(i+1)`. Not a set. */
  paramOrder: string[];
  paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface FANamedQueryInput {
  name: string;
  description?: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>;
}

/** Every structural problem at once, so an author fixes them in one pass. */
export interface FANamedQueryCheck {
  ok: boolean;
  problems: Array<{ code: string; message: string }>;
}

// ---- DB operations (Phase 4) -------------------------------------------------
//
// The second half of the callable catalogue a flow is built from. An operation
// is a SAVED, NAMED, read-only component described by a visual spec the server
// compiles to SELECT — a `query` step references it by
// `<datasource>.<operation>`. Only schema metadata is ever exposed; rows are
// never served to this client.

export type FADbOperationAggregate = "count" | "sum" | "avg" | "min" | "max";
export type FADbOperationJoinKind = "inner" | "left";
export type FADbOperationOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "ilike" | "is_null" | "is_not_null";
export type FADbOperationHavingOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
export type FADbOperationSortDir = "asc" | "desc";

/**
 * The visual spec an operation is compiled from — the client's mirror of the
 * server's zod-validated `DbOperationSpec`.
 *
 * ⚠ Every `table`/`column`/`onLeft`/`onRight` resolves against the introspected
 * `schemas` rows server-side; nothing is ever raw-interpolated, and `filters`
 * bind positionally as `$1..$n` in declaration order. Filters sharing an
 * `orGroup` are ORed inside one parenthesised term; `having` filters an
 * aggregate after summarising.
 */
export interface FADbOperationSpec {
  base: { schema?: string; table: string };
  columns: Array<{ column?: string; compute?: unknown; aggregate?: FADbOperationAggregate; aggregateDistinct?: boolean; alias: string }>;
  joins: Array<{ table: string; onLeft?: string; onRight?: string; kind: FADbOperationJoinKind }>;
  aggregateJoins?: Array<unknown>;
  filters: Array<{ column: string; op: FADbOperationOp; param?: string; orGroup?: string }>;
  having?: Array<{ column: string; aggregate: FADbOperationAggregate; op: FADbOperationHavingOp; param: string }>;
  distinct?: boolean;
  sort: Array<{ column: string; dir: FADbOperationSortDir }>;
  limit?: number;
}

/** A saved DB operation. `ref` is `<datasource>.<operation>`, built server-side. */
export interface FADatasourceOperation {
  id: string;
  datasourceId: string;
  name: string;
  ref: string;
  description: string | null;
  /** The visual spec — the thing the server compiled, so it can be shown back. */
  spec: FADbOperationSpec;
  /** Read-only SELECT with positional `$1..$n` — compiled server-side, never here. */
  compiledSql: string;
  /** Exactly the filter `param` names, in the same flat vocabulary as a tool's. */
  paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface FADbOperationInput {
  name: string;
  description?: string;
  spec: FADbOperationSpec;
}

/**
 * One clause of the plain-English readback — `services/db-operation-readback.ts`.
 *
 * ⚠ **Rendered SERVER-SIDE by pure code, and this client must never build one**
 * (FR-022). A client-side renderer would be a second definition of what a spec
 * means, and the two would drift in the one direction that matters: a screen
 * that disagrees with the SQL it is standing in front of.
 *
 * ⚠ A `label` can REPEAT. There is one `From` clause per join, because each join
 * carries its own `note`, and the note is the part most likely to be the defect.
 * Render the array in order; do not group by label.
 */
export interface FAReadbackClause {
  label: "From" | "Kept when" | "You get" | "Ordered by" | "At most";
  text: string;
  /**
   * The CONSEQUENCE of a decision, as opposed to the decision. `inner` and
   * `left` produce the same `text` and different notes — so a note that is
   * dropped in rendering throws away the single most valuable line on screen.
   */
  note?: string;
}

/**
 * An output column with its provenance — `customer_name ← customers.name (text)`.
 *
 * ⚠ `type` is the introspected COLUMN's type, not the type of the value this
 * operation returns. They differ the moment an aggregate is involved: `count`
 * over a `text` column returns a number and `type` still says `text`. Label it
 * as the source column's type or leave it off — never as "the output type"
 * (plan Decision 17, **D-185**).
 */
export interface FAOutputColumn {
  alias: string;
  /** `table.column`, or `agg(table.column)` — resolved by the compiler. */
  source: string;
  type: string | null;
}

/**
 * `POST …/operations/check` — compile without saving. Always resolves (200):
 * `ok: true` carries the emitted read-only SQL; `ok: false` carries the
 * structured findings (offending identifier + available schema) — same shape
 * rule as `FANamedQueryCheck`, so a refused spec is a verdict, not an outage.
 *
 * ⚠ `readback` and `outputColumns` are on the `ok: true` branch ONLY, and that
 * asymmetry is deliberate (FR-026): a spec that will not compile has no
 * readback, because rendering one from an invalid spec is a confident English
 * sentence describing something that cannot run.
 */
/**
 * A bare column name that more than one joined table could have meant, and the
 * table the compiler picked (the first in the chain).
 *
 * ⚠ **Not an error and not a warning about the SQL** — the SQL is correct and
 * deterministic. It is the record of a CHOICE made on the author's behalf, and
 * the review surface is the only place anyone can disagree with it. The remedy
 * is the qualified spelling `table.column`, which is why the two shipped
 * together.
 */
export interface FAColumnAmbiguity {
  column: string;
  resolvedTo: string;
  alsoOn: string[];
}

export type FADbOperationCheck =
  | {
      ok: true;
      compiledSql: string;
      paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>;
      readback: FAReadbackClause[];
      outputColumns: FAOutputColumn[];
      ambiguousColumns: FAColumnAmbiguity[];
    }
  | { ok: false; problems: Array<{ code: string; message: string; identifier?: string; available?: string[] }> };

// ---- Proposed DB operations (proposed-db-operations) -------------------------
//
// A person describes the data they need in one sentence; the server reads the
// INTROSPECTED SCHEMA (never a row, never the DSN) and answers with a spec, or
// refuses and names what the schema does not carry.
//
// ⚠ **Both channels are HTTP 200, and the refusal is a SUCCESS** — the same rule
// `insufficient_catalogue` follows. A refusal naming the boundary is the most
// useful answer this path produces, and rendering it as a failure is how a
// client grows a Retry button that turns "there is no due date column" into a
// plausible-looking `created_at` on attempt 2.
//
// ⚠ **Nothing is created.** This route writes no `db_operations` row, no
// manifest version and no ref (FR-010). Saving goes through the EXISTING
// `createOperation`, which re-runs the compiler on whatever spec is submitted —
// a proposal is not authorisation, which is why nothing here carries an id.

/** The proposal channel. `name` is editable BEFORE creation, immutable after. */
export interface FAOperationProposal {
  status: "ok";
  name: string;
  description: string;
  spec: FADbOperationSpec;
  /** ⚠ The PRIMARY review artefact (FR-011) — lead with this, not the SQL. */
  readback: FAReadbackClause[];
  outputColumns: FAOutputColumn[];
  ambiguousColumns: FAColumnAmbiguity[];
  /** Available, COLLAPSED — not the primary artefact. Removing it loses a real reviewer. */
  compiledSql: string;
  paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>;
  /** Inference calls spent. `> 1` means the compiler's findings were fed back. */
  attempts: number;
  /**
   * FR-014's bound, travelling with the response.
   *
   * ⚠ **Read it from here; never hardcode the number.** It is on both channels
   * because a refusal spends one of the N too, and it travels rather than
   * living in this file because a constant here would be a second definition of
   * a server bound — the two drift, and the screen then states a bound the
   * server does not hold. It is NOT enforced server-side and cannot be: one
   * request has no notion of "this visit", and the server holds no proposal
   * state at all (**D-189**).
   */
  maxPerRequest: number;
}

/** The refusal channel — a boundary in the SCHEMA, named. ⚠ Never retried. */
export interface FAOperationProposalRefusal {
  status: "insufficient_schema";
  missing: string[];
  reason: string;
  /** See `FAOperationProposal.maxPerRequest` — a refusal spends one of the N. */
  maxPerRequest: number;
}

export type FAOperationProposalResult = FAOperationProposal | FAOperationProposalRefusal;

/**
 * What an edit will unarm. Not a "heads up" — the sweep WILL do this; the only
 * open question is which tick.
 */
export interface FASuspensionNotice {
  willSuspendFlows: Array<{ id: string; name: string; armedRevision: number }>;
  suspensionReason: string | null;
}

/**
 * Gate 3 — one human decision on one execution.
 *
 * Distinct from `FAFlowApproval` (gate 2), which approves a REVISION to run
 * unattended. This approves THIS BATCH, mid-flight, and an armed flow with an
 * approval step still stops every run.
 *
 * ⚠ `decidedBy` is SELF-ASSERTED: one shared API key, no user model (I-13). It
 * records a claim; it does not authenticate one. Never label this surface
 * "separation of duties".
 */
/** One question an agent put to a person, as the agent worded it (Stage 8.1). */
export interface FAAgentQuestion {
  id: string;
  question: string;
  header?: string;
  kind?: "text" | "single" | "multi";
  options?: Array<string | { label?: string; value?: string; description?: string }>;
}

export interface FAStepApproval {
  id: string;
  flowExecutionId: string;
  stepId: string;
  /**
   * `gate` — an approval step: may this run proceed?
   * `question` — REMOVED with the agent runtime; `gate` is the only kind.
   *
   * One inbox, two things, and the card renders each as what it is. A question
   * shown as "Approve / Reject" would be answered by clicking Approve, which
   * sends the agent no answer at all.
   */
  kind: "gate" | "question";
  /** The question, rendered by the flow at the moment it paused. */
  summary: string;
  /** The evidence — server-side redacted (D-07). */
  context: unknown;
  /** `question` rows only — the agent's own words. */
  questions: FAAgentQuestion[] | null;
  answers: unknown;
  decision: "approved" | "rejected" | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** When the decision actually reached the engine. Set but null = recorded, undelivered. */
  appliedAt: string | null;
  /** Closed with no decision — the run stopped waiting. Never appears in the inbox. */
  expiredAt: string | null;
  note: string | null;
  createdAt: string | null;
  /** Present on the inbox listing only. */
  flowId?: string | null;
  startedAt?: string | null;
}

export interface FASchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyReference: string | null;
  characterMaximumLength: number | null;
  /** The column's tag (`email`, …): the schema's own, or one the owner declared (`columnTags`). */
  tag?: string | null;
}
export interface FASchemaEntity {
  entityType: string;
  name: string;
  schema?: string | null;
  rowCountEstimate: number | null;
  columns: FASchemaColumn[];
}
export interface FAScript {
  id: string;
  workspaceId: string;
  title: string | null;
  description: string | null;
  language: string | null;
  status: string;
  versionNumber: number;
  manifestVersion: number | null;
  code: string;
  requirements: string | null;
  requirementsFilename: string | null;
  runStartedAt: string | null;
  runEndedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FAExecution {
  id: string;
  scriptId: string;
  containerImage: string | null;
  exitCode: number | null;
  stdoutText: string | null;
  stderrText: string | null;
  durationMs: number | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
}
/**
 * Gate 2, as the server reports it (Phase 3, §6.5).
 *
 * `armedRevision` is what is deployed live; `draftAhead` says an unapproved
 * revision is waiting. The two are separate because a flow can be firing
 * revision 1 unattended while revision 2 sits in draft, and a UI that collapsed
 * them could not say which one runs tonight.
 */
export interface FAApprovalState {
  armedRevision: number | null;
  approval: {
    id: string;
    revision: number;
    approverUserId: string;
    approverKind: string;
    note: string | null;
    approvedAt: string | null;
    revokedAt: string | null;
    staleAt: string | null;
    staleReason: string | null;
    /** Switched on by its owner with no reviewer, because it uses only their own things (plugins phase 9). */
    selfEnabled?: boolean;
  } | null;
  status: "draft" | "draft_pending" | "approved" | "armed" | "suspended";
  draftAhead: boolean;
  blockedReason: string | null;
}

/**
 * Whether the person asking may switch a Forge workflow's draft on themselves (plugins phase 9) — the server's own
 * answer, from what the draft uses. `null` for a workflow a reviewer always approves.
 */
export interface FASelfEnable {
  /** The workspace lets members switch on their own automations that use only their own things. */
  allowed: boolean;
  ownOnly: boolean;
  /** Each thing of the workspace's the draft uses, in words — why a reviewer approves it. */
  needsReviewerFor: string[];
  own: string[];
  youMay: boolean;
}

export interface FAChatThread {
  id: string;
  workspaceId: string;
  flowId: string | null;
  name: string;
  createdByKind: string;
  createdAt: string;
}

/**
 * ⚠ There is no text field, and there must not be one. What the screen says is
 * computed — `describeOp` over the op that was applied, plus the diff
 * `flowApprovalService.diff` produces — so "what changed" has exactly one answer.
 * A stored narration would sit beside a diff it could contradict.
 */
export interface FAChatTurn {
  id: string;
  threadId: string;
  seq: number;
  message: string;
  opJson: unknown;
  resolvedStepId: string | null;
  resolvedBy: string | null;
  revision: number | null;
  findingsJson: string[] | null;
  refusalJson: { missing?: string[]; reason?: string; stepId?: string } | null;
  /**
   * Why the `more` continuation loop stopped — `done` | `declined` |
   * `unparseable` | `refused` | `no_change` | `cap`, or null when a turn
   * applied one op and the loop never ran.
   *
   * ⚠ **Only `done` and `null` mean the instruction was fully carried out.** A
   * turn is `applied` for all six, so without this an incomplete turn is
   * indistinguishable from a complete one — which is how six of eleven rebuilt
   * UAT flows stopped at a `transform` having been asked to "email me", with
   * nothing on screen saying so.
   */
  moreStopReason: string | null;
  attempts: number;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  /** A RUNNING turn's build so far — the engine state and its shape, read-only (no signature, no actions). Absent otherwise. */
  preview?: { state: unknown; shape: unknown };
}

/** A notice to the signed-in person (sharing-boundaries): e.g. an Admin opened their private work. */
export interface FANotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  createdAt: string;
  read: boolean;
}

export interface FAFlow {
  id: string;
  workspaceId: string;
  /** Which builder and runner own it: "foundry" (Pi-built, flow-runner) or "kestra" (compiled). */
  runtime?: string;
  name: string;
  description: string | null;
  kestraFlowId: string;
  draftRevision: number;
  armedRevision: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  /**
   * ⚠ The APPROVAL COUNT — the flow's version number. Not `armedRevision`, and
   * not `draftRevision`: a revision is written on every edit, so those climb
   * while somebody is drafting. `null` until somebody approves. See
   * `FlowVersion`.
   */
  version?: number | null;
  approvalState?: FAApprovalState;
  /** P5 B-06 — owner when backend models it (else derived via createdBy/members). */
  ownerSubject?: string | null;
  ownerName?: string | null;
  /** rbac-observability: the person asking owns it. */
  mine?: boolean;
  /** Who sees it (plugins phase 9): its owner chooses. Absent from an older server. */
  visibility?: "private" | "public";
  /** Its owner asked a reviewer to approve this version (sharing-boundaries); null once approved or withdrawn. */
  reviewRequestedRevision?: number | null;
  /** While shared, may members edit it (sharing-boundaries phase 2) — false is view-only. */
  othersMayEdit?: boolean;
  /** The project it lives in (sharing-boundaries phase 5), or null for My space / the Workspace. */
  projectId?: string | null;
  /** Its project's name, sent with the list. */
  projectName?: string | null;
  /** P5 B-07 — resource refs from `flow_steps.manifest_refs_json` when exposed. */
  resources?: string[] | null;
  /** Alternate: raw manifest_refs_json already present on step rows, exposed per flow when list joins it. */
  manifestRefs?: string[] | null;
  /** The cron that fires (armed revision's, else the draft's) — `GET …/flows` sends it; `null` when none. */
  schedule?: string | null;
  /**
   * Per-flow chat configuration (Phase 5) — `{ model, instructions,
   * suggestions }`, or null when nobody configured the chat. Served by
   * `GET …/flows/:id` (the flow row's `chat_config`); absent on responses
   * that predate the column, so optional here.
   */
  chatConfig?: { model: string | null; instructions: string | null; suggestions: boolean } | null;
  /**
   * What this automation was designed against (Phase 3.3) — the stored scope
   * the chat turn falls back to when the thread names none. Null when nobody
   * chose; shaping the stored value is `designSelectionSchema` server-side.
   */
  designSelection?: unknown;
}

export interface FAFlowRevision {
  id: string;
  flowId: string;
  revision: number;
  modelJson: unknown;
  compiledYamlHash: string;
  structureHash: string;
  createdBy: string | null;
  createdAt: string;
}

/** One persisted step of one revision, as `…/revisions/:n/steps` returns it. */
export interface FAFlowStep {
  stepId: string;
  ordinal: number;
  kind: string;
  configJson: unknown;
  manifestRefsJson: Record<string, string> | null;
  /**
   * The contract a `code` step's fragment was generated FROM. NULL for every
   * other kind, and NULL for a hand-written `code` step — which is honest rather
   * than a gap: nobody declared a contract, so there is nothing to regenerate
   * from, and `regenerateStep` refuses such a step by name.
   */
  contractJson: unknown | null;
}

/**
 * What the editable canvas may offer — `GET …/catalogue`, Stage 5.
 *
 * ⚠ Five things the client would otherwise hold its own copy of: the callable
 * refs, how each kind's output is reached, D-22's allowlist, the caps, and
 * (Phase 8) the declarable webhook/api triggers. Each copy is a thing that
 * drifts, and each drift is silent in the direction that matters — a palette
 * offering a ref the validator rejects is a form that fails on submit for a
 * reason nobody can see.
 */
export interface FAFlowCatalogue {
  entries: Array<{
    ref: string;
    /** What the ref names: a tool, a named query, or a DB operation. */
    kind: "tool" | "query" | "operation";
    /** The step kind that may name this ref — `tool`/`operation` refs on their own kinds only. */
    stepKind: "tool" | "datasource" | "query";
    description: string | null;
    /** Tool entries only — the URL's first path segment (palette sub-groups, D-28). */
    service: string | null;
    params: Array<{ name: string; type: string; required: boolean; description: string | null; /** Left unset, it goes to whoever starts the run. */ fallsBackToRequester?: boolean }>;
    datasource: string | null;
    /** Query and operation entries only. What a design selection stores — see the server's docblock. */
    datasourceId: string | null;
    /**
     * Exactly what this ref reads: compiled SQL for an operation, the stored
     * `sql_text` for a named query, null for a tool. READING ONLY — nothing in
     * the client may compile, edit or submit this.
     */
    sql: string | null;
    /** The same read in English. Operations only; null for query and tool. */
    readback: FAReadbackClause[] | null;
  }>;
  /**
   * Triggers declarable on the flow being authored — `webhook` and `api` only
   * (manual/poll are not LLM-creatable; schedules are flow-level and live on
   * the SchedulePane). Always present, empty array when the workspace has
   * none, so the palette's contract is stable across reads. A trigger is a
   * flow-model DECLARATION (`{webhook|api: {name}}`), never a step ref.
   */
  triggers: Array<{ name: string; type: "webhook" | "api" }>;
  outputs: Record<string, { template: string | null; describes: string | null; caution: string | null }>;
  expressions: { roots: string[]; calls: string[] };
  caps: { steps: number; codeSteps: number; approvalSteps: number } & Record<string, number>;
  /** Refs the fingerprint and interface sets disagree about. Empty in a healthy workspace. */
  drift: string[];
  /** Allowed LLM model ids — served by `GET …/catalogue` (`flow-catalogue.service.ts`). Absent from a server predating Stage 4: the model picker names that staleness instead of crashing on it. */
  models?: string[];
  /** Default LLM model id, null when the deployment configures none — served by `GET …/catalogue` (`flow-catalogue.service.ts`). */
  defaultModel?: string | null;
  /**
   * Which kinds "try this step" can run, and why each of the others cannot —
   * T9. ⚠ **Read, never mirrored.** The builder must decide before any button
   * is pressed whether to draw a form or a sentence, and a client copy of that
   * decision drifts in exactly one direction: the screen offers something the
   * server refuses. Optional on the type because an older server does not send
   * it, and the panel renders nothing rather than guessing when it is absent.
   */
  tryable?: { kinds: string[]; reasons: Record<string, string> };
}

/** One undecided site in an incomplete flow — `packages/flow-edit`'s `Hole` (D-317), as the server stores it. */
export interface FAHole {
  id: string;
  site: { at: "port"; stepId: string; port: string } | { at: "reader"; stepId: string } | { at: "arm"; stepId: string } | { at: "output" };
  why: string;
  owner: "chooser" | "person" | "catalogue";
  reason: string;
  options?: string[];
}
export interface FAIncompleteFlow {
  basedOnRevision: number;
  savedAt: string;
  stale: boolean;
  model: { holes: FAHole[]; steps: Array<{ id: string; kind: string }> };
  diagnostics: unknown[];
}

/**
 * How to call an approved flow from outside — `GET …/flows/:id/integration`.
 *
 * ⚠ `baseUrl` is null unless the deployment set `PUBLIC_API_BASE_URL`, and the
 * page must then render the PATH alone. The browser's origin is the web app;
 * the receivers are on the API. A URL built from `window.location` looks right
 * and does not work.
 */
export interface FAFlowIntegration {
  baseUrl: string | null;
  live: boolean;
  liveBlockedReason: string | null;
  inputs: Array<{ id: string; type: string; required: boolean }>;
  endpoints: Array<{
    triggerId: string;
    name: string;
    type: "webhook" | "api";
    path: string | null;
    enabled: boolean;
    auth: "bearer" | "none";
    /**
     * ⚠ `trigger_token` means the Bearer is byte-identical to the token in the
     * URL — the token must be presented twice, and that is the whole of it.
     * `wrong_kind` means a secret of the trigger's name exists with another
     * kind, so EVERY call 401s even with the right value.
     */
    bearerSource: "workspace_secret" | "trigger_token" | "wrong_kind" | null;
  }>;
}

/** One component run on its own — T9. `POST …/steps/try`. */
export interface FAStepTryResult {
  ok: boolean;
  item: { ok: boolean; data?: unknown; error?: string; status?: number; bytes?: number };
  warnings: string[];
  /**
   * Which database a `datasource`/`query` try read. Absent for a `tool`.
   * ⚠ A try has no execution and therefore no namespace, so it resolves DRAFT —
   * and a datasource with no sandbox still reads production and still says so.
   */
  readFrom?: "sandbox" | "production";
}

/**
 * A generation a browser started and is polling (Stage 7.1).
 *
 * ⚠ `status` has FIVE values and neither `insufficient_contract` nor
 * `insufficient_catalogue` is a failure. The first is a fragment naming the
 * declared input it was not given; the second is the drafter naming a tool or
 * named query the goal needs that this workspace does not have — one stage
 * earlier, before there was ever a model to generate fragments for. Both are
 * generation refusing to invent or guess, which is the behaviour this whole
 * migration was built to produce. Rendering either as an error, or offering to
 * retry it, is how a correct refusal becomes an invented `period="2023-10"`
 * or a guessed ref on attempt 2 (§6.7).
 */
/**
 * Clarify gate — advisory questions about a goal before the job starts.
 *
 * ⚠ Advisory, never blocking: an empty list means "ask nothing, start the
 * job", and a failed read means the same. The server caps at 3 questions with
 * 2–4 options each; the client enforces nothing beyond rendering what arrives.
 */
export interface FAClarifyOption {
  label: string;
  value: string;
}
export interface FAClarification {
  id: string;
  answer: string;
}

/**
 * The prompt-boundary detector's answer for one manifest build (guardrail port
 * V4). Shape mirrors the server's `DetectionResult`.
 *
 * ⚠ `excerpt` is attacker-authored text and must only ever be rendered as text.
 */
export interface FAManifestWarnings {
  items: Array<{
    source: "tool" | "datasource" | "schema";
    itemName: string;
    field: string;
    pattern: string;
    describes: string;
    excerpt: string;
  }>;
  truncated: boolean;
  total: number;
  cap: number;
}

export interface FAFlowDiff {
  from: number | null;
  to: number;
  added: string[];
  removed: string[];
  changed: string[];
  structureChanged: boolean;
  /** §6.5's asymmetry: structure needs a human, a fragment body needs a re-test. */
  requires: "human_reapproval" | "automated_retest";
}

export interface FATrigger {
  id: string;
  workspaceId: string;
  scriptId: string | null;
  /** Set instead of `scriptId` for a flow-bound trigger (Phase 3). */
  flowId?: string | null;
  name: string;
  type: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
  webhookPath: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  // WS-H0.2: the bound automation, and whether this trigger may be armed yet.
  // The server enforces the same rule, so these are for EXPLAINING a refusal —
  // never the only thing standing between a trigger and going live.
  automationName: string | null;
  automationStatus: string | null;
  enableReady: boolean;
  enableBlockedReason: string | null;
  /**
   * Gate 2, reported ALONGSIDE gate 1 rather than folded into it (task 3.9).
   *
   * A trigger blocked on approval must say "waiting for approval", not "not
   * ready" — the same mistake as the removed localStorage go-live gate, which
   * presented a switch that did nothing and explained nothing.
   */
  approvalState?: FAApprovalState | null;
  approvalBlockedReason?: string | null;
  /**
   * What this trigger will send, and **who supplies each value** — ui-upgrade
   * Phase 7.1, D-107. Optional so an older server simply reports nothing here
   * rather than the client rendering `undefined` as "nobody supplies it".
   */
  declaredInputs?: FADeclaredInput[];
  /** The revision those inputs were read from — armed if there is one, else draft. */
  inputsFromRevision?: number | null;
  /** The cron on the flow's MODEL. Read, never stored on a trigger (D-18). */
  scheduleCron?: string | null;
  /** ⚠ A WARNING, not a gate (D-108). Nothing refuses on it. */
  inputsWarning?: string | null;
}

/**
 * One declared input of the revision a trigger would run.
 *
 * `source` is the load-bearing field: `trigger` is the only one this trigger
 * owns, `plan` is Kestra applying the model's `defaults`, and `none` means a
 * fire will be rejected if the input is required.
 */
export interface FADeclaredInput {
  id: string;
  type: string;
  required: boolean;
  value: string | null;
  source: "trigger" | "plan" | "none";
}

/**
 * One row of a trigger's fire audit trail, as `GET …/triggers/:tid/fires` serves
 * it. The server redacts `payload` before it leaves the process (D-07).
 *
 * ⚠ `flowExecutionId` is FOUNDRY's execution id — there is no Kestra id here
 * (R5) — and `null` is the informative value: it means this fire started nothing.
 * It is NOT `trigger_fires.execution_id`, which is a leftover column that a flow
 * fire always leaves NULL; the link comes from `flow_executions.trigger_fire_id`.
 */
/** GAPS §1.1 — `author` may write revisions, `approver` may also approve, `admin` may also grant. */
/** US dollars per 1M tokens. A null cached/cache-write price charges those tokens at the input price. */
export type FAModelPrice = {
  model: string;
  inputPer1m: number | null;
  outputPer1m: number | null;
  cachedInputPer1m?: number | null;
  cacheWritePer1m?: number | null;
  effectiveFrom: string;
  updatedBy: string | null;
};
export type FAModelPricing = {
  prices: FAModelPrice[];
  modelsSeen: string[];
  /** Every change, newest first; a removal has every price null. Absent from an older server. */
  history?: FAModelPrice[];
  currency: "USD";
  unit: string;
};
export type FAModelPriceInput = {
  model: string;
  inputPer1m: number | null;
  outputPer1m: number | null;
  cachedInputPer1m?: number | null;
  cacheWritePer1m?: number | null;
};
/** One model's cost over a window, by where the figure came from (`GET /api/generation/pricing/spend`). */
export type FAModelSpend = {
  model: string;
  calls: number;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  pricedUsd: number;
  reportedUsd: number;
  uncostedCalls: number;
};
/** Who can see what, across workspaces (`GET /api/platform/access`). Every cell is the server's own answer. */
export type FAAccessReach = "none" | "published" | "own" | "review" | "everything";
export type FAAccessCell = {
  reach: FAAccessReach;
  role: string | null;
  via: string[];
  cost: "none" | "own" | "everyone";
  managesPeople: boolean;
  permissionCount: number;
};
export type FAAccessMatrix = {
  /** `restricted`: a restricted workspace the reader is outside of — its name only, no cell in any row. */
  workspaces: Array<{ id: string; name: string; restricted?: boolean }>;
  people: Array<{ subject: string; email: string; name: string | null; superAdmin: boolean; cells: Record<string, FAAccessCell> }>;
  caveat: string;
};
/** People — one row per person (`GET /api/platform/people`, admin simplify phase 3). The server decides every field. */
export type FAPersonWorkspace = { id: string; name: string; role: string | null; reach: FAAccessReach; via: string[] };
export type FAPerson = {
  subject: string;
  email: string;
  name: string | null;
  signIn: "microsoft" | "local";
  lastSeenAt: string | null;
  superAdmin: boolean;
  platformRoles: string[];
  workspaces: FAPersonWorkspace[];
  localAccount: { id: string; username: string; active: boolean } | null;
};
export type FAInvitation = {
  id: string;
  email: string;
  workspaces: { workspaceId: string; workspaceName: string; role: string }[];
  platformRole: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};
export type FAPeopleView = {
  people: FAPerson[];
  invitations: FAInvitation[];
  workspaces: { id: string; name: string; canAddPeople: boolean }[];
  closedWorkspaces: string[];
  platformRoles: { key: string; name: string }[];
  can: { givePlatformRoles: boolean; createLocalAccounts: boolean };
};
export type FAInviteResult =
  | { applied: true; subject: string; email: string }
  | { applied: false; invitation: FAInvitation };
export type FAWorkspaceRole = "viewer" | "author" | "approver" | "admin";

export interface FAWorkspaceMember {
  id: string;
  workspaceId: string;
  /** The identity token's `sub`. What membership is keyed on — an email can be reassigned. */
  subject: string;
  email: string;
  role: FAWorkspaceRole;
  /**
   * Who granted it.
   *
   * ⚠ The literal `bootstrap` means the row was written by the DELETED
   * self-claim endpoint, which is why the badge for it must keep working: for
   * those rows there is no answer to "who let this person in", and that is the
   * fact worth showing. Every assignment made since records the super admin who
   * made it.
   */
  grantedBy: string;
  createdAt: string | null;
}

/**
 * Who the signed-in caller is, and what the DEPLOYMENT will let them do —
 * `GET /api/me`.
 *
 * ⚠ **This is the only source of "am I a super admin" in this package, and the
 * tempting alternative is sitting in `src/auth.ts`.** That file already puts
 * `["superadmin","admin"]` on the local credentials account, in the browser's
 * session, from a password check — while the server decides from
 * `SUPER_ADMIN_EMAILS` in the API server's environment. Reading the session
 * would be a second definition of super admin that can disagree with the only
 * one that refuses anything, and it would disagree in the worse direction: a
 * screen that renders because the session said so, over routes that all 403.
 *
 * The client asks; it never decides. Hiding a nav row is presentation, and
 * `requireSuperAdmin` on the routes is the control.
 */
export interface FAMe {
  subject: string;
  email: string;
  name?: string;
  superAdmin: boolean;
  /**
   * Whether ANY super admin is configured on this deployment — never who.
   *
   * ⚠ Its whole purpose is to keep *"you are not a super admin"* separate from
   * *"nobody is, so nothing can be assigned"*. The second needs an environment
   * variable set on the server, and a screen that cannot tell them apart shows
   * a person a dead end that looks like a permission problem.
   */
  superAdminConfigured: boolean;
  /**
   * Workspace-scoped capabilities for the caller when `?workspaceId` was sent.
   * Absent when called without a workspace — see `GET /api/me?workspaceId` B-06.
   * Server returns the union of role bundles + explicit grants; superAdmin gets all.
   */
  capabilities?: string[];
  /** The mode this person's new Forge chats open in; Workflow Builder until they choose. */
  forgeDefaultMode?: "workflow" | "agent";
  /**
   * Whether the cost report is theirs to open — an Admin of at least one workspace, or a super admin. The nav asks;
   * the report routes decide. Absent on an older server, which reads as "no".
   */
  canViewReports?: boolean;
}

/**
 * An identity this API has seen — `GET /api/platform/users`.
 *
 * ⚠ **Not an account and not a verified person.** A row means one thing: this
 * subject presented a token that verified against the deployment's identity
 * signing secret. Anything holding that secret can present any identity (I-13).
 * The route serves that bound in its own `caveat` field, with the data, and the
 * screen renders it.
 */
export interface FAPlatformUser {
  /** The identity token's `sub`. What an assignment is keyed on. */
  subject: string;
  email: string;
  name: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * A local account — a username and password for a person with no AD identity.
 *
 * ⚠ **No role and no super-admin flag, on the wire as in the table.** An
 * account is an identity; rights live in `workspace_members` keyed on
 * `subject`, so a person's rights are read from one place whether they arrived
 * through Entra or through here. ⚠ **And no password field of any kind** —
 * there is no route that returns one, which is the same rule as
 * `workspace_secrets` having no `?reveal=`.
 */
/** One workspace a local account holds a role in. */
export interface FALocalUserAccess {
  workspaceId: string;
  workspaceName: string;
  role: FAWorkspaceRole;
  /** Who granted it, or the literal `bootstrap` for a pre-2026-08-20 row. */
  grantedBy: string;
}

export interface FALocalUser {
  id: string;
  /** `local:<id>`. What a `workspace_members` assignment is keyed on. */
  subject: string;
  username: string;
  email: string | null;
  name: string | null;
  isActive: boolean;
  /** The super admin who created it, by subject. Attribution, never a permission. */
  createdBy: string | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface FATriggerFire {
  id: string;
  triggerId: string;
  /** `manual` | `schedule` | `poll` | `webhook`. */
  firedBy: string;
  firedAt: string | null;
  payload: unknown;
  flowExecutionId: string | null;
  flowExecutionStatus: string | null;
}

export interface FAScriptVersion {
  id: string;
  scriptId: string;
  versionNumber: number;
  code: string;
  diffFromPrevious: string | null;
  createdAt: string;
}
export interface FATestResult {
  id: string;
  overallStatus: string | null;
  summary: string | null;
  testsRan: boolean;
  testsPassed: boolean | null;
  testCommand: string | null;
  testOutput: string | null;
  syntaxCheckPassed: boolean | null;
  dependencyResolutionOk: boolean | null;
  dryRunExitCode: number | null;
  schemaAlignmentVerified: boolean | null;
  endpointConnectivityOk: boolean | null;
  generatedAt: string;
}
export interface FAProgress {
  status: string;
  stage: string;
  message: string | null;
  elapsedMs: number | null;
  // Telemetry (Workstream E): cumulative usage reported for this run so far.
  tokens?: number | null;
  toolCalls?: number | null;
  costUsd?: number | null;
  runStartedAt: string | null;
  runEndedAt: string | null;
  terminal: boolean;
}
export interface FAGenerateResult {
  script: FAScript;
  runId: string;
  sessionId: string;
  manifestVersion: number;
  fullManifestDelivered: boolean;
}

/**
 * `GET /api/health` — GAPS §6.2.
 *
 * The endpoint answers *"can this process serve requests?"*, which is why a
 * `down` Kestra leaves `serves: true`: with the engine unreachable this API is
 * still the only surface that can say so, and a 503 takes it out of the load
 * balancer at exactly that moment. `GET /api/health/strict` is the "everything
 * is wired" variant and 503s on any component.
 *
 * ⚠ Every component states the bound of its OWN probe in `caveat`. Render it
 * beside the status or not at all — a green tick with the caveat stripped is
 * the `llmConnected` mistake with a different subject.
 */
export interface FAHealthComponent {
  name: "database" | "migrations" | "kestra" | "ops-api" | "mail";
  status: "up" | "degraded" | "down" | "unknown";
  /** `down` on a critical component is the only thing that makes `serves` false. */
  critical: boolean;
  latencyMs: number | null;
  detail: string;
  caveat: string;
}
export interface FAParentHealth {
  status: "ok" | "degraded" | "down";
  serves: boolean;
  checkedAt: string;
  /** How stale the report is. Cached for `cacheTtlMs`; `?fresh=1` re-probes. */
  ageMs: number;
  cacheTtlMs: number;
  probeTimeoutMs: number;
  components: FAHealthComponent[];
  /** Kept from the two-key response this replaced. */
  db: boolean;
}

// ---- fetch core -------------------------------------------------------------

export class FoundryApiError extends Error {
  status: number;
  /**
   * The refusal's structured half, when the thrower attached one.
   *
   * `errorHandler` forwards `findings` on any 4xx and says why in its own
   * comment: *"flattening it to `message` here would undo that at the last hop,
   * which is the least visible place to lose it."* This client was doing exactly
   * that one hop later — `req` read `message` and dropped the rest — so
   * `assertReadOnly`'s and `assertRegistrableTarget`'s per-rule findings
   * (`{rule, message, facts}`) never reached a screen, and the only version a
   * person saw was the sentence they are joined into.
   *
   * ⚠ Typed `unknown` on purpose: three different throwers attach three shapes
   * (`PrivilegeFinding[]`, `TargetFinding[]`, `FlowValidationError`'s findings),
   * and a declared type here would be this client asserting a wire contract it
   * does not own. Narrow it where it is rendered — `lib/generation-findings.ts`
   * is the precedent, and I-100 is what happens when one shape is assumed.
   */
  findings?: unknown;
  /**
   * The type checker's structured diagnostics, when a save was refused by it
   * (typed-build phase 2) — `{code, severity, span: {stepId?, port?}, message,
   * help?}` per entry. `errorHandler` forwards them beside `findings`, by the
   * same rule, so a builder can put each one ON the step it names.
   *
   * ⚠ `unknown` for exactly the reason `findings` is: the shape is
   * `@foundry/flow-edit`'s contract, not this client's. Narrowed in ONE place,
   * `lib/step-diagnostics.ts`.
   */
  diagnostics?: unknown;
  constructor(message: string, status: number, findings?: unknown, diagnostics?: unknown) {
    super(message);
    this.status = status;
    this.findings = findings;
    this.diagnostics = diagnostics;
  }
}

// ---- What a run called ------------------------------------------------------
//
// Read from Foundry's own records since 2026-10-30 (`GET …/flow-executions/:id/calls`): every tool call and read a step
// made, and every web address it read. It was ops-api's call log, which only ever saw ops-api's own simulated tools.
/**
 * One REAL email attempt, from `email_sends`.
 * email-send-tool T037
 *
 * ⚠ There is **no body field, because the server stores none** (FR-009). The body
 * is the script's output and may carry tenant PII; the row answers "was a message
 * sent, to whom, and did it work" without it. Do not add one here expecting the
 * server to start sending it.
 *
 * ⚠ `graphMessageId` is a Graph **correlation id**, not an RFC 5322 Message-ID —
 * `sendMail` answers `202` with an empty body, so no provider message id exists at
 * that point. It is what a Microsoft support case is opened against; it will not be
 * found in a mail header.
 */
export interface FAEmailSend {
  id: string;
  stepId: string | null;
  recipients: string[];
  cc: string[];
  /**
   * `requester` — no `to` was given, so it went to the person who started the run.
   * `explicit`  — the flow named the addresses and they passed the allowlist.
   *
   * Shown, because "why did it go there?" is the first question asked about an
   * unexpected email.
   */
  resolvedFrom: "requester" | "explicit" | null;
  subject: string | null;
  /**
   * `refused` — Foundry declined; nothing left the building and the fix is here.
   * `failed`  — Graph was contacted and did not accept it; the fix is at the provider.
   *
   * Not interchangeable. Collapsing them sends someone whose allowlist is wrong to
   * go and read Azure logs.
   */
  outcome: "sent" | "refused" | "failed";
  graphMessageId: string | null;
  failureReason: string | null;
  createdAt: string | null;
}

/** One thing a run called, from Foundry's own records: a tool, a read, or a web address (`detail` says which and how it went). */
export interface FARunCall {
  id: string;
  kind: "tool" | "read" | "web";
  name: string;
  stepId: string | null;
  ok: boolean;
  durationMs: number | null;
  at: string;
  detail: string | null;
}
/**
 * The LLM provider as an operator may see it.
 *
 * ⚠ There is no `apiKey` field, and there must never be one. `keyFingerprint` is
 * eight hex characters of a salted digest — enough to tell two keys apart, not
 * enough to reconstruct either. Same rule as `WorkspaceSecret.hasValue`.
 */
export interface FALlmProvider {
  configured: boolean;
  baseUrl: string;
  keyFingerprint: string;
  defaultModel: string;
  allowedModels: string[];
  /** `env` until someone saves a configuration; `configured` afterwards. */
  source: "env" | "configured";
  updatedAt: string | null;
}
export interface FALlmTest {
  ok: boolean;
  model?: string;
  text?: string;
  latencyMs?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
}
export type ValidationIssue = { path?: Array<string | number>; message?: string };

/** A schema refusal in words: "The server did not accept this — step 4 › conditions › 1 › left › field: must not be empty." */
export function validationWords(issues: ValidationIssue[]): string {
  const where = (p: Array<string | number> = []) => {
    const parts: string[] = [];
    for (let i = 0; i < p.length; i += 1) {
      const k = p[i]!;
      if (k === "model") continue;
      if (k === "steps" && typeof p[i + 1] === "number") { parts.push(`step ${(p[i + 1] as number) + 1}`); i += 1; continue; }
      parts.push(typeof k === "number" ? String(k + 1) : k);
    }
    return parts.join(" › ");
  };
  const say = (m = "") => (/at least 1 character/i.test(m) ? "must not be empty" : m.replace(/^String /, "").toLowerCase() || "not accepted");
  const lines = issues.slice(0, 2).map((i) => `${where(i.path) || "the request"}: ${say(i.message)}`);
  const more = issues.length > 2 ? ` (and ${issues.length - 2} more)` : "";
  return `The server did not accept this — ${lines.join("; ")}${more}.`;
}

// ── cost report helpers (2026-10-26) ──────────────────────────────────────────
const reportQs = (q: import("./reports").ReportQuery, extra?: Record<string, string | number | undefined>) =>
  queryString(q, extra);
/** The same query as a JSON body: `workspaces` as an array, the period as `days` or `from`/`to`. */
function reportBody(q: import("./reports").ReportQuery) {
  return {
    ...(q.from && q.to ? { from: q.from, to: q.to } : { days: q.days ?? 30 }),
    ...(q.workspaces?.length ? { workspaces: q.workspaces } : {}),
    ...(q.flowId ? { flowId: q.flowId } : {}),
    ...(q.subject ? { subject: q.subject } : {}),
  };
}
/** A refusal on a binary route, with the server's own sentence. */
async function reportError(res: Response): Promise<FoundryApiError> {
  const body = await res.text().catch(() => "");
  signInIfEnded(res.status, body);
  let detail = body;
  try {
    detail = (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    /* not JSON */
  }
  return new FoundryApiError(detail || `GET /reports/export → ${res.status}`, res.status);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PROXY}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A session that has ended goes to sign-in (the error still throws, so nothing acts on a half-loaded page).
    signInIfEnded(res.status, body);
    // The Parent API's error envelope is {error, message}. Surface `message` —
    // some of these are written to be read by a person (the trigger enable gate
    // explains *why* it refused), and raw JSON in a toast throws that away.
    let detail = body;
    let findings: unknown;
    let diagnostics: unknown;
    try {
      const parsed = JSON.parse(body) as {
        message?: string;
        error?: string;
        findings?: unknown;
        diagnostics?: unknown;
        retryAfterSeconds?: number;
      };
      if (parsed?.message) detail = parsed.message;
      // ⚠ **A REFUSAL WITH NO `message` USED TO ARRIVE AS RAW JSON.** The 429
      // from `auth.middleware`, `identity.middleware` and the public receivers is
      // `{error:"rate_limited", retryAfterSeconds:60}` and carries no `message`
      // at all, so `detail` stayed the literal body and a person saw
      // `{"error":"rate_limited","retryAfterSeconds":60}` in a toast —
      // indistinguishable from a crash.
      //
      // ⚠ That distinction is what makes "refuse rather than queue" defensible
      // in the first place: rejecting is honest only if the caller is told they
      // were rejected AND that waiting will work. A limit rendered as gibberish
      // is worse than queueing, because the person cannot tell busy from broken.
      //
      // Scoped to the ONE code that has no message, deliberately. `budget_exceeded`
      // writes its own sentence naming the count and whether the limit was
      // configured, and a generic string here would overwrite a better one.
      else if (parsed?.error === "rate_limited") {
        const wait =
          typeof parsed.retryAfterSeconds === "number"
            ? ` Try again in about ${parsed.retryAfterSeconds} seconds.`
            : "";
        detail = `Too many attempts — this has been temporarily rate limited.${wait}`;
      }
      // ⚠ A schema refusal carries `issues`, not a `message`, and arrived as the raw envelope (I-321). Put it in words: where, what.
      else if (parsed?.error === "validation_error" && Array.isArray((parsed as { issues?: unknown }).issues)) {
        detail = validationWords((parsed as { issues: ValidationIssue[] }).issues);
      }
      // Carried, not summarised — see `FoundryApiError.findings`.
      findings = parsed?.findings;
      diagnostics = parsed?.diagnostics;
    } catch {
      /* not JSON — use the raw body */
    }
    throw new FoundryApiError(
      detail || `${init?.method ?? "GET"} ${path} → ${res.status}`,
      res.status,
      findings,
      diagnostics,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- Flow executions (Phase 2) ---------------------------------------------
// Deliberately identical to the UI types in `types.ts`. `adapters.ts` is still
// where the mapping lives, because the day these diverge — and a server owned by
// a different team eventually diverges — the seam has to already exist.
export interface FAFlowExecutionSummary {
  id: string;
  workspaceId: string;
  /**
   * FOUNDRY's flow uuid — the same id space as `FAFlow.id` and `/flows/:flowId`,
   * so a client can filter this list by a flow it holds.
   *
   * ⚠ It carried the Kestra SLUG until I-23 was fixed, and nothing broke, because
   * every consumer printed it. Filtering by the uuid returned zero rows, which
   * reads exactly like "this flow has never run".
   *
   * Null for a run whose flow has been deleted, and for pre-`flows` history. Use
   * `flowName` for a label; never this.
   */
  flowId: string | null;
  /**
   * The flow's slug — a human-readable name for the run, and the only one an
   * orphaned execution has. Not an address: Kestra needs a namespace too, and the
   * namespace is never served (R5).
   *
   * `| null` on the client and non-null on the server: an older server simply
   * does not send it, and the label must then degrade rather than print
   * "undefined".
   */
  flowName: string | null;
  /**
   * The flow's `name` as it was when THIS run began — frozen, so renaming the
   * flow later never relabels a run that already happened. Null for a run from
   * before this field existed, or one whose flow had no name to snapshot.
   */
  flowNameSnapshot: string | null;
  /**
   * The flow's `id` as it was when THIS run began — frozen, same rule as
   * `flowNameSnapshot` above, applied to the id instead of the name. Null for
   * a run from before this field existed, or one whose flow had no id to
   * snapshot.
   */
  flowIdSnapshot: string | null;
  status: string;
  engineStatus: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputs: Record<string, unknown>;
  replayOfId: string | null;
  replayFromStep: string | null;
  autoTest?: boolean;
  /**
   * A list run's steps in LIGHT form (2026-10-11): id, status, attempt, error, loop counts — never inputs, outputs or
   * logs. Present for a flow-runner run in `view=page`/`view=summary`; absent for an engine run (fetch it in full).
   */
  steps?: FAFlowStepRun[];
}
export interface FASandboxTaxonomyItem {
  id: string;
  title: string;
  satisfied: boolean;
  evidence: string | null;
}

export interface FASandboxStatus {
  datasourceId: string;
  datasourceName: string;
  hasSandbox: boolean;
  dbName: string | null;
  fixtureVersion: number | null;
  frozenAt: string | null;
  generatedBy: string | null;
  model: string | null;
  taxonomy: { items: FASandboxTaxonomyItem[]; integrity: { ok: boolean; problems: string[] }; passed: boolean } | null;
  dateRange: { from: string; to: string } | null;
  drift: { was: string; now: string } | null;
  /**
   * How an AUTOMATIC build went (the one started by introspection), or null
   * where none was ever started — a CLI-provisioned datasource, or one
   * onboarded before that existed.
   *
   * ⚠ **`failed` and null are different and neither means "there is a
   * sandbox".** `hasSandbox` is still the only thing that decides what a draft
   * run reads, and `exposure` below is still present whenever it is false. A
   * panel that renders `failed` as "no sandbox yet" turns an error into an
   * absence, which is the one thing this surface must never do.
   */
  buildStatus: "building" | "ready" | "failed" | null;
  buildError: string | null;
  buildStartedAt: string | null;
  /** Present when `hasSandbox` is false. The server's own sentence — rendered verbatim. */
  exposure: string | null;
}

/** The dashboard's summary as the server computes it (`view=summary`). */
export type FAHealthRange = "today" | "7d" | "30d";
export type FARunEnv = "live" | "test";
export type FARunScope = "mine" | "everyone";

export interface FAHealthCounts {
  runs: number;
  /** succeeded + failed + partial. */
  settled: number;
  succeeded: number;
  failed: number;
  partial: number;
}

/** What started a run. `cron` (schedules only) is raw — `describeCron` turns it into words. */
export interface FAStartedBy {
  kind: "person" | "replay" | "schedule" | "trigger" | "test" | "system" | "unknown";
  label: string;
  detail: string | null;
  cron?: string | null;
}

export type FAHealthRun = FAFlowExecutionSummary & { startedBy: FAStartedBy; items?: { done: number; total: number } };

/** The dashboard's "Runs and health" (2026-10-23), computed by the server for one period. */
export interface FAFlowRunsSummary {
  env: FARunEnv;
  /** What the server applied — "everyone" whenever the person has no choice. */
  scope: FARunScope;
  /** Whether "Mine / Everyone" is offered: only to those who see beyond their own work (Admins and Reviewers). */
  choosesScope: boolean;
  health: {
    range: FAHealthRange;
    current: FAHealthCounts;
    previous: FAHealthCounts;
    failedAutomations: number;
    series: Array<FAHealthCounts & { start: string }>;
    bucket: "hour" | "day";
    runningNow: number;
    longestRunningMs: number | null;
    medianMs: number | null;
  };
  recent: FAHealthRun[];
  running: FAHealthRun[];
}

export interface FAFlowStepRun {
  stepId: string;
  /** For each (phase F): see `StepRun.items`. */
  items?: Array<{ i: number; status: string; path: string[]; error: string | null; result: unknown }>;
  perItem?: { ran: number; succeeded: number; failed: number };
  loop?: string;
  status: string;
  kind: string | null;
  /** The catalogue entry the step calls, from the revision it ran. Drives the model-seam badge. */
  ref: string | null;
  /** `sandbox` | `production` — which database a `datasource` step read (Stage 4). */
  readFrom?: string | null;
  /** A task the compiler emitted rather than a step anybody declared. */
  platform?: boolean;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  request: { uri: string; method: string } | null;
  responseCode: number | null;
  output: Record<string, unknown> | null;
  error: string | null;
  logs: Array<{ timestamp: string; level: string; message: string }>;
  /** What the step was given, after binding — runner (Pi-built) runs only. */
  input?: { params?: Record<string, unknown>; inputs?: Record<string, unknown> } | null;
  /** The runner's output checks (flow-runner checks.py). */
  checks?: import("./types").StepCheck[] | null;
  /** The runner's own word for how the step ended: not_taken, waiting, partial, rejected, expired… (P5/P7). */
  outcome?: string | null;
  /** Why it did not run (a branch's other path, an earlier failure, a rejection). */
  reason?: string | null;
  kestraTaskrunId: string | null;
  auditVerdict: string | null;
  oracleScore: number | null;
}
export interface FAFlowExecutionDetail extends FAFlowExecutionSummary {
  engineStatus: string;
  steps: FAFlowStepRun[];
  graph: { nodes: Array<{ id: string; type: string | null }>; edges: Array<{ source: string; target: string }> } | null;
  engineUnavailable?: string;
  /** A draft run started with the admin production opt-in. */
  usedProductionData?: boolean;
  /** It used another person's own account: only its status is shown (sharing-boundaries D4). */
  dataHidden?: boolean;
  /** GAPS §2.3 — what the flow claimed about its output, and how this run did. */
  expectations?: Array<{
    expectationId: string;
    stepId: string;
    status: string;
    detail: string;
    observed: unknown;
  }>;
}

// ---- Phase 6: replay, portability, templates, promotion --------------------

export interface FAReplayableStep {
  stepId: string;
  state: string;
  replayable: boolean;
  /** Present when `replayable` is false. Rendered verbatim — the server wrote it. */
  reason?: string;
}
/**
 * How long this run stays replayable — GAPS §6.3.
 *
 * Retention and the replay window are ONE number, and nothing said so where a
 * person would see it. Every field here is computed server-side from
 * `config.kestra.retentionDays`; the browser must never derive a window of its
 * own, because a second source is exactly how a UI ends up promising 30 days
 * against a purge running at 7.
 */
export interface FAReplayWindow {
  days: number;
  /** ISO. `null` when the run has no recorded start. */
  expiresAt: string | null;
  /** Floored at 0 — an already-purgeable run reads `0`, never a negative. */
  daysRemaining: number | null;
  /** Close enough to the edge to say so before somebody plans around it. */
  expiringSoon: boolean;
  /** The server's sentence. Render it verbatim; do not paraphrase the coupling. */
  note: string;
}

export interface FAReplayPlan {
  executionId: string;
  engineState: string | null;
  replayable: boolean;
  reason?: string;
  steps: FAReplayableStep[];
  /** Present on refusals too — that is the screen where the window matters most. */
  retention: FAReplayWindow;
}
export interface FAReplayResult {
  mode: "full" | "from_step";
  /** The new run, addressed by its FOUNDRY id. */
  execution: { id: string; status: string } | null;
  /**
   * False when a full replay started but no Foundry row appeared. Surfaced rather
   * than swallowed: one reason is a slow engine and the other is the approval gate
   * refusing the run, and the second is worth hearing about.
   */
  lineageRecorded: boolean;
  note?: string;
}

/**
 * A flow bundle. Structurally opaque to the client on purpose — it is passed
 * through to import unchanged, and a browser-side reshaping of it is a second
 * format the server would then have to accept.
 */
export interface FAFlowBundle {
  formatVersion: number;
  source: { flowName: string; kestraFlowId: string; revision: number; workspaceName?: string };
  flow: { name: string; description?: string };
  model: { id: string; steps: Array<{ id: string; kind: string }> };
  refs: Array<{ ref: string; kind: "tool" | "query"; signature: string }>;
  secretNames: string[];
}
export interface FAImportFinding {
  code: string;
  blocking: boolean;
  stepId?: string;
  ref?: string;
  message: string;
}
export interface FAImportPlan {
  findings: FAImportFinding[];
  warnings: FAImportFinding[];
  remapped: Array<{ from: string; to: string }>;
  importable: boolean;
  contracts: Record<string, { purpose: string }>;
}
export type FAImportResult =
  | {
      status: "ok";
      flow: FAFlow;
      revision: number;
      warnings: FAImportFinding[];
      remapped: Array<{ from: string; to: string }>;
      inferenceCalls: number;
    }
  | {
      status: "insufficient_contract";
      refusals: Array<{ stepId: string; missing?: string[]; reason?: string }>;
      warnings: FAImportFinding[];
    };

export interface FAFlowTemplate {
  id: string;
  name: string;
  description: string | null;
  sourceFlowId: string | null;
  sourceRevision: number | null;
  createdBy: string | null;
  createdAt: string | null;
  stepCount: number;
}

export interface FAFragmentCandidate {
  shapeKey: string;
  signature: string;
  flowCount: number;
  purposes: string[];
  distinctBodies: number;
  /** The interface matched but the purposes did not. Say so; do not hide it. */
  shapeOnly: boolean;
  occurrences: Array<{ flowId: string; flowName: string; stepId: string; purpose: string }>;
}

/**
 * A workspace secret as the server is willing to describe it: PRESENCE, never
 * content. `hasValue` is `Boolean(valueEnc)` computed server-side — the encrypted
 * bytes do not leave the process either.
 */
export interface FAWorkspaceSecret {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  hasValue: boolean;
  hasSandboxValue: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A credential of ANY kind, as the server is willing to describe it: PRESENCE,
 * never content (Phase 5, D-01). `hasValue` is computed server-side and the
 * encrypted bytes do not leave the process.
 *
 * `ref` is the stable identifier — the env-var name for secrets, the datasource
 * name for a DSN, the trigger name for webhook/api. `lastUsedAt` may be omitted
 * entirely (never used) rather than sent as null.
 */
export type FACredentialKind = "tool" | "database" | "webhook" | "api" | "llm" | "generic";

export interface FACredentialView {
  kind: FACredentialKind;
  ref: string;
  label?: string;
  hasValue: boolean;
  lastUsedAt?: string | null;
}

/**
 * `configured` — ⚠ names with a stored value **that something references**, not
 *                every stored name (`issues.md` I-96). It is computed from
 *                declarations, so a secret nothing references appears in neither
 *                `configured` nor `missing`. `listSecrets` enumerates what is stored.
 * `missing`    — names a tool or datasource references with nothing stored.
 *                ⚠ `{envName, neededBy}` objects, not strings (**I-97**).
 * `collisions` — one env-var name claimed by two different secrets. Fails an
 *                execution with a 409 rather than last-write-wins, so a shadowed
 *                credential presents as a wrong key, not a silent misconfiguration.
 *                Two tools SHARING one secret is not a collision.
 */
export interface FASecretAudit {
  configured: string[];
  missing: { envName: string; neededBy: string }[];
  collisions: string[];
}

/**
 * Something that reads a secret BY NAME, and therefore breaks when the name moves.
 *
 * ⚠ A datasource is deliberately not one of these. A datasource declares an
 * env-var name too, but its value is its own encrypted DSN — nothing looks that
 * name up in the secret store. A datasource sharing a name is a COLLISION, which
 * fails an execution with a 409. These are the SILENT ones.
 */
export interface FASecretReference {
  kind: "tool";
  label: string;
  /** What actually happens when the name stops resolving. Not "may be affected". */
  breaks: string;
}

/**
 * ⚠ There is no `willSuspendFlows` here and there must not be, however closely
 * this mirrors `namedQueryImpact` (D-84). A named query's edit moves a ref
 * fingerprint, so the staleness sweep unarms the flows using it and they STOP. A
 * secret rename moves no fingerprint at all: every armed flow stays armed and
 * keeps running, and just signs in with nothing.
 */
export interface FASecretImpact {
  name: string;
  newName: string | null;
  /** Everything referencing the CURRENT name. A rename orphans exactly these. */
  references: FASecretReference[];
  /** Another SECRET holds the new name — a hard refusal. */
  nameTaken: boolean;
  /** A DATASOURCE declares it — reported, not refused: a collision is loud. */
  collidesWithDatasource: string | null;
  /** References the new name would START satisfying — the rename is the fix. */
  adopts: FASecretReference[];
  orphanWarning: string | null;
}

export interface FASecretRename {
  from: string;
  to: string;
  orphaned: FASecretReference[];
}

// ---- The engine's plugin registry (ui-upgrade Phase 9, D-111) --------------
//
// ⚠ **Not tenant-scoped, and there is no tenant-scoped form.** Plugins are a
// property of the engine's BUILD, not of a workspace; Kestra has no per-tenant
// plugin endpoint at all. Hence `/api/engine/plugins` rather than a path under
// `/workspaces/:ws`, which would state a registry that does not exist.
//
// ⚠ **The browser never reaches Kestra and must not learn how.** The engine
// publishes no port and cannot have one, and `kestra-ui` has no tenant
// isolation. This is a shaped server-side read, never a proxy, and it carries no
// Kestra URL (R5).

/** One class a plugin supplies. */
export interface FAPluginClass {
  cls: string;
  simpleName: string;
  kind: "task" | "trigger" | "condition" | "taskRunner" | "storage" | "other";
  title: string | null;
  deprecated: boolean;
  /**
   * ⚠ Whether an automation in this product can actually use it. The engine
   * registering a class and Foundry being able to emit it are DIFFERENT FACTS,
   * and conflating them turns this page into a catalogue of things you cannot
   * ask for.
   */
  reachable: boolean;
}

export interface FAPlugin {
  name: string;
  group: string | null;
  title: string | null;
  description: string | null;
  /** Null for `core`, which ships with the engine and has no version of its own. */
  version: string | null;
  categories: string[];
  /**
   * The plugin's logo as a base64 SVG, or null. Reduced server-side to one per
   * plugin — the engine's own icon endpoint returns 2.4 MB in a single body and
   * must never be proxied to a browser.
   */
  icon: string | null;
  classes: FAPluginClass[];
  counts: {
    total: number;
    reachable: number;
    tasks: number;
    triggers: number;
    conditions: number;
    taskRunners: number;
    other: number;
  };
}

export interface FAEnginePlugins {
  /** ⚠ False when the engine could not be read — NEVER a silently empty list. */
  reachable: boolean;
  engine: { version: string | null; edition: string | null };
  plugins: FAPlugin[];
  foundryEmits: string[];
  totals: { plugins: number; classes: number; reachable: number };
  /** Why the numbers are what they are. Two readers, one sentence — render them. */
  notes: string[];
  /** The transport diagnosis when `reachable` is false. Not "no data". */
  detail?: string;
}

/** One field a plugin's author marked as part of connecting to it. */
export interface FAPluginCredentialField {
  name: string;
  title: string | null;
  description: string | null;
  type: string;
  required: boolean;
  /**
   * ⚠ `declared` — the plugin's own author marked it as part of connecting.
   * `inferred` — matched by NAME, because this plugin classifies none of its
   * properties. AWS is the case: `accessKeyId`/`secretKeyId` carry no group at
   * all, and a filter on the group alone reports that AWS needs nothing to sign
   * in. The distinction is rendered — a guess presented as the author's word is
   * the failure mode.
   */
  source: "declared" | "inferred";
}

export interface FAPluginCredentials {
  plugin: string;
  /** False when the engine could not be read — never a silently empty field list. */
  reachable: boolean;
  fields: FAPluginCredentialField[];
  /** How many of the plugin's classes were actually asked about, and out of how many. */
  classesRead: number;
  classesTotal: number;
  /**
   * ⚠ Whether a flow in this product can call this plugin AT ALL — `false` for
   * every non-core plugin on this engine. A credentials form is the strongest
   * possible claim that filling it in makes something work; this is the field
   * that stops that claim being made.
   */
  usableToday: boolean;
  notes: string[];
  detail?: string;
}

// ---- Audit explorer (S-68, Phase 13) ---------------------------------------
// Two views of ONE immutable record: Plain English and Raw events.
// Every row carries its raw event inline behind a per-row disclosure.
// `audit_events` is the table per mapping.md Phase 13 — entity is an enum,
// where is a typed {entityType, entityId} reference, not prose. UI renders
// `where` as a breadcrumb. Operations: create · update · delete · publish ·
// approve · reject · access · execute.

export type FAAuditOperation =
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "approve"
  | "reject"
  | "access"
  | "execute";

export interface FAAuditEvent {
  id: string;
  time: string;
  actor: string;
  operation: FAAuditOperation;
  entity: string;
  entityId?: string;
  description: string;
  where: string;
  raw?: unknown;
}
export interface FAAttendanceStatus {
  identity: { displayName: string; title: string };
  daysInOffice: number;
  requiredDays: number;
  avgHours: string;
  lastCalculatedAt: string;
  nextCalculationAt: string;
  calculated: {
    officeDaysMeetingThreshold: { label: string; value?: number };
    annualLeaveDays: number;
    publicHolidays: number;
    result: { label: string; compliant?: boolean };
  };
  history: Array<{ month: string; compliant: boolean; label?: string }>;
  compliant: boolean;
}
export interface FAExceptionNotice {
  id: string;
  status: "pending" | "approved" | "declined";
  message?: string;
  notice?: string;
  reason?: string;
  approver?: string;
}
export type FAIncidentSeverity = "sev1" | "sev2" | "sev3";
export type FAIncidentStatus =
  | "reported"
  | "triaged"
  | "investigating"
  | "contained"
  | "recovering"
  | "monitoring"
  | "resolved"
  | "post-incident-review"
  | "closed";
export interface FAIncident {
  id: string;
  workspaceId: string;
  title: string;
  severity: FAIncidentSeverity;
  status: FAIncidentStatus;
  ownerSubject: string | null;
  openedAt: string;
  timeline: unknown;
}
export interface FABreakGlassSession {
  id: string;
  workspaceId: string;
  incidentId: string;
  scope: "hris-unmasked" | "payroll-restricted";
  durationHours: number;
  justification: string;
  acknowledged: boolean;
  activatedBySubject: string;
  activatedAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
}
export interface FAReleaseGate {
  id: string;
  workspaceId: string;
  flowId: string | null;
  name: string;
  enabled: boolean;
  satisfiedBy: string;
  policyId: string | null;
  ordinal: number;
  createdAt: string | null;
}
export interface FAMemberCapability {
  subject: string;
  capability: string;
  grantedBy: string;
  createdAt: string;
}
/** One holder of a CUSTOM workspace role. Presets have no assignment table. */
export interface FAWorkspaceRoleMember {
  subject: string;
  grantedBy: string;
  createdAt: string;
}
export interface FABudget {
  workspaceId: string;
  maxConcurrentExecutions: number;
  maxTokensPerDay: number | null;
  configured: boolean;
}

// ---- the App A contract (+ the extra methods App A's server exposes) --------

export const foundryApi = {
  // Workspaces
  // ⚠ A restricted workspace the caller is outside of comes back as a stub (`closed: true`) for the platform tier. It is
  // dropped HERE, so no screen can offer it as a workspace to switch to or resolve it as the active one; only
  // `listClosedWorkspaces` returns them.
  listWorkspaces: (opts?: { counts?: boolean }) =>
    req<{ workspaces: Array<FAWorkspace | FAClosedWorkspace> }>(opts?.counts ? "/workspaces?with=counts" : "/workspaces").then(
      (r) => r.workspaces.filter((w): w is FAWorkspace => !("closed" in w && w.closed)),
    ),
  listClosedWorkspaces: () =>
    req<{ workspaces: Array<FAWorkspace | FAClosedWorkspace> }>("/workspaces").then((r) =>
      r.workspaces.filter((w): w is FAClosedWorkspace => "closed" in w && w.closed === true),
    ),
  setWorkspaceRestricted: (wsId: string, restricted: boolean) =>
    req<{ workspace: FAWorkspace }>(`/workspaces/${wsId}/restricted`, { method: "PUT", body: JSON.stringify({ restricted }) }).then((r) => r.workspace),
  startEmergencyAccess: (body: { workspaceId: string; reason: string; hours: 1 | 2 | 4 }) =>
    req<{ access: FAEmergencyAccess; notified: string }>("/platform/emergency-access", { method: "POST", body: JSON.stringify(body) }),
  listEmergencyAccess: (wsId: string) =>
    req<{ accesses: FAEmergencyAccess[] }>(`/workspaces/${wsId}/emergency-access`).then((r) => r.accesses),
  endEmergencyAccess: (wsId: string, accessId: string) =>
    req<{ access: FAEmergencyAccess }>(`/workspaces/${wsId}/emergency-access/${accessId}/end`, { method: "POST" }).then((r) => r.access),
  createWorkspace: (body: { name: string; description?: string; assistant?: boolean; agentChanges?: boolean; restricted?: boolean }) =>
    req<{ workspace: FAWorkspace }>("/workspaces", { method: "POST", body: JSON.stringify(body) }).then(
      (r) => r.workspace,
    ),
  updateWorkspace: (wsId: string, body: { name?: string; description?: string; assistant?: boolean; agentChanges?: boolean; selfEnable?: boolean; webAccess?: boolean }) =>
    req<{ workspace: FAWorkspace }>(`/workspaces/${wsId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.workspace),
  deleteWorkspace: (wsId: string) => req<void>(`/workspaces/${wsId}`, { method: "DELETE" }),

  // Secrets — presence only, never a value. There is deliberately no read
  // endpoint for a secret's content and no `?reveal=`; see routes/workspace-secrets.ts.
  listSecrets: (wsId: string) =>
    req<{ secrets: FAWorkspaceSecret[] }>(`/workspaces/${wsId}/secrets`).then((r) => r.secrets),
  auditSecrets: (wsId: string) =>
    req<FASecretAudit>(`/workspaces/${wsId}/secrets/audit`),
  /**
   * The Email box — what automations tried to email, and what was HELD because
   * the run was a draft. The only client read of this route.
   */
  getEmailBox: (wsId: string, limit = 100) =>
    req<EmailBox>(`/workspaces/${wsId}/email-box?limit=${limit}`),
  /**
   * Clear every NEVER-DELIVERED message in this workspace — held, refused and failed. The server fixes the set; a
   * delivered message is the record that real mail was sent and no button removes it.
   */
  clearUndeliveredEmails: (wsId: string) =>
    req<{ ok: true; cleared: number }>(`/workspaces/${wsId}/email-box/undelivered`, { method: "DELETE" }),
  /** Remove ONE never-delivered message. A delivered one is refused (409) with the server's sentence. */
  deleteEmail: (wsId: string, id: string) =>
    req<{ ok: true; cleared: number }>(`/workspaces/${wsId}/email-box/messages/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createSecret: (
    wsId: string,
    body: { name: string; value: string; description?: string; sandboxValue?: string },
  ) =>
    req<{ secret: FAWorkspaceSecret }>(`/workspaces/${wsId}/secrets`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.secret),
  /**
   * What renaming or deleting this secret would break, WITHOUT doing it.
   *
   * ⚠ A GET, and it must be asked BEFORE the write — the consequence is not
   * visible afterwards. Nothing is suspended, no fingerprint moves and no
   * manifest changes; the reference simply stops resolving and the first sign is
   * a 401 inside a run. Same split as `namedQueryImpact` (D-84).
   *
   * It returns names and booleans and nothing from a value.
   */
  secretImpact: (wsId: string, id: string, newName?: string) =>
    req<FASecretImpact>(
      `/workspaces/${wsId}/secrets/${id}/impact` +
        (newName ? `?name=${encodeURIComponent(newName)}` : ""),
    ),
  /**
   * ⚠ Returns `{ secret, rename }`. `rename` is null for every edit that does
   * not move the name.
   *
   * A rename that orphans a reference is refused by the SERVER with a 409 unless
   * `confirmOrphans` is true — so a caller that never asks cannot orphan one by
   * omission. Ask `secretImpact` first, show the list, then send the flag.
   */
  updateSecret: (
    wsId: string,
    id: string,
    body: {
      name?: string;
      value?: string;
      description?: string;
      sandboxValue?: string | null;
      confirmOrphans?: boolean;
    },
  ) =>
    req<{ secret: FAWorkspaceSecret; rename: FASecretRename | null }>(
      `/workspaces/${wsId}/secrets/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  deleteSecret: (wsId: string, id: string) =>
    req<void>(`/workspaces/${wsId}/secrets/${id}`, { method: "DELETE" }),

  // Credentials (Phase 5, D-01) — the unified view across the stores the
  // vault-relay seam owns. Values NEVER return; only `hasValue` does. The seam
  // owns the secret store (tool/llm/generic); database/webhook/api
  // credentials are the datasource/trigger stores and refuse writes here with a
  // clean 409 — they are managed on their owning pages.
  listCredentials: (wsId: string) =>
    req<{ credentials: FACredentialView[] }>(`/workspaces/${wsId}/credentials`).then((r) => r.credentials),
  /** Create-or-update by ref (`name`). Omit `value` to keep the stored one. */
  upsertCredential: (
    wsId: string,
    body: { kind: FACredentialKind; name: string; label?: string; value?: string },
  ) =>
    req<void>(`/workspaces/${wsId}/credentials`, { method: "POST", body: JSON.stringify(body) }),
  deleteCredential: (wsId: string, ref: string) =>
    req<void>(`/workspaces/${wsId}/credentials/${encodeURIComponent(ref)}`, { method: "DELETE" }),

  /**
   * What the execution engine can do. ⚠ Instance-wide, not per workspace.
   *
   * Installing a plugin is deliberately absent (D-85): provisioning the engine
   * is a deployment operation — a button here would be one that rebuilds an
   * image.
   */
  enginePlugins: () => req<FAEnginePlugins>("/engine/plugins"),

  // ── Connectors (plans/plugins-2026-10-27). ⚠ No method returns a connection's value. ──────────────────────────────
  connectorMarketplace: (wsId: string) => req<ConnectorMarketplace>(`/workspaces/${wsId}/plugins/marketplace`),
  workspaceConnectors: (wsId: string) => req<{ plugins: WorkspaceConnector[] }>(`/workspaces/${wsId}/plugins`).then((r) => r.plugins),
  createConnection: (wsId: string, short: string, body: { label: string; authType?: string; fields: Record<string, string | number | boolean>; asMe?: boolean }) =>
    req<{ connection: ConnectorConnection }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/connections`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.connection),
  updateConnection: (wsId: string, id: string, body: { label?: string; fields?: Record<string, string | number | boolean> }) =>
    req<{ connection: ConnectorConnection }>(`/workspaces/${wsId}/plugins/connections/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) => r.connection),
  testConnection: (wsId: string, id: string) =>
    req<ConnectionTestResult>(`/workspaces/${wsId}/plugins/connections/${id}/test`, { method: "POST" }),
  deleteConnection: (wsId: string, id: string) => req<void>(`/workspaces/${wsId}/plugins/connections/${id}`, { method: "DELETE" }),
  setConnectorActions: (wsId: string, short: string, body: { connectionId: string; actions: string[] }) =>
    req<{ plugin: WorkspaceConnector }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/actions`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.plugin),
  // Declared API calls (plans/declared-api-calls-2026-10-29).
  declaredCalls: (wsId: string, short: string) =>
    req<{ calls: DeclaredCallView[]; packs: DeclaredCallPack[] }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/calls`),
  declareCall: (wsId: string, short: string, body: { connectionId: string; call: DeclaredCallInput }) =>
    req<{ name: string; hash: string; writes: boolean; changed: boolean }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/calls`, { method: "POST", body: JSON.stringify(body) }),
  enableCallPack: (wsId: string, short: string, pack: string, connectionId: string) =>
    req<{ pack: string; calls: Array<{ name: string }> }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/call-packs/${encodeURIComponent(pack)}`, { method: "POST", body: JSON.stringify({ connectionId }) }),
  removeDeclaredCall: (wsId: string, short: string, name: string) =>
    req<{ name: string; on: false }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/calls/${encodeURIComponent(name)}`, { method: "DELETE" }),
  // For me (plans/personal-actions-2026-10-29): actions a person switches on for themselves, through their own account.
  personalConnector: (wsId: string, short: string) => req<PersonalConnectorView>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/mine`),
  setMyConnectorActions: (wsId: string, short: string, actions: string[]) =>
    req<PersonalConnectorView>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/mine/actions`, { method: "PUT", body: JSON.stringify({ actions }) }),
  enableMyCallPack: (wsId: string, short: string, pack: string) =>
    req<PersonalConnectorView>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/mine/call-packs/${encodeURIComponent(pack)}`, { method: "POST" }),
  removeMyDeclaredCall: (wsId: string, short: string, name: string) =>
    req<PersonalConnectorView>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/mine/calls/${encodeURIComponent(name)}`, { method: "DELETE" }),
  setPersonalUse: (wsId: string, short: string, allowed: boolean) =>
    req<{ allowed: boolean }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/personal-use`, { method: "PUT", body: JSON.stringify({ allowed }) }),
  connectorInstalls: () => req<{ installs: ConnectorInstall[] }>("/plugins/installs").then((r) => r.installs),
  installConnector: (body: { piece: string; version?: string; hosts?: string[] }) =>
    req<{ install: ConnectorInstall }>("/plugins/installs", { method: "POST", body: JSON.stringify(body) }).then((r) => r.install),
  setConnectorHosts: (short: string, hosts: string[]) =>
    req<{ install: ConnectorInstall }>(`/plugins/installs/${encodeURIComponent(short)}/hosts`, { method: "PUT", body: JSON.stringify({ hosts }) }).then((r) => r.install),
  upgradeConnector: (short: string, version: string) =>
    req<{ install: ConnectorInstall; toolsRepointed: number }>(`/plugins/installs/${encodeURIComponent(short)}/upgrade`, { method: "POST", body: JSON.stringify({ version }) }),
  uninstallConnector: (short: string) => req<void>(`/plugins/installs/${encodeURIComponent(short)}`, { method: "DELETE" }),
  connectorOauthApp: (short: string) => req<{ app: ConnectorOauthApp }>(`/plugins/oauth-apps/${encodeURIComponent(short)}`).then((r) => r.app),
  setConnectorOauthApp: (short: string, body: { useSignInApp?: boolean; clientId?: string; clientSecret?: string; scopes?: string[] }) =>
    req<{ app: ConnectorOauthApp }>(`/plugins/oauth-apps/${encodeURIComponent(short)}`, { method: "PUT", body: JSON.stringify(body) }).then((r) => r.app),
  removeConnectorOauthApp: (short: string) => req<void>(`/plugins/oauth-apps/${encodeURIComponent(short)}`, { method: "DELETE" }),
  /** Begin signing in: the browser then goes to `authorizeUrl`. A connector that needs no person connects at once. */
  startConnectorOauth: (wsId: string, short: string, body: { label?: string; connectionId?: string; asMe?: boolean; props?: Record<string, string | number | boolean> }) =>
    req<{ authorizeUrl: string; scopes: string[] } | { connection: ConnectorConnection }>(`/workspaces/${wsId}/plugins/${encodeURIComponent(short)}/oauth/start`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /**
   * What one plugin needs in order to authenticate, read from the engine's own
   * property schema.
   *
   * ⚠ **`usableToday` is on the response and must be rendered.** It is `false`
   * for every plugin on this engine — Foundry's compiler emits seven class
   * types and none of them belong to a plugin — so a credentials form here
   * shows what WOULD be needed, not something that starts working when filled
   * in. See the server service's docblock.
   */
  pluginCredentials: (name: string) =>
    req<FAPluginCredentials>(`/engine/plugins/${encodeURIComponent(name)}/credentials`),

  /**
   * Chat mode (Phase 2.8). ⚠ A turn is SYNCHRONOUS — bounded at 1024 output
   * tokens, so it is one op and seconds, where a generation is minutes and needs
   * a job row you can come back to.
   *
   * ⚠ Every terminal state comes back 200 with the status ON THE TURN, including
   * `insufficient_contract`. A client that treated a refusal as an HTTP error
   * would render the most useful diagnosis this system produces as a failure,
   * and offer a retry for it.
   */
  createChatThread: (wsId: string, body: { name: string; flowId?: string; designSelection?: unknown }) =>
    req<{ thread: FAChatThread }>(`/workspaces/${wsId}/flow-chat/threads`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Bind the flow a generation job seeded to a thread that has none yet (a goal typed after questions). */
  attachChatThreadFlow: (wsId: string, threadId: string, flowId: string) =>
    req<{ thread: FAChatThread }>(`/workspaces/${wsId}/flow-chat/threads/${threadId}/flow`, {
      method: "POST",
      body: JSON.stringify({ flowId }),
    }),
  listChatThreads: (wsId: string) =>
    req<{ threads: FAChatThread[] }>(`/workspaces/${wsId}/flow-chat/threads`).then((r) => r.threads),
  listChatTurns: (wsId: string, threadId: string) =>
    req<{ turns: FAChatTurn[] }>(
      `/workspaces/${wsId}/flow-chat/threads/${threadId}/turns`,
    ).then((r) => r.turns),
  chatTurn: (
    wsId: string,
    threadId: string,
    body: { message: string; targetStepId?: string },
    opts?: { signal?: AbortSignal },
  ) =>
    req<{ turn: FAChatTurn; flowId: string | null; diff?: FAFlowDiff }>(
      `/workspaces/${wsId}/flow-chat/threads/${threadId}/turns`,
      { method: "POST", body: JSON.stringify(body), ...(opts?.signal ? { signal: opts.signal } : {}) },
    ),

  // Tools
  listTools: (wsId: string) =>
    req<{ tools: FATool[] }>(`/workspaces/${wsId}/tools`).then((r) => r.tools),
  createTool: (wsId: string, body: Record<string, unknown>) =>
    req<{ tool: FATool }>(`/workspaces/${wsId}/tools`, { method: "POST", body: JSON.stringify(body) }).then(
      (r) => r.tool,
    ),
  updateTool: (wsId: string, toolId: string, body: Record<string, unknown>) =>
    req<{ tool: FATool }>(`/workspaces/${wsId}/tools/${toolId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.tool),
  deleteTool: (wsId: string, toolId: string) =>
    req<void>(`/workspaces/${wsId}/tools/${toolId}`, { method: "DELETE" }),
  /**
   * "Test this tool" — `specs/20260818-123807-tool-probe`.
   *
   * ⚠ **A 200 here does not mean the tool works.** It means Foundry managed to
   * ask; the answer is `probe.verdict`. An endpoint's 401 is a 200 with
   * `verdict: "auth_rejected"`, and every non-200 means Foundry could not attempt
   * the call at all (424 unstored credential, 409 collision, 429 rate limit).
   * `req` throws on those, so the panel renders the thrown error — which is
   * correct, and is why there is no fallback probe object anywhere.
   */
  probeTool: (wsId: string, body: Record<string, unknown>) =>
    req<{ probe: ToolProbe }>(`/workspaces/${wsId}/tools/probe`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.probe),

  // Datasources
  listDatasources: (wsId: string) =>
    req<{ datasources: FADatasource[] }>(`/workspaces/${wsId}/datasources`).then((r) => r.datasources),
  getDatasource: (wsId: string, dsId: string) =>
    req<{ datasource: FADatasource }>(`/workspaces/${wsId}/datasources/${dsId}`).then((r) => r.datasource),
  createDatasource: (wsId: string, body: Record<string, unknown>) =>
    req<{ datasource: FADatasource }>(`/workspaces/${wsId}/datasources`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.datasource),
  /**
   * Upload a SQLite database file — the body is the file itself. Returns the id
   * `createDatasource` takes as `sqliteFileId`; the server builds the DSN.
   */
  uploadSqliteFile: (wsId: string, file: Blob, filename?: string) =>
    req<{ file: SqliteFileUpload }>(`/workspaces/${wsId}/datasources/sqlite-files`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(filename ? { "x-file-name": encodeURIComponent(filename) } : {}),
      },
      body: file,
    }).then((r) => r.file),
  updateDatasource: (wsId: string, dsId: string, body: Record<string, unknown>) =>
    req<{ datasource: FADatasource }>(`/workspaces/${wsId}/datasources/${dsId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.datasource),
  deleteDatasource: (wsId: string, dsId: string) =>
    req<void>(`/workspaces/${wsId}/datasources/${dsId}`, { method: "DELETE" }),
  testDatasource: (wsId: string, dsId: string) =>
    req<{ ok: boolean; detail?: string }>(`/workspaces/${wsId}/datasources/${dsId}/test`, {
      method: "POST",
    }),
  refreshSchema: (wsId: string, dsId: string) =>
    req<{ refreshed: boolean; tables: number; columns: number }>(
      `/workspaces/${wsId}/datasources/${dsId}/schema/refresh`,
      { method: "POST" },
    ),
  getSchema: (wsId: string, dsId: string) =>
    req<{ entities: FASchemaEntity[] }>(`/workspaces/${wsId}/datasources/${dsId}/schema`).then(
      (r) => r.entities,
    ),
  /**
   * Mock-data readiness + paged mock rows. Both serve the derived fixture
   * projection only — no endpoint here returns production rows, and there is
   * deliberately no prod-preview endpoint at all.
   *
   * Rebuilds are CLI/ops-triggered server-side; there is no browser rebuild
   * action by design (a rebuild drops and regenerates rows).
   */
  getDatasourceMock: (wsId: string, dsId: string) =>
    req<{ mock: FADatasourceMock }>(`/workspaces/${wsId}/datasources/${dsId}/mock`).then((r) => r.mock),
  /**
   * Rebuild the mock dataset, deliberately, from the datasource page.
   *
   * ⚠ The outcome is a 200 either way. The server answers `{started:true,version}`
   * or `{started:false, why}` — `why` being a state of this datasource
   * (`not_postgres`, `no_schema`, `unsupported_shape`, `already_building`), not a
   * failure of the request. A caller that treats a decline as an error reports
   * "rebuild failed" for a datasource that simply cannot have one.
   */
  rebuildDatasourceMock: (wsId: string, dsId: string) =>
    req<{ mock: FAMockBuildOutcome }>(`/workspaces/${wsId}/datasources/${dsId}/mock/rebuild`, {
      method: "POST",
    }).then((r) => r.mock),
  getDatasourceMockRows: (wsId: string, dsId: string, table: string, page: number, pageSize: number) =>
    req<FAMockRowsPage>(
      `/workspaces/${wsId}/datasources/${dsId}/mock/rows?table=${encodeURIComponent(table)}&page=${page}&pageSize=${pageSize}`,
    ),
  /**
   * Draft step SQL from the introspected SCHEMA alone (never rows). The draft
   * is shown inline for human approval and frozen into `step.sql` on save —
   * generation-per-run is prohibited, generation-per-build is the whole UX.
   */
  proposeDatasourceSql: (wsId: string, dsId: string, need: string) =>
    req<FADatasourceSqlProposal>(`/workspaces/${wsId}/datasources/${dsId}/queries/propose`, {
      method: "POST",
      body: JSON.stringify({ need }),
    }),

  // Resources — B-07/B-13 union of datasources+tools with ResourceCategory/status/owner/health/dependents
  // P5 uses this to hydrate resource names per flow (manifest_refs_json join). Honest-empty when unmatched.
  listResources: (wsId: string, type: string = "all") =>
    req<{ resources: Array<{ id: string; name: string; resourceCategory?: string; type?: string; resourceType?: string }> }>(
      `/workspaces/${wsId}/resources?type=${encodeURIComponent(type)}`,
    ).then((r) => r.resources),

  // ── gate 3: step approvals ────────────────────────────────────────────────
  //
  // An approval is named by ITS OWN id, never by a Kestra taskrun (R5) — the
  // task to resume is stored server-side and resolved there.
  listPendingApprovals: (wsId: string) =>
    req<{ approvals: FAStepApproval[] }>(`/workspaces/${wsId}/step-approvals`).then(
      (r) => r.approvals,
    ),
  listExecutionApprovals: (wsId: string, executionId: string) =>
    req<{ approvals: FAStepApproval[] }>(
      `/workspaces/${wsId}/step-approvals/execution/${executionId}`,
    ).then((r) => r.approvals),
  /**
   * ⚠ Rejecting a GATE kills the run — downstream steps never execute. That is
   * the point: resuming would send. There is no undo; a second decision is a 409.
   *
   * On a `question` row it means something different and the server says so:
   * approving posts `answers` to the agent and the run continues; rejecting
   * cancels the agent run and fails that one step. `answers` is REFUSED on a
   * gate (400) rather than ignored.
   */
  decideApproval: (
    wsId: string,
    approvalId: string,
    body: {
      decision: "approved" | "rejected";
      note?: string;
      answers?: Record<string, string | string[]>;
    },
  ) =>
    req<{ approval: FAStepApproval }>(`/workspaces/${wsId}/step-approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.approval),

  // ── DB operations (Phase 4) ───────────────────────────────────────────────
  //
  // A `query` step references an operation by `<datasource>.<operation>`, so
  // these are addressed by NAME like named queries — a name IS the second half
  // of the ref. Phase 4 ships the create/list/check surface; PATCH and DELETE
  // exist server-side for later editing surfaces, and a client that does not
  // call them cannot delete an operation flows are approved against.
  listOperations: (wsId: string, dsId: string) =>
    req<{ operations: FADatasourceOperation[] }>(
      `/workspaces/${wsId}/datasources/${dsId}/operations`,
    ).then((r) => r.operations),
  createOperation: (wsId: string, dsId: string, body: FADbOperationInput) =>
    req<{ operation: FADatasourceOperation }>(
      `/workspaces/${wsId}/datasources/${dsId}/operations`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.operation),
  /**
   * Delete a saved reader.
   *
   * ⚠ **A 409 is the normal, expected answer** when a flow still names it, and
   * its `message` lists those flows by name — so the caller renders the error
   * rather than reporting "could not delete". A missing reader does not fail an
   * edit, a compile or a deploy; it fails the next RUN, on a flow that may be
   * armed, for somebody who did not delete it.
   *
   * ⚠ `force` is offered only AFTER that refusal has been shown with its list.
   * A deliberate break is a decision somebody may need to make; it must not be
   * the default, and it must not be reachable without seeing the consequence.
   */
  deleteOperation: (wsId: string, dsId: string, name: string, opts: { force?: boolean } = {}) =>
    req<void>(
      `/workspaces/${wsId}/datasources/${dsId}/operations/${encodeURIComponent(name)}` +
        (opts.force ? "?force=true" : ""),
      { method: "DELETE" },
    ),
  /** Compile without saving — the builder's live preview. Always resolves 200:
   *  `ok: false` carries the structured findings rather than an HTTP error, so
   *  a refused spec renders as a verdict beside the spec that produced it. */
  checkOperation: (wsId: string, dsId: string, body: FADbOperationSpec) =>
    req<FADbOperationCheck>(`/workspaces/${wsId}/datasources/${dsId}/operations/check`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * Ask for a spec from a sentence. ⚠ **Creates nothing** — the result is
   * reviewed and then submitted through `createOperation`, which compiles it
   * again (FR-013: an edited spec is fresh input, and the dialog is editable by
   * design).
   *
   * ⚠ `need` is the ONLY field, and that is the isolation this path's safety
   * rests on: there is no place here for a DSN, a schema, a table list, a goal,
   * a flow id or a row of data. Everything the proposer sees is resolved
   * server-side from `dsId` (FR-005).
   *
   * ⚠ **Both channels resolve.** `status: "insufficient_schema"` is a 200 and a
   * success — do not treat it as an error and do not re-ask (FR-008). A 409
   * means the schema was never introspected and the fix is a re-scan; a 422
   * means three compiled attempts were all refused, and its `findings` are the
   * only actionable part.
   */
  proposeOperation: (wsId: string, dsId: string, need: string) =>
    req<FAOperationProposalResult>(
      `/workspaces/${wsId}/datasources/${dsId}/operations/propose`,
      { method: "POST", body: JSON.stringify({ need }) },
    ),

  // `scripts` is being deleted in Phase 4. Already assembled and redacted by
  // `services/flow-visibility.service.ts` — see FlowExecutionDetail in types.ts.
  /**
   * One page of runs for History (2026-10-11): each with its steps in light form, filtered over every run. `next` is
   * the cursor of the following page (null on the last); `labels` (first page only) are the workflow filter's options.
   */
  listFlowExecutionsPage: (wsId: string, p: { limit?: number; before?: string; name?: string; from?: string; q?: string }) => {
    const qs = new URLSearchParams({ view: "page", limit: String(p.limit ?? 50) });
    for (const k of ["before", "name", "from", "q"] as const) if (p[k]) qs.set(k, p[k]!);
    return req<{ executions: FAFlowExecutionSummary[]; next: string | null; labels?: string[] }>(`/workspaces/${wsId}/flow-executions?${qs}`);
  },
  /** The dashboard's figures and its last few runs, computed by the server (2026-10-23: a period, live or test, mine or everyone). */
  flowExecutionsSummary: (wsId: string, p: { dayStart: string; recent: number; range: FAHealthRange; env: FARunEnv; scope: FARunScope }) =>
    req<FAFlowRunsSummary>(
      `/workspaces/${wsId}/flow-executions?${new URLSearchParams({ view: "summary", dayStart: p.dayStart, recent: String(p.recent), range: p.range, env: p.env, scope: p.scope })}`,
    ),
  listFlowExecutions: (wsId: string, limit = 50) =>
    req<{ executions: FAFlowExecutionSummary[] }>(
      `/workspaces/${wsId}/flow-executions?limit=${limit}`,
    ).then((r) => r.executions),
  getFlowExecution: (wsId: string, execId: string) =>
    req<FAFlowExecutionDetail>(`/workspaces/${wsId}/flow-executions/${execId}`),
  /**
   * Mint a single-use ticket for the step-progress socket (phase-2.md 2.8).
   *
   * This request goes through the same-origin proxy, so it carries the parent API
   * key; the WebSocket that follows cannot. That is the whole reason the ticket
   * exists — see `services/flow-progress.service.ts` on the server.
   */
  /**
   * REAL emails this run attempted — `email_sends`, not `api_call_log`.
   * email-send-tool T037
   *
   * ⚠ A DIFFERENT source from `demoCallsForRun`, and the distinction is the point:
   * that one reads the simulated tool layer through ops-api, this one reads
   * Foundry's own record of messages that actually left the building. A run can
   * have rows in one, the other, both, or neither.
   */
  emailsForRun: (wsId: string, execId: string) =>
    req<{ emails: FAEmailSend[] }>(
      `/workspaces/${wsId}/flow-executions/${execId}/emails`,
    ).then((r) => r.emails),
  watchFlowExecution: (wsId: string, execId: string) =>
    req<{ ticket: string; expiresAt: string }>(
      `/workspaces/${wsId}/flow-executions/${execId}/watch`,
      { method: "POST" },
    ),

  // ── Flows, revisions and approvals (Kestra migration, Phase 3) ─────────────
  listFlows: (wsId: string) =>
    req<{ flows: FAFlow[] }>(`/workspaces/${wsId}/flows`).then((r) => r.flows),
  /** Only the automations that fire on a timer, and only what the dashboard prints (2026-10-11). */
  listScheduledFlows: (wsId: string, limit = 4) =>
    req<{ flows: { id: string; name: string; schedule: string }[]; total: number }>(
      `/workspaces/${wsId}/flows?view=scheduled&limit=${limit}`,
    ),
  /**
   * P6 — last run stub. Returns honest-empty (`{ execution: null }`) when the
   * flow never ran — the tab then counts 0 rather than hiding (S-28 Layout).
   * The bulk join via `listFlowExecutions` is the primary path; this endpoint
   * exists for per-flow honesty when the summary carries no last run.
   */
  getFlowLastRun: (wsId: string, flowId: string) =>
    req<{ execution: FAFlowExecutionSummary | null }>(`/workspaces/${wsId}/flows/${flowId}/last-run`).then((r) => r.execution),
  getFlow: (wsId: string, flowId: string) =>
    req<{
      flow: FAFlow;
      revisions: FAFlowRevision[];
      /**
       * The DRAFT revision's model, served whether or not that revision appears
       * in `revisions` above.
       *
       * ⚠ **`revisions` is the version LIST and cannot be used for this.** It
       * honours `hidden_at`, and a chat turn writes its revision already
       * hidden — so on a flow built in the chat builder and not yet saved,
       * `revisions` is `[]` while `flow.draftRevision` is a real number.
       * Deriving the model from that array is what made the step inspector
       * answer *"this draft could not be read as an editable model"* under
       * every node of every chat-built flow.
       */
      draftModel: unknown;
      /**
       * The goal the builder has understood, as it stands now — an unfinished build's (it changes as the person replies, restated
       * and read as meant), else the one the draft was built from. `null` for a flow with none (built on the canvas). Optional: a
       * server not yet rebuilt serves no such key.
       */
      understoodGoal?: { text: string; building: boolean } | null;
      /**
       * The draft's per-input controls, derived server-side beside `draftModel`
       * from that same model (`flowInputFormat`). Optional — a deployment that
       * has not been rebuilt yet serves no such key, and the drawer then falls
       * back to each input's declared type.
       */
      inputFormats?: Record<string, FlowInputFormat>;
      /** rbac-observability: may this person move the automation to another owner (an Admin). */
      canChangeOwner?: boolean;
      /** May this person edit it (theirs, an Admin, or a shared workflow members may edit — sharing-boundaries phase 2). */
      canChange?: boolean;
      /** May this person MANAGE it — delete, private/view-only, whose account, switch on/off, ask for approval. */
      canManage?: boolean;
      /** Plugins phase 9: may this person switch the draft on themselves, and if not, why. */
      selfEnable?: FASelfEnable | null;
      approvals: FAApprovalState["approval"][];
      approvalState: FAApprovalState;
      // ⚠ `status` is `flow_executions.status` — a failed run never updates it
      // (its own `complete` task never runs), so it reads "running" forever.
      // `engineStatus` is Kestra's live state, joined server-side the same way
      // the run list and run detail routes already do; read THAT for whether
      // a run is still live. See `lib/flow-stream.ts`'s `isLive`.
      executions: Array<{
        id: string;
        status: string;
        engineStatus: string | null;
        flowRevision: number | null;
        startedAt: string | null;
      }>;
      /**
       * What this automation's designer was pointed at — Phase 3.3, served
       * since then and, until D-114, read by nothing at all.
       *
       * ⚠ **`null` is a real value and is not an empty list.** Null means
       * nothing was preferred (or the flow predates the column); an empty list
       * would mean somebody pointed at nothing, which nothing can produce.
       *
       * ⚠ `used` is `boolean | null` and the third value matters: `null` is
       * *nobody asked*, not *no*. Rendering it with a falsy check accuses a
       * flow of ignoring a choice that was never compared against anything.
       */
      designedAgainst: Array<{
        kind: "datasource" | "tool";
        label: string;
        present: boolean;
        used: boolean | null;
      }> | null;
      /** Refs the draft uses that no preferred entry covers. Empty ⇒ render nothing. */
      usedInstead: string[];
    }>(`/workspaces/${wsId}/flows/${flowId}`),
  // ── Step positions (Phase 2, plan decision ② / D-150) ──────────────────────
  // The DAG arrangement mirror, OUTSIDE the revision: a drag must never create
  // a revision and invalidate an approval. The server is deliberately dumb —
  // GET returns the rows, PUT replaces the flow's whole set; reconciliation
  // (drop on delete, re-key on rename) is the CLIENT's job before PUT.
  getFlowPositions: (wsId: string, flowId: string) =>
    req<{ positions: Array<{ stepId: string; x: number; y: number }> }>(
      `/workspaces/${wsId}/flows/${flowId}/positions`,
    ).then((r) => r.positions),
  putFlowPositions: (wsId: string, flowId: string, positions: Array<{ stepId: string; x: number; y: number }>) =>
    req<{ saved: number }>(`/workspaces/${wsId}/flows/${flowId}/positions`, {
      method: "PUT",
      body: JSON.stringify({ positions }),
    }),
  // B-11/B-12 per-revision reads for builder canvas S-07
  listPhases: (wsId: string, flowId: string, revision: string | number) =>
    req<{ phases: Array<{ id: string; label: string; ordinal: number; flowRevisionId: string }> }>(`/workspaces/${wsId}/flows/${flowId}/phases?revision=${encodeURIComponent(String(revision))}`).then((r) => r.phases),
  listFlags: (wsId: string, flowId: string, revision: string | number) =>
    req<{ flags: Array<{ id: string; stepNumber: number | null; kind: string; title: string; consequence: string; blocking: boolean; status: string }>; canTest: boolean; canPublish: boolean }>(`/workspaces/${wsId}/flows/${flowId}/flags?revision=${encodeURIComponent(String(revision))}`),
  /** A manual run against the DRAFT namespace — how gate 1 is satisfied. */
  /**
   * Start a draft run. The response carries the revision that was started and
   * nothing else — no Kestra execution id and no namespace (I-22, R5).
   *
   * The run becomes addressable a second or two later, when the flow's own
   * `begin` task writes `flow_executions`; find it with `listFlowExecutions`.
   */
  testRunFlow: (wsId: string, flowId: string, inputs?: Record<string, string>, opts?: { useProductionData?: boolean }) =>
    req<{ revision: number }>(
      `/workspaces/${wsId}/flows/${flowId}/test-run`,
      { method: "POST", body: JSON.stringify({ inputs: inputs ?? {}, ...(opts?.useProductionData ? { useProductionData: true } : {}) }) },
    ),
  /**
   * Confirm the values this automation's declared inputs carry — Phase 4.
   *
   * ⚠ **Values only.** There is deliberately no goal, no instruction and no
   * redraft: re-asking a refusal is how a correct `insufficient_contract`
   * becomes an invented `period="2023-10"` on attempt two (§6.7, D-38, D-112),
   * and the server's schema has nowhere to put one either. It lands as a NEW
   * REVISION, because `defaults` is part of what a scheduled run does.
   */
  confirmFlowInputs: (
    wsId: string,
    flowId: string,
    values: Record<string, string>,
    computed?: Record<string, ComputedInputFn>,
  ) =>
    req<{ flow: FAFlow; revision: FAFlowRevision }>(
      `/workspaces/${wsId}/flows/${flowId}/inputs`,
      // `computed` is absent (not `{}`) when nothing derives — `stringify`
      // drops the `undefined`, so the body keeps the shape it always had.
      { method: "POST", body: JSON.stringify({ values, computed }) },
    ),
  getFlowDiff: (wsId: string, flowId: string, to?: number, from?: number) => {
    const qs = new URLSearchParams();
    if (to !== undefined) qs.set("to", String(to));
    if (from !== undefined) qs.set("from", String(from));
    return req<FAFlowDiff>(
      `/workspaces/${wsId}/flows/${flowId}/approvals/diff${qs.toString() ? `?${qs}` : ""}`,
    );
  },
  /**
   * Approve a revision → promote it live → deploy its Schedule trigger.
   *
   * ⚠ **The approver is NOT sent.** Since Stage 9.1 the server takes it from the
   * signed identity the proxy forwards, and `approveSchema` is `.strict()` — a
   * body carrying `approverUserId` is a 400 naming the field. Do not add it back
   * "for clarity": a field the server refuses is the clearest possible signal
   * that the browser does not get to choose who approved.
   */
  approveFlowRevision: (
    wsId: string,
    flowId: string,
    body: { revision: number; note?: string },
  ) =>
    req<{
      flow: FAFlow;
      approval: NonNullable<FAApprovalState["approval"]>;
      /**
       * ⚠ **WHAT PUBLISHING DID ABOUT FIRING.** Publish means "this workflow is
       * ready to run in whatever capacity it was built in", and the server
       * arms that capacity — so the response says which mechanisms are now on,
       * which are not, and the server's own reason for each one that is not.
       *
       * Optional because a server that predates the change does not send it,
       * and a missing field must read as "not reported" rather than as
       * "nothing was armed" — those need different sentences.
       */
      firing?: FiringOutcome;
    }>(`/workspaces/${wsId}/flows/${flowId}/approvals`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * Usage, cost and run health for one workspace (P-OBS). The server answers with what the caller may see
   * (rbac-observability): their own (`scope: "mine"`), or everyone's for an Admin — who may ask for `mine` too.
   */
  getObservability: (wsId: string, days: number, scope?: "mine" | "workspace") =>
    req<import("./types").Observability>(`/workspaces/${wsId}/observability?days=${days}${scope ? `&scope=${scope}` : ""}`),
  /** The same across the whole deployment — platform administrators. */
  getDeploymentObservability: (days: number) => req<import("./types").Observability>(`/observability?days=${days}`),
  /** The cost report (2026-10-26): tiles, the daily series and the three lenses, limited to what the caller may see. */
  getReportSummary: (q: import("./reports").ReportQuery) =>
    req<import("./reports").ReportSummary>(`/reports/summary?${reportQs(q)}`),
  /** One page of runs. The download carries the full set, not this page. */
  getReportRuns: (q: import("./reports").ReportQuery, page: { sort: import("./reports").RunSort; dir: "asc" | "desc"; offset: number; limit: number }) =>
    req<{ total: number; rows: import("./reports").ReportRun[] }>(`/reports/runs?${reportQs(q, page)}`),
  /** The whole report as one workbook, for saving. */
  downloadReport: async (q: import("./reports").ReportQuery): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`${PROXY}/reports/export?${reportQs(q)}`, { cache: "no-store" });
    if (!res.ok) throw await reportError(res);
    return { blob: await res.blob(), filename: filenameFrom(res.headers.get("content-disposition"), "cost-report.xlsx") };
  },
  /** Email the same workbook to people who may hold no access here. Recipients must be on an allowed domain. */
  emailReport: (q: import("./reports").ReportQuery, body: { recipients: string[]; note?: string }) =>
    req<{ status: "sent"; filename: string; recipients: string[] }>(`/reports/email`, {
      method: "POST",
      body: JSON.stringify({ ...reportBody(q), ...body }),
    }),
  /** Run a Forge workflow's approved revision now, live (pi-runtime P5). */
  runFlowLive: (wsId: string, flowId: string, inputs?: Record<string, string | number | boolean>) =>
    req<{ flowExecutionId: string; revision: number }>(`/workspaces/${wsId}/flows/${flowId}/run`, {
      method: "POST",
      body: JSON.stringify(inputs ? { inputs } : {}),
    }),
  /** Its owner switches it on, with no reviewer — only when it uses nothing but their own things (phase 9). */
  switchOnFlow: (wsId: string, flowId: string, revision?: number) =>
    req<{ flow: FAFlow; approval: NonNullable<FAApprovalState["approval"]> }>(`/workspaces/${wsId}/flows/${flowId}/switch-on`, {
      method: "POST",
      body: JSON.stringify(revision ? { revision } : {}),
    }),
  /** Its owner (or an Admin) switches it off (phase 9). */
  switchOffFlow: (wsId: string, flowId: string) =>
    req<{ flow: FAFlow; revoked: number }>(`/workspaces/${wsId}/flows/${flowId}/switch-off`, { method: "POST", body: JSON.stringify({}) }),
  /** The signed-in person's own notices (sharing-boundaries), newest first. */
  listNotifications: (wsId: string) => req<{ notifications: FANotification[] }>(`/workspaces/${wsId}/notifications`),
  markNotificationsRead: (wsId: string, ids?: string[]) =>
    req<{ ok: true }>(`/workspaces/${wsId}/notifications/read`, { method: "POST", body: JSON.stringify(ids ? { ids } : {}) }),
  /** While shared, may members edit it, or is it view-only (sharing-boundaries phase 2). Its owner's or an Admin's. */
  setFlowEditing: (wsId: string, flowId: string, othersMayEdit: boolean) =>
    req<{ flow: FAFlow }>(`/workspaces/${wsId}/flows/${flowId}/visibility`, { method: "PUT", body: JSON.stringify({ othersMayEdit }) }),
  /** Ask a reviewer to approve (sharing-boundaries): puts a private workflow in front of reviewers. */
  requestFlowReview: (wsId: string, flowId: string, revision?: number) =>
    req<{ flow: FAFlow }>(`/workspaces/${wsId}/flows/${flowId}/review-request`, {
      method: "POST",
      body: JSON.stringify(revision ? { revision } : {}),
    }),
  withdrawFlowReview: (wsId: string, flowId: string) =>
    req<{ flow: FAFlow }>(`/workspaces/${wsId}/flows/${flowId}/review-request`, { method: "DELETE" }),
  revokeFlowApproval: (wsId: string, flowId: string, reason: string) =>
    req<{ flow: FAFlow; revoked: number }>(`/workspaces/${wsId}/flows/${flowId}/approvals/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  /**
   * Re-arm a turned-off flow without a new review — one click on the list's switch.
   *
   * ⚠ **200 OR 409, AND THE 409 IS THE OTHER SUCCESS.** The server re-arms
   * only an UNCHANGED revision (draft still equals the armed one, ref
   * fingerprints identical); a 409 states exactly the cases where a person
   * needs to look, and the caller routes those to `/publish` rather than
   * reporting a failure. Any other status is the failure.
   */
  rearmFlowApproval: (wsId: string, flowId: string) =>
    req<{
      flow: FAFlow;
      approval: NonNullable<FAApprovalState["approval"]>;
      firing?: FiringOutcome;
    }>(`/workspaces/${wsId}/flows/${flowId}/approvals/rearm`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /**
   * Remove one revision from the version list.
   *
   * ⚠ **The server HIDES it; nothing is destroyed.** `flow_revisions` is
   * insert-only because an approval points at a revision — the row, its
   * approval and its model all survive, and a replay or a diff can still read
   * them by id. The draft and the live revision are refused, by the service,
   * with a sentence saying which and why.
   */
  hideFlowRevision: (wsId: string, flowId: string, revision: number) =>
    req<{ revision: number; hidden: boolean; alreadyHidden: boolean }>(
      `/workspaces/${wsId}/flows/${flowId}/revisions/${revision}`,
      { method: "DELETE" },
    ),

  /**
   * Everything the editable canvas may offer — Stage 5.
   *
   * One read rather than four, and the ref list comes from the same call
   * `flowValidator.checkFlowRefs` is handed, so the palette cannot offer a ref
   * the server will reject.
   */
  /**
   * The workspace manifest, and the only reason the client reads it: the
   * prompt-boundary warnings (guardrail port V4).
   *
   * ⚠ The route BUILDS as well as returns — `buildAndPersist` is idempotent and
   * writes a new version only when the render differs, and `warnings` is
   * deliberately outside `hashBody`, so reading this page cannot move a single
   * ref fingerprint or suspend an armed flow.
   *
   * ⚠ `manifestXml`/`summaryXml` come back too and are ~17 KB. Nothing renders
   * them and nothing should: the manifest is the model's view, and putting it on
   * a screen invites editing text whose hash arms and disarms flows.
   */
  getManifest: (wsId: string) =>
    req<{
      version: number;
      hash: string;
      changed: boolean;
      warnings?: FAManifestWarnings;
    }>(`/workspaces/${wsId}/manifest`),

  getFlowCatalogue: (wsId: string) => req<FAFlowCatalogue>(`/workspaces/${wsId}/catalogue`),
  /**
   * Run ONE component with values a person supplied, and persist nothing — T9.
   *
   * ⚠ **It really calls the endpoint.** A `tool` try dials the registered URL
   * with the stored credential, and whatever effect that has, happens. The
   * screen must say so before the button; there is no dry-run mode, because a
   * dial that pretends is the probe that returns green for a tool which 401s in
   * a run.
   *
   * ⚠ It runs the VALUES, not the step's expression. Foundry has no Pebble
   * evaluator and must not grow one (I-118), so a green try is evidence the
   * component works — never evidence the flow's expression feeding it is right.
   */
  /** The flow's incomplete working copy, re-judged now (compiled-builder D-319); `null` when there is none. */
  // The manual builder (compiled-builder phase 7, D-329): open a flow's engine state, take ONE listed action, save.
  getFlowChoices: (wsId: string, flowId: string, revision: number) =>
    req<import("./api").ChoicesResult>(`/workspaces/${wsId}/flows/${flowId}/choices?revision=${revision}`),
  createCanvasFlow: (wsId: string, name: string) => req<{ flowId: string }>(`/workspaces/${wsId}/flows/canvas`, { method: "POST", body: JSON.stringify({ name }) }),
  openCanvas: (wsId: string, flowId: string) => req<import("./engine-canvas").CanvasOpen>(`/workspaces/${wsId}/flows/${flowId}/canvas`),
  canvasAct: (wsId: string, flowId: string, body: { state: unknown; sig: string; actionId: string; value?: string }) =>
    req<import("./engine-canvas").CanvasActResult>(`/workspaces/${wsId}/flows/${flowId}/canvas/act`, { method: "POST", body: JSON.stringify(body) }),
  canvasSave: (wsId: string, flowId: string, body: { state: unknown; sig: string }) =>
    req<import("./engine-canvas").CanvasSaveResult>(`/workspaces/${wsId}/flows/${flowId}/canvas/save`, { method: "POST", body: JSON.stringify(body) }),
  getIncompleteFlow: (wsId: string, flowId: string) =>
    req<{ incomplete: FAIncompleteFlow | null }>(`/workspaces/${wsId}/flows/${flowId}/incomplete`).then((r) => r.incomplete),
  getFlowIntegration: (wsId: string, flowId: string) =>
    req<FAFlowIntegration>(`/workspaces/${wsId}/flows/${flowId}/integration`),

  tryStep: (
    wsId: string,
    body: { stepKind: string; ref: string; params: Record<string, unknown> },
  ) => req<FAStepTryResult>(`/workspaces/${wsId}/steps/try`, { method: "POST", body: JSON.stringify(body) }),

  /**
   * The datasource's development-sandbox state (Stage 4).
   *
   * READ only, and there is deliberately no `provisionSandbox` here: provisioning
   * generates rows with a model, drops a database and creates a role, which is
   * the shape of the destructive HTTP reseed Stage 1 deleted. It is a CLI
   * command. What a browser needs is whether a test run will read real data.
   */
  getDatasourceSandbox: (wsId: string, dsId: string) =>
    req<{ sandbox: FASandboxStatus }>(
      `/workspaces/${wsId}/datasources/${dsId}/sandbox`,
    ).then((r) => r.sandbox),

  /** The steps of one revision, with each `code` step's stored contract. */
  getFlowRevisionSteps: (wsId: string, flowId: string, revision: number) =>
    req<{ steps: FAFlowStep[] }>(
      `/workspaces/${wsId}/flows/${flowId}/revisions/${revision}/steps`,
    ).then((r) => r.steps),

  /**
   * Save an edited model → a NEW revision on the draft namespace.
   *
   * Never an edit in place, and never the live namespace: an armed flow keeps
   * firing its approved revision and becomes `draft_pending` (§6.5).
   */
  /**
   * "Save draft" - put the conversation's current version in the version list.
   *
   * WARNING **It writes NO model.** A chat turn already wrote the revision; what
   * this changes is only whether it is LISTED. Sending a model here would make
   * two writers of the same thing, and the browser the authority on what the
   * flow is.
   */
  saveFlowDraft: (wsId: string, flowId: string) =>
    req<{ revision: number; alreadyVisible: boolean }>(
      `/workspaces/${wsId}/flows/${flowId}/save-draft`,
      { method: "POST" },
    ),

  saveFlowRevision: (wsId: string, flowId: string, model: unknown, createdBy?: string) =>
    req<{ flow: FAFlow; revision: FAFlowRevision }>(
      `/workspaces/${wsId}/flows/${flowId}/revisions`,
      { method: "POST", body: JSON.stringify({ model, ...(createdBy ? { createdBy } : {}) }) },
    ),

  /**
   * Rename, or reword the description. **Metadata only** — deliberately not a
   * revision, because a revision invalidates an approval and a typo fix must not
   * unarm a live schedule.
   */
  updateFlow: (wsId: string, flowId: string, patch: { name?: string; description?: string | null }) =>
    req<{ flow: FAFlow }>(`/workspaces/${wsId}/flows/${flowId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.flow),
  /**
   * Chat + scope metadata (Phase 5) — the same PATCH route as `updateFlow`.
   * **Metadata only**, for the same reason a rename is not a revision: editing
   * the drafting model, the extra instructions, the suggestion chips or the
   * design scope must not invalidate an approval or suspend a schedule.
   * `null` clears back to "nobody chose"; shaping is the server's
   * `updateFlowSchema`, so anything it rejects answers 400 here.
   */
  updateFlowMeta: (wsId: string, flowId: string, patch: { chatConfig?: unknown; designSelection?: unknown }) =>
    req<{ flow: FAFlow }>(`/workspaces/${wsId}/flows/${flowId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.flow),

  /**
   * rbac-observability — an Admin moves an automation to another member (`null`: to nobody). The server refuses a
   * person who is not a member, or an Observer, with a sentence.
   */
  setFlowOwner: (wsId: string, flowId: string, subject: string | null) =>
    req<{ flow: FAFlow | null }>(`/workspaces/${wsId}/flows/${flowId}/owner`, {
      method: "PUT",
      body: JSON.stringify({ subject }),
    }).then((r) => r.flow),

  /** Plugins 8.6 — per connected service a workflow uses, the connection it runs as, and what this person may choose. */
  getFlowRunAs: (wsId: string, flowId: string) => req<FlowRunAs>(`/workspaces/${wsId}/flows/${flowId}/run-as`),
  /** What the workflow still needs before it can run, for this person, with who fixes each (sharing-boundaries phase 4). */
  getFlowReadiness: (wsId: string, flowId: string, revision: "approved" | "draft") =>
    req<FlowReadiness>(`/workspaces/${wsId}/flows/${flowId}/readiness?revision=${revision}`),
  /** Which of my own accounts my runs use for a service, when I have several. */
  setMyAccount: (wsId: string, flowId: string, piece: string, connectionId: string) =>
    req<FlowReadiness>(`/workspaces/${wsId}/flows/${flowId}/my-account`, { method: "PUT", body: JSON.stringify({ piece, connectionId }) }),
  /** "Turn on for me" (sharing-boundaries phase 3): this person's own schedule for a shared each-person workflow. */
  getFlowActivation: (wsId: string, flowId: string) => req<FlowActivation>(`/workspaces/${wsId}/flows/${flowId}/activation`),
  setFlowActivation: (wsId: string, flowId: string, body: { on: boolean; cron?: string | null; timezone?: string | null }) =>
    req<FlowActivation>(`/workspaces/${wsId}/flows/${flowId}/activation`, { method: "PUT", body: JSON.stringify(body) }),
  /** Projects (sharing-boundaries phase 5): a smaller circle inside the workspace, with shared instructions. */
  listProjects: (wsId: string) => req<{ projects: ProjectSummary[] }>(`/workspaces/${wsId}/projects`),
  getProject: (wsId: string, projectId: string) => req<{ project: ProjectDetail }>(`/workspaces/${wsId}/projects/${projectId}`),
  createProject: (wsId: string, body: { name: string; description?: string | null; instructions?: string }) =>
    req<{ project: ProjectSummary }>(`/workspaces/${wsId}/projects`, { method: "POST", body: JSON.stringify(body) }),
  updateProject: (wsId: string, projectId: string, body: { name?: string; description?: string | null; instructions?: string }) =>
    req<{ project: ProjectSummary }>(`/workspaces/${wsId}/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (wsId: string, projectId: string) => req<{ returned: number }>(`/workspaces/${wsId}/projects/${projectId}`, { method: "DELETE" }),
  addProjectMember: (wsId: string, projectId: string, subject: string) =>
    req<{ project: ProjectDetail }>(`/workspaces/${wsId}/projects/${projectId}/members`, { method: "POST", body: JSON.stringify({ subject }) }),
  removeProjectMember: (wsId: string, projectId: string, subject: string) =>
    req<{ handedOver: number }>(`/workspaces/${wsId}/projects/${projectId}/members/${encodeURIComponent(subject)}`, { method: "DELETE" }),
  setProjectOwner: (wsId: string, projectId: string, subject: string) =>
    req<{ project: ProjectDetail }>(`/workspaces/${wsId}/projects/${projectId}/owner`, { method: "PUT", body: JSON.stringify({ subject }) }),
  /** Where an item lives: what a move would change, said first; then the move. `to`: mine | workspace | project:<id>. */
  movePreview: (wsId: string, item: MovableItem, to: string) =>
    req<MovePreview>(`${movePath(wsId, item)}/move-preview?to=${encodeURIComponent(to)}`),
  moveItem: (wsId: string, item: MovableItem, to: string) =>
    req<{ turnedOff?: boolean }>(`${movePath(wsId, item)}/move`, { method: "POST", body: JSON.stringify({ to }) }),
  /** Change what one service runs as: a new draft version, approved again before a live run uses it. */
  setFlowRunAs: (wsId: string, flowId: string, piece: string, connectionId: string) =>
    req<FlowRunAs & { revision: number }>(`/workspaces/${wsId}/flows/${flowId}/run-as`, { method: "PUT", body: JSON.stringify({ piece, connectionId }) }),

  /** Triage level 1 — regenerate ONE fragment into a new revision. */
  regenerateFlowStep: (wsId: string, flowId: string, stepId: string) =>
    req<{ status: string; flow?: FAFlow; revision?: FAFlowRevision; attempts?: number }>(
      `/workspaces/${wsId}/flows/${flowId}/steps/${stepId}/regenerate`,
      { method: "POST" },
    ),

  deleteFlow: (wsId: string, flowId: string) =>
    req<void>(`/workspaces/${wsId}/flows/${flowId}`, { method: "DELETE" }),

  /** Copy a flow's draft into a new unarmed draft (`name (copy)`). */
  duplicateFlow: (wsId: string, flowId: string) =>
    req<{ flow: FlowSummary; revision: number }>(
      `/workspaces/${wsId}/flows/${flowId}/duplicate`,
      { method: "POST" },
    ),

  // ── Phase 6: replay, portability, templates, promotion ─────────────────────

  /**
   * Import a bundle. Note the response is a UNION and `insufficient_contract` is
   * a **200** — a travelled contract this workspace cannot satisfy names the
   * field the recipe assumes, which is the most useful thing an import can say.
   */
  importFlow: (
    wsId: string,
    body: {
      bundle: unknown;
      refMap?: Record<string, string>;
      modelId?: string;
      name?: string;
      description?: string;
    },
  ) =>
    req<FAImportResult>(`/workspaces/${wsId}/flows/import`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listFlowTemplates: (wsId: string) =>
    req<{ templates: FAFlowTemplate[] }>(`/workspaces/${wsId}/flow-templates`).then(
      (r) => r.templates,
    ),
  // ── Triggers. Nested under a FLOW — the script-nested set was deleted with
  // `scripts` in Phase 4 (4.11), along with the {triggerId → scriptId} index the
  // Triggers page kept in order to fan out over both backends.
  /**
   * Claims this flow's shape implies — GAPS §2.3b. A read; accepting one is an
   * ordinary `saveFlowRevision` by the person who read it.
   */
  expectationSuggestions: (wsId: string, flowId: string) =>
    req<{
      suggestions: Array<{ expectation: Record<string, unknown>; because: string }>;
      caveat: string;
    }>(`/workspaces/${wsId}/flows/${flowId}/expectation-suggestions`),
  /**
   * GAPS §6.1b — the four things that fail with nothing raising an error.
   *
   * ⚠ Not `/health`. Health answers "can this process serve a request"; this
   * answers "is the system still doing its job", and it is authenticated because
   * it names workspaces and flows.
   */
  signals: () =>
    req<{
      state: string;
      checkedAt: string;
      signals: Array<{
        name: string;
        state: string;
        detail: string;
        caveat: string;
        facts?: Record<string, unknown>;
      }>;
    }>(`/signals`),
  listFlowTriggers: (wsId: string, flowId: string) =>
    req<{ triggers: FATrigger[] }>(`/workspaces/${wsId}/flows/${flowId}/triggers`).then(
      (r) => r.triggers,
    ),
  createTrigger: (wsId: string, flowId: string, body: Record<string, unknown>) =>
    req<{ trigger: FATrigger }>(`/workspaces/${wsId}/flows/${flowId}/triggers`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.trigger),
  updateTrigger: (wsId: string, flowId: string, tid: string, body: Record<string, unknown>) =>
    req<{ trigger: FATrigger }>(`/workspaces/${wsId}/flows/${flowId}/triggers/${tid}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.trigger),
  /**
   * Fire now. `fireId` is the `trigger_fires` row — Foundry's id, written before
   * the engine is called, so it exists even when nothing started. `started` is
   * the boolean the leaked `kestraExecutionId` was only ever read as (I-22).
   *
   * `inputs` are the values THIS fire sends, type-checked server-side against
   * the armed revision — a missing required input is a 422 naming it, not the
   * old 409. Absent means "the trigger's stored values and the plan's defaults".
   */
  fireTrigger: (wsId: string, flowId: string, tid: string, inputs?: Record<string, string>) =>
    req<{ fireId: string; started: boolean; error?: string }>(
      `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fire`,
      { method: "POST", ...(inputs ? { body: JSON.stringify({ inputs }) } : {}) },
    ),
  /**
   * The fire audit trail — every attempt to start this trigger, newest first.
   *
   * ⚠ The row worth reading is the one with `flowExecutionId: null`: a fire that
   * started NOTHING still writes a row, and that is the whole reason to look. A
   * silent automation is either not firing (no rows) or firing and being refused
   * (rows with no execution), and those have completely different fixes.
   */
  listTriggerFires: (wsId: string, flowId: string, tid: string) =>
    req<{ fires: FATriggerFire[] }>(
      `/workspaces/${wsId}/flows/${flowId}/triggers/${tid}/fires`,
    ).then((r) => r.fires),
  deleteTrigger: (wsId: string, flowId: string, tid: string) =>
    req<void>(`/workspaces/${wsId}/flows/${flowId}/triggers/${tid}`, { method: "DELETE" }),

  // ---- Workspace membership and roles (GAPS §1.1) -------------------------
  //
  // ⚠ There is no cross-workspace listing and there must not be one: a
  // membership list is the people who work on ONE tenant's automations, and a
  // combined view is a directory of the customer base assembled from rows nobody
  // meant to publish together (D-27's rule, applied to people).
  listMembers: (wsId: string) =>
    req<{ members: FAWorkspaceMember[] }>(`/workspaces/${wsId}/members`).then((r) => r.members),
  /**
   * ⚠ **`claimWorkspace` is DELETED and this is where it was.** It posted to
   * `…/members/claim`, and the first signed-in caller became the admin of any
   * workspace nobody had claimed yet. Both the endpoint and this method are
   * gone: assigning a member is now super-admin-only, and `ui-honesty-check.sh`
   * fails if a `claimWorkspace` reappears in this package.
   */
  grantMember: (wsId: string, body: { subject: string; email: string; role: FAWorkspaceRole }) =>
    req<{ member: FAWorkspaceMember }>(`/workspaces/${wsId}/members`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.member),
  /** By SUBJECT, never email — the membership is keyed on it. */
  revokeMember: (wsId: string, subject: string) =>
    req<{ removed: boolean }>(`/workspaces/${wsId}/members/${encodeURIComponent(subject)}`, {
      method: "DELETE",
    }),
  // Audit explorer (S-68, Phase 13) — immutable record, workspace-scoped
  listAuditEvents: (wsId: string) =>
    req<{ events: FAAuditEvent[] }>(`/workspaces/${wsId}/audit-events`).then((r) => r.events),
  /**
   * One page of the audit record, filtered ON THE SERVER (2026-10-12). With `limit` the server also answers `total`
   * — how many events the filter matches. Without it, every match (what the CSV download needs).
   */
  listAuditPage: (
    wsId: string,
    p: { q?: string; from?: string; to?: string; limit?: number; offset?: number },
  ) => {
    const qs = new URLSearchParams({ view: "raw" });
    if (p.q?.trim()) qs.set("q", p.q.trim());
    if (p.from) qs.set("from", p.from);
    if (p.to) qs.set("to", p.to);
    if (p.limit !== undefined) {
      qs.set("limit", String(p.limit));
      qs.set("offset", String(p.offset ?? 0));
    }
    return req<{ events: FAAuditEvent[]; total?: number }>(`/workspaces/${wsId}/audit-events?${qs}`).then((r) => ({
      events: r.events,
      total: r.total ?? r.events.length,
    }));
  },

  // ---- Deployment level: who I am, and who this API has seen ---------------
  //
  // ⚠ Both are deployment-scoped, so neither takes a workspace id EXCEPT `me`
  // which optionally returns workspace-scoped `capabilities` via `?workspaceId`
  // (B-06). `me` is the ONLY source of "am I a super admin" and "do I have admin
  // capability" in this package.
  me: (workspaceId?: string) =>
    req<FAMe>(workspaceId ? `/me?workspaceId=${encodeURIComponent(workspaceId)}` : "/me"),
  listPlatformUsers: () =>
    req<{ users: FAPlatformUser[]; caveat: string }>("/platform/users"),
  getAccessMatrix: () => req<FAAccessMatrix>("/platform/access"),
  /** People, invitations, and what the reader may do — admin simplify phase 3. */
  getPeople: () => req<FAPeopleView>("/platform/people"),
  /** Add a person by email: applied at once if they have signed in, else kept as an invitation. */
  invite: (body: { email: string; workspaces: { workspaceId: string; role: FAWorkspaceRole }[]; platformRole?: string | null }) =>
    req<FAInviteResult>("/invitations", { method: "POST", body: JSON.stringify(body) }),
  listInvitations: () => req<{ invitations: FAInvitation[] }>("/invitations"),
  revokeInvitation: (id: string) => req<{ revoked: boolean }>(`/invitations/${id}`, { method: "DELETE" }),
  removeInvitationWorkspace: (id: string, workspaceId: string) =>
    req<{ removed: boolean }>(`/invitations/${id}/workspaces/${workspaceId}`, { method: "DELETE" }),

  // ---- Access: what the SERVER says this person may do -----------------------
  //
  // ⚠ **NO ACCESS LOGIC IN THIS FILE.** These methods fetch an answer; they never
  // compute one. `lib/capabilities.ts` used to compute one — a second `ROLE_CAPS`
  // that disagreed with the server's about whether an approver may publish — and
  // it is deleted. `ui-honesty-check.sh` fails if a policy table comes back.

  /** What this person may do in one workspace, with provenance. Identity-only. */
  myPermissions: (workspaceId: string) =>
    req<{
      workspaceId: string;
      permissions: string[];
      provenance: Record<string, unknown[]>;
      memberRole: string | null;
      superAdmin: boolean;
      platformRoles: string[];
      platformPermissions: string[];
    }>(`/workspaces/${workspaceId}/me/permissions`),

  /** The permission catalogue a role editor renders from. Identity-only. */
  permissionCatalogue: () =>
    req<{
      permissions: Array<{ key: string; tier: string; label: string; description: string }>;
      presets: Array<{ name: string; permissions: string[] }>;
      platformConfers: Record<string, string[]>;
      conferrable: string[];
    }>("/permissions/catalogue"),

  // ---- Custom workspace roles ------------------------------------------------
  listWorkspaceRoles: (workspaceId: string) =>
    req<{ roles: unknown[] }>(`/workspaces/${workspaceId}/roles`),
  createWorkspaceRole: (
    workspaceId: string,
    body: { name: string; description?: string | null; permissions: string[] },
  ) => req<{ role: unknown }>(`/workspaces/${workspaceId}/roles`, { method: "POST", body: JSON.stringify(body) }),
  /** ⚠ Retire, never delete. `confirm` is required when anybody holds it. */
  retireWorkspaceRole: (workspaceId: string, roleId: string, confirm = false) =>
    req<{ retired: boolean; hadAssignees: number }>(
      `/workspaces/${workspaceId}/roles/${roleId}${confirm ? "?confirm=true" : ""}`,
      { method: "DELETE" },
    ),
  listWorkspaceRoleMembers: (workspaceId: string, roleId: string) =>
    req<{ members: FAWorkspaceRoleMember[] }>(
      `/workspaces/${workspaceId}/roles/${roleId}/members`,
    ),
  assignWorkspaceRole: (workspaceId: string, roleId: string, subject: string) =>
    req<{ assigned: boolean }>(`/workspaces/${workspaceId}/roles/${roleId}/members`, {
      method: "POST",
      body: JSON.stringify({ subject }),
    }),
  unassignWorkspaceRole: (workspaceId: string, roleId: string, subject: string) =>
    req<{ assigned: boolean }>(
      `/workspaces/${workspaceId}/roles/${roleId}/members/${encodeURIComponent(subject)}`,
      { method: "DELETE" },
    ),

  // ---- The platform tier -----------------------------------------------------
  listPlatformRoles: () => req<{ roles: unknown[] }>("/platform/roles"),
  listPlatformRoleAssignments: () => req<{ assignments: unknown[] }>("/platform/role-assignments"),
  assignPlatformRole: (body: { subject: string; email: string; roleKey: string }) =>
    req<{ assigned: boolean }>("/platform/role-assignments", { method: "POST", body: JSON.stringify(body) }),
  unassignPlatformRole: (subject: string, roleKey: string) =>
    req<{ assigned: boolean }>(
      `/platform/role-assignments/${encodeURIComponent(subject)}/${encodeURIComponent(roleKey)}`,
      { method: "DELETE" },
    ),
  /** ⚠ INV-17 — both audit stores, already in one time order. */
  platformAudit: (params?: { limit?: number; actor?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.actor) q.set("actor", params.actor);
    const qs = q.toString();
    return req<{ events: unknown[] }>(`/platform/audit${qs ? `?${qs}` : ""}`);
  },

  // ---- Local accounts (username + password, for people with no AD identity) --
  //
  // ⚠ There is NO wrapper for `/local-auth/verify` and there must not be. That
  // route takes a password and is called by `auth.ts` server-side; a method
  // here would put a credential-checking call on a client whose every request
  // goes through a proxy that already holds `PARENT_API_KEY`.
  //
  // ⚠ And no method reads a password back, because no route returns one.
  listLocalUsers: () => req<{ users: FALocalUser[] }>("/local-users"),
  createLocalUser: (body: { username: string; password: string; email?: string; name?: string }) =>
    req<{ user: FALocalUser }>("/local-users", { method: "POST", body: JSON.stringify(body) }),
  setLocalUserPassword: (id: string, password: string) =>
    req<void>(`/local-users/${id}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  updateLocalUser: (
    id: string,
    body: { username?: string; email?: string | null; name?: string | null },
  ) => req<{ user: FALocalUser }>(`/local-users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLocalUser: (id: string) => req<{ user: FALocalUser }>(`/local-users/${id}`, { method: "DELETE" }),
  setLocalUserActive: (id: string, isActive: boolean) =>
    req<{ user: FALocalUser }>(`/local-users/${id}/active`, {
      method: "POST",
      body: JSON.stringify({ isActive }),
    }),

  /**
   * Which workspaces one local account can act in.
   *
   * ⚠ The account is named by its ID and the SUBJECT never crosses the wire
   * from here — the server derives it from the row. So there is no field in
   * which this client could name somebody else's identity, which is the point
   * of these three living under `/local-users` rather than being three more
   * calls to the workspace members route.
   */
  listLocalUserAccess: (id: string) =>
    req<{ access: FALocalUserAccess[] }>(`/local-users/${id}/access`).then((r) => r.access),
  grantLocalUserAccess: (id: string, workspaceId: string, role: FAWorkspaceRole) =>
    req<{ member: unknown }>(`/local-users/${id}/access/${workspaceId}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  revokeLocalUserAccess: (id: string, workspaceId: string) =>
    req<{ removed: boolean }>(`/local-users/${id}/access/${workspaceId}`, { method: "DELETE" }),

  /** What one run called — tools, reads and web addresses — from Foundry's own records. */
  runCalls: (wsId: string, runId: string) =>
    req<{ calls: FARunCall[]; truncated: boolean }>(`/workspaces/${wsId}/flow-executions/${encodeURIComponent(runId)}/calls`),

  // ---- the LLM provider ----------------------------------------------------
  //
  // Configuration for the `llm_complete` tool: which gateway, which key, which
  // models a flow may name. The key travels ONE WAY. `getLlmProvider` returns a
  // `keyFingerprint` and never a value, exactly as `listSecrets` returns
  // `hasValue` and never content — a settings page is precisely where that rule
  // gets broken "so the operator can check what they pasted".
  //
  // ⚠ `llmModels` and `llmTest` are NOT the same evidence. Listing models proves
  // the gateway answered; it is the documented false-green shape of
  // `llmConnected: true` from a health probe that "verifies" an LLM by
  // listing models. Only `llmTest` runs a completion. The UI must show both and
  // must not present a populated dropdown as a working configuration.
  getLlmProvider: () => req<FALlmProvider>("/runtime-model/provider"),
  saveLlmProvider: (body: {
    baseUrl: string;
    /** Omit to keep the stored key. */
    apiKey?: string;
    defaultModel: string;
    allowedModels: string[];
  }) => req<FALlmProvider>("/runtime-model/provider", { method: "PUT", body: JSON.stringify(body) }),
  clearLlmProvider: () => req<FALlmProvider>("/runtime-model/provider", { method: "DELETE" }),
  llmModels: (probe?: { baseUrl?: string; apiKey?: string }) =>
    req<{ models: string[]; caveat: string }>("/runtime-model/models", {
      method: "POST",
      body: JSON.stringify(probe ?? {}),
    }),
  llmTest: (probe?: { baseUrl?: string; apiKey?: string; model?: string }) =>
    req<FALlmTest>("/runtime-model/test", { method: "POST", body: JSON.stringify(probe ?? {}) }),

  // ── ⚠ The model that DESIGNS automations — a DIFFERENT provider (F2) ───────
  //
  // `/generation/*`, not `/ops/*`. Measured 2026-08-07: the ops row said
  // `gpt-5.4-mini` and flow generation carried on running the environment's
  // model, because the two are separate stores read by separate processes.
  // D-35 forbids merging them — *"runtime and generation inference must not be
  // merged: different credentials, different processes, no shared abstraction"*
  // — so these are separate methods rather than a `kind` parameter on the four
  // above, which is the refactor that would quietly delete the property.
  //
  // ⚠ **There is no `saveGenerationProvider({baseUrl, apiKey})` and there must
  // not be.** The gateway and key come from the deployment's environment; the
  // server refuses those fields by name rather than ignoring them, because a
  // field accepted and dropped reads exactly like one that works.
  getGenerationProvider: () => req<FAGenerationProvider>("/generation/llm/provider"),
  saveGenerationProvider: (body: { defaultModel: string; allowedModels: string[] }) =>
    req<{ defaultModel: string; allowedModels: string[]; source: string }>("/generation/llm/provider", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  clearGenerationProvider: () =>
    req<{ defaultModel: string; source: string }>("/generation/llm/provider", { method: "DELETE" }),
  /**
   * Model prices, per 1M input and per 1M output tokens, in US dollars (rbac-observability, 2026-10-15). Readable by
   * anyone signed in; setting one needs `platform.generation.write`. Null for both removes a price.
   */
  getModelPricing: () => req<FAModelPricing>("/generation/pricing"),
  setModelPrice: (body: FAModelPriceInput) =>
    req<{ prices: FAModelPrice[] }>("/generation/pricing", { method: "PUT", body: JSON.stringify(body) }),
  getModelSpend: (days: number) =>
    req<{ days: number; models: FAModelSpend[]; currency: "USD" }>(`/generation/pricing/spend?days=${days}`),
  generationModels: () =>
    req<{ models: string[]; caveat: string }>("/generation/llm/models", { method: "POST" }),
  generationTest: () =>
    req<{ ok: boolean; model?: string; ms: number; reply?: string; message?: string }>(
      "/generation/llm/test",
      { method: "POST" },
    ),
  getMyAttendance: (workspaceId: string, period: string) =>
    req<FAAttendanceStatus>(`/workspaces/${workspaceId}/me/attendance?period=${encodeURIComponent(period)}`),
  getMyExceptions: (workspaceId: string, period: string) =>
    req<{ period: string; exceptions: FAExceptionNotice[] }>(
      `/workspaces/${workspaceId}/me/exceptions?period=${encodeURIComponent(period)}`,
    ),
  // Incidents (B-16)
  listIncidents: (wsId: string) => req<{ incidents: FAIncident[] }>(`/workspaces/${wsId}/incidents`),
  createIncident: (
    wsId: string,
    body: { id: string; title: string; severity: FAIncidentSeverity; ownerSubject?: string },
  ) =>
    req<{ incident: FAIncident }>(`/workspaces/${wsId}/incidents`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  transitionIncident: (wsId: string, id: string, status: FAIncidentStatus) =>
    req<{ incident: FAIncident }>(`/workspaces/${wsId}/incidents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  // Break-glass (B-16)
  activeBreakGlass: (wsId: string) =>
    req<{ sessions: FABreakGlassSession[] }>(`/workspaces/${wsId}/break-glass/active`),
  activateBreakGlass: (
    wsId: string,
    body: {
      incidentId: string;
      scope: "hris-unmasked" | "payroll-restricted";
      durationHours: 1 | 2 | 4;
      justification: string;
      acknowledged: true;
    },
  ) =>
    req<{ session: FABreakGlassSession }>(`/workspaces/${wsId}/break-glass`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeBreakGlass: (wsId: string, id: string) =>
    req<{ session: FABreakGlassSession }>(`/workspaces/${wsId}/break-glass/${id}/revoke`, {
      method: "POST",
    }),

  // Release gates (B-19)
  listReleaseGates: (wsId: string, flowId?: string) =>
    req<{ gates: FAReleaseGate[] }>(
      flowId
        ? `/workspaces/${wsId}/flows/${flowId}/release-gates`
        : `/workspaces/${wsId}/release-gates`,
    ),
  setReleaseGateEnabled: (wsId: string, gateId: string, enabled: boolean) =>
    req<{ gate: FAReleaseGate }>(`/workspaces/${wsId}/release-gates/${gateId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),

  // Member capabilities (B-06)
  listMemberCapabilities: (wsId: string) =>
    req<{ capabilities: FAMemberCapability[] }>(`/workspaces/${wsId}/member-capabilities`),
  grantMemberCapability: (wsId: string, subject: string, capability: string) =>
    req<{ ok: true }>(
      `/workspaces/${wsId}/member-capabilities/${encodeURIComponent(subject)}/${capability}`,
      { method: "PUT" },
    ),
  revokeMemberCapability: (wsId: string, subject: string, capability: string) =>
    req<{ ok: true }>(
      `/workspaces/${wsId}/member-capabilities/${encodeURIComponent(subject)}/${capability}`,
      { method: "DELETE" },
    ),

  // Budget (M3/M4)
  getBudget: (wsId: string) => req<FABudget>(`/workspaces/${wsId}/budget`),
  setBudget: (
    wsId: string,
    body: { maxConcurrentExecutions?: number; maxTokensPerDay?: number | null },
  ) => req<FABudget>(`/workspaces/${wsId}/budget`, { method: "PUT", body: JSON.stringify(body) }),
  clearBudget: (wsId: string) => req<FABudget>(`/workspaces/${wsId}/budget`, { method: "DELETE" }),
  getApprovalFigures: (wsId: string) =>
    req<{ pendingYourApproval: number; inFlight: number }>(
      `/workspaces/${wsId}/approval-requests/figures`,
    ),
};

/**
 * The generation provider as the page reads it.
 *
 * ⚠ `baseUrl` is READ-ONLY and `keyFingerprint` is never a key — there is no
 * endpoint in this product that returns a secret value and no `?reveal=`.
 *
 * ⚠ `source: "environment"` is the DEFAULT, not a degraded state. Rendering it
 * the same as `configured` is how "I changed this and nothing happened" happens
 * a second time.
 */
export interface FAGenerationProvider {
  baseUrl: string | null;
  keyFingerprint: string | null;
  defaultModel: string;
  allowedModels: string[];
  source: "configured" | "environment";
  /** What clearing the setting would produce. Named on the button rather than implied. */
  environmentModel: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Who set it, as a person reads it: their sign-in name, else their email. Null when unknown. */
  updatedByName?: string | null;
}

// ---- Workspace identity -----------------------------------------------------
// The server scopes every tool/datasource/flow/trigger under a workspace id, and
// this is the ONE place the browser decides which id that is.
//
// ⚠ THE COMMENT THAT USED TO BE HERE CAUSED I-103. It read:
//
//     "The UI's mock 'active workspace' (localStorage) is a different concept,
//      so A-backed calls resolve a REAL App A workspace id here."
//
// True when it was written — the localStorage workspace belonged to
// `lib/mockdb.ts`, and resolving separately was correct. Stage 1 deleted the
// mock, `lib/workspace.tsx` became real, the topbar gained a switcher, and this
// sentence was never revisited. So the switcher wrote a choice that nothing on
// this path read: pages remounted, refetched, and refetched the SAME workspace,
// and a tool created after a switch landed in the one switched away from. Same
// family as I-95 — a statement accurate about the code path it was written for,
// surviving into one where it is false.
//
// ⚠ THE OLDEST-WORKSPACE RULE IS ALSO LOAD-BEARING. This used to be `list[0]`,
// and the server returns workspaces `created_at DESC` — so **creating any new
// workspace silently repointed the whole UI at it.** Observed 2026-07-26:
// provisioning the WS-E rehearsal workspace moved Tools, Automations, Triggers
// and History off the HR demo without a single visible change. "Newest wins" is
// never the right rule for a default; it means the UI's identity is decided by
// whatever was created last. (`workspace.tsx` held a second copy of exactly that
// bug — `spaces[0]` — until Phase 1 deleted it. Two implementations disagreed
// about the switch AND about the default.)
//
// Resolution order, most explicit first:
//   1. The person's own choice     — `storedWorkspaceChoice()`, validated below.
//   2. FOUNDRY_WORKSPACE_ID        — an exact id.
//   3. FOUNDRY_WORKSPACE           — a workspace NAME (nicer to configure).
//   4. The OLDEST workspace        — stable; it cannot change when one is added.
//   5. Create a default if there are none at all.
//
// ⚠ The env settings sit BELOW the person deliberately. They exist to pin a
// deployment's default — the workspace you land in — not to overrule a live
// choice. An env var that outranks the switcher makes the switcher a control
// that cannot work, which is I-103 again with a different cause.
//
// Both arrive from /api/foundry-config at REQUEST time. They are not
// `NEXT_PUBLIC_*` on purpose: those are baked into the bundle at build time, so
// changing one would need an image rebuild rather than a restart.

let _wsId: string | null = null;
let _wsInflight: Promise<string> | null = null;
// Bumped by `adoptWorkspaceId`. A resolve that started before a switch must not
// write its now-stale answer into `_wsId` when it lands — it may legitimately
// still return that answer to ITS caller (the call was made in the old
// workspace), but it must not repoint everything afterwards.
let _wsGeneration = 0;

/**
 * The person switched workspace. Adopt it immediately.
 *
 * ⚠ Phase 1.2, and this is the half most likely to be missed: `_wsId` is a
 * module-level cache assigned once for the life of the page. Teaching
 * `resolveWorkspaceId` to read the stored choice fixes a *fresh load* and
 * changes nothing about a switch made inside a live page — and that tests green,
 * because a test that reloads never sees it.
 *
 * It ADOPTS rather than merely invalidating. The switcher already holds a real
 * id from the list it rendered, so there is nothing to look up, and clearing to
 * null would open a window where `activeFoundryWorkspaceId()` (which four
 * components read to build links) answers "unknown" for a workspace the person
 * just picked.
 */
export function adoptWorkspaceId(id: string): void {
  _wsId = id;
  _wsInflight = null;
  _wsGeneration++;
}

async function preferredWorkspace(): Promise<{
  workspaceId?: string | null;
  workspaceName?: string | null;
}> {
  const none = {};
  try {
    const res = await fetch("/api/foundry-config", { cache: "no-store" });
    // The auth middleware matches this path, so an expired session REDIRECTS here
    // and returns the login page as HTML. Parsing that throws, and the catch below
    // would then fall back to a different workspace SILENTLY — which is the exact
    // class of bug this whole function exists to fix. Check the type, and say so.
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !ct.includes("application/json")) {
      console.warn(
        `[foundry] /api/foundry-config returned ${res.status} ${ct || "(no content-type)"} — ` +
          "falling back to the oldest workspace. If the UI is showing the wrong " +
          "workspace, this is why (usually an expired session).",
      );
      return none;
    }
    return (await res.json()) as { workspaceId?: string | null; workspaceName?: string | null };
  } catch (e) {
    console.warn(
      `[foundry] could not read /api/foundry-config (${e instanceof Error ? e.message : e}); ` +
        "falling back to the oldest workspace.",
    );
    return none;
  }
}

/**
 * What `resolveWorkspaceId()` throws when the deployment holds no workspace at all.
 *
 * ⚠ **Compared by identity, never re-typed.** A screen wanting to render this
 * state imports the constant; a screen matching on a substring of the prose would
 * break the day the sentence is reworded, and it would break by falling back to
 * "something went wrong" — the least informative branch. `dashboard/page.test.tsx`
 * pins that the dashboard uses the constant.
 *
 * It is a sentence rather than a code because every other page under the app
 * shell renders `error` verbatim in its own notice, so this text IS the UI on all
 * of them. It must therefore say the cause and the fix, and it must not blame the
 * page it lands on.
 */
export const NO_WORKSPACE_MESSAGE =
  "There are no workspaces on this deployment yet. Whoever administers it can create the first one from Manage Workspaces.";

export function resolveWorkspaceId(): Promise<string> {
  if (_wsId) return Promise.resolve(_wsId);
  if (_wsInflight) return _wsInflight;
  const gen = _wsGeneration;
  const settled = () => {
    // Only clear the slot if it is still ours. After a switch it belongs to a
    // newer resolve, and nulling it there would strand that one's callers.
    if (gen === _wsGeneration) _wsInflight = null;
  };
  _wsInflight = (async () => {
    const [list, cfg] = await Promise.all([
      foundryApi.listWorkspaces(),
      preferredWorkspace(),
    ]);
    const CHOSEN = storedWorkspaceChoice() ?? undefined;
    const PREFERRED_ID = cfg.workspaceId?.trim() || undefined;
    const PREFERRED_NAME = cfg.workspaceName?.trim() || undefined;
    // ⚠ The choice is VALIDATED against the list, not trusted. A workspace
    // deleted in another tab, or a browser profile carried to a different
    // deployment, leaves an id nothing owns — and pinning the UI to it would
    // 404 every scoped call while the topbar still named it. Forget it and fall
    // through, out loud.
    const byChoice = CHOSEN ? list.find((w) => w.id === CHOSEN) : undefined;
    const byId = PREFERRED_ID ? list.find((w) => w.id === PREFERRED_ID) : undefined;
    const byName = PREFERRED_NAME
      ? list.find((w) => w.name.toLowerCase() === PREFERRED_NAME.toLowerCase())
      : undefined;
    // list is created_at DESC, so the last element is the oldest.
    const oldest = list.length ? list[list.length - 1] : undefined;

    if (CHOSEN && !byChoice) {
      console.warn(
        `[foundry] the workspace you last chose (${CHOSEN}) no longer exists; falling back.`,
      );
      clearWorkspaceChoice();
    }
    if (PREFERRED_ID && !byId) {
      console.warn(
        `[foundry] NEXT_PUBLIC_FOUNDRY_WORKSPACE_ID=${PREFERRED_ID} matches no workspace; falling back.`,
      );
    }
    if (PREFERRED_NAME && !byName) {
      console.warn(
        `[foundry] NEXT_PUBLIC_FOUNDRY_WORKSPACE="${PREFERRED_NAME}" matches no workspace; falling back.`,
      );
    }

    // ⚠ THIS USED TO END `?? await foundryApi.createWorkspace({name: "Foundry"})`,
    // AND THAT IS NOW TWO DEFECTS IN ONE LINE.
    //
    // It was a reasonable convenience while anyone signed in could create a
    // workspace. Since the super-admin pass (2026-08-20) creation is
    // `requireSuperAdmin`, so on a deployment with no workspaces it 403s — and
    // because it 403s *inside the resolver*, every scoped page on the app fails
    // its first read and reports the refusal in its own words. What a person saw
    // on `/dashboard` was **"Could not read this workspace's runs"** with a
    // sentence about `SUPER_ADMIN_EMAILS` inside it: two true statements that
    // together name neither the cause (there is no workspace) nor the fix.
    //
    // The second defect is the one that would have outlived the first: for a
    // caller who IS a super admin it **succeeds**, and silently creates a real
    // tenant as a side effect of loading a page. Self-service creation is exactly
    // what `members/claim`'s deletion removed, and this line put it back in a
    // place nobody would look — no confirmation, no audit intent, named
    // "Foundry" by a constant.
    //
    // So: resolve, or say there is nothing to resolve. `NO_WORKSPACE_MESSAGE` is
    // exported and compared by identity (never re-typed) so a screen can render
    // the state properly rather than pattern-matching prose.
    const ws = byChoice ?? byId ?? byName ?? oldest;
    if (!ws) throw new Error(NO_WORKSPACE_MESSAGE);
    if (gen === _wsGeneration) _wsId = ws.id;
    settled();
    return ws.id;
  })().catch((e) => {
    settled();
    throw e;
  });
  return _wsInflight;
}

/** Which workspace the UI is bound to, for display. Null before first resolve. */
export function activeFoundryWorkspaceId(): string | null {
  return _wsId;
}

// ── `faFallback` WAS HERE. DO NOT BRING IT BACK. ────────────────────────────
//
//   export async function faFallback<T>(real: () => Promise<T>, mock: () => Promise<T>) {
//     try { return await real() }
//     catch (e) { console.warn("… using local data:", e); return mock() }
//   }
//
// It wrapped ten reads — tools, triggers, datasources, run history, `whoami` — so
// that "the UI never breaks". What it actually did was answer every server failure
// with fabricated rows from `lib/mockdb.ts` and leave a `console.warn` as the only
// evidence. A 500, a 404 from a route deleted three phases ago, an expired
// session, a stopped container: all rendered as a working page full of data that
// no server had ever seen.
//
// Two things made it worse than an ordinary bug. It was invisible in exactly the
// situation you most need the truth — a demo, where nobody is reading the console.
// And it hid its own cause: deleting a server route did not break a page, it
// silently re-pointed that page at localStorage, so the tests and the click-through
// both stayed green.
//
// The rule now: a failed call throws and the page renders an error. Degrading to
// LESS data is fine (see `listFlowRuns`, which falls back from an execution's full
// detail to its summary). Degrading to DIFFERENT data is not.

/** One connection a workflow can run as, for one service. */
/** `each` (sharing-boundaries phase 3): no single connection — every run uses its starter's own (`connectionId` "each"). */
export type FlowRunAsChoice = { connectionId: string; label: string; personal: boolean; service: string; each?: boolean; own?: boolean };
/** One thing a workflow needs before it can run, and who fixes it. */
export type FlowNeed = {
  cause: "not_installed" | "not_enabled" | "not_connected" | "choose_account" | "connection_gone";
  service: string;
  piece: string | null;
  message: string;
  fixBy: string;
  href: string | null;
  options?: Array<{ connectionId: string; label: string }>;
};
export type FlowReadiness = { ready: boolean; needs: FlowNeed[] };
/** "Turn on for me": whether this person can, whether they did, and whether a newer approved version paused it. */
export type FlowActivation = {
  available: boolean;
  reason: string | null;
  on: boolean;
  paused: string | null;
  schedule: { cron: string; timezone: string } | null;
  mine: { cron: string; timezone: string } | null;
};
/** A workflow's "Runs as": per service, the draft's choice, the approved one, and the options this person has. */
export type FlowRunAs = {
  services: Array<{ piece: string; service: string; current: FlowRunAsChoice | null; approved: FlowRunAsChoice | null; options: FlowRunAsChoice[] }>;
  /** Whether the person asking owns the workflow (only an owner is offered their own account). */
  owner: boolean;
  approved: boolean;
  /** Shared with the workspace: only then can each person run it on their own account. */
  shared?: boolean;
  /** In My space: no choice — it always uses its owner's own accounts (sharing-boundaries Q3). */
  mySpace?: boolean;
};

/** Projects (sharing-boundaries phase 5). */
export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  ownerSubject: string;
  members?: number;
  /** This person is in it. */
  mine?: boolean;
  /** This person owns it. */
  owned?: boolean;
};
export type ProjectDetail = Omit<ProjectSummary, "members"> & {
  ownerName: string;
  /** `you`: this row is the person asking. */
  members: Array<{ subject: string; name: string; owner: boolean; you: boolean; addedAt: string }>;
  items: {
    flows: Array<{ id: string; name: string; ownerSubject: string | null; ownerName: string; updatedAt?: string | null }>;
    chats: Array<{ id: string; title: string | null; createdBySubject: string | null; flowId: string | null; ownerName: string; canChange: boolean; updatedAt?: string | null }>;
  };
  /** The owner or an Admin: may change it, its members, and delete it. */
  manages: boolean;
};
export type MovableItem = { kind: "flow"; id: string } | { kind: "chat"; id: string };
export type Place = { kind: "mine" } | { kind: "workspace" } | { kind: "project"; projectId: string };
/** What a move would change, said before it happens. */
export type MovePreview = {
  from: Place;
  to: Place;
  /** Who would stop seeing it (names). */
  loses: string[];
  /** How many more people would see it. */
  gains: number;
  /** It runs on its own (approved and switched on). */
  live: boolean;
  /** People who turned it on for themselves and would lose it. */
  turnedOnBy: string[];
  /** Chats that use it. */
  referencedBy: string[];
  /** A live workflow whose accounts change with the move, one line per service (it is switched off until approved). */
  runsAs?: string[];
  /** Said before the move when it stops running on its own, and why. */
  switchesOff?: string | null;
  narrows: boolean;
};
function movePath(wsId: string, item: MovableItem): string {
  return item.kind === "flow" ? `/workspaces/${wsId}/flows/${item.id}` : `/workspaces/${wsId}/pi-builder/chats/${item.id}`;
}
