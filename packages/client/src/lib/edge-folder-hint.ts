/**
 * Mirror of server `folderPatternFromJob` for the Edge Approve card — when to show "Allow this folder".
 * Keep charset/rules aligned with packages/server/src/services/edge-command-allowlist.ts.
 */

const SAFE_PATH = /^[A-Za-z0-9._/@:+%~-]+$/;
const DIR_CMD_MAX = 4000;

function hasDotDot(path: string): boolean {
  return path.split("/").includes("..");
}

function isSafePath(p: string): boolean {
  return SAFE_PATH.test(p) && !hasDotDot(p) && p !== "--";
}

function isPathLike(a: string): boolean {
  if (a.startsWith("-")) return false;
  if (!isSafePath(a)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(a)) return false;
  return a.startsWith("/") || a.startsWith("~") || a.includes("/");
}

function directoryOfPath(path: string): string {
  const p = path.replace(/\/+$/, "") || path;
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const looksFile = base.includes(".") && !base.startsWith(".");
  if (!looksFile) return p;
  if (slash < 0) return p;
  if (slash === 0) return "/";
  return p.slice(0, slash) || p;
}

/** Peel `zsh -lc '…'` so folder / family hints see the real work (mirrors server unwrapShellWrapper). */
export function unwrapShellWrapper(command: string): string | null {
  const t = command.trim();
  const m = /^(?:zsh|bash|sh|dash)\s+-l?c\s+([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const rest = m[1]!.trim();
  if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) return rest.slice(1, -1);
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
    return rest.slice(1, -1).replace(/\\([\\"])/g, "$1");
  }
  return null;
}

function effectiveCommand(command: string): string {
  const t = command.trim();
  return unwrapShellWrapper(t) ?? t;
}

/** Tool family for Allow always — `docker compose up` → `docker` (mirrors server commandFamily). */
export function commandFamily(command: string): string | null {
  const cmd = effectiveCommand(command);
  if (!cmd || cmd.length > DIR_CMD_MAX) return null;
  for (const seg of cmd.split(/\s*(?:&&|;|\|\|)\s*/).map((s) => s.trim()).filter(Boolean)) {
    const parts = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < parts.length && /^\w+=/.test(parts[i]!)) i++;
    let bin = parts[i];
    if (!bin) continue;
    if (bin.includes("/")) bin = bin.slice(bin.lastIndexOf("/") + 1);
    const lower = bin.toLowerCase();
    if (lower === "cd" || lower === "true" || lower === "false" || lower === ":") continue;
    if (!/^[a-zA-Z][a-zA-Z0-9._+-]*$/.test(bin)) return null;
    return lower;
  }
  return null;
}

function pathLikeFromCommand(cmd: string): string[] {
  const trimmed = effectiveCommand(cmd);
  if (!trimmed || trimmed.length > DIR_CMD_MAX) return [];
  if (/[`$]|\$\(|\$\{|\n|\r/.test(trimmed)) return [];
  if (/[<>]/.test(trimmed.replace(/2>&1/g, ""))) return [];
  // Simple tokenize first
  const simple = trimmed.split(/\s+/);
  if (simple.length && !simple[0]!.includes("/") && simple.every((p) => SAFE_PATH.test(p))) {
    const paths = simple.slice(1).filter(isPathLike);
    if (paths.length) return paths;
  }
  // Compounds: cd DIR && npm …
  const out: string[] = [];
  for (const seg of trimmed.split(/\s*(?:&&|;|\|\||\|)\s*/).map((s) => s.trim()).filter(Boolean)) {
    const parts = seg.split(/\s+/).filter(Boolean);
    if (!parts.length || parts.some((p) => !SAFE_PATH.test(p))) return [];
    for (const a of parts.slice(1)) {
      if (isPathLike(a)) out.push(a);
    }
  }
  return out;
}

/** Longest common directory of several folder hints (dock “Allow this folder”). */
export function commonEdgeFolder(folders: string[]): string | null {
  const cleaned = folders.map((f) => f.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!cleaned.length) return null;
  const parts = cleaned.map((f) => f.split("/"));
  let i = 0;
  while (parts.every((p) => p[i] !== undefined && p[i] === parts[0]![i])) i++;
  if (i === 0) return null;
  return parts[0]!.slice(0, i).join("/") || "/";
}

function shorten(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function basename(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) || p : p;
}

/**
 * One-liner for a settled edge job in the chat Actions density:
 * `mac · $ npm install` / `mac · Wrote package.json` / `mac · Read index.html`.
 */
export function edgeActionLine(
  deviceName: string,
  kind: string,
  params: Record<string, unknown>,
  max = 72,
): string {
  const device = deviceName.trim() || "computer";
  if (kind === "run_command") {
    const cmd = typeof params.command === "string" ? params.command.trim() : "";
    return `${device} · $ ${shorten(cmd || "command", max)}`;
  }
  const path = typeof params.path === "string" ? params.path.trim() : "";
  const file = path ? basename(path) : "file";
  if (kind === "write_path") return `${device} · Wrote ${shorten(file, max)}`;
  if (kind === "read_path") return `${device} · Read ${shorten(file, max)}`;
  return `${device} · ${shorten(path || kind, max)}`;
}

/** Folder the person would grant from this edge job, or null if none can be inferred. */
export function edgeFolderHint(kind: string, params: Record<string, unknown>): string | null {
  if (kind === "read_path" || kind === "write_path") {
    const path = typeof params.path === "string" ? params.path.trim() : "";
    if (!path || !isSafePath(path)) return null;
    return directoryOfPath(path);
  }
  if (kind !== "run_command") return null;
  const cmd = typeof params.command === "string" ? params.command.trim() : "";
  if (!cmd) return null;
  const pathArgs = pathLikeFromCommand(cmd);
  if (!pathArgs.length) return null;
  const roots = [...new Set(pathArgs.map(directoryOfPath))];
  if (roots.length !== 1) return null;
  return roots[0]!.replace(/\/+$/, "") || roots[0]!;
}
