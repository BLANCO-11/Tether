import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/server (works from both src/ and dist/) */
export const SERVER_ROOT = resolve(HERE, "../..");
/** Blank session template (copied per session). */
export const TEMPLATE_ROOT = join(SERVER_ROOT, "pi-builder-template");
/** Isolated per-session sandboxes. */
export const SANDBOXES_ROOT = join(SERVER_ROOT, ".pi-sandboxes");
/** One catalogue file per workspace — sandboxes symlink in, never copy. */
export const CATALOGUE_ROOT = join(SANDBOXES_ROOT, "_catalog");

export function resolvePiBin(): string {
  const fromEnv = process.env.PI_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    "/usr/local/bin/pi",
    "/usr/bin/pi",
    join(process.env.HOME ?? "", ".local/node/bin/pi"),
    "/Users/himanshu/.local/node/bin/pi",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    "pi binary not found — set PI_BIN (e.g. /usr/local/bin/pi) or install @mariozechner/pi-coding-agent",
  );
}
