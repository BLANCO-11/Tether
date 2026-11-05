/**
 * Every bash command stops on its own (2026-10-21). pi's bash tool has no default timeout, so a command the model
 * sent without one ran until a person pressed Stop: a chat's script saved its workbook, then spent 4 m 45 s in a
 * quadratic "verify" pass (openpyxl `.cell()` on a read-only sheet re-reads the sheet per call), while the chat showed
 * only a running timer. Across the stored sessions the longest command that finished took 120 s (p95 42 s).
 *
 * A command with no timeout gets DEFAULT_S; a requested one is capped at MAX_S. When it fires, pi kills the command
 * and the model is told it timed out, so the turn goes on and Forge can say what happened.
 * Load with: pi -e ./pi-extensions/bash-timeout.js
 */
export const DEFAULT_S = 180;
export const MAX_S = 600;

export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || typeof event.input !== "object" || event.input === null) return;
    const t = Number(event.input.timeout);
    event.input.timeout = Number.isFinite(t) && t > 0 ? Math.min(t, MAX_S) : DEFAULT_S;
  });
}
