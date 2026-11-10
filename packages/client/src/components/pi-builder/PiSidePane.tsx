"use client";

/**
 * The builder's right pane (2026-10-11): one surface that slides over the canvas's right edge. Clicking a step opens
 * it on that step — Overview, Inputs & outputs, Code, Last run — and the Files button opens it on what Forge is
 * writing: workflow.json and every step's code, with what changed since your last message marked and its new lines
 * highlighted. It replaces two separate boxes (the step panel and the last-run panel) that opened on top of each other.
 *
 * Always mounted, so it slides both ways; while it slides out it keeps showing what it showed.
 */
import Link from "next/link";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StepEvidence } from "@/components/flow/StepEvidence";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, Close, Code, Collapse, Download, Expand, Folder, Fork, Play, Shield, Trash } from "@/components/ui/icons";
import { errorText, storageLevel, type PiStorage } from "@/lib/pi-builder";
import { fmtDuration } from "@/lib/stats";
import { allNodes, kindOf, type PiAttachment, type PiWorkflow } from "@/lib/pi-builder";
import { END_ID, START_ID } from "@/lib/canvas-model";
import type { FlowExecutionDetail } from "@/lib/types";
import { PiEndInspector, PiStartInspector, PiStepInspector } from "./PiDagCanvas";
import { ChatFilePreview } from "./ChatFilePreview";
import { ToolsHeaderSlot } from "./ChatToolsPane";
import { renderedViewLabel, ViewToggle, type FileView } from "./FileRenderers";

/** A pane path naming a chat file (previewed) rather than a file Forge wrote (shown as code). */
export const CHAT_FILE = "chat:";

export type PaneTab = "overview" | "io" | "code" | "run";
/** A file in this chat: one the person sent, or one Forge made — downloadable, never shown as text. */
export type ChatFile = PiAttachment & { from: "you" | "forge" };
export type PaneView = { kind: "step"; id: string; tab: PaneTab } | { kind: "files"; path?: string } | null;

const TAB_WORD: Record<PaneTab, string> = { overview: "Overview", io: "Inputs & outputs", code: "Code", run: "Last run" };

export function PiSidePane({
  view,
  onView,
  workflow,
  files,
  baseFiles,
  live,
  lastRun,
  chatFiles = [],
  chatFileHref = null,
  onRemoveChatFile,
  storage = null,
  docked = false,
  expanded = false,
  onExpand,
  embedded = false,
}: {
  /** Fills its column as the explorer (the canvas folded) instead of floating over the canvas. */
  docked?: boolean;
  /** The files have the whole width (the chat folded). */
  expanded?: boolean;
  /** Give the files the whole width, or give the chat back. Absent where that is not offered. */
  onExpand?: () => void;
  /** Inside ChatToolsPane: one chrome bar only — no second close, and empty overview is a single column. */
  embedded?: boolean;
  view: PaneView;
  onView: (v: PaneView) => void;
  workflow: PiWorkflow;
  files: Record<string, string>;
  /** The files as they were when the latest request began — what "changed" is measured against. */
  baseFiles: Record<string, string> | null;
  /** Forge is working right now: a changed file is marked live. */
  live: boolean;
  lastRun: FlowExecutionDetail | null;
  /** The chat's files, listed under "Files in chat". */
  chatFiles?: ChatFile[];
  /** Where a chat file downloads from; null until the chat is saved (its first message). */
  chatFileHref?: ((name: string) => string) | null;
  /** Remove a chat file. Absent while Forge is working. */
  onRemoveChatFile?: (name: string) => Promise<void>;
  /** How full the conversation's folder is. */
  storage?: PiStorage | null;
}) {
  // Keep showing the last view while the pane slides out.
  const last = useRef<PaneView>(view);
  if (view) last.current = view;
  const shown = view ?? last.current;
  const open = view != null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onView(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onView]);

  return (
    <aside
      className={`pis-pane${open ? " open" : ""}${shown?.kind === "files" ? " wide" : ""}${docked || embedded ? " docked" : ""}${embedded ? " embedded" : ""}`}
      aria-hidden={!open}
      aria-label={shown?.kind === "files" ? "Files" : "Step details"}
      // A closed pane must not take focus or clicks (React 18 passes `inert` through only as a string).
      {...(open ? {} : ({ inert: "" } as Record<string, string>))}
    >
      {shown?.kind === "step" ? (
        <StepView view={shown} onView={onView} workflow={workflow} files={files} lastRun={lastRun} />
      ) : shown?.kind === "files" ? (
        <FilesView
          path={shown.path}
          onPath={(p) => onView(p ? { kind: "files", path: p } : { kind: "files" })}
          onClose={() => onView(null)}
          expanded={expanded}
          onExpand={onExpand}
          embedded={embedded}
          workflow={workflow}
          files={files}
          baseFiles={baseFiles}
          live={live}
          chatFiles={chatFiles}
          chatFileHref={chatFileHref}
          onRemoveChatFile={onRemoveChatFile}
          storage={storage}
        />
      ) : null}
    </aside>
  );
}

function Head({ icon, title, sub, onClose }: { icon: ReactNode; title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="pis-head">
      <span className="pis-ico">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="pis-title">{title}</div>
        {sub ? <div className="pis-sub">{sub}</div> : null}
      </div>
      <button type="button" onClick={onClose} className="pis-x" aria-label="Close" title="Close (Esc)">
        <Close className="h-4 w-4" />
      </button>
    </div>
  );
}

function StepView({
  view,
  onView,
  workflow,
  files,
  lastRun,
}: {
  view: Extract<PaneView, { kind: "step" }>;
  onView: (v: PaneView) => void;
  workflow: PiWorkflow;
  files: Record<string, string>;
  lastRun: FlowExecutionDetail | null;
}) {
  const close = () => onView(null);
  if (view.id === START_ID || view.id === END_ID) {
    const start = view.id === START_ID;
    return (
      <>
        <Head icon={<Play className="h-4 w-4" />} title={start ? "Start" : "End"} sub={start ? "What the run is given" : "What the run hands back"} onClose={close} />
        <div className="pis-body">{start ? <PiStartInspector workflow={workflow} /> : <PiEndInspector workflow={workflow} />}</div>
      </>
    );
  }
  const step = allNodes(workflow.steps).find((s) => s.id === view.id) ?? null;
  if (!step) {
    return (
      <>
        <Head icon={<Code className="h-4 w-4" />} title={view.id} onClose={close} />
        <p className="p-4 text-sm text-muted">This step is no longer in the workflow.</p>
      </>
    );
  }
  const kind = kindOf(step);
  const tabs: PaneTab[] = kind === "step" ? ["overview", "io", "code", "run"] : ["overview", "run"];
  const tab = tabs.includes(view.tab) ? view.tab : "overview";
  const icon = kind === "approval" ? <Shield className="h-4 w-4" /> : kind === "branch" ? <Fork className="h-4 w-4" /> : <Code className="h-4 w-4" />;
  const title = step.description ?? step.approval?.title ?? step.id;
  const ran = lastRun?.steps.find((s) => s.stepId === step.id) ?? null;
  return (
    <>
      <Head icon={<span className={`pis-k-${kind}`}>{icon}</span>} title={title} sub={step.id} onClose={close} />
      <div className="pis-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} className={`pis-tab${t === tab ? " on" : ""}`} onClick={() => onView({ ...view, tab: t })}>
            {TAB_WORD[t]}
            {t === "run" && ran ? <span className={`pis-dot ${ran.status === "success" ? "ok" : ran.status === "failed" ? "bad" : ""}`} /> : null}
          </button>
        ))}
      </div>
      <div className="pis-body" key={`${step.id}:${tab}`}>
        {tab === "run" ? (
          <LastRun stepId={step.id} step={ran} runId={lastRun?.id ?? null} />
        ) : (
          <PiStepInspector step={step} workflow={workflow} files={files} section={kind === "step" ? tab : undefined} />
        )}
      </div>
    </>
  );
}

function LastRun({ step, runId }: { stepId: string; step: FlowExecutionDetail["steps"][number] | null; runId: string | null }) {
  if (!runId) return <p className="p-4 text-sm text-muted">No test run yet. Run a test to see what this step is given and what it returns.</p>;
  if (!step) return <p className="p-4 text-sm text-muted">This step was not part of the last test run — the workflow changed since.</p>;
  const label = step.status === "success" ? "Succeeded" : step.status === "skipped" ? "Not run — an earlier step failed" : step.status === "failed" ? "Failed" : step.status;
  return (
    <div className="space-y-3 p-4">
      <div className={`text-sm font-medium ${step.status === "failed" ? "text-danger" : step.status === "success" ? "text-ok" : "text-muted"}`}>
        {label}
        {step.durationMs != null ? <span className="font-normal text-muted"> · {fmtDuration(step.durationMs)}</span> : null}
      </div>
      <StepEvidence step={step} />
      <Link href={`/runs/${runId}`} className="inline-block text-xs text-accent hover:underline">
        Open the whole run
      </Link>
    </div>
  );
}

/** The new lines of `now` against `before`: a line counts as new when `before` does not have it (as many times). */
export function newLines(before: string | undefined, now: string): Set<number> {
  const out = new Set<number>();
  if (before === undefined) {
    now.split("\n").forEach((_, i) => out.add(i));
    return out;
  }
  const have = new Map<string, number>();
  for (const l of before.split("\n")) have.set(l, (have.get(l) ?? 0) + 1);
  now.split("\n").forEach((l, i) => {
    const n = have.get(l) ?? 0;
    if (n > 0) have.set(l, n - 1);
    else if (l.trim()) out.add(i);
  });
  return out;
}

const WORKFLOW_FILE = "workflow.json";

type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: string[] };

/** Paths → a folder tree, folders first, each level sorted; workflow.json leads the root. */
function treeOf(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let at = root;
    parts.slice(0, -1).forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let d = at.dirs.find((x) => x.path === path);
      if (!d) at.dirs.push((d = { name: part, path, dirs: [], files: [] }));
      at = d;
    });
    at.files.push(p);
  }
  const sort = (d: TreeDir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => (a === WORKFLOW_FILE ? -1 : b === WORKFLOW_FILE ? 1 : a.localeCompare(b)));
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/** A file's glyph, by type — the cue a code editor's explorer gives. */
function FileGlyph({ path }: { path: string }) {
  const ext = (path.includes(".") ? path.split(".").pop() : "")!.toLowerCase();
  if (ext === "json") return <span className="pis-glyph json">{"{}"}</span>;
  if (ext === "py") return <span className="pis-glyph py">py</span>;
  const kind = GLYPHS[ext];
  return kind ? <span className={`pis-glyph ${kind[1]}`}>{kind[0]}</span> : <span className="pis-glyph">·</span>;
}

/** Extension → [short label, colour class]. Anything else is a plain dot. */
const GLYPHS: Record<string, [string, string]> = {
  png: ["img", "img"], jpg: ["img", "img"], jpeg: ["img", "img"], gif: ["img", "img"], webp: ["img", "img"], svg: ["img", "img"],
  pdf: ["pdf", "pdf"],
  xlsx: ["xls", "sheet"], xls: ["xls", "sheet"], csv: ["csv", "sheet"],
  docx: ["doc", "doc"], doc: ["doc", "doc"],
  txt: ["txt", ""], md: ["md", "md"],
  html: ["htm", "web"], htm: ["htm", "web"], css: ["css", "web"], scss: ["css", "web"],
  js: ["js", "code"], mjs: ["js", "code"], cjs: ["js", "code"], jsx: ["jsx", "code"], ts: ["ts", "code"], tsx: ["tsx", "code"],
  sh: ["sh", ""], sql: ["sql", "code"], yaml: ["yml", ""], yml: ["yml", ""], xml: ["xml", ""],
};

const GROUPS = [
  ["workflow", "Workflow"],
  ["forge", "Made by Forge"],
  ["you", "Uploaded by you"],
] as const;

function FilesView({
  path,
  onPath,
  onClose,
  expanded,
  onExpand,
  embedded = false,
  workflow,
  files,
  baseFiles,
  live,
  chatFiles,
  chatFileHref,
  onRemoveChatFile,
  storage,
}: {
  path?: string;
  onPath: (p: string) => void;
  onClose: () => void;
  expanded: boolean;
  onExpand?: () => void;
  embedded?: boolean;
  workflow: PiWorkflow;
  files: Record<string, string>;
  baseFiles: Record<string, string> | null;
  live: boolean;
  chatFiles: ChatFile[];
  chatFileHref: ((name: string) => string) | null;
  onRemoveChatFile?: (name: string) => Promise<void>;
  storage: PiStorage | null;
}) {
  // Removing takes two clicks: the bin, then "Remove?" within a few seconds.
  const [arming, setArming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(null), 4000);
    return () => clearTimeout(t);
  }, [arming]);
  const remove = async (name: string) => {
    if (!onRemoveChatFile) return;
    setRemoving(name);
    setRemoveError(null);
    try {
      await onRemoveChatFile(name);
    } catch (e) {
      setRemoveError(errorText(e));
    } finally {
      setRemoving(null);
      setArming(null);
    }
  };
  const all = useMemo<Record<string, string>>(() => ({ [WORKFLOW_FILE]: JSON.stringify(workflow, null, 2), ...files }), [workflow, files]);
  const paths = Object.keys(all);
  const state = (p: string): "A" | "M" | null => (baseFiles == null || baseFiles[p] === all[p] ? null : p in baseFiles ? "M" : "A");
  const removed = baseFiles ? Object.keys(baseFiles).filter((p) => !(p in all)) : [];
  const ordered = (function walk(d: TreeDir): string[] {
    return [...d.files, ...d.dirs.flatMap(walk)];
  })(treeOf(paths));
  // A chat with no workflow (Forge Agent's usual case) has nothing to show under Workflow: the section is left out.
  const hasWorkflow = (workflow.steps?.length ?? 0) > 0 || Object.keys(files).length > 0;
  const chatName = path?.startsWith(CHAT_FILE) ? path.slice(CHAT_FILE.length) : null;
  // A chat file opens only when the person picked one.
  const previewing = chatName != null && chatFiles.some((f) => f.name === chatName) ? chatName : null;
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [view, setView] = useState<FileView>("page");
  const [full, setFull] = useState(false);
  useEffect(() => setView("page"), [previewing]);
  const previewFile = previewing ? chatFiles.find((f) => f.name === previewing) : undefined;
  const viewLabel = previewing ? renderedViewLabel(previewing) : null;
  const current = path && path in all ? path : (ordered.find((p) => state(p)) ?? ordered[0]!);
  // A workflow file is open when picked; with room for both columns the first one is open by default.
  const openWf = previewing ? null : hasWorkflow && ((path && path in all) || expanded) ? current : null;
  const detail = previewing != null || openWf != null;
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const body = all[current] ?? "";
  const fresh = useMemo(() => (baseFiles ? newLines(baseFiles[current], body) : new Set<number>()), [baseFiles, current, body]);
  const nChanged = paths.filter((p) => state(p)).length;
  const tree = treeOf(paths);
  const slot = useContext(ToolsHeaderSlot);

  const sortedChat = (from: "you" | "forge") => chatFiles.filter((f) => f.from === from).sort((a, b) => a.name.localeCompare(b.name));
  const groups = GROUPS.map(([id, label]) => ({ id, label, n: id === "workflow" ? (hasWorkflow ? paths.length : 0) : sortedChat(id).length })).filter((g) => g.n > 0);
  const labelled = groups.length > 1;

  const stMark = (p: string) => {
    const st = state(p);
    return st ? (
      <span className={`pis-st ${st === "A" ? "a" : "m"}${live ? " live" : ""}`} title={st === "A" ? "Added since your last message" : "Changed since your last message"}>
        {st}
      </span>
    ) : null;
  };
  const chatActs = (f: ChatFile) => {
    const href = chatFileHref?.(f.name);
    return (
      <>
        {onRemoveChatFile ? (
          arming === f.name ? (
            <button
              type="button"
              disabled={removing === f.name}
              onClick={() => void remove(f.name)}
              className="h-6 shrink-0 rounded px-1.5 text-[11px] font-medium text-danger hover:bg-danger/10"
              aria-label={`Confirm removing ${f.name}`}
            >
              {removing === f.name ? "Removing…" : "Remove?"}
            </button>
          ) : (
            <button type="button" onClick={() => setArming(f.name)} className="pis-x shrink-0 !h-6 !w-6" title={`Remove ${f.name} from this chat`} aria-label={`Remove ${f.name}`}>
              <Trash className="h-3.5 w-3.5" />
            </button>
          )
        ) : null}
        {href ? (
          <a href={href} download={f.name} className="pis-x shrink-0 !h-6 !w-6" title={`Download ${f.name}`} aria-label={`Download ${f.name}`}>
            <Download className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </>
    );
  };
  const wfActs = (p: string) => (
    <button type="button" onClick={() => downloadText(p.split("/").pop()!, all[p] ?? "")} className="pis-x shrink-0 !h-6 !w-6" title={`Download ${p}`} aria-label={`Download ${p}`}>
      <Download className="h-3.5 w-3.5" />
    </button>
  );

  /** One file, as a list row or a grid card — the same open button and the same hover actions either way. */
  const entry = (o: { key: string; name: string; glyph: string; on: boolean; open: () => void; title: string; meta: string; mark?: ReactNode; acts: ReactNode; depth?: number; armed?: boolean }) =>
    layout === "grid" ? (
      <li key={o.key} className={`pis-xcard${o.on ? " on" : ""}${o.armed ? " armed" : ""}`}>
        <button type="button" className="pis-card" onClick={o.open} title={o.title}>
          <span className="pis-card-glyph" aria-hidden>
            <FileGlyph path={o.glyph} />
          </span>
          <span className="pis-card-name truncate">{o.name}</span>
          <span className="pis-card-meta">{o.meta}</span>
        </button>
        <span className="pis-acts">{o.acts}</span>
      </li>
    ) : (
      <div key={o.key} className={`pis-xrow${o.on ? " on" : ""}${o.armed ? " armed" : ""}`}>
        <button type="button" className="pis-xmain" style={{ paddingLeft: 10 + (o.depth ?? 0) * 14 }} onClick={o.open} title={o.title}>
          <FileGlyph path={o.glyph} />
          <span className="pis-xname">{o.name}</span>
          {o.mark}
          <span className="pis-xmeta">{o.meta}</span>
        </button>
        <span className="pis-acts">{o.acts}</span>
      </div>
    );
  const wfFile = (p: string, depth: number) => {
    const st = state(p);
    return entry({
      key: `wf:${p}`,
      name: p.split("/").pop()!,
      glyph: p,
      on: openWf === p,
      open: () => onPath(p),
      title: p,
      meta: st === "A" ? "new" : st === "M" ? "changed" : "Workflow",
      mark: stMark(p),
      acts: wfActs(p),
      depth,
    });
  };
  const wfDir = (d: TreeDir, depth: number): ReactNode => {
    const shut = closed.has(d.path);
    return (
      <div key={`d:${d.path}`}>
        <button
          type="button"
          className="pis-xdir"
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => setClosed((c) => (c.has(d.path) ? new Set([...c].filter((x) => x !== d.path)) : new Set(c).add(d.path)))}
          aria-expanded={!shut}
          title={d.path}
        >
          <ChevronRight className={`pis-chev h-3 w-3${shut ? "" : " open"}`} />
          <Folder s={14} />
          <span className="truncate">{d.name}</span>
        </button>
        {shut ? null : (
          <div>
            {d.dirs.map((x) => wfDir(x, depth + 1))}
            {d.files.map((p) => wfFile(p, depth + 1))}
          </div>
        )}
      </div>
    );
  };
  const chatEntry = (f: ChatFile) =>
    entry({
      key: `chat:${f.name}`,
      name: f.name,
      glyph: f.name,
      on: previewing === f.name,
      open: () => onPath(CHAT_FILE + f.name),
      title: `${f.name}\n${sizeOf(f.size)} · added by ${f.from === "forge" ? "Forge" : "you"}`,
      meta: `${sizeOf(f.size)} · ${f.from === "forge" ? "Forge" : "You"}`,
      acts: chatActs(f),
      armed: arming === f.name,
    });

  const section = (id: (typeof GROUPS)[number][0], label: string): ReactNode => {
    const items: ReactNode[] =
      id === "workflow"
        ? layout === "grid"
          ? ordered.map((p) => wfFile(p, 0))
          : [...tree.files.map((p) => wfFile(p, 0)), ...tree.dirs.map((d) => wfDir(d, 0))]
        : sortedChat(id).map(chatEntry);
    return (
      <div key={id}>
        {labelled ? <div className="pis-tree-label">{label}</div> : null}
        {layout === "grid" ? <ul className="pis-grid pis-xgrid" aria-label={labelled ? label : "All files in this chat"}>{items}</ul> : items}
        {id === "workflow" && removed.length ? <div className="pis-removed">Removed: {removed.map((p) => p.split("/").slice(-2).join("/")).join(", ")}</div> : null}
      </div>
    );
  };

  const level = storage ? storageLevel(storage) : "ok";
  const download = previewing ? (
    chatFileHref ? (
      <a href={chatFileHref(previewing)} download={previewing} className="pis-x" aria-label={`Download ${previewing}`} title={`Download ${previewing}`}>
        <Download className="h-3.5 w-3.5" />
      </a>
    ) : null
  ) : openWf ? (
    <button type="button" onClick={() => downloadText(current.split("/").pop()!, body)} className="pis-x" aria-label={`Download ${current}`} title={`Download ${current.split("/").pop()}`}>
      <Download className="h-3.5 w-3.5" />
    </button>
  ) : null;
  const viewSwitch = viewLabel ? <ViewToggle label={viewLabel} view={view} onView={setView} /> : null;
  const shownName = previewing ?? current;
  const content = (where: "pane" | "full") =>
    previewing ? (
      <ChatFilePreview key={`${where}:${previewing}`} name={previewing} href={chatFileHref?.(previewing) ?? null} view={view} />
    ) : (
      <pre className="pis-code" aria-label={where === "pane" ? `Contents of ${current}` : undefined}>
        {body.split("\n").map((l, i) =>
          onlyChanges && !fresh.has(i) ? null : (
            <div key={i} className={fresh.has(i) ? "add" : undefined}>
              <span className="ln">{i + 1}</span>
              {l || " "}
            </div>
          ),
        )}
      </pre>
    );

  const layoutSwitch = (
    <span className="pis-seg" role="group" aria-label="Layout">
      <button type="button" className={layout === "list" ? "on" : ""} aria-pressed={layout === "list"} aria-label="List view" title="List view" onClick={() => setLayout("list")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      </button>
      <button type="button" className={layout === "grid" ? "on" : ""} aria-pressed={layout === "grid"} aria-label="Grid view" title="Grid view" onClick={() => setLayout("grid")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </button>
    </span>
  );
  const own = embedded && slot !== undefined; // the tools drawer's header carries expand and close
  const controls = (
    <>
      {layoutSwitch}
      {viewSwitch}
      {openWf && fresh.size ? (
        <label className="mx-2 flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
          <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />
          Only new lines
        </label>
      ) : null}
      {download}
      {detail ? (
        <button type="button" onClick={() => setFull(true)} className="pis-x" aria-label="Full screen preview" title="Full screen preview">
          <Expand className="h-4 w-4" />
        </button>
      ) : null}
      {onExpand && !embedded ? (
        <button type="button" onClick={onExpand} className="pis-x" aria-label={expanded ? "Shrink tools" : "Give tools the whole width"} title={expanded ? "Shrink" : "Full width"}>
          {expanded ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      ) : null}
      {embedded ? null : (
        <>
          <span className="pis-sep" aria-hidden />
          <button type="button" onClick={onClose} className="pis-x" aria-label="Close" title="Close (Esc)">
            <Close className="h-4 w-4" />
          </button>
        </>
      )}
    </>
  );
  // ONE header: inside the tools drawer the controls join the drawer's tab strip; on their own they get a bar.
  const header = own ? (
    slot ? createPortal(controls, slot) : null
  ) : (
    <div className="pis-bar">
      <span className="text-[13px] font-semibold text-text">Files</span>
      <span className="min-w-0 truncate text-[11.5px] text-dim" title={live ? "Forge is writing" : undefined}>
        {hasWorkflow && nChanged ? `${nChanged} changed${live ? " · writing" : ""}` : countOf(chatFiles.length + (hasWorkflow ? paths.length : 0))}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">{controls}</span>
    </div>
  );

  const crumbs = path ? shownName.split("/") : [];
  const list = (
    <nav className="pis-list" aria-label="Files">
      <div className="pis-tree-scroll">
        {removeError ? (
          <p role="alert" className="px-2.5 py-1 text-[11px] text-danger">
            {removeError}
          </p>
        ) : null}
        {groups.length ? (
          groups.map((g) => section(g.id, g.label))
        ) : (
          <p className="px-6 py-10 text-center text-[12.5px] text-dim">No files yet — files Forge makes or you upload show up here.</p>
        )}
      </div>
      {storage ? (
        <div className="pis-foot" title="Everything in this conversation's folder, including Forge's own working files">
          <span className={level === "ok" ? "text-dim" : level === "full" ? "text-danger" : "text-warn"}>
            {mbOf(storage.bytes)} of {mbOf(storage.limit)} used by this chat
          </span>
          <span className="pis-meter" aria-hidden>
            <i className={level} style={{ width: `${Math.min(100, Math.max(1, (storage.bytes / Math.max(1, storage.limit)) * 100))}%` }} />
          </span>
        </div>
      ) : null}
    </nav>
  );
  const pane = detail ? (
    <div className="pis-code-wrap">
      <div className="pis-crumbs">
        {expanded ? null : (
          <button type="button" className="pis-x !h-6 !w-6" aria-label="Back to files" title="Back to files" onClick={() => onPath("")}>
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <FileGlyph path={shownName} />
        <span className="pis-name min-w-0" title={shownName}>
          {(previewing ? [previewing] : crumbs.length ? crumbs : current.split("/")).map((c, i, a) => (
            <span key={i} className={`truncate ${i === a.length - 1 ? "text-text" : "text-dim"}`}>
              {c}
              {i < a.length - 1 ? " /" : ""}
            </span>
          ))}
        </span>
        {previewFile ? <span className="pis-meta">{sizeOf(previewFile.size)} · {previewFile.from === "forge" ? "by Forge" : "yours"}</span> : null}
      </div>
      {content("pane")}
    </div>
  ) : null;

  return (
    <>
      {header}
      <div className={`pis-xp${detail ? (expanded ? " split" : " swap") : ""}`}>
        {list}
        {pane}
      </div>
      {full && detail ? (
        <FullScreen name={shownName} onExit={() => setFull(false)} actions={<>{viewSwitch}{download}</>}>
          {content("full")}
        </FullScreen>
      ) : null}
    </>
  );
}

/**
 * The open file's name, as the way to the chat's other files: a menu of every file, Forge's first, with its size, a
 * download and (two clicks) remove, and how full the conversation's folder is at the foot. Esc or a click outside
 * closes the menu and only the menu.
 */
function FilePicker({
  files,
  current,
  onPick,
  storage,
  hrefOf,
  onRemove,
  removing,
  error,
}: {
  files: ChatFile[];
  current: string | null;
  onPick: (name: string) => void;
  storage: PiStorage | null;
  hrefOf: ((name: string) => string) | null;
  onRemove?: (name: string) => Promise<void>;
  removing: string | null;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [arming, setArming] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(null), 4000);
    return () => clearTimeout(t);
  }, [arming]);
  const now = files.find((f) => f.name === current);
  const ordered = [...files.filter((f) => f.from === "forge"), ...files.filter((f) => f.from !== "forge")];
  return (
    <div ref={box} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pis-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        title={files.length > 1 ? "Switch file" : current ?? undefined}
      >
        {current ? <FileGlyph path={current} /> : null}
        <span className="truncate">{current ?? "Choose a file"}</span>
        {now ? <span className="pis-meta">{sizeOf(now.size)}</span> : null}
        {files.length > 1 ? <span className="pis-count">{files.length}</span> : null}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-dim" />
      </button>
      {open ? (
        <div className="pis-menu" role="menu" aria-label="Files in this chat">
          {error ? (
            <p role="alert" className="px-3 py-1.5 text-[11px] text-danger">
              {error}
            </p>
          ) : null}
          {ordered.map((f) => {
            const href = hrefOf?.(f.name);
            return (
              <div key={f.name} className={`pis-mrow${f.name === current ? " on" : ""}`}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onPick(f.name);
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <FileGlyph path={f.name} />
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto shrink-0 pl-3 text-[11px] text-dim">
                    {sizeOf(f.size)} · {f.from === "forge" ? "by Forge" : "yours"}
                  </span>
                </button>
                <span className="flex shrink-0 items-center">
                  {href ? (
                    <a href={href} download={f.name} className="pis-x !h-6 !w-6" aria-label={`Download ${f.name}`} title={`Download ${f.name}`}>
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                  {onRemove ? (
                    arming === f.name ? (
                      <button
                        type="button"
                        disabled={removing === f.name}
                        onClick={() => void onRemove(f.name).finally(() => setArming(null))}
                        className="h-6 rounded px-1.5 text-[11px] font-medium text-danger hover:bg-danger/10"
                        aria-label={`Confirm removing ${f.name}`}
                      >
                        {removing === f.name ? "Removing…" : "Remove?"}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setArming(f.name)} className="pis-x !h-6 !w-6" aria-label={`Remove ${f.name}`} title={`Remove ${f.name} from this chat`}>
                        <Trash className="h-3.5 w-3.5" />
                      </button>
                    )
                  ) : null}
                </span>
              </div>
            );
          })}
          {storage ? (
            <div
              className={`border-t border-line px-3 py-2 text-[11px] ${storageLevel(storage) === "ok" ? "text-dim" : storageLevel(storage) === "full" ? "text-danger" : "text-warn"}`}
              title="Everything in this conversation's folder, including Forge's own working files"
            >
              {mbOf(storage.bytes)} of {mbOf(storage.limit)} used by this chat
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The open file over the whole window, for a proper look at a page or a document. Esc leaves it (and only it: the
 * Files pane under it stays open). Rendered into the body so no column or pane clips it.
 */
function FullScreen({ name, onExit, actions, children }: { name: string; onExit: () => void; actions: ReactNode; children: ReactNode }) {
  useEffect(() => {
    // Capture on window runs before the pane's own Esc handler on document, so Esc closes this alone.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onExit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onExit]);
  // Drive-style: the app stays visible, dimmed, behind the file; a click on the dark backdrop leaves, like Esc.
  return createPortal(
    <div
      className="pis-full"
      role="dialog"
      aria-modal="true"
      aria-label={`${name}, full screen`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onExit();
      }}
    >
      <div className="pis-bar">
        <span className="pis-name">
          <FileGlyph path={name} />
          <span className="truncate text-text">{name}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {actions}
          <span className="pis-sep" aria-hidden />
          <button type="button" onClick={onExit} className="pis-x" aria-label="Leave full screen" title="Leave full screen (Esc)">
            <Collapse className="h-4 w-4" />
          </button>
        </span>
      </div>
      <div className="pis-full-card">{children}</div>
    </div>,
    document.body,
  );
}

/** Save a file Forge wrote (text held in the page) as a download. */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const countOf = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const mbOf = (b: number) => `${Math.max(1, Math.round(b / 1024 / 1024))} MB`;
/** A file's size, short: "820 KB", "12 MB". */
function sizeOf(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 KB";
  return b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
