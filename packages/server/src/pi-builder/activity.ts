import { basename } from "node:path";
import type { PiActivity, PiActivityKind } from "./types.js";

export function kindOfTool(toolName: string): PiActivityKind {
  const n = toolName.toLowerCase();
  if (n === "read" || n === "read_file") return "read";
  if (n === "write" || n === "write_file") return "write";
  if (n === "edit" || n === "str_replace" || n === "apply_patch") return "edit";
  if (n === "bash" || n === "shell" || n === "run") return "bash";
  if (n === "grep" || n === "search" || n === "glob") return "grep";
  if (n.includes("think") || n === "reasoning") return "think";
  return "other";
}

function asRecord(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return args as Record<string, unknown>;
}

function pickPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const k of ["path", "file_path", "filePath", "file", "filename", "target", "target_file"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickCmd(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const k of ["command", "cmd", "script"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickPattern(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const k of ["pattern", "query", "glob", "include"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function shorten(s: string, n = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function displayPath(path: string): string {
  // Prefer a short relative-looking name for the closed accordion.
  const base = basename(path);
  if (path.includes("/") && path.length > 48) return shorten(path, 48);
  return path.length > 64 ? shorten(path, 64) : path || base;
}

/**
 * Subject line ONLY — the kind badge is rendered separately in the UI.
 * Never "Read (read)" / "Shell (bash)".
 */
export function titleForActivity(
  tool: string,
  kind: PiActivityKind,
  args: Record<string, unknown> | undefined,
): string {
  const path = pickPath(args);
  const cmd = pickCmd(args);
  const pattern = pickPattern(args);
  switch (kind) {
    case "read":
    case "write":
    case "edit":
      return path ? displayPath(path) : "…";
    case "bash":
      return cmd ? shorten(cmd, 72) : "…";
    case "grep":
      if (pattern && path) return `${shorten(pattern, 40)} in ${displayPath(path)}`;
      if (pattern) return shorten(pattern, 56);
      if (path) return displayPath(path);
      return "…";
    case "think":
      return "reasoning";
    default:
      if (path) return displayPath(path);
      if (cmd) return shorten(cmd, 72);
      return tool;
  }
}

export function detailForActivity(
  args: Record<string, unknown> | undefined,
  result?: unknown,
  isError?: boolean,
): string {
  const parts: string[] = [];
  const path = pickPath(args);
  const cmd = pickCmd(args);
  if (path) parts.push(path);
  if (cmd) parts.push(`$ ${cmd}`);
  if (args && !path && !cmd) {
    try {
      parts.push(shorten(JSON.stringify(args), 240));
    } catch {
      /* ignore */
    }
  }
  if (result !== undefined) {
    let body: string;
    if (typeof result === "string") body = result;
    else {
      try {
        body = JSON.stringify(result, null, 2);
      } catch {
        body = String(result);
      }
    }
    parts.push(isError ? `error:\n${shorten(body, 800)}` : shorten(body, 800));
  }
  return parts.join("\n") || "(no detail yet)";
}

export function startActivity(toolCallId: string, toolName: string, args: unknown): PiActivity {
  const a = asRecord(args);
  const kind = kindOfTool(toolName);
  return {
    id: toolCallId,
    tool: toolName,
    kind,
    title: titleForActivity(toolName, kind, a),
    detail: detailForActivity(a),
    status: "running",
    startedAt: new Date().toISOString(),
  };
}

export function updateActivity(prev: PiActivity, args: unknown, partialResult?: unknown): PiActivity {
  const a = asRecord(args);
  const title = titleForActivity(prev.tool, prev.kind, a);
  return {
    ...prev,
    // Keep previous concrete title if update still has no path/cmd
    title: title === "…" && prev.title !== "…" ? prev.title : title,
    detail: detailForActivity(a, partialResult),
  };
}

export function endActivity(
  prev: PiActivity,
  args: unknown,
  result: unknown,
  isError: boolean,
): PiActivity {
  const a = asRecord(args);
  const title = titleForActivity(prev.tool, prev.kind, a);
  return {
    ...prev,
    title: title === "…" && prev.title !== "…" ? prev.title : title,
    detail: detailForActivity(a, result, isError),
    status: isError ? "error" : "done",
    endedAt: new Date().toISOString(),
  };
}

export function textDeltaFromUpdate(ev: Record<string, unknown>): string | null {
  const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!ame) return null;
  if (ame.type === "text_delta" && typeof ame.delta === "string") return ame.delta;
  return null;
}

/**
 * The model's thinking, as Pi streams it (2026-10-29): `start` and `end` bound a block, `delta` is its text. Pi emits
 * these only when the provider returns READABLE reasoning (`reasoning_content` and the like). The luna models return
 * theirs encrypted, so a luna turn has none — and the chat shows none rather than inventing one.
 */
export function thinkingFromUpdate(ev: Record<string, unknown>): { kind: "start" } | { kind: "end" } | { kind: "delta"; text: string } | null {
  const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!ame) return null;
  if (ame.type === "thinking_start") return { kind: "start" };
  if (ame.type === "thinking_end") return { kind: "end" };
  if (ame.type === "thinking_delta" && typeof ame.delta === "string" && ame.delta) return { kind: "delta", text: ame.delta };
  return null;
}

export function assistantTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { content?: unknown };
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  const bits: string[] = [];
  for (const c of m.content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const t = (c as { text?: string }).text;
      if (typeof t === "string") bits.push(t);
    }
  }
  return bits.join("");
}
