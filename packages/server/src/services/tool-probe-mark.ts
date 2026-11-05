/**
 * The tested marker — `specs/20260818-123807-tool-probe` · P3 · T20.
 *
 * ── Why this is its own module ────────────────────────────────────────────────
 *
 * ⚠ **Because putting it in `tool-probe.service.ts` is a CYCLE, and it is a
 * cycle that ships as a 500.** T21's own note claims there is none — *"the probe
 * service reads tools through `toolRepo`, not through `tool.service.ts`"* — and
 * that is true of the tool ROWS and false of the schema: Decision 3 has the probe
 * service import `createToolSchema` from `tool.service.ts` on purpose, so a draft
 * that could not be created cannot be probed. Adding `tool.service.ts` →
 * `tool-probe.service.ts` closed the loop, `draftSchema` evaluated to `undefined`,
 * and **every draft probe answered `500 internal_error`** while the service's own
 * 43 unit tests stayed green (they import the service directly, so the loop never
 * forms). `routes/tools-probe.test.ts`, which drives real HTTP through the real
 * app, is what caught it.
 *
 * So the marker lives where neither side has to import the other — the same
 * extraction, for the same reason, as `step-error.ts` in T01.
 *
 * ⚠ **No column, no table, no migration.** The P3 sign-off (2026-08-18) is
 * explicit: *"no schema"*. If a `drizzle/0040_*.sql` shows up in this branch, the
 * sign-off was walked back without anyone saying so.
 *
 * ⚠ **Which means the marker is genuinely absent after a restart, and absent on
 * the other container.** That is not a gap to paper over: T22's rule is that no
 * marker renders NOTHING — not "unknown", not a grey pill. A remembered verdict is
 * worth something because it is a fact about a call somebody made; a rendering
 * that fills the gap with a word invents the one thing this feature exists to
 * avoid.
 */

/** Mirrors the two unions in `tool-probe.service.ts`. */
type Verdict =
  | "ok"
  | "reachable"
  | "auth_rejected"
  | "forbidden"
  | "not_found"
  | "upstream_error"
  | "client_error"
  | "unreachable"
  | "egress_refused"
  | "timeout";

/**
 * ⚠ The two unions are declared here rather than imported from the service, and
 * `tool-probe.service.ts` asserts they still match — see its
 * *"the marker's verdict union has not drifted"* test. An import would be the
 * cycle again, in the other direction; a silent drift would let a verdict exist
 * that no marker can hold.
 */
type Mode = "live" | "reachability";

/** What is remembered about the last probe of a SAVED tool. */
export type ToolProbeMark = {
  /** ISO 8601 — the client renders an age rather than being told one. */
  at: string;
  verdict: Verdict;
  mode: Mode;
  status: number | null;
};

/**
 * Keyed `` `${workspaceId}:${toolId}` ``.
 *
 * ⚠ **Saved tools only.** A draft probe marks nothing, because the row the mark
 * would describe does not exist — `toolProbeService.probe` synthesises a draft's
 * row with `id: ""`, so the write is keyed off a non-empty `tool.id` rather than
 * off a flag somebody has to remember to pass.
 *
 * ⚠ At most one entry per tool, and `toolService.remove` drops it — so this does
 * not grow without bound as tools come and go.
 */
const probeMarks = new Map<string, ToolProbeMark>();

const markKey = (workspaceId: string, toolId: string) => `${workspaceId}:${toolId}`;

/** Remember this probe. Called from the ONE place a `ToolProbe` is constructed. */
export function setMark(workspaceId: string, toolId: string, mark: ToolProbeMark): void {
  if (!toolId) return;
  probeMarks.set(markKey(workspaceId, toolId), mark);
}

/** The last probe of this tool in THIS process, or `undefined`. */
export function markFor(workspaceId: string, toolId: string): ToolProbeMark | undefined {
  return probeMarks.get(markKey(workspaceId, toolId));
}

/**
 * Forget the last probe of this tool.
 *
 * ⚠ Called by `toolService` when an edit moves a **dialled** field, and
 * unconditionally on delete. The mark says "this configuration answered like
 * this"; the moment the configuration changes it is a statement about a tool that
 * no longer exists — which is worse than no statement, because it looks current.
 */
export function dropMark(workspaceId: string, toolId: string): void {
  probeMarks.delete(markKey(workspaceId, toolId));
}

/** Test seam — the map lives for the life of the process. */
export function resetProbeMarks(): void {
  probeMarks.clear();
}
