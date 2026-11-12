"use client";

/**
 * Pi builder on the REAL Foundry chat workbench chrome (ChatWorkbench + ChatPanel):
 * Drafting head · Said/Asked/Thinking bubbles · Send composer · FlowCanvas Start/End · StepPanel.
 * Pi is the agent backend; save / test / run go through Foundry flows.
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useResolvedWorkspace } from "@/lib/workspace";
import { getFlowExecution, getProject } from "@/lib/api";
import type { FlowExecutionDetail } from "@/lib/types";
import { LiveRunPanel } from "@/components/flow/LiveRunPanel";
import { PromptJumpRail } from "./PromptJumpRail";
import {
  answerPiQuestions,
  decidePiTest,
  createPiSession,
  getPiSession,
  openPiEventStream,
  piChatFileUrl,
  savePiVersion,
  schedulePiSession,
  retryPiTurn,
  sendPiMessage,
  steerPiMessage,
  stopPiSession,
  compactPiSession,
  type EdgeAlways,
  type PiContext,
  testRunPiSession,
  type PiActivity,
  type PiChatMessage,
  type PiEvent,
  type PiQuestionsFile,
  type PiTestWaiting,
  type PiAnswered,
  type PiSession,
  type PiSessionStatus,
  type PiTurnError,
  type PiWorkflow,
  type ChatMode,
  setPiMode,
  setPiThinking,
  errorText,
  removePiChatFile,
  storageLevel,
  type PiStorage,
} from "@/lib/pi-builder";
import { ModeSwitch } from "./ModeSwitch";
import { ModelThinkingPill, type PillMenu } from "./ModelThinkingPill";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { prettyModelName } from "@/lib/model-names";
import { SLASH_COMMANDS, bestMatch, commandsFor, exactCommand, parseSlash, type SlashCommand } from "@/lib/composer-commands";
import { THINKING_LABEL, THINKING_LEVELS } from "@/lib/thinking-levels";
import { Confirm } from "@/components/ui/Confirm";
import { usePermissions } from "@/lib/permissions";
import { ThinkingBlock, WorkingLine } from "./ThinkingBlock";
import type { ThinkingLevel as ThinkingLevelValue } from "@/lib/thinking-levels";
import { CopyButton } from "./CopyButton";
import { addProjectMemory, pickMemoryCandidatesLocal } from "@/lib/project-memories";
import { useToast } from "@/lib/toast";
import {
  Workbench,
  WorkbenchPane,
  WorkbenchBody,
  WorkbenchRail,
} from "@/components/layout/Workbench";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Key, PanelRight, Paperclip, Send, Workflow } from "@/components/ui/icons";
import { AttachmentTray, DropOverlay, FileCards, SentAttachments, useChatAttachments } from "./ChatAttachments";
import { ReferenceChips, ReferencePicker, useWorkflowReferences } from "./WorkflowReferences";
import { mentionAt, setPiModel, withoutMention } from "@/lib/pi-builder";
import { ATTACH_ACCEPT, clearPiAccount, decidePiEmail, decidePiHttp, decidePiProposal, type GrantScope, type PiAccountChoice, type PiAttachment, type PiProposal } from "@/lib/pi-builder";
import { ChatConnections } from "./ChatConnections";
import { ProposalCard } from "./ProposalCard";
import { PastedSecretBanner, SecretsDialog } from "./ChatSecrets";
import { commonEdgeFolder, edgeFolderHint } from "@/lib/edge-folder-hint";
import { Button } from "@/components/ui/Button";
import { useAutoGrow } from "@/lib/use-auto-grow";
import { FadingText, useSmoothText, useStreamedText } from "./StreamedText";
import { playReceive, playSend } from "@/lib/chat-sounds";
import { usePageHeader } from "@/lib/page-header";
import { SCHEDULE_PRESETS } from "@/lib/schedule-presets";
import { AnsweredCard, QuestionCard } from "./QuestionCard";
import { ChatResizer, useChatWidth } from "./ChatResizer";
import { Markdown } from "./Markdown";
import { ActivityStack, activityStatusNote } from "./ActivityAccordion";
import { piInputDecls } from "./PiDagCanvas";
import { PiFlowCanvas } from "./PiFlowCanvas";
import { ContextMeter } from "./ContextMeter";
import { CHAT_FILE, PiSidePane, type ChatFile, type PaneView } from "./PiSidePane";
import { ChatToolsPane, TOOLS_DEFAULT_W, type ToolsTab } from "./ChatToolsPane";
import { BackgroundChip, BackgroundPanel, BackgroundToggle, useChatBackground } from "./ChatBackground";
import { TestWorkbenchPanel } from "@/components/flow/TestWorkbenchPanel";
import { storeRailCollapsed } from "@/lib/rail-preference";



/**
 * `flowId` opens a SAVED Pi flow (pi-runtime P3): the session is rebuilt from its draft revision on the server — that
 * is /flows/<id>/builder, the way in from Workflows. Without it this is a CHAT (2026-10-30): a new one at /chats/new,
 * isolated by a per-tab draft key, and once its first message saves it, /chats/<id> — whatever mode it is in and
 * whether or not it has built a workflow. `chatId` reopens a saved chat; `title` is its stored name; `mode` is the
 * mode a NEW chat starts in (the Workflows page's "New workflow" asks for Workflow Builder), else the person's default.
 */
type WorkbenchProps = {
  initialDraft?: string | null;
  flowId?: string | null;
  chatId?: string | null;
  projectId?: string | null;
  title?: string | null;
  mode?: ChatMode | null;
};

type QueuedMessage = { id: string; text: string; attachments: string[]; error?: string };

/**
 * The builder starts only once the workspace's REAL id is known: every call below sends it, and the context holds a
 * placeholder until it resolves — a placeholder that must never reach the server (useResolvedWorkspace).
 */
export function PiBuilderWorkbench(props: WorkbenchProps) {
  const workspaceId = useResolvedWorkspace();
  if (!workspaceId) return <div className="flex h-full items-center justify-center text-sm text-muted">Starting…</div>;
  return <Workbench_ {...props} workspaceId={workspaceId} />;
}

function Workbench_({
  initialDraft,
  flowId: openFlowId,
  chatId: openChatId,
  projectId: startInProject,
  title: storedTitle,
  mode: startMode,
  workspaceId,
}: WorkbenchProps & { workspaceId: string }) {
  const [session, setSession] = useState<PiSession | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [status, setStatus] = useState<PiSessionStatus>("idle");
  const [messages, setMessages] = useState<PiChatMessage[]>([]);
  const [liveActivities, setLiveActivities] = useState<PiActivity[]>([]);
  const [draftDelta, setDraftDelta] = useState("");
  const [draftThinking, setDraftThinking] = useState("");
  const [workflow, setWorkflow] = useState<PiWorkflow>({ steps: [] });
  const [stepFiles, setStepFiles] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<PiQuestionsFile>({
    status: "idle",
    questions: [],
  });
  // The right pane: a step (by tab) or the Files view; null = closed. The canvas's selection is the step it shows.
  const [pane, setPane] = useState<PaneView>(null);
  const selectedStep = pane?.kind === "step" ? pane.id : null;
  /** The files when the latest request began — the Files view marks what changed since. */
  const [turnBase, setTurnBase] = useState<Record<string, string> | null>(null);
  const wasRunning = useRef(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Messages typed while Forge works wait here, one goes per finished turn (2026-11-03). State only, nothing stored.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [queueHeld, setQueueHeld] = useState(false);
  const queueSending = useRef<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const perms = usePermissions();
  // (2026-11-03) Only hides the button; the test-run route checks the admin role itself.
  const canTestRealData = perms.data?.superAdmin === true || perms.data?.memberRole === "admin";
  // The banner says ONE sentence; a test's raw result (written for Forge) is behind "Details" (2026-10-13).
  const [bannerState, setBannerState] = useState<{ text: string; detail?: string; needsRealData?: boolean } | null>(null);
  const banner = bannerState?.text ?? null;
  const setBanner = useCallback(
    (text: string | null, detail?: string, opts?: { needsRealData?: boolean }) =>
      setBannerState(text ? { text, ...(detail && detail !== text ? { detail } : {}), ...(opts?.needsRealData ? { needsRealData: true } : {}) } : null),
    [],
  );
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  /** The saved chat this conversation is (set by the person's first message). */
  const [chatId, setChatId] = useState<string | null>(null);
  const [context, setContext] = useState<PiContext | null>(null);
  const [compacting, setCompacting] = useState(false);
  /** Project this chat lives in — Remember / compact promo only when set and memory is on. */
  const [projectId, setProjectId] = useState<string | null>(startInProject ?? null);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  /** After Compact: heuristic ≤3 candidates (no LLM) — accept into project memory. */
  const [memoryPromo, setMemoryPromo] = useState<string[] | null>(null);
  const [memoryPromoBusy, setMemoryPromoBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!projectId) {
      setMemoryEnabled(true);
      return;
    }
    void getProject(projectId)
      .then((p) => setMemoryEnabled(p.memoryEnabled !== false))
      .catch(() => setMemoryEnabled(true));
  }, [projectId]);
  /** Workflow Builder or Forge Agent, and whether this workspace offers Forge Agent (ModeSwitch). */
  const [mode, setMode] = useState<ChatMode>("workflow");
  const [thinking, setThinking] = useState<ThinkingLevelValue>("balanced");
  const [agentAllowed, setAgentAllowed] = useState(false);
  /** Which connection this chat uses per connected service, chosen by the person on a card (plugins 8.5). */
  const [accounts, setAccounts] = useState<Record<string, PiAccountChoice>>({});
  /** How full the conversation's folder is (StorageNotice, the Files pane). */
  const [storage, setStorage] = useState<PiStorage | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string; runId: string | null; waiting?: PiTestWaiting | null; needsRealData?: boolean } | null>(null);
  /** The last test run's own record — the same view the run page reads, so the builder shows no second account. */
  const [lastRun, setLastRun] = useState<FlowExecutionDetail | null>(null);
  /** The test drawer: asks for each declared input BEFORE the run, then shows the run in place. */
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  /** The run-state summary on the canvas toolbar, expanded to its details on click. */
  const [stateOpen, setStateOpen] = useState(false);
  /**
   * The full-bleed workbench layout (`body.wb` — height = viewport minus the top bar). Set HERE, by the component that
   * needs it, the way `BuilderComposer` does: it was set only by /flows/new, so on /flows/:id/builder the workbench
   * had no height and the page rendered blank (2026-10-10). Removed on unmount, or every later page loses its padding.
   */
  useEffect(() => {
    document.body.classList.add("wb");
    storeRailCollapsed(true);
    return () => document.body.classList.remove("wb");
  }, []);
  const [chatOpen, setChatOpen] = useState(true);
  // The canvas can be hidden like the chat, leaving the conversation the whole width. Never both: hiding one while the
  // other is hidden brings the other back.
  const [canvasOpen, setCanvasOpen] = useState(true);
  /** Agent tools drawer (Files | Canvas) — chat stays full width; no always-on rail. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsTab, setToolsTab] = useState<ToolsTab>("files");
  const [toolsWidth, setToolsWidth] = useState(TOOLS_DEFAULT_W);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const bg = useChatBackground(workspaceId, session?.id ?? null);
  /** Agent → Files. Builder keeps its own canvas column, so tools open on Files unless that column is folded. */
  const nativeToolsTab = (m: ChatMode, canvasIsOpen: boolean): ToolsTab =>
    m === "agent" || canvasIsOpen ? "files" : "canvas";
  // Forge Agent works in the chat, so the canvas column is gone there; Workflow Builder opens it again.
  // Only when the mode changes, so a person who opens tools in Forge Agent keeps them open across turns.
  useEffect(() => {
    if (mode === "agent") {
      setPane(null);
      setChatOpen(true);
      setCanvasOpen(false);
      setToolsOpen(false);
      setToolsExpanded(false);
      setToolsTab("files");
    } else {
      setCanvasOpen(true);
      setToolsOpen(false);
      setToolsExpanded(false);
      setToolsTab("files");
    }
  }, [mode]);
  // The chat column's width, dragged by its right edge (ChatResizer); null is the default 400px.
  const [chatWidth, setChatWidth] = useChatWidth();
  const hideCanvas = () => {
    setPane(null);
    setChatOpen(true);
    setCanvasOpen(false);
  };
  /** The AI service failed and Forge is retrying — said on the working line until it recovers or gives up. */
  const [retrying, setRetrying] = useState<{ attempt: number; maxAttempts?: number; title?: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const bindScroller = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    setScrollerEl(el);
  }, []);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Workflow references: `@` opens the picker; picks become chips above the box (WorkflowReferences.tsx).
  const [refsTick, setRefsTick] = useState(0);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const pickerKeys = useRef<((e: KeyboardEvent<HTMLTextAreaElement>) => boolean) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Files on the message being written (ChatAttachments.tsx); `dragDepth` counts nested dragenter/leave pairs.
  const files = useChatAttachments(workspaceId, session?.id ?? null);
  const references = useWorkflowReferences(workspaceId, session?.id ?? null, refsTick);
  /** The `@mention` at the caret, read after every change or caret move. */
  const trackMention = (el: HTMLTextAreaElement) => {
    const m = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    setMention((cur) => (m?.start === cur?.start && m?.query === cur?.query ? cur : m));
  };
  /** The toolbar's `@` button: the same thing as typing `@` — put one at the caret and open the picker. */
  const insertMention = () => {
    const el = composerRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? input.length;
    const before = input.slice(0, pos);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const caret = pos + lead.length + 1;
    setInput(before + lead + "@" + input.slice(pos));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
      trackMention(el);
    });
  };
  // The composer grows with a long message, easing to each new height, and scrolls past 200px.
  useAutoGrow(composerRef, input, { min: 24, max: 200, mountKey: `${session?.id ?? ""}:${chatOpen}` });
  /**
   * The composer floats over the conversation, so the conversation's bottom space must be exactly as tall as the
   * composer is: when it grows (a long message, attached files, an approval card) the messages move up with it instead
   * of disappearing underneath. A reader at the bottom stays at the bottom; one scrolled up is left where they are.
   */
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const list = scroller.current;
    if (!dock || !list || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
      list.style.paddingBottom = `${Math.ceil(dock.offsetHeight) + 16}px`;
      if (atBottom) list.scrollTo({ top: list.scrollHeight, behavior: "instant" as ScrollBehavior });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [session?.id, chatOpen]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const seeded = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const workflowFingerprint = useRef<string>("");
  const savedFingerprint = useRef<string>("");
  const busySince = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | null = null;
    const draftKey = crypto.randomUUID();
    (async () => {
      try {
        const s = await createPiSession(
          workspaceId,
          initialDraft?.trim() ?? "",
          openFlowId ? { flowId: openFlowId } : openChatId ? { chatId: openChatId } : { draftKey, projectId: startInProject ?? null, mode: startMode ?? null },
        );
        // A page that has gone does not delete the conversation (2026-10-10): its event stream closing is what
        // lets the server end Forge after a grace, and another tab or person may be in the same conversation.
        if (cancelled) return;
        sessionId = s.id;
        sessionIdRef.current = s.id;
        setSession(s);
        setStatus(s.status);
        setMessages(s.messages);
        setWorkflow(s.workflow);
        setStepFiles(s.files ?? {});
        setQuestions(s.questions);
        setSavedRevision(s.savedRevision);
        setFlowId(s.flowId);
        setChatId(s.chatId ?? null);
        setContext(s.context ?? null);
        setCompacting(s.compacting === true);
        setMode(s.mode ?? "workflow");
        setThinking(s.thinking ?? "balanced");
        setModel(s.model ?? null);
        setModels(s.models ?? []);
        setAgentAllowed(s.agentAllowed === true);
        setAccounts(s.accounts ?? {});
        setStorage(s.storage ?? null);
        {
          const fromPlace = s.place?.key?.match(/^project:([0-9a-f-]{36})$/i)?.[1] ?? null;
          setProjectId(fromPlace ?? startInProject ?? null);
        }
        if (s.lastTestRun) setTestResult({ ok: s.lastTestRun.ok, detail: s.lastTestRun.detail, runId: s.lastTestRun.runId ?? null, waiting: s.lastTestRun.waiting ?? null, needsRealData: s.lastTestRun.needsRealData === true });
        // A reopened flow arrives already saved; its current workflow IS the saved one.
        if (s.savedRevision != null) savedFingerprint.current = JSON.stringify(s.workflow);
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      sessionIdRef.current = null;
    };
  }, [workspaceId, initialDraft, openFlowId, openChatId]);

  /** The live connection: answering, being retried, or ended for good (the server restarted on an unsaved draft). */
  const [link, setLink] = useState<"live" | "reconnecting" | "gone">("live");
  const flowIdRef = useRef<string | null>(null);
  flowIdRef.current = flowId;
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;

  // A new chat is saved by its first message: from then on this page's address is that chat, so a reload, a shared
  // link or the back button comes back to it rather than to an empty new chat. It stays the chat's address after the
  // chat builds a workflow (one conversation, one address); only a workflow opened from Workflows keeps its own.
  useEffect(() => {
    if (!chatId || openFlowId) return;
    const want = `/chats/${chatId}`;
    if (typeof window !== "undefined" && window.location.pathname + window.location.search !== want) {
      window.history.replaceState(window.history.state, "", want);
    }
  }, [chatId, flowId, openFlowId]);

  useEffect(() => {
    if (!session) return;
    const handle = (ev: PiEvent) => {
      switch (ev.type) {
        case "status":
          setStatus(ev.status);
          setBusy(ev.status === "running");
          break;
        case "delta":
          setDraftDelta((d) => d + ev.text);
          break;
        case "thinking":
          setDraftThinking((d) => d + ev.text);
          break;
        case "message":
          setMessages((m) => {
            if (m.some((x) => x.id === ev.message.id)) return m;
            if (ev.message.role === "assistant") playReceive();
            return [...m, ev.message];
          });
          if (ev.message.role === "assistant") {
            setDraftDelta("");
            setDraftThinking("");
            setLiveActivities([]);
            setRetrying(null);
          }
          break;
        case "retrying":
          setRetrying(ev.attempt > 0 ? { attempt: ev.attempt, maxAttempts: ev.maxAttempts, title: ev.title } : null);
          break;
        case "activity":
          setLiveActivities((list) => {
            const i = list.findIndex((a) => a.id === ev.activity.id);
            if (i < 0) return [...list, ev.activity];
            const next = list.slice();
            next[i] = ev.activity;
            return next;
          });
          break;
        case "workflow":
          setWorkflow(ev.workflow);
          if (ev.files) setStepFiles(ev.files);
          break;
        case "questions":
          setQuestions(ev.questions);
          break;
        case "verify":
          if (!ev.ok) setBanner(ev.summary ?? ev.detail, ev.detail);
          break;
        case "test_run_started":
          // Mid-test live panel (Phase 2) — runId before waitForRun settles.
          setTestResult((prev) => ({
            ok: prev?.ok ?? false,
            detail: prev?.detail ?? "Test running…",
            runId: ev.runId,
            waiting: prev?.waiting ?? null,
            needsRealData: prev?.needsRealData,
          }));
          break;
        case "test_run":
          setTestResult({ ok: ev.ok, detail: ev.detail, runId: ev.runId ?? null, waiting: ev.waiting ?? null, needsRealData: ev.needsRealData === true });
          setBanner(ev.ok ? null : ev.summary ?? ev.detail, ev.detail, { needsRealData: ev.needsRealData === true });
          break;
        case "chat":
          setChatId(ev.chatId);
          break;
        case "context":
          setContext(ev.context);
          break;
        case "compacting":
          setCompacting(ev.on);
          break;
        case "mode":
          setMode(ev.mode);
          setAgentAllowed(ev.agentAllowed);
          break;
        case "accounts":
          setAccounts(ev.accounts);
          break;
        case "storage":
          setStorage(ev.storage);
          break;
        case "messages":
          setMessages(ev.messages);
          break;
        case "references":
          setRefsTick((t) => t + 1);
          break;
        case "saved":
          setFlowId(ev.flowId);
          setSavedRevision(ev.revision);
          savedFingerprint.current = workflowFingerprint.current;
          break;
        case "error":
          setBanner(ev.message);
          break;
        case "done":
          setBusy(false);
          // A referenced workflow may have been saved again meanwhile: its chip then offers the newer version.
          setRefsTick((t) => t + 1);
          break;
        default:
          break;
      }
    };

    // Retries (2026-10-11): a dropped stream — the web proxy restarting, a network blip, a laptop waking — is tried
    // again after 1s, 2s, 4s … (at most 30s apart), and at once when the tab is shown again or the network returns.
    // Once it answers, the page catches up from the session itself, so nothing that happened meanwhile is missing
    // and a stuck "Sending…"/"Thinking…" clears. A server restart drops the session from memory: a SAVED workflow
    // is reopened from its saved draft and chat; an unsaved draft cannot be, and the page says so instead of retrying.
    let stopped = false;
    let attempt = 0;
    let dropped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: () => void = () => {};
    const id = session.id;
    const catchUp = async () => {
      try {
        const s = await getPiSession(workspaceId, id);
        if (stopped) return;
        setStatus(s.status);
        setBusy(s.status === "running");
        setMessages(s.messages);
        setLiveActivities(s.status === "running" ? s.liveActivities ?? [] : []);
        // The reply so far, as the server has it: replaces what the dropped stream left, so nothing doubles or goes missing.
        setDraftDelta(s.status === "running" ? s.draftText ?? "" : "");
        setDraftThinking(s.status === "running" ? s.draftThinking ?? "" : "");
        setWorkflow(s.workflow);
        setStepFiles(s.files ?? {});
        setQuestions(s.questions);
        setSavedRevision(s.savedRevision);
        setFlowId(s.flowId);
        setChatId(s.chatId ?? null);
        setContext(s.context ?? null);
        setCompacting(s.compacting === true);
        setMode(s.mode ?? "workflow");
        setThinking(s.thinking ?? "balanced");
        setModel(s.model ?? null);
        setModels(s.models ?? []);
        setAgentAllowed(s.agentAllowed === true);
        setAccounts(s.accounts ?? {});
        setStorage(s.storage ?? null);
        if (s.lastTestRun) setTestResult({ ok: s.lastTestRun.ok, detail: s.lastTestRun.detail, runId: s.lastTestRun.runId ?? null, waiting: s.lastTestRun.waiting ?? null, needsRealData: s.lastTestRun.needsRealData === true });
        if (s.status !== "running") setRetrying(null);
      } catch (e) {
        if (!stopped && /\b404\b/.test(String(e))) void lost();
      }
    };
    const lost = async () => {
      unsub();
      // A saved workflow or a saved chat is reopened from the database; only a chat with no message yet is gone.
      const saved = flowIdRef.current;
      const chat = chatIdRef.current;
      if (!saved && !chat) {
        setLink("gone");
        setBusy(false);
        return;
      }
      try {
        // By its chat when it has one, so it comes back in the mode it was in; a flow alone opens in Workflow Builder.
        const s = await createPiSession(workspaceId, "", chat ? { chatId: chat } : { flowId: saved });
        if (stopped) return;
        sessionIdRef.current = s.id;
        setSession(s); // this effect runs again for the reopened session, and connects to it
        setLink("live");
      } catch (e) {
        if (stopped) return;
        // Not found: the chat was deleted. Retrying cannot bring it back.
        if (/\b404\b/.test(String(e))) {
          setLink("gone");
          setBusy(false);
        } else retry();
      }
    };
    const retry = () => {
      if (stopped) return;
      clearTimeout(timer);
      setLink("reconnecting");
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
    };
    const connect = () => {
      if (stopped) return;
      unsub();
      unsub = openPiEventStream(
        workspaceId,
        id,
        handle,
        (err) => {
          if (stopped) return;
          dropped = true;
          if (/SSE 404\b/.test(err.message)) void lost();
          else retry();
        },
        () => {
          attempt = 0;
          setLink("live");
          if (dropped) void catchUp();
          dropped = false;
        },
      );
    };
    const now = () => {
      if (stopped || !dropped || document.visibilityState === "hidden") return;
      attempt = 0;
      clearTimeout(timer);
      connect();
    };
    connect();
    document.addEventListener("visibilitychange", now);
    window.addEventListener("online", now);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsub();
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("online", now);
    };
  }, [session, workspaceId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, liveActivities, draftDelta, questions, busy]);

  useEffect(() => {
    if (!busy) {
      busySince.current = null;
      setElapsed(0);
      return;
    }
    if (busySince.current == null) busySince.current = Date.now();
    const t = window.setInterval(() => {
      const start = busySince.current ?? Date.now();
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 250);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (!session || seeded.current || !initialDraft?.trim()) return;
    seeded.current = true;
    setBusy(true);
    void sendPiMessage(workspaceId, session.id, initialDraft.trim()).catch((e) => {
      setBanner(errorText(e));
      setBusy(false);
    });
  }, [session, initialDraft, workspaceId]);

  /**
   * Save when a turn ends GREEN (`ready` = verified + test-run passed) and the workflow changed since the last save
   * (pi-runtime P3). Saving on every change to the step list wrote a revision per keystroke of Pi's work, and the
   * server now refuses a workflow that fails its checks — so the only state worth keeping automatically is a green one.
   */
  useEffect(() => {
    workflowFingerprint.current = JSON.stringify(workflow);
    if (!session || busy || status !== "ready" || !workflow.steps.length) return;
    if (workflowFingerprint.current === savedFingerprint.current) return;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          setSaving(true);
          const s = await savePiVersion(workspaceId, session.id);
          savedFingerprint.current = JSON.stringify(workflow);
          setFlowId(s.flowId);
          setSavedRevision(s.savedRevision);
        } catch (e) {
          setBanner(errorText(e));
        } finally {
          setSaving(false);
        }
      })();
    }, 600);
    return () => window.clearTimeout(t);
  }, [workflow, session, workspaceId, busy, status]);


  const pickModel = async (m: string) => {
    if (!session) return;
    const s = await setPiModel(workspaceId, session.id, m);
    setModel(s.model ?? m);
    setModels(s.models ?? models);
  };
  const pickThinking = async (level: ThinkingLevelValue) => {
    if (!session) return;
    const s = await setPiThinking(workspaceId, session.id, level);
    setThinking(s.thinking ?? level);
  };

  // `/` commands (2026-11-04): /model and /think. Think only exists in Forge Agent mode.
  const [pillMenu, setPillMenu] = useState<PillMenu | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const availableCommands = SLASH_COMMANDS.filter((c) => c.name !== "think" || mode === "agent");
  const slash = parseSlash(input);
  const slashList: SlashCommand[] = !slash
    ? []
    : slash.hasArg
      ? [exactCommand(input, availableCommands)?.command].filter((c): c is SlashCommand => !!c)
      : commandsFor(slash.name, availableCommands);
  const slashOpen = slashList.length > 0 && !slashDismissed;
  const slashKey = slashList.map((c) => c.name).join(",");
  useEffect(() => setSlashIndex(0), [slashKey]);
  useEffect(() => {
    if (!input.startsWith("/")) setSlashDismissed(false);
  }, [input]);
  const runSlash = (chosen?: SlashCommand): boolean => {
    const exact = exactCommand(input, availableCommands);
    const command = exact?.command ?? chosen ?? (slashOpen ? slashList[Math.min(slashIndex, slashList.length - 1)] : undefined);
    if (!command) {
      // A known command this chat does not offer is told, never sent to Forge as a message (2026-11-04).
      if (/^\/think\b/i.test(input.trim())) {
        setBanner("Thinking can only be set in Forge Agent chats.");
        return true;
      }
      return false;
    }
    if (busy || status === "running") {
      setBanner(`Forge is working. Use /${command.name} again when it finishes.`);
      return true;
    }
    const arg = exact?.arg ?? "";
    setInput("");
    const focus = command.name === "model" ? "model" : "thinking";
    if (!arg) {
      setPillMenu({ focus });
      return true;
    }
    const current = model ?? session?.model ?? null;
    const items =
      command.name === "model"
        ? (current && !models.includes(current) ? [current, ...models] : models).map((id) => ({ key: id, labels: [prettyModelName(id), id] }))
        : THINKING_LEVELS.map((l) => ({ key: l, labels: [l, THINKING_LABEL[l]] }));
    const { pick } = bestMatch(arg, items);
    if (!pick) {
      setPillMenu({ focus, filter: arg });
      return true;
    }
    const run = command.name === "model" ? pickModel(pick) : pickThinking(pick as ThinkingLevelValue);
    run.catch((e) => setBanner(errorText(e)));
    return true;
  };

  const sendNow = useCallback(async (text: string, attached: string[], opts?: { fromQueue?: boolean }) => {
    if (!session) return;
    setInput("");
    setBusy(true);
    setDraftDelta("");
    setDraftThinking("");
    setBanner(null);
    playSend();
    try {
      await sendPiMessage(workspaceId, session.id, text, attached);
      if (!opts?.fromQueue) files.clear();
    } catch (e) {
      setBanner(errorText(e));
      setBusy(false);
      if (opts?.fromQueue) {
        // Back to the front, and held so the same failure does not loop (2026-11-03).
        setQueue((q) => [{ id: crypto.randomUUID(), text, attachments: attached }, ...q]);
        setQueueHeld(true);
      } else {
        setInput(text);
      }
    }
  }, [session, workspaceId, files]);

  const send = useCallback(async () => {
    if (runSlash()) return;
    // A file still uploading holds the message back: sending without it would drop it silently.
    if (!session || files.uploading || (!input.trim() && !files.ready.length)) return;
    const text = input.trim();
    const attached = files.ready;
    if (busy) {
      setQueue((q) => [...q, { id: crypto.randomUUID(), text, attachments: attached }]);
      setInput("");
      files.clear();
      return;
    }
    await sendNow(text, attached);
  }, [session, input, busy, files, sendNow, runSlash]);

  // Forge is free: the first waiting message goes (2026-11-03). The ref keeps StrictMode from sending it twice.
  useEffect(() => {
    if (busy || status === "running" || status === "awaiting_answers" || queueHeld || !queue.length || !session) return;
    const item = queue[0]!;
    if (queueSending.current === item.id) return;
    queueSending.current = item.id;
    setQueue((q) => q.filter((m) => m.id !== item.id));
    void sendNow(item.text, item.attachments, { fromQueue: true });
  }, [busy, status, queueHeld, queue, session, sendNow]);

  useEffect(() => {
    setQueue([]);
    setQueueHeld(false);
    queueSending.current = null;
  }, [session?.id]);

  // "Send now": hand a waiting message to the running turn. Text only (2026-11-03).
  const steerQueued = useCallback(async (item: QueuedMessage) => {
    if (!session) return;
    try {
      await steerPiMessage(workspaceId, session.id, item.text);
      setQueue((q) => q.filter((m) => m.id !== item.id));
    } catch (e) {
      setQueue((q) => q.map((m) => (m.id === item.id ? { ...m, error: errorText(e) } : m)));
    }
  }, [session, workspaceId]);

  // Try again on a failure card: the server re-runs the last turn as it was.
  const onRetry = useCallback(async () => {
    if (!session || busy) return;
    setBusy(true);
    setDraftDelta("");
    setDraftThinking("");
    setBanner(null);
    try {
      await retryPiTurn(workspaceId, session.id);
    } catch (e) {
      setBanner(errorText(e));
      setBusy(false);
    }
  }, [session, busy, workspaceId]);

  const onStop = useCallback(async () => {
    if (!session) return;
    try {
      await stopPiSession(workspaceId, session.id);
      setBusy(false);
      setDraftDelta("");
      setDraftThinking("");
    } catch (e) {
      setBanner(errorText(e));
    }
  }, [session, workspaceId]);

  const onSaveDraft = useCallback(async () => {
    if (!session || !workflow.steps.length) return;
    setSaving(true);
    setBanner(null);
    try {
      const s = await savePiVersion(workspaceId, session.id);
      setFlowId(s.flowId);
      setSavedRevision(s.savedRevision);
      savedFingerprint.current = JSON.stringify(workflow);
      setBanner(
        s.flowId
          ? `Draft saved on Workflows · revision ${s.savedRevision ?? "?"}`
          : "Draft saved",
      );
    } catch (e) {
      setBanner(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [session, workflow, workspaceId]);

  /** Chat → schedule (Phase 1): preset only, after a green test; saves and switches on when possible. */
  const onSchedule = useCallback(
    async (cron: string) => {
      if (!session || !testResult?.ok || busy || saving) return;
      setSaving(true);
      setBanner(null);
      const timezone = (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        } catch {
          return "UTC";
        }
      })();
      try {
        const out = await schedulePiSession(workspaceId, session.id, { cron, timezone, arm: true });
        setFlowId(out.session.flowId);
        setSavedRevision(out.session.savedRevision);
        setWorkflow(out.session.workflow);
        savedFingerprint.current = JSON.stringify(out.session.workflow);
        setBanner(
          out.armed
            ? `On · ${out.label} (${timezone}). It will run on its own.`
            : `${out.label} saved on the draft — open the workflow to switch it on.`,
        );
      } catch (e) {
        setBanner(errorText(e));
      } finally {
        setSaving(false);
      }
    },
    [session, testResult?.ok, busy, saving, workspaceId],
  );

  /**
   * Test run = a REAL draft run of this session's workflow on flow-runner (pi-runtime P2/P3): reads come from test
   * data and messages are held, not delivered. The same executor a production run uses.
   */
  const onTestRun = useCallback(async (values?: Record<string, string>, opts?: { useProductionData: boolean }) => {
    if (!session || busy) return;
    setBusy(true);
    setBanner(null);
    setLastRun(null);
    try {
      // The server starts the run and answers at once (2026-10-12). The result arrives on the event stream: a
      // `test_run` event sets it and `done` clears `busy`, so nothing here waits on a request for the whole run.
      const s = await testRunPiSession(workspaceId, session.id, values, opts);
      setStatus(s.status);
    } catch (e) {
      setBanner(errorText(e));
      setBusy(false);
    }
  }, [session, busy, workspaceId]);

  const submitAnswers = useCallback(
    async (answers: Record<string, string>) => {
      if (!session) return;
      setBusy(true);
      try {
        await answerPiQuestions(workspaceId, session.id, answers);
      } catch (e) {
        setBanner(errorText(e));
        setBusy(false);
      }
    },
    [session, workspaceId],
  );

  // Read the run's record whenever a new test run settles. A refused workflow has no run (runId null), and the
  // previous run's evidence must not stand in for it.
  const lastRunId = testResult?.runId ?? null;
  useEffect(() => {
    if (!lastRunId) {
      setLastRun(null);
      return;
    }
    let cancelled = false;
    getFlowExecution(lastRunId)
      .then((r) => {
        if (!cancelled) setLastRun(r);
      })
      .catch(() => {
        if (!cancelled) setLastRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lastRunId]);

  /**
   * The test drawer asks for what the workflow declares NOW — read from the server as it opens, never from the
   * stream-fed copy on screen. That copy goes stale whenever the stream drops (2026-10-10: after a redeploy the drawer
   * showed the workflow from before month/year were added — no fields at all).
   */
  const openTest = useCallback(async () => {
    if (!session) return;
    try {
      const fresh = await getPiSession(workspaceId, session.id);
      setWorkflow(fresh.workflow);
      setStepFiles(fresh.files ?? {});
      setTestPanelOpen(true);
    } catch (e) {
      setBanner(
        `This builder session has ended — the server was restarted. Reload the page; the flow and its conversation are kept once saved. (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }, [session, workspaceId]);

  const awaitingAskSurface = messages.some((m) =>
    (m.proposals ?? []).some((p) => p.kind === "surface" && p.surface?.mode === "ask" && p.status === "pending"),
  );
  const awaiting = status === "awaiting_answers" && ((questions.questions?.length ?? 0) > 0 || awaitingAskSurface);
  const hasSteps = workflow.steps.length > 0;
  // What Forge is doing, in one sentence: a retry first (it explains a pause), then the file it is on. Null: the working
  // line says one word for the turn instead ("Ruminating…").
  const thinkLabel = retrying
    ? `${retrying.title ?? "The AI service did not answer"} — trying again${retrying.maxAttempts ? ` (${retrying.attempt} of ${retrying.maxAttempts})` : ""}…`
    : activityStatusNote(liveActivities) ?? null;

  // ONE header (2026-10-10): the flow's name, its state and the two actions live in the shell's top bar — not in a
  // chat head, a canvas toolbar and a canvas title row stacked under it.
  const isDirty = hasSteps && (savedRevision == null || workflowFingerprint.current !== savedFingerprint.current);
  // When a request starts, keep the files as they were: the Files view marks what this request changed.
  useEffect(() => {
    const running = status === "running";
    if (running && !wasRunning.current) setTurnBase({ "workflow.json": JSON.stringify(workflow, null, 2), ...stepFiles });
    wasRunning.current = running;
    // Only the status edge matters; the files at that moment are the "before".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  usePageHeader(
    session
      ? {
          title: openFlowId ? (
            <span className="min-w-0 flex-1 truncate font-medium">{workflow.name?.trim() || "Untitled workflow"}</span>
          ) : (
            // A chat is named by its stored title, else its first message, else "New chat" — never "New workflow":
            // what it will produce is not known until the person says.
            <span className="min-w-0 flex-1 truncate font-medium">{storedTitle?.trim() || firstLine(messages) || "New chat"}</span>
          ),
          actions: (
            <div className="flex items-center gap-1">
              <RunState
                open={stateOpen}
                onToggle={() => setStateOpen((v) => !v)}
                status={status}
                steps={workflow.steps.length}
                savedRevision={flowId ? savedRevision : null}
                testResult={testResult}
                flowId={flowId}
                workflowName={workflow.name ?? ""}
                edge={{
                  needsApprove:
                    bg.jobs.some((j) => j.status === "awaiting_approval") ||
                    messages.some((m) => m.proposals?.some((p) => p.kind === "edge" && p.status === "pending")),
                  onDevice: bg.jobs.some((j) => j.status === "approved" || j.status === "running"),
                }}
              />
              {/* Testing is the workflow's; Forge Agent does not build one, so the button is Workflow Builder's only. */}
              {mode !== "agent" ? (
                <button
                  type="button"
                  data-testid="builder-test"
                  onClick={() => void openTest()}
                  disabled={busy || !hasSteps}
                  className="h-8 rounded-md px-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                >
                  Test
                </button>
              ) : null}
              {/* Saving is the workflow's too: Forge Agent never changes it, so nothing of this chat's is saved from here. */}
              {mode !== "agent" ? (
                <button
                  type="button"
                  onClick={() => void onSaveDraft()}
                  disabled={saving || !hasSteps || !isDirty}
                  title={!hasSteps ? "Nothing built yet" : !isDirty ? "This version is saved" : "Save this version"}
                  // The primary colour only when there is something to save — a saved draft is a quiet state, not a call to act.
                  className={
                    isDirty || saving
                      ? "btn-primary h-8 rounded-md px-3 text-sm font-medium disabled:opacity-50"
                      : "flex h-8 items-center gap-1 rounded-md px-2.5 text-sm font-medium text-muted disabled:cursor-default"
                  }
                >
                  {saving ? "Saving…" : isDirty ? "Save" : <><span aria-hidden><Check s={14} /></span>Saved</>}
                </button>
              ) : null}
              {/* Chat → schedule: only after a green test (Phase 1.2). Presets only — no cron box. */}
              {mode !== "agent" && testResult?.ok && hasSteps ? (
                <label className="relative inline-flex h-8 items-center">
                  <span className="sr-only">Schedule this workflow</span>
                  <select
                    data-testid="builder-schedule"
                    disabled={saving || busy}
                    defaultValue=""
                    onChange={(e) => {
                      const cron = e.target.value;
                      e.target.value = "";
                      if (cron) void onSchedule(cron);
                    }}
                    title={workflow.schedule?.cron ? `Scheduled: ${workflow.schedule.cron}` : "Run this on a cadence"}
                    className="h-8 max-w-[11rem] cursor-pointer appearance-none rounded-md border border-line bg-surface px-2.5 pr-7 text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-50"
                  >
                    <option value="" disabled>
                      {workflow.schedule?.cron ? "Reschedule…" : "Schedule…"}
                    </option>
                    {SCHEDULE_PRESETS.map((p) => (
                      <option key={p.cron} value={p.cron}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-2 text-dim" aria-hidden>
                    <ChevronDown s={12} />
                  </span>
                </label>
              ) : null}
            </div>
          ),
          endActions: (
            <div className="relative flex items-center gap-0.5">
              <BackgroundToggle live={bg.live.length} open={bgOpen} onOpen={() => setBgOpen((v) => !v)} />
              {bgOpen ? (
                <BackgroundPanel
                  jobs={bg.jobs}
                  live={bg.live}
                  err={bg.err}
                  onStop={bg.stop}
                  onClose={() => setBgOpen(false)}
                />
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setToolsOpen((v) => {
                    if (v) {
                      setPane((p) => (p?.kind === "files" ? null : p));
                      setToolsExpanded(false);
                      return false;
                    }
                    const tab = nativeToolsTab(mode, canvasOpen);
                    setToolsTab(tab);
                    if (tab === "files") setPane({ kind: "files" });
                    return true;
                  });
                }}
                aria-pressed={toolsOpen}
                aria-label="Tools"
                title="Files and canvas"
                className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                  toolsOpen ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                <PanelRight s={16} />
              </button>
            </div>
          ),
        }
      : null,
    [session != null, openFlowId, workflow.name, workflow.steps.length, workflow.schedule?.cron, flowId, storedTitle, firstLine(messages), stateOpen, status, savedRevision, isDirty, testResult, busy, hasSteps, saving, pane?.kind, canvasOpen, toolsOpen, mode, bg.live.length, bgOpen, bg.jobs, bg.err],
  );

  // Every file in the chat, once each (a later message with the same name is the same stored file): the pane's
  // "Files in chat".
  const chatFiles = useMemo<ChatFile[]>(() => {
    const seen = new Map<string, ChatFile>();
    for (const m of messages) {
      for (const f of m.attachments ?? []) seen.set(f.name, { ...f, from: "you" });
      for (const f of m.files ?? []) seen.set(f.name, { ...f, from: "forge" });
    }
    // A removed file is still named in its message, but it is no longer one of the chat's files.
    return [...seen.values()].filter((f) => !f.removed);
  }, [messages]);
  const chatFileNames = useMemo(() => chatFiles.map((f) => f.name), [chatFiles]);
  const removeChatFile = useCallback(
    async (name: string) => {
      if (!session) return;
      const s = await removePiChatFile(workspaceId, session.id, name);
      setMessages(s.messages);
      setStorage(s.storage ?? null);
      setPane((p) => (p?.kind === "files" && p.path === CHAT_FILE + name ? { kind: "files" } : p));
    },
    [session, workspaceId],
  );
  const openFilesPane = useCallback(() => {
    setToolsTab("files");
    setToolsOpen(true);
    setPane({ kind: "files" });
  }, []);
  const openChatFile = useCallback((name: string) => {
    setToolsTab("files");
    setToolsOpen(true);
    setPane({ kind: "files", path: CHAT_FILE + name });
  }, []);
  const fileHref = useMemo(() => (chatId ? (name: string) => piChatFileUrl(workspaceId, chatId, name) : null), [chatId, workspaceId]);
  const sessionIdForDecide = session?.id ?? null;
  const decideProposal = useMemo(
    () =>
      sessionIdForDecide
        ? async (
            id: string,
            decision: "run" | "decline",
            scope?: GrantScope,
            choice?: string,
            surfaceAct?: { actionId?: string; selected?: string[] },
            always?: EdgeAlways | null,
            folder?: string | null,
          ) => void (await decidePiProposal(workspaceId, sessionIdForDecide, id, decision, scope, choice, surfaceAct, always, folder))
        : null,
    [sessionIdForDecide, workspaceId],
  );
  const decideEmail = useMemo(
    () => (sessionIdForDecide ? async (id: string, decision: "send" | "cancel") => void (await decidePiEmail(workspaceId, sessionIdForDecide, id, decision)) : null),
    [sessionIdForDecide, workspaceId],
  );
  const decideHttp = useMemo(
    () => (sessionIdForDecide ? async (id: string, decision: "send" | "cancel") => void (await decidePiHttp(workspaceId, sessionIdForDecide, id, decision)) : null),
    [sessionIdForDecide, workspaceId],
  );
  const [secretsOpen, setSecretsOpen] = useState(false);
  const secretsCaughtCount = useMemo(() => messages.filter((m) => m.secretsCaught?.length).length, [messages]);
  /** Pending edge Approves — pinned above the composer so scrolling the transcript cannot hide them. */
  const pendingEdgeApprovals = useMemo(() => {
    const out: PiProposal[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      for (const p of m.proposals ?? []) {
        if (p.kind !== "edge" || p.status !== "pending" || seen.has(p.id)) continue;
        seen.add(p.id);
        out.push(p);
      }
    }
    return out;
  }, [messages]);
  /** One folder for the dock — common ancestor of every pending edge path. */
  const pendingEdgeFolder = useMemo(() => {
    const hints = pendingEdgeApprovals
      .map((p) => edgeFolderHint(p.edge?.kind ?? "", (p.params && !Array.isArray(p.params) ? p.params : {}) as Record<string, unknown>))
      .filter((h): h is string => !!h);
    return commonEdgeFolder(hints) ?? hints[0] ?? null;
  }, [pendingEdgeApprovals]);
  // Agent: chat is the only column. Builder: canvas column still exists; never leave both panes folded.
  const agentFull = mode === "agent";
  /** Canvas lives in the workbench column in Builder — only put it in tools when that column is gone. */
  const canvasInTools = agentFull || !canvasOpen;
  useEffect(() => {
    if (!agentFull && !canvasOpen && !chatOpen) setChatOpen(true);
  }, [agentFull, canvasOpen, chatOpen]);
  useEffect(() => {
    if (!canvasInTools && toolsTab === "canvas") setToolsTab("files");
  }, [canvasInTools, toolsTab]);
  const closeTools = useCallback(() => {
    setToolsOpen(false);
    setToolsExpanded(false);
    setPane((p) => (p?.kind === "files" ? null : p));
  }, []);
  const sidePane = (docked: boolean, embedded = false) => (
    <PiSidePane
      view={pane}
      onView={(v) => {
        setPane(v);
        if (embedded && v == null) closeTools();
      }}
      docked={docked}
      embedded={embedded}
      expanded={embedded ? toolsExpanded : docked && !chatOpen}
      onExpand={
        embedded
          ? () => setToolsExpanded((v) => !v)
          : docked
            ? () => setChatOpen((v) => !v)
            : undefined
      }
      workflow={workflow}
      files={stepFiles}
      baseFiles={turnBase}
      live={status === "running"}
      lastRun={lastRun}
      chatFiles={chatFiles}
      chatFileHref={fileHref}
      onRemoveChatFile={busy || status === "running" ? undefined : removeChatFile}
      storage={storage}
    />
  );
  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-danger">
        Could not start builder: {bootError}
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">Starting…</div>
    );
  }

  return (
    <ChatFileHref.Provider value={fileHref}>
    <OpenChatFile.Provider value={openChatFile}>
    <ProjectMemory.Provider
      value={
        projectId && memoryEnabled
          ? {
              projectId,
              chatId,
              remember: async (text: string, messageId?: string) => {
                try {
                  await addProjectMemory(projectId, {
                    kind: "preference",
                    body: text.slice(0, 500),
                    source: "promoted",
                    sourceChatId: chatId,
                    sourceMessageId: messageId ?? null,
                  });
                  toast.success("Remembered for this project.");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e));
                }
              },
            }
          : null
      }
    >
    <DecideProposal.Provider value={decideProposal}>
    <DecideEmail.Provider value={decideEmail}>
    <DecideHttp.Provider value={decideHttp}>
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Same 48px draft strip the manual builder uses, with Tether actions */}


      <Workbench
        variant="chat"
        className={`forge-wb min-h-0 flex-1 h-full ${selectedStep ? "with-inspector" : ""} ${chatOpen ? "" : "chat-closed"} ${agentFull ? "agent-full" : canvasOpen ? "" : "canvas-closed"}`.trim()}
        style={chatWidth != null ? ({ "--chat-w": `${chatWidth}px` } as CSSProperties) : undefined}
      >
        <WorkbenchPane label="Chat">
          {chatOpen && !agentFull && canvasOpen ? <ChatResizer width={chatWidth} onChange={setChatWidth} /> : null}
          {chatOpen ? (
            <>
              <WorkbenchBody flush>
                <div
                  className="pi-chat relative flex min-h-0 flex-1 flex-col"
                  onDragEnter={(e) => {
                    if (!e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    dragDepth.current += 1;
                    setDragging(true);
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={() => {
                    dragDepth.current = Math.max(0, dragDepth.current - 1);
                    if (dragDepth.current === 0) setDragging(false);
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.files.length) return;
                    e.preventDefault();
                    dragDepth.current = 0;
                    setDragging(false);
                    files.add(e.dataTransfer.files);
                  }}
                >
                  {dragging ? <DropOverlay /> : null}
                  <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
                    {mode === "agent" ? (
                      <ChatConnections
                        accounts={accounts}
                        busy={busy || status === "running"}
                        onChange={async (piece) => setAccounts((await clearPiAccount(workspaceId, session.id, piece)).accounts ?? {})}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setCanvasOpen(true);
                        setChatOpen(false);
                      }}
                      aria-label="Hide chat"
                      title="Hide chat"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-surface-2 hover:text-text"
                    >
                      <ChevronLeft s={14} />
                    </button>
                  </div>
                  {link === "reconnecting" ? (
                    <div className="pi-link" role="status" aria-live="polite">
                      <span className="pi-link-dot" aria-hidden />
                      Reconnecting to the builder…
                    </div>
                  ) : null}
                  <div
                    ref={bindScroller}
                    className="pi-wide min-h-0 flex-1 space-y-8 overflow-y-auto scroll-smooth px-6 pb-48 pt-11"
                  >

                    {/* The welcome is the session's first message, written by the server from this person and
                        workspace (pi-builder/welcome.ts). The screen draws none of its own — it did, and every
                        conversation opened with two. */}
                    {(() => {
                      const items = coalesceContinueTurns(chatItems(messages));
                      const liveOn = busy || liveActivities.length > 0 || !!draftDelta || !!draftThinking;
                      // Readable thinking is its own block, streaming while the model thinks; while it is the newest
                      // thing on screen, its header is the working line and a second one would say the same.
                      const thinkingNow = busy && !!draftThinking && !draftDelta;
                      const live = liveOn ? (
                        <div className="space-y-2">
                          {draftThinking ? <ThinkingBlock text={draftThinking} live={thinkingNow} /> : null}
                          <ActivityStack activities={liveActivities} />
                          {draftDelta ? <LiveReply text={draftDelta} /> : null}
                          {busy && !(thinkingNow && !thinkLabel) ? <WorkingLine label={thinkLabel} elapsed={elapsed} warn={!!retrying} /> : null}
                          {/* Mid-test engine watch (Phase 2): step progress + Stop once runId is known. */}
                          {busy && testResult?.runId ? <LiveRunPanel runId={testResult.runId} /> : null}
                        </div>
                      ) : null;
                      const lastIsTurn = items.at(-1)?.kind === "turn";
                      const asking = awaiting ? (
                        <QuestionCard
                          key={questions.questions.map((q) => q.id).join("|")}
                          questions={questions.questions}
                          busy={busy}
                          onSubmit={(a) => void submitAnswers(a)}
                          chatFiles={chatFileNames}
                        />
                      ) : null;
                      return (
                        <>
                          {items.map((item, i) =>
                            item.kind === "welcome" ? (
                              <WelcomeCard key={item.m.id} id={item.m.id} text={item.m.text} reopened={i > 0} />
                            ) : item.kind === "note" ? (
                              <SystemNote key={item.m.id} text={item.m.text} />
                            ) : (
                              <TurnCard
                                key={item.user?.id ?? item.replies[0]?.id ?? i}
                                turn={item}
                                onRetry={i === items.length - 1 && !busy ? () => void onRetry() : undefined}
                              >
                                {i === items.length - 1 ? (
                                  <>
                                    {live}
                                    {asking}
                                  </>
                                ) : null}
                              </TurnCard>
                            ),
                          )}
                          {!lastIsTurn ? (
                            <>
                              {live}
                              {asking}
                            </>
                          ) : null}
                        </>
                      );
                    })()}

                  </div>
                  <PromptJumpRail scroller={scrollerEl} />

                  {/* The composer floats over the conversation — no band behind it; the messages fade out beneath. */}
                  <div className="pi-dock pi-wide" ref={dockRef}>
                    {link === "gone" ? (
                      <div className="mb-2 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn/5 p-3 text-[13px]" role="alert">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-text">This conversation ended</div>
                          <div className="text-muted">It could not be reopened: it had no messages yet, or it was deleted. Reload to start again.</div>
                        </div>
                        <button type="button" onClick={() => window.location.reload()} className="btn-primary h-8 shrink-0 rounded-md px-3 text-sm font-medium">
                          Reload
                        </button>
                      </div>
                    ) : null}
                    {testResult?.waiting && session ? (
                      <TestApproval
                        waiting={testResult.waiting}
                        busy={busy}
                        onDecide={async (decision) => {
                          setBusy(true);
                          try {
                            await decidePiTest(workspaceId, session.id, decision);
                          } catch (e) {
                            setBanner(errorText(e));
                            setBusy(false);
                          }
                        }}
                      />
                    ) : null}

                    {!canvasOpen && banner ? (
                      <div role="alert" className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-text">
                        <BannerText
                          state={bannerState!}
                          realData={{ canRun: canTestRealData, busy, onRun: () => void onTestRun(undefined, { useProductionData: true }) }}
                        />
                      </div>
                    ) : null}
                    <OthersChatNotice othersChat={session?.othersChat ?? null} />
                    {pendingEdgeApprovals.length ? (
                      <div className="mb-2 space-y-2" data-testid="pending-edge-dock" role="region" aria-label="Needs your approval">
                        <p className="text-[10px] font-medium uppercase tracking-widest text-warn">Needs your approval</p>
                        {pendingEdgeFolder && decideProposal ? (
                          <div className="rounded-xl border border-warn/30 bg-warn/5 p-3 space-y-2">
                            <p className="text-sm font-medium text-text">Allow work in this folder</p>
                            <p className="truncate font-mono text-[12.5px] text-muted" title={pendingEdgeFolder}>
                              {pendingEdgeFolder}
                            </p>
                            <p className="text-caption text-dim">
                              {pendingEdgeApprovals.length} pending action{pendingEdgeApprovals.length === 1 ? "" : "s"} — one Allow covers
                              this folder for the rest of this workspace.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  void decideProposal(pendingEdgeApprovals[0]!.id, "run", undefined, undefined, undefined, "path_read", pendingEdgeFolder)
                                }
                              >
                                Allow this folder
                              </Button>
                            </div>
                          </div>
                        ) : (
                          pendingEdgeApprovals.map((p) => <ProposalCard key={p.id} p={p} onDecide={decideProposal} />)
                        )}
                      </div>
                    ) : null}
                    <PastedSecretBanner workspaceId={workspaceId} chatId={chatId} refreshKey={secretsCaughtCount} />
                    <BackgroundChip live={bg.live} onOpen={() => setBgOpen(true)} />
                    <StorageNotice storage={storage} onOpenFiles={() => openFilesPane()} />
                    <ReferenceChips
                      refs={references.refs}
                      error={references.error}
                      mode={mode}
                      busy={busy}
                      onDismissError={references.dismissError}
                      onSetVersion={references.setVersion}
                      onRemove={references.remove}
                    />
                    {slashOpen && !mention ? (
                      <SlashCommandMenu
                        commands={slashList}
                        index={slashIndex}
                        locked={busy || status === "running"}
                        onHover={setSlashIndex}
                        onRun={(i) => void runSlash(slashList[i])}
                      />
                    ) : null}
                    {mention ? (
                      <ReferencePicker
                        workspaceId={workspaceId}
                        sessionId={session.id}
                        query={mention.query}
                        mode={mode}
                        count={references.refs?.length ?? 0}
                        keys={pickerKeys}
                        onClose={() => setMention(null)}
                        onPick={(flowId) => {
                          const el = composerRef.current;
                          const caret = el?.selectionStart ?? input.length;
                          const at = mention.start;
                          setInput((text) => withoutMention(text, at, Math.max(caret, at)));
                          setMention(null);
                          void references.add(flowId);
                          requestAnimationFrame(() => {
                            el?.focus();
                            el?.setSelectionRange(at, at);
                          });
                        }}
                      />
                    ) : null}
                    <AttachmentTray
                      pending={files.pending}
                      notice={files.notice}
                      onRemove={files.remove}
                      onDismissNotice={() => files.setNotice(null)}
                    />
                    {queue.length > 0 ? (
                      <div aria-label="Queued messages" className="mb-2 space-y-1">
                        <p className="text-[11px] text-dim">
                          {status === "awaiting_answers"
                            ? "Waiting to send. Answer Forge's questions first."
                            : "Waiting to send. They go one at a time when Forge finishes."}
                        </p>
                        {queueHeld ? (
                          <p role="alert" className="text-[11px] text-danger">
                            The next message could not be sent. <button className="underline" onClick={() => setQueueHeld(false)}>Try again</button>
                          </p>
                        ) : null}
                        {queue.map((item) => (
                          <div key={item.id}>
                            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px]">
                              <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
                              {item.attachments.length ? (
                                <span className="flex shrink-0 items-center gap-0.5 text-dim"><Paperclip s={12} />{item.attachments.length}</span>
                              ) : null}
                              {!item.attachments.length && busy ? (
                                <button
                                  type="button"
                                  onClick={() => void steerQueued(item)}
                                  title="Give this to Forge now, while it works"
                                  className="shrink-0 text-muted hover:text-text"
                                >
                                  Send now
                                </button>
                              ) : null}
                              <button
                                type="button"
                                aria-label="Remove from queue"
                                onClick={() => setQueue((q) => q.filter((m) => m.id !== item.id))}
                                className="shrink-0 text-muted hover:text-text"
                              >
                                ✕
                              </button>
                            </div>
                            {item.error ? <p className="text-[11px] text-danger">{item.error}</p> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="pi-composer flex flex-col gap-2">
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        accept={ATTACH_ACCEPT}
                        className="hidden"
                        aria-hidden
                        tabIndex={-1}
                        onChange={(e) => {
                          if (e.target.files) files.add(e.target.files);
                          e.target.value = "";
                        }}
                      />
                      <textarea
                        ref={composerRef}
                        rows={1}
                        aria-label="Chat message"
                        className="block h-6 w-full resize-none overflow-y-hidden border-0 transition-[height] duration-150 ease-out motion-reduce:transition-none bg-transparent p-0 text-[13px] leading-relaxed text-text placeholder:text-muted/50 focus:outline-none disabled:opacity-60"
                        placeholder={
                          busy
                            ? "Forge is working. Your message will wait until it finishes."
                            : mode === "agent"
                              ? "Describe the automation you want…"
                              : "Describe the automation you want… or type @ to learn from a saved workflow"
                        }
                        value={input}
                        onChange={(e) => {
                          setInput(e.target.value);
                          trackMention(e.target);
                        }}
                        onSelect={(e) => trackMention(e.currentTarget)}
                        onBlur={() => setMention(null)}
                        onPaste={(e) => {
                          // A pasted screenshot is a file: attach it rather than lose it.
                          if (e.clipboardData.files.length) {
                            e.preventDefault();
                            files.add(e.clipboardData.files);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (slashOpen) {
                            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                              e.preventDefault();
                              const n = slashList.length;
                              setSlashIndex((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setSlashDismissed(true);
                              return;
                            }
                            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                              e.preventDefault();
                              void runSlash();
                              return;
                            }
                          }
                          if (mention && pickerKeys.current?.(e)) {
                            e.preventDefault();
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      {/* One toolbar inside the box, the same at any width: what the message goes with on the left, where it
                          goes on the right. Only the model name gives way when the chat is narrow. */}
                      <div className="flex h-7 min-w-0 items-center gap-3 text-[11.5px] leading-none text-dim">
                        <button
                          type="button"
                          onClick={() => fileInput.current?.click()}
                          aria-label="Attach files"
                          title="Attach files: documents, sheets, images or text, up to 50 MB each"
                          className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
                        >
                          <Paperclip s={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setSecretsOpen(true)}
                          disabled={!chatId}
                          aria-label="Add secret"
                          title={
                            chatId
                              ? "Add secret: a key for a website, kept in this chat's vault; Forge uses it by name and never sees it"
                              : "Send a first message to save this chat; then you can add secrets"
                          }
                          className="-ml-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:opacity-40"
                        >
                          <Key s={15} />
                        </button>
                        {chatId ? <SecretsDialog workspaceId={workspaceId} chatId={chatId} open={secretsOpen} onClose={() => setSecretsOpen(false)} /> : null}
                        {mode !== "agent" ? (
                          <button
                            type="button"
                            onClick={insertMention}
                            disabled={busy}
                            aria-label="Reference a saved workflow"
                            title="Reference a saved workflow: Forge reads it and builds on it. You can also type @"
                            className="-ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] font-medium leading-none text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:opacity-40"
                          >
                            @
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            const el = composerRef.current;
                            setInput("/");
                            setSlashDismissed(false);
                            requestAnimationFrame(() => {
                              el?.focus();
                              el?.setSelectionRange(1, 1);
                            });
                          }}
                          disabled={!!input}
                          aria-label="Commands"
                          data-testid="composer-slash"
                          title={input ? "Clear the message to use a command" : "Commands: choose the model or how hard Forge thinks. You can also type /"}
                          className="-ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] font-medium leading-none text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:opacity-40"
                        >
                          /
                        </button>
                          <ModeSwitch
                            mode={mode}
                            agentAllowed={agentAllowed}
                            busy={busy || status === "running"}
                            onSwitch={async (m) => {
                              const s = await setPiMode(workspaceId, session.id, m);
                              setMessages(s.messages);
                              setMode(s.mode ?? m);
                              setAgentAllowed(s.agentAllowed === true);
                              setContext(s.context ?? null);
                            }}
                          />
                        <div className="ml-auto flex min-w-0 items-center">
                          <ModelThinkingPill
                            model={model ?? session.model ?? ""}
                            models={models}
                            thinking={mode === "agent" ? thinking : undefined}
                            disabled={busy || status === "running"}
                            menu={pillMenu}
                            onMenu={setPillMenu}
                            onPickModel={pickModel}
                            onPickThinking={pickThinking}
                          />
                        </div>
                          <ContextMeter
                            context={context}
                            compacting={compacting}
                            canCompact={status !== "running" && !busy && messages.some((m) => m.role === "user")}
                            onCompact={async () => {
                              // Heuristic only — no LLM spend for memory promote.
                              const candidates = projectId && memoryEnabled ? pickMemoryCandidatesLocal(messages, 3) : [];
                              const fresh = await compactPiSession(workspaceId, session.id);
                              setContext(fresh.context ?? null);
                              if (projectId && memoryEnabled && candidates.length) setMemoryPromo(candidates);
                            }}
                          />
                          {busy ? (
                            <button
                              type="button"
                              onClick={() => void onStop()}
                              className="flex h-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface px-3 text-xs font-medium text-muted transition-all duration-150 ease-out hover:border-danger/40 hover:text-danger"
                              aria-label="Stop"
                            >
                              Stop
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void send()}
                            disabled={files.uploading || (!input.trim() && !files.ready.length)}
                            title={files.uploading ? "Wait for the files to finish uploading" : busy ? "Send when Forge finishes" : undefined}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.95] disabled:opacity-40 disabled:cursor-not-allowed"
                            aria-label={busy ? "Add to queue" : "Send"}
                          >
                            <Send s={14} />
                          </button>
                      </div>
                    </div>
                  </div>
                </div>
              </WorkbenchBody>
            </>
          ) : (
            <WorkbenchRail label="Chat" side="left" onExpand={() => setChatOpen(true)} />
          )}
        </WorkbenchPane>

        {!agentFull ? (
        <WorkbenchPane label="The flow you are building">
          {!canvasOpen ? (
            <WorkbenchRail
              label="Canvas"
              side="right"
              onExpand={() => setCanvasOpen(true)}
              icon={<Workflow s={14} />}
              meta={workflow.steps.length > 0 ? String(workflow.steps.length) : undefined}
            />
          ) : (
          <>
          {banner ? (
            <div className="shrink-0 border-b border-line bg-warn/10 px-4 py-2 text-xs text-text">
              <BannerText
                state={bannerState!}
                realData={{ canRun: canTestRealData, busy, onRun: () => void onTestRun(undefined, { useProductionData: true }) }}
              />
            </div>
          ) : null}
          <WorkbenchBody flush>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <PiFlowCanvas
                workflow={workflow}
                flowId={flowId}
                selectedId={selectedStep}
                onSelect={(id, tab) => setPane(id ? { kind: "step", id, tab: tab ?? (pane?.kind === "step" ? pane.tab : "overview") } : null)}
              />
              {testPanelOpen ? (
                <TestWorkbenchPanel
                  flowId={flowId ?? session.id}
                  inputs={piInputDecls(workflow)}
                  testing={busy}
                  notice={busy ? "Running…" : null}
                  run={(values, opts) => void onTestRun(values, opts)}
                  result={lastRun}
                  onClose={() => setTestPanelOpen(false)}
                />
              ) : null}
              {!toolsOpen ? sidePane(false) : null}
              <button
                type="button"
                onClick={hideCanvas}
                aria-label="Hide canvas"
                title="Hide canvas"
                className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-dim shadow-sm hover:text-text"
                hidden={pane != null || toolsOpen}
              >
                <ChevronRight s={13} />
              </button>
            </div>
          </WorkbenchBody>
          </>
          )}
        </WorkbenchPane>
        ) : null}
      </Workbench>
      <ChatToolsPane
        open={toolsOpen}
        tab={toolsTab}
        onTab={(t) => {
          setToolsTab(t);
          if (t === "files") setPane((p) => (p?.kind === "files" ? p : { kind: "files" }));
          else setPane((p) => (p?.kind === "files" ? null : p));
        }}
        onClose={closeTools}
        width={toolsWidth}
        onWidth={setToolsWidth}
        expanded={toolsExpanded}
        onToggleExpand={() => setToolsExpanded((v) => !v)}
        showCanvas={canvasInTools}
        files={<div className="relative flex h-full min-h-0 flex-col">{sidePane(true, true)}</div>}
        canvas={
          <div className="relative flex h-full min-h-0 flex-col">
            <PiFlowCanvas
              workflow={workflow}
              flowId={flowId}
              selectedId={selectedStep}
              onSelect={(id, tab) => setPane(id ? { kind: "step", id, tab: tab ?? (pane?.kind === "step" ? pane.tab : "overview") } : null)}
            />
          </div>
        }
      />
    </div>
    </DecideHttp.Provider>
    </DecideEmail.Provider>
    </DecideProposal.Provider>
    {memoryPromo && projectId && memoryEnabled ? (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center" role="dialog" aria-label="Remember for this project">
        <div className="w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-raised">
          <h2 className="text-body font-semibold text-text">Remember for this project?</h2>
          <p className="mt-1 text-caption text-muted">After compacting, keep up to three facts so new chats here start with them.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {memoryPromo.map((t, i) => (
              <li key={i} className="rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-text">
                {t}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="rounded-md px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2" disabled={memoryPromoBusy} onClick={() => setMemoryPromo(null)}>
              Skip
            </button>
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50"
              disabled={memoryPromoBusy}
              onClick={() => {
                void (async () => {
                  setMemoryPromoBusy(true);
                  try {
                    for (const body of memoryPromo) {
                      await addProjectMemory(projectId, { kind: "preference", body, source: "compact", sourceChatId: chatId });
                    }
                    toast.success(`Remembered ${memoryPromo.length} for this project.`);
                    setMemoryPromo(null);
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : String(e));
                  } finally {
                    setMemoryPromoBusy(false);
                  }
                })();
              }}
            >
              {memoryPromoBusy ? "Saving…" : "Remember all"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </ProjectMemory.Provider>
    </OpenChatFile.Provider>
    </ChatFileHref.Provider>
  );
}

export type RunTest = "passed" | "failed" | "needs real data" | "refused" | null;
/** Extra edge signals for the header pill — Background / open Approve cards, not only `status`. */
export type RunStateEdge = { needsApprove?: boolean; onDevice?: boolean };

/** The header pill's ONE word and dot (2026-11-03): what Forge is doing first, else how the last test went, else Ready. */
export function runStatePill(status: PiSessionStatus, test: RunTest, edge?: RunStateEdge): { label: string; dot: string } {
  if (status === "running") return { label: "Working…", dot: "bg-accent animate-pulse" };
  // Edge waits used to leave the pill on Ready while a card needed Approve — people had to keep saying "okay".
  if (edge?.needsApprove) return { label: "Needs approve", dot: "bg-warn" };
  if (edge?.onDevice) return { label: "On your computer…", dot: "bg-accent animate-pulse" };
  if (status === "awaiting_answers") return { label: "Needs your answer", dot: "bg-warn" };
  // A session that ended "failed" after a failing test says why (the test), not just that it stopped.
  if (status === "failed" && (test === null || test === "passed")) return { label: "Stopped", dot: "bg-danger" };
  if (test === "passed") return { label: "Test passed", dot: "bg-ok" };
  if (test === "failed") return { label: "Test failed", dot: "bg-danger" };
  if (test === "needs real data") return { label: "Needs real data", dot: "bg-warn" };
  if (test === "refused") return { label: "Checks refused", dot: "bg-danger" };
  return { label: "Ready", dot: status === "ready" || status === "accepted" ? "bg-ok" : "bg-muted" };
}
export const RUN_STATE_LABELS = [
  "Working…",
  "Needs approve",
  "On your computer…",
  "Needs your answer",
  "Stopped",
  "Test passed",
  "Test failed",
  "Needs real data",
  "Checks refused",
  "Ready",
] as const;

/** The builder's state as one word, never truncated; the details (including the workflow link) open on click. */
function RunState({
  open,
  onToggle,
  status,
  steps,
  savedRevision,
  testResult,
  flowId,
  workflowName,
  edge,
}: {
  open: boolean;
  onToggle: () => void;
  status: PiSessionStatus;
  steps: number;
  savedRevision: number | null;
  testResult: { ok: boolean; detail: string; runId: string | null; needsRealData?: boolean } | null;
  flowId: string | null;
  workflowName: string;
  edge?: RunStateEdge;
}) {
  const test: RunTest =
    testResult == null
      ? null
      : testResult.runId == null
        ? "refused"
        : testResult.ok
          ? "passed"
          : testResult.needsRealData
            ? "needs real data"
            : "failed";
  const pill = runStatePill(status, test, edge);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-testid="run-state"
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm font-medium text-text transition-colors hover:bg-surface-2"
      >
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${pill.dot}`} />
        <span data-testid="run-state-label">{pill.label}</span>
        <span aria-hidden className={`shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`}>
          <ChevronDown s={12} />
        </span>
      </button>
      {open ? (
        <>
          <button type="button" aria-label="Close" onClick={onToggle} className="fixed inset-0 z-20 cursor-default bg-transparent" />
          <dl className="absolute right-0 top-full z-30 mt-2 w-72 space-y-2 rounded-lg border border-line bg-surface p-3 text-xs shadow-lg">
            {flowId ? (
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Workflow</dt>
                <dd className="min-w-0 truncate">
                  <Link href={`/flows/${flowId}`} className="text-accent hover:underline">{workflowName.trim() || "Untitled"}</Link>
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt className="text-dim">State</dt>
              <dd className="text-text">{status.replace(/_/g, " ")}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Steps</dt>
              <dd className="text-text">{steps}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Saved</dt>
              <dd className="text-text">{savedRevision != null ? `revision ${savedRevision}` : "not yet"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Last test run</dt>
              <dd className={test === "passed" ? "text-ok" : test === "needs real data" ? "text-warn" : test ? "text-danger" : "text-dim"}>
                {test === null ? "none yet" : test === "refused" ? "refused before it started" : test}
              </dd>
            </div>
            {testResult?.runId ? (
              <Link href={`/runs/${testResult.runId}`} className="block pt-1 text-right text-accent hover:underline">
                View the run
              </Link>
            ) : null}
          </dl>
        </>
      ) : null}
    </div>
  );
}

/**
 * The selected step in the LAST TEST RUN — what it was given, returned and printed. Floats over the canvas (the chat
 * workbench has no inspector column). Says plainly when there is no run, or the step was not in it, rather than
 * showing nothing: an empty panel reads as "the step produced nothing".
 */
/**
 * A test run waiting at an approval (P5): the question it asks, decided here by the person testing — a test runs on
 * test data and holds its mail, so approving it sends nothing. A live run's approval goes to the approvals inbox.
 */
function TestApproval({
  waiting,
  busy,
  onDecide,
}: {
  waiting: PiTestWaiting;
  busy: boolean;
  onDecide: (d: "approved" | "rejected") => void;
}) {
  return (
    <div data-testid="test-approval" className="mx-4 mb-2 rounded-xl border border-warn/40 bg-surface p-3 text-sm">
      <p className="text-[10px] font-medium uppercase tracking-widest text-warn">Test waiting for approval</p>
      <p className="mt-1 font-medium text-text">{waiting.title}</p>
      <p className="mt-0.5 text-xs text-muted">This is a test: approving continues it on test data, and its email is held, not sent.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={busy} onClick={() => onDecide("approved")} className="btn-primary h-8 rounded-md px-3 text-xs font-medium disabled:opacity-50">
          Approve and continue
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide("rejected")} className="h-8 rounded-md border border-line px-3 text-xs font-medium text-muted hover:text-text disabled:opacity-50">
          Reject
        </button>
      </div>
    </div>
  );
}

export type ChatItem =
  | { kind: "welcome"; m: PiChatMessage }
  | { kind: "note"; m: PiChatMessage }
  | { kind: "turn"; user: PiChatMessage | null; replies: PiChatMessage[] };

/**
 * The conversation as TURNS (2026-10-10): a person's message and everything that answered it — Pi's actions, its
 * reply, the server's notes — until the next message. A welcome stands apart (it opens a conversation, or marks a
 * reopen); a note with no turn to belong to stands alone. Pure, so the grouping is testable.
 */
/** A new chat's name until it has a stored one: the person's first message, on one line, cut near 60 characters. */
function firstLine(messages: PiChatMessage[]): string | null {
  const text = messages.find((m) => m.role === "user")?.text?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 57).replace(/\s+\S*$/, "")}…` : text;
}

export function chatItems(messages: PiChatMessage[]): ChatItem[] {
  const out: ChatItem[] = [];
  let cur: Extract<ChatItem, { kind: "turn" }> | null = null;
  for (const m of messages) {
    if (m.welcome) {
      out.push({ kind: "welcome", m });
      cur = null;
    } else if (m.role === "user") {
      // Silent continues (edge settle) still start a turn for replies, but with no Asked bubble / jump target.
      // Legacy chats stored the same continue without `silent` — hide that exact status string too.
      const hideAsked = !!m.silent || m.text === "(work on your computer finished)";
      cur = { kind: "turn", user: hideAsked ? null : m, replies: [] };
      out.push(cur);
    } else if (cur) {
      cur.replies.push(m);
    } else if (m.role === "system") {
      out.push({ kind: "note", m });
    } else {
      cur = { kind: "turn", user: null, replies: [m] };
      out.push(cur);
    }
  }
  return out;
}

/** Edge settle continue: no Asked bubble, and at least one edge Actions row. */
export function isEdgeContinueTurn(item: ChatItem): item is Extract<ChatItem, { kind: "turn" }> {
  if (item.kind !== "turn" || item.user !== null) return false;
  return item.replies.some((r) =>
    (r.activities ?? []).some((a) => a.tool === "edge-run" || a.id.startsWith("edge-")),
  );
}

/**
 * Consecutive silent edge-continue turns → one visual turn: single What Forge did + latest summary.
 * Render-only; stored messages stay one settle each.
 */
export function coalesceContinueTurns(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (item.kind === "turn" && prev?.kind === "turn" && isEdgeContinueTurn(item) && isEdgeContinueTurn(prev)) {
      const replies = [...prev.replies, ...item.replies];
      const activities = replies.flatMap((r) => r.activities ?? []);
      const proposals = replies.flatMap((r) => r.proposals ?? []);
      const files = replies.flatMap((r) => r.files ?? []);
      const seenA = new Set<string>();
      const uniqueActs = activities.filter((a) => {
        if (seenA.has(a.id)) return false;
        seenA.add(a.id);
        return true;
      });
      const seenP = new Set<string>();
      const uniqueProposals = proposals.filter((p) => {
        if (seenP.has(p.id)) return false;
        seenP.add(p.id);
        return true;
      });
      const latest =
        [...replies].reverse().find((r) => r.role === "assistant" && (!!r.text?.trim() || !!r.error)) ??
        replies[replies.length - 1]!;
      out[out.length - 1] = {
        kind: "turn",
        user: null,
        replies: [
          {
            ...latest,
            activities: uniqueActs.length ? uniqueActs : undefined,
            proposals: uniqueProposals.length ? uniqueProposals : undefined,
            files: files.length ? files : latest.files,
          },
        ],
      };
    } else {
      out.push(item);
    }
  }
  return out;
}

/**
 * A conversation saved before answers were recorded (2026-10-10) holds the agent's instruction as the person's words:
 * `Answers are in answers.json: {"q1": "…"}. …`. Its prompts were never stored, so each answer is labelled by number.
 */
export function legacyAnswers(text: string): PiAnswered[] | null {
  const m = /^Answers are in answers\.json: (\{[\s\S]*\})\. Clear questions\.json/.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
    const rows = Object.entries(parsed).map(([id, v], i) => ({ id, prompt: `Question ${i + 1}`, answer: String(v) }));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** One turn on one raised surface — grouping by a shared region and spacing, not by outlines. */
function TurnCard({
  turn,
  onRetry,
  readOnly = false,
  children,
}: {
  turn: Extract<ChatItem, { kind: "turn" }>;
  /** Somebody reading a shared chat (sharing-boundaries): nothing in it may be acted on, so proposals are not shown. */
  readOnly?: boolean;
  /** Given only for the latest turn while nothing is running — Try again re-runs it. */
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const promptLabel = turn.user?.text?.replace(/\s+/g, " ").trim().slice(0, 72) || undefined;
  return (
    <section
      className="space-y-4 animate-[chatIn_180ms_ease]"
      {...(turn.user
        ? { "data-prompt-id": turn.user.id, "data-prompt-label": promptLabel ?? "Prompt" }
        : {})}
    >
      {turn.user ? (
        (() => {
          const answers = turn.user.answers?.length ? turn.user.answers : legacyAnswers(turn.user.text);
          return answers ? (
            <AnsweredCard answers={answers} by={turn.user.by?.name ?? null} />          ) : (
            <Asked by={turn.user.by?.name ?? null} attachments={turn.user.attachments} at={turn.user.at}>
              {turn.user.text}
            </Asked>
          );
        })()
      ) : null}
      {turn.replies.map((r) =>
        r.role === "system" ? (
          <SystemNote key={r.id} text={r.text} />
        ) : (
          <div key={r.id} className="space-y-2">
            {r.thinking?.text ? <ThinkingBlock text={r.thinking.text} ms={r.thinking.ms} /> : null}
            {r.activities?.length ? <ActivityStack activities={r.activities} /> : null}
            {r.error ? (
              <FailureCard error={r.error} onRetry={r === turn.replies.at(-1) ? onRetry : undefined} />
            ) : (
              <Said copy={r.text} at={r.at}>
                <Markdown text={r.text} />
              </Said>
            )}
            {r.files?.length ? <MadeFiles files={r.files} /> : null}
            {r.proposals?.length && !readOnly ? <Proposals proposals={r.proposals} /> : null}
          </div>
        ),
      )}
      {children}
    </section>
  );
}

/**
 * A stored conversation, READ-ONLY (sharing-boundaries): the same turns the workbench draws, with nothing to act on —
 * no retry, no proposal cards. For a member reading a chat somebody shared with the workspace.
 */
export function ReadOnlyConversation({ messages }: { messages: PiChatMessage[] }) {
  const items = coalesceContinueTurns(chatItems(messages));
  if (!items.length) return <p className="text-caption text-muted">Nothing has been said in this chat yet.</p>;
  return (
    <div className="space-y-6">
      {items.map((item, i) =>
        item.kind === "welcome" ? (
          <WelcomeCard key={item.m.id} id={item.m.id} text={item.m.text} reopened={i > 0} />
        ) : item.kind === "note" ? (
          <SystemNote key={item.m.id} text={item.m.text} />
        ) : (
          <TurnCard key={item.user?.id ?? item.replies[0]?.id ?? String(i)} turn={item} readOnly />
        ),
      )}
    </div>
  );
}

/** The changes Forge Agent proposed in a reply: each a card the person decides. Pending edge Approves live in the dock. */
function Proposals({ proposals }: { proposals: PiProposal[] }) {
  const decide = useContext(DecideProposal);
  const decideEmail = useContext(DecideEmail);
  const decideHttp = useContext(DecideHttp);
  const shown = proposals.filter((p) => !(p.kind === "edge" && p.status === "pending"));
  if (!shown.length) return null;
  return (
    <div className="space-y-2">
      {shown.map((p) => (
        <ProposalCard key={p.id} p={p} onDecide={decide} onEmail={decideEmail} onHttp={decideHttp} />
      ))}
    </div>
  );
}

/** The files Forge made or changed in a reply: each one a download card (a saved chat keeps them). */
function MadeFiles({ files }: { files: PiAttachment[] }) {
  const hrefOf = useContext(ChatFileHref);
  const open = useContext(OpenChatFile);
  return <FileCards files={files} hrefOf={hrefOf} onOpen={open} />;
}

/** What the server said on its own (a test result, a fix attempt): quiet, set into the surface, never a reply. */
function SystemNote({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-lg bg-sunken/70 px-3 py-2 text-xs leading-relaxed text-muted">
      <span aria-hidden className="text-dim">ⓘ</span>
      <div className="min-w-0 whitespace-pre-wrap">{text}</div>
    </div>
  );
}

/** The opening line of a conversation, or the mark where it was reopened — a divider, not a reply. */
function WelcomeCard({ id, text, reopened }: { id: string; text: string; reopened: boolean }) {
  // A Forge message, not a banner: the same mark and type as every reply, revealed smoothly the first time it is shown
  // (StreamedText.tsx). Only a reopened conversation gets a divider, between its history and today.
  const { shown } = useStreamedText(id, text);
  return (
    <div className="space-y-6 animate-[chatIn_180ms_ease]">
      {reopened ? (
        <div className="flex items-center gap-3 text-[10px] font-medium uppercase tracking-widest text-dim">
          <span className="h-px flex-1 bg-line" aria-hidden />
          Reopened
          <span className="h-px flex-1 bg-line" aria-hidden />
        </div>
      ) : null}
      <Said>
        <FadingText shown={shown} full={text} />
      </Said>
    </div>
  );
}

/** Forge's reply while it is being written: the text that has arrived, revealed at an even pace (StreamedText.tsx). */
function LiveReply({ text }: { text: string }) {
  const n = useSmoothText(text);
  return (
    <Said>
      <Markdown text={text.slice(0, n)} />
    </Said>
  );
}

function Said({
  children,
  copy,
  at,
}: {
  children: ReactNode;
  /** The reply's text, for its copy button. */
  copy?: string;
  /** When it arrived, shown beside "Forge". */
  at?: string;
}) {
  return (
    <div className="group flex gap-3 animate-[chatIn_180ms_ease]">
      <div className="pi-mark" aria-hidden>
        F
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-[11.5px] font-medium text-muted">
          Forge
          <SentAt at={at} />
        </p>
        <div className="text-[13.5px] leading-relaxed text-text">{children}</div>
        {copy ? (
          <div className="mt-0.5 flex items-center gap-0.5">
            <CopyButton text={copy} label="Copy reply" className="-ml-1" />
            <RememberButton text={copy} className="-ml-0.5" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Where a sent file of this chat downloads from — null until the chat is saved (its files are in the database). */
const ChatFileHref = createContext<((name: string) => string) | null>(null);
/** Do or cancel a proposed change in this chat (null until the session exists). */
const DecideProposal = createContext<
  ((id: string, decision: "run" | "decline", scope?: GrantScope, choice?: string, surfaceAct?: { actionId?: string; selected?: string[] }, always?: EdgeAlways | null, folder?: string | null) => Promise<void>) | null
>(null);
/** Send or cancel an email Forge drafted in this chat (null until the session exists). */
const DecideEmail = createContext<((id: string, decision: "send" | "cancel") => Promise<void>) | null>(null);
/** Send or cancel a web request Forge drafted in this chat (null until the session exists). */
const DecideHttp = createContext<((id: string, decision: "send" | "cancel") => Promise<void>) | null>(null);
/** Opens a chat file's preview in the Files pane. */
const OpenChatFile = createContext<((name: string) => void) | null>(null);
/** Project memory (Phase 4): Remember on a message when the chat lives in a project. */
const ProjectMemory = createContext<{
  projectId: string;
  chatId: string | null;
  remember: (text: string, messageId?: string) => Promise<void>;
} | null>(null);

function RememberButton({ text, messageId, className = "" }: { text: string; messageId?: string; className?: string }) {
  const mem = useContext(ProjectMemory);
  const [state, setState] = useState<"idle" | "done" | "busy">("idle");
  if (!mem || !text.trim()) return null;
  return (
    <button
      type="button"
      aria-label={state === "done" ? "Remembered" : "Remember for this project"}
      title={state === "done" ? "Remembered" : "Remember for this project"}
      disabled={state === "busy"}
      onClick={() => {
        void (async () => {
          setState("busy");
          await mem.remember(text, messageId);
          setState("done");
          setTimeout(() => setState("idle"), 1500);
        })();
      }}
      className={`flex h-6 items-center justify-center rounded px-1.5 text-[11px] font-medium text-dim opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${
        state !== "idle" ? "opacity-100" : ""
      } ${className}`}
    >
      {state === "done" ? "✓" : state === "busy" ? "…" : "Remember"}
    </button>
  );
}

/** A person's message. `by` names them — a workflow's conversation is shared, so who asked is part of the record. */
function Asked({
  children,
  by,
  attachments,
  at,
}: {
  children: ReactNode;
  by?: string | null;
  attachments?: PiAttachment[];
  /** When it was sent, shown beside the sender. */
  at?: string;
}) {
  const hrefOf = useContext(ChatFileHref);
  const hasText = typeof children === "string" ? children.trim().length > 0 : children != null;
  return (
    <div className="group flex flex-col items-end gap-1 animate-[chatIn_180ms_ease]">
      {by || at ? (
        <span className="pr-1 text-[11px] text-dim">
          {by}
          <SentAt at={at} lead={!!by} />
        </span>
      ) : null}
      {attachments?.length ? <SentAttachments files={attachments} hrefOf={hrefOf} /> : null}
      {hasText ? <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-[5px] bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-on-accent shadow-raised">
        {children}
      </div> : null}
      {hasText && typeof children === "string" ? (
        <div className="flex items-center gap-0.5">
          <CopyButton text={children} label="Copy message" className="-mr-1" />
          <RememberButton text={children} className="-mr-1" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A turn that did not finish (2026-10-11): what went wrong in plain words, Try again when it can help, and the raw
 * error behind "Show details" — never a raw "403 terminated" as Forge's reply.
 */
export function FailureCard({ error, onRetry }: { error: PiTurnError; onRetry?: () => void }) {
  const tone = error.retryable ? "warn" : "danger";
  return (
    <div
      className={`flex gap-3 rounded-xl border p-3.5 animate-[chatIn_180ms_ease] ${tone === "warn" ? "border-warn/30 bg-warn/5" : "border-danger/30 bg-danger/5"}`}
      role="alert"
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${tone === "warn" ? "bg-warn/15 text-warn" : "bg-danger/15 text-danger"}`}
        aria-hidden
      >
        !
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13px] font-medium text-text">{error.title}</p>
        <p className="text-[13px] leading-relaxed text-muted">{error.said}</p>
        {(onRetry && error.retryable) || error.detail ? (
          <div className="flex flex-wrap items-center gap-3 pt-1.5">
            {onRetry && error.retryable ? (
              <button type="button" onClick={onRetry} className="btn-primary h-7 rounded-md px-3 text-xs font-medium">
                Try again
              </button>
            ) : null}
            {error.detail ? (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer select-none hover:text-text">Show details</summary>
                <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] text-dim">{error.detail}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}


const MB = 1024 * 1024;
const mbText = (b: number) => `${Math.max(1, Math.round(b / MB))} MB`;

/**
 * The conversation's folder filling up (2026-10-13): a note above the message box from 80%, and a stronger one past
 * the limit, when Forge cannot take another message. Before this, a full folder made every message fail with
 * "Forge stopped unexpectedly".
 */
/**
 * An Admin reading somebody else's chat (rbac-observability). It says whose chat it is, and that opening it left a
 * line in the audit history, so nobody reads another person's conversation without knowing it is recorded.
 */
export function OthersChatNotice({ othersChat }: { othersChat: { ownerName: string | null } | null }) {
  if (!othersChat) return null;
  const whose = othersChat.ownerName?.trim() ? `${othersChat.ownerName.trim()}'s` : "somebody else's";
  return (
    <div role="status" className="mb-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">
      This is {whose} chat. You can see it because you are an Admin, and opening it was recorded in the audit history.
    </div>
  );
}

export function StorageNotice({ storage, onOpenFiles }: { storage: PiStorage | null; onOpenFiles: () => void }) {
  const level = storageLevel(storage);
  if (!storage || level === "ok") return null;
  const mostlyChat = storage.chat > storage.limit * 0.2;
  return (
    <div
      role={level === "full" ? "alert" : "status"}
      className={`mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-xs ${
        level === "full" ? "bg-danger/10 text-text" : "bg-warn/10 text-text"
      }`}
    >
      <span className="min-w-0 flex-1">
        {level === "full"
          ? `This conversation's files take ${mbText(storage.bytes)} of its ${mbText(storage.limit)}, so Forge can't take another message.`
          : `This conversation's files take ${mbText(storage.bytes)} of its ${mbText(storage.limit)}.`}{" "}
        {mostlyChat ? "Remove files you no longer need, or start a new chat." : "Most of it is Forge's own working files: a new chat starts fresh."}
      </span>
      {mostlyChat ? (
        <button type="button" onClick={onOpenFiles} className="shrink-0 font-medium text-accent hover:underline">
          Open Files
        </button>
      ) : null}
    </div>
  );
}

/** "3:42 PM" from an ISO time, in the reader's own time zone; empty when it cannot be read. */
export function clockTime(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
}

/** When a message was sent or a reply arrived, quietly beside the name; the full date on hover. */
function SentAt({ at, lead = true }: { at?: string; lead?: boolean }) {
  const t = clockTime(at);
  if (!t) return null;
  return (
    <time dateTime={at} title={new Date(at!).toLocaleString()} className="font-normal text-dim">
      {lead ? " · " : ""}
      {t}
    </time>
  );
}

/** The banner's sentence, and the raw result it came from behind "Details" when there is one. */
export function BannerText({
  state,
  realData,
}: {
  state: { text: string; detail?: string; needsRealData?: boolean };
  realData?: { canRun: boolean; busy: boolean; onRun: () => void };
}) {
  return (
    <>
      <p className="whitespace-pre-wrap">{state.text}</p>
      {state.needsRealData && realData ? <RealDataAction {...realData} /> : null}
      {state.detail ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-muted hover:text-text">Details</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{state.detail}</pre>
        </details>
      ) : null}
    </>
  );
}

/**
 * (2026-11-03) The way out of a test that needs real data: an admin re-runs it on real records after a confirm step
 * (every read is recorded); anyone else is told to ask an admin.
 */
function RealDataAction({ canRun, busy, onRun }: { canRun: boolean; busy: boolean; onRun: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!canRun) return <p className="mt-1 text-muted">Ask an admin to run it on real data.</p>;
  return (
    <>
      <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="btn-primary mt-2 h-8 rounded-md px-3 text-xs font-medium disabled:opacity-50">
        Test on real data
      </button>
      <Confirm
        open={confirming}
        title="Test on real data?"
        body="This test reads real records from the workspace's databases instead of test data. Every read is recorded."
        confirmLabel="Test on real data"
        danger
        onConfirm={onRun}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
