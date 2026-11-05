/**
 * Harmless edge `run_command` allowlist + trust-rule evaluation (personal thin).
 *
 * Fail closed: anything with shell metacharacters, paths-as-bins, or unknown argv is NOT allowlisted.
 * The agent runs with `shell: true`, so substring matches are unsafe — full-token rules only.
 *
 * Persisted deny/allow/path grants (edge_trust_rules) are applied in `edgeJobNeedsApproval` after
 * built-in checks: deny before allow, then built-in allow / command allow / path grants.
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

/** Directory prefix to persist for "Always allow this folder" (literal token the person approved). */
export function folderPatternFromJob(kind: EdgeJobKind, payload: Record<string, unknown>): string | null {
  if (kind === "read_path" || kind === "write_path") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!path || !isSafePathArg(path)) return null;
    // Directory of a file path, or the path itself if it looks like a dir (no extension heuristic — keep as given).
    return path.replace(/\/+$/, "") || path;
  }
  if (kind === "run_command") {
    const cmd = typeof payload.command === "string" ? payload.command : "";
    const paths = lsPathArgs(cmd);
    if (paths.length !== 1) return null;
    return paths[0]!.replace(/\/+$/, "") || paths[0]!;
  }
  return null;
}

function commandPrefixMatch(normalizedCmd: string, pattern: string): boolean {
  const cmdTok = normalizedCmd.split(/\s+/);
  const patTok = pattern.trim().split(/\s+/).filter(Boolean);
  if (!patTok.length || patTok.length > cmdTok.length) return false;
  return patTok.every((t, i) => t === cmdTok[i]);
}

function pathUnderGrant(path: string, pattern: string): boolean {
  const p = path.replace(/\/+$/, "");
  const g = pattern.replace(/\/+$/, "");
  if (!g) return false;
  return p === g || p.startsWith(`${g}/`);
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
 * 2. Persisted deny (command) → needs approval
 * 3. Built-in allow OR persisted allow command → auto-approve
 * 4. ls / read_path under path_read, or write_path under path_write → auto-approve
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
    const cmd = typeof payload.command === "string" ? payload.command : "";
    const normalized = normalizeCommandPattern(cmd);

    // Unsafe tokens → always gate (cannot match allowlist).
    if (!normalized) {
      return { needsApproval: true, reason: "unsafe_or_empty" };
    }

    // Persisted deny (command prefix) before any allow.
    if (rules.some((r) => r.effect === "deny" && r.scope === "command" && commandPrefixMatch(normalized, r.pattern))) {
      return { needsApproval: true, reason: "deny_command" };
    }

    if (isHarmlessEdgeRunCommand(cmd)) {
      return { needsApproval: false, reason: "builtin_allow" };
    }

    if (rules.some((r) => r.effect === "allow" && r.scope === "command" && commandPrefixMatch(normalized, r.pattern))) {
      return { needsApproval: false, reason: "allow_command" };
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
