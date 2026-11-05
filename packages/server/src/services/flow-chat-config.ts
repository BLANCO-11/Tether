import { z } from "zod";

/**
 * Per-flow chat configurability (Phase 5) — what the chat column remembers.
 *
 * Stored as `flows.chat_config` jsonb, written through `updateFlowSchema` /
 * `flowService.updateMeta` — a META write, never a revision, for the same
 * reason a rename is not one. Array-shaped config is deliberately avoided:
 * four named facts, one row, no ordering to preserve.
 */
export const chatConfigSchema = z
  .object({
    /** Model override for this flow's turns; NULL means the deployment default. */
    model: z.string().min(1).max(128).nullable().default(null),
    /** Extra instructions appended to the turn prompt; NULL/empty means none. */
    instructions: z.string().max(2000).nullable().default(null),
    /** Whether the workbench offers suggestion chips; off skips the call. */
    suggestions: z.boolean().default(true),
  })
  .strict();

export type ChatConfig = z.infer<typeof chatConfigSchema>;

/**
 * Read a stored `chat_config` value. NULL (never configured) and anything the
 * schema rejects both behave as "never configured" — a turn must never crash
 * on a row an older build or a hand edit left behind.
 */
export function parseChatConfig(stored: unknown): ChatConfig | null {
  if (stored == null) return null;
  const parsed = chatConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/**
 * The visible-fallback sentence, computed — never model prose, so it can live
 * in the transcript beside `describeOp` lines without touching the
 * `turn.text` ban.
 */
export function modelSubstitutionNote(requested: string, used: string): string {
  return (
    `Chat model "${requested}" is not available on this deployment — ` +
    `this turn ran on "${used}" instead.`
  );
}

/**
 * Resolve a flow's configured model against the deployment. Returns the model
 * to pass to `inference.complete` (undefined = today's resolved default) plus
 * a transcript line when the stored model is not offered — a fallback that is
 * visible, never silent.
 *
 * An empty `allowedModels` list means the deployment names no restriction, so
 * the stored model passes through; only a non-empty list that omits it
 * substitutes the default.
 */
export function resolveChatModel(
  requested: string | null | undefined,
  provider: { model: string; allowedModels: string[] },
): { model: string | undefined; substitution: string | null } {
  if (!requested) return { model: undefined, substitution: null };
  if (provider.allowedModels.length > 0 && !provider.allowedModels.includes(requested)) {
    return { model: undefined, substitution: modelSubstitutionNote(requested, provider.model) };
  }
  return { model: requested, substitution: null };
}
/**
 * Bind a resolved model onto a chooser (S8). No override returns the base
 * chooser itself — every leaf keeps calling it with three arguments, so a
 * flow that configured nothing behaves byte-for-byte as before. With an
 * override the bound chooser forwards it as the fourth argument, which
 * `modelChooser` passes to `inference.complete` as `opts.model`.
 */
export function withChatModel(
  base: import("./builder/build.js").Chooser,
  model: string | undefined,
): import("./builder/build.js").Chooser {
  if (!model) return base;
  return (prompt, schema, label) => base(prompt, schema, label, model);
}
