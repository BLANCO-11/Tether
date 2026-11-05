/**
 * The seal on the held-out workspace (compiled-builder phase 1, D-313). PURE — safe to import.
 *
 * A goal whose workspace is listed here is refused by `goalset:measure` unless `--gate` is passed, and every gate run
 * appends a line to the file named by `--gate-log`. Tuning against these goals outside a gate is the leak (§5 rule 8).
 */
export const SEALED_WORKSPACES: readonly string[] = ["Fleet Telemetry"];

/** The schema-only twins (D-311): measured like tuned workspaces, never sealed. */
export const SCHEMA_ONLY_TWINS: readonly string[] = ["Orders & Fulfilment (schema-only)", "Customer Support (schema-only)"];

/**
 * The seal's decision, pure. Returns the refusal message, or null when the run may proceed.
 * A sealed goal without `--gate` is refused before any model call; a gate run must name its log.
 */
export function sealCheck(goals: ReadonlyArray<{ id: string; workspace: string }>, gate: boolean, gateLog: string | undefined): string | null {
  const sealed = goals.filter((g) => SEALED_WORKSPACES.includes(g.workspace));
  if (sealed.length === 0) return null;
  if (!gate) {
    return `refused: ${sealed.length} goal(s) target a SEALED workspace (${[...new Set(sealed.map((g) => g.workspace))].join(", ")}): ` +
      `${sealed.map((g) => g.id).join(", ")}. Held-out goals run only at a gate: pass --gate and --gate-log=<evidence file>.`;
  }
  if (!gateLog) return "refused: a gate run must name --gate-log=<file>; every gate run is recorded";
  return null;
}
