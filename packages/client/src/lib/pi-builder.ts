/**
 * Pi builder client — sessions, messages, SSE events, Accept/snapshot.
 * Paths go through `/api/foundry/*` (session cookie → parent key).
 */

import type { ThinkingLevel } from "./thinking-levels";
import { signInIfEnded } from "@/lib/session-expiry";

const PROXY = "/api/foundry";

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
  /** Outputs (or a field in every row) that may genuinely come back empty, each with its reason. */
  allow_empty?: Array<{ output: string; field?: string; reason: string }>;
  /** A loop: run `steps` once per item of this list (`$item` / `$<as>` / `$index` inside). */
  as?: string;
  steps?: PiStep[];
  /** A choice: the first path whose condition holds runs; `outputs` is what every path sets for later steps. */
  branch?: PiArm[];
  /** An approval: the run waits here until someone approves everything after it. Never inside a loop. */
  approval?: { title: string; review?: string };
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
  /** When it runs on its own once approved: a 5-field cron, in `timezone` (default UTC). */
  schedule?: { cron: string; timezone?: string };
  /** The choices the request describes and the branch path each is (PiCase). */
  cases?: PiCase[];
  /** What `foundry.read("<name>")` runs: a saved reader (`ref`) or the workflow's own SQL. */
  reads?: Record<string, PiRead>;
  steps: PiStep[];
};

export type PiRead = { datasource?: string; sql?: string; params?: Array<{ name: string; type: string }>; ref?: string; kind?: string };

/**
 * `pick` (2026-10-13): the question asks which file is meant. The card lists every file in this chat and in the
 * workspace's Files with a search box; `choices` are Forge's suggestions, shown first. One file, or several (one name
 * per line in the answer).
 */
/**
 * A question Forge (or the server) asks. `kind` (2026-10-13) says how it is answered; without it, one of `choices` or
 * typed text, as always. The server normalises every question before it arrives, so an unknown kind never reaches
 * here; the card still treats one as a plain question.
 */
export type PiQuestion = {
  id: string;
  prompt: string;
  choices?: string[];
  pick?: "file" | "files";
  kind?: "choice" | "multi" | "number" | "date" | "period" | "text";
  min?: number;
  max?: number;
  unit?: string;
};

/** The answer to a `multi` question when nothing is ticked (the server's MULTI_NONE). */
export const MULTI_NONE = "None of these";
/** A person, as a chat message records them. */
export type PiAuthor = { subject: string | null; name: string | null };

export type PiAnswered = { id: string; prompt: string; choices?: string[]; answer: string };

/** A test run that is waiting at an approval: what it asks. The person testing decides it from the builder. */
export type PiTestWaiting = { stepId: string; title: string };

export type PiQuestionsFile = { status: string; questions: PiQuestion[] };

export type PiActivityKind = "read" | "write" | "edit" | "bash" | "grep" | "think" | "other";

export type PiActivity = {
  id: string;
  tool: string;
  kind: PiActivityKind;
  title: string;
  detail: string;
  status: "running" | "done" | "error";
  startedAt: string;
  endedAt?: string;
};

/** What went wrong in a Forge turn, in words a person acts on (server forge-errors.ts); `detail` is the raw error. */
export type PiTurnError = { title: string; said: string; retryable: boolean; detail?: string };

export type PiChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  activities?: PiActivity[];
  /** The opening line — written fresh on every open, never stored with the conversation. */
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
  /** Files the person sent with this message — context for Forge, stored with the workflow's chat. */
  attachments?: PiAttachment[];
  /** Files Forge made or changed in this reply, kept with the chat — downloadable. */
  files?: PiAttachment[];
  /** The chat's mode when this was said. Absent on older messages (Workflow Builder). */
  mode?: ChatMode;
  /** A "Switched to …" note; the next switch with nothing in between replaces it. */
  modeSwitch?: { from: ChatMode };
  /** What the model thought before this reply — only when its provider returns that readable. */
  thinking?: { text: string; ms: number };
  /** Changes Forge Agent proposed in this reply: each a card, done only when the person clicks Do it. */
  proposals?: PiProposal[];
};

/**
 * A change to a connected service that Forge Agent proposed (plugins phase 6). ⚠ Forge cannot perform it: only the
 * person's own click sends it to the server, which runs exactly these values, once.
 */
export type PiProposal = {
  id: string;
  tool: string;
  connector: string;
  action: string;
  summary: string;
  /** A list is a batch: the same action once per entry, one click, reported entry by entry. */
  params: Record<string, unknown> | Array<Record<string, unknown>>;
  status: "pending" | "running" | "done" | "partial" | "failed" | "declined";
  result?: string | null;
  results?: Array<{ ok: boolean; result: string; link?: string | null; brief?: Array<[string, string]> }>;
  /** Where a done change can be seen at the service, and a few facts a person recognises. */
  link?: string | null;
  brief?: Array<[string, string]>;
  decidedBy?: string | null;
  decidedAt?: string | null;
  via?: "personal" | "workspace" | null;
  /** The connection a change goes through, as chosen for this chat. */
  account?: PiAccount | null;
  at: string;
  /**
   * `setting`: switching a service's action on or off; the person picks where by the button they press.
   * `account`: which connection this chat uses for a service; the person picks one of `choice.options`.
   */
  kind?: "action" | "setting" | "account";
  setting?: PiSettingChange;
  /** `chat` is only on cards decided before actions were kept per person (0117). */
  scope?: GrantScope | "chat" | null;
  choice?: PiAccountQuestion;
};

/** Where a switched-on action applies: the person (every Forge Agent chat of theirs here), or the workspace. */
export type GrantScope = "me" | "workspace";

/** One connection a chat could use for a service. */
export type PiAccount = { connectionId: string; label: string; personal: boolean; identity: string | null };
export type PiAccountQuestion = { piece: string; service: string; options: PiAccount[]; chosen?: string | null; purpose?: "chat" | "workflow" };
/** The connection a chat uses for one service (piece → this). */
export type PiAccountChoice = PiAccount & { service: string; chosenBy: string; at: string };

/** Everything a setting card states before the click (server: pi-builder/types.ts `PiSettingChange`). */
export type PiSettingChange = {
  piece: string;
  action: string;
  service: string;
  title: string;
  on: boolean;
  describes: string;
  effect: "reads" | "changes";
  /** Where it is on now, for the person Forge is talking to. */
  current: "workspace" | "me" | "off";
  connection: string | null;
  identity: string | null;
  /** `true` when this person may apply it there, else why not. */
  scopes: { me: true | string; workspace: true | string };
  reason: string;
};

/**
 * A chat's mode (2026-10-13): Workflow Builder builds and changes the chat's one workflow and answers questions about
 * it; Forge Agent does the job now (questions, data, files, drafts) and never changes the workflow.
 */
export type ChatMode = "workflow" | "agent";
export const MODE_LABEL: Record<ChatMode, string> = { workflow: "Workflow Builder", agent: "Forge Agent" };
export const MODE_BLURB: Record<ChatMode, string> = {
  workflow: "Build and change automations, and ask about them.",
  agent: "Questions, data and files, done now. Nothing is sent or changed outside this chat.",
};

/** A file attached to a workflow's chat (server pi-builder/attachments.ts). */
/** `removed`: taken out of the chat later; the message keeps its name and nothing downloads. */
export type PiAttachment = { name: string; size: number; type: string; removed?: boolean };

/** How full a conversation's folder is. `chat`: the part in the chat's files, which the person can remove. */
export type PiStorage = { bytes: number; limit: number; chat: number };

/** Where a conversation's folder stands: below 80%, nearly full, or full (Forge cannot take a message). */
export function storageLevel(st: PiStorage | null | undefined): "ok" | "near" | "full" {
  if (!st || !st.limit) return "ok";
  if (st.bytes > st.limit) return "full";
  return st.bytes >= st.limit * 0.8 ? "near" : "ok";
}

/** A server error as its message ("413 {json}" → the sentence the server wrote). */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const body = raw.replace(/^\d{3}\s+/, "");
  try {
    const b = JSON.parse(body) as { message?: string; error?: string };
    return b.message ?? b.error ?? raw;
  } catch {
    return body || raw;
  }
}

export type PiSessionStatus =
  | "idle"
  | "running"
  | "awaiting_answers"
  | "ready"
  | "failed"
  | "accepted";

export type PiSession = {
  /**
   * Set when this person (an Admin) opened somebody else's chat: the screen says whose it is and that opening it
   * was recorded. Only the open call answers it; absent everywhere else.
   */
  othersChat?: { ownerName: string | null } | null;
  /**
   * Where this chat lives (sharing-boundaries P6-I4): `key` is a place key ("mine", "workspace", "project:<id>").
   * Only the open call answers it; absent from an older server, and then the builder says nothing.
   */
  place?: { key: string; projectName: string | null } | null;
  flowId: string | null;
  draftKey: string | null;
  /** The saved chat — null until the person's first message. Absent from an older server. */
  chatId?: string | null;
  id: string;
  workspaceId: string;
  status: PiSessionStatus;
  goal: string;
  messages: PiChatMessage[];
  liveActivities: PiActivity[];
  /** The reply as written so far while a turn runs (empty between turns). */
  draftText?: string;
  /** The model's thinking so far this turn — empty unless its provider returns it readable. */
  draftThinking?: string;
  workflow: PiWorkflow;
  /** The step files (`steps/<id>/main.py` → source), shown read-only when a step is clicked. */
  files?: Record<string, string>;
  questions: PiQuestionsFile;
  answers: Record<string, unknown>;
  lastVerify: { ok: boolean; detail: string } | null;
  /** `detail` is written for Forge; `summary` is the sentence a person reads. `needsRealData`: the test ran on test data and cannot judge the workflow (2026-11-03); absent from an older server. */
  lastTestRun: { ok: boolean; detail: string; summary?: string; at: string; runId: string | null; waiting?: PiTestWaiting | null; needsRealData?: boolean } | null;
  /** The flow execution of the last test run on flow-runner (pi-runtime P2). */
  lastRunId: string | null;
  acceptedSnapshotId: string | null;
  savedRevision: number | null;
  /** The model this chat's Forge runs with. Absent from an older server. */
  model?: string;
  /** The models this chat may choose from (enabled for the builder by an admin). Absent from an older server. */
  models?: string[];
  /** The context meter, as last measured (null until Forge has been asked). */
  context?: PiContext | null;
  compacting?: boolean;
  /** Workflow Builder or Forge Agent. Absent from an older server (Workflow Builder). */
  mode?: ChatMode;
  /** How hard Forge Agent thinks. Absent from an older server (balanced). */
  thinking?: ThinkingLevel;
  /** Whether this workspace offers Forge Agent at all. */
  agentAllowed?: boolean;
  /** Which connection this chat uses per connected service. Absent from an older server. */
  accounts?: Record<string, PiAccountChoice>;
  /** How full the conversation's folder is. Absent from an older server. */
  storage?: PiStorage;
  createdAt: string;
  updatedAt: string;
};

/** How full Forge's conversation is — the chat's context meter. Null tokens: not known until its next reply. */
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
  | { type: "test_run"; ok: boolean; detail: string; summary?: string; runId: string | null; waiting?: PiTestWaiting | null; needsRealData?: boolean }
  | { type: "snapshot"; id: string; label: string }
  | { type: "saved"; flowId: string; revision: number }
  /** The person's first message saved this conversation as a chat. */
  | { type: "chat"; chatId: string }
  | { type: "context"; context: PiContext }
  | { type: "compacting"; on: boolean }
  | { type: "mode"; mode: ChatMode; agentAllowed: boolean }
  /** More of the model's thinking this turn (only when its provider returns it readable). */
  | { type: "thinking"; text: string }
  | { type: "accounts"; accounts: Record<string, PiAccountChoice> }
  | { type: "storage"; storage: PiStorage }
  | { type: "messages"; messages: PiChatMessage[] }
  /** The chat's references changed: re-read them. */
  | { type: "references" }
  | { type: "error"; message: string }
  | { type: "done" };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PROXY}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    signInIfEnded(res.status, body);
    throw new Error(`${res.status} ${body || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function createPiSession(
  wsId: string,
  goal?: string,
  opts?: { flowId?: string | null; draftKey?: string | null; chatId?: string | null; mode?: ChatMode | null; projectId?: string | null },
) {
  return req<{ session: PiSession; othersChat?: { ownerName: string | null } | null; place?: { key: string; projectName: string | null } | null }>(`/workspaces/${wsId}/pi-builder/sessions`, {
    method: "POST",
    body: JSON.stringify({
      goal: goal ?? "",
      flowId: opts?.flowId ?? null,
      draftKey: opts?.draftKey ?? null,
      ...(opts?.chatId ? { chatId: opts.chatId } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
      // A new chat started inside a project lives there (sharing-boundaries phase 5); the server checks membership.
      ...(opts?.projectId ? { projectId: opts.projectId } : {}),
    }),
  }).then((r) => ({ ...r.session, othersChat: r.othersChat ?? null, place: r.place ?? null }));
}

/** A saved chat, as the Chats list shows it. */
export type PiChatSummary = {
  id: string;
  title: string;
  flowId: string | null;
  flowName: string | null;
  createdBy: { subject: string | null; name: string | null };
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** What the person asked for, in a line: the chat's preview on the Chats page. Absent from an older server. */
  goal?: string;
  /** An UNSAVED build in this chat (no workflow yet): how many steps it has, and the name Forge gave it. */
  draftSteps?: number;
  draftName?: string | null;
  /** The server's answer: the person who started it, or a workspace admin. */
  canDelete: boolean;
  /** The same rule as delete. Absent from an older server — then rename is not offered. */
  canRename?: boolean;
  /** Workflow Builder or Forge Agent. Absent from an older server. */
  mode?: ChatMode;
  /** Started by the person asking (rbac-observability). */
  mine?: boolean;
  /** `public`: shared with the workspace to READ (sharing-boundaries). Absent from an older server — private. */
  visibility?: "private" | "public";
  /** The project it lives in (sharing-boundaries phase 5); null or absent: My space or the Workspace. */
  projectId?: string | null;
  /** Its project's name, sent with the list. */
  projectName?: string | null;
  /**
   * May this person continue, rename, delete or share it — its owner, or an Admin. A member reading a shared chat may
   * not. Absent from an older server, which listed only chats the person could change.
   */
  canChange?: boolean;
};

/** A chat read WITHOUT opening it (sharing-boundaries): the stored conversation, and whether this person may continue it. */
export type PiChatTranscript = {
  chat: {
    id: string;
    title: string;
    mode: ChatMode;
    flowId: string | null;
    visibility: "private" | "public";
    createdBy: { subject: string | null; name: string | null };
    updatedAt: string;
    messages: PiChatMessage[];
  };
  mine: boolean;
  canChange: boolean;
};

/** The Chats page's filters (2026-10-13): by mode, or the chats holding a build nobody has saved. */
export type ChatFilter = "all" | "workflow" | "agent" | "drafts";
export const CHAT_FILTERS: Array<{ key: ChatFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "workflow", label: "Workflow Builder" },
  { key: "agent", label: "Forge Agent" },
  { key: "drafts", label: "Drafts not saved" },
];

/** A chat holding a build nobody has saved yet: steps, and no workflow. */
export function isUnsavedDraft(c: Pick<PiChatSummary, "flowId" | "draftSteps">): boolean {
  return !c.flowId && (c.draftSteps ?? 0) > 0;
}

export function chatMatches(c: Pick<PiChatSummary, "flowId" | "draftSteps" | "mode">, only: ChatFilter): boolean {
  if (only === "all") return true;
  if (only === "drafts") return isUnsavedDraft(c);
  return (c.mode ?? "workflow") === only;
}

/** Chats holding a build nobody has saved yet — the Workflows page lists them under Drafts. */
export function unsavedBuilds(chats: readonly PiChatSummary[]): PiChatSummary[] {
  return chats.filter((c) => !c.flowId && (c.draftSteps ?? 0) > 0);
}

export function listPiChats(wsId: string) {
  return req<{ chats: PiChatSummary[] }>(`/workspaces/${wsId}/pi-builder/chats`).then((r) => r.chats);
}

export function deletePiChat(wsId: string, chatId: string) {
  return req<void>(`/workspaces/${wsId}/pi-builder/chats/${chatId}`, { method: "DELETE" });
}

/** Read a chat without opening it — starts no Forge process (sharing-boundaries). */
export function getPiChat(wsId: string, chatId: string) {
  return req<PiChatTranscript>(`/workspaces/${wsId}/pi-builder/chats/${chatId}`);
}

/** Give a chat a new name (the person who started it, or a workspace admin). */
export function renamePiChat(wsId: string, chatId: string, title: string) {
  return req<{ id: string; title: string }>(`/workspaces/${wsId}/pi-builder/chats/${chatId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** Where a chat's stored file downloads from (the proxy forwards it). */
export function piChatFileUrl(wsId: string, chatId: string, name: string): string {
  return `${PROXY}/workspaces/${wsId}/pi-builder/chats/${chatId}/files/${encodeURIComponent(name)}`;
}

/**
 * Where a chat opens: its workflow's builder when it built one, otherwise the new-workflow page holding it. A chat this
 * person may only READ (shared with the workspace by somebody else) opens read-only at `/chats/<id>` instead.
 */
/**
 * A chat's address: always /chats/<id> (2026-10-30). That page opens it live for whoever may continue it and read-only
 * for anyone it is shared with, so the link no longer depends on who asks or on whether it built a workflow.
 */
export function chatHref(chat: { id: string }): string {
  return `/chats/${chat.id}`;
}

/** Where an old /flows/new link lands: a saved chat's own address, else /chats/new with `?q=` and `?project=` kept. */
export function newChatTarget(params: URLSearchParams): string {
  const chat = params.get("chat");
  if (chat) return `/chats/${encodeURIComponent(chat)}`;
  const keep = new URLSearchParams();
  for (const k of ["q", "project"]) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  return qs ? `/chats/new?${qs}` : "/chats/new";
}

/** Tear down session + sandbox so nothing seeps into the next workflow. */
export function destroyPiSession(wsId: string, sessionId: string) {
  return req<void>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

export function bindPiSessionFlow(wsId: string, sessionId: string, flowId: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/bind-flow`,
    { method: "POST", body: JSON.stringify({ flowId }) },
  ).then((r) => r.session);
}

export function getPiSession(wsId: string, sessionId: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}`,
  ).then((r) => r.session);
}

export function sendPiMessage(wsId: string, sessionId: string, text: string, attachments: string[] = []) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/messages`,
    { method: "POST", body: JSON.stringify(attachments.length ? { text, attachments } : { text }) },
  ).then((r) => r.session);
}

/** The server's own limits, mirrored so a file is refused here before it is sent. The server still decides. */
export const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
export const ATTACH_MAX_FILES = 10;
export const ATTACH_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx,.xls,.odt,.ods,.txt,.md,.csv,.tsv,.json,.xml,.yaml,.yml";

/** Why a file cannot be attached, before it is uploaded — or null. */
export function attachRefusal(file: { name: string; size: number }): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : "";
  if (ext === ".doc") return `${file.name}: save it as .docx and attach that.`;
  if (!ATTACH_ACCEPT.split(",").includes(ext)) return `${file.name} can't be attached. Documents, sheets, images and text files only.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > ATTACH_MAX_BYTES) return `${file.name} is larger than 50 MB.`;
  return null;
}

/**
 * Upload one file to the workflow's chat, reporting progress (0–1). XMLHttpRequest because fetch reports no upload
 * progress. The file is sent as raw bytes with its name in `x-file-name`, like the SQLite upload.
 */
export function uploadPiAttachment(
  wsId: string,
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
): { done: Promise<PiAttachment>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<PiAttachment>((resolve, reject) => {
    xhr.open("POST", `${PROXY}/workspaces/${wsId}/pi-builder/sessions/${sessionId}/attachments`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as { attachment: PiAttachment }).attachment);
        } catch {
          reject(new Error("The upload finished but its answer could not be read."));
        }
        return;
      }
      signInIfEnded(xhr.status, xhr.responseText);
      let said = xhr.responseText;
      try {
        said = (JSON.parse(xhr.responseText) as { message?: string }).message ?? said;
      } catch {
        /* plain text */
      }
      reject(new Error(said || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("The upload could not reach the server."));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

/** Remove an attached file that has not been sent. */
export function removePiAttachment(wsId: string, sessionId: string, name: string) {
  return req<void>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/attachments/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

/** Try again on a failure card: the server re-runs the last turn as it was — no second copy of the message. */
export function retryPiTurn(wsId: string, sessionId: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/messages`,
    { method: "POST", body: JSON.stringify({ retry: true }) },
  ).then((r) => r.session);
}

export function answerPiQuestions(
  wsId: string,
  sessionId: string,
  answers: Record<string, string>,
) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/answers`,
    { method: "POST", body: JSON.stringify({ answers }) },
  ).then((r) => r.session);
}

export function verifyPiSession(wsId: string, sessionId: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/verify`,
    { method: "POST", body: "{}" },
  ).then((r) => r.session);
}

export function acceptPiSession(wsId: string, sessionId: string, label?: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/accept`,
    { method: "POST", body: JSON.stringify({ label: label ?? "accept" }) },
  ).then((r) => r.session);
}

/** Remove a file from the chat: its folder and the saved chat. Its cards stay, marked removed. */
export function removePiChatFile(wsId: string, sessionId: string, name: string) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/files/${encodeURIComponent(name)}`, {
    method: "DELETE",
  }).then((r) => r.session);
}

/** Switch the chat's mode; it applies from the next message. */
export function setPiMode(wsId: string, sessionId: string, mode: ChatMode) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  }).then((r) => r.session);
}

/** Set how hard Forge Agent thinks; it applies from the next message. */
export function setPiThinking(wsId: string, sessionId: string, thinking: ThinkingLevel) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/thinking`, {
    method: "POST",
    body: JSON.stringify({ thinking }),
  }).then((r) => r.session);
}

/** Set the model this chat's Forge runs with; it applies from the next message. */
export function setPiModel(wsId: string, sessionId: string, model: string) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/model`, {
    method: "POST",
    body: JSON.stringify({ model }),
  }).then((r) => r.session);
}

/** "Send now" on a queued message: give it to Forge during the turn that is running. Refused (409) when none is. */
export function steerPiMessage(wsId: string, sessionId: string, text: string) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/steer`, {
    method: "POST",
    body: JSON.stringify({ text }),
  }).then((r) => r.session);
}

/** Do (or cancel) a change Forge Agent proposed. Only the person Forge was answering may; the server checks. */
export function decidePiProposal(wsId: string, sessionId: string, proposalId: string, decision: "run" | "decline", scope?: GrantScope, choice?: string) {
  return req<{ proposal: PiProposal }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/proposals/${proposalId}`, {
    method: "POST",
    body: JSON.stringify({ decision, ...(scope ? { scope } : {}), ...(choice ? { choice } : {}) }),
  }).then((r) => r.proposal);
}

/** "Change" on the chat's accounts: forget the connection chosen for a service, so the next use asks again. */
export function clearPiAccount(wsId: string, sessionId: string, piece: string) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/accounts/clear`, {
    method: "POST",
    body: JSON.stringify({ piece }),
  }).then((r) => r.session);
}

/** The person's own default for new chats. */
export function setForgeDefaultMode(mode: ChatMode) {
  return req<{ forgeDefaultMode: ChatMode }>(`/me/forge-default-mode`, { method: "PUT", body: JSON.stringify({ mode }) }).then(
    (r) => r.forgeDefaultMode,
  );
}

/** "Compact now": Forge summarises the earlier conversation to make room. */
export function compactPiSession(wsId: string, sessionId: string) {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/compact`, { method: "POST", body: "{}" }).then((r) => r.session);
}

export function stopPiSession(wsId: string, sessionId: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/stop`,
    { method: "POST", body: "{}" },
  ).then((r) => r.session);
}

/**
 * `inputs`: what the person typed into the test form, by input name. Absent = run on the declared defaults.
 * `useProductionData`: the per-run opt-in — sent only when checked AND confirmed; the server refuses a non-admin.
 */
export function testRunPiSession(
  wsId: string,
  sessionId: string,
  inputs?: Record<string, string>,
  opts?: { useProductionData: boolean },
) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/test-run`,
    {
      method: "POST",
      body: JSON.stringify({ ...(inputs ? { inputs } : {}), ...(opts?.useProductionData ? { useProductionData: true } : {}) }),
    },
  ).then((r) => r.session);
}

/** Decide the approval the session's test run is waiting at, and follow the run to its end (P5). */
export function decidePiTest(wsId: string, sessionId: string, decision: "approved" | "rejected") {
  return req<{ session: PiSession }>(`/workspaces/${wsId}/pi-builder/sessions/${sessionId}/test-run`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  }).then((r) => r.session);
}

export function savePiVersion(wsId: string, sessionId: string, name?: string) {
  return req<{ session: PiSession }>(
    `/workspaces/${wsId}/pi-builder/sessions/${sessionId}/save-version`,
    { method: "POST", body: JSON.stringify({ name }) },
  ).then((r) => r.session);
}

/**
 * Subscribe to Pi SSE. Returns an unsubscribe. `onOpen` fires once the stream is answering; `onError` fires when it
 * fails OR ends — a stream that closes on its own (a proxy restarting, a dropped network) is a lost connection too,
 * never a silent stop. Neither fires after unsubscribing. Uses fetch+ReadableStream so
 * cookies / identity headers work the same as other Foundry calls (EventSource
 * cannot set headers, but same-origin cookies still attach here).
 */
export function openPiEventStream(
  wsId: string,
  sessionId: string,
  onEvent: (ev: PiEvent) => void,
  onError?: (err: Error) => void,
  onOpen?: () => void,
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(
        `${PROXY}/workspaces/${wsId}/pi-builder/sessions/${sessionId}/events`,
        { signal: ctrl.signal, cache: "no-store", headers: { accept: "text/event-stream" } },
      );
      if (!res.ok || !res.body) {
        // An ended session is not a dropped connection: go to sign-in instead of retrying for ever.
        if (res.status === 401 && signInIfEnded(401, await res.text().catch(() => ""))) return;
        throw new Error(`SSE ${res.status}`);
      }
      onOpen?.();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            try {
              onEvent(JSON.parse(raw) as PiEvent);
            } catch {
              /* ignore malformed */
            }
          }
        }
      }
      if (!ctrl.signal.aborted) onError?.(new Error("the live connection closed"));
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError" || ctrl.signal.aborted) return;
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return () => ctrl.abort();
}

// ── Workflow references (server pi-builder/reference-state.ts) ──────────────────────────────────────────────────
// A Workflow Builder chat learns from up to MAX_REFERENCES saved workflows of its workspace. Each is pinned to one
// SAVED version, labelled "saved N" — never "vN", which on the workflows list counts approvals.

export const MAX_REFERENCES = 3;

/** A saved workflow this chat may reference. */
export type Referenceable = { flowId: string; name: string; latest: number; latestLabel: string; savedAt: string | null };

/** A reference, as its chip shows it. */
export type WorkflowReference = {
  id: string;
  flowId: string | null;
  name: string;
  revision: number;
  /** "saved 3 · not approved" / "saved 3 · approved as v1". */
  label: string;
  /** The card exactly as Forge sees it. */
  cardMd: string;
  /** The workflow has been deleted; the reference reads from its copy. */
  deleted: boolean;
  /** A newer saved version, when there is one. */
  newer: number | null;
  versions: Array<{ revision: number; savedAt: string | null; approvedAs: number | null; label: string }>;
};

const refsPath = (wsId: string, sessionId: string) => `/workspaces/${wsId}/pi-builder/sessions/${sessionId}`;

export function listReferenceable(wsId: string, sessionId: string) {
  return req<{ workflows: Referenceable[] }>(`${refsPath(wsId, sessionId)}/referenceable`).then((r) => r.workflows);
}

export function listReferences(wsId: string, sessionId: string) {
  return req<{ references: WorkflowReference[] }>(`${refsPath(wsId, sessionId)}/references`).then((r) => r.references);
}

export function addReference(wsId: string, sessionId: string, flowId: string) {
  return req<{ references: WorkflowReference[] }>(`${refsPath(wsId, sessionId)}/references`, {
    method: "POST",
    body: JSON.stringify({ flowId }),
  }).then((r) => r.references);
}

export function setReferenceVersion(wsId: string, sessionId: string, refId: string, revision: number) {
  return req<{ references: WorkflowReference[] }>(`${refsPath(wsId, sessionId)}/references/${refId}`, {
    method: "PATCH",
    body: JSON.stringify({ revision }),
  }).then((r) => r.references);
}

export function removeReference(wsId: string, sessionId: string, refId: string) {
  return req<{ references: WorkflowReference[] }>(`${refsPath(wsId, sessionId)}/references/${refId}`, {
    method: "DELETE",
  }).then((r) => r.references);
}

/**
 * The `@mention` being typed at the caret, if any: an `@` at the start of the text or after a space, then the
 * characters up to the caret (spaces allowed — workflow names have them — but not a new line). Null when the caret is
 * not inside one, so an email address ("a@b.com") never opens the picker.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\n/.test(query) || query.length > 60) return null;
  return { start: at, query };
}

/** The text with the `@mention` from `start` to the caret taken out (the pick becomes a chip, not words). */
export function withoutMention(text: string, start: number, caret: number): string {
  const rest = text.slice(caret);
  const head = text.slice(0, start);
  return head.endsWith(" ") && rest.startsWith(" ") ? head + rest.slice(1) : head + rest;
}
