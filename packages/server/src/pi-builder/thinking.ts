/**
 * How hard Forge Agent thinks before it answers (0119): a chat's level, chosen by the person. It reaches the model as
 * `reasoning_effort`, set by `luna-tools-compat.js` from the process's `PI_FORGE_REASONING_EFFORT` — Pi's own thinking
 * level is not used, because Pi drops `xhigh` for a gateway model with no `thinkingLevelMap` and would quietly turn
 * Ultra into High.
 *
 * Workflow Builder always runs with no reasoning ("none"), as it did before: its turns are measured that way, and a
 * level chosen in an agent chat must not change what a build costs.
 *
 * Measured 2026-10-29 against the gateway with tools attached: `gpt-6-luna` takes every effort (none…xhigh);
 * `gpt-5.6-luna` 400s on anything but `none`, which is why the extension still forces `none` for it.
 */
import type { ChatMode } from "./instructions.js";

export const THINKING_LEVELS = ["low", "balanced", "high", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING: ThinkingLevel = "balanced";

const EFFORT: Record<ThinkingLevel, string> = { low: "low", balanced: "medium", high: "high", ultra: "xhigh" };

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/** The `reasoning_effort` a Forge process runs with. */
export function reasoningEffort(mode: ChatMode, level: ThinkingLevel): string {
  return mode === "agent" ? EFFORT[level] : "none";
}
