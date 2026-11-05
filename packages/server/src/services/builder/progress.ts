/**
 * The flow as a build stands RIGHT NOW, for the canvas to draw while the turn is still working (2026-09-29: "there was no phased
 * rendering as the workflow was being created, it all just spawns and renders at the last").
 *
 * A turn is one synchronous request, and it saves once, at the end — on a first message the flow does not even exist until then —
 * so there was nothing for the canvas to show in between. The time is spent in the model calls BETWEEN moves, so the states in
 * between are real and worth drawing.
 *
 * Read-only by construction: the preview carries the engine state and its shape, never a signature or an action, so it cannot be
 * acted on or saved — the finished turn's flow (a revision or the working copy) replaces it. Held in memory for exactly the life
 * of the turn (`finally` drops it) and keyed by the turn id: this server is one process (no replicas), and a restart mid-turn
 * loses only a picture, never state.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { flowShape, type CatalogueSnapshot, type EFlow, type StepShape } from "@foundry/flow-edit";

const scope = new AsyncLocalStorage<{ key: string }>();
const latest = new Map<string, { state: EFlow; cat: CatalogueSnapshot }>();

/** Run a build with its progress readable under `key` (the turn id) until it finishes. */
export async function withBuildProgress<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ key }, async () => {
    try {
      return await fn();
    } finally {
      latest.delete(key);
    }
  });
}

/** The builder's hook, called after each engine move. Outside a turn (tests, harnesses, the canvas) it does nothing. */
export function noteBuildState(state: EFlow, cat: CatalogueSnapshot): void {
  const s = scope.getStore();
  if (s) latest.set(s.key, { state, cat });
}

export interface BuildPreview { state: EFlow; shape: Record<string, StepShape> }

/** What a running turn has built so far, or null (not running, nothing moved yet, or finished). */
export function buildPreview(key: string): BuildPreview | null {
  const p = latest.get(key);
  if (!p || !p.state.steps.length) return null;
  let shape: Record<string, StepShape> = {};
  try {
    shape = flowShape(p.state, p.cat);
  } catch {
    // A mid-build state the shape pass cannot read yet still draws — its cards simply show no typed rows.
  }
  return { state: p.state, shape };
}
