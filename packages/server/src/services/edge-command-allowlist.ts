/**
 * Harmless edge `run_command` allowlist (personal thin).
 *
 * Fail closed: anything with shell metacharacters, paths, or unknown argv is NOT allowlisted.
 * The agent runs with `shell: true`, so substring matches are unsafe — full-token rules only.
 */
import type { EdgeJobKind } from "./edge-device.service.js";

const MAX_LEN = 200;
/** Tokens may only be these characters (no quotes, pipes, dollars, redirects, …). */
const SAFE_TOKEN = /^[A-Za-z0-9._/@:+%-]+$/;
const SAFE_ECHO_ARG = /^[A-Za-z0-9._:@/+%-]+$/;

const NO_ARGS = new Set(["whoami", "pwd", "date", "id", "true", "false", "arch", "sw_vers"]);

const UNAME_FLAGS = new Set(["-a", "-s", "-n", "-r", "-m", "-p", "-v"]);
const HOSTNAME_FLAGS = new Set(["-s", "-f"]);

function tokenize(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_LEN) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.some((p) => !SAFE_TOKEN.test(p))) return null;
  // Basename only — refuse /bin/sh, ./whoami, ../x
  if (parts[0]!.includes("/")) return null;
  return parts;
}

/**
 * True when this exact command may run without Needs-you / in-chat approval.
 * Conservative: whoami, uname, hostname, pwd, date, id, true/false, arch, sw_vers, echo (safe args).
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
    // Allow `-a` or combined short flags like `-sm` (letters from the known set only).
    return args.every((a) => UNAME_FLAGS.has(a) || (/^-[asnrpmv]+$/.test(a) && a.length > 1));
  }

  if (bin === "echo") {
    // No flags (-e/-E enable escapes). Args must be plain tokens.
    return args.every((a) => SAFE_ECHO_ARG.test(a) && !a.startsWith("-"));
  }

  return false;
}

/** Whether enqueue must start in `awaiting_approval`. */
export function edgeJobNeedsApproval(kind: EdgeJobKind, payload: Record<string, unknown>): boolean {
  if (kind === "write_path") return true;
  if (kind === "read_path") return false;
  if (kind === "run_command") {
    const cmd = typeof payload.command === "string" ? payload.command : "";
    return !isHarmlessEdgeRunCommand(cmd);
  }
  return true;
}
