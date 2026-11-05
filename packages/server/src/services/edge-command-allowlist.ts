/**
 * Harmless edge `run_command` allowlist + trust-rule evaluation (personal thin).
 *
 * Fail closed: anything with shell metacharacters, paths-as-bins, or unknown argv is NOT allowlisted.
 * The agent runs with `shell: true`, so substring matches are unsafe — full-token rules only.
 *
 * Permission model (simple):
 * 1. Built-in harmless run_command / read_path → auto
 * 2. Persisted deny (command family or argv prefix) → ask
 * 3. Persisted allow — **command family** (`docker`, `npm`, …) or exact argv prefix → auto
 * 4. Folder grant ("Allow this folder" = path_read + path_write on one prefix):
 *    - write_path under the prefix → auto
 *    - run_command whose *shell-surface* paths (args + redirects, never quoted payloads)
 *      all sit under a grant, and the shell surface has no curl/ssh/`$`/pipe-to-shell → auto
 * 5. Else → ask
 *
 * Forge often wraps work as `zsh -lc '…'`. Unwrap that before path/family checks — otherwise a
 * folder grant never sees `cd /granted && docker …` inside the quotes.
 *
 * Quoted string literals are file *contents* (printf '…html…'), not shell paths — scanning them
 * was treating `</body>` / `src="/orbit.html"` as filesystem paths outside the grant.
 */
import type { EdgeJobKind } from "./edge-device.service.js";

const MAX_LEN = 200;
/** Tokens may only be these characters (no quotes, pipes, dollars, redirects, …). `~` allowed for home paths. */
const SAFE_TOKEN = /^[A-Za-z0-9._/@:+%~-]+$/;
const SAFE_ECHO_ARG = /^[A-Za-z0-9._:@/+%-]+$/;
/** Path args for ls: same safe charset, no `..` segments. */
const SAFE_PATH_ARG = /^[A-Za-z0-9._/@:+%~-]+$/;

const NO_ARGS = new Set(["whoami", "pwd", "date", "id", "true", "false", "arch", "sw_vers"]);

const UNAME_FLAGS = new Set(["-a", "-s", "-n", "-r", "-m", "-p", "-v"]);
const HOSTNAME_FLAGS = new Set(["-s", "-f"]);
/** Letter-class short flags for ls (no long options, no `--`). */
const LS_FLAG = /^-[1AacdFfhiklnqRrSstu]+$/;

export type EdgeTrustEffect = "allow" | "deny";
export type EdgeTrustScope = "command" | "path_read" | "path_write";

export type EdgeTrustRule = {
  effect: EdgeTrustEffect;
  scope: EdgeTrustScope;
  pattern: string;
};

function tokenize(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_LEN) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.some((p) => !SAFE_TOKEN.test(p))) return null;
  // Basename only — refuse /bin/sh, ./whoami, ../x
  if (parts[0]!.includes("/")) return null;
  return parts;
}

/** Normalized argv string for trust patterns (single spaces). Null if unsafe to tokenize. */
export function normalizeCommandPattern(command: string): string | null {
  const argv = tokenize(command);
  if (!argv?.length) return null;
  return argv.join(" ");
}

function hasDotDot(path: string): boolean {
  return path.split("/").includes("..");
}

function isSafePathArg(p: string): boolean {
  return SAFE_PATH_ARG.test(p) && !hasDotDot(p) && p !== "--";
}

/**
 * True when this exact command may run without Needs-you / in-chat approval (built-in only).
 * Conservative: whoami, uname, hostname, pwd, date, id, true/false, arch, sw_vers, echo, ls (safe).
 */
export function isHarmlessEdgeRunCommand(command: string): boolean {
  const argv = tokenize(command);
  if (!argv?.length) return false;
  const bin = argv[0]!;
  const args = argv.slice(1);

  if (NO_ARGS.has(bin)) return args.length === 0;

  if (bin === "hostname") {
    if (args.length === 0) return true;
    return args.length === 1 && HOSTNAME_FLAGS.has(args[0]!);
  }

  if (bin === "uname") {
    if (args.length === 0) return true;
    return args.every((a) => UNAME_FLAGS.has(a) || (/^-[asnrpmv]+$/.test(a) && a.length > 1));
  }

  if (bin === "echo") {
    return args.every((a) => SAFE_ECHO_ARG.test(a) && !a.startsWith("-"));
  }

  if (bin === "ls") {
    // Flags must be short letter-class; path args safe tokens, no `..`.
    for (const a of args) {
      if (a.startsWith("-")) {
        if (a === "-" || a.startsWith("--") || !LS_FLAG.test(a)) return false;
      } else if (!isSafePathArg(a)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/** Path tokens from an `ls` argv (non-flag args). */
export function lsPathArgs(command: string): string[] {
  const argv = tokenize(command);
  if (!argv || argv[0] !== "ls") return [];
  return argv.slice(1).filter((a) => !a.startsWith("-"));
}

/**
 * Path-like argv tokens: absolute, home (`~`), or containing `/`. Flags and bare words are not paths.
 * Used for directory grants and folder inference (not for builtin ls path extraction).
 * Simple commands only (no `&&`); use `pathLikeArgsLoose` for shell compounds under a folder grant.
 */
export function pathLikeArgs(command: string): string[] {
  const argv = tokenize(command);
  if (!argv?.length) return [];
  return argv.slice(1).filter((a) => isPathLikeToken(a));
}

/** Longer bound for directory-scoped compounds (Forge often packs many `printf … > file` under one grant). */
const DIR_CMD_MAX = 24_000;

/** Expansion / network still refused under a folder grant — redirects and quotes are allowed. */
const DIR_EXPANSION_REFUSE = /[`$]|\$\(|\$\{/;
const DIR_FORBIDDEN_BIN = /\b(curl|wget|ssh|scp|nc|ncat|telnet)\b/i;
const DIR_PIPE_SHELL = /\|\s*(bash|sh|zsh|dash)\b/;

function isPathLikeToken(a: string): boolean {
  if (a.startsWith("-")) return false;
  if (!isSafePathArg(a)) return false;
  // URLs are not filesystem paths (curl https://… must stay gated).
  if (/^[a-z][a-z0-9+.-]*:/i.test(a)) return false;
  return a.startsWith("/") || a.startsWith("~") || a.includes("/");
}

/**
 * Peel `zsh -lc '…'` / `bash -c "…"` wrappers Forge uses so path + family checks see the real work.
 * One level only; returns null when the command is not that shape.
 */
export function unwrapShellWrapper(command: string): string | null {
  const t = command.trim();
  const m = /^(?:zsh|bash|sh|dash)\s+-l?c\s+([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const rest = m[1]!.trim();
  if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) return rest.slice(1, -1);
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
    // Minimal unescape for \" and \\ inside double quotes.
    return rest.slice(1, -1).replace(/\\([\\"])/g, "$1");
  }
  return null;
}

/** Command text used for trust checks — unwrap login-shell wrappers when present. */
export function effectiveEdgeCommand(command: string): string {
  const trimmed = command.trim();
  return unwrapShellWrapper(trimmed) ?? trimmed;
}

/**
 * Primary tool family for "Allow always" — e.g. `docker compose up` → `docker`, `cd X && npm i` → `npm`.
 * Skips `cd`. Returns null when nothing safe can be named.
 */
export function commandFamily(command: string): string | null {
  const cmd = effectiveEdgeCommand(command);
  if (!cmd || cmd.length > DIR_CMD_MAX) return null;
  const segments = cmd.split(/\s*(?:&&|;|\|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const parts = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < parts.length && /^\w+=/.test(parts[i]!)) i++;
    let bin = parts[i];
    if (!bin) continue;
    if (bin.includes("/")) bin = bin.slice(bin.lastIndexOf("/") + 1);
    const lower = bin.toLowerCase();
    if (lower === "cd" || lower === "true" || lower === "false" || lower === ":" || lower === "builtin") continue;
    if (!/^[a-zA-Z][a-zA-Z0-9._+-]*$/.test(bin)) return null;
    return lower;
  }
  return null;
}

/** Pattern persisted for Allow always / Deny always — prefer family (`docker`) over fragile full argv. */
export function commandTrustPattern(command: string): string | null {
  const family = commandFamily(command);
  if (family) return family;
  return normalizeCommandPattern(effectiveEdgeCommand(command));
}

/**
 * Shell surface of a command: quoted literals replaced with spaces.
 * Folder grants judge only this surface — `printf '%s' '<html>…</body>' > /granted/f`
 * must not treat `/body` inside the payload as a filesystem path.
 */
export function shellSurface(command: string): string {
  let out = "";
  let i = 0;
  const s = command;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      out += " ";
      i++;
      while (i < s.length && s[i] !== "'") {
        out += " ";
        i++;
      }
      if (i < s.length) {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === '"') {
      out += " ";
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i++;
      }
      if (i < s.length) {
        out += " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Absolute / home paths on the shell surface (args + redirect targets), never inside quotes.
 * Used for folder grants — Forge writes files with `printf … > /granted/path`.
 */
export function pathsInCommand(command: string): string[] {
  const trimmed = effectiveEdgeCommand(command);
  if (!trimmed || trimmed.length > DIR_CMD_MAX) return [];
  const surface = shellSurface(trimmed);
  const pathRe = /(?:^|[\s=(<>])((?:\/|~\/)[A-Za-z0-9._/@:+%~-]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(surface)) !== null) {
    const p = m[1]!.replace(/\/+$/, "") || m[1]!;
    if (!hasDotDot(p) && isSafePathArg(p)) out.push(p);
  }
  return out;
}

/**
 * Path tokens from a command that may use `&&` / `;` / `|` (Forge's usual `cd DIR && npm …` shape).
 * Returns [] if the shell surface has expansion we refuse, or tokens we cannot parse safely.
 */
export function pathLikeArgsLoose(command: string): string[] {
  const trimmed = effectiveEdgeCommand(command);
  if (!trimmed || trimmed.length > DIR_CMD_MAX) return [];
  const surface = shellSurface(trimmed);
  if (DIR_EXPANSION_REFUSE.test(surface)) return [];
  const fromScan = pathsInCommand(trimmed);
  if (fromScan.length) return fromScan;
  const segments = surface.split(/\s*(?:&&|;|\|\||\|)\s*/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const seg of segments) {
    const parts = seg.split(/\s+/).filter(Boolean);
    if (!parts.length || parts.some((p) => !SAFE_TOKEN.test(p))) return [];
    for (const a of parts.slice(1)) {
      if (isPathLikeToken(a)) out.push(a);
    }
  }
  return out;
}

/**
 * Under a folder grant: every shell-surface filesystem path sits under the grant.
 * Allows `cd GRANT && npm install`, `printf … > GRANT/file` — still refuses curl/wget/ssh
 * and shell expansion (`$`, backticks) on the shell surface (not inside quoted payloads).
 */
export function directoryShellAllowed(command: string, rules: EdgeTrustRule[]): boolean {
  if (!folderGrants(rules).length) return false;
  const trimmed = effectiveEdgeCommand(command);
  if (!trimmed || trimmed.length > DIR_CMD_MAX) return false;
  const surface = shellSurface(trimmed);
  if (DIR_EXPANSION_REFUSE.test(surface)) return false;
  if (DIR_FORBIDDEN_BIN.test(surface)) return false;
  if (DIR_PIPE_SHELL.test(surface)) return false;
  const allPaths = pathsInCommand(trimmed);
  if (!allPaths.length) return false;
  return pathsUnderFolderGrants(allPaths, rules);
}

/**
 * Folder to grant for a path token: file-like basenames (contain a `.`) map to their parent;
 * otherwise the path itself (already a directory).
 */
export function directoryOfPath(path: string): string {
  const p = path.replace(/\/+$/, "") || path;
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const looksFile = base.includes(".") && !base.startsWith(".");
  if (!looksFile) return p;
  if (slash < 0) return p;
  if (slash === 0) return "/";
  return p.slice(0, slash) || p;
}

/** Directory prefix to persist for "Allow this folder" (literal token the person approved). */
export function folderPatternFromJob(kind: EdgeJobKind, payload: Record<string, unknown>): string | null {
  if (kind === "read_path" || kind === "write_path") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!path || !isSafePathArg(path)) return null;
    return directoryOfPath(path);
  }
  if (kind === "run_command") {
    const cmd = effectiveEdgeCommand(typeof payload.command === "string" ? payload.command : "");
    // Prefer path-like args (python ~/ws/a.py, or `cd DIR && npm …`); fall back to ls paths.
    const paths = pathLikeArgs(cmd);
    const loose = paths.length ? paths : pathLikeArgsLoose(cmd);
    const fromLs = loose.length ? loose : lsPathArgs(cmd).filter((p) => isSafePathArg(p));
    if (!fromLs.length) return null;
    const roots = [...new Set(fromLs.map(directoryOfPath))];
    if (roots.length !== 1) return null;
    return roots[0]!.replace(/\/+$/, "") || roots[0]!;
  }
  return null;
}

function commandPrefixMatch(normalizedCmd: string, pattern: string): boolean {
  const cmdTok = normalizedCmd.split(/\s+/);
  const patTok = pattern.trim().split(/\s+/).filter(Boolean);
  if (!patTok.length || patTok.length > cmdTok.length) return false;
  return patTok.every((t, i) => t === cmdTok[i]);
}

/**
 * True when every non-`cd` payload binary is this family — so `docker …; curl …` does not ride a docker allow.
 */
function commandFamilyCovers(cmd: string, family: string): boolean {
  const want = family.toLowerCase();
  const body = effectiveEdgeCommand(cmd);
  let saw = false;
  for (const seg of body.split(/\s*(?:&&|;|\|\|)\s*/).map((s) => s.trim()).filter(Boolean)) {
    const parts = seg.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < parts.length && /^\w+=/.test(parts[i]!)) i++;
    let bin = parts[i];
    if (!bin) continue;
    if (bin.includes("/")) bin = bin.slice(bin.lastIndexOf("/") + 1);
    const lower = bin.toLowerCase();
    if (lower === "cd" || lower === "true" || lower === "false" || lower === ":") continue;
    if (!/^[a-zA-Z][a-zA-Z0-9._+-]*$/.test(bin)) return false;
    if (lower !== want) return false;
    saw = true;
  }
  return saw;
}

/** Allow/deny rule match: single-token patterns are families (`docker`); multi-token are argv prefixes. */
function commandRuleMatches(cmd: string, pattern: string): boolean {
  const pat = pattern.trim();
  if (!pat) return false;
  if (!/\s/.test(pat)) return commandFamilyCovers(cmd, pat);
  const normalized = normalizeCommandPattern(effectiveEdgeCommand(cmd));
  if (!normalized) return false;
  return commandPrefixMatch(normalized, pat);
}

export function pathUnderGrant(path: string, pattern: string): boolean {
  const p = path.replace(/\/+$/, "");
  const g = pattern.replace(/\/+$/, "");
  if (!g) return false;
  return p === g || p.startsWith(`${g}/`);
}

/** Longest common directory prefix of several folder paths (for one dock “Allow this folder”). */
export function commonDirectory(folders: string[]): string | null {
  const cleaned = folders.map((f) => f.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!cleaned.length) return null;
  const parts = cleaned.map((f) => f.split("/"));
  let i = 0;
  while (parts.every((p) => p[i] !== undefined && p[i] === parts[0]![i])) i++;
  if (i === 0) return null;
  const joined = parts[0]!.slice(0, i).join("/");
  return joined || "/";
}

/** Whether this edge job’s path(s) sit under a granted folder. */
export function edgeJobUnderFolder(kind: EdgeJobKind, payload: Record<string, unknown>, folder: string): boolean {
  const g = folder.replace(/\/+$/, "");
  if (!g) return false;
  if (kind === "read_path" || kind === "write_path") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    return !!path && pathUnderGrant(path, g);
  }
  if (kind === "run_command") {
    const cmd = effectiveEdgeCommand(typeof payload.command === "string" ? payload.command : "");
    const loose = pathLikeArgsLoose(cmd);
    if (!loose.length) return false;
    return loose.every((p) => pathUnderGrant(p, g));
  }
  return false;
}

function folderGrants(rules: EdgeTrustRule[]): EdgeTrustRule[] {
  return rules.filter((r) => r.effect === "allow" && (r.scope === "path_read" || r.scope === "path_write"));
}

function pathsUnderFolderGrants(paths: string[], rules: EdgeTrustRule[]): boolean {
  const grants = folderGrants(rules);
  if (!paths.length || !grants.length) return false;
  return paths.every((p) => grants.some((g) => pathUnderGrant(p, g.pattern)));
}

/**
 * Sync built-in check only (no trust rules). Prefer `evaluateEdgeJobApproval` when rules are available.
 */
export function edgeJobNeedsApproval(kind: EdgeJobKind, payload: Record<string, unknown>): boolean {
  return evaluateEdgeJobApproval(kind, payload, []).needsApproval;
}

/**
 * Evaluation order:
 * 1. Built-in refuse tokenize / unsafe → needs approval (or write always unless path_write allow)
 * 2. Persisted deny (command family / argv prefix) → needs approval
 * 3. Built-in allow OR persisted allow (family or argv) → auto-approve
 * 4. ls under path_read, write_path under path_write, or path-bound run_command under folder grants → auto-approve
 * 5. Else → awaiting approval
 */
export function evaluateEdgeJobApproval(
  kind: EdgeJobKind,
  payload: Record<string, unknown>,
  rules: EdgeTrustRule[],
): { needsApproval: boolean; reason: string } {
  if (kind === "write_path") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    const denied = rules.some((r) => r.effect === "deny" && r.scope === "command");
    // Deny-command rules don't apply to write_path; path_write deny if we ever add it — skip.
    void denied;
    const allowWrite = rules.some(
      (r) => r.effect === "allow" && r.scope === "path_write" && path && pathUnderGrant(path, r.pattern),
    );
    if (allowWrite) return { needsApproval: false, reason: "path_write_grant" };
    return { needsApproval: true, reason: "write_path" };
  }

  if (kind === "read_path") {
    // Built-in: read_path stays open (existing behaviour). path_read grants are for ls under a folder.
    return { needsApproval: false, reason: "read_path" };
  }

  if (kind === "run_command") {
    const raw = typeof payload.command === "string" ? payload.command : "";
    const cmd = effectiveEdgeCommand(raw);
    const normalized = normalizeCommandPattern(cmd);

    // Persisted deny (family or argv prefix) before any allow — including wrapped/unnormalized forms.
    if (rules.some((r) => r.effect === "deny" && r.scope === "command" && commandRuleMatches(cmd, r.pattern))) {
      return { needsApproval: true, reason: "deny_command" };
    }

    if (isHarmlessEdgeRunCommand(cmd)) {
      return { needsApproval: false, reason: "builtin_allow" };
    }

    if (rules.some((r) => r.effect === "allow" && r.scope === "command" && commandRuleMatches(cmd, r.pattern))) {
      return { needsApproval: false, reason: "allow_command" };
    }

    // Shell compounds / wrappers fail strict tokenize — still honour a folder grant for safe bins.
    if (!normalized) {
      if (directoryShellAllowed(cmd, rules)) return { needsApproval: false, reason: "directory_grant" };
      return { needsApproval: true, reason: "unsafe_or_empty" };
    }

    // ls under a path_read grant (every path arg must be under some grant).
    const argv = tokenize(cmd);
    if (argv?.[0] === "ls") {
      const paths = lsPathArgs(cmd);
      const grants = rules.filter((r) => r.effect === "allow" && r.scope === "path_read");
      if (paths.length > 0 && grants.length > 0 && paths.every((p) => grants.some((g) => pathUnderGrant(p, g.pattern)))) {
        // Still require the ls form itself to be flag-safe (no injection via weird flags).
        if (isHarmlessEdgeRunCommand(cmd) || lsArgsLookSafe(argv)) {
          return { needsApproval: false, reason: "path_read_grant" };
        }
      }
    }

    // Path-bound command under a folder grant (path_read and/or path_write from "Allow this folder").
    // Requires at least one path-like arg; curl / bare npm without cd stay gated.
    // `ls` stays on the stricter path_read + flag-safe path above — do not rescue weird ls flags here.
    const pathArgs = argv?.[0] === "ls" ? [] : pathLikeArgs(cmd);
    if (pathArgs.length > 0 && pathsUnderFolderGrants(pathArgs, rules)) {
      return { needsApproval: false, reason: "directory_grant" };
    }
    if (argv?.[0] !== "ls" && directoryShellAllowed(cmd, rules)) {
      return { needsApproval: false, reason: "directory_grant" };
    }

    return { needsApproval: true, reason: "default" };
  }

  return { needsApproval: true, reason: "unknown_kind" };
}

function lsArgsLookSafe(argv: string[]): boolean {
  for (const a of argv.slice(1)) {
    if (a.startsWith("-")) {
      if (a === "-" || a.startsWith("--") || !LS_FLAG.test(a)) return false;
    } else if (!isSafePathArg(a)) {
      return false;
    }
  }
  return true;
}
