export type PiStep = {
  id: string;
  /** One plain sentence: what this step does, for a person reading it (2026-10-11). Required on code steps. */
  description?: string;
  entry?: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  outputs?: string[];
  /** What the step reaches: "read:<name>" / "tool:<name>". */
  uses?: string[];
  foreach?: string;
  /**
   * Outputs (or a field in every row of one) that may genuinely come back empty, each with its reason. Anything
   * not declared here fails the step when it comes back empty (flow-runner checks.py).
   */
  allow_empty?: PiEmptyAllowance[];
  /** A loop: run `steps` once per item of this list (`$item` / `$<as>` / `$index` inside). */
  as?: string;
  steps?: PiStep[];
  /** A choice: the first path whose condition holds runs; `outputs` is what every path sets for later steps. */
  branch?: PiArm[];
  /** An approval: the run waits here until someone approves everything after it. Never inside a loop. */
  approval?: { title: string; review?: string; decider?: string };
};

/** A branch path: a declared condition (or `else`), its steps, and what it sets for the steps after the branch. */
export type PiCondition =
  | { value: string; op: string; to?: unknown }
  | { all: PiCondition[] }
  | { any: PiCondition[] }
  | { not: PiCondition };
export type PiArm = { if?: PiCondition; else?: boolean; steps: PiStep[]; set?: Record<string, string> };

/** What a workflow node is (pi-runtime P5/P7): a step, a loop over a list, a choice between paths, or an approval. */
export function kindOf(node: PiStep): "step" | "loop" | "branch" | "approval" {
  if (node.foreach !== undefined) return "loop";
  if (node.branch !== undefined) return "branch";
  if (node.approval !== undefined) return "approval";
  return "step";
}

/** Every node, at any depth — inside loops and branch paths too — in workflow order. */
export function allNodes(nodes: PiStep[] | undefined): PiStep[] {
  const out: PiStep[] = [];
  for (const n of nodes ?? []) {
    out.push(n);
    if (n.steps) out.push(...allNodes(n.steps));
    for (const arm of n.branch ?? []) out.push(...allNodes(arm.steps));
  }
  return out;
}

/** Every plain step (code that runs), at any depth. */
export function allSteps(nodes: PiStep[] | undefined): PiStep[] {
  return allNodes(nodes).filter((n) => kindOf(n) === "step");
}

export type PiEmptyAllowance = { output: string; field?: string; reason: string };

/** A value the run is started with — what the test form asks for, and what `$input.<name>` reads. */
/**
 * `relative` (a date input only): what a REAL run uses when nobody gives a value — worked out from the run day
 * (run-inputs RELATIVE_DATES); a test run uses `default`, a date the test data has rows for.
 */
export type PiInputDecl = { type?: string; description?: string; default?: unknown; relative?: string };
/**
 * One choice the request describes, in the person's words, and the branch path that handles it (`<branch>.<n>` or
 * `<branch>.else`). The checker holds the workflow to this list, so no choice is hidden in code or silently dropped.
 */
export type PiCase = { says: string; path?: string; missing?: string };
export type PiWorkflow = {
  name?: string;
  inputs?: Record<string, PiInputDecl>;
  schedule?: { cron: string; timezone?: string };
  /** The choices the request describes and the branch path each is (PiCase). */
  cases?: PiCase[];
  steps: PiStep[];
};

export type PiQuestion = {
  id: string;
  prompt: string;
  choices?: string[];
  /** Which file is meant (SYSTEM.md, How you work): the card lists the chat's files and the workspace's Files. */
  pick?: "file" | "files";
  /**
   * How it is answered (2026-10-13, question-kinds.ts). Optional: without it a question is what it always was — one
   * of `choices` or typed text. `multi` ticks any of `choices`; `number` takes `min`/`max`/`unit`; `date` is
   * YYYY-MM-DD, `period` YYYY-MM. A kind this build does not know is dropped, never rendered blank.
   */
  kind?: QuestionKind;
  min?: number;
  max?: number;
  unit?: string;
};

export type QuestionKind = "choice" | "multi" | "number" | "date" | "period" | "text";

/** A person, as a chat message records them. */
export type PiAuthor = { subject: string | null; name: string | null };

export type PiAnswered = { id: string; prompt: string; choices?: string[]; answer: string };

/** A test run that is waiting at an approval: what it asks. The person testing decides it from the builder. */
export type PiTestWaiting = { stepId: string; title: string };

export type PiQuestionsFile = {
  status: "idle" | "open" | "answered" | string;
  questions: PiQuestion[];
};

export type PiSessionStatus =
  | "idle"
  | "running"
  | "awaiting_answers"
  | "ready"
  | "failed"
  | "accepted";

/** What went wrong in a Forge turn, in words a person acts on (server forge-errors.ts); `detail` is the raw error. */
export type PiTurnError = { title: string; said: string; retryable: boolean; detail?: string };

export type PiChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  /** The chat's mode when this was said (0097): Workflow Builder or Forge Agent. Absent on older messages (workflow). */
  mode?: "workflow" | "agent";
  /** A "Switched to …" note, with the mode the chat was in before it — so the next switch can replace it. */
  modeSwitch?: { from: "workflow" | "agent" };
  /** What the model thought before this reply, when its provider returns that readable — absent otherwise. */
  thinking?: { text: string; ms: number };
  /** Tool / agent steps that ran under this assistant turn (accordion list). */
  activities?: PiActivity[];
  /** The opening line — written fresh on every open, so it is never stored with the conversation. */
  welcome?: boolean;
  /**
   * A person's message that ANSWERED Forge's questions (2026-10-10): each question with what was chosen or typed. The
   * chat shows it as the settled question card; the instruction sent to the agent is never shown as their words.
   */
  answers?: PiAnswered[];
  /** Who sent a person's message — from the verified identity, for the record of who asked for what. */
  by?: PiAuthor;
  /** A turn that did not finish: what went wrong, in plain words, and whether Try again can help. */
  error?: PiTurnError;
  /** Files the person attached to this message (attachments.ts) — by name, as stored for the workflow's chat. */
  attachments?: { name: string; size: number; type: string }[];
  /** Files Forge made or changed in this reply (`out/`), kept with the chat — downloadable. */
  files?: { name: string; size: number; type: string }[];
  /** Changes Forge Agent proposed in this reply (plugins phase 6): each shown as a card, done only by the person's click. */
  proposals?: PiProposal[];
};

/**
 * A change to a connected service that Forge Agent PROPOSED (`tools/propose-change.mjs`). ⚠ Forge cannot perform it:
 * only the person who asked, clicking "Do it" in their own browser, makes the server run exactly this call, once.
 */
export type PiProposal = {
  id: string;
  /** The tool (an enabled connector action) and what it is, in the connector's words. */
  tool: string;
  connector: string;
  action: string;
  /** Forge's one line of what will happen, shown above the exact values. */
  summary: string;
  /**
   * The exact values the call is made with — what the person reads before clicking. A LIST is a batch: the same action
   * once per entry (close these nine items), decided by one click and reported entry by entry.
   */
  params: Record<string, unknown> | Array<Record<string, unknown>>;
  /** `partial`: a batch where some entries were done and some failed (`results` says which). */
  status: "pending" | "running" | "done" | "partial" | "failed" | "declined";
  /** A batch's answer per entry, in order, each with where to see it and a few facts (agent-changes.ts). */
  results?: Array<{ ok: boolean; result: string; link?: string | null; brief?: Array<[string, string]> }>;
  /** Where a done change can be seen at the service (its web page), and a few facts a person recognises. */
  link?: string | null;
  brief?: Array<[string, string]>;
  /** What the service answered (shortened), or why it failed. */
  result?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  /** Whose connection the call went through: the person's own ("as me") or the workspace's. */
  via?: "personal" | "workspace" | null;
  /** The connection a change goes through, as the card names it (plugins 8.5) — chosen by the person for this chat. */
  account?: PiAccount | null;
  at: string;
  /**
   * `setting`: not a call to the service but switching one of its actions on or off (agent-grants.ts). `params` is then
   * empty and `setting` says everything the card shows; the person picks WHERE (`scope`) by the button they press.
   */
  kind?: "action" | "setting" | "account";
  setting?: PiSettingChange;
  /** `account`: which connection this chat should use for a service — the person picks one of `options`. */
  choice?: PiAccountQuestion;
  /** Where the person applied a setting change. */
  /** `chat` is only on cards decided before 0117, when an action was switched on for one chat. */
  scope?: "me" | "workspace" | "chat" | null;
};

/** One connection a chat could use for a service, as the person reads it. */
export type PiAccount = {
  connectionId: string;
  /** The connection's name in Foundry ("Team GitHub", "Mine"). */
  label: string;
  /** The person's own ("only for me") connection, or the workspace's. */
  personal: boolean;
  /** Who it is at the service, from its last check ("Connected as BLANCO-11"), when known. */
  identity: string | null;
};

/** "Which GitHub should Forge use in this chat?" — the options, and once answered, the one chosen. */
export type PiAccountQuestion = {
  piece: string;
  service: string;
  options: PiAccount[];
  chosen?: string | null;
  /** For this chat's calls (Forge Agent), or what the workflow runs as (Workflow Builder, saved and approved with it). */
  purpose?: "chat" | "workflow";
};

/** The connection a chat uses for one service, as remembered on the chat (pi_chats.connection_choices). */
export type PiAccountChoice = PiAccount & { service: string; chosenBy: string; at: string };

/** A proposal to switch a connected service's action on or off — everything the card states before the click. */
export type PiSettingChange = {
  piece: string;
  action: string;
  /** The service's and the action's names, as people read them. */
  service: string;
  title: string;
  on: boolean;
  /** What the action does, in the service's words, and its effect: reads, changes. */
  describes: string;
  effect: "reads" | "changes";
  /** Where it is on now, for the person Forge is talking to. */
  current: "workspace" | "me" | "off";
  /** The connection it would run through, and who that is at the service ("Connected as BLANCO-11"). */
  connection: string | null;
  identity: string | null;
  /** For each place: `true` when THIS person may apply it there, else why not. */
  scopes: { me: true | string; workspace: true | string };
  /** Forge's reason, in a line. */
  reason: string;
};

/**
 * One accordion row in chat — a tool call or agent phase while Pi builds.
 * Mirrors Pi's tool_execution_* events, normalised for the UI.
 */
export type PiActivityKind = "read" | "write" | "edit" | "bash" | "grep" | "think" | "other";

export type PiActivity = {
  id: string;
  tool: string;
  kind: PiActivityKind;
  /** Short title for the closed accordion (e.g. "Wrote steps/fetch/main.py"). */
  title: string;
  /** Detail shown when expanded (args summary, path, command, result snippet). */
  detail: string;
  status: "running" | "done" | "error";
  startedAt: string;
  endedAt?: string;
};

/**
 * How full Forge's conversation is (pi's `get_session_stats`), the chat's context meter. `tokens`/`percent` are null
 * when pi does not know yet (right after a compaction, before the next reply).
 */
export type PiContext = { tokens: number | null; window: number; percent: number | null; at: string };

export type PiEvent =
  | { type: "status"; status: PiSessionStatus }
  /** The AI service failed and Pi is retrying (`attempt` of `maxAttempts`); `attempt: 0` = the retry worked, clear it. */
  | { type: "retrying"; attempt: number; maxAttempts?: number; title?: string }
  | { type: "delta"; text: string }
  | { type: "message"; message: PiChatMessage }
  | { type: "activity"; activity: PiActivity }
  | { type: "workflow"; workflow: PiWorkflow; files?: Record<string, string> }
  | { type: "questions"; questions: PiQuestionsFile }
  | { type: "verify"; ok: boolean; detail: string; summary?: string }
  | { type: "test_run"; ok: boolean; detail: string; summary?: string; runId: string | null; waiting?: PiTestWaiting | null; needsRealData: boolean }
  /** Draft/live test started — runId is known before waitForRun settles (personal Phase 2 live panel). */
  | { type: "test_run_started"; runId: string }
  | { type: "snapshot"; id: string; label: string }
  | { type: "saved"; flowId: string; revision: number }
  /** The person's first message saved this conversation as a chat (0095). */
  | { type: "chat"; chatId: string }
  /** The context meter moved (after a reply, on open, after a compaction). */
  | { type: "context"; context: PiContext }
  /** Forge is summarising earlier messages to make room (`on`), or finished. */
  | { type: "compacting"; on: boolean }
  /** The conversation's folder was measured (after a turn, an upload, a removal). */
  | { type: "storage"; storage: PiStorage }
  /** The chat's messages changed outside a turn (a file was removed: its cards say so). */
  | { type: "messages"; messages: PiChatMessage[] }
  /** The chat changed mode (0097), or Forge Agent was turned off for the workspace. */
  | { type: "mode"; mode: "workflow" | "agent"; agentAllowed: boolean }
  /** More of the model's thinking this turn (only when the provider returns it readable). */
  | { type: "thinking"; text: string }
  /** The chat's references changed (added, moved, removed, or one's workflow was deleted): re-read them. */
  | { type: "references" }
  /** The connections this chat uses, per service, changed (chosen on a card, or cleared to ask again). */
  | { type: "accounts"; accounts: Record<string, PiAccountChoice> }
  | { type: "error"; message: string }
  | { type: "done" };

export type PiSessionPublic = {
  id: string;
  workspaceId: string;
  /** Foundry flow this session belongs to, once known. Null for /flows/new drafts. */
  flowId: string | null;
  /** Client draft key — one live session per (workspace, flowId|draftKey). */
  draftKey: string | null;
  /** The saved chat — null until the person's first message. */
  chatId: string | null;
  status: PiSessionStatus;
  goal: string;
  messages: PiChatMessage[];
  /** Live activities for the in-flight turn (cleared when the assistant message lands). */
  liveActivities: PiActivity[];
  /** The reply as written so far while a turn runs (empty between turns), so a reloaded page shows it at once. */
  draftText: string;
  /** The model's thinking so far this turn — empty unless the provider returns it readable. */
  draftThinking: string;
  workflow: PiWorkflow;
  /** The step files (`steps/<id>/main.py` → source), shown read-only when a step is clicked. */
  files?: Record<string, string>;
  questions: PiQuestionsFile;
  answers: Record<string, unknown>;
  lastVerify: { ok: boolean; detail: string } | null;
  /** Sandbox test-run (verify + runner). Save-as-version requires ok. */
  /** `detail` is written for Forge; `summary` is the sentence a person reads (flow-runner.service `summariseRun`). */
  lastTestRun: { ok: boolean; detail: string; summary?: string; at: string; runId: string | null; waiting?: PiTestWaiting | null; needsRealData: boolean } | null;
  /** The flow execution of the last test run on flow-runner (pi-runtime P2). */
  lastRunId: string | null;
  acceptedSnapshotId: string | null;
  /** Foundry revision number after save-as-version, if any. */
  savedRevision: number | null;
  /** The model Forge runs with for this chat (the effective one; the chat head shows it). */
  model: string;
  /** The models this chat may choose from (the builder's enabled models, or its default alone). */
  models: string[];
  /** How full the conversation is, as last measured; null until Forge has been asked. */
  context: PiContext | null;
  /** Forge is summarising earlier messages right now. */
  compacting: boolean;
  /** Workflow Builder (`workflow`) or Forge Agent (`agent`), chosen by the person (0097). */
  mode: "workflow" | "agent";
  /** How hard Forge Agent thinks (0119). Workflow Builder turns run without reasoning whatever this says. */
  thinking: "low" | "balanced" | "high" | "ultra";
  /** Whether this workspace offers Forge Agent at all (workspaces.assistant), as last read. */
  agentAllowed: boolean;
  /** Which connection this chat uses per connected service (piece → choice), chosen by the person. */
  accounts: Record<string, PiAccountChoice>;
  /** How full the conversation's folder is; past `limit` Forge cannot take a message. */
  storage: PiStorage;
  createdAt: string;
  updatedAt: string;
};

/** How full a conversation's folder is (2026-10-13). `chat`: the bytes in the chat's files, the part a person can remove. */
export type PiStorage = { bytes: number; limit: number; chat: number };
