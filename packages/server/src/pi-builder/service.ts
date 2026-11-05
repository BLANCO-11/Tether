import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, extname, join } from "node:path";
import {
  assistantTextFromMessage,
  endActivity,
  startActivity,
  textDeltaFromUpdate,
  thinkingFromUpdate,
  updateActivity,
} from "./activity.js";
import { ForgeProcess, forgeSessionFile, piModel, rebaseForgeSession } from "./pi-runner.js";
import { ForgePool } from "./forge-pool.js";
import { config } from "../config/index.js";
import {
  createSessionTree,
  destroySessionTree,
  readAnswers,
  readQuestions,
  readWorkflow,
  sandboxDir,
  sessionRoot,
  takeSnapshot,
  writeAnswers,
  writeGoal,
} from "./sandbox-fs.js";
import { linkCatalogueIntoSandbox, refreshWorkspaceCatalogue } from "./catalogue-sync.js";
import { actionsFor, applyMine, applyWorkspace, connectedServices, findAction, mayDecide, neverFromChat, serviceLine, workspaceConnection, type GrantScope } from "./agent-grants.js";
import { keptChoice, workflowChanged } from "./save-conflict.js";
import { confined, folderUsage, readBundle, restoreWorkflowSnapshot, workflowSnapshot, writeBundle } from "./sandbox-fs.js";
import { explainModelError, turnFailure } from "./forge-errors.js";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { MODE_NAME, writeSystemPrompt, type ChatMode } from "./instructions.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { bareModel, effectiveModel, modelChoices, modelNote, type Generation } from "./model-choice.js";
import { DEFAULT_THINKING, isThinkingLevel, reasoningEffort, thinkingNote, type ThinkingLevel } from "./thinking.js";
import { MAX_REFERENCES, cardsBlock, clearReferences, writeReferences } from "./references.js";
import {
  folderRefs,
  goneFlows,
  listReferenceable,
  loadRefs,
  newRef,
  snapshotOf,
  storeRef,
  viewsOf,
  type ReferenceView,
  type Referenceable,
  type SessionRef,
} from "./reference-state.js";
import { piChatReferenceRepo } from "../repositories/pi-chat-reference.repo.js";
import { effectivePermissionsService, type Identity } from "../services/effective-permissions.service.js";
import { contentVisibility, type Viewer } from "../services/content-visibility.service.js";
import { platformUserService } from "../services/platform-user.service.js";
import {
  ATTACHMENT_TYPES,
  chatFileNames,
  chatFileOnDisk,
  findAttachment,
  newOutputs,
  outDir,
  outSnapshot,
  layOutFiles,
  legacyAttachmentFolders,
  MAX_ATTACHMENTS_PER_MESSAGE,
  readAttachment,
  removeAttachment,
  removeLegacyAttachmentRoot,
  storeAttachment,
  type PiAttachment,
} from "./attachments.js";
import { SANDBOXES_ROOT, TEMPLATE_ROOT } from "./paths.js";
import { allowedEmptyOutputs, emptyReadsOf, filesBesideTables, largeTablesRead, realDataVerdict } from "./test-data-kind.js";
import { droppedSources, fixPrompt, noProgress, routeFailure, sourceList } from "./fix-loop.js";
import { firstNameOf, newWelcome, savedWelcome, type WelcomeCatalogue } from "./welcome.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { projectService } from "../services/project.service.js";
import { webFetch, WebFetchError, type WebFetchResult } from "../services/web-fetch.service.js";
import { projectFileService } from "../services/project-file.service.js";
import { piChatRepo, type PiChatSummary } from "../repositories/pi-chat.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowRunnerService, describeRun, failedOnEmptyData, readProblems, summariseRun, CHECKS_REFUSED } from "../services/flow-runner.service.js";
import { runInputsOf } from "../services/run-inputs.js";
import { forgeRefsOf, piFlowService } from "../services/pi-flow.service.js";
import type { PiBundle } from "../services/flow-runner.service.js";
import { isAllowedScheduleCron, labelForCron } from "./schedule-presets.js";
import { parseCron } from "../services/cron.js";
import { flowApprovalService } from "../services/flow-approval.service.js";
import { stepBatchSchema, stepExecutionService } from "../services/step-execution.service.js";
import { auditService } from "../services/audit.service.js";
import { toolRepo, type Tool } from "../repositories/tool.repo.js";
import { isPersonalTool, mayRunThrough, ownConnections, personalTools } from "../services/personal-actions.js";
import { pluginRepo } from "../repositories/plugin.repo.js";
import { connectorPieces, invokePluginTool, isPluginTool, parsePluginUrl, pluginToolName } from "../services/plugin-connector.service.js";
import { accountLine, accountOptions, askMessage, resolveAccount, type AccountOption } from "./connection-choice.js";
import { inMySpace, piecesUsed, type PiRunAs } from "../services/run-as.service.js";
import { changesAllowed, checkValues, MAX_PROPOSALS_PER_TURN, outcomeLine, performConfirmed, proposable } from "./agent-changes.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import { filesUsedBy, workspaceFileService } from "../services/workspace-file.service.js";
import { stepApprovalService } from "../services/step-approval.service.js";
import { usageService } from "../services/usage.service.js";
import { edgeDeviceService, type EdgeJobKind } from "../services/edge-device.service.js";
import { applyEdgeAlways, type EdgeAlways } from "../services/edge-trust.service.js";
import { PERSONAL_PRODUCT } from "../personal.js";
import type { RunRequester } from "../services/run-requester.js";
import type { RevisionAuthor } from "../services/revision-author.js";
import { allSteps } from "./types.js";
import {
  HOLD_PREFIX,
  heldFromId,
  heldQuestion,
  newWholeOutputAllowances,
  readWorkflowRaw,
  saysYes,
  withAllowance,
  withoutAllowances,
  withRoots,
  keyOf as allowanceKey,
  writeQuestionsRaw,
  writeWorkflowRaw,
  BLANK_PREFIX,
  blankColumnsOf,
  blankColumnsQuestion,
  blankColumnsTarget,
  withFieldAllowances,
  type BlankColumns,
  type HeldAllowance,
} from "./empty-allowance.js";
import { steerRefusal } from "./steer.js";
import { checkAnswer, multiChoices, toStored } from "./question-kinds.js";
import type {
  PiAnswered,
  PiQuestion,
  PiTestWaiting,
  PiAuthor,
  PiActivity,
  PiChatMessage,
  PiContext,
  PiEvent,
  PiSessionPublic,
  PiSessionStatus,
  PiStorage,
  PiWorkflow,
  PiProposal,
  PiSettingChange,
  PiAccountChoice,
  PiAccount,
  PiAccountQuestion,
  PiSurface,
} from "./types.js";
import { isPendingAskSurface, parseSurface } from "./surface-card.js";

type Session = {
  id: string;
  workspaceId: string;
  /** Bound Foundry flow, or null while still on /flows/new. */
  flowId: string | null;
  /** Client-issued draft key when flowId is null — isolates parallel new-flow tabs. */
  draftKey: string | null;
  /** The saved chat (0095) — null until the person's first message; a greeting alone saves nothing. */
  chatId: string | null;
  /** While the chat's record is being created — so two messages at once make one chat, not two. */
  chatPending: Promise<string> | null;
  /**
   * The project a NEW chat is saved into (sharing-boundaries phase 5): the one it was started from, else its
   * workflow's. Once saved, the chat's own row says where it lives (it can be moved), and each turn reads that.
   */
  projectId: string | null;
  /** `out/` when the turn began — what Forge made or changed is what differs after it. */
  outBefore: Map<string, string>;
  /** The key Forge's own tools present to `/api/forge/*` (`tools/ask-data.mjs`) — this conversation's, nobody else's. */
  toolToken: string;
  status: PiSessionStatus;
  goal: string;
  messages: PiChatMessage[];
  liveActivities: PiActivity[];
  lastVerify: { ok: boolean; detail: string } | null;
  lastTestRun: { ok: boolean; detail: string; summary?: string; at: string; runId: string | null; waiting?: PiTestWaiting | null; needsRealData: boolean } | null;
  acceptedSnapshotId: string | null;
  savedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  bus: EventEmitter;
  abort: AbortController | null;
  /** A test run is in progress (started in the background — `testRun`, `decideTest`). One at a time, and no turn beside it. */
  testing: boolean;
  draftText: string;
  /** The model's thinking this turn, when the provider returns it readable (thinkingFromUpdate). Empty otherwise. */
  draftThinking: string;
  /** How long it thought this turn, and when the block now open started (null between blocks). */
  thinkingMs: number;
  thinkingSince: number | null;
  /** Values the test run is started with (`$input.<name>` in workflow.json). */
  runInputs: Record<string, unknown>;
  /** The last draft run on flow-runner, so the UI can link to it. */
  lastRunId: string | null;
  /** Who the last message came from — the person a test run is "for" (e.g. whom "email me" means). */
  requester: RunRequester;
  /**
   * The workflow's `allow_empty` declarations when the person's turn began. An automatic fix round may not add one:
   * declaring an output "may be empty" is the easy way to turn a hollow test green, and only the person may accept that.
   */
  allowancesAtTurn: string[];
  /** Whole-output allowances taken out after a turn and put to the person (`empty-allowance.ts`), until answered. */
  heldAllowances: HeldAllowance[];
  /**
   * Whole-output allowances the person answered NO to ("step:output"). Forge adding one again is stripped without
   * asking: the question was answered. Kept for the session in memory only — a reopened chat may be asked once more.
   */
  declinedAllowances: string[];
  /**
   * The fix rounds now running follow a test the person started on REAL data. Their automatic re-test reads real data
   * too: a failure found there and re-tested on invented rows "passes" on data that never showed it (chat eb205c03).
   * Cleared when the person starts a turn — their consent was to that test and the fixes it set off.
   */
  fixOnRealData: boolean;
  /**
   * Whether the last test read real data. A card that test raised (blank columns, an empty result) is answered and
   * the test runs again — on the SAME data (chat 1c2f85e5): a real-data test of 103,974 rows asked about two blank
   * columns, and the re-test after the answer ran on test data, found no rows for the month and failed.
   */
  lastTestRealData: boolean;
  /**
   * The failure the running fix round was started on. A fix round that fails with the same text again made no
   * progress, so the loop stops instead of spending another round. Cleared when the person starts a turn.
   */
  lastFixFailure: string | null;
  /**
   * 2026-11-03: the large-table list last told to the person in this session ('' = none), so a passing re-test
   * does not repeat the same note.
   */
  lastVolumeNote: string;
  /** The columns the last test run found blank in every row (empty-allowance.ts `blankColumnsOf`); [] once it passed. */
  lastBlank: BlankColumns[];
  /** The last test's empty-data findings, told to Forge with the person's next message (then cleared). */
  lastEmptyDetail: string | null;
  /** The last model-call error Pi reported in this turn (raw) — explained on the failure card if the turn fails. */
  lastModelError: string | null;
  /** What the last turn told Forge, so Try again re-runs it without a second copy of the person's message. */
  lastTurn: { userText: string; fixRound: number } | null;
  /** When someone last had this conversation open (a connection opened or closed, or a message arrived). */
  lastSeenAt: number;
  /** The context meter: last measured, kept when Forge has exited. */
  context: PiContext | null;
  compacting: boolean;
  /** Workflow Builder or Forge Agent (0097). Forge's instructions are this mode's; a switch restarts its process. */
  mode: ChatMode;
  /** How hard Forge Agent thinks (0119). Its process runs with this effort; a change restarts it. */
  thinking: ThinkingLevel;
  /** The model this chat chose (0135); null = the builder's default. A change restarts Forge. */
  model: string | null;
  /** The builder's models as last read (resolveGenerationProvider): at open, every turn, and a model change. */
  generation: Generation | null;
  /** Chat owner's subject — personal BYOK resolves this person's AI connection for Forge. */
  ownerSubject: string | null;
  /** Whether the workspace offers Forge Agent, as last read (at open, at every turn, at a switch). */
  agentAllowed: boolean;
  /** A Forge Agent turn changed the workflow and it was put back: the next turn tells Forge so. */
  workflowRestored: boolean;
  /** How full the folder is, as last measured. */
  storage: PiStorage;
  /** Files the person removed since the last turn: the next turn tells Forge not to use them. */
  removedFiles: string[];
  /** The chat's files on disk when the turn started: any gone at its end, Forge deleted (`forgetDeletedFiles`). */
  filesBefore: Set<string>;
  /**
   * Saved workflows this chat learns from (reference-state.ts), in the order they were added. Held here before the
   * chat has a record, stored from then on.
   */
  refs: SessionRef[];
  /** Pins the person moved since the last turn: told to Forge once, so it does not mix the old version in. */
  refsMoved: string[];
  /** Who last sent a message, as verified — whose read access the references are re-checked against each turn. */
  reader: Identity | null;
  /** Changes Forge Agent proposed during the running turn (agent-changes.ts); they go onto its reply as cards. */
  proposals: PiProposal[];
  /** What became of proposals since the last turn (confirmed, done, failed, declined): told to Forge, then cleared. */
  proposalOutcomes: string[];
  /** Which connection this chat uses per service, chosen by the person (connection-choice.ts, pi_chats.connection_choices). */
  accounts: Record<string, PiAccountChoice>;
  /** What a workflow account card stopped (a test, with its options, or a save): a test runs again once they choose. */
  accountResume?: { kind: "test"; opts: Parameters<typeof verifyAndRun>[2] } | { kind: "save" };
  /**
   * Edge jobs that finished while a turn was still running: Forge continues with each result once idle.
   * Without this, the chat dumps stdout and then sits on Ready until the person says "okay".
   */
  pendingEdgeContinues: Array<{ jobId: string; told: string }>;
  /** Job ids already handed to a continuation turn — never continue the same settle twice. */
  edgeContinued: Set<string>;
};

/**
 * After a turn: any whole-output `allow_empty` Forge added comes out of the workflow and becomes a question for the
 * person (`empty-allowance.ts`). True when something was held, so the automatic test waits for the answer.
 */
function holdNewAllowances(s: Session): boolean {
  const raw = readWorkflowRaw(s.workspaceId, s.id);
  if (!raw) return false;
  const fresh = newWholeOutputAllowances(raw, s.allowancesAtTurn);
  if (!fresh.length) return false;
  // An allowance the person already answered NO to is not asked again (it was, in chat eb205c03).
  const refused = fresh.filter((h) => s.declinedAllowances.includes(allowanceKey(h.stepId, h.output)));
  let wf = withoutAllowances(raw, refused);
  for (const h of refused)
    pushNote(s, `"${h.output}" was answered earlier: it must not come back empty, so Forge's allowance was not applied.`);
  const held = withRoots(wf, fresh.filter((h) => !refused.includes(h)));
  // Derived only from allowances the person already accepted: empty because its inputs may be — that answer stands.
  const inherited = held.filter((h) => h.follows && !h.follows.length);
  for (const h of inherited) {
    s.allowancesAtTurn = [...s.allowancesAtTurn, allowanceKey(h.stepId, h.output)];
    pushNote(s, `"${h.output}" may come back empty: it is built only from outputs you already said may be empty.`);
  }
  const pending = held.filter((h) => !inherited.includes(h));
  wf = withoutAllowances(wf, pending);
  writeWorkflowRaw(s.workspaceId, s.id, wf);
  // "The whole output may have no rows" is not an answer to "these columns are blank in every row" — the test found
  // rows. Asked as the whole-output question it gets an honest "no" and the columns are left failing (chat 25d67dbd).
  // So on an output the last test found blank columns in, the person is asked about those columns instead.
  const blankOf = (h: HeldAllowance) => s.lastBlank.find((b) => b.stepId === h.stepId && b.output === h.output);
  const columns = pending.filter(blankOf);
  const roots = pending.filter((h) => !blankOf(h) && !h.follows);
  const rootKeys = new Set(roots.map((h) => allowanceKey(h.stepId, h.output)));
  // A derived allowance whose roots are not being asked (a blank-columns output instead) is left out with them.
  const derived = pending
    .filter((h) => !blankOf(h) && h.follows)
    .map((h) => ({ ...h, follows: h.follows!.filter((k) => rootKeys.has(k)) }))
    .filter((h) => h.follows.length);
  if (!roots.length && !columns.length) {
    refreshFiles(s);
    return false;
  }
  s.heldAllowances = [...roots, ...derived];
  const existing = (readQuestions(s.workspaceId, s.id).questions ?? []).filter(
    (q) => !q.id.startsWith(HOLD_PREFIX) && !q.id.startsWith(BLANK_PREFIX),
  );
  const blankQs = s.lastBlank.filter((b) => columns.some((h) => h.stepId === b.stepId && h.output === b.output)).map(blankColumnsQuestion);
  const derivedOf = (r: HeldAllowance) => derived.filter((d) => d.follows.includes(allowanceKey(r.stepId, r.output)));
  writeQuestionsRaw(s.workspaceId, s.id, [...existing, ...roots.map((r) => heldQuestion(r, derivedOf(r))), ...blankQs]);
  if (columns.length) {
    pushNote(
      s,
      `Forge marked ${columns.map((h) => `"${h.output}"`).join(", ")} as allowed to come back with no rows at all, but the ` +
        `test found rows with columns blank in every one of them, not an empty result. That was not applied: choose on ` +
        `the card which columns can be blank.`,
    );
  }
  refreshFiles(s);
  setStatus(s, "awaiting_answers");
  emit(s, { type: "questions", questions: readQuestions(s.workspaceId, s.id) });
  return true;
}

/** Apply the person's answers to held allowances: yes writes the allowance back, anything else leaves it out. */
function settleHeldAllowances(
  s: Session,
  answers: Record<string, string>,
  asked: PiQuestion[],
  by: PiAuthor | null,
): boolean {
  const decided = Object.entries(answers).filter(([id]) => id.startsWith(HOLD_PREFIX));
  if (!decided.length) return false;
  let wf = readWorkflowRaw(s.workspaceId, s.id);
  const lines: string[] = [];
  const answered: PiAnswered[] = [];
  for (const [id, answer] of decided) {
    const h = heldFromId(id, s.heldAllowances);
    if (!h) continue;
    const q = asked.find((x) => x.id === id);
    answered.push({ id, prompt: q?.prompt ?? id, ...(q?.choices?.length ? { choices: q.choices } : {}), answer });
    const key = allowanceKey(h.stepId, h.output);
    if (saysYes(answer)) {
      wf = withAllowance(wf, h);
      s.allowancesAtTurn = [...s.allowancesAtTurn, key];
      lines.push(`"${h.output}" may come back empty.`);
      // What is built only from it follows the answer (empty-allowance.ts `withRoots`).
      for (const d of s.heldAllowances.filter((x) => x.follows?.includes(key))) {
        wf = withAllowance(wf, d);
        s.allowancesAtTurn = [...s.allowancesAtTurn, allowanceKey(d.stepId, d.output)];
        lines.push(`"${d.output}" may come back empty too: it is built from it.`);
        s.heldAllowances = s.heldAllowances.filter((x) => x !== d);
      }
    } else {
      s.declinedAllowances = [...s.declinedAllowances, key];
      lines.push(`"${h.output}" must not come back empty: a run that finds nothing stops and says so.`);
    }
    s.heldAllowances = s.heldAllowances.filter((x) => x !== h);
  }
  // A derived allowance whose roots were all answered no is left out with them.
  const open = new Set(s.heldAllowances.filter((x) => !x.follows).map((x) => allowanceKey(x.stepId, x.output)));
  s.heldAllowances = s.heldAllowances.filter((x) => !x.follows || x.follows.some((k) => open.has(k)));
  writeWorkflowRaw(s.workspaceId, s.id, wf);
  writeQuestionsRaw(
    s.workspaceId,
    s.id,
    asked.filter((q) => !decided.some(([id]) => id === q.id)),
  );
  refreshFiles(s);
  const msg: PiChatMessage = {
    id: randomUUID(),
    role: "user",
    text: answered.map((a) => `${a.prompt}\n→ ${a.answer}`).join("\n\n"),
    at: new Date().toISOString(),
    answers: answered,
    ...(by ? { by } : {}),
  };
  s.messages.push(msg);
  emit(s, { type: "message", message: msg });
  const note: PiChatMessage = { id: randomUUID(), role: "system", text: lines.join(" "), at: new Date().toISOString() };
  s.messages.push(note);
  emit(s, { type: "message", message: note });
  persistChat(s);
  return true;
}

/**
 * Apply the person's answers to blank-columns questions (empty-allowance.ts): the ticked columns are written onto the
 * step as field allowances; the rest are returned as what Forge must fix — columns that must have values.
 */
function settleBlankColumns(
  s: Session,
  answers: Record<string, string>,
  asked: PiQuestion[],
  by: PiAuthor | null,
): { settled: boolean; mustFill: string[] } {
  const decided = Object.entries(answers).filter(([id]) => id.startsWith(BLANK_PREFIX));
  if (!decided.length) return { settled: false, mustFill: [] };
  let wf = readWorkflowRaw(s.workspaceId, s.id);
  const lines: string[] = [];
  const mustFill: string[] = [];
  const answered: PiAnswered[] = [];
  for (const [id, answer] of decided) {
    const q = asked.find((x) => x.id === id);
    const t = blankColumnsTarget(id);
    if (!q || !t) continue;
    const listed = q.choices ?? [];
    const allowed = multiChoices(answer).filter((f) => listed.includes(f));
    const fill = listed.filter((f) => !allowed.includes(f));
    answered.push({ id, prompt: q.prompt, choices: listed, answer });
    if (allowed.length) {
      wf = withFieldAllowances(wf, t.stepId, t.output, allowed);
      s.allowancesAtTurn = [...s.allowancesAtTurn, ...allowed.map((f) => `${t.stepId}:${t.output}:${f}`)];
      lines.push(`May be blank in every row: ${allowed.map((f) => `"${f}"`).join(", ")}.`);
    }
    if (fill.length) {
      lines.push(`Must have values: ${fill.map((f) => `"${f}"`).join(", ")}. Forge will fix the step.`);
      mustFill.push(
        `In step ${t.stepId}, these columns of "${t.output}" came back blank in every row on the test, and the person says ` +
          `they must have values: ${fill.map((f) => JSON.stringify(f)).join(", ")}. Fix the read or the code so they are ` +
          `filled. Do not add "allow_empty" for them.`,
      );
    }
  }
  if (!answered.length) return { settled: false, mustFill: [] };
  writeWorkflowRaw(s.workspaceId, s.id, wf);
  writeQuestionsRaw(
    s.workspaceId,
    s.id,
    asked.filter((q) => !decided.some(([id]) => id === q.id)),
  );
  s.lastBlank = [];
  s.lastEmptyDetail = null;
  refreshFiles(s);
  const msg: PiChatMessage = {
    id: randomUUID(),
    role: "user",
    text: answered.map((a) => `${a.prompt}\n→ ${a.answer}`).join("\n\n"),
    at: new Date().toISOString(),
    answers: answered,
    ...(by ? { by } : {}),
  };
  s.messages.push(msg);
  emit(s, { type: "message", message: msg });
  pushNote(s, lines.join(" "));
  return { settled: true, mustFill };
}

/** Every `allow_empty` declaration in the workflow, as "step:output[:field]". */
function allowancesOf(wf: PiWorkflow): string[] {
  return allSteps(wf.steps).flatMap((st) =>
    (Array.isArray(st.allow_empty) ? st.allow_empty : []).map((a) => `${st.id}:${a?.output ?? ""}${a?.field ? `:${a.field}` : ""}`),
  );
}

const sessions = new Map<string, Session>();
/** Forge's tool key → its conversation (`/api/forge/*`). */
const toolTokens = new Map<string, string>();
/** One live session per (workspace, scope). Scope = flow:<id> | draft:<key>. */
const scopeIndex = new Map<string, string>();

/** The model a chat's Forge runs with: its own choice while the admin still allows it, else the builder's default. */
function forgeModelOf(s: Session): string {
  return effectiveModel(s.model, s.generation, piModel());
}

async function loadGeneration(subject?: string | null): Promise<Generation | null> {
  return resolveGenerationProvider(subject)
    .then((g) => ({ model: g.model, allowedModels: g.allowedModels }))
    .catch(() => null);
}

/** Live Forge processes — one per open conversation, timed out and capped (forge-pool.ts). */
const forgePool = new ForgePool({
  spawn: (workspaceId, sessionId) => {
    const s = sessions.get(sessionId);
    return new ForgeProcess({ workspaceId, sessionId, effort: s ? reasoningEffort(s.mode, s.thinking) : "none", model: s ? forgeModelOf(s) : undefined });
  },
  maxLive: config.forge.maxLive,
  maxPerWorkspace: config.forge.maxLivePerWorkspace,
  idleMs: config.forge.idleMs,
  leaveGraceMs: config.forge.leaveGraceMs,
});
// The processes lead their own groups (so a stop reaches what they started) — which also means they would outlive
// this server. Take them down with it.
process.once("exit", () => forgePool.releaseAll());

/** At most this many rows of a chat data read go back to Forge — it answers from them; the count is always true. */
const ASK_ROWS = 200;

/** A session file larger than this is not stored — Pi compacts long conversations, so this is a fault, not a chat. */
const MAX_SESSION_BYTES = 10 * 1024 * 1024;

/**
 * Keep Forge's session file with the chat (0095), so a conversation that left memory — or a server restart —
 * resumes with its history. Only once the chat is saved (the person's first message). Fire-and-forget, like the chat.
 */
function persistForgeSession(s: Session) {
  if (!s.chatId) return;
  const file = forgeSessionFile(s.workspaceId, s.id);
  try {
    if (!existsSync(file)) return;
    // A link here (Forge can write its own folder) would store a server file as the chat's history, and the next
    // reopen would hand it to Forge.
    if (lstatSync(file).isSymbolicLink() || !confined(file)) return;
    if (statSync(file).size > MAX_SESSION_BYTES) {
      console.warn(`[pi-builder] Forge's session for chat ${s.chatId} is over ${MAX_SESSION_BYTES} bytes; not stored`);
      return;
    }
    const text = readFileSync(file, "utf8");
    void piChatRepo.update(s.chatId, { forgeSession: text }).catch((e) => {
      console.warn(`[pi-builder] could not store Forge's session for chat ${s.chatId}: ${(e as Error).message}`);
    });
  } catch (e) {
    console.warn(`[pi-builder] could not read Forge's session for chat ${s.chatId}: ${(e as Error).message}`);
  }
}

/**
 * A conversation nobody has had open for `forgetAfterMs` leaves server memory (its sandbox with it); a saved flow's
 * chat and Forge session are in the database and come back on the next open. Unsaved changes do not — the same as
 * closing the page always did, but after half an hour instead of at once.
 *
 * ⚠ A DRAFT (no workflow yet) goes after `DRAFT_FORGET_MS`, not half an hour (2026-10-12). /flows/new mints a fresh
 * draft key on every load, so once its page is gone nothing can ever rejoin it: keeping it only held a sandbox, a
 * Forge process and its attachments for nobody. The short grace covers a dropped connection on a page still open.
 */
const DRAFT_FORGET_MS = 2 * 60_000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.abort || s.testing || forgePool.connections(s.id) > 0) continue;
    if (now - s.lastSeenAt < (s.flowId || s.chatId ? config.forge.forgetAfterMs : DRAFT_FORGET_MS)) continue;
    persistChat(s);
    persistForgeSession(s);
    destroySession(s);
  }
}, 60_000);
sweeper.unref();

function scopeKey(workspaceId: string, flowId: string | null, chatId: string | null, draftKey: string | null): string {
  if (flowId) return `${workspaceId}::flow:${flowId}`;
  if (chatId) return `${workspaceId}::chat:${chatId}`;
  if (draftKey) return `${workspaceId}::draft:${draftKey}`;
  return `${workspaceId}::session-ephemeral`;
}

function httpErr(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function touch(s: Session) {
  s.updatedAt = new Date().toISOString();
}

function emit(s: Session, ev: PiEvent) {
  s.bus.emit("event", ev);
}

/**
 * Keep the conversation in its saved chat (0095), so reopening it — or a server restart — does not lose it. Only once
 * the chat exists (the person's first message). A chat with no saved workflow also keeps what it has built so far
 * (`draft_bundle`), so it reopens with its steps. The welcome is never stored. Fire-and-forget: a failed write is
 * logged, never a failed turn.
 */
function persistChat(s: Session) {
  if (!s.chatId) return;
  const messages = s.messages.filter((m) => !m.welcome);
  const draftBundle = s.flowId ? null : { ...readBundle(s.workspaceId, s.id), goal: s.goal };
  void piChatRepo.update(s.chatId, { messages, draftBundle, goal: s.goal, connectionChoices: s.accounts }).catch((e) => {
    console.warn(`[pi-builder] could not store chat ${s.chatId}: ${(e as Error).message}`);
  });
}

/** A chat's title: the person's first message on one line, cut at a word near 80 characters. */
export function chatTitle(text: string, files: string[], goal: string): string {
  const line = (text || goal).replace(/\s+/g, " ").trim();
  if (line) {
    if (line.length <= 80) return line;
    const cut = line.slice(0, 80);
    const at = cut.lastIndexOf(" ");
    return `${(at > 40 ? cut.slice(0, at) : cut).trim()}…`;
  }
  return files[0] ?? "Untitled chat";
}

/** The saved chat for this conversation, created on the person's first message (once, however many arrive at once). */
async function ensureChat(s: Session, title: string, by: PiAuthor | null): Promise<string> {
  if (s.chatId) return s.chatId;
  if (!s.chatPending) {
    s.chatPending = piChatRepo
      .create({ workspaceId: s.workspaceId, flowId: s.flowId, title, goal: s.goal, createdBy: by, mode: s.mode, thinking: s.thinking, model: s.model, projectId: s.projectId })
      .then(async (id) => {
        s.chatId = id;
        // References picked before the first message are stored with the chat now.
        for (const [i, r] of s.refs.entries()) {
          if (!r.stored) s.refs[i] = await storeRef(s.workspaceId, id, r).catch(() => r);
        }
        // A draft is now found by its chat: reopening `?chat=<id>` joins this conversation.
        if (!s.flowId) {
          const oldSk = scopeKey(s.workspaceId, null, null, s.draftKey);
          if (scopeIndex.get(oldSk) === s.id) scopeIndex.delete(oldSk);
          s.draftKey = null;
          scopeIndex.set(scopeKey(s.workspaceId, null, id, null), s.id);
        }
        emit(s, { type: "chat", chatId: id });
        return id;
      })
      .finally(() => {
        s.chatPending = null;
      });
  }
  return s.chatPending;
}

/**
 * After a turn: the files Forge made or changed in `out/` are kept with the chat (origin `forge`), and returned for
 * the reply's download cards. What cannot be kept is said, with why. A name the person's own file already has keeps
 * both: Forge's is renamed on disk to the name it was stored under, so the two never disagree.
 */
async function keepOutputs(s: Session): Promise<{ made: PiAttachment[]; refused: string[] }> {
  const { kept, refused } = newOutputs(s.workspaceId, s.id, s.outBefore);
  s.outBefore = outSnapshot(s.workspaceId, s.id);
  if (!kept.length) return { made: [], refused: refused.map((r) => `${r.name} (${r.why})`) };
  const chatId = await ensureChat(s, chatTitle("", [], s.goal), null);
  const made: PiAttachment[] = [];
  for (const f of kept) {
    const name = await piChatRepo.putForgeFile(chatId, s.workspaceId, { name: f.name, contentType: f.type, body: f.body });
    if (name !== f.name) renameSync(join(outDir(s.workspaceId, s.id), f.name), join(outDir(s.workspaceId, s.id), name));
    made.push({ name, size: f.body.length, type: f.type });
  }
  s.outBefore = outSnapshot(s.workspaceId, s.id);
  return { made, refused: refused.map((r) => `${r.name} (${r.why})`) };
}

/** Mark a file's cards in the conversation as removed (they keep its name; nothing downloads). True when any named it. */
function markRemoved(s: Session, name: string): boolean {
  let mentioned = false;
  for (const m of s.messages) {
    for (const key of ["attachments", "files"] as const) {
      const list = m[key];
      if (!list?.some((f) => f.name === name)) continue;
      mentioned = true;
      m[key] = list.map((f) => (f.name === name ? { ...f, removed: true } : f));
    }
  }
  return mentioned;
}

/**
 * The files Forge deleted this turn (on disk at its start, gone at its end) leave the chat's record and their cards are
 * marked removed (2026-10-14). The record used to keep them — and lay them back out on the next open — so a reply
 * saying "I removed the old files" was contradicted by the Files list. Forge did it, so Forge is not told about it.
 */
async function forgetDeletedFiles(s: Session): Promise<string[]> {
  const now = chatFileNames(s.workspaceId, s.id);
  const gone = [...s.filesBefore].filter((n) => !now.has(n));
  s.filesBefore = now;
  if (!gone.length) return [];
  for (const name of gone) {
    if (s.chatId) await piChatRepo.removeFile(s.chatId, name);
    markRemoved(s, name);
  }
  emit(s, { type: "messages", messages: s.messages });
  return gone;
}

/**
 * At save: every `file:<name>` the workflow reads that is not yet in the workspace's Files, but is in this chat, is
 * copied there. A name the workspace already has with DIFFERENT contents is never overwritten — the save is refused
 * and says how to settle it — because a running workflow reads files by name and another workflow may rely on it.
 * The same contents under the same name is already there and needs nothing. Returns the names copied.
 */
async function copyChatFilesToWorkspace(s: Session, workflow: unknown, author: RevisionAuthor): Promise<string[]> {
  const wanted = filesUsedBy({ workflow });
  const toCopy: Array<{ name: string; body: Buffer }> = [];
  for (const name of wanted) {
    const mine = chatFileOnDisk(s.workspaceId, s.id, name);
    const theirs = await workspaceFileService.read(s.workspaceId, { name });
    if (!mine) continue; // in Files only: the verifier already checked it is there
    if (theirs) {
      if (Buffer.compare(theirs.data, mine.body) === 0) continue;
      throw httpErr(
        `Not saved. The workspace's Files already has a different file named "${name}", and the workflow reads files ` +
          `by name. Ask me to give this chat's copy a new name, or delete the one in Resources → Files if it is no ` +
          `longer needed, then save again.`,
        409,
      );
    }
    toCopy.push({ name, body: mine.body });
  }
  for (const f of toCopy) await workspaceFileService.upload(s.workspaceId, encodeURIComponent(f.name), f.body, author.createdBy);
  return toCopy.map((f) => f.name);
}

/** Copy the files a message sends into its chat's record. A file that cannot be read is refused, never dropped. */
async function keepSentFiles(s: Session, chatId: string, files: PiAttachment[]): Promise<void> {
  for (const f of files) {
    const body = readAttachment(s.workspaceId, s.id, f.name);
    if (!body) throw httpErr(`The attached file "${f.name}" is no longer here. Please attach it again.`, 400);
    await piChatRepo.putFile(chatId, s.workspaceId, { name: f.name, contentType: f.type, body });
  }
}

function refreshFiles(s: Session) {
  const bundle = readBundle(s.workspaceId, s.id);
  emit(s, { type: "workflow", workflow: bundle.workflow, files: bundle.files });
  emit(s, { type: "questions", questions: readQuestions(s.workspaceId, s.id) });
}

function setStatus(s: Session, status: PiSessionStatus) {
  s.status = status;
  touch(s);
  emit(s, { type: "status", status });
}

function publicOf(s: Session): PiSessionPublic {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    flowId: s.flowId,
    draftKey: s.draftKey,
    chatId: s.chatId,
    status: s.status,
    goal: s.goal,
    messages: s.messages,
    liveActivities: s.liveActivities,
    draftText: s.status === "running" ? s.draftText : "",
    draftThinking: s.status === "running" ? s.draftThinking : "",
    workflow: readWorkflow(s.workspaceId, s.id),
    files: readBundle(s.workspaceId, s.id).files,
    questions: readQuestions(s.workspaceId, s.id),
    answers: readAnswers(s.workspaceId, s.id),
    lastVerify: s.lastVerify,
    lastTestRun: s.lastTestRun,
    lastRunId: s.lastRunId,
    acceptedSnapshotId: s.acceptedSnapshotId,
    savedRevision: s.savedRevision,
    model: forgeModelOf(s),
    models: modelChoices(s.generation, piModel()),
    context: s.context,
    compacting: s.compacting,
    mode: s.mode,
    thinking: s.thinking,
    agentAllowed: s.agentAllowed,
    accounts: s.accounts,
    storage: s.storage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function getOrThrow(workspaceId: string, sessionId: string): Session {
  const s = sessions.get(sessionId);
  if (!s || s.workspaceId !== workspaceId) {
    const err = new Error("session not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  return s;
}

/** A waiting draft test is only decideable from this session's card — cancel it when the session goes. */
function cancelWaitingTest(s: Session): void {
  const runId = s.lastRunId;
  if (!runId || !s.lastTestRun?.waiting) return;
  void flowRunnerService.cancel(runId).catch((e) => {
    console.warn(`[pi-builder] could not cancel waiting test ${runId} for session ${s.id}: ${(e as Error).message}`);
  });
}

function destroySession(s: Session): void {
  forgePool.release(s.id);
  if (s.abort) {
    try {
      s.abort.abort();
    } catch {
      /* ignore */
    }
  }
  cancelWaitingTest(s);
  s.bus.removeAllListeners();
  sessions.delete(s.id);
  toolTokens.delete(s.toolToken);
  const sk = scopeKey(s.workspaceId, s.flowId, s.chatId, s.draftKey);
  if (scopeIndex.get(sk) === s.id) scopeIndex.delete(sk);
  // The chat's files are in its record; what is on disk goes with the tree (an unsent file with it).
  destroySessionTree(s.workspaceId, s.id);
}

/** True when the message looks like an automation request, not chat. */
function looksLikeAutomationGoal(text: string): boolean {
  const t = text.trim();
  if (t.length < 16) return false;
  if (
    /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|good morning|good afternoon)\b/i.test(t) &&
    t.length < 48
  ) {
    return false;
  }
  if (
    /^(what can you|who are you|help|how (do|does|can)|what(?:'?s| is) (this|here))\b/i.test(t) &&
    t.length < 80
  ) {
    return false;
  }
  return true;
}

/** The named files, each one stored for this conversation — a name that is not there is refused, never dropped. */
function attachedFiles(s: Session, names: string[]): PiAttachment[] {
  if (names.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw httpErr(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} files can be sent with one message.`, 400);
  }
  return [...new Set(names)].map((n) => {
    const f = findAttachment(s.workspaceId, s.id, n);
    if (!f) throw httpErr(`The attached file "${n}" is no longer here. Please attach it again.`, 400);
    return f;
  });
}

function sizeWords(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What the agent is told about a message's files: where they are and how to read them. */
export function withAttachments(text: string, files: PiAttachment[]): string {
  if (!files.length) return text;
  const lines = [
    text || "(No message. The person sent only the attached files.)",
    "",
    "The person attached these files to this message (stored in files/):",
    ...files.map((f) => `- files/${f.name} (${f.type}, ${sizeWords(f.size)})`),
    "Read every one of them before you answer: `node tools/read-file.mjs files/<name>` prints a document's text " +
      "(PDF, Word, Excel, CSV, text); open an image with your read tool.",
    "These files come first. They are the person's own spec: what the result should look like, which fields, " +
      "names, rules and recipients. Where a file disagrees with your assumptions, the workspace defaults or an " +
      "earlier answer, follow the file, unless this message says otherwise. Say which file you followed. If two " +
      "files disagree, ask which one wins.",
    "If they ask for a file made or changed, write the result to out/<name> and never change files/. A workflow built " +
      "here reads one with foundry.file(\"<name>\") (see SYSTEM.md, Files in this chat). Refer to a file by its name, " +
      "never by its path.",
  ];
  return lines.join("\n");
}

/** The workspace as Forge must see it on THIS turn: its purpose and whether assistant mode is on (SYSTEM.md). */
export type TurnWorkspace = {
  purpose: string | null;
  assistant: boolean;
  files?: string[];
  /** Plugins POC — the workspace's plugin tools (connected services), named so Forge Agent can read from them. */
  plugins?: string[];
  /** Forge Agent may propose changes to connected services for the person to confirm (agent-changes.ts). */
  changes?: boolean;
  /** Who Forge is talking to, so "my tasks" and "me" name a real person rather than a guess. */
  person?: { name: string | null; email: string | null } | null;
  /** What became of Forge's proposed changes since its last turn. */
  outcomes?: string[];
  /**
   * Every connected service this person can reach here, one line each (agent-grants.ts `serviceLine`) — said whether
   * or not any action is on, so Forge never has to guess a service's name. Undefined when it could not be read.
   */
  services?: string[];
  /** Actions the chat's person switched on for themselves (plans/personal-actions-2026-10-29), through their own account. */
  myTools?: string[];
  /** Forge Agent may propose switching an action on or off (agent-grants.ts). */
  settings?: boolean;
  /** The project this chat lives in (sharing-boundaries phase 5): its shared instructions start every turn. */
  project?: { name: string; instructions: string; files?: string[]; memories?: Array<{ kind: string; body: string }> } | null;
};

/** At most this many workspace File names are listed per turn; the catalogue has them all. */
const TURN_FILE_NAMES = 60;

/**
 * The project's shared context (sharing-boundaries phase 5), said every turn because a chat can be moved and the
 * instructions edited between turns. Written by the project's people, for the people in it: it shapes how Forge works
 * here, and it never widens what Forge may do (SYSTEM.md still rules).
 */
export function projectLines(p: TurnWorkspace["project"]): string[] {
  if (!p) return [];
  const text = p.instructions.trim();
  const memories = p.memories?.filter((m) => m.body.trim()) ?? [];
  return [
    `This chat is in the project “${p.name}”. Everything made here is seen by the project's members.`,
    ...(text ? [`The project's shared instructions (from its members; follow them where SYSTEM.md allows):\n${text.slice(0, PROJECT_INSTRUCTIONS_MAX)}`] : []),
    ...(memories.length
      ? [
          `The project's remembered facts (accepted by its members; follow them where SYSTEM.md allows — do not invent extras):\n${memories
            .map((m) => `- [${m.kind}] ${m.body.trim()}`)
            .join("\n")}`,
        ]
      : []),
    ...(p.files?.length
      ? [
          `The project's files (shared by its members; open one with node tools/open-file.mjs --project "<name>"; never ask for one of these to be uploaded): ${p.files
            .slice(0, TURN_FILE_NAMES)
            .map((n) => JSON.stringify(n))
            .join(", ")}${p.files.length > TURN_FILE_NAMES ? `, and ${p.files.length - TURN_FILE_NAMES} more` : ""}.`,
        ]
      : []),
  ];
}
const PROJECT_INSTRUCTIONS_MAX = 8000;
/** Unread is not "none": when the Files list could not be read, the line is left out and catalogue.json speaks. */
const FILES_UNREAD = "\u0000files-unread";

export function workspaceLines(ws: TurnWorkspace): string[] {
  const files = ws.files ?? [];
  const lines = [
    `Workspace purpose: ${ws.purpose?.trim() || "(not stated; treat it as a general workspace for building workflows)"}`,
    ...projectLines(ws.project),
    ws.assistant
      ? "Real data: you may read it, with tools/ask-data.mjs and a datasource name from catalogue.json (SYSTEM.md, This workspace)."
      : "Real data: this workspace does not let you read it. Do not run tools/ask-data.mjs (SYSTEM.md, This workspace).",
    // Listed every turn (2026-10-13): Forge asked a person to upload files that were sitting in Resources → Files,
    // because it read Files as something only a workflow step opens. The names here are the ones it can open now.
    files.length
      ? `Workspace Files (Resources → Files; open one with tools/open-file.mjs; never ask for one of these to be uploaded): ${files
          .slice(0, TURN_FILE_NAMES)
          .map((n) => JSON.stringify(n))
          .join(", ")}${files.length > TURN_FILE_NAMES ? `, and ${files.length - TURN_FILE_NAMES} more in catalogue.json` : ""}.`
      : ws.files === undefined
        ? FILES_UNREAD
        : "Workspace Files (Resources → Files): none.",
  ];
  // ⚠ Which services this person can reach is said EVERY turn, whether or not any action is on (2026-10-29). It was
  // said only when tools were on, so a service connected with nothing switched on yet — the usual state right after
  // connecting — was invisible, and Forge guessed names ("github", "Foundry") and told the person it was not connected.
  if (ws.assistant && ws.services) {
    lines.push(
      ws.services.length
        ? `Connected services you can use here: ${ws.services.join("; ")}. Use these names with node tools/connector-actions.mjs <service>; never guess one.`
        : "Connected services: none you can use in this workspace. If the job needs one, say they can connect it as themselves (Apps → the service → Connect as yourself) or ask an Admin to connect it for the workspace.",
    );
  }
  // Said only where there are workspace tools AND the workspace lets Forge read real data.
  if (ws.assistant && ws.plugins?.length) {
    lines.push(
      `On for the workspace: read from them now with node tools/use-plugin.mjs <tool name> '<JSON params>', ` +
        `params named as catalogue.json names them (read each tool's parameter descriptions there). Tools: ${ws.plugins.map((n) => JSON.stringify(n)).join(", ")}. ` +
        (ws.changes
          ? "A tool that CHANGES something (create, update, close, comment, send) is not run by you: propose it with node tools/propose-change.mjs <tool name> '<JSON params>' \"<one line of what it does>\" and the person confirms it on a card (SYSTEM.md, Changing things). A tool that deletes is never done from chat."
          : "A tool that changes or deletes something is refused here: this workspace lets you read connected services, not change them. Say a super admin can allow confirmed changes in the workspace's settings, or a workflow can do it after approval."),
    );
  }
  // Their own actions are said in both modes: a workflow may call one (it then runs as its owner's own account).
  const mine = (ws.myTools ?? []).filter((t) => !ws.plugins?.includes(t));
  if (mine.length) {
    lines.push(
      `On for this person only, through their own account (inputs in catalogue.mine.json, the same shape as catalogue.json's entries): ${mine.map((n) => JSON.stringify(n)).join(", ")}. ` +
        (ws.assistant ? "Read from them now with node tools/use-plugin.mjs like any connected-service tool; a change is proposed, as for any other. " : "") +
        "A workflow may call one with foundry.call like any tool: it then runs as the workflow's owner's own account, and only while they keep it on.",
    );
  }
  if (ws.person && (ws.person.name || ws.person.email)) {
    lines.push(
      `You are talking to ${[ws.person.name, ws.person.email && `<${ws.person.email}>`].filter(Boolean).join(" ")}. "Me", "my" and "mine" mean this person: use their name or email to find their own items (assigned to them, created by them).`,
    );
  }
  if (ws.assistant && ws.settings) {
    lines.push(
      "An action of a connected service that is not switched on: list them with node tools/connector-actions.mjs <service> (each with its inputs), and propose switching one on with node tools/propose-setting.mjs <service> <action> on \"<why, in a line>\". The person chooses on a card whether it is for themselves (every chat of theirs, and workflows they own) or the whole workspace (SYSTEM.md, Switching actions on).",
    );
  }
  for (const o of ws.outcomes ?? []) lines.push(o);
  // Unread is not "none": when the list could not be read, say nothing and let catalogue.json speak.
  return ws.files === undefined ? lines.filter((l) => l !== FILES_UNREAD) : lines;
}

export function buildPrompt(
  userText: string,
  goal: string,
  ws: TurnWorkspace = { purpose: null, assistant: false },
  mode: ChatMode = "workflow",
  workflowRestored = false,
  /** The referenced workflows' section (references.ts `cardsBlock`); Workflow Builder only. */
  references: string[] = [],
): string {
  const lines = [
    ...workspaceLines(ws),
    `This chat is in ${MODE_NAME[mode]} mode (SYSTEM.md, This chat).`,
    ...(mode === "agent"
      ? [
          "Do the job now. Never change workflow.json, GOAL.md or steps/: this chat's workflow is not yours to change here. A job that should repeat on its own is a workflow: say they can turn off the Forge Agent switch under the message box to build it.",
          ...(workflowRestored
            ? ["Last turn changed this chat's workflow, so Foundry put it back as it was. Do not change it in this mode."]
            : []),
        ]
      : [
          "Build only when the user describes an automation; answer questions about this chat's work in text. A one-off job unrelated to the workflow belongs to Forge Agent: say they can turn on the Forge Agent switch under the message box.",
        ]),
    "You are Forge, Foundry's friendly assistant (see SYSTEM.md).",
    "Sandbox layout is already in SYSTEM.md. Do not ls/find/re-read GOAL, SYSTEM, questions, answers, context, or templates unless you need a specific detail.",
    "Chat/greetings: reply in text only; never open questions.json; never invent a goal from a greeting.",
    "Ask through questions.json only when something genuinely cannot be settled, including which file the person means (SYSTEM.md, Asking the person).",
    "A request to make or change a file is done straight away, into out/, from a file in this chat or in the workspace's Files; keep editing one working copy rather than making new files (SYSTEM.md, Files in this chat).",
    "Never mention file names (questions.json, answers.json, workflow.json, GOAL.md, step files) in your reply. The person sees questions as a card and the workflow as steps.",
    "This sandbox belongs to ONE workflow session. Do not assume files or goals from any other automation.",
    "Write to the person like a helpful colleague (SYSTEM.md, How you talk): short plain sentences, no em dashes, few commas, no jargon.",
  ];
  if (goal.trim()) {
    lines.push(`Current GOAL.md:\n${goal.trim()}`);
  } else {
    lines.push(mode === "agent" ? "This chat has no workflow goal." : "GOAL.md is empty. Only write it when the user states an automation to build.");
  }
  lines.push(...references);
  lines.push("", "User message:", userText);
  return lines.join("\n");
}

async function runHarness(
  workspaceId: string,
  sessionId: string,
  scriptRel: string,
): Promise<{ ok: boolean; detail: string }> {
  const root = sessionRoot(workspaceId, sessionId);
  return new Promise((resolve) => {
    // The server's OWN copy of the script, never the conversation's: Forge can write anything in its folder, and a
    // copy there would be Forge's code run by the server. With nothing of the server's environment either.
    const child = spawn(process.execPath, [join(TEMPLATE_ROOT, scriptRel)], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8", FORGE_VERIFY_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.on("close", (code) => {
      // The verifier must SAY it passed: exit 0 with no verdict is a verifier that did not run (it runs only as a
      // program — a path mismatch makes it a silent no-op), never a pass.
      const said = !scriptRel.endsWith("verify.mjs") || /VERIFY OK/.test(out);
      resolve({
        ok: code === 0 && said,
        detail: (out || `exit ${code}`).trim().slice(0, 4000) + (code === 0 && !said ? "\nVERIFY FAIL\n  - the verifier gave no verdict" : ""),
      });
    });
  });
}

/**
 * 2026-11-03: the tables this workflow reads that are large in the workspace's schema catalogue. One row per column
 * there, so take the biggest estimate per table.
 */
async function largeTablesOf(workspaceId: string, reads: unknown) {
  const tables: { datasource: string; name: string; rows: number | null }[] = [];
  // Only the datasources a read names: one catalogue query each, on every passing test.
  const named = new Set(
    Object.values((reads ?? {}) as Record<string, { datasource?: unknown }>).map((r) => r?.datasource),
  );
  if (!named.size) return [];
  for (const ds of await datasourceRepo.listByWorkspace(workspaceId)) {
    if (!named.has(ds.name)) continue;
    const best = new Map<string, { name: string; rows: number | null }>();
    for (const c of await schemaRepo.listByDatasource(ds.id)) {
      if (!c.entityName) continue;
      const key = `${c.entitySchema ?? "public"}.${c.entityName}`;
      const prev = best.get(key);
      const n = c.rowCountEstimate ?? null;
      const rows = prev?.rows == null ? n : n == null ? prev.rows : Math.max(prev.rows, n);
      best.set(key, { name: c.entityName, rows });
    }
    for (const b of best.values()) tables.push({ datasource: ds.name, name: b.name, rows: b.rows });
  }
  return largeTablesRead(reads, tables);
}

/** Verify the bundle, then run it as a draft. Records both on the session and emits both events. */
async function verifyAndRun(
  s: Session,
  requester: RunRequester,
  opts: {
    useProductionData?: boolean;
    /** The builder's own test after a build turn (not the person's Test button). */
    auto?: boolean;
    /** Set on an automatic FIX round: the allow_empty declarations it may not add to. */
    allowancesBefore?: string[];
  } = {},
): Promise<{ ok: boolean; detail: string; emptyData: boolean; asked: boolean; infra: boolean; retryable?: boolean; realData: { kind: "no-rows" | "files"; summary: string } | null }> {
  let verify = await runHarness(s.workspaceId, s.id, "verifier/verify.mjs");
  if (verify.ok) {
    // The EXECUTOR's own read rules (checkSqlShape + the dialect check), not a copy of them — so a read the run
    // would refuse fails here, named, before a run exists.
    const reads = await readProblems(s.workspaceId, readBundle(s.workspaceId, s.id).workflow);
    if (reads.length) verify = { ok: false, detail: `VERIFY FAIL\n  - ${reads.join("\n  - ")}` };
  }
  if (verify.ok && opts.allowancesBefore) {
    const before = new Set(opts.allowancesBefore);
    const added = allowancesOf(readWorkflow(s.workspaceId, s.id)).filter((a) => !before.has(a));
    if (added.length) {
      verify = {
        ok: false,
        detail:
          `VERIFY FAIL\n  - an automatic fix may not add "allow_empty" (${added.join(", ")}). Only the person can accept ` +
          `that a result may be empty. Remove it, and fix the read or the code so the step returns what it is for.`,
      };
    }
  }
  s.lastVerify = verify;
  emit(s, { type: "verify", ok: verify.ok, detail: verify.detail, ...(verify.ok ? {} : { summary: CHECKS_REFUSED }) });
  if (!verify.ok) {
    // No run exists: the workflow was refused before one could start.
    s.lastTestRun = { ok: false, detail: verify.detail, summary: CHECKS_REFUSED, at: new Date().toISOString(), runId: null, needsRealData: false };
    emit(s, { type: "test_run", ok: false, detail: verify.detail, summary: CHECKS_REFUSED, runId: null, needsRealData: false });
    return { ok: false, detail: verify.detail, emptyData: false, asked: false, infra: false, realData: null };
  }
  let detail: string;
  let summary = "The test could not start.";
  let ok = false;
  let emptyData = false;
  let infra = false;
  let retryable = true;
  let verdict: { kind: "no-rows" | "files"; summary: string } | null = null;
  let blank: BlankColumns[] = [];
  let runId: string | null = null;
  let waiting: PiTestWaiting | null = null;
  try {
    const bundle = readBundle(s.workspaceId, s.id);
    // The values remembered from the last test form follow the workflow: an input Pi has since renamed or removed
    // is dropped HERE (the session's memory), never sent — the runner service refuses an undeclared name, which is
    // right for a request and wrong for a stale memory.
    const declared = (bundle.workflow.inputs ?? {}) as Record<string, unknown>;
    s.runInputs = Object.fromEntries(Object.entries(s.runInputs).filter(([k]) => k in declared));
    const runAs = await workflowAccounts(s, bundle, requester.subject ?? null, { kind: "test", opts });
    // A prior waiting test on this session has nowhere else to be decided — cancel before starting another.
    if (s.lastRunId && s.lastTestRun?.waiting) {
      await flowRunnerService.cancel(s.lastRunId).catch((e) => {
        console.warn(`[pi-builder] could not cancel prior waiting test ${s.lastRunId}: ${(e as Error).message}`);
      });
      s.lastTestRun = { ...s.lastTestRun, waiting: null };
    }
    const { flowExecutionId } = await flowRunnerService.startDraftRun({
      workspaceId: s.workspaceId,
      flowId: s.flowId,
      bundle,
      runAs,
      inputs: s.runInputs,
      // Per run, never remembered: the automatic test after the next edit reads test data again.
      useProductionData: opts.useProductionData === true,
      autoTest: opts.auto === true,
      requester,
      sessionId: s.id,
      chatId: s.chatId,
    });
    // Emit before waitForRun so the builder can open the live progress stream (Phase 2).
    s.lastRunId = flowExecutionId;
    runId = flowExecutionId;
    emit(s, { type: "test_run_started", runId: flowExecutionId });
    const run = await flowRunnerService.waitForRun(flowExecutionId);
    // Waiting at an approval is the test getting as far as it can without a person — not a failure to fix.
    ok = run.status === "succeeded" || run.status === "waiting";
    waiting = waitingOf(run);
    emptyData = failedOnEmptyData(run);
    blank = emptyData ? blankColumnsOf(run.steps) : [];
    detail = describeRun(run);
    summary = summariseRun(run, emptyData);
    // 2026-11-03: empty on invented test data proves nothing (no rows for these values, or files beside the tables).
    verdict = realDataVerdict({
      realData: opts.useProductionData === true,
      // A run that succeeded with an allowed-empty output on invented data is as inconclusive as one that failed empty.
      emptyData: emptyData || allowedEmptyOutputs(bundle.workflow, run.steps).length > 0,
      emptyReads: emptyReadsOf(run.steps),
      files: filesBesideTables(bundle.workflow),
      inputs: runInputsOf(bundle.workflow, s.runInputs).values,
    });
    if (verdict) summary = verdict.summary;
    s.lastRunId = flowExecutionId;
    runId = flowExecutionId;
  } catch (e) {
    detail = `Could not start the test run: ${(e as Error).message}`;
    // 2026-11-03: the run never started: not the workflow's fault (settleTest keeps it from Forge). A 4xx is a refusal
    // the person can act on (e.g. "choose which account"), not an outage to wait out.
    infra = true;
    const code = (e as { statusCode?: number }).statusCode;
    retryable = !(typeof code === "number" && code >= 400 && code < 500);
  }
  s.lastTestRun = { ok, detail, summary, at: new Date().toISOString(), runId, waiting, needsRealData: verdict != null };
  s.lastTestRealData = opts.useProductionData === true;
  s.lastBlank = blank;
  s.lastEmptyDetail = emptyData ? detail : null;
  touch(s);
  emit(s, { type: "test_run", ok, detail, summary, runId, waiting, needsRealData: verdict != null });
  // 2026-11-03: a pass on a handful of invented rows says nothing about volume; name the big tables once.
  if (ok && opts.useProductionData !== true) {
    try {
      const big = await largeTablesOf(s.workspaceId, (readBundle(s.workspaceId, s.id).workflow as { reads?: unknown }).reads);
      const list = big.map((t) => `${t.name} (about ${t.rows.toLocaleString("en-US")} rows)`).join(", ");
      if (list && list !== s.lastVolumeNote) {
        s.lastVolumeNote = list;
        pushNote(
          s,
          `Passed on test data, which has a handful of invented rows per table. In production ${list} — volume is not tested here: run it once on real data before relying on it.`,
        );
      }
    } catch (e) {
      console.warn(`[pi-builder] could not read table sizes for chat ${s.chatId}: ${(e as Error).message}`);
    }
  }
  const asked = blank.length > 0 && askBlankColumns(s, blank);
  return { ok, detail, emptyData, asked, infra, retryable, realData: verdict };
}

/**
 * Columns blank in every row go to the person as a card (empty-allowance.ts): which can genuinely be blank. Decided
 * by them, settled by code — never left for Forge to turn into an allowance from a sentence.
 */
function askBlankColumns(s: Session, blank: BlankColumns[]): boolean {
  const existing = (readQuestions(s.workspaceId, s.id).questions ?? []).filter((q) => !q.id.startsWith(BLANK_PREFIX));
  writeQuestionsRaw(s.workspaceId, s.id, [...existing, ...blank.map(blankColumnsQuestion)]);
  refreshFiles(s);
  setStatus(s, "awaiting_answers");
  emit(s, { type: "questions", questions: readQuestions(s.workspaceId, s.id) });
  return true;
}

/** The approval a test run is waiting at, from its records — or null when it is not waiting. */
function waitingOf(run: { status: string; steps: Array<{ stepId: string; scope: string; status: string; outputJson: unknown }> }): PiTestWaiting | null {
  if (run.status !== "waiting") return null;
  const w = run.steps.find((x) => x.scope === "" && x.status === "waiting");
  if (!w) return null;
  return { stepId: w.stepId, title: String((w.outputJson as { title?: unknown } | null)?.title ?? w.stepId) };
}

function handlePiEvent(s: Session, ev: Record<string, unknown>) {
  const type = String(ev.type ?? "");

  if (type === "tool_execution_start") {
    const id = String(ev.toolCallId ?? randomUUID());
    const tool = String(ev.toolName ?? "tool");
    const act = startActivity(id, tool, ev.args);
    const i = s.liveActivities.findIndex((a) => a.id === id);
    if (i >= 0) s.liveActivities[i] = act;
    else s.liveActivities.push(act);
    emit(s, { type: "activity", activity: act });
    if (/write|edit/i.test(tool)) refreshFiles(s);
    return;
  }

  if (type === "tool_execution_update") {
    const id = String(ev.toolCallId ?? "");
    const prev = s.liveActivities.find((a) => a.id === id);
    if (!prev) return;
    const next = updateActivity(prev, ev.args, ev.partialResult);
    s.liveActivities = s.liveActivities.map((a) => (a.id === id ? next : a));
    emit(s, { type: "activity", activity: next });
    return;
  }

  if (type === "tool_execution_end") {
    const id = String(ev.toolCallId ?? "");
    const prev = s.liveActivities.find((a) => a.id === id);
    if (!prev) return;
    const next = endActivity(prev, ev.args, ev.result, Boolean(ev.isError));
    s.liveActivities = s.liveActivities.map((a) => (a.id === id ? next : a));
    emit(s, { type: "activity", activity: next });
    refreshFiles(s);
    return;
  }

  if (type === "message_update") {
    const thought = thinkingFromUpdate(ev);
    if (thought) {
      if (thought.kind === "start") {
        s.thinkingSince ??= Date.now();
        // A second block in one turn (after a tool call) reads as a new paragraph, not run on.
        if (s.draftThinking && !s.draftThinking.endsWith("\n\n")) {
          s.draftThinking += "\n\n";
          emit(s, { type: "thinking", text: "\n\n" });
        }
      } else if (thought.kind === "end") {
        if (s.thinkingSince != null) s.thinkingMs += Date.now() - s.thinkingSince;
        s.thinkingSince = null;
      } else if (s.draftThinking.length < MAX_THINKING_CHARS) {
        s.draftThinking += thought.text;
        emit(s, { type: "thinking", text: thought.text });
      }
      return;
    }
    const delta = textDeltaFromUpdate(ev);
    if (delta) {
      s.draftText += delta;
      emit(s, { type: "delta", text: delta });
    }
    return;
  }

  if (type === "auto_retry_start") {
    // Said while it happens, not after: the chat line reads "The AI service is busy — trying again (2 of 3)".
    emit(s, {
      type: "retrying",
      attempt: Number(ev.attempt ?? 1),
      ...(typeof ev.maxAttempts === "number" ? { maxAttempts: ev.maxAttempts } : {}),
      title: explainModelError(String(ev.errorMessage ?? "")).title,
    });
  }
  if (type === "auto_retry_end" && ev.success !== false) emit(s, { type: "retrying", attempt: 0 });
  // Pi summarised earlier messages on its own (the conversation was nearly full): say so, once, where it happened.
  if (type === "compaction_end" && ev.aborted !== true && !ev.errorMessage && !s.compacting) {
    pushNote(s, COMPACTED_NOTE);
  }
  if (type === "auto_retry_start" || type === "auto_retry_end" || type === "compaction_end") {
    console.log(`[forge] ${s.id.slice(0, 8)} ${type} ${JSON.stringify({ attempt: ev.attempt, success: ev.success, willRetry: ev.willRetry, error: String(ev.errorMessage ?? ev.finalError ?? "").slice(0, 200) })}`);
  }

  if (type === "message_end") {
    const msg = ev.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    // Only Forge's own messages are its reply — never the prompt we sent, never a tool's result (2026-10-10: both
    // were recorded as the reply when a turn was cut short).
    if (msg?.role === "assistant") {
      const text = assistantTextFromMessage(ev.message);
      if (text.trim()) s.draftText = text;
      // A failed model call is explained on the turn's failure card (forge-errors.ts), never pasted in as the reply.
      if (msg.stopReason === "error" && msg.errorMessage) s.lastModelError = String(msg.errorMessage);
      if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse") {
        console.log(`[forge] ${s.id.slice(0, 8)} reply stopped: ${msg.stopReason} ${String(msg.errorMessage ?? "").slice(0, 200)}`);
      }
    }
    recordForgeUsage(s, ev.message);
    return;
  }
}

/** Thinking kept per turn is bounded: it is stored with the chat, and a runaway model must not bloat every reload. */
const MAX_THINKING_CHARS = 60_000;

function resetThinking(s: Session): void {
  s.draftThinking = "";
  s.thinkingMs = 0;
  s.thinkingSince = null;
}

/**
 * One model reply in a Forge conversation, as usage (P-OBS): building cost, attributed to the person who sent the
 * message and to the workflow (or, before its first save, to the conversation — moved onto the workflow then). Pi
 * reports the cost itself; measured equal to the gateway's own `x-litellm-response-cost` (2026-10-10).
 */
function recordForgeUsage(s: Session, message: unknown): void {
  const m = message as {
    role?: string;
    model?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
  } | null;
  if (!m || m.role !== "assistant" || !m.usage) return;
  usageService.record({
    workspaceId: s.workspaceId,
    purpose: "building",
    kind: "llm",
    source: "forge",
    subject: s.requester.subject,
    actor: s.requester.actor,
    flowId: s.flowId,
    sessionId: s.id,
    model: m.model ?? forgeModelOf(s),
    // Pi's `input` is the UNCACHED part of the prompt; the prompt is all three (as the gateway's prompt_tokens is).
    tokensIn: (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0),
    tokensOut: m.usage.output,
    tokensCached: m.usage.cacheRead,
    tokensCacheWrite: m.usage.cacheWrite,
    costUsd: m.usage.cost?.total,
  });
}

/**
 * How many times the server hands a failure back to Pi on its own before stopping and showing the person.
 * Bounded: an unbounded loop is a model arguing with a check, at the person's expense.
 */
const MAX_AUTO_FIX = 2;

/**
 * What happens to a test result — ONE rule, whichever path ran the test: the automatic test after a turn, the
 * person's Test button, or the re-test after they answered (2026-10-13). It used to live in the turn alone, so the
 * same failure was Forge's to fix after a turn and simply shown to the person after a Test: a refused read
 * ("this join cannot use an index") sat in front of them as raw VERIFY FAIL text, with nothing happening next.
 *
 *   - passed, or waiting at an approval → ready
 *   - EMPTY DATA → the person decides (a note, and the blank-columns card when columns are blank): with test data it
 *     is as likely "nothing fits these values" as a fault, and a fix loop facing it is invited to allow the emptiness
 *   - EMPTY DATA on test data with no rows for the values (2026-11-03) → one plain note that it needs real data
 *   - the run could not start (2026-11-03) → an outage: a note to the person, failed, and no fix round. Forge would only edit a correct workflow.
 *   - anything else (the checks refused it, a step crashed, a read timed out) → Forge's own work to correct: the
 *     returned text is what the fix turn is told. The caller bounds the rounds (MAX_AUTO_FIX).
 */
function settleTest(
  s: Session,
  run: {
    ok: boolean;
    detail: string;
    emptyData: boolean;
    asked: boolean;
    infra: boolean;
    retryable?: boolean;
    realData?: { kind: "no-rows" | "files"; summary: string } | null;
  },
  realData = false,
): string | null {
  const route = routeFailure(run);
  if (route === "ready") {
    setStatus(s, "ready");
    return null;
  }
  if (route === "outage") {
    pushNote(
      s,
      run.retryable === false
        ? `The test could not start: ${run.detail}. Nothing was changed.`
        : `The test could not run, which is not a fault in the workflow: ${run.detail}. Nothing was changed; try the test again in a moment.`,
    );
    setStatus(s, "failed");
    return null;
  }
  if (route === "forge") return run.detail;
  if (run.realData?.kind === "no-rows" && !run.asked) {
    pushNote(s, run.realData.summary);
    setStatus(s, "ready");
    return null;
  }
  const { workflow } = readBundle(s.workspaceId, s.id);
  const used = runInputsOf(workflow, s.runInputs).values;
  const files = realData ? [] : filesBesideTables(workflow);
  pushNote(
    s,
    `The test ran${Object.keys(used).length ? ` with ${Object.entries(used).map(([k, v]) => `${k} = ${String(v)}`).join(", ")}` : ""}, ` +
      `and a step returned empty data:\n\n${run.detail}\n\nNothing has been changed. ` +
      (run.asked
        ? `Some columns came back blank in every row: tick on the card the ones that can genuinely be blank.`
        : files.length
          ? `This workflow compares the workspace's tables with ${files.map((f) => `"${f}"`).join(", ")}. Test data ` +
            `invents table rows that cannot match the names in a real file, so empty is expected here: test it on ` +
            `real data to check it.`
          : `If the test data just has no rows that fit, try the test with other values, or on real data. If the ` +
          `step is keeping the wrong rows, tell me what it should keep.`),
  );
  if (!run.asked) setStatus(s, "ready");
  return null;
}

/**
 * A test the PERSON started (Test, or answering a card) that Forge must correct: the same bounded fix loop a turn
 * gets. Only in Workflow Builder — Forge Agent never changes the workflow.
 */
async function testThenSettle(s: Session, requester: RunRequester, opts: { useProductionData?: boolean; auto?: boolean }) {
  const run = await verifyAndRun(s, requester, opts);
  const followUp = settleTest(s, run, opts.useProductionData === true);
  if (!followUp) return;
  if (s.mode !== "workflow") {
    setStatus(s, "failed");
    return;
  }
  // The allowances as they stand are the baseline the fix may not add to.
  s.allowancesAtTurn = allowancesOf(readWorkflow(s.workspaceId, s.id));
  s.fixOnRealData = opts.useProductionData === true;
  s.lastFixFailure = followUp;
  await runTurn(s, fixPrompt(followUp), 1);
}

/**
 * One Pi turn, then the server's own follow-through: questions → wait for the person; a workflow → verify and
 * TEST-RUN it on flow-runner; a failure → up to MAX_AUTO_FIX fix turns carrying the failure verbatim.
 * `fixRound > 0` marks a turn the server started — its prompt is shown as a system note, not as the person's words.
 */
/**
 * Refuse a new turn up front, where the refusal reaches the person: a turn still running (409), or no room for
 * another live Forge (429). A turn is started fire-and-forget, so a throw inside it reaches nobody.
 */
/**
 * Run a test in the background. Its outcome reaches the page as events; a failure is said in plain words and leaves
 * the session `failed`, never stuck at `running` with nothing coming. `testing` is cleared however it ends.
 */
function inBackground(s: Session, work: () => Promise<void>): void {
  s.testing = true;
  void work()
    .catch((e) => {
      const detail = `The test run could not finish: ${e instanceof Error ? e.message : String(e)}`;
      const summary = "The test could not finish.";
      s.lastTestRun = { ok: false, detail, summary, at: new Date().toISOString(), runId: null, waiting: null, needsRealData: false };
      emit(s, { type: "test_run", ok: false, detail, summary, runId: null, needsRealData: false });
      setStatus(s, "failed");
    })
    .finally(() => {
      s.testing = false;
      emit(s, { type: "done" });
    });
}

const COMPACTED_NOTE =
  "The conversation was nearly full, so Forge summarised the earlier messages to make room. It keeps a summary of them, " +
  "and everything it built is unchanged.";

function pushNote(s: Session, text: string): void {
  const note: PiChatMessage = { id: randomUUID(), role: "system", text, at: new Date().toISOString(), mode: s.mode };
  s.messages.push(note);
  emit(s, { type: "message", message: note });
  persistChat(s);
}

/**
 * Put the conversation in a mode (0097): Forge's instructions are rewritten and its process released, so the next
 * message starts one that loads them and resumes the conversation from its session file. Not during a turn.
 */
function applyMode(s: Session, mode: ChatMode): void {
  if (s.mode === mode) return;
  s.mode = mode;
  writeSystemPrompt(s.workspaceId, s.id, mode);
  forgePool.release(s.id);
  s.context = null;
  if (s.chatId) void piChatRepo.update(s.chatId, { mode }).catch((e) => console.warn(`[pi-builder] could not store chat ${s.chatId}'s mode: ${(e as Error).message}`));
  emit(s, { type: "mode", mode, agentAllowed: s.agentAllowed });
}


/**
 * Ask Forge how full its conversation is and tell the page. Only between turns, only of a live Forge — never starts
 * one; the last known reading stays when Forge has exited. Best effort: a meter that could not be read keeps its value.
 */
async function refreshContext(s: Session): Promise<void> {
  const forge = forgePool.peek(s.id);
  if (!forge || forge.busy) return;
  try {
    const stats = await forge.request<{ contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }>(
      { type: "get_session_stats" },
      15_000,
    );
    const u = stats?.contextUsage;
    if (!u) return;
    s.context = { tokens: u.tokens, window: u.contextWindow, percent: u.percent, at: new Date().toISOString() };
    emit(s, { type: "context", context: s.context });
  } catch {
    /* the meter keeps its last reading */
  }
}

/**
 * The conversation after a switch to `mode`: one "Switched to …" note for a run of switches with nothing said in
 * between. The last switch note is replaced, and switching back to where the run started leaves none. Toggling quickly
 * used to stack a note per click.
 */
export function withModeNote(messages: PiChatMessage[], mode: ChatMode): PiChatMessage[] {
  const last = messages.at(-1);
  const from: ChatMode = last?.modeSwitch ? last.modeSwitch.from : mode === "agent" ? "workflow" : "agent";
  const kept = last?.modeSwitch ? messages.slice(0, -1) : [...messages];
  if (from === mode) return kept;
  return [
    ...kept,
    {
      id: randomUUID(),
      role: "system",
      text:
        mode === "agent"
          ? "Switched to Forge Agent. I'll do things here and now, and leave the workflow as it is."
          : "Switched to Workflow Builder. I'll build and change this chat's workflow.",
      at: new Date().toISOString(),
      mode,
      modeSwitch: { from },
    },
  ];
}

/** Measure the conversation's folder and tell the page. */
function measureStorage(s: Session): PiStorage {
  const u = folderUsage(s.workspaceId, s.id);
  s.storage = { bytes: u.bytes, limit: config.forge.maxFolderBytes, chat: u.chat };
  emit(s, { type: "storage", storage: s.storage });
  return s.storage;
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

/** Why a full conversation cannot take a message, and what the person can do about it. */
export function storageFullMessage(st: PiStorage): string {
  return (
    `This conversation's files take ${mb(st.bytes)} of its ${mb(st.limit)}, so Forge can't take another message. ` +
    (st.chat > st.limit * 0.2
      ? "Remove files you no longer need in the Files pane, under Files in chat, or start a new chat."
      : "Most of that is Forge's own working files, so start a new chat to carry on.")
  );
}

function readyForTurn(s: Session): void {
  // Full is said here, in words, before anything is sent: the forge host refuses it too, and its refusal used to reach
  // the person as "Forge stopped unexpectedly" (2026-10-13).
  const st = measureStorage(s);
  if (st.bytes > st.limit) throw httpErr(storageFullMessage(st), 413);
  if (s.compacting) throw httpErr("Forge is making room in this conversation. Send your message again in a moment.", 409);
  if (s.abort) throw httpErr("Forge is still working on the last message. Wait for it to finish or press Stop.", 409);
  if (s.testing) throw httpErr("A test run is still going. Wait for it to finish, then send your message.", 409);
  forgePool.acquire(s.workspaceId, s.id);
  s.lastSeenAt = Date.now();
}

/**
 * `shown` is what the chat records as the person's message when it differs from what the agent is told — an answer
 * turn tells the agent where the answers are, and shows the person their answers.
 */
/**
 * Before a turn: the references Forge may read this turn. Workflow Builder only — a Forge Agent turn gets none and
 * the folder is removed. A workflow the person can no longer read is dropped, with a note; a deleted one stays,
 * readable from its copy. Then `references/` is removed and written again, and the prompt section is returned.
 */
async function prepareReferences(s: Session): Promise<string[]> {
  if (s.mode !== "workflow") {
    clearReferences(s.workspaceId, s.id);
    return [];
  }
  if (s.refs.length && s.reader?.subject) {
    // A reference the person may no longer see leaves: no `flows.read` at all, or (rbac-observability) somebody
    // else's private draft — e.g. after its owner changed. A deleted workflow stays (its copy is still readable).
    const mayRead = await effectivePermissionsService.has(s.reader, s.workspaceId, "flows.read").catch(() => true);
    const viewer = mayRead ? await contentVisibility.viewer(s.reader, s.workspaceId).catch(() => null) : null;
    const lost: SessionRef[] = [];
    for (const r of s.refs) {
      if (!mayRead) lost.push(r);
      else if (viewer && r.flowId) {
        const f = await flowRepo.get(s.workspaceId, r.flowId).catch(() => null);
        if (f && !contentVisibility.flowVisible(viewer, f)) lost.push(r);
      }
    }
    if (lost.length) {
      const names = lost.map((r) => r.name);
      for (const r of lost) if (r.stored) await piChatReferenceRepo.remove(s.workspaceId, r.id).catch(() => {});
      s.refs = s.refs.filter((r) => !lost.includes(r));
      pushNote(s, `Removed the reference${names.length > 1 ? "s" : ""} to ${names.map((n) => `"${n}"`).join(", ")}: you can no longer read ${names.length > 1 ? "them" : "it"}.`);
      emit(s, { type: "references" });
    }
  }
  const gone = await goneFlows(s.workspaceId, s.refs).catch(() => new Set<string>());
  if (gone.size) {
    s.refs = s.refs.map((r) => (r.flowId && gone.has(r.flowId) ? { ...r, flowId: null } : r));
    emit(s, { type: "references" });
  }
  const refs = folderRefs(s.refs);
  writeReferences(s.workspaceId, s.id, refs);
  return cardsBlock(refs, s.refsMoved.splice(0));
}

async function runTurn(
  s: Session,
  userText: string,
  fixRound = 0,
  shown?: Pick<PiChatMessage, "text" | "answers" | "by" | "attachments">,
  /** Try again: re-run the last turn — no second copy of the person's message in the chat. */
  retry = false,
) {
  if (s.abort) {
    const err = new Error("a turn is already running") as Error & { statusCode?: number };
    err.statusCode = 409;
    throw err;
  }

  const userMsg: PiChatMessage = {
    id: randomUUID(),
    role: fixRound > 0 ? "system" : "user",
    text: fixRound > 0 ? `The test run didn't pass, so I'm fixing it (try ${fixRound} of ${MAX_AUTO_FIX}).` : (shown?.text ?? userText),
    at: new Date().toISOString(),
    mode: s.mode,
    ...(fixRound === 0 && shown?.answers?.length ? { answers: shown.answers } : {}),
    ...(fixRound === 0 && shown?.by ? { by: shown.by } : {}),
    ...(fixRound === 0 && shown?.attachments?.length ? { attachments: shown.attachments } : {}),
  };
  if (!retry) {
    s.messages.push(userMsg);
    emit(s, { type: "message", message: userMsg });
    persistChat(s);
  }
  s.lastTurn = { userText, fixRound };
  s.lastModelError = null;
  if (fixRound === 0 && !retry) s.allowancesAtTurn = allowancesOf(readWorkflow(s.workspaceId, s.id));
  if (fixRound === 0) {
    s.fixOnRealData = false;
    s.lastFixFailure = null;
  }
  let followUp: string | null = null;

  s.liveActivities = [];
  s.draftText = "";
  resetThinking(s);
  setStatus(s, "running");

  const ac = new AbortController();
  s.abort = ac;

  try {
    // ⚠ The catalogue is rebuilt per turn, not only when the session starts. An action switched on mid-chat (chat
    // 4ecefa5a: GitHub's Create or Update File) was otherwise missing its inputs from Forge's copy, and Forge guessed
    // them, proposing a commit of the literal text "PLACEHOLDER". A failed rebuild keeps the last one, and says so.
    await refreshWorkspaceCatalogue(s.workspaceId).catch((e) => console.warn(`[pi-builder] catalogue refresh failed: ${(e as Error).message}`));
    // Read per turn: a super admin's change to the purpose or to Forge Agent applies from the next message.
    const row = await workspaceRepo.get(s.workspaceId).catch(() => null);
    if (row) s.agentAllowed = row.assistant === true;
    if (s.mode === "agent" && row && !row.assistant) {
      applyMode(s, "workflow");
      pushNote(s, "Forge Agent is turned off for this workspace, so this chat is in Workflow Builder now.");
    }
    // 2026-11-03: the admin's model list is read per turn; a Forge running a model no longer chosen is restarted on the right one.
    s.generation = (await loadGeneration(s.ownerSubject)) ?? s.generation;
    const live = forgePool.peek(s.id);
    if (live && !live.busy && live.model !== forgeModelOf(s)) forgePool.release(s.id);
    // Rewritten every turn from the server's template: Forge can write its own folder, SYSTEM.md included.
    writeSystemPrompt(s.workspaceId, s.id, s.mode);
    // Forge Agent never changes the workflow: what it is now is put back after the turn if it moved.
    const guarded = s.mode === "agent" ? workflowSnapshot(s.workspaceId, s.id) : null;
    // 2026-11-03: an automatic fix may not drop a source (a File, a read, a tool) to get past a test; checked after the turn.
    const fixGuard =
      fixRound > 0 && s.mode === "workflow"
        ? { snapshot: workflowSnapshot(s.workspaceId, s.id), workflow: readWorkflowRaw(s.workspaceId, s.id) }
        : null;
    // The conversation's live Forge, or a new one resuming from its session file. Room was checked when the
    // message arrived (`message` / `answer`); an automatic fix round reuses the same process.
    const forge = forgePool.acquire(s.workspaceId, s.id);
    forgePool.turnStarted(s.id);
    s.outBefore = outSnapshot(s.workspaceId, s.id);
    s.filesBefore = chatFileNames(s.workspaceId, s.id);
    let end;
    try {
      const fileNames = await workspaceFileService
        .list(s.workspaceId)
        .then((fs) => fs.map((f) => f.name))
        .catch(() => undefined);
      const pluginNames = config.plugins.enabled
        ? await toolRepo
            .listByWorkspace(s.workspaceId)
            .then((ts) => ts.filter((t) => t.isActive !== false && isPluginTool(t)).map((t) => t.name))
            .catch(() => undefined)
        : undefined;
      // The person's own actions: listed to Forge and written beside catalogue.json for the builder and the verifier.
      const reader = talker(s);
      const myTools = config.plugins.enabled ? await personalTools(s.workspaceId, reader?.subject ?? null).catch(() => [] as Tool[]) : [];
      writeMyCatalogue(s.workspaceId, s.id, myTools);
      const by = [...s.messages].reverse().find((m) => m.role === "user" && m.by)?.by;
      const turnWs: TurnWorkspace = {
        purpose: row?.description ?? null,
        assistant: row?.assistant === true,
        files: fileNames,
        plugins: pluginNames,
        changes: s.mode === "agent" && row?.assistant === true && row?.agentChanges === true,
        person: by || s.reader ? { name: by?.name ?? null, email: s.reader?.email ?? null } : null,
        outcomes: s.proposalOutcomes.splice(0),
        services:
          config.plugins.enabled && s.mode === "agent" && row?.assistant === true
            ? await connectedServices(s.workspaceId, reader)
                .then((ss) => ss.map(serviceLine))
                .catch((e) => {
                  console.warn(`[pi-builder] could not list connected services for the turn: ${(e as Error).message}`);
                  return undefined;
                })
            : undefined,
        myTools: myTools.map((t) => t.name),
        settings: config.plugins.enabled && s.mode === "agent" && row?.assistant === true,
        // Read from the chat's row each turn: it may have been moved, or the project's instructions edited, since.
        project: await (s.chatId ? piChatRepo.get(s.workspaceId, s.chatId).then((c) => c?.projectId ?? null) : Promise.resolve(s.projectId))
          .then((pid) => projectService.contextOf(s.workspaceId, pid))
          .catch((e) => {
            console.warn(`[pi-builder] could not read the chat's project for the turn: ${(e as Error).message}`);
            return null;
          }),
      };
      s.proposals = [];
      const restoredBefore = s.workflowRestored;
      s.workflowRestored = false;
      const removed = s.removedFiles.splice(0);
      let told = removed.length
        ? `The person removed these files from this chat; they are gone, so do not use or recreate them: ${removed.map((n) => JSON.stringify(n)).join(", ")}.\n\n${userText}`
        : userText;
      // The empty-data note went to the person, not to Forge: without it, "these can be empty" names nothing Forge can
      // see, and it guesses which columns (chat 25d67dbd allowed three others and missed the one that failed).
      if (fixRound === 0 && !retry && s.lastEmptyDetail) {
        told =
          `The last test stopped on empty data (the person saw this):\n${s.lastEmptyDetail}\n` +
          `If the person says some of it can be empty, declare exactly what the test named: one "allow_empty" entry WITH ` +
          `"field" per column blank in every row. An entry without "field" means the output may have no rows at all — ` +
          `a different thing, never a way to allow blank columns.\n\n${told}`;
        s.lastEmptyDetail = null;
      }
      const references = await prepareReferences(s);
      end = await forge.turn(buildPrompt(told, s.goal, turnWs, s.mode, restoredBefore, references), {
        onEvent: (ev) => handlePiEvent(s, ev),
        signal: ac.signal,
        timeoutMs: config.forge.turnTimeoutMs,
      });
    } finally {
      forgePool.turnEnded(s.id);
      persistForgeSession(s);
      if (guarded !== null && workflowSnapshot(s.workspaceId, s.id) !== guarded) {
        restoreWorkflowSnapshot(s.workspaceId, s.id, guarded, s.goal);
        s.workflowRestored = true;
        console.warn(`[pi-builder] a Forge Agent turn changed the workflow in session ${s.id}; put back`);
      }
    }
    void refreshContext(s);

    refreshFiles(s);
    // What Forge deleted this turn leaves the chat's record too, before what it made is kept.
    await forgetDeletedFiles(s).catch((e) => console.warn(`[pi-builder] could not forget the files Forge deleted: ${(e as Error).message}`));
    // What Forge made for the person this turn goes with its reply, kept with the chat (before any test run reads it).
    const outputs = await keepOutputs(s).catch((e) => {
      console.warn(`[pi-builder] could not keep the files Forge made: ${(e as Error).message}`);
      return { made: [] as PiAttachment[], refused: [] as string[] };
    });
    measureStorage(s);
    const q = readQuestions(s.workspaceId, s.id);
    const minutes = Math.round(config.forge.turnTimeoutMs / 60_000);
    // A turn that did not finish is explained in plain words, with whether Try again can help (forge-errors.ts).
    // pi can end a turn as "done" after its model call failed (a 413 did, 2026-10-12): with no reply and an error
    // recorded, that turn failed, and saying "Done for now." hid why.
    const silentFailure = end.ended === "done" && !!s.lastModelError && !s.draftText.trim();
    const ended = silentFailure ? "failed" : end.ended;
    const error =
      ended === "failed" || ended === "timeout" || ended === "exited" || ended === "refused"
        ? turnFailure(ended, { modelError: s.lastModelError, minutes, exitCode: end.exitCode, stderr: end.stderr, reason: end.reason })
        : null;
    const text = error
      ? `${error.title}. ${error.said}`
      : s.draftText.trim() ||
        (end.ended === "aborted" ? "Stopped." : q.status === "open" ? "A couple of things to settle before I build this." : "Done for now.");
    const ok = ended === "done";

    const assistant: PiChatMessage = {
      id: randomUUID(),
      role: "assistant",
      text,
      at: new Date().toISOString(),
      activities: [...s.liveActivities],
      mode: s.mode,
      ...(error ? { error } : {}),
      ...(s.draftThinking.trim()
        ? { thinking: { text: s.draftThinking.trim(), ms: s.thinkingMs + (s.thinkingSince != null ? Date.now() - s.thinkingSince : 0) } }
        : {}),
      ...(outputs.made.length ? { files: outputs.made } : {}),
      ...(s.proposals.length ? { proposals: s.proposals.splice(0) } : {}),
    };
    s.messages.push(assistant);
    emit(s, { type: "message", message: assistant });
    if (outputs.refused.length) {
      const note: PiChatMessage = {
        id: randomUUID(),
        role: "system",
        text: `Not kept: ${outputs.refused.join("; ")}.`,
        at: new Date().toISOString(),
      };
      s.messages.push(note);
      emit(s, { type: "message", message: note });
    }
    persistChat(s);
    s.liveActivities = [];
    s.draftText = "";
    resetThinking(s);

    const open = q.status === "open" && (q.questions?.length ?? 0) > 0;
    // P0-I1: a question with no prompt reached the person as a blank card. It is Pi's defect to fix, not theirs.
    const blank = open ? q.questions.filter((x) => !x?.prompt || !String(x.prompt).trim()) : [];
    // 2026-11-03: put back a fix that dropped a source, and stop: whether that source should change is the person's call.
    // An unreadable workflow.json is not "every source removed": the checks report it and the fix loop corrects it.
    const after = fixGuard ? readWorkflowRaw(s.workspaceId, s.id) : null;
    const dropped = fixGuard && after ? droppedSources(fixGuard.workflow, after) : [];
    if (fixGuard && dropped.length) {
      restoreWorkflowSnapshot(s.workspaceId, s.id, fixGuard.snapshot, s.goal);
      pushNote(
        s,
        `The automatic fix removed ${sourceList(dropped)}, which the workflow used. That was put back: a fix may not swap a source to get past a test. Tell me whether that source should change.`,
      );
    }
    const wf = readWorkflow(s.workspaceId, s.id);
    if (!ok) {
      // Stopped, timed out or crashed: what it wrote is kept, nothing is tested on its behalf.
      setStatus(s, end.ended === "aborted" ? "idle" : "failed");
    } else if (dropped.length) {
      // Put back above; nothing is tested and no further round starts.
      setStatus(s, "failed");
    } else if (open && blank.length === 0) {
      setStatus(s, "awaiting_answers");
      emit(s, { type: "questions", questions: q });
    } else if (pendingAskSurfaces(s).length > 0) {
      // Forge showed a choice card and needs a pick before continuing (surface cards, ask mode).
      setStatus(s, "awaiting_answers");
    } else if (pendingEdgeWork(s)) {
      // An edge Approve card is open, or a job is running on their computer — not Ready.
      setStatus(s, "awaiting_answers");
    } else if (open && s.mode === "agent") {
      // A blank question in Forge Agent is not a build to repair: the turn ends, and nothing is tested.
      setStatus(s, wf.steps.length ? "ready" : "idle");
    } else if (open) {
      followUp = `questions.json has ${blank.length} question(s) with no prompt (${blank.map((x) => x?.id ?? "?").join(", ")}). Every question needs its full text in "prompt".`;
    } else if (s.mode === "agent") {
      // Forge Agent built nothing (anything it changed was put back), so there is nothing new to check or test.
      setStatus(s, wf.steps.length ? "ready" : "idle");
    } else if (wf.steps.length === 0) {
      s.lastVerify = null;
      setStatus(s, ok ? "idle" : "failed");
    } else if (fixRound === 0 && holdNewAllowances(s)) {
      // Forge declared an output may come back with nothing in it: the person decides that before anything runs.
    } else {
      const realData = fixRound > 0 && s.fixOnRealData;
      const run = await verifyAndRun(s, s.requester, {
        auto: true,
        ...(fixRound > 0 ? { allowancesBefore: s.allowancesAtTurn } : {}),
        ...(realData ? { useProductionData: true } : {}),
      });
      followUp = settleTest(s, run, realData);
    }
    if (followUp && fixRound > 0 && noProgress(s.lastFixFailure, followUp)) {
      // The fix changed nothing the test can see: another round would argue with the same check.
      setStatus(s, "failed");
      pushNote(
        s,
        "The fix did not change the result: the test failed the same way again, so I stopped instead of trying again. " +
          "The failure is above; tell me what to change.",
      );
      followUp = null;
    } else if (followUp && fixRound >= MAX_AUTO_FIX) {
      setStatus(s, "failed");
      followUp = null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit(s, { type: "error", message: msg });
    setStatus(s, "failed");
    followUp = null;
  } finally {
    s.abort = null;
    if (!followUp) emit(s, { type: "done" });
  }
  if (followUp) {
    s.lastFixFailure = followUp;
    await runTurn(s, fixPrompt(followUp), fixRound + 1);
  } else {
    // Edge jobs that finished mid-turn (or while we were talking) — continue now that we are idle.
    flushPendingEdgeContinues(s);
  }
}

export type CreatePiSessionOpts = {
  goal?: string;
  /** Bind to an existing Foundry flow — at most one live Pi session per flow. */
  flowId?: string | null;
  /** For /flows/new: client UUID so parallel tabs do not share a sandbox. */
  draftKey?: string | null;
  /** Reopen a saved chat (0095). With a workflow, it opens as that workflow's conversation. */
  chatId?: string | null;
  /** Who opened it — for the welcome's greeting and their default mode. From the verified identity, never a body. */
  person?: { subject?: string | null; name?: string | null; email?: string | null } | null;
  /** The mode a NEW chat starts in, when the person picked one; otherwise their default. Ignored on a reopened chat. */
  mode?: ChatMode | null;
  /** A NEW chat started inside a project (sharing-boundaries phase 5). The route checks the person is in it. */
  projectId?: string | null;
};

export const piBuilderService = {
  decideProposal,
  clearAccount,
  async create(workspaceId: string, opts: CreatePiSessionOpts | string = {}): Promise<PiSessionPublic> {
    // Back-compat: create(ws, goalString)
    const o: CreatePiSessionOpts =
      typeof opts === "string" ? { goal: opts } : opts ?? {};
    // A saved chat (0095) is opened by its id, or as its workflow's conversation (the chat that last worked on it).
    const askedChat = o.chatId?.trim() || null;
    let chat = askedChat ? await piChatRepo.get(workspaceId, askedChat) : null;
    if (askedChat && !chat) throw httpErr("This chat is not here any more. Someone may have deleted it.", 404);
    const flowId = o.flowId?.trim() || chat?.flowId || null;
    if (!chat && flowId) chat = await piChatRepo.latestForFlow(workspaceId, flowId).catch(() => null);
    const draftKey = flowId || chat ? null : o.draftKey?.trim() || randomUUID();
    const goal = (o.goal ?? "").trim();

    // A workflow has ONE conversation (2026-10-10). Opening it while it is live — a second tab, a colleague, a
    // reload — JOINS that conversation. It used to destroy it, cutting off a turn still running and its sandbox.
    const sk = scopeKey(workspaceId, flowId, chat?.id ?? null, draftKey);
    const priorId = scopeIndex.get(sk);
    const prior = priorId ? sessions.get(priorId) : undefined;
    if (prior) {
      prior.lastSeenAt = Date.now();
      forgePool.warm(prior.workspaceId, prior.id);
      if (!prior.context) void refreshContext(prior);
      return publicOf(prior);
    }

    // An existing flow is opened from its saved draft (P3) — loaded BEFORE anything is created, so a flow that
    // cannot be opened here (wrong runtime, no bundle) is a clean refusal, not a half-built session.
    const saved = flowId ? await piFlowService.load(workspaceId, flowId) : null;
    // An unsaved chat comes back with what it had built (`draft_bundle`); a saved workflow from its saved draft.
    const draft = !saved && chat?.draftBundle ? (chat.draftBundle as { workflow: unknown; files: Record<string, string>; goal?: string }) : null;
    const startGoal = goal || chat?.goal?.trim() || saved?.flow.description?.trim() || draft?.goal?.trim() || "";
    const chatFiles = chat ? await piChatRepo.readFiles(chat.id) : [];

    // The mode (0097): a workflow opened from Workflows is built here; a reopened chat keeps its own; a new chat takes
    // what the person picked, or their default. Forge Agent only where the workspace offers it.
    const wsRow = await workspaceRepo.get(workspaceId).catch(() => null);
    const agentAllowed = wsRow?.assistant === true;
    const wanted: ChatMode =
      o.flowId?.trim()
        ? "workflow"
        : chat
          ? chat.mode === "agent" ? "agent" : "workflow"
          : o.mode ?? (await platformUserService.forgeDefaultMode(o.person?.subject).catch(() => "workflow" as const));
    const mode: ChatMode = wanted === "agent" && agentAllowed ? "agent" : "workflow";
    if (chat && chat.mode !== mode) void piChatRepo.update(chat.id, { mode }).catch(() => {});

    const id = randomUUID();
    const cataloguePath = await refreshWorkspaceCatalogue(workspaceId);
    createSessionTree(workspaceId, id, startGoal);
    writeSystemPrompt(workspaceId, id, mode);
    linkCatalogueIntoSandbox(workspaceId, id);
    layOutFiles(workspaceId, id, chatFiles);
    if (saved) writeBundle(workspaceId, id, saved.model, startGoal);
    else if (draft?.workflow) writeBundle(workspaceId, id, { workflow: draft.workflow, files: draft.files ?? {} }, startGoal);
    // Forge resumes the chat's conversation from its stored session file.
    if (chat?.forgeSession) {
      // Re-pointed at THIS sandbox: the stored file names the one it was written in, which no longer exists.
      writeFileSync(forgeSessionFile(workspaceId, id), rebaseForgeSession(chat.forgeSession, sandboxDir(workspaceId, id)));
    }
    // Forge's own tools reach the server with this conversation's key, written where they read it (never in steps/,
    // so it never travels with a workflow).
    const toolToken = randomBytes(24).toString("hex");
    writeFileSync(
      join(sandboxDir(workspaceId, id), ".forge-tool.json"),
      JSON.stringify({ url: config.forge.toolUrl ?? `http://127.0.0.1:${config.port}/api/forge`, token: toolToken }),
      { mode: 0o600 },
    );
    const priorMessages = Array.isArray(chat?.messages) ? (chat.messages as PiChatMessage[]) : [];
    const now = new Date().toISOString();
    const welcome: PiChatMessage = {
      id: randomUUID(),
      role: "assistant",
      welcome: true,
      // Written from this person, this workspace and this flow — see welcome.ts. The screen draws no welcome of its
      // own: it used to, and every conversation opened with two.
      text: await (async () => {
        const name = firstNameOf(o.person);
        if (saved) return savedWelcome(name, { name: saved.flow.name, workflow: saved.model.workflow as never });
        let cat: WelcomeCatalogue = {};
        try {
          cat = JSON.parse(readFileSync(cataloguePath, "utf8")) as WelcomeCatalogue;
        } catch {
          // An unreadable catalogue makes a plainer greeting, never a failed session.
        }
        return newWelcome(name, wsRow?.name ?? null, cat);
      })(),
      at: now,
    };
    const ownerSubject = chat?.createdBySubject?.trim() || o.person?.subject?.trim() || null;
    const generation = await loadGeneration(ownerSubject);
    const s: Session = {
      id,
      workspaceId,
      flowId,
      draftKey,
      chatId: chat?.id ?? null,
      ownerSubject,
      chatPending: null,
      // A new chat lives where it was started (a project the route held the person to), else where its workflow does.
      projectId: chat ? null : o.projectId?.trim() || saved?.flow.projectId || null,
      outBefore: outSnapshot(workspaceId, id),
      toolToken,
      status: saved || readWorkflow(workspaceId, id).steps.length ? "ready" : "idle",
      goal: startGoal,
      // A reopened chat brings its conversation back, then today's welcome — except an unsaved chat picking up where
      // it stopped, whose last message is already the right place to resume.
      messages: [...priorMessages, ...(saved || !priorMessages.length ? [welcome] : [])],
      liveActivities: [],
      lastVerify: null,
      lastTestRun: null,
      acceptedSnapshotId: null,
      savedRevision: saved?.revision ?? null,
      createdAt: now,
      updatedAt: now,
      bus: new EventEmitter(),
      abort: null,
      testing: false,
      draftText: "",
      draftThinking: "",
      thinkingMs: 0,
      thinkingSince: null,
      runInputs: {},
      allowancesAtTurn: [],
      heldAllowances: [],
      declinedAllowances: [],
      fixOnRealData: false,
      lastTestRealData: false,
      lastFixFailure: null,
      lastVolumeNote: "",
      lastBlank: [],
      lastEmptyDetail: null,
      lastModelError: null,
      lastTurn: null,
      lastRunId: null,
      requester: { subject: null, actor: "system", kind: "system" },
      lastSeenAt: Date.now(),
      context: null,
      compacting: false,
      mode,
      thinking: isThinkingLevel(chat?.thinking) ? chat.thinking : DEFAULT_THINKING,
      model: typeof chat?.model === "string" && chat.model.trim() ? chat.model.trim() : null,
      generation,
      agentAllowed,
      workflowRestored: false,
      storage: { bytes: 0, limit: config.forge.maxFolderBytes, chat: 0 },
      removedFiles: [],
      proposals: [],
      proposalOutcomes: [],
      accounts: chat?.connectionChoices && typeof chat.connectionChoices === "object" && !Array.isArray(chat.connectionChoices) ? (chat.connectionChoices as Record<string, PiAccountChoice>) : {},
      pendingEdgeContinues: [],
      edgeContinued: new Set(),
      filesBefore: new Set(),
      refs: chat ? await loadRefs(workspaceId, chat.id).catch(() => []) : [],
      refsMoved: [],
      reader: o.person ? { subject: o.person.subject ?? null, email: o.person.email ?? null } : null,
    };
    s.bus.setMaxListeners(50);
    measureStorage(s);
    sessions.set(id, s);
    toolTokens.set(toolToken, id);
    scopeIndex.set(sk, id);
    // The chat is open: load its Forge now, so the first message does not wait for one to start.
    forgePool.warm(workspaceId, id);
    void refreshContext(s);
    return publicOf(s);
  },

  get(workspaceId: string, sessionId: string): PiSessionPublic {
    return publicOf(getOrThrow(workspaceId, sessionId));
  },

  /** Drop session + sandbox. Safe to call on page leave. */
  destroy(workspaceId: string, sessionId: string): void {
    const s = getOrThrow(workspaceId, sessionId);
    destroySession(s);
  },

  /** Attach a draft session to a Foundry flow after Accept creates one. */
  bindFlow(workspaceId: string, sessionId: string, flowId: string): PiSessionPublic {
    const s = getOrThrow(workspaceId, sessionId);
    const nextFlow = flowId.trim();
    if (!nextFlow) {
      const err = new Error("flowId required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    // Evict whoever currently owns this flow.
    const flowSk = scopeKey(workspaceId, nextFlow, null, null);
    const occupant = scopeIndex.get(flowSk);
    if (occupant && occupant !== s.id) {
      const other = sessions.get(occupant);
      if (other) destroySession(other);
    }
    // Drop old draft scope index entry
    const oldSk = scopeKey(s.workspaceId, s.flowId, s.chatId, s.draftKey);
    if (scopeIndex.get(oldSk) === s.id) scopeIndex.delete(oldSk);
    s.flowId = nextFlow;
    if (s.chatId) void piChatRepo.update(s.chatId, { flowId: nextFlow, draftBundle: null }).catch(() => {});
    s.draftKey = null;
    scopeIndex.set(flowSk, s.id);
    void usageService.attachSession(s.id, nextFlow, null);
    touch(s);
    persistChat(s);
    persistForgeSession(s);
    return publicOf(s);
  },

  /**
   * Switch the chat between Workflow Builder and Forge Agent (0097). Applies from the next message: Forge restarts with
   * the new mode's instructions and resumes the conversation. The workflow stays as it is in both modes.
   */
  async setMode(workspaceId: string, sessionId: string, mode: ChatMode): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort || s.testing) throw httpErr("Forge is still working. Wait for it to finish, then switch.", 409);
    const ws = await workspaceRepo.get(workspaceId).catch(() => null);
    if (ws) s.agentAllowed = ws.assistant === true;
    if (mode === "agent" && !s.agentAllowed) {
      throw httpErr("Forge Agent is not turned on for this workspace. A super admin can turn it on under Purpose and access.", 403);
    }
    if (s.mode !== mode) {
      applyMode(s, mode);
      // Switches with nothing said in between make ONE note (2026-10-13): see `withModeNote`.
      s.messages = withModeNote(s.messages, mode);
      persistChat(s);
      emit(s, { type: "messages", messages: s.messages });
    }
    return publicOf(s);
  },

  /**
   * Set how hard Forge Agent thinks (0119). Applies from the next message: Forge restarts with the new effort and
   * resumes the conversation, as a mode switch does. Kept with the chat.
   */
  async setThinking(workspaceId: string, sessionId: string, level: ThinkingLevel): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort || s.testing) throw httpErr("Forge is still working. Wait for it to finish, then change it.", 409);
    if (s.thinking !== level) {
      s.thinking = level;
      // Only an agent chat's process runs with the level; a workflow chat's effort is unchanged, so it keeps its Forge.
      if (s.mode === "agent") forgePool.release(s.id);
      if (s.chatId) void piChatRepo.update(s.chatId, { thinking: level }).catch((e) => console.warn(`[pi-builder] could not store chat ${s.chatId}'s thinking level: ${(e as Error).message}`));
      pushNote(s, thinkingNote(level));
    }
    return publicOf(s);
  },

  /**
   * Set the model this chat's Forge runs with (2026-11-03), from the models turned on for the builder. Applies from the
   * next message: Forge restarts with it and resumes the conversation. Kept with the chat.
   */
  async setModel(workspaceId: string, sessionId: string, model: string): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort || s.testing) throw httpErr("Forge is still working. Wait for it to finish, then change it.", 409);
    s.generation = (await loadGeneration(s.ownerSubject)) ?? s.generation;
    const bare = bareModel(model);
    if (!modelChoices(s.generation, piModel()).includes(bare)) {
      throw httpErr("That model is not turned on for the Workflow Builder. Choose one from the list.", 400);
    }
    const changed = bare !== forgeModelOf(s);
    if (changed || s.model !== bare) {
      s.model = bare;
      // The model applies to both modes, so Forge restarts either way.
      forgePool.release(s.id);
      if (s.chatId) void piChatRepo.update(s.chatId, { model: bare }).catch((e) => console.warn(`[pi-builder] could not store chat ${s.chatId}'s model: ${(e as Error).message}`));
      if (changed) pushNote(s, modelNote(bare));
    }
    return publicOf(s);
  },

  /**
   * Remove a file from this chat (2026-10-13): from Forge's folder (`files/` or `out/`) and from the saved chat. Its
   * cards stay in the conversation, marked removed, and the next turn tells Forge it is gone. Refused while Forge is
   * working, and while this chat's workflow reads it (the next test would fail on a missing file).
   */
  async removeChatFile(workspaceId: string, sessionId: string, name: string): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort || s.testing) throw httpErr("Forge is still working. Wait for it to finish, then remove the file.", 409);
    if (!name || name !== basename(name) || name.startsWith(".")) throw httpErr("That is not a file in this chat.", 400);
    if (JSON.stringify(readWorkflow(s.workspaceId, s.id)).includes(JSON.stringify(`file:${name}`))) {
      throw httpErr(`This chat's workflow reads "${name}". Take it out of the workflow first, then remove the file.`, 409);
    }
    const sbx = sandboxDir(s.workspaceId, s.id);
    let found = false;
    for (const dir of ["files", "out"]) {
      const p = join(sbx, dir, name);
      try {
        // A link is removed as a link (rmSync does not follow one); a folder of that name is not a chat file.
        if (lstatSync(p).isDirectory()) continue;
        rmSync(p, { force: true });
        found = true;
      } catch {
        // Not there.
      }
    }
    if (s.chatId) found = (await piChatRepo.removeFile(s.chatId, name)) || found;
    const mentioned = markRemoved(s, name);
    if (!found && !mentioned) throw httpErr(`There is no file named "${name}" in this chat.`, 404);
    if (!s.removedFiles.includes(name)) s.removedFiles.push(name);
    persistChat(s);
    emit(s, { type: "messages", messages: s.messages });
    measureStorage(s);
    return publicOf(s);
  },

  /** A page is showing this conversation (its event stream opened). Cancels the 30-second leave grace. */
  connected(workspaceId: string, sessionId: string): void {
    const s = getOrThrow(workspaceId, sessionId);
    s.lastSeenAt = Date.now();
    forgePool.connect(s.id);
  },

  /** A page stopped showing it. With none left, its Forge exits after the grace (or when a running turn ends). */
  disconnected(workspaceId: string, sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s || s.workspaceId !== workspaceId) return;
    s.lastSeenAt = Date.now();
    forgePool.disconnect(s.id);
  },

  /** Live Forge processes — for health and the operator. */
  forgeStats() {
    return forgePool.stats();
  },

  subscribe(workspaceId: string, sessionId: string, fn: (ev: PiEvent) => void): () => void {
    const s = getOrThrow(workspaceId, sessionId);
    const handler = (ev: PiEvent) => fn(ev);
    s.bus.on("event", handler);
    return () => s.bus.off("event", handler);
  },

  async message(
    workspaceId: string,
    sessionId: string,
    text: string,
    requester?: RunRequester,
    by?: PiAuthor | null,
    retry = false,
    attachmentNames: string[] = [],
  ): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (requester) s.requester = requester;
    if (retry) {
      // Try again on a failure card: the last turn, re-run as it was.
      if (!s.lastTurn) throw httpErr("there is nothing to try again", 409);
      readyForTurn(s);
      void runTurn(s, s.lastTurn.userText, s.lastTurn.fixRound, undefined, true);
      return publicOf(s);
    }
    const trimmed = text.trim();
    const attached = attachedFiles(s, attachmentNames);
    if (!trimmed && attached.length === 0) {
      const err = new Error("message required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    readyForTurn(s);
    if (s.mode === "workflow" && !s.goal.trim() && looksLikeAutomationGoal(trimmed)) {
      s.goal = trimmed;
      writeGoal(s.workspaceId, s.id, trimmed);
    }
    // The person's first message saves the chat (0095); the files it sends are kept with it.
    const chatId = await ensureChat(s, chatTitle(trimmed, attached.map((f) => f.name), s.goal), by ?? null);
    await keepSentFiles(s, chatId, attached);
    readyForTurn(s);
    // The person's words are shown as they wrote them; the agent is also told where the files are.
    void runTurn(s, withAttachments(trimmed, attached), 0, {
      text: trimmed,
      ...(by ? { by } : {}),
      ...(attached.length ? { attachments: attached } : {}),
    });
    return publicOf(s);
  },

  /**
   * Give a message to the turn that is running (2026-11-03). Works in Workflow Builder and Forge Agent alike. The
   * ownership and permission checks are the send route's.
   */
  async steer(workspaceId: string, sessionId: string, text: string, by?: PiAuthor | null): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    const trimmed = text.trim();
    if (!trimmed) throw httpErr("message required", 400);
    const forge = forgePool.peek(s.id);
    const refusal = steerRefusal({ running: s.abort != null, testing: s.testing, compacting: s.compacting, forgeBusy: forge?.busy === true });
    if (refusal) throw httpErr(refusal, 409);
    if (!forge!.steer(trimmed)) throw httpErr("Forge is checking its work now. Your message will wait until it finishes.", 409);
    const msg: PiChatMessage = { id: randomUUID(), role: "user", text: trimmed, at: new Date().toISOString(), mode: s.mode, ...(by ? { by } : {}) };
    s.messages.push(msg);
    emit(s, { type: "message", message: msg });
    persistChat(s);
    s.lastSeenAt = Date.now();
    touch(s);
    return publicOf(s);
  },

  /** Store a file for this workflow's chat (attachments.ts). It is sent with the next message that names it. */
  attach(workspaceId: string, sessionId: string, body: Buffer, name: string | null): PiAttachment {
    const s = getOrThrow(workspaceId, sessionId);
    touch(s);
    const stored = storeAttachment(s.workspaceId, s.id, body, name);
    measureStorage(s);
    return stored;
  },

  /** Remove a file before it is sent. One a sent message names stays — the conversation refers to it. */
  detach(workspaceId: string, sessionId: string, name: string): void {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.messages.some((m) => m.attachments?.some((a) => a.name === name))) {
      throw httpErr("That file was already sent in this conversation, so it stays.", 409);
    }
    if (!removeAttachment(s.workspaceId, s.id, name)) throw httpErr("no such attachment", 404);
  },

  async answer(
    workspaceId: string,
    sessionId: string,
    answers: Record<string, string>,
    requester?: RunRequester,
    by?: PiAuthor | null,
  ): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (requester) s.requester = requester;
    readyForTurn(s);
    await ensureChat(s, chatTitle("", [], s.goal), by ?? null);
    const asked = readQuestions(s.workspaceId, s.id).questions ?? [];
    // Every answer fits its question (question-kinds.ts) before anything is decided or told to Forge.
    const wrong = Object.entries(answers).flatMap(([id, a]) => {
      const q = asked.find((x) => x.id === id);
      const c = q ? checkAnswer(q, a) : { ok: true as const };
      return c.ok ? [] : [c.reason];
    });
    if (wrong.length) throw httpErr(wrong.join(" "), 400);

    // "May this come back empty?" and "which columns may be blank?" are decided here, by code — never handed to
    // Forge to interpret.
    // ⚠ An answered question leaves the card HERE, by code. It used to stay in questions.json until Forge cleared it
    // ("Clear questions.json and continue"), and a turn that forgot (Forge Agent mode, chat 4ecefa5a) showed the same
    // card again after its reply, so the person answered it twice and Forge redid the work for the second answer.
    // After the two settles below: each rewrites the file from `asked` minus only its own questions.
    const answeredIds = new Set(Object.keys(answers));
    const decided = settleHeldAllowances(s, answers, asked, by ?? null);
    const columns = settleBlankColumns(s, answers, asked, by ?? null);
    if (answeredIds.size) writeQuestionsRaw(s.workspaceId, s.id, asked.filter((q) => !answeredIds.has(q.id)));
    answers = Object.fromEntries(
      Object.entries(answers).filter(([id]) => !id.startsWith(HOLD_PREFIX) && !id.startsWith(BLANK_PREFIX)),
    );
    if ((decided || columns.settled) && Object.keys(answers).length === 0 && !columns.mustFill.length) {
      setStatus(s, "running");
      inBackground(s, async () => {
        await testThenSettle(s, s.requester, { auto: true, ...(s.lastTestRealData ? { useProductionData: true } : {}) });
      });
      return publicOf(s);
    }
    const stored = Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, toStored(asked.find((q) => q.id === id), a)]));
    const merged = { ...readAnswers(s.workspaceId, s.id), ...stored };
    if (Object.keys(answers).length) writeAnswers(s.workspaceId, s.id, merged);
    const answered = asked
      .filter((q) => typeof answers[q.id] === "string")
      .map((q) => ({ id: q.id, prompt: q.prompt, ...(q.choices?.length ? { choices: q.choices } : {}), answer: answers[q.id]! }));
    const told = [
      ...(Object.keys(answers).length
        ? [`Answers are in answers.json: ${JSON.stringify(merged)}. Those questions are answered and off the card; continue.`]
        : []),
      ...columns.mustFill,
    ].join("\n\n");
    void runTurn(
      s,
      told,
      0,
      { text: answered.map((a) => `${a.prompt}\n→ ${a.answer}`).join("\n\n") || "Answered.", answers: answered, ...(by ? { by } : {}) },
      // Only column answers: they are already in the chat (settleBlankColumns), so this turn records no second copy.
      answered.length === 0,
    );
    return publicOf(s);
  },

  async verify(workspaceId: string, sessionId: string): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    const verify = await runHarness(s.workspaceId, s.id, "verifier/verify.mjs");
    s.lastVerify = verify;
    touch(s);
    emit(s, { type: "verify", ok: verify.ok, detail: verify.detail, ...(verify.ok ? {} : { summary: "The workflow did not pass its checks." }) });
    if (verify.ok) setStatus(s, "ready");
    return publicOf(s);
  },

  accept(workspaceId: string, sessionId: string, label = "accept"): PiSessionPublic {
    const s = getOrThrow(workspaceId, sessionId);
    const snap = takeSnapshot(s.workspaceId, s.id, label);
    s.acceptedSnapshotId = snap.id;
    touch(s);
    emit(s, { type: "snapshot", id: snap.id, label: snap.label });
    setStatus(s, "accepted");
    return publicOf(s);
  },
  /**
   * "Compact now" on the context meter: Forge summarises the earlier conversation to make room (pi's `compact`).
   * Refused while it is working or testing; a message sent meanwhile is refused with a sentence (`readyForTurn`).
   */
  async compact(workspaceId: string, sessionId: string): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.compacting) throw httpErr("Forge is already making room in this conversation.", 409);
    readyForTurn(s);
    if (!s.messages.some((m) => m.role === "user")) throw httpErr("There is nothing to summarise yet.", 409);
    const forge = forgePool.acquire(s.workspaceId, s.id);
    s.compacting = true;
    emit(s, { type: "compacting", on: true });
    forgePool.turnStarted(s.id);
    try {
      await forge.request({ type: "compact" }, config.forge.turnTimeoutMs);
      pushNote(s, "Forge summarised the earlier messages to make room. It keeps a summary of them, and everything it built is unchanged.");
    } catch (e) {
      throw httpErr(`The conversation could not be summarised: ${(e as Error).message}. Nothing was changed.`, 502);
    } finally {
      s.compacting = false;
      forgePool.turnEnded(s.id);
      persistForgeSession(s);
      emit(s, { type: "compacting", on: false });
    }
    await refreshContext(s);
    return publicOf(s);
  },

  stop(workspaceId: string, sessionId: string): PiSessionPublic {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort) {
      // Forge is asked to stop (and killed if it has not within a few seconds). The turn clears itself when it
      // ends — clearing it here let the next message reach a process still finishing the old one.
      s.abort.abort();
      return publicOf(s);
    }
    setStatus(s, "idle");
    emit(s, { type: "done" });
    return publicOf(s);
  },

  /**
   * Verify, then a REAL draft run of this session's bundle on flow-runner (pi-runtime P2) — the same executor
   * and the same step API a production run uses, against mock data with mail captured. "Green here" therefore
   * means the code path that runs in production went green, not that a sandbox imitation did.
   */
  async testRun(
    workspaceId: string,
    sessionId: string,
    requester: RunRequester,
    inputs?: Record<string, unknown>,
    opts: { useProductionData?: boolean } = {},
  ): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    // What the person typed is the run's input; absent, the run uses the declared defaults. Kept on the session so
    // the next automatic test after an edit runs with the same values, not silently back on the defaults.
    if (inputs) {
      // Checked BEFORE it is remembered: a refused value kept on the session would fail every automatic test after
      // the next edit, for a reason the person already saw and corrected.
      const { problems } = runInputsOf(readBundle(s.workspaceId, s.id).workflow, inputs);
      if (problems.length) throw httpErr(`the test's inputs do not fit the workflow:\n- ${problems.join("\n- ")}`, 422);
      s.runInputs = inputs;
    }
    if (s.abort) {
      const err = new Error("Forge is still working. Stop it first.") as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    if (s.testing) throw httpErr("A test run is already going. Wait for it to finish.", 409);
    setStatus(s, "running");
    // In the background (2026-10-12): the request answers at once and the result arrives on the session's event
    // stream (`test_run`, then `done`), which every open page already listens to. It used to hold the request open for
    // the whole run (up to five minutes), so a slow test tied up one of the browser's few connections to the site.
    inBackground(s, async () => {
      await testThenSettle(s, requester, opts);
    });
    return publicOf(s);
  },

  /**
   * Decide the approval this session's test run is waiting at, as the person testing it, and follow the run to its
   * end (pi-runtime P5). A test runs on test data and captures mail, so the person who started it may decide it.
   */
  async decideTest(
    workspaceId: string,
    sessionId: string,
    decision: "approved" | "rejected",
    requester: RunRequester,
  ): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    const runId = s.lastRunId;
    if (!runId || !s.lastTestRun?.waiting) throw httpErr("the last test run is not waiting for an approval", 409);
    const pending = ((await stepApprovalService.listForExecution(workspaceId, runId)) ?? []).find((a) => !a.decidedAt && !a.expiredAt);
    if (!pending) throw httpErr("the test run's approval was already decided", 409);
    if (s.testing) throw httpErr("A test run is already going. Wait for it to finish.", 409);
    await stepApprovalService.decide(workspaceId, pending.id, { decision, decidedBy: requester.actor });
    setStatus(s, "running");
    // The rest of the run follows in the background, like `testRun`: the decision is recorded, the request answers.
    inBackground(s, async () => {
      const run = await flowRunnerService.waitForRun(runId);
      const ok = run.status === "succeeded" || run.status === "waiting" || run.status === "rejected";
      const waiting = waitingOf(run);
      const detail = describeRun(run);
      const summary = summariseRun(run);
      s.lastTestRun = { ok, detail, summary, at: new Date().toISOString(), runId, waiting, needsRealData: false };
      emit(s, { type: "test_run", ok, detail, summary, runId, waiting, needsRealData: false });
      setStatus(s, ok ? "ready" : "failed");
    });
    return publicOf(s);
  },

  /**
   * Save the session's bundle as the flow's next draft revision (pi-runtime P3) — no compile, no Kestra.
   * Refused when the verifier fails (P0-I2: a flow known to be broken must not become a saved revision). A failed
   * test run does NOT block the save — the person may want to keep work in progress — but it is stated beside it.
   */
  async saveVersion(
    workspaceId: string,
    sessionId: string,
    opts: { name?: string; author: RevisionAuthor },
  ): Promise<PiSessionPublic> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort) throw httpErr("Forge is still working. Wait for it to finish, then save.", 409);
    const wf = readWorkflow(s.workspaceId, s.id) as PiWorkflow & { name?: string };
    if (!wf.steps.length) throw httpErr("the workflow has no steps to save", 400);
    const verify = await runHarness(s.workspaceId, s.id, "verifier/verify.mjs");
    s.lastVerify = verify;
    emit(s, { type: "verify", ok: verify.ok, detail: verify.detail, ...(verify.ok ? {} : { summary: "The workflow did not pass its checks." }) });
    if (!verify.ok) throw httpErr(`Not saved. The workflow doesn't pass its checks yet:\n${verify.detail}`, 409);
    // A file from this chat that the workflow reads goes into the workspace's Files, where a saved workflow reads it.
    const copied = await copyChatFilesToWorkspace(s, wf, opts.author);

    const name =
      opts.name?.trim() ||
      (typeof wf.name === "string" ? wf.name.trim().slice(0, 120) : "") ||
      s.goal.trim().slice(0, 80) ||
      "Untitled automation";
    const bundleToSave = readBundle(s.workspaceId, s.id);
    // ⚠ Somebody else saved a different workflow since this chat last did (sharing-boundaries P2-I2): saving would
    // silently undo their change. Refused, naming them. A newer version that changed only whose account a service runs
    // as is not a conflict — that choice is kept below.
    const current = s.flowId ? await piFlowService.load(workspaceId, s.flowId).catch(() => null) : null;
    if (current && s.savedRevision != null && current.revision > s.savedRevision) {
      const base = await flowRepo.getRevision(s.flowId!, s.savedRevision);
      if (workflowChanged(base?.modelJson as never, current.model)) {
        const newer = await flowRepo.getRevision(s.flowId!, current.revision);
        const who = newer?.createdBy ?? "Someone";
        // Catch the chat up rather than leave it stuck: its own version is kept as a snapshot, the newer saved one is
        // put in its place, and the person is told their change was not saved.
        takeSnapshot(s.workspaceId, s.id, `unsaved, set aside for revision ${current.revision}`);
        restoreWorkflowSnapshot(s.workspaceId, s.id, JSON.stringify({ workflow: current.model.workflow, files: current.model.files }), s.goal);
        s.savedRevision = current.revision;
        const note: PiChatMessage = {
          id: randomUUID(),
          role: "system",
          text: `${who} saved a newer version of this workflow while this chat was open. This chat now shows their version; your change was not saved. Ask Forge for it again and it will be made on top of theirs.`,
          at: new Date().toISOString(),
        };
        s.messages.push(note);
        emit(s, { type: "message", message: note });
        persistChat(s);
        throw httpErr(`Not saved: ${who} saved a newer version first. This chat now shows it; ask for your change again.`, 409);
      }
    }
    // Whose account each service runs as is part of what is saved and approved (8.6) — chosen, never assumed. What the
    // workflow's page chose (e.g. each person's own account) is kept unless this chat chose otherwise.
    const accounts = await workflowAccounts(s, bundleToSave, s.requester?.subject ?? null, { kind: "save" }, current?.model.accounts);
    const saved = await piFlowService.save({
      workspaceId,
      flowId: s.flowId,
      accounts,
      bundle: bundleToSave,
      name,
      description: s.goal.trim() || null,
      author: opts.author,
    });
    if (!s.flowId) {
      s.flowId = saved.flowId;
      // What this conversation cost to build before it had a workflow now belongs to the workflow.
      void usageService.attachSession(s.id, saved.flowId, name);
      const oldSk = scopeKey(workspaceId, null, s.chatId, s.draftKey);
      if (scopeIndex.get(oldSk) === s.id) scopeIndex.delete(oldSk);
      s.draftKey = null;
      scopeIndex.set(scopeKey(workspaceId, s.flowId, null, null), s.id);
      // The chat now has a workflow: it is that workflow's conversation, and its draft lives in the workflow.
      if (s.chatId) void piChatRepo.update(s.chatId, { flowId: saved.flowId, draftBundle: null }).catch(() => {});
      // The person whose conversation built it owns it (rbac-observability) — even when the save ran outside a request.
      void flowRepo.claimOwner(workspaceId, saved.flowId, s.requester.subject ?? null).catch(() => {});
    }
    s.savedRevision = saved.revision;
    const snap = takeSnapshot(s.workspaceId, s.id, `revision ${saved.revision}`);
    s.acceptedSnapshotId = snap.id;
    emit(s, { type: "saved", flowId: saved.flowId, revision: saved.revision });
    if (copied.length) {
      const note: PiChatMessage = {
        id: randomUUID(),
        role: "system",
        text:
          `Copied ${copied.map((n) => `"${n}"`).join(", ")} from this chat to the workspace's Files (Resources → Files). ` +
          "The workflow reads it from there when it runs, so it keeps working if this chat is deleted.",
        at: new Date().toISOString(),
      };
      s.messages.push(note);
      emit(s, { type: "message", message: note });
    }
    persistChat(s);
    persistForgeSession(s);
    touch(s);
    return publicOf(s);
  },

  /**
   * Put a plain schedule on the session's workflow (personal Phase 1), then optionally save + switch it on.
   *
   * ⚠ **Only the allowlisted presets.** Free cron is refused — the product surface is words, not crontab.
   * ⚠ **Arming needs a green test run** (`lastTestRun.ok`). Declaring a schedule without arming still
   * requires a green test so an untested draft cannot pick up a timer from the overview later by surprise.
   */
  async setSchedule(
    workspaceId: string,
    sessionId: string,
    opts: {
      cron: string;
      timezone?: string;
      /** Save the draft and switch the saved revision on (Foundry runner schedule tick). */
      arm?: boolean;
      author: RevisionAuthor;
      subject: string;
      actor: string;
    },
  ): Promise<{ session: PiSessionPublic; armed: boolean; label: string }> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.abort) throw httpErr("Forge is still working. Wait for it to finish, then schedule.", 409);
    const cron = opts.cron.trim();
    if (!isAllowedScheduleCron(cron)) {
      throw httpErr("Pick one of the suggested schedules — a custom cron is not accepted here.", 400);
    }
    try {
      parseCron(cron);
    } catch (e) {
      throw httpErr((e as Error).message, 400);
    }
    const timezone = (opts.timezone?.trim() || "UTC").slice(0, 64);
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      throw httpErr(`"${timezone}" is not a timezone`, 400);
    }
    if (!s.lastTestRun?.ok) {
      throw httpErr("Run a successful test before scheduling this workflow.", 409);
    }
    const wf = readWorkflowRaw(s.workspaceId, s.id) as Record<string, unknown>;
    if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
      throw httpErr("the workflow has no steps to schedule", 400);
    }
    wf.schedule = { cron, timezone };
    writeWorkflowRaw(s.workspaceId, s.id, wf);
    emit(s, { type: "workflow", workflow: readWorkflow(s.workspaceId, s.id), files: readBundle(s.workspaceId, s.id).files });
    const label = labelForCron(cron) ?? cron;

    if (!opts.arm) {
      touch(s);
      return { session: publicOf(s), armed: false, label };
    }

    const saved = await this.saveVersion(workspaceId, sessionId, { author: opts.author });
    if (!saved.flowId || saved.savedRevision == null) {
      throw httpErr("Saved, but there is no workflow id to switch on.", 500);
    }
    try {
      await flowApprovalService.enableOwn(workspaceId, saved.flowId, {
        revision: saved.savedRevision,
        subject: opts.subject,
        actor: opts.actor,
        note: `Switched on from chat with schedule: ${label} (${timezone}).`,
      });
    } catch (e) {
      // Schedule is on the saved draft; arming failed (needs reviewer, shared, etc.). Surface that honestly.
      const err = e as Error & { statusCode?: number };
      throw httpErr(
        `${label} is on the saved draft, but it could not be switched on yet: ${err.message}`,
        err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 409,
      );
    }
    return { session: saved, armed: true, label };
  },

  // ── Workflow references (plans/workflow-references-2026-10-16) ────────────────────────────────────────────────
  // Same workspace, saved workflows only, never the chat's own, at most MAX_REFERENCES, Workflow Builder only. A
  // reference pins one saved version; only the person moves it.

  /** Who is using the chat now, as verified — whose read access the references are re-checked against each turn. */
  noteReader(workspaceId: string, sessionId: string, identity: Identity | null | undefined): void {
    const s = sessions.get(sessionId);
    if (s && s.workspaceId === workspaceId && identity?.subject) s.reader = { subject: identity.subject, email: identity.email ?? null };
  },

  /** The workspace's saved workflows this chat may reference (not already referenced, never its own). */
  async referenceable(workspaceId: string, sessionId: string, viewer?: Viewer): Promise<Referenceable[]> {
    const s = getOrThrow(workspaceId, sessionId);
    const taken = new Set(s.refs.flatMap((r) => (r.flowId ? [r.flowId] : [])));
    return (await listReferenceable(workspaceId, s.flowId, viewer)).filter((r) => !taken.has(r.flowId));
  },

  /** The chat's references, as the chips show them. */
  async references(workspaceId: string, sessionId: string): Promise<ReferenceView[]> {
    const s = getOrThrow(workspaceId, sessionId);
    return viewsOf(workspaceId, s.refs);
  },

  /** Reference a saved workflow, pinned to its latest saved version. */
  async addReference(
    workspaceId: string,
    sessionId: string,
    flowId: string,
    by: string | null,
    viewer?: Viewer,
  ): Promise<ReferenceView[]> {
    const s = getOrThrow(workspaceId, sessionId);
    if (s.mode !== "workflow") throw httpErr("Referenced workflows are used in Workflow Builder only.", 409);
    if (s.refs.length >= MAX_REFERENCES) {
      throw httpErr(`A chat can reference at most ${MAX_REFERENCES} workflows. Remove one to add another.`, 409);
    }
    if (flowId === s.flowId) throw httpErr("This is the chat's own workflow, so it cannot reference itself.", 409);
    if (s.refs.some((r) => r.flowId === flowId)) throw httpErr("This chat already references that workflow.", 409);
    let ref = newRef(await snapshotOf(workspaceId, flowId, undefined, viewer), by);
    if (s.chatId) ref = await storeRef(workspaceId, s.chatId, ref);
    s.refs.push(ref);
    touch(s);
    emit(s, { type: "references" });
    return viewsOf(workspaceId, s.refs);
  },

  /** Move a reference to another saved version — a newer one (⟳) or an older one from the version list. */
  async setReferenceVersion(
    workspaceId: string,
    sessionId: string,
    refId: string,
    revision: number,
    viewer?: Viewer,
  ): Promise<ReferenceView[]> {
    const s = getOrThrow(workspaceId, sessionId);
    const i = s.refs.findIndex((r) => r.id === refId);
    const cur = s.refs[i];
    if (!cur) throw httpErr("no such reference", 404);
    if (!cur.flowId) throw httpErr("That workflow has been deleted, so its version cannot change.", 409);
    if (cur.revision === revision) return viewsOf(workspaceId, s.refs);
    const snap = await snapshotOf(workspaceId, cur.flowId, revision, viewer);
    s.refs[i] = { ...cur, ...snap };
    if (cur.stored) {
      await piChatReferenceRepo.setRevision(workspaceId, cur.id, {
        revision: snap.revision,
        cardMd: snap.cardMd,
        bundleJson: snap.bundle,
        flowNameSnapshot: snap.name.slice(0, 200),
      });
    }
    s.refsMoved.push(
      `Reference updated: "${snap.name}", saved ${cur.revision} → saved ${snap.revision}. Use saved ${snap.revision} from now on; do not mix in what saved ${cur.revision} said earlier in this chat.`,
    );
    touch(s);
    emit(s, { type: "references" });
    return viewsOf(workspaceId, s.refs);
  },

  /** Stop referencing a workflow. Its copy leaves the folder on the next turn. */
  async removeReference(workspaceId: string, sessionId: string, refId: string): Promise<ReferenceView[]> {
    const s = getOrThrow(workspaceId, sessionId);
    const cur = s.refs.find((r) => r.id === refId);
    if (!cur) throw httpErr("no such reference", 404);
    if (cur.stored) await piChatReferenceRepo.remove(workspaceId, cur.id);
    s.refs = s.refs.filter((r) => r.id !== refId);
    touch(s);
    emit(s, { type: "references" });
    return viewsOf(workspaceId, s.refs);
  },

  /** The workspace's saved chats, newest first. */
  async listChats(workspaceId: string): Promise<PiChatSummary[]> {
    return piChatRepo.list(workspaceId);
  },

  /**
   * What a live Forge session is about, for the content guard (rbac-observability): its chat, its workflow, and
   * who opened it. Null when the session is not here (the route then answers its own 404).
   */
  sessionScope(workspaceId: string, sessionId: string): { chatId: string | null; flowId: string | null; requesterSubject: string | null } | null {
    const s = sessions.get(sessionId);
    if (!s || s.workspaceId !== workspaceId) return null;
    return { chatId: s.chatId, flowId: s.flowId, requesterSubject: s.requester.subject ?? null };
  },

  /** Who started a chat — the route decides with it whether this caller may delete it. Null when not found. */
  async chatOwner(workspaceId: string, chatId: string): Promise<{ subject: string | null } | null> {
    const chat = await piChatRepo.get(workspaceId, chatId);
    return chat ? { subject: chat.createdBySubject } : null;
  },

  /** Delete a chat, its files and Forge's history. A workflow it built is not touched. An open page is closed. */
  async deleteChat(workspaceId: string, chatId: string): Promise<void> {
    for (const s of [...sessions.values()]) {
      if (s.workspaceId === workspaceId && s.chatId === chatId) {
        emit(s, { type: "error", message: "This chat was deleted." });
        destroySession(s);
      }
    }
    if (!(await piChatRepo.remove(workspaceId, chatId))) throw httpErr("This chat is not here any more.", 404);
  },

  /** Give a chat a new name. The route decides who may (the same people as delete). */
  async renameChat(workspaceId: string, chatId: string, title: string): Promise<void> {
    if (!(await piChatRepo.rename(workspaceId, chatId, title))) throw httpErr("This chat is not here any more.", 404);
  },

  /** One of a chat's stored files, to download. */
  async chatFile(workspaceId: string, chatId: string, name: string): Promise<{ name: string; contentType: string; body: Buffer }> {
    const chat = await piChatRepo.get(workspaceId, chatId);
    if (!chat) throw httpErr("This chat is not here any more.", 404);
    const [file] = await piChatRepo.readFiles(chat.id, [name]);
    if (!file) throw httpErr("That file is not in this chat.", 404);
    return file;
  },

  /**
   * Assistant mode: Forge answers a question from the workspace's REAL data, read-only (`tools/ask-data.mjs` →
   * `POST /api/forge/data`). Every gate is code, checked on each call:
   *  - the key names a live conversation, and only while one of its turns is running (Forge is answering someone);
   *  - the workspace has assistant mode on NOW (a switch turned off stops the next read, not the next session);
   *  - the statement passes the same read-only shape check a workflow's read does, and runs the same way a live
   *    workflow's read runs (inside a read-only transaction where the datasource's policy says so);
   *  - at most ASK_ROWS rows go back to Forge, with the true count;
   *  - every read is recorded in the workspace's audit log as a data access by the person Forge was answering.
   */
  /**
   * A workspace File's bytes for Forge to look at while it builds (tools/open-file.mjs) — a rate card, a template, a
   * policy the workflow will read when it runs. Any workspace may: these files exist for workflows, unlike the live
   * data `askData` reads. Only mid-turn, by a live conversation's key; a wrong name is answered with the real names.
   */
  async openWorkspaceFile(token: string, name: string, opts: { project?: boolean } = {}): Promise<{ data: Buffer }> {
    const sid = toolTokens.get(token);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
    if (!s.abort) throw httpErr("Files can only be opened while Forge is answering a message.", 409);
    if (opts.project) {
      // Where the chat lives NOW decides: read from its row, as each turn does, so a chat moved out opens nothing.
      const projectId = s.chatId ? ((await piChatRepo.get(s.workspaceId, s.chatId))?.projectId ?? null) : s.projectId;
      if (!projectId) throw httpErr("This chat is not in a project, so it has no project files.", 404);
      const file = await projectFileService.readForChat(s.workspaceId, projectId, name);
      if (!file) {
        const ctx = await projectService.contextOf(s.workspaceId, projectId);
        const names = ctx?.files ?? [];
        throw httpErr(`There is no file named "${name}" in this project. ${names.length ? `Its files are: ${names.join(", ")}.` : "It has no files."}`, 404);
      }
      return file;
    }
    const file = await workspaceFileService.read(s.workspaceId, { name });
    if (!file) {
      const names = (await workspaceFileService.list(s.workspaceId)).map((f) => f.name);
      throw httpErr(
        `There is no file named "${name}" in this workspace's Files. ${names.length ? `Its files are: ${names.join(", ")}.` : "It has no files."}`,
        404,
      );
    }
    return { data: file.data };
  },

  /**
   * A public web address read while Forge answers (tools/fetch-url.mjs, 2026-10-30) — to see a feed's or a page's shape
   * before writing the step that reads it with `web_fetch`. The same service and rules as the workflow tool: the
   * workspace's web access must be on, public addresses only, and the call is recorded against this conversation.
   */
  async fetchWeb(token: string, url: string, opts: { raw?: boolean } = {}): Promise<WebFetchResult> {
    const sid = toolTokens.get(token);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
    if (!s.abort) throw httpErr("Web pages can only be read while Forge is answering a message.", 409);
    try {
      return await webFetch(s.workspaceId, url, { sessionId: s.id, actor: s.requester.actor }, { raw: opts.raw });
    } catch (e) {
      if (e instanceof WebFetchError) throw httpErr(e.message, e.statusCode);
      throw e;
    }
  },

  async askData(token: string, datasource: string, sql: string): Promise<{ rows: unknown[]; total: number; shown: number }> {
    const sid = toolTokens.get(token);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
    if (!s.abort) throw httpErr("Data can only be read while Forge is answering a message.", 409);
    const ws = await workspaceRepo.get(s.workspaceId);
    if (!ws?.assistant) {
      throw httpErr(
        "This workspace is set up for building workflows only, so Forge cannot read its data from chat. A super admin can turn on assistant mode for it.",
        403,
      );
    }
    // A name that is not here is refused with the names that ARE, so Forge can correct itself rather than give up.
    const known = (await datasourceRepo.listByWorkspace(s.workspaceId)).map((d) => d.name);
    if (!known.includes(datasource)) {
      throw httpErr(
        `There is no datasource named "${datasource}" in this workspace. ${known.length ? `Use one of: ${known.join(", ")}.` : "It has no datasources."}`,
        404,
      );
    }
    const input = stepBatchSchema.parse({
      ref: `${datasource}.pi:ask`,
      datasourceRef: datasource,
      sql,
      params: [{}],
      stepId: "forge-ask",
    });
    const result = await stepExecutionService.operation(s.workspaceId, input, "live", { workspaceId: s.workspaceId });
    const first = result.results[0];
    if (!first?.ok) throw httpErr(`The read failed: ${first?.error ?? "no result"}`, 400);
    const data = first.data as unknown;
    const rows = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { rows?: unknown }).rows) ? (data as { rows: unknown[] }).rows : [data];
    void auditService
      .record({
        workspaceId: s.workspaceId,
        actor: s.requester.actor,
        operation: "access",
        entity: "datasource",
        description: `Forge read "${datasource}" from chat to answer a question (${rows.length} row(s)): ${sql.replace(/\s+/g, " ").slice(0, 300)}`,
        whereText: s.chatId ? "Chats" : "Forge",
        whereEntityType: s.chatId ? "chat" : null,
        whereEntityId: s.chatId,
        raw: { datasource, sql, rows: rows.length, chatId: s.chatId, flowId: s.flowId },
      })
      .catch((e) => console.warn(`[pi-builder] could not record Forge's data read: ${(e as Error).message}`));
    return { rows: rows.slice(0, ASK_ROWS), total: rows.length, shown: Math.min(rows.length, ASK_ROWS) };
  },

  /**
   * Personal thin: Forge talks to the person's paired edge devices (tools/edge-*.mjs → /api/forge/edge/*).
   * Scoped to the person talking. Harmless run_command is auto-approved; other run_command / write_path
   * get an in-chat Approve card (Needs you / Devices still work as backup).
   */
  async edgeListDevices(token: string): Promise<{
    devices: Array<{
      id: string;
      name: string;
      lastSeenAt: string | null;
      status: string;
      home: string | null;
      cwd: string | null;
      platform: string | null;
    }>;
  }> {
    const { workspaceId, subject } = forgeEdgeCaller(token);
    const devices = (await edgeDeviceService.list(workspaceId, subject))
      .filter((d) => d.status === "active")
      .map((d) => ({
        id: d.id,
        name: d.name,
        lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
        status: d.status,
        home: d.hostHome ?? null,
        cwd: d.hostCwd ?? null,
        platform: d.hostPlatform ?? null,
      }));
    return { devices };
  },

  async edgeEnqueue(
    token: string,
    body: { deviceId: string; kind: EdgeJobKind; payload?: Record<string, unknown> },
  ): Promise<{ job: { id: string; status: string; kind: string; needsApproval: boolean }; message: string }> {
    const { workspaceId, subject, session: s } = forgeEdgeCaller(token);
    const payload = body.payload ?? {};
    const job = await edgeDeviceService.enqueue(workspaceId, body.deviceId, subject, body.kind, payload, s.id);
    // Re-read after enqueue: getJob may auto-release allowlisted jobs that were awaiting.
    const detail = await edgeDeviceService.getJob(workspaceId, job.id, subject, false);
    const needsApproval = detail.needsApproval;
    if (needsApproval) {
      showEdgeApprovalCard(s, {
        jobId: detail.id,
        deviceId: body.deviceId,
        deviceName: detail.deviceName ?? "your computer",
        kind: body.kind,
        payload,
      });
    }
    return {
      job: { id: detail.id, status: detail.status, kind: detail.kind, needsApproval },
      message: needsApproval
        ? "Queued. An Approve card is in this chat. Once they Approve, the job runs on their computer and Foundry continues this chat with the result automatically — do NOT ask them to say okay, and do NOT poll edge-job. Keep your reply short (one line that the card needs Approve)."
        : "Queued in the background (job " + detail.id + "). Do NOT poll edge-job — finish a short reply. Foundry will continue this chat with the result when the edge agent finishes. Do not ask them to say okay.",
    };
  },

  async edgeJob(
    token: string,
    body: { jobId: string; waitMs?: number },
  ): Promise<{
    job: {
      id: string;
      status: string;
      kind: string;
      needsApproval: boolean;
      deviceName: string | null;
      result: Record<string, unknown> | null;
      error: string | null;
      timedOut?: boolean;
    };
    message: string;
  }> {
    const { workspaceId, subject, session: s } = forgeEdgeCaller(token);
    // Default 0: status peek. Long waits block the chat turn — Background owns watching.
    const waitMs = body.waitMs ?? 0;
    // Show the card before waiting so the person can Approve while we poll.
    {
      const snap = await edgeDeviceService.getJob(workspaceId, body.jobId, subject, false);
      if (snap.needsApproval) {
        showEdgeApprovalCard(s, {
          jobId: snap.id,
          deviceId: snap.deviceId ?? "",
          deviceName: snap.deviceName ?? "your computer",
          kind: snap.kind as EdgeJobKind,
          payload: (snap.payload ?? {}) as Record<string, unknown>,
        });
      }
    }
    const job =
      waitMs > 0
        ? await edgeDeviceService.waitForJob(workspaceId, body.jobId, subject, false, waitMs)
        : await edgeDeviceService.getJob(workspaceId, body.jobId, subject, false);
    settleEdgeProposalCard(s, {
      id: job.id,
      status: job.status,
      error: job.error,
      result: job.result,
    });
    let message = `Status: ${job.status}.`;
    const timedOut = "timedOut" in job && job.timedOut === true;
    if (job.needsApproval) {
      message = "Still waiting for Approve on the card in this chat. Tell them once, then poll again.";
    } else if (job.status === "succeeded") {
      message = "Done.";
    } else if (job.status === "failed") {
      const stderr = typeof job.result?.stderr === "string" ? job.result.stderr.trim() : "";
      message = `Approved but the command failed: ${job.error ?? "unknown"}${stderr ? `\n${stderr.slice(0, 2000)}` : ""}`;
    } else if (job.status === "revoked") {
      message = `Declined: ${job.error ?? "the person cancelled this job"}`;
    } else if (timedOut) {
      message = `Still ${job.status} after waiting. The edge agent may be offline — ask them to check Devices / the agent process.`;
    } else if (job.status === "approved" || job.status === "running") {
      message = "Approved; waiting for the edge agent to claim and finish. Keep polling.";
    }
    return {
      job: {
        id: job.id,
        status: job.status,
        kind: job.kind,
        needsApproval: job.needsApproval,
        deviceName: job.deviceName,
        result: job.result,
        error: job.error,
        timedOut: timedOut || undefined,
      },
      message,
    };
  },

  /**
   * Background watcher: jobs this chat started on edge (and still open, or just finished).
   * Does not require an active Forge turn.
   */
  async listBackground(
    workspaceId: string,
    sessionId: string,
    subject: string,
  ): Promise<{
    jobs: Array<{
      id: string;
      kind: string;
      status: string;
      deviceName: string | null;
      summary: string;
      error: string | null;
      createdAt: string;
      startedAt: string | null;
      finishedAt: string | null;
      open: boolean;
    }>;
  }> {
    const s = sessions.get(sessionId);
    if (!s || s.workspaceId !== workspaceId) throw httpErr("No such conversation.", 404);
    const rows = await edgeDeviceService.listSessionJobs(workspaceId, sessionId, subject);
    const openStatuses = new Set(["awaiting_approval", "approved", "running"]);
    return {
      jobs: rows.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        deviceName: j.deviceName,
        summary: edgeJobSummary(j.kind as EdgeJobKind, (j.payload ?? {}) as Record<string, unknown>, j.deviceName ?? "device"),
        error: j.error,
        createdAt: j.createdAt.toISOString(),
        startedAt: j.startedAt ? j.startedAt.toISOString() : null,
        finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
        open: openStatuses.has(j.status),
      })),
    };
  },

  async cancelBackgroundJob(workspaceId: string, sessionId: string, jobId: string, subject: string): Promise<{ job: { id: string; status: string } }> {
    const s = sessions.get(sessionId);
    if (!s || s.workspaceId !== workspaceId) throw httpErr("No such conversation.", 404);
    const existing = await edgeDeviceService.getJob(workspaceId, jobId, subject, false);
    if (existing.sessionId && existing.sessionId !== sessionId) throw httpErr("That job is not from this chat.", 404);
    const job = await edgeDeviceService.cancelJob(workspaceId, jobId, subject, false);
    return { job: { id: job.id, status: job.status } };
  },

  /**
   * Edge agent finished (or was stopped): update the Approve card (it already shows the result) and continue Forge
   * with that result. Do NOT dump stdout into the chat as a fake assistant message — that is why people saw
   * `_bg-job:…` blobs and then had to say "okay" to make Forge move again.
   */
  onEdgeJobSettled(job: { id: string; sessionId: string | null; status: string; error: string | null; result: Record<string, unknown> | null; kind: string; payload: Record<string, unknown> }): void {
    if (!job.sessionId) return;
    const s = sessions.get(job.sessionId);
    if (!s) return;
    settleEdgeProposalCard(s, { id: job.id, status: job.status, error: job.error, result: job.result });
    emit(s, { type: "background", jobId: job.id, status: job.status } as never);
    if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "revoked") return;
    queueOrContinueAfterEdge(s, job);
  },
};

/** Live Forge turn + personal product + talking subject → edge device owner. */
function forgeEdgeCaller(token: string): { workspaceId: string; subject: string; session: Session } {
  if (!PERSONAL_PRODUCT) throw httpErr("Edge devices are only available in personal Foundry.", 404);
  const sid = toolTokens.get(token);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
  if (!s.abort) throw httpErr("Edge devices can only be used while Forge is answering a message.", 409);
  const subject = talker(s)?.subject ?? null;
  if (!subject) throw httpErr("Edge devices need a signed-in person in this chat.", 403);
  return { workspaceId: s.workspaceId, subject, session: s };
}

/** One-line summary for an edge job card. */
function edgeJobSummary(kind: EdgeJobKind, payload: Record<string, unknown>, deviceName: string): string {
  if (kind === "run_command") {
    const cmd = typeof payload.command === "string" ? payload.command.trim() : "";
    return cmd ? `Run \`${cmd}\` on ${deviceName}` : `Run a command on ${deviceName}`;
  }
  if (kind === "write_path") {
    const path = typeof payload.path === "string" ? payload.path : "a file";
    return `Write to ${path} on ${deviceName}`;
  }
  const path = typeof payload.path === "string" ? payload.path : "a path";
  return `Read ${path} on ${deviceName}`;
}

function edgeJobAction(kind: EdgeJobKind): string {
  if (kind === "run_command") return "Run a command";
  if (kind === "write_path") return "Write a file";
  return "Read a file";
}

/** Open edge Approve cards, or jobs already approved and still running on the device. */
function pendingEdgeWork(s: Session): boolean {
  return [...s.proposals, ...s.messages.flatMap((m) => m.proposals ?? [])].some(
    (p) => p.kind === "edge" && (p.status === "pending" || p.status === "running"),
  );
}

/** Prompt Forge gets when an edge job settles — full result, not shown as a chat dump. */
function edgeContinueTold(job: {
  id: string;
  status: string;
  error: string | null;
  result: Record<string, unknown> | null;
  kind: string;
  payload: Record<string, unknown>;
}): string {
  const summary = edgeJobSummary(job.kind as EdgeJobKind, job.payload ?? {}, "their computer");
  const outcome = edgeJobOutcomeText(job);
  return (
    `Work on the person's computer finished (${job.status}) for: ${summary}\n\n` +
    `Result:\n${outcome}\n\n` +
    `Continue their request with this result. Do not ask them to approve again, and do not ask them to say "okay" — proceed.`
  );
}

/**
 * Continue Forge with an edge result when idle; if a turn is still running, queue for flushPendingEdgeContinues.
 */
function queueOrContinueAfterEdge(
  s: Session,
  job: {
    id: string;
    status: string;
    error: string | null;
    result: Record<string, unknown> | null;
    kind: string;
    payload: Record<string, unknown>;
  },
): void {
  if (s.edgeContinued.has(job.id)) return;
  const told = edgeContinueTold(job);
  if (s.abort || s.testing || s.compacting || s.status === "running") {
    if (!s.pendingEdgeContinues.some((p) => p.jobId === job.id)) {
      s.pendingEdgeContinues.push({ jobId: job.id, told });
    }
    return;
  }
  s.edgeContinued.add(job.id);
  void runTurn(s, told, 0, {
    text: "(work on your computer finished)",
    by: { subject: null, name: "Foundry" },
  });
}

function flushPendingEdgeContinues(s: Session): void {
  if (s.abort || s.testing || s.compacting) return;
  const next = s.pendingEdgeContinues.shift();
  if (!next) return;
  if (s.edgeContinued.has(next.jobId)) {
    flushPendingEdgeContinues(s);
    return;
  }
  s.edgeContinued.add(next.jobId);
  void runTurn(s, next.told, 0, {
    text: "(work on your computer finished)",
    by: { subject: null, name: "Foundry" },
  });
}

/**
 * Edge approval must appear WHILE Forge is still waiting (unlike connector proposals, which land on the finished reply).
 * Emit a chat message with the card immediately — do not park it only on s.proposals for end-of-turn.
 */
function showEdgeApprovalCard(
  s: Session,
  job: { jobId: string; deviceId: string; deviceName: string; kind: EdgeJobKind; payload: Record<string, unknown> },
): void {
  const open = [...s.proposals, ...s.messages.flatMap((m) => m.proposals ?? [])].some(
    (p) => p.kind === "edge" && p.edge?.jobId === job.jobId && p.status === "pending",
  );
  if (open) return;
  const card: PiProposal = {
    id: randomUUID(),
    kind: "edge",
    tool: "edge-run",
    connector: job.deviceName,
    action: edgeJobAction(job.kind),
    summary: edgeJobSummary(job.kind, job.payload, job.deviceName),
    params: job.payload,
    status: "pending",
    at: new Date().toISOString(),
    edge: { jobId: job.jobId, deviceId: job.deviceId, deviceName: job.deviceName, kind: job.kind },
  };
  const host = [...s.messages].reverse().find((m) => m.role === "assistant" && m.proposals?.some((p) => p.kind === "edge" && p.status === "pending"));
  if (host) {
    host.proposals = [...(host.proposals ?? []), card];
    emit(s, { type: "messages", messages: s.messages });
  } else {
    const msg = {
      id: randomUUID(),
      role: "assistant" as const,
      text: "This needs your approval before it runs on your computer.",
      at: card.at,
      mode: s.mode,
      proposals: [card],
    };
    s.messages.push(msg);
    emit(s, { type: "message", message: msg });
  }
  persistChat(s);
}

/** Format edge job outcome for the Approve card (success preview or failure stderr). */
function edgeJobOutcomeText(job: {
  status: string;
  error: string | null;
  result: Record<string, unknown> | null;
}): string {
  const r = job.result ?? {};
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  const exitCode = r.exitCode;
  if (job.status === "succeeded") {
    const preview = (stdout || JSON.stringify(r, null, 2)).trim().slice(0, 2000);
    return preview || "Finished successfully.";
  }
  if (job.status === "revoked") {
    return `Declined: ${job.error ?? "cancelled"}`;
  }
  const bits = [`Approved but the command failed${exitCode != null ? ` (exit ${exitCode})` : ""}: ${job.error ?? "unknown"}`];
  if (stderr.trim()) bits.push(stderr.trim().slice(0, 2000));
  else if (stdout.trim()) bits.push(stdout.trim().slice(0, 2000));
  return bits.join("\n");
}

/**
 * When an edge job settles, patch the in-chat card so it is not stuck on "Approved. Running…".
 */
function settleEdgeProposalCard(
  s: Session,
  job: {
    id: string;
    status: string;
    error: string | null;
    result: Record<string, unknown> | null;
  },
): void {
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "revoked") return;
  let found = false;
  const text = edgeJobOutcomeText(job);
  const nextStatus: PiProposal["status"] = job.status === "succeeded" ? "done" : "failed";
  for (const m of s.messages) {
    for (const p of m.proposals ?? []) {
      if (p.kind !== "edge" || p.edge?.jobId !== job.id) continue;
      if (p.status === "declined") continue;
      p.status = nextStatus;
      p.result = text;
      found = true;
    }
  }
  for (const p of s.proposals) {
    if (p.kind !== "edge" || p.edge?.jobId !== job.id || p.status === "declined") continue;
    p.status = nextStatus;
    p.result = text;
    found = true;
  }
  if (!found) return;
  emit(s, { type: "messages", messages: s.messages });
  persistChat(s);
}

/** Ask-mode surface cards still waiting for the person. */
function pendingAskSurfaces(s: Session): PiProposal[] {
  return s.messages.flatMap((m) => m.proposals ?? []).filter(isPendingAskSurface);
}

/**
 * Forge shows a structured card in the chat (`tools/show-card.mjs` → `POST /api/forge/card`).
 * Emitted immediately so the person sees it while the turn is still running.
 */
export async function showCard(token: string, raw: unknown): Promise<{ shown: true; message: string; id: string }> {
  const sid = toolTokens.get(token);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
  if (!s.abort) throw httpErr("A card can only be shown while Forge is answering a message.", 409);
  if (s.mode !== "agent") throw httpErr("Cards are for Forge Agent. In Workflow Builder, ask with questions.json.", 403);
  let surface: PiSurface;
  try {
    surface = parseSurface(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw httpErr(`That card is not valid: ${msg}`, 400);
  }
  const openAsks = pendingAskSurfaces(s).length;
  if (surface.mode === "ask" && openAsks >= 3) {
    throw httpErr("At most three open choice cards at a time. Let the person answer these first.", 409);
  }
  const card: PiProposal = {
    id: randomUUID(),
    kind: "surface",
    tool: "show-card",
    connector: surface.type === "choice" ? "Choice" : "List",
    action: surface.title,
    summary: surface.subtitle?.trim() || surface.title,
    params: {},
    status: "pending",
    at: new Date().toISOString(),
    surface,
  };
  // Always visible now (info and ask) — do not wait for end-of-turn splice.
  const host = [...s.messages].reverse().find((m) => m.role === "assistant" && (m.proposals ?? []).some((p) => p.kind === "surface" && p.status === "pending"));
  if (host) {
    host.proposals = [...(host.proposals ?? []), card];
    emit(s, { type: "messages", messages: s.messages });
  } else {
    const msg = {
      id: randomUUID(),
      role: "assistant" as const,
      text: surface.mode === "ask" ? "Pick one below when you are ready." : "",
      at: card.at,
      mode: s.mode,
      proposals: [card],
    };
    s.messages.push(msg);
    emit(s, { type: "message", message: msg });
  }
  persistChat(s);
  return {
    shown: true,
    id: card.id,
    message:
      surface.mode === "ask"
        ? "Choice card is in the chat. The person must pick before you continue; do not re-ask in prose."
        : "List card is in the chat. Keep going — do not restate every row in prose unless a short summary helps.",
  };
}


/** A connected service's name as people read it ("GitHub"), from the installed piece. */
async function pieceName(piece: string): Promise<string> {
  const p = (await connectorPieces().catch(() => [])).find((x) => x.name === piece);
  return p?.displayName ?? piece.replace("@activepieces/piece-", "");
}

/**
 * The connection a chat call goes through (connection-choice.ts). ⚠ Several possible and none chosen: a card asks the
 * person — once per service while it is open — and the call is refused, so nothing runs on a guess.
 */
async function chatAccount(s: Session, tool: Tool, service?: string): Promise<AccountOption> {
  const piece = parsePluginUrl(tool.url)!.piece;
  const name = service ?? (await pieceName(piece));
  const r = await resolveAccount(s.workspaceId, piece, name, tool, s.requester?.subject ?? null, s.accounts);
  if (r.kind === "use") return r.account;
  if (r.kind === "none") throw httpErr(r.why, 403);
  showAccountCard(s, tool, r.question, `Which ${name} should Forge use in this chat?`, "turn");
  throw httpErr(askMessage(r.question), 409);
}

/**
 * Put a "which connection" card in the chat — once per service while one is open. During a turn it joins the reply
 * (`turn`); outside one (a test or a save) it joins the latest reply now, so the person sees it where they are.
 */
function showAccountCard(s: Session, tool: Tool, q: PiAccountQuestion, summary: string, when: "turn" | "now"): void {
  const open = [...s.proposals, ...s.messages.flatMap((m) => m.proposals ?? [])].some((p) => p.kind === "account" && p.status === "pending" && p.choice?.piece === q.piece);
  if (open) return;
  const card: PiProposal = { id: randomUUID(), kind: "account", tool: tool.name, connector: q.service, action: "Choose a connection", summary, params: {}, status: "pending", at: new Date().toISOString(), choice: q };
  if (when === "turn") {
    if (s.proposals.length < MAX_PROPOSALS_PER_TURN) s.proposals.push(card);
    return;
  }
  const last = [...s.messages].reverse().find((m) => m.role === "assistant");
  if (last) last.proposals = [...(last.proposals ?? []), card];
  else s.messages.push({ id: randomUUID(), role: "assistant", text: "", at: card.at, mode: s.mode, proposals: [card] });
  emit(s, { type: "messages", messages: s.messages });
  persistChat(s);
}

/**
 * Whose account a WORKFLOW acts as in each connected service it uses (plugins 8.6): the person's choice for this chat,
 * or the only connection there is. Several and none chosen ⇒ a card, and the test or save stops — nothing is assumed.
 */
/** Does this conversation's workflow live in My space — its saved workflow's place, else its chat's (or start's) project? */
async function sessionInMySpace(s: Session): Promise<boolean> {
  if (s.flowId) {
    const flow = await flowRepo.get(s.workspaceId, s.flowId).catch(() => undefined);
    if (flow) return inMySpace(flow);
  }
  const projectId = s.chatId ? ((await piChatRepo.get(s.workspaceId, s.chatId).catch(() => null))?.projectId ?? null) : s.projectId;
  return !projectId;
}

async function workflowAccounts(
  s: Session,
  bundle: PiBundle,
  subject: string | null,
  stopped: NonNullable<Session["accountResume"]>,
  kept?: Record<string, PiRunAs>,
): Promise<Record<string, PiRunAs>> {
  const used = await piecesUsed(s.workspaceId, forgeRefsOf({ runtime: "foundry", workflow: bundle.workflow, files: {} }), subject);
  const out: Record<string, PiRunAs> = {};
  // Where it lives decides what is offered (Q3): in My space only the person's own connections.
  const ownOnly = used.size ? await sessionInMySpace(s) : false;
  for (const [piece, tool] of used) {
    // The saved workflow's own choice stands unless this chat chose for this service (sharing-boundaries phase 3).
    const keep = keptChoice(piece, s.accounts, kept);
    if (keep) {
      out[piece] = keep;
      continue;
    }
    const name = await pieceName(piece);
    const r = await resolveAccount(s.workspaceId, piece, name, tool, subject, s.accounts, { ownOnly });
    if (r.kind === "use") {
      out[piece] = { connectionId: r.account.connectionId, label: r.account.label, personal: r.account.personal, service: name };
      continue;
    }
    if (r.kind === "none") throw httpErr(r.why, 409);
    showAccountCard(s, tool, { ...r.question, purpose: "workflow" }, `Which ${name} should this workflow run as?`, "now");
    s.accountResume = stopped;
    throw httpErr(`Choose which ${name} account this workflow runs as, on the card in the chat. Nothing ran.`, 409);
  }
  return out;
}

/**
 * The person's choice of account is the go-ahead: what stopped for it carries on, so the click is never a dead end.
 * In a chat, Forge's next reply starts at once (the choice shows as their message); a stopped workflow test runs
 * again; a stopped save waits for the person to press Save again (the card says so). When something is still running,
 * nothing starts: the choice applies from its next call.
 */
function continueAfterAccount(s: Session, q: PiAccountQuestion, picked: PiAccount, person: { subject: string; email?: string | null; name?: string | null }, label: string): void {
  if (s.abort || s.testing || s.compacting) return;
  const resume = s.accountResume;
  if (q.purpose === "workflow") {
    s.accountResume = undefined;
    if (resume?.kind !== "test") return;
    setStatus(s, "running");
    inBackground(s, async () => {
      await testThenSettle(s, s.requester, { useProductionData: resume.opts?.useProductionData, auto: resume.opts?.auto });
    });
    return;
  }
  try {
    readyForTurn(s);
  } catch {
    return; // full, or busy: the choice is kept and applies from the next message
  }
  const whose = picked.personal ? `my own ${q.service}` : `the workspace's ${q.service}`;
  void runTurn(s, `The person chose which ${q.service} account to use. Carry on with what they asked, now.`, 0, {
    text: `Use ${whose} “${picked.label}”.`,
    by: { subject: person.subject, name: person.name ?? label },
  });
}

/**
 * Who Forge Agent is talking to, as verified — whose own connections and whose own actions it may use. Undefined when
 * nobody verified has sent a message yet: then only the workspace's own actions are reachable.
 */
function talker(s: Session): Identity | undefined {
  if (s.reader?.subject) return s.reader;
  return s.requester?.subject ? { subject: s.requester.subject, email: null } : undefined;
}

/** The tools a chat has beyond the workspace's: the actions its person switched on for themselves (personal-actions.ts). */
async function chatExtraTools(s: Session): Promise<Tool[]> {
  return config.plugins.enabled ? await personalTools(s.workspaceId, talker(s)?.subject ?? null).catch(() => [] as Tool[]) : [];
}

/** ⚠ A personal action runs only through its person's own connection — checked right before every chat call. */
async function ownOnly(workspaceId: string, tool: Tool, secretName: string | undefined, subject: string | null): Promise<void> {
  if (!isPersonalTool(tool)) return;
  const ok = await mayRunThrough(workspaceId, tool, secretName ?? tool.secretEnvName ?? "", subject);
  if (ok !== true) throw httpErr(`"${tool.name}" was not used: ${ok}.`, 403);
}

/**
 * `catalogue.mine.json` beside catalogue.json: the chat person's own actions as catalogue entries, rewritten every turn
 * (removed when there are none). Forge builds from it and the verifier accepts its tools; ⚠ neither grants anything —
 * a run refuses an action its person does not have on, whatever this file says.
 */
function writeMyCatalogue(workspaceId: string, sessionId: string, tools: Tool[]): void {
  const path = join(sandboxDir(workspaceId, sessionId), "catalogue.mine.json");
  try {
    if (!tools.length) {
      if (existsSync(path) || lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
      return;
    }
  } catch {
    return;
  }
  const entries = tools.map((t) => ({
    ref: t.name,
    kind: "tool",
    stepKind: "tool",
    description: t.description,
    service: parsePluginUrl(t.url)?.piece.replace("@activepieces/piece-", "") ?? null,
    method: "POST",
    personal: true,
    params: Object.entries((t.paramsSchema ?? {}) as Record<string, { type?: string; required?: boolean; description?: string }>).map(([name, p]) => ({
      name,
      type: p.type ?? "string",
      required: p.required === true,
      description: p.description ?? null,
    })),
    datasource: null,
    datasourceId: null,
    sql: null,
    readback: null,
  }));
  try {
    rmSync(path, { force: true }); // never write through a link Forge left there
    writeFileSync(path, JSON.stringify({ note: "Actions on for this person only, through their own account. Same shape as catalogue.json's entries.", entries }, null, 2) + "\n");
  } catch (e) {
    console.warn(`[pi-builder] could not write catalogue.mine.json: ${(e as Error).message}`);
  }
}

/**
 * Plugins POC — Forge reads from a connected service while it answers (`tools/use-plugin.mjs` → `POST /api/forge/plugin`).
 *
 * The same gates as `askData` (an open conversation, mid-answer, a workspace that lets Forge read real data), and the
 * call goes to the connector in CAPTURE mode — which runs a read or search and does NOT perform anything else. So a
 * change is refused by the connector, not by Forge's good behaviour: "Nothing leaves this chat" (SYSTEM.md) is
 * enforced here, and a workflow is how a change happens, after a person approves it.
 */
export async function usePlugin(token: string, toolName: string, params: Record<string, unknown>): Promise<{ result: unknown; via: string }> {
  const sid = toolTokens.get(token);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
  if (!s.abort) throw httpErr("A connected service can only be used while Forge is answering a message.", 409);
  if (!config.plugins.enabled) throw httpErr("Connected services (plugins) are not turned on in this deployment.", 404);
  const ws = await workspaceRepo.get(s.workspaceId);
  if (!ws?.assistant) {
    throw httpErr("This workspace is set up for building workflows only, so Forge cannot read from connected services in chat.", 403);
  }
  const wsTools = (await toolRepo.listByWorkspace(s.workspaceId)).filter((t) => t.isActive !== false && isPluginTool(t));
  // Actions on for this chat only (Forge Agent), and the person's own: the same call path. A workspace tool's name wins.
  const plugins = [...wsTools, ...(await chatExtraTools(s)).filter((g) => !wsTools.some((t) => t.name === g.name))];
  const tool = plugins.find((t) => t.name === toolName);
  if (!tool) {
    throw httpErr(
      `There is no connected-service tool named "${toolName}". ${plugins.length ? `Use one of: ${plugins.map((t) => t.name).join(", ")}.` : "This workspace has none."}`,
      404,
    );
  }
  // Which connection: the person's choice for this chat, or the only one; several and none chosen ⇒ ask (8.5).
  const account = await chatAccount(s, tool);
  await ownOnly(s.workspaceId, tool, account.secretName, talker(s)?.subject ?? null);
  const { results } = await invokePluginTool(s.workspaceId, tool, [params], undefined, { actingSubject: s.requester?.subject ?? null, secretName: account.secretName }); // no run ⇒ capture: reads run, changes do not
  const r = results[0]!;
  if (!r.ok) throw httpErr(`The call failed: ${r.error ?? "no result"}`, 400);
  if (r.captured) {
    const canPropose = s.mode === "agent" && (await changesAllowed(s.workspaceId)).ok;
    throw httpErr(
      `"${toolName}" changes something outside Foundry, so it was not done. ` +
        (canPropose
          ? `Propose it instead: node tools/propose-change.mjs ${toolName} '<the same params>' "<one line of what it does>" — the person confirms it on a card.`
          : "This workspace lets Forge read connected services, not change them. A super admin can allow confirmed changes in the workspace's settings; a workflow can also do it after approval."),
      403,
    );
  }
  void auditService
    .record({
      workspaceId: s.workspaceId,
      actor: s.requester.actor,
      operation: "access",
      entity: "tool",
      description: `Forge read from "${toolName}" (a connected service) to answer in chat: ${JSON.stringify(params).slice(0, 300)}`,
      whereText: s.chatId ? "Chats" : "Forge",
      whereEntityType: s.chatId ? "chat" : null,
      whereEntityId: s.chatId,
      raw: { tool: toolName, params, chatId: s.chatId, flowId: s.flowId },
    })
    .catch((e) => console.warn(`[pi-builder] could not record Forge's plugin read: ${(e as Error).message}`));
  return { result: r.data, via: accountLine(account, await pieceName(parsePluginUrl(tool.url)!.piece)) };
}

/**
 * Forge Agent proposes a change to a connected service (`tools/propose-change.mjs` → `POST /api/forge/propose`). ⚠ It
 * is CHECKED and STORED, never performed: the person sees it as a card on Forge's reply and only their click runs it
 * (`decideProposal`). See agent-changes.ts for why a question card could not be the confirmation.
 */
export async function proposeChange(token: string, toolName: string, params: Record<string, unknown> | Array<Record<string, unknown>>, summary: string): Promise<{ proposed: true; message: string }> {
  const sid = toolTokens.get(token);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
  if (!s.abort) throw httpErr("A change can only be proposed while Forge is answering a message.", 409);
  if (s.mode !== "agent") throw httpErr("Changes are proposed in Forge Agent only. In Workflow Builder, build the change into the workflow.", 403);
  const allowed = await changesAllowed(s.workspaceId);
  if (!allowed.ok) throw httpErr(allowed.why, 403);
  const line = summary.replace(/\s+/g, " ").trim();
  if (line.length < 5) throw httpErr("Say in one line what the change does, for the person to read on the card.", 400);
  if (s.proposals.length >= MAX_PROPOSALS_PER_TURN) {
    throw httpErr(`At most ${MAX_PROPOSALS_PER_TURN} changes can be proposed in one reply. Let the person decide these first.`, 409);
  }
  const { tool, action, connector } = await proposable(s.workspaceId, toolName, await chatExtraTools(s));
  const account = await chatAccount(s, tool, connector);
  await ownOnly(s.workspaceId, tool, account.secretName, talker(s)?.subject ?? null);
  await checkValues(s.workspaceId, tool, params, s.requester?.subject ?? null, account.secretName);
  const p: PiProposal = {
    id: randomUUID(),
    tool: tool.name,
    connector,
    action: action.displayName,
    summary: line.slice(0, 300),
    params,
    status: "pending",
    at: new Date().toISOString(),
    via: account.personal ? "personal" : "workspace",
    account: { connectionId: account.connectionId, label: account.label, personal: account.personal, identity: account.identity },
  };
  s.proposals.push(p);
  return {
    proposed: true,
    message:
      "Proposed, NOT done. The person sees it as a card under your reply with Do it and Cancel. Say in your reply what " +
      "you proposed and that nothing changes until they click Do it. Do not propose it again, and do not claim it is done.",
  };
}

/** The open conversation behind a Forge tool key, in Forge Agent, while it is answering — or the refusal. */
function agentTurnOf(token: string, doing: string): Session {
  const sid = toolTokens.get(token);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) throw httpErr("This key does not belong to an open conversation.", 401);
  if (!s.abort) throw httpErr(`${doing} only while Forge is answering a message.`, 409);
  if (!config.plugins.enabled) throw httpErr("Connected services (plugins) are not turned on in this deployment.", 404);
  if (s.mode !== "agent") throw httpErr("This is for Forge Agent. In Workflow Builder, build it into the workflow.", 403);
  return s;
}

/** What Forge lists (`tools/connector-actions.mjs`): every action of the services this workspace is connected to. */
export async function listActions(token: string, service?: string) {
  const s = agentTurnOf(token, "Actions can be listed");
  const ws = await workspaceRepo.get(s.workspaceId);
  if (!ws?.assistant) throw httpErr("This workspace does not offer Forge Agent.", 403);
  return { services: await actionsFor(s.workspaceId, talker(s), service) };
}

/**
 * Forge proposes switching an action ON or OFF (`tools/propose-setting.mjs`). Stored as a card, never applied: the
 * person reads what it allows, through whose connection, and where, and picks "this chat" or "the workspace" by the
 * button they press (`decideProposal`). Each place says up front whether THIS person may choose it.
 */
export async function proposeSetting(token: string, service: string, action: string, on: boolean, reason: string): Promise<{ proposed: true; message: string }> {
  const s = agentTurnOf(token, "A setting change can be proposed");
  const ws = await workspaceRepo.get(s.workspaceId);
  if (!ws?.assistant) throw httpErr("This workspace does not offer Forge Agent.", 403);
  const line = reason.replace(/\s+/g, " ").trim();
  if (line.length < 5) throw httpErr("Say in one line why it is needed, for the person to read on the card.", 400);
  if (s.proposals.length >= MAX_PROPOSALS_PER_TURN) throw httpErr(`At most ${MAX_PROPOSALS_PER_TURN} changes can be proposed in one reply.`, 409);
  const { piece, action: a } = await findAction(service, action);
  const never = neverFromChat(a);
  if (on && never) throw httpErr(`${piece.displayName} · ${a.displayName} cannot be switched on: ${never}.`, 403);
  const tool = (await toolRepo.listByWorkspace(s.workspaceId)).find((t) => t.isActive !== false && parsePluginUrl(t.url)?.piece === piece.name && parsePluginUrl(t.url)?.action === a.name);
  const identity = talker(s);
  const mineOn = (await chatExtraTools(s)).some((t) => t.name === pluginToolName(piece.name, a.name));
  const current: PiSettingChange["current"] = tool ? "workspace" : mineOn ? "me" : "off";
  if (on && current !== "off") throw httpErr(`${a.displayName} is already on ${current === "me" ? "for this person" : "for the workspace"}; use it.`, 409);
  if (!on && current === "off") throw httpErr(`${a.displayName} is not on; there is nothing to switch off.`, 409);
  const personal = identity?.subject ? ((await ownConnections(s.workspaceId, piece.name, identity.subject))[0] ?? null) : null;
  const conn = personal ?? (await workspaceConnection(s.workspaceId, piece.name));
  const scopes = {
    me: on || current === "me" ? await mayDecide(s.workspaceId, identity, piece.name, "me") : "It is not on for you.",
    workspace: on || current === "workspace" ? await mayDecide(s.workspaceId, identity, piece.name, "workspace") : "It is not on for the workspace.",
  };
  const setting: PiSettingChange = {
    piece: piece.name,
    action: a.name,
    service: piece.displayName,
    title: a.displayName,
    on,
    describes: a.description,
    effect: a.writes ? "changes" : "reads",
    current,
    connection: conn ? `${conn.label}${personal ? " (your own connection)" : " (the workspace's connection)"}` : null,
    identity: conn?.lastTestOk ? (conn.lastTestMessage ?? null) : null,
    scopes,
    reason: line.slice(0, 300),
  };
  s.proposals.push({
    id: randomUUID(),
    kind: "setting",
    tool: pluginToolName(piece.name, a.name),
    connector: piece.displayName,
    action: a.displayName,
    summary: `${on ? "Switch on" : "Switch off"} ${piece.displayName} · ${a.displayName}`,
    params: {},
    setting,
    status: "pending",
    at: new Date().toISOString(),
  });
  return {
    proposed: true,
    message:
      "Proposed, NOT done. The person sees a card with what it allows and chooses for themselves or the whole workspace. Say " +
      "in your reply what you asked to switch on and why, and that nothing changes until they choose. Do not use the " +
      "action until the next message tells you it is on.",
  };
}

/** Apply a confirmed setting change where the person chose; the line Forge is told comes from `outcomeLine`. */
async function applySetting(s: Session, p: PiProposal, scope: GrantScope, person: { subject: string; email?: string | null; label: string; identity?: Identity }): Promise<string> {
  const st = p.setting!;
  const may = await mayDecide(s.workspaceId, person.identity ?? { subject: person.subject, email: person.email ?? null }, st.piece, scope);
  if (may !== true) throw httpErr(may, 403);
  if (scope === "workspace") {
    await applyWorkspace(s.workspaceId, st.piece, st.action, st.on, { subject: person.subject, email: person.email ?? null });
    return st.on ? `${st.title} is on for the whole workspace now: automations and every chat can use it.` : `${st.title} is off for the whole workspace now.`;
  }
  // For me: the Apps page's own "For me" call — the same record, the same checks, the same audit entry.
  await applyMine(s.workspaceId, st.piece, st.action, st.on, { subject: person.subject, email: person.email ?? null });
  return st.on
    ? `${st.title} is on for ${person.label} now, through their own connection: every chat of theirs and the workflows they own can use it. Nobody else gains it.`
    : `${st.title} is off for ${person.label}.`;
}

/**
 * "Change" on the chat's accounts: forget which connection this chat uses for a service, so the next call asks again.
 * Only someone who may write in the chat reaches it (the route's content guard); nothing else changes.
 */
function clearAccount(workspaceId: string, sessionId: string, piece: string): PiSessionPublic {
  const s = getOrThrow(workspaceId, sessionId);
  if (!s.accounts[piece]) throw httpErr("This chat has no connection chosen for that service.", 404);
  const { [piece]: _gone, ...rest } = s.accounts;
  s.accounts = rest;
  emit(s, { type: "accounts", accounts: s.accounts });
  persistChat(s);
  return publicOf(s);
}

/**
 * The person's answer to a proposed change. ⚠ Only the person whose message Forge was answering may decide it, and
 * only once: the stored call runs exactly as shown, through their own connection when they have one.
 */

function actSurface(
  s: Session,
  p: PiProposal,
  update: (patch: Partial<PiProposal>) => void,
  label: string,
  person: { subject: string },
  surfaceAct?: { actionId?: string; selected?: string[] },
): PiProposal {
  const surf = p.surface!;
  if (surf.mode === "ask" || surf.type === "choice") {
    const selected = surfaceAct?.selected ?? [];
    if (!selected.length) throw httpErr("Pick at least one option on the card.", 400);
    const ids = new Set(surf.items.map((i) => i.id));
    if (selected.some((id) => !ids.has(id))) throw httpErr("That option is not on the card.", 400);
    if (!surf.multi && selected.length > 1) throw httpErr("Pick only one option.", 400);
    const titles = selected.map((id) => surf.items.find((i) => i.id === id)!.title);
    update({
      status: "done",
      decidedBy: label,
      decidedAt: new Date().toISOString(),
      surface: { ...surf, selected },
      result: surf.multi ? `Chose: ${titles.join(", ")}` : `Chose: ${titles[0]}`,
    });
    s.proposalOutcomes.push(outcomeLine(p));
    maybeResumeAfterAskSurface(s, label);
    return p;
  }
  // Info list action — agent-defined id/label/payload; resume Forge with that context (no hardcoded handlers).
  const actionId = surfaceAct?.actionId;
  if (!actionId) throw httpErr("Choose an action on the card.", 400);
  const action = (surf.actions ?? []).find((a) => a.id === actionId);
  if (!action) throw httpErr("That action is not on the card.", 400);
  const item = action.itemId ? surf.items.find((i) => i.id === action.itemId) : null;
  const actedPayload = action.payload ?? null;
  update({
    status: "done",
    decidedBy: label,
    decidedAt: new Date().toISOString(),
    surface: { ...surf, acted: actionId, actedPayload },
    result: item ? `${action.label} · ${item.title}` : action.label,
  });
  s.proposalOutcomes.push(outcomeLine(p));
  void person;
  maybeResumeAfterSurfaceAct(s, label, "action");
  return p;
}

/**
 * Continue Forge after a surface card act. Ask cards wait until all are settled; info actions resume when idle
 * so Forge gets the action id + payload and continues without a hardcoded handler.
 */
function maybeResumeAfterAskSurface(s: Session, label: string): void {
  maybeResumeAfterSurfaceAct(s, label, "ask");
}

function maybeResumeAfterSurfaceAct(s: Session, label: string, kind: "ask" | "action"): void {
  if (pendingAskSurfaces(s).length > 0) return;
  if (s.abort) return;
  if (kind === "ask" && s.status !== "awaiting_answers") return;
  if (kind === "action" && (s.status === "running" || s.testing || s.compacting)) return;
  const outcomes = s.proposalOutcomes.splice(0);
  const told =
    outcomes.length > 0
      ? outcomes.join("\n") + "\nContinue with that — do not re-ask what they already chose on the card."
      : kind === "ask"
        ? "The person answered the choice card(s). Continue."
        : "The person pressed an action on a card. Continue with that context.";
  const shown = kind === "ask" ? "(chose on a card)" : "(card action)";
  void runTurn(s, told, 0, { text: shown, by: { subject: null, name: label } });
}

async function decideProposal(
  workspaceId: string,
  sessionId: string,
  proposalId: string,
  decision: "run" | "decline",
  person: { subject: string; email?: string | null; name?: string | null; identity?: Identity },
  scope?: GrantScope,
  /** For an `account` card: the connection the person picked. */
  choice?: string,
  /** For a `surface` card: info action id, or ask selected item ids. */
  surfaceAct?: { actionId?: string; selected?: string[] },
  /** Edge Approve card: remember allow/deny for later jobs. */
  always?: EdgeAlways | null,
): Promise<PiProposal> {
  const s = getOrThrow(workspaceId, sessionId);
  const at = s.messages.findIndex((m) => m.proposals?.some((p) => p.id === proposalId));
  if (at < 0) throw httpErr("There is no such proposed change in this chat.", 404);
  const asker = s.messages.slice(0, at).reverse().find((m) => m.role === "user" && m.by)?.by;
  if (!asker?.subject || asker.subject !== person.subject) {
    throw httpErr("Only the person Forge proposed this change to can confirm or cancel it.", 403);
  }
  const p = s.messages[at]!.proposals!.find((x) => x.id === proposalId)!;
  if (p.status !== "pending") throw httpErr(`This change was already ${p.status === "running" ? "started" : p.status}.`, 409);
  const label = person.email || person.name || person.subject;
  const update = (patch: Partial<PiProposal>) => {
    Object.assign(p, patch);
    emit(s, { type: "messages", messages: s.messages });
    persistChat(s);
  };
  if (decision === "decline") {
    if (p.kind === "edge" && p.edge?.jobId) {
      if (always === "deny") {
        await applyEdgeAlways(
          workspaceId,
          person.subject,
          person.subject,
          "deny",
          p.edge.kind as EdgeJobKind,
          (p.params ?? {}) as Record<string, unknown>,
        );
      }
      await edgeDeviceService.rejectJob(workspaceId, p.edge.jobId, person.subject, false).catch((e) => {
        // Already approved/revoked elsewhere — still mark the card declined.
        if ((e as { statusCode?: number }).statusCode !== 409) throw e;
      });
    }
    update({ status: "declined", decidedBy: label, decidedAt: new Date().toISOString() });
    s.proposalOutcomes.push(outcomeLine(p));
    if (p.kind === "surface" && p.surface?.mode === "ask") maybeResumeAfterAskSurface(s, label);
    else if (p.kind === "edge") {
      // Same as settle: do not leave them saying "okay" after they declined.
      const told = `The person declined the edge job (${p.summary}). Acknowledge briefly; do not re-propose the same command unless they ask.`;
      if (!s.abort && !s.testing && !s.compacting) {
        void runTurn(s, told, 0, { text: "(declined on a card)", by: { subject: null, name: label } });
      }
    }
    return p;
  }
  if (p.kind === "surface" && p.surface) {
    return actSurface(s, p, update, label, person, surfaceAct);
  }
  if (p.kind === "edge" && p.edge) {
    if (always === "command" || always === "path_read") {
      await applyEdgeAlways(
        workspaceId,
        person.subject,
        person.subject,
        always,
        p.edge.kind as EdgeJobKind,
        (p.params ?? {}) as Record<string, unknown>,
      );
    }
    update({ status: "running", decidedBy: label, decidedAt: new Date().toISOString() });
    try {
      await edgeDeviceService.approveJob(workspaceId, p.edge.jobId, person.subject, false);
      update({
        status: "done",
        result: `Approved. Running on ${p.edge.deviceName} — Forge will pick up the result.`,
      });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 409) {
        // Approved from Needs you / Devices while the card was still open.
        update({
          status: "done",
          result: `Already approved. Running on ${p.edge.deviceName} — Forge will pick up the result.`,
        });
      } else {
        update({ status: "failed", result: (e as Error).message });
      }
    }
    s.proposalOutcomes.push(outcomeLine(p));
    return p;
  }
  if (p.kind === "account" && p.choice) {
    const q = p.choice;
    const picked = q.options.find((o) => o.connectionId === choice);
    if (!picked) throw httpErr(`Choose one of the ${q.service} connections on the card.`, 400);
    // ⚠ Re-read at the click: a personal connection only ever for its owner, and it must still exist.
    const conn = await pluginRepo.getConnection(workspaceId, picked.connectionId);
    if (!conn || conn.piece !== q.piece || (conn.ownerSubject && conn.ownerSubject !== person.subject)) {
      throw httpErr(`“${picked.label}” is no longer a ${q.service} connection you can use. Ask Forge again.`, 409);
    }
    s.accounts = { ...s.accounts, [q.piece]: { ...picked, service: q.service, chosenBy: label, at: new Date().toISOString() } };
    const resume = q.purpose === "workflow" ? s.accountResume : undefined;
    const then = resume?.kind === "save" ? " Press Save again." : "";
    update({ status: "done", decidedBy: label, decidedAt: new Date().toISOString(), choice: { ...q, chosen: picked.connectionId }, result: `${q.service} in this chat goes through ${accountLine(picked, q.service)}.${then}` });
    emit(s, { type: "accounts", accounts: s.accounts });
    s.proposalOutcomes.push(outcomeLine(p));
    continueAfterAccount(s, q, picked, person, label);
    return p;
  }
  if (p.kind === "setting") {
    if (!scope) throw httpErr("Choose where: for you, or the whole workspace.", 400);
    const may = await mayDecide(workspaceId, person.identity ?? { subject: person.subject, email: person.email ?? null }, p.setting!.piece, scope);
    if (may !== true) throw httpErr(may, 403);
    update({ status: "running", decidedBy: label, decidedAt: new Date().toISOString(), scope });
    try {
      update({ status: "done", result: await applySetting(s, p, scope, { subject: person.subject, email: person.email, label, identity: person.identity }) });
    } catch (e) {
      update({ status: "failed", result: (e as Error).message });
    }
    s.proposalOutcomes.push(outcomeLine(p));
    return p;
  }
  update({ status: "running", decidedBy: label, decidedAt: new Date().toISOString() });
  try {
    const chatTools = await chatExtraTools(s);
    const { tool } = await proposable(workspaceId, p.tool, chatTools);
    // ⚠ The connection the card named, re-checked at the click: still one this person may use for this action.
    const options = await accountOptions(workspaceId, parsePluginUrl(tool.url)!.piece, tool, person.subject);
    const use = p.account ? options.find((o) => o.connectionId === p.account!.connectionId) : options.length === 1 ? options[0] : undefined;
    if (!use) throw new Error(p.account ? `“${p.account.label}” can no longer be used for this. Ask Forge to propose it again.` : "Which connection to use is no longer clear. Ask Forge to propose it again.");
    await ownOnly(workspaceId, tool, use.secretName, person.subject);
    const out = await performConfirmed(workspaceId, p, { subject: person.subject, label }, { chatId: s.chatId }, chatTools, { secretName: use.secretName, personal: use.personal, label: use.label });
    update(out);
  } catch (e) {
    // A rule that no longer holds (the setting was turned off, the action switched off): nothing was done.
    update({ status: "failed", result: (e as Error).message });
  }
  s.proposalOutcomes.push(outcomeLine(p));
  return p;
}

/**
 * Once, at start: files attached to workflow chats under the OLD layout (`_attachments/flow-<id>/` on disk) move
 * into each workflow's saved chat, then the folder goes. A folder whose workflow is gone is removed; one that cannot
 * be moved (the database said no) is left and logged, to try again on the next start.
 */
export async function importLegacyAttachments(root = SANDBOXES_ROOT): Promise<{ moved: number; left: number }> {
  let moved = 0;
  let left = 0;
  const folders = legacyAttachmentFolders(root);
  const done = new Map<string, boolean>();
  for (const f of folders) {
    let ok = true;
    try {
      const flow = await piFlowService.load(f.workspaceId, f.flowId).catch(() => null);
      if (flow) {
        const chatId =
          (await piChatRepo.latestForFlow(f.workspaceId, f.flowId))?.id ??
          (await piChatRepo.create({ workspaceId: f.workspaceId, flowId: f.flowId, title: chatTitle("", [], flow.flow.name ?? ""), goal: flow.flow.description ?? "", createdBy: null }));
        for (const name of f.files) {
          const body = readFileSync(join(f.dir, name));
          if (!body.length || body.length > 50 * 1024 * 1024) continue;
          const type = ATTACHMENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
          await piChatRepo.putFile(chatId, f.workspaceId, { name, contentType: type, body });
          moved += 1;
        }
      }
    } catch (e) {
      ok = false;
      left += 1;
      console.warn(`[pi-builder] could not move the chat files of flow ${f.flowId}: ${(e as Error).message}`);
    }
    done.set(f.workspaceId, (done.get(f.workspaceId) ?? true) && ok);
  }
  for (const [ws, ok] of done) if (ok) removeLegacyAttachmentRoot(root, ws);
  return { moved, left };
}

/** Tests only: the open conversations and their tool keys, to set up a session without a live Forge. */
export const __sessionsForTests = { sessions: sessions as Map<string, unknown>, toolTokens };
