// src/lib/types.ts — shared domain model for the Foundry pages. One definition per
// thing, imported everywhere. Content mirrors Foundry-UX-Design.pdf verbatim.

/** The signed-in user (mocked; real auth arrives with the RBAC team). */
export type User = { name: string; email: string };

/** Health expressed in plain words, driving a colored dot/pill. */
export type Status = "ok" | "warn" | "danger" | "neutral";

/** Parameter data types a tool accepts (from the tool-onboarding service). */
export type DataType = "string" | "integer" | "float" | "boolean" | "array";

/** One input parameter of a tool. */
export type ToolParam = {
  name: string;
  dataType: DataType;
  required: boolean;
  /**
   * What this parameter MEANS, in a sentence — not what it is called.
   *
   * It is rendered into the workspace manifest as the body of `<param>`, so it
   * is the only place the flow drafter learns that `recipients` accepts "one
   * address or an array of up to 50" and that a 202 from `mail_send` means
   * nothing was delivered. A tool with typed parameters and no descriptions is
   * a tool the drafter has to guess at.
   */
  description?: string;
};

/** A catalog action on "Tools". Mirrors the tool-onboarding `tools` table:
    name, description, api endpoint, typed parameters. */
export type Tool = {
  id: string;
  workspaceId?: string;
  name: string;
  description: string;
  app: string;
  type: "changes data" | "read-only" | "read-only send";
  /**
   * How many distinct flows reference this tool — computed server-side from
   * `flow_steps.manifest_refs_json` (distinct flows across any revision).
   *
   * ⚠ Phase 7 (I-104 landing): this used to be a hardcoded "—" from
   * `toolFromFA`, rendered as a column that promised information nobody was
   * going to get. The type kept it because a real ref count is a real feature;
   * the server now computes it, so the field is a real number and the "—" the
   * page shows for a zero is a rendering of that zero, not a placeholder.
   */
  usedBy: number;
  status: Status;
  statusText: string;
  endpoint?: string; // api_endpoint
  /** GET / POST / … — the field that decides whether this tool can change data. */
  method?: string;
  /**
   * The env-var NAME of the credential this tool presents. Never a value —
   * there is deliberately no endpoint that returns one, and no `?reveal=`.
   */
  secretEnvName?: string | null;
  /**
   * HOW the credential is presented —
   * `bearer | header | query | basic | none | oauth2_client_credentials`.
   *
   * ⚠ Read as well as written since foundations Phase 1.2. `<secretRef env="K"/>`
   * said a key existed but not where it went, so an agent guessed between four
   * styles and a wrong guess was a 401 the audit called `clean`; WS-B.4 made it
   * declared data. The client then dropped it, which is why no tool created in
   * the UI could authenticate at all (I-124).
   *
   * ⚠ `oauth2_client_credentials` (Phase 7) reads its credentials from
   * `clientIdSecretRef` + `clientSecretSecretRef` — two env-var names — and a
   * `tokenUrl`; it has no `secretEnvName`, and the server refuses one for it.
   *
   * ⚠ It is inside `refFingerprints()`'s hash together with `authParamName`,
   * `method`, `url`, `paramsSchema` and `secretEnvName` — see
   * `lib/tool-edit.ts`. Changing any of the six unarms every automation approved
   * against the old shape. The oauth2 trio (`tokenUrl`/`clientIdSecretRef`/
   * `clientSecretSecretRef`) is NOT in the hash — editing them does not unarm.
   */
  authStyle?:
    | "bearer"
    | "header"
    | "query"
    | "basic"
    | "none"
    | "oauth2_client_credentials"
    | null;
  /** The header or query-parameter name a `header`/`query` style puts it in. */
  authParamName?: string | null;
  /**
   * The OAuth2 token endpoint Foundry calls with the client credentials —
   * `oauth2_client_credentials` only, and required for that style.
   */
  tokenUrl?: string | null;
  /**
   * The env-var NAME of the workspace secret holding the OAuth2 client id —
   * `oauth2_client_credentials` only. Same reference vocabulary as
   * `secretEnvName`: never a value, and there is deliberately no endpoint that
   * returns one.
   */
  clientIdSecretRef?: string | null;
  /**
   * The env-var NAME of the workspace secret holding the OAuth2 client secret —
   * `oauth2_client_credentials` only.
   */
  clientSecretSecretRef?: string | null;
  params?: ToolParam[]; // typed inputs
  /**
   * The last probe of this tool, as the server that answered remembers it
   * (`specs/20260818-123807-tool-probe` P3).
   *
   * ⚠ **`null` when there is no record, and the row then renders NOTHING** — not
   * "unknown", not a grey pill, and never a column. The marker is in-process by
   * design (no schema), so absence is the honest state after a restart or on
   * another container, and a rendering that fills the gap with a word invents the
   * one thing this feature exists to avoid. `page.test.tsx` asserts the absence
   * with a control that the line appears when the field is present.
   */
  lastProbe?: ToolProbeMark | null;
};

/** What the server remembers about the last probe of a saved tool. */
export type ToolProbeMark = {
  /** ISO 8601 — the CLIENT renders the age, so it is right at read time. */
  at: string;
  verdict: ToolProbeVerdict;
  mode: ToolProbeMode;
  status: number | null;
};

// ── The tool probe ("Test this tool") ────────────────────────────────────────
//
// `specs/20260818-123807-tool-probe` · contracts/tool-probe.md
//
// ⚠ These mirror the server's response EXACTLY and add nothing. The panel derives
// no verdict, no tone and no sentence of its own — `probeCopy` in
// `lib/tool-probe.ts` maps server fields to presentation and nothing else. A
// client that computes its own verdict is a second opinion about whether a tool
// works, and the two will disagree on the day it matters.

/**
 * `live` invokes the tool. `reachability` asks the host whether the path exists
 * WITHOUT sending the tool's own method.
 *
 * ⚠ The distinction is not cosmetic: `live` on a `POST` ticketing tool files a
 * ticket. `defaultModeFor` picks `reachability` for anything mutating, and a live
 * probe of one has to be asked for explicitly.
 */
export type ToolProbeMode = "live" | "reachability";

/**
 * The server's verdict word. **The client renders it; it never derives it.**
 *
 * ⚠ `reachable` is the one that gets misread as "it works" — it means the host
 * answered *something* to a `HEAD`, and the tool's own call was never made. The
 * server's `message` carries that caveat in the sentence itself, which is why the
 * panel renders the server's words rather than its own.
 */
export type ToolProbeVerdict =
  | "ok"
  | "reachable"
  | "auth_rejected"
  | "forbidden"
  | "not_found"
  | "upstream_error"
  | "client_error"
  | "unreachable"
  | "egress_refused"
  | "timeout";

export type ToolProbe = {
  mode: ToolProbeMode;
  verdict: ToolProbeVerdict;
  /** ⚠ `false` ⇒ the tool's own operation did NOT run. The panel must say so. */
  invoked: boolean;
  request: {
    /** What was actually sent — may differ from `toolMethod`. */
    method: string;
    /** What the tool would send in a run. */
    toolMethod: string;
    /** ⚠ A `query`-style credential is already `[redacted]` here, server-side. */
    urlShown: string;
    fellBackToGet: boolean;
    /** Placement only — `header:x-api-key`, `query:api_key`, `authorization`. Never a value. */
    authPresented: { style: string | null; placement: string | null };
  };
  /** `null` when no HTTP answer arrived at all (timeout, DNS, egress refusal). */
  status: number | null;
  statusText: string | null;
  contentType: string | null;
  durationMs: number;
  /** `null` for an empty body. `redacted: false` ⇒ non-JSON, so key-name redaction could not apply. */
  body: { preview: string; redacted: boolean; truncated: boolean } | null;
  /** One sentence, written server-side, always naming the host and the status. */
  message: string;
  /** ⚠ Present ONLY when there is a specific next action. Never "try again". */
  remedy: string | null;
};

/**
 * What the onboarding form can probe before saving.
 *
 * ⚠ **There is no field for a credential VALUE, and adding one is out of
 * contract.** A probe presents what the workspace already holds under the named
 * key, or the server refuses with a 424. A "paste your key to test it" box would
 * be a second, unstored credential path, and the configuration tested would not
 * be the one a run uses.
 */
export type ToolProbeDraft = {
  name: string;
  url: string;
  method?: string;
  authStyle?: Tool["authStyle"];
  authParamName?: string | null;
  /** A NAME. Never a value. */
  secretEnvName?: string | null;
  tokenUrl?: string | null;
  clientIdSecretRef?: string | null;
  clientSecretSecretRef?: string | null;
};

/** A trigger card on "Triggers". */
export type Trigger = {
  id: string;
  workspaceId?: string;
  /**
   * The automation this trigger starts. Added in ui-upgrade Phase 7.2 as the
   * grouping key: grouping on `automationName` would merge two automations that
   * share a name and split one that gets renamed mid-list.
   */
  flowId?: string | null;
  name: string;
  kind: string; // the server's own type word — "manual", "webhook", "poll", "api"
  /**
   * ⚠ FIVE, and one of them is legacy-only.
   *
   * It held seven — `email`, `cron`, `kafka`, `rabbitmq` and `file` as well —
   * and four of those were reachable only through a picker that created
   * something inert under their name (`issues.md` I-94). Now it mirrors the
   * four types a flow-bound trigger may have, plus `schedule` for rows that
   * predate the server's refusal of one. Same family as I-81: a union member no
   * path can produce is a state nobody can debug.
   */
  icon: "manual" | "webhook" | "poll" | "schedule" | "api";
  quote: string; // the blue plain-English line
  /** ⚠ TWO values. `"Available"` was here and unreachable — `triggerFromFA()` is the only
   *  producer and it returns `live ? "Live" : "Draft"`. `issues.md` I-81. */
  state: "Live" | "Draft";
  stateStatus: Status;
  rows: { label: string; value: string; mono?: boolean }[]; // detail rows
  note?: string; // extra muted line
  lastStarted?: string;
  // ⚠ `primary` was here, and the adapter set it to the string `"Test"` — the
  // label on the button that fires the approved LIVE revision (`issues.md`
  // I-95). Removed with the word rather than renamed: the page says "Fire now",
  // the same words `/flows/[id]` uses for the same call, and a per-row label
  // field is how two surfaces end up naming one action differently.
  secondary?: string; // secondary button label
  // ⚠ `adapterFields` was here — "the fields the AI Boundary Adapter extracts
  // from each message". The create form collected them, `createTrigger` never
  // sent them, no server column held them and no runtime applied them; the
  // detail modal then displayed the schema back as if it were configured
  // (`issues.md` I-94). Removed rather than wired up: the kinds it existed for
  // (email, file drop) are the ones Foundry has no connector for.
  // WS-H0.2 — the automation this trigger starts, and whether it may go live yet.
  // `enableReady` comes from the server (generation completed AND at least one
  // successful run); `enableBlockedReason` is the sentence to show when it hasn't.
  automationName?: string | null;
  enableReady?: boolean;
  enableBlockedReason?: string | null;
  /**
   * Phase 3, gate 2. Present only for a FLOW-bound trigger.
   *
   * Deliberately separate from `enableBlockedReason`. They are different
   * questions with different answers — "this has never run" is fixed by running
   * it, "this has no approved revision" is fixed by a second person — and one
   * combined sentence can only be right about one of them.
   */
  approvalBlockedReason?: string | null;
  /** `armed` = an approved revision is live WITH its schedule deployed in Kestra. */
  approvalStatus?: "draft" | "draft_pending" | "approved" | "armed" | "suspended" | null;
  armedRevision?: number | null;
  /** True when an unapproved revision is waiting behind the one that is live. */
  draftAhead?: boolean;
  /**
   * ui-upgrade Phase 7.1 (D-107) — what this trigger sends, per declared input,
   * and who supplies each value.
   *
   * ⚠ It replaces rendering `config` as detail rows. `config.inputs` is an
   * object, and `String({period:"2026-06"})` is `"[object Object]"` — which is
   * what the card showed for every trigger that carried inputs (`issues.md`
   * I-92).
   */
  declaredInputs?: DeclaredInput[];
  /** Which revision those inputs came from — armed if there is one, else draft. */
  inputsFromRevision?: number | null;
  /** The cron on the automation's MODEL. Reported here; it lives there (D-18). */
  scheduleCron?: string | null;
  /**
   * ⚠ The THIRD sentence, and it is a WARNING (D-108). Its fix is typing a value
   * here — not running the flow (gate 1), not finding an approver (gate 2). It
   * must not be styled like either of those, because it refuses nothing.
   */
  inputsWarning?: string | null;
  /** True when Foundry drafted this trigger at creation rather than a person. */
  draftedFromPlan?: boolean;
};

/** Which control an input deserves. Server-derived (`flowInputFormat`) when present; otherwise `formatFor` falls back to the declared type. */
export type FlowInputFormat = "month" | "date" | "datetime" | "number" | "boolean" | "text";

/** A value derived from the run's firing time. Mirrors the server's `ComputedInputFn` — the compiler owns the expressions. */
export type ComputedInputFn = "priorMonth" | "currentMonth" | "priorDate" | "currentDate" | "currentYear" | "runTimestamp";

/** One declared input of the revision a trigger would run. See `Trigger.declaredInputs`. */
export type DeclaredInput = {
  id: string;
  type: string;
  required: boolean;
  value: string | null;
  source: "trigger" | "plan" | "computed" | "none";
  /**
   * Which firing-time derivation supplies this input, when `source` is
   * `"computed"` — so a surface can say *why* a blank box is correct.
   * Mirrors the server's `DeclaredInput`; absent on an older server.
   */
  computed?: ComputedInputFn | null;
  /**
   * Which control this input deserves, derived server-side by `flowInputFormat`
   * from the declared type, then the flow's own use of it, then the value's
   * shape. Absent on an older server — `text`, which is what every input got
   * before this existed.
   */
  format?: FlowInputFormat;
};

/**
 * One attempt to start a trigger — a row of the fire audit trail.
 *
 * ⚠ `startedRunId` being null is the point of the whole screen. A fire that
 * started nothing still writes a row, so "the automation is silent" splits into
 * two very different diagnoses: no rows (it never fired) and rows with no run
 * (it fired and was refused, almost always by gate 2). Nothing else in the
 * product distinguishes them — the card's "Last started" is set by the fire, not
 * by the run.
 */
export type TriggerFire = {
  id: string;
  /** "manually", "on a schedule", "by a webhook" — already in words. */
  how: string;
  /** Relative, e.g. "2h ago". Empty when the server sent no timestamp. */
  when: string;
  whenIso: string | null;
  /** Foundry's execution id, so it can be linked to `/runs/[id]`. Null = nothing started. */
  startedRunId: string | null;
  /** Foundry's row status, which lags a failure (D-13). Null when nothing started. */
  startedRunStatus: string | null;
};

/** One automation as a flow of declared steps — the Phase 3 `flows` row. */
/**
 * What publishing did about FIRING — the server's `FiringOutcome`, unchanged.
 *
 * ⚠ **"Publish" means "this workflow is ready to run in whatever capacity it was
 * built in"** — scheduled, trigger, manual fire or API. Before that answer, the
 * product had no statement of it at all: approval deployed a Kestra Schedule
 * only when the model declared a cron, every other firing mechanism was a
 * separate row with its own gate, and on this deployment all 8 of those rows
 * were disabled. So every flow could read **Live** while nothing ever fired.
 *
 * ⚠ **THREE FIELDS, NOT A BOOLEAN, AND A PARTIAL ARMING IS THE NORMAL
 * OUTCOME.** The trigger gate requires one succeeded run and is still a hard
 * refusal — only approval's gate 1 was downgraded to a warning (2026-09-07) —
 * and measured, only 1 of 8 triggers here is bound to a flow that has ever
 * succeeded. A boolean would have to round that, and both roundings lie:
 * "armed" over seven refusals, or "not armed" over one live endpoint.
 *
 * ⚠ **ONE DEFINITION.** `lib/types.ts` is the leaf — it imports nothing — so
 * `foundry-client.ts` imports this rather than declaring its own wire copy,
 * which is what a first draft of this did (D-197).
 */
export type FiringOutcome = {
  /** Enabled by this publish, or already on. */
  armed: Array<{ id: string; name: string; type: string }>;
  /** Not enabled, each carrying the server's own reason verbatim. */
  held: Array<{ id: string; name: string; type: string; reason: string }>;
  /**
   * The cron, when the model declares one. ⚠ NOT a trigger row (D-18): a flow's
   * schedule lives on its model, so a reader looking only at `armed` would
   * conclude a scheduled workflow fires nothing.
   */
  schedule: string | null;
};

export type FlowSummary = {
  /**
   * Which engine runs this flow (server migration 0083, pi-runtime P3). `foundry` = a Pi-built bundle run by
   * flow-runner, opened in the Pi builder; `kestra` (and absent, from an older server) = the compiled path.
   */
  runtime?: "kestra" | "foundry";
  id: string;
  name: string;
  description?: string | null;
  kestraFlowId: string;
  draftRevision: number;
  armedRevision: number | null;
  status: "draft" | "draft_pending" | "approved" | "armed" | "suspended";
  /**
   * ⚠ **THE NUMBER TO PUT ON SCREEN.** The count of approvals this automation
   * has had — so `v2` means "the second thing anybody approved", and it cannot
   * move while somebody edits. `null` until the first approval. `draftRevision`
   * and `armedRevision` are ENGINE identifiers; see `FlowVersion`.
   */
  version?: number | null;
  /** The cron, when the model declares one. Empty means it never fires on a timer. */
  schedule?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  staleReason?: string | null;
  blockedReason?: string | null;
  draftAhead: boolean;
  updatedAt?: string | null;
  /**
   * P5 B-06 — owner of the flow. Null/honest-empty when backend has not modelled it
   * (or derived fallback via `flow.createdBy` / workspaceMembers fails). The
   * `My drafts` view filters by `ownerSubject === me.subject` via
   * `GET /api/me?workspaceId` caps; until owner exists that view is disabled
   * (but the Owner column still renders `—` so the data has purpose when it lands).
   */
  ownerSubject?: string | null;
  ownerName?: string | null;
  /** rbac-observability: the person asking owns it (the server's answer — the "Mine" tab). */
  mine?: boolean;
  /**
   * Who sees it (plugins phase 9): `public` — the whole workspace; `private` — its owner and Admins, and Reviewers
   * once its owner asks for approval or it is live (sharing-boundaries).
   */
  visibility?: "private" | "public";
  /** Its owner asked a reviewer to approve this version; null once approved or withdrawn. */
  reviewRequestedRevision?: number | null;
  /** While shared, may members edit it (sharing-boundaries phase 2); false is view-only. Absent: treated as view-only. */
  othersMayEdit?: boolean;
  /** The project it lives in (sharing-boundaries phase 5); null in My space or the Workspace. */
  projectId?: string | null;
  /** Its project's name, when the list sent one. */
  projectName?: string | null;
  /** The approval it runs under was its owner switching it on, with no reviewer (plugins phase 9). */
  selfEnabled?: boolean;
  /**
   * P5 B-07 — resources this flow depends on (derived from
   * `flow_steps.manifest_refs_json` when the backend exposes it via
   * `GET /resources` union). Honest-empty (`null`/`[]`) renders `—`; the column
   * is present so a future `manifest_refs_json` join has a place, and the page
   * may hydrate names via `GET /resources` rather than inventing them.
   */
  resources?: string[] | null;
  /**
   * P6 — the most recent execution joined for list filtering (Running/Failed).
   * Null/undefined when the flow never ran or the backend has not joined it.
   * The view predicate reads `status === "running" || isLive(engineStatus)` and
   * `status === "failed" || outcome === "stopped"` — so this shape mirrors
   * `FlowExecutionSummary` but `FlowSummary` stays the list row.
   *
   * ⚠ **Honest-empty:** absent is 0 rows for both tabs, not a hidden tab. The
   * predicate is what keeps the count from being always-0: with data it reflects
   * the last run, without it the tab still renders `0` (S-28 Layout).
   */
  lastExecution?: {
    id: string;
    status: string;
    engineStatus: string | null;
    startedAt?: string | null;
  } | null;
  /** Alternate shape when joined via `Run` (history). Same predicate, different source. */
  lastRun?: {
    status?: string;
    engineStatus?: string | null;
    outcome?: string;
    startedAt?: string | null;
  } | null;
};

/** One immutable revision of a flow. */
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A VERSION IS AN APPROVAL — the version list is the approval history
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **`version` IS NOT `revision`, AND THE DIFFERENCE IS THE WHOLE POINT.**
 *
 * A `revision` is an internal, insert-only row written on every edit — a chat
 * turn, a canvas save, a seed, a harness. Reported from use: *"for each change
 * on builder it increments the version… it should only increment once we
 * save"*, and then, decisively: *"increment revision only on approval, without
 * that there won't be any versioning."*
 *
 * So a VERSION is the ordinal of an approval: v1 is the first revision anybody
 * approved, v2 the second, and an automation nobody has approved has **no
 * version at all**. Editing cannot move it, because editing does not approve
 * anything.
 *
 * ⚠ **Two numbers now exist for one automation, and the UI must show only this
 * one.** `revision` still travels on the wire, in Kestra's `foundry_revision`
 * label and in `flow_executions.flow_revision`, because that is what an
 * approval binds to (§6.5 — the binding is what stops approve-once being a
 * blank cheque) and what a replay re-runs. It is an ENGINE identifier. Putting
 * it on screen is what produced the original complaint. This is the same hazard
 * `flowId` already carries — the Kestra slug and the Foundry uuid under one
 * name (I-23) — so it is named rather than left to be inferred.
 */
export type FlowVersion = {
  /** 1-based, in approval order. What a person calls "v2". */
  version: number;
  /** The engine identifier this version approved. NOT shown to a person. */
  revision: number;
  approvedAt: string | null;
  approvedBy: string | null;
  note: string | null;
  /** Set once superseded or revoked — a version leaves service, it is never deleted. */
  revokedAt: string | null;
  staleReason: string | null;
};

export type FlowRevisionSummary = {
  revision: number;
  createdBy: string | null;
  createdAt: string | null;
  stepCount: number;
  /** Reuse of `structure_hash`: two revisions sharing it differ only in a fragment body. */
  structureHash: string;
};

/**
 * One value the flow expects when it runs, as the model declares it.
 *
 * ⚠ `defaults` present means a value HAS been decided — by a person, at the
 * canvas or through the confirmation panel. A drafted default is stripped
 * server-side and carried as a suggestion instead (platform-coherence Phase 4,
 * I-107), because a model's guess reaching the compiled YAML is what made a
 * scheduled run use `period="2023-10"` for ever.
 */
export type FlowInputDecl = {
  /** Slug-shaped, because expressions read it (`{{ inputs.as_of }}`). Not a label. */
  id: string;
  /** `STRING` | `INT` | `FLOAT` | `BOOLEAN` | `DATE` | `DATETIME`. */
  type: string;
  defaults?: string;
  required?: boolean;
  /**
   * What a PERSON is asked for, and one sentence on what to enter.
   *
   * ⚠ **Both optional, and the fallback is deliberate.** Every flow authored
   * before 2026-09-04 has neither, and their forms must keep working — so an
   * absent `label` falls back to a humanised `id` and an absent `description`
   * renders nothing rather than a placeholder sentence nobody wrote.
   *
   * ⚠ The reason they exist: the test drawer rendered `id` verbatim, so a
   * non-technical person was shown a box called `as_of` hinted "Defaults to
   * 2026-09-04T11:21:39.237Z" — an identifier and a machine timestamp, with
   * nothing saying what to type. There was no field for the answer.
   */
  label?: string;
  description?: string;
  /**
   * The server-derived control for this input (`GET …/flows/:id` `inputFormats`).
   * Absent until the detail carries it — `formatFor` falls back to `type`.
   */
  format?: FlowInputFormat;
  /**
   * A value derived from the run's firing time, resolved by the engine at run
   * creation. Counts as answered everywhere `defaults` does (`unresolvedInputs`,
   * the run sheet, the test drawer) — a blank box with `computed` is correct.
   */
  computed?: ComputedInputFn;
};

/** One step of a drafted flow, as the review surface shows it. */
export type FlowStepReview = {
  stepId: string;
  kind: string;
  ordinal: number;
  ref: string | null;
  dependsOn: string[];
  /** True only for `code` steps — the only ones a model wrote the body of. */
  generated: boolean;
  contract: {
    purpose?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  } | null;
  codeLines: number | null;
  retry: { maxAttempts?: number; backoff?: string; intervalSeconds?: number } | null;
  awaitSeconds: number | null;
  /**
   * The step's `paramsExpr`, as stored. ⚠ Carried so the CANVAS can say whether
   * the call is made once or once per row — `lib/step-shape.ts`'s `fanOutOver`
   * reads it. The inspector has always let a person CHOOSE fan-out and nothing
   * has ever stated the consequence, so "one email per employee" and "one email"
   * looked identical on the picture. Null for a kind that takes no params.
   */
  paramsExpr: string | null;
  /** The branch this one continues — `if` → `elif` → `else`. Null on every other kind. */
  elseOf?: string | null;
  /** A branch's guard. Null on a terminal `else`, and on every other kind. */
  conditionExpr?: string | null;
  /**
   * A `merge`'s inputs, in priority order. Null on every other kind.
   *
   * ⚠ **Carried because a merge's links live NOWHERE ELSE.** Every other kind
   * declares its topology in `dependsOn`, which the canvas draws; a merge
   * declares it here, and the projection dropped it — so `outcome` and its
   * whole tail rendered as an island with no incoming edge, in every flow that
   * has one. That is `elseOf`'s defect repeated one kind later, and the same
   * `configJson` has carried the field all along.
   */
  sources?: string[] | null;
};

/** What changed between the armed revision and the one being reviewed (§6.5). */
export type FlowDiff = {
  from: number | null;
  to: number;
  added: string[];
  removed: string[];
  changed: string[];
  structureChanged: boolean;
  requires: "human_reapproval" | "automated_retest";
};

/** Everything the per-automation detail page shows: the generated code and
    requirements, the self-test detail, and the run status — mapped from the

/** The kinds of data source the platform can onboard (Compiler spec). */
export type DataSourceKind = "postgres" | "mysql" | "oracle" | "sqlserver" | "mongo" | "s3" | "ftp" | "excel" | "csv";

// ---- Data-plane onboarding model (Data Sources + Virtual Tables) -------------
// Mirrors the Data_Source_Onboarding backend (/api/v1/*). These drive the real
// connector marketplace, connections, discovered assets, and virtual tables.

/** Connector marketplace category (backend Category enum). */
export type ConnectorCategory = "StructuredData" | "NoSQL" | "DataLake" | "MCP" | "SaaS";

/**
 * A datasource's connection health, as the server last observed it.
 *
 * `untested` is a real state and NOT a synonym for `pending`: the server sets
 * `test_status = NULL` whenever the connection string changes, and nothing tests
 * it again until somebody asks. Rendering that as "Queued" — which is what
 * `pending` used to cover — claimed work was in progress that nothing would ever
 * perform, and the page polled forever waiting for it.
 *
 * `pending` / `discovering` are kept for a server that reports an in-flight
 * test; only those two justify polling.
 */
export type ConnectionStatus = "untested" | "pending" | "discovering" | "ready" | "error";

/**
 * Whether a connection's DSN is referenced by a declared name, or only stored.
 *
 * ⚠ **This said `"direct" | "vault"` and the second value was a trap** (D-117,
 * I-122). It is derived from `secretEnvName` — *"this data source declares an
 * env-var name, which the manifest renders as `<secretRef>` and `/keys` audits"* —
 * and had nothing to do with the wizard's (now refused) "fetch the secret from a
 * vault" mode. But `/keys` passed it in as that form's `initialMode`, so declaring
 * a name reopened the sign-in form in the one mode that could only assemble a
 * password-less DSN.
 *
 * Renamed rather than commented, because a comment does not stop the next reader
 * joining the two: one word meaning two things was the whole mechanism of the
 * defect. `VaultProvider` went with it — the three providers it named are refused,
 * and a type enumerating them is a capability that reads as pending.
 */
export type CredentialSource = "direct" | "secret_ref";

/** A minimal JSON-Schema fragment — drives the connector onboarding form (auth/advanced). */
export type JsonSchemaProp = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  format?: string; // "password" | "data-url" mark secret fields
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
};
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
};

/** A connector type in the marketplace (backend `manifest.model_dump()`). */
export type ConnectorManifest = {
  id: string;
  display_name: string;
  description: string;
  icon?: string;
  category: ConnectorCategory;
  version?: string;
  auth_type: string;
  capabilities: string[];
  execution_engine: string; // trino | native | object_store | rest | mcp
  discovery_method: string;
  health_check?: { type: string; target: string } | null;
  onboarding_schema: { auth?: JsonSchema; advanced?: JsonSchema };
  trino?: { connector_name: string; template: string } | null;
};

/** A registered data source (a "connection"). Never carries secrets. */
export type Connection = {
  id: string;
  name: string;
  description?: string;
  connector_id: string;
  category: ConnectorCategory;
  status: ConnectionStatus;
  error_message?: string | null;
  credential_source: CredentialSource;
  /**
   * Paused — **hidden from everything the model is shown**, and running
   * automations untouched.
   *
   * A paused data source is left out of the workspace manifest, out of the
   * CALLABLE STEPS catalogue the designer and every chat turn are given, and
   * out of the "no reader yet" offer. It is NOT removed from what an existing
   * flow may reference and NOT removed from what a running step may read — so
   * pausing never suspends an armed automation, and never stops one mid-flight.
   * That is the difference between this and Remove, and it is why both exist.
   */
  paused_from_model?: boolean;
  config?: Record<string, unknown> | null; // non-secret connector config (host/port/bucket) — never secrets
  // ⚠ `vault_config` WAS HERE and is gone with vault mode (D-117). No server route
  // ever returned it, so it was a field that could only ever be `undefined` —
  // scenery describing a store the product does not read from.
  created_at?: string;
  updated_at?: string;
  /**
   * When the server last actually opened this connection. Real, not a guess — the
   * detail page shows it so "Connected" carries a date rather than a vibe.
   */
  last_tested_at?: string | null;
  /**
   * The env-var name this data source's connection string is exposed under.
   *
   * Worth surfacing because it is the SAME identifier a flow's `datasource` step
   * references and the manifest renders — and because `GET /secrets/audit` reports
   * it under `configured` even though it has no `workspace_secrets` row. Without it
   * on screen, the audit naming a credential the secrets list does not contain reads
   * as a bug rather than as two stores.
   */
  secret_env_name?: string | null;
  /** The owner's column declarations, `[schema.]table.column` → tag. */
  column_tags?: Record<string, string>;
};

/** A discovered metadata asset (recursive tree). */
export type AssetType =
  | "db_schema" | "table" | "column" | "bucket" | "object"
  | "mcp_tool" | "mcp_prompt" | "mcp_resource" | "rest_resource" | "saas_object";
export type AssetNode = {
  asset_id?: string; // sample endpoint addresses a table by id; read defensively
  id?: string;
  asset_type: AssetType;
  name: string;
  attributes?: Record<string, unknown>; // columns carry { type, nullable }
  children?: AssetNode[];
};

/**
 * Result of a real connection test, performed by the server against a registered
 * data source.
 *
 * `latency_ms` was removed with the fake pre-create check: the only value it ever
 * carried was a hardcoded 24, printed next to "Connection looks reachable." for a
 * connection nothing had opened.
 */
export type TestResult = { ok: boolean; message: string };

/** A registered data source on "Data sources". Its ETL layer produces Virtual Tables. */
export type DataSource = {
  id: string;
  workspaceId?: string;
  name: string;
  kind: DataSourceKind;
  detail: string; // host:port/db, bucket, path… shown in plain words
  tables: number; // discovered / virtual tables count
  status: Status;
  statusText: string;
  lastChecked: string;
};

// ---- Run artifacts and the build UI's result contract ------------------------

/** An artifact produced by a run (a generated script, an output file). */
export type RunArtifact = { path: string; language?: string; bytes?: number };

/** One adversarial test case the external facility ran (from contract.build.tester.cases). */
export type BuildCase = {
  id?: string; category?: string; severity?: string; passed?: boolean | null;
  input?: string; expected?: string; actual?: string; note?: string;
};
/** One security finding the facility flagged (contract.build.tester.security). */
export type BuildSecurityFinding = {
  id?: string; title?: string; severity?: string; location?: string; recommendation?: string;
};

/** The typed result contract of a run, mapped for the build UI.
    `status` drives the test gate; `script` is the fetched primaryArtifact content;

/** The tenant identity returned by GET /api/auth/whoami — the "test connection" surface. */
export type WhoAmI = {
  success?: boolean;
  role?: string;
  tenantId?: string | null;
  tenantName?: string | null;
  email?: string | null;
  devMode?: boolean;
  isSuperadmin?: boolean;
  isAdmin?: boolean;
};

// ---- Design-time plans (the create-automation flow) --------------------------

/** One step of a generated plan. Steps are a sequence; a "condition" step forks
    the sequence into labeled paths that merge again after it — together they form

/** One step of a finished run — the plain-English record History drills into. */
export type RunStep = {
  title: string;
  outcome: "done" | "stopped" | "skipped" | "running";
  note?: string; // what the step produced, or why it stopped/was skipped
  durationLabel?: string; // per-step time, e.g. "0.6s"; "—" when it never ran, "skipped" when skipped
};

/** A run row on "History". Prose fields (`when`, `timeTaken`) stay for the list;
    the machine fields under them are what the dashboard aggregates. */
export type Run = {
  id: string;
  when: string;
  automation: string;
  /** Foundry's flow uuid — the "Workflow ID" column. `null` for an orphaned
      run (flow deleted) predating the id snapshot, or a script-kind run. */
  flowId?: string | null;
  /** The flow's id AT run-start time — see `runWorkflowId`. Preferred over
      `flowId` for display; survives the flow's later deletion. */
  flowIdSnapshot?: string | null;
  /** The Pi builder's automatic test after a build turn — not a run a person started. */
  autoTest?: boolean;
  /**
   * Settled outcome, or `running` while the run is still in flight.
   *
   * The third value is not cosmetic. This was `"done" | "stopped"`, so anything
   * not yet finished was reported as STOPPED: the dashboard counted live runs as
   * failures, the trend chart drew them as red bars, and History offered
   * "Fix & retry" on a run that was still working. It is invisible when every run
   * takes ~1s and permanent the moment a step takes minutes.
   * Aggregates in `lib/stats.ts` therefore divide by SETTLED runs, not by all of
   * them.
   */
  outcome: "done" | "stopped" | "running";
  text: string; // plain-English sentence
  timeTaken: string;
  action: "Details" | "Fix & retry";
  startedAt?: string; // ISO timestamp
  durationMs?: number;
  steps?: RunStep[]; // step-by-step record
  error?: string; // plain words on what went wrong (stopped runs)
  workspaceId?: string;
  /** Which backend produced this row. `flow` rows have a step graph at /runs/<id>;
      `script` rows are the pre-migration monolithic executions being deleted in Phase 4. */
  kind?: "script" | "flow";
};

// ---- Organization → Workspace hierarchy --------------------------------------
// The tenancy model. Resources carry an optional workspaceId: mock seeds are all
// tagged; rows from a backend that doesn't know workspaces yet show everywhere.

/**
 * A team boundary. Every resource lives in exactly one.
 *
 * `Organization`, `OrgRole`, `Membership`, and this type's own `orgId` and
 * `archived` were removed with the localStorage mock: the server has no
 * organization or membership model, so those could only ever be invented.
 * `archived` was the worst of them — it hid a row in the browser while the
 * workspace stayed fully live, schedules armed and triggers firing.
 */
/**
 * A restricted workspace the person is OUTSIDE of, as the platform tier sees it: its name, its admins, nothing else.
 * Never a `Workspace` — it cannot be switched to, and nothing inside it can be read.
 */
export type ClosedWorkspace = { id: string; name: string; admins: string[] };

/** A super admin's emergency access to a restricted workspace. */
export type EmergencyAccess = {
  id: string;
  workspaceId: string;
  subject: string;
  email: string | null;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: string | null;
  open: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  /** What it holds — present only when asked for (`listWorkspaces({ counts: true })`). */
  counts?: { workflows: number; live: number; datasources: number; members: number; lastRunAt: string | null };
  purpose?: string; // one plain line on what this team automates
  /** Assistant mode: Forge does everyday tasks here too, and answers from the real data, read-only. */
  assistant?: boolean;
  /** Forge Agent may propose changes to connected services, each done only by the person's own click. */
  agentChanges?: boolean;
  /** Members may switch on their own automations that use only their own things (plugins phase 9). On by default. */
  selfEnable?: boolean;
  /** Workflows and Forge may read public web addresses (`web_fetch`). On by default. */
  webAccess?: boolean;
  /** Restricted: closed to everyone its own admins did not add, platform and super admins included. */
  restricted?: boolean;
  /**
   * `"fixture"` for a workspace that exists to serve a harness rather than a
   * team — today that is `HR (alt — swap rehearsal)`, which `demo:rehearse`
   * requires and which must not be deleted.
   *
   * Shown with a badge rather than hidden. A hidden workspace is one nobody
   * notices has broken, and its tools are scenery: they point at the same
   * ops-api endpoints as HR's, so the `hr_*` ones read `hr_demo` and disagree
   * with that workspace's own datasource about who exists.
   */
  kind?: string | null;
};

/**
 * A stored credential, described by PRESENCE rather than content.
 *
 * There is deliberately no field carrying a value and no endpoint that returns
 * one. `name` is the env-var name, which is also the identifier the manifest
 * renders — one identifier, so the manifest, the prompt, the `-e` flag and the row
 * cannot disagree.
 */
export type WorkspaceSecret = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  hasValue: boolean;
  /**
   * A throwaway credential used at generation time, so a production key need not
   * enter a generation-time workspace. Caveat: with one set, a passing connectivity check
   * does not prove PRODUCTION connectivity.
   */
  hasSandboxValue: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---- Credentials (Phase 5, D-01) -------------------------------------------
//
// The unified surface: one list, one search, one modal across every store the
// vault-relay seam can describe. `WorkspaceSecret` above remains the SECRET
// store's own shape; `CredentialView` is the seam's READ model — presence only,
// and the same rule applies to it: no value ever returns, `hasValue` does.

/** The seven kinds the seam knows. `generic` is what a legacy secret (stored
 * before the `kind` column existed) renders as. */
export type CredentialKind = "tool" | "database" | "webhook" | "api" | "llm" | "generic";

/**
 * One credential in the unified list. Described by PRESENCE, never content.
 *
 * `ref` is the stable identifier — the env-var name for secrets, the datasource
 * name for a DSN, the trigger name for webhook/api. `lastUsedAt` is an ISO
 * string; absent/undefined when never used.
 */
export type CredentialView = {
  kind: CredentialKind;
  ref: string;
  label?: string;
  hasValue: boolean;
  lastUsedAt?: string | null;
};

/**
 * Something that reads a secret BY NAME, and therefore breaks when the name moves.
 *
 * ⚠ A data source is deliberately not one of these. It declares an env-var name
 * too, but its value is its own encrypted connection string — nothing looks that
 * name up in the secret store. A data source sharing a name is a COLLISION,
 * which refuses the execution with a 409. These are the SILENT ones.
 */
export type SecretReference = {
  kind: "tool";
  label: string;
  /** What actually happens when the name stops resolving. Not "may be affected". */
  breaks: string;
};

/**
 * What renaming a secret would break — asked before the write, because it cannot
 * be seen after.
 *
 * ⚠ There is no `willSuspendFlows` here and there must not be, however closely
 * this mirrors the named-query impact (D-84). Editing a named query moves a ref
 * fingerprint, so the sweep unarms the flows using it and they STOP. Renaming a
 * secret moves no fingerprint: every armed flow stays armed, keeps running, and
 * signs in with nothing.
 */
export type SecretImpact = {
  name: string;
  newName: string | null;
  references: SecretReference[];
  /** Another SECRET holds the new name — refused. */
  nameTaken: boolean;
  /** A DATA SOURCE declares it — reported, not refused: a collision is loud. */
  collidesWithDatasource: string | null;
  /** References the new name would START satisfying — the rename is the fix. */
  adopts: SecretReference[];
  orphanWarning: string | null;
};

/** What a completed rename just orphaned. Null on every edit that kept the name. */
export type SecretRename = {
  from: string;
  to: string;
  orphaned: SecretReference[];
};

/** Something that references a secret name with nothing stored under it. */
export type MissingSecret = {
  envName: string;
  /** `tool "Send email"` — the words the server already uses. */
  neededBy: string;
};

/** `GET /secrets/audit` — the answer to "why did my tool call 401?". */
export type SecretAudit = {
  /**
   * ⚠ Stored **and referenced**, not stored (`issues.md` I-96). Computed from
   * declarations, so a secret nothing references is in neither this list nor
   * `missing`. `listSecrets()` is what enumerates everything stored.
   */
  configured: string[];
  /**
   * Referenced by a tool or datasource, with nothing stored.
   *
   * ⚠ **An object per entry, not a string** (`issues.md` I-97). It was typed
   * `string[]` here from the day it was written, and `/keys` rendered it with
   * `.join(", ")` — so the banner counted correctly and then printed
   * `[object Object]` where the names belonged. The same defect as I-92, in a
   * second place, and the fix is the same: type it as the server sends it.
   */
  missing: MissingSecret[];
  /**
   * One env-var name claimed by two secrets — a 409 at execution rather than
   * last-write-wins, so a shadowed credential presents as a wrong key instead of a
   * silent misconfiguration. Two tools sharing one secret is not a collision.
   */
  collisions: string[];
};

// ---- Flow executions (Kestra migration, Phase 2) ----------------------------
// archive/kestra-migration/progress/phase-2.md
//
// The UI-side shape of a run. It replaces the "one script, one stdout, one exit
// code" model with "a flow of declared steps, each with its own record" — which
// is the entire point of the migration, expressed as a type.
//
// Assembled SERVER-side by `services/flow-visibility.service.ts` and delivered
// already redacted. Two things follow from that and are easy to undo by
// accident:
//
//   * There is no Kestra execution id here. Clients never address Kestra (R5).
//   * `output` has already had credentials removed, including the execution
//     token in the `begin` step's body (DECISIONS.md D-07). Do not add a path
//     that fetches a raw execution to "get the full output".

/** A step's state. `running` is also what an unrecognised engine state maps to — never `success`. */
export type StepStatus =
  | "created"
  | "running"
  | "paused"
  | "success"
  | "warning"
  | "failed"
  | "cancelled"
  | "skipped";

export type StepLog = { timestamp: string; level: string; message: string };

/** One step of one execution. `stepId` is stable across executions, so it addresses the STEP. */
export type StepRun = {
  stepId: string;
  status: StepStatus;
  /**
   * `tool` / `datasource` / `code` … — the kind the flow DECLARED, joined
   * server-side from the execution's own revision. Null only for a task the
   * model never declared; see `platform`.
   */
  kind: string | null;
  /**
   * A task the compiler emitted rather than a step anybody wrote — `begin`,
   * `complete`, and a pausing step's `_await` task.
   *
   * ⚠ Drawn, never hidden: `begin` is where the approval gate and the budget
   * check happen, so a run that failed there failed for the most interesting
   * reason there is. What this buys is that the picture can say which four of a
   * six-task run belong to the two steps the person wrote.
   */
  platform: boolean;
  /**
   * The tool or named query this step calls, joined server-side from the revision
   * the execution actually ran. `null` when unknown — which the seam rule treats
   * as "cannot tell", never as "safe". See `lib/canvas-model.ts`.
   */
  ref: string | null;
  /**
   * `"sandbox"` | `"production"` | null — which database a `datasource` step
   * actually read (Stage 4). Null for every other kind and for history from
   * before the sandbox existed.
   *
   * ⚠ `"production"` on a DRAFT run is the interesting value, not the alarming
   * one to hide: it means a test run just read the tenant's real data, and if
   * anything downstream is an `llm_complete` those rows left the
   * building. Rendered on the step, never inferred from configuration.
   */
  readFrom: "sandbox" | "production" | null;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  request: { uri: string; method: string } | null;
  responseCode: number | null;
  output: Record<string, unknown> | null;
  /**
   * What the step was GIVEN — `{params, inputs}` after binding, redacted server-side. Runner (Pi-built) runs only;
   * absent on an engine run, whose task inputs are not retained.
   */
  input?: { params?: Record<string, unknown>; inputs?: Record<string, unknown> } | null;
  /** What the step returned, checked against what it declared. Runner runs only. */
  checks?: StepCheck[] | null;
  /** The runner's own word for how the step ended — finer than `status` (not_taken, waiting, partial, rejected…). */
  outcome?: string | null;
  /** Why it did not run: the other side of a choice, an earlier failure, a rejected approval. */
  reason?: string | null;
  /** The reason a step failed. The field the whole step-detail panel exists to show. */
  error: string | null;
  logs: StepLog[];
  kestraTaskrunId: string | null;
  auditVerdict: string | null;
  oracleScore: number | null;
  /**
   * For each (phase F, D-367): on a LOOP's step, one entry per item in input order — its status, the steps it ran, the first
   * error, its result. On a step inside a loop, `perItem` counts the items and `loop` names the loop; its `output` is null
   * there (one item's output is not the step's). Folded server-side; absent on every other step.
   */
  items?: LoopItem[];
  perItem?: { ran: number; succeeded: number; failed: number };
  loop?: string;
};
export type LoopItem = { i: number; status: StepStatus; path: string[]; error: string | null; result: unknown };

/** Flow topology, from the engine — not inferred from step order. */
export type StepGraphShape = {
  nodes: Array<{ id: string; type: string | null }>;
  edges: Array<{ source: string; target: string }>;
};

/** One output check the runner made on a step's result (flow-runner checks.py) — names and counts, never a value. */
export type StepCheck = {
  output: string;
  field?: string;
  rows?: number | null;
  empty?: number;
  verdict: "ok" | "partial" | "allowed" | "failed";
  reason?: string;
};

export type FlowExecutionSummary = {
  id: string;
  workspaceId: string;
  /**
   * FOUNDRY's flow uuid — an identifier, and the same one `/flows/:flowId` takes.
   * Null when the flow has been deleted or the run predates the `flows` table.
   *
   * ⚠ Not a label. It used to be the Kestra slug (I-23), which read fine as one
   * and was unusable as an id; `flowName` is the label now, and printing this
   * would put a uuid where a name used to be.
   */
  flowId: string | null;
  /** The flow's slug — the run's human-readable name, and all an orphaned run has. */
  flowName: string | null;
  /**
   * The flow's `name` as it was when THIS run began — preferred over `flowName`
   * for display when present (see `runLabel`). Null for a run predating this
   * field, which falls back to `flowName` exactly as it did before.
   */
  flowNameSnapshot: string | null;
  /**
   * The flow's `id` as it was when THIS run began — preferred over the live
   * `flowId` for display when present (see `runWorkflowId`). Null for a run
   * predating this field, which falls back to `flowId`.
   */
  flowIdSnapshot: string | null;
  /** Foundry's record. Lags on failure: `complete` is a task, so a failed run never sets it. */
  status: string;
  /** The engine's live state. `null` when Kestra could not be asked. */
  engineStatus: StepStatus | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputs: Record<string, unknown>;
  /**
   * The run this one replayed, and the step it resumed from (phase 6.1). Null for
   * an ordinary run.
   *
   * A FOUNDRY id, so it is a link. Kept on the summary rather than the detail
   * because history is where the misreading happens: two `succeeded` rows with
   * no link between them read as two working runs.
   */
  replayOfId: string | null;
  replayFromStep: string | null;
  /** The Pi builder's automatic test after a build turn — not a run a person started. */
  autoTest?: boolean;
};

export type FlowExecutionDetail = FlowExecutionSummary & {
  engineStatus: StepStatus;
  steps: StepRun[];
  graph: StepGraphShape | null;
  /** Set when the engine could not be reached; the Foundry-side fields are still real. */
  engineUnavailable?: string;
  /** A draft run started with the admin production opt-in: its reads used production, not test data. */
  usedProductionData?: boolean;
  /** It used another person's own account: what it did is theirs and an Admin's to see (sharing-boundaries D4). */
  dataHidden?: boolean;
  /**
   * What the flow CLAIMED about its own output, and whether this run bore it out
   * (GAPS §2.3). Empty for a flow that declares nothing, which is most of them.
   */
  expectations: ExpectationVerdict[];
  /**
   * Steps that succeeded and produced NO rows (compiled-builder I-301 C) — computed by the server from the redacted view. Not a
   * failure: an empty answer can be right. Absent from an older server.
   */
  noRows?: Array<{ stepId: string; note: string }>;
  /** Phase 5: shared with you read-only. */
  sharedWithMe?: boolean;
  /** Phase 5: you may share this run with People. */
  canShare?: boolean;
};

// ── Expectations — GAPS §2.3 ─────────────────────────────────────────────────

/**
 * ⚠ Three states, and the third is the one a UI must not round off.
 * `unevaluable` means nobody checked — a step whose output could not be read as
 * rows. Drawing it as a tick is a claim that held; drawing it as a cross blames
 * the flow for the checker's own inability to read it. It gets its own mark.
 */
export type ExpectationStatus = "passed" | "failed" | "unevaluable";

export interface ExpectationVerdict {
  expectationId: string;
  stepId: string;
  status: ExpectationStatus;
  /** Populated on a pass as well as a failure — a verdict with no values is unfalsifiable. */
  detail: string;
  observed: unknown;
}

/** Every comparison the vocabulary can make. Mirrors `EXPECT_OPS` server-side. */
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

/**
 * One claim, as it sits on the flow model.
 *
 * ⚠ Declarative, with no escape hatch, and the client must not grow one. The
 * whole reason this is safe to expose is that it cannot express computation —
 * same argument as D-50 for the expression inspector.
 */
export interface FlowExpectation {
  id: string;
  stepId: string;
  /** A single top-level key on the step's output. Never a path. */
  select?: string;
  description?: string;
  assert: ExpectationAssert;
}

/**
 * Workspace membership — GAPS §1.1.
 *
 * ⚠ A role says what someone may DO here; it is not proof of who they are.
 * Anything holding the deployment's identity signing secret can present any
 * identity, so a role reads as "granted access", never as "verified person".
 */
export type WorkspaceRole = "viewer" | "author" | "approver" | "admin";

export interface WorkspaceMember {
  id: string;
  /** The identity token's `sub` — what membership is keyed on. Emails move. */
  subject: string;
  email: string;
  role: WorkspaceRole;
  /** Who granted it; the literal `bootstrap` for the workspace's first member. */
  grantedBy: string;
}

/**
 * Who I am, and what this deployment lets me do — `GET /api/me`.
 *
 * ⚠ Read `FAMe`'s docblock in `foundry-client.ts` before using this: it is the
 * ONLY source of "am I a super admin" in the client, and `session.user.roles`
 * (which `auth.ts` populates from a local password check) must never stand in
 * for it.
 */
export interface Me {
  subject: string;
  email: string;
  name?: string;
  superAdmin: boolean;
  /** Whether any super admin exists on this deployment — never who. */
  superAdminConfigured: boolean;
  /** Workspace-scoped permissions when `?workspaceId` was sent. */
  capabilities?: string[];
  /** Platform roles this person holds. Keyed on the person, so always answered. */
  platformRoles?: string[];
  /** Platform permissions this person holds. */
  platformPermissions?: string[];
  /** The mode this person's new Forge chats open in; Workflow Builder until they choose. */
  forgeDefaultMode?: "workflow" | "agent";
  /** Whether the cost report is theirs to open (an Admin of some workspace, or a super admin). Absent reads as "no". */
  canViewReports?: boolean;
  /** May manage who can sign in. The server decides; absent reads as "no". */
  userAdmin?: boolean;
}

/** A permission string from the server's catalogue. Never invented client-side. */
export type Permission = string;

/** Where a permission came from. `via: "platform"` is the D-9 conferral. */
export type PermissionProvenance =
  | { via: "superadmin" }
  | { via: "preset"; role: string }
  | { via: "role"; roleId: string; roleName: string }
  | { via: "grant" }
  | { via: "platform"; role: string; permission: string };

/**
 * The server's answer to "what may I do here", from
 * `GET /api/workspaces/:ws/me/permissions`.
 *
 * ⚠ **This is the ONLY thing the browser may consult about its own access.** There is no
 * client-side policy table: `lib/capabilities.ts` used to be one, it disagreed with the
 * server about whether an approver may publish, and it is deleted.
 */
export interface MyPermissions {
  workspaceId: string;
  permissions: Permission[];
  provenance: Record<string, PermissionProvenance[]>;
  memberRole: string | null;
  superAdmin: boolean;
  platformRoles: string[];
  platformPermissions: string[];
}

/** One entry in the server's permission catalogue. */
export interface PermissionCatalogueEntry {
  key: Permission;
  tier: "workspace" | "platform";
  label: string;
  description: string;
}

export interface PermissionCatalogue {
  permissions: PermissionCatalogueEntry[];
  presets: Array<{ name: string; permissions: Permission[] }>;
  /** Which workspace permissions a platform permission confers, in every workspace. */
  platformConfers: Record<string, Permission[]>;
  conferrable: Permission[];
}

/** A custom workspace role, or a built-in preset rendered beside them. */
export interface WorkspaceRoleSummary {
  id: string | null;
  name: string;
  description: string | null;
  permissions: Permission[];
  builtin: boolean;
  retiredAt: string | null;
  assignees: number;
}

/** A deployment-level role. */
export interface PlatformRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  builtin: boolean;
}

/**
 * An identity this API has seen. **Not an account, not a verified person** —
 * see `FAPlatformUser`.
 */
export interface PlatformUser {
  subject: string;
  email: string;
  name: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

// ── Operational signals — GAPS §6.1b ─────────────────────────────────────────

/**
 * ⚠ `unknown` is not a soft `ok`. It means a signal had nothing to go on, and it
 * ranks BELOW `warn` server-side so it cannot shout over a real warning — a UI
 * that draws it as a pass undoes that.
 */
export type SignalState = "ok" | "warn" | "alarm" | "unknown";

export interface OperationalSignal {
  name: string;
  state: SignalState;
  detail: string;
  /** What this signal CANNOT see. Never omitted, and never dropped on the way to a screen. */
  caveat: string;
  facts?: Record<string, unknown>;
}

export interface SignalsReport {
  state: SignalState;
  checkedAt: string;
  signals: OperationalSignal[];
}

// ---- The engine's plugin registry (ui-upgrade Phase 9, D-111) ---------------
//
// What the execution engine can do, read FROM the engine. ⚠ Instance-wide, not
// per workspace: plugins are a property of the engine's build, and Kestra has no
// per-tenant plugin endpoint at all.

/** One class a plugin supplies — a task, trigger, condition, runner or storage. */
export type PluginClass = {
  cls: string;
  /** The last segment. What a person reads. */
  simpleName: string;
  kind: "task" | "trigger" | "condition" | "taskRunner" | "storage" | "other";
  title: string | null;
  deprecated: boolean;
  /**
   * ⚠ Whether an automation in this product can actually use it.
   *
   * The engine registering a class and Foundry being able to emit it are
   * DIFFERENT FACTS. Foundry's compiler is the only thing that writes flow
   * definitions and it emits seven of the sixty-odd classes registered here;
   * a page that showed them all as capabilities would be listing things nobody
   * can ask for.
   */
  reachable: boolean;
};

export type Plugin = {
  name: string;
  group: string | null;
  title: string | null;
  description: string | null;
  /** Null for `core`, which ships with the engine and has no version of its own. */
  version: string | null;
  categories: string[];
  /**
   * The plugin's logo, base64 SVG, straight from the engine — null when it has
   * none. ⚠ **Decorative only.** Every claim the gallery makes is carried by
   * text beside the mark, because a card whose meaning depends on recognising a
   * logo is one a screen reader cannot read.
   */
  icon: string | null;
  classes: PluginClass[];
  counts: {
    total: number;
    reachable: number;
    tasks: number;
    triggers: number;
    conditions: number;
    taskRunners: number;
    other: number;
  };
};

/**
 * What one plugin needs in order to authenticate — read from the engine, never
 * a list maintained in this repo.
 *
 * ⚠ **`usableToday` is the field that must never be dropped from a render.** It
 * is `false` for every non-core plugin on this engine, because Foundry's
 * compiler is the sole YAML emitter (R8) and emits seven class types, none of
 * them from a plugin. A credentials form with that fact removed is a form whose
 * whole appearance promises that filling it in makes something work.
 */
export type PluginCredentialField = {
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
};

export type PluginCredentials = {
  plugin: string;
  /** False when the engine could not be read — never a silently empty field list. */
  reachable: boolean;
  fields: PluginCredentialField[];
  /** How many classes were read, and out of how many. Both, so a bound is never silent. */
  classesRead: number;
  classesTotal: number;
  usableToday: boolean;
  notes: string[];
  detail?: string;
};

export type EnginePlugins = {
  /** ⚠ False when the engine could not be read — never a silently empty list. */
  reachable: boolean;
  engine: { version: string | null; edition: string | null };
  plugins: Plugin[];
  foundryEmits: string[];
  totals: { plugins: number; classes: number; reachable: number };
  /** Why the numbers are what they are. Render them; do not paraphrase. */
  notes: string[];
  /** The transport diagnosis when `reachable` is false. Not "no data". */
  detail?: string;
};

/**
 * One message Foundry itself handled — `tether_email_send` → `/api/mail/send`.
 *
 * ⚠ `outcome` has FOUR values and only `sent` is a delivery. `captured` means
 * the run was a draft (test) run, so Foundry deliberately did not contact the
 * mail provider: the message is complete and addressed and nothing was
 * delivered. Any UI that means "a person received this" must test `delivered`,
 * which is `outcome === "sent"` computed server-side — never `outcome !==
 * "failed"`, which counts a held message as a delivered one.
 */
export interface EmailBoxMessage {
  id: string;
  subject: string | null;
  recipients: string[];
  cc: string[];
  resolvedFrom: string | null;
  outcome: "sent" | "refused" | "failed" | "captured";
  delivered: boolean;
  failureReason: string | null;
  /** Present ONLY for `captured`. A real send stores no body. */
  body: string | null;
  flowExecutionId: string | null;
  /**
   * The workflow that sent it. `flowId` is the LIVE workflow and is null once it is deleted; `flowName` outlives it
   * (the run's own snapshot). Both null: no run behind the message. Older servers omit both.
   */
  flowId?: string | null;
  flowName?: string | null;
  stepId: string | null;
  at: string | null;
  /** The files the message carried. Older servers may omit it entirely. */
  attachments?: EmailBoxAttachment[];
}

/**
 * One file a message carried. A held (draft-run) message keeps its content, so
 * the client can offer it back for download; a delivered one lists the name and
 * size only — `contentType`/`content` are null and say so on screen rather than
 * offering a button with nothing behind it.
 *
 * ⚠ `encoding` absent or `"text"` means `content` is the file's own text;
 * `"base64"` means it is base64-encoded binary (the generated `.xlsx`), and a
 * client that writes it to a Blob un-decoded hands back garbage.
 */
export interface EmailBoxAttachment {
  name: string;
  bytes: number;
  /** Its place in the message (two files may share a name). */
  position: number;
  /** True when a file is behind the name: only a held (captured) message keeps its files. */
  held: boolean;
  contentType: string | null;
  /** Where the held file is opened (download, `?inline=1`, `?preview=1`) — set by `getEmailBox`; null when not held. */
  href?: string | null;
}

export interface EmailBox {
  workspaceId: string;
  foundry: EmailBoxMessage[];
  notes: Record<string, string>;
}

/**
 * A local account — a username and password for a person with no AD identity.
 *
 * ⚠ A re-export of the wire shape rather than a second definition: there is
 * nothing to adapt, and a parallel type here is how a field comes to mean two
 * things. No role, no super-admin flag, and no password of any kind.
 */
export type { FALocalUser as LocalUser } from "@/lib/foundry-client";
export type { FALocalUserAccess as LocalUserAccess } from "@/lib/foundry-client";

/**
 * Usage, cost and run health (pi-runtime P-OBS). Since rbac-observability (2026-10-15) every caller sees cost — for
 * what they may see: `scope` says whose ("mine", "workspace" for an Admin, "deployment" for the platform view).
 * `costVisible` stays for older servers, which left cost out for non-admins.
 */
export type UsagePurpose = "building" | "test" | "live";
export type RunHealth = { byStatus: Record<string, number>; total: number; settled: number; succeeded: number; failed: number; successRate: number | null };
export type Observability = {
  days: number;
  since: string;
  scope?: "mine" | "workspace" | "deployment";
  costVisible: boolean;
  costUsd?: number;
  byPurpose: Array<{ purpose: UsagePurpose; tokensIn: number; tokensOut: number; modelCalls: number; costUsd?: number }>;
  byDay: Array<{ day: string; purpose: UsagePurpose; tokens: number; costUsd?: number }>;
  byFlow: Array<{ flowId: string | null; flowName: string | null; purpose: UsagePurpose; tokensIn: number; tokensOut: number; costUsd?: number }>;
  byPerson: Array<{ subject?: string | null; actor: string | null; tokensIn: number; tokensOut: number; costUsd?: number }>;
  byWorkspace?: Array<{ workspaceId: string; name: string | null; tokensIn: number; tokensOut: number; costUsd?: number }>;
  /** Deployment view: restricted workspaces the reader is outside of — left out of every figure, named only. */
  restricted?: Array<{ id: string; name: string }>;
  byModel: Array<{ model: string | null; calls: number; tokensIn: number; tokensOut: number; costUsd?: number }>;
  tools: Array<{ tool: string | null; kind: "tool" | "read"; calls: number; failed: number; avgMs: number }>;
  runs: { live: RunHealth; test: RunHealth };
  runsByDay: Array<{ day: string; status: string; count: number }>;
  runsByFlow: Array<{ flowId: string | null; name: string | null; total: number; succeeded: number; failed: number; partial: number }>;
};


// ── Connectors (Activepieces pieces) — plans/plugins-2026-10-27 ─────────────────────────────────────────────────────
// ⚠ No type here has a field a connection's VALUE could travel in. A form sends one; nothing returns one.

export interface ConnectorCatalogueEntry {
  name: string;
  short: string;
  displayName: string;
  description: string;
  logoUrl: string | null;
  version: string;
  categories: string[];
  authTypes: string[];
  actions: number;
  triggers: number;
  /** The version this deployment has installed, or null. */
  installedVersion: string | null;
}
export interface ConnectorMarketplace {
  fetchedAt: string;
  /** The catalogue could not be refreshed; this is the last good copy. */
  stale: boolean;
  /** Whether the connector service answered — `installedVersion` is the record alone when it did not. */
  connectorReachable: boolean;
  entries: ConnectorCatalogueEntry[];
}
export interface ConnectorAuthField {
  name: string;
  label?: string;
  type: string;
  required: boolean;
  secret: boolean;
  description: string;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: unknown }>;
}
export interface ConnectorAuth {
  type: string;
  displayName: string | null;
  description?: string;
  required: boolean;
  checks?: boolean;
  fields?: ConnectorAuthField[];
  oauth?: { authUrl: string | null; tokenUrl: string | null; scope: string[]; grantType: string | null; pkce?: boolean };
}
/** Whether signing in is set up for a connector, and what it will ask the provider for. */
export interface ConnectorOauthStatus {
  configured: boolean;
  useSignInApp: boolean;
  scopes: string[];
  redirectUri: string;
}
/** A connector's OAuth app, as an installer sees it. ⚠ Never the client secret — only whether one is set. */
export interface ConnectorOauthApp {
  piece: string;
  configured: boolean;
  useSignInApp: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  scopes: string[];
  pieceScopes: string[];
  narrowed: boolean;
  pkce: boolean;
  redirectUri: string;
  signInAppOffered: boolean;
  newAppUrl: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}
export interface ConnectorAction {
  name: string;
  displayName: string;
  description: string;
  classification: string | null;
  writes: boolean;
  destructive: boolean;
  idempotent: boolean | null;
  params: Record<string, { type: string; required: boolean; description: string }>;
  unsupported: string[];
}
export interface ConnectorConnection {
  id: string;
  piece: string;
  label: string;
  authType: string;
  fieldNames: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /** A personal connection ("as me"): only its owner sees it, and no automation uses it. */
  personal?: boolean;
}
/** A blank in a declared API call: where it goes, its type, and (for query/body) the service's own name for it. */
export type DeclaredParam = { name: string; in: "path" | "query" | "body"; type: "string" | "number" | "boolean"; required: boolean; description: string; key?: string };
/** What a declared call does — the part its address's hash covers. */
export type Declaration = {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  query: Record<string, string | number | boolean>;
  params: DeclaredParam[];
  returns: "json" | "file";
  /** Body fields sent on every call, by place: `commits[0].changes[0].changeType` → `add`. */
  body?: Record<string, string | number | boolean>;
};
/** A connector's raw call fixed in advance (plans/declared-api-calls-2026-10-29), as this workspace has it. */
export type DeclaredCallView = { name: string; tool: string; on: boolean; displayName: string; description: string; pack: string | null; writes: boolean; declaration: Declaration };
/** A curated set of declared calls Foundry ships for a connector. */
export type DeclaredCallPack = { key: string; displayName: string; description: string; needs: string; calls: Array<{ name: string; displayName: string; writes: boolean }> };
/**
 * What "For me" shows for one connector (plans/personal-actions-2026-10-29): may this person switch actions on for
 * themselves, do they have their own connection, and what they have on — actions by name, declared calls by record.
 */
export type PersonalConnectorView = {
  allowed: boolean;
  connected: boolean;
  actions: string[];
  calls: Array<{ name: string; displayName: string; description: string; pack: string | null; writes: boolean; declaration: Declaration }>;
  packs: DeclaredCallPack[];
};
/** What a person submits to declare one call. */
export type DeclaredCallInput = Declaration & { name: string; displayName: string; description: string };

export interface WorkspaceConnector {
  name: string;
  short: string;
  displayName: string;
  description: string;
  logoUrl: string | null;
  version: string;
  auth: ConnectorAuth[];
  oauth?: ConnectorOauthStatus | null;
  actions: ConnectorAction[];
  connections: ConnectorConnection[];
  enabled: Array<{ action: string; tool: string; connection: string | null; version: string }>;
}
export interface ConnectorInstall {
  name: string;
  short: string;
  displayName: string;
  description: string;
  logoUrl: string | null;
  version: string;
  license: string | null;
  hosts: string[];
  suggestedHosts: string[];
  status: "installed" | "unrecorded" | "missing";
  installedBy: string | null;
  installedAt: string | null;
  auth: ConnectorAuth[];
  actions: ConnectorAction[];
}
export interface ConnectionTestResult {
  checked: boolean;
  valid?: boolean;
  error?: string | null;
  identity?: string | null;
  connection: ConnectorConnection;
}
