/** How hard Forge Agent thinks before it answers (0119). Its own module so a test mocking `@/lib/pi-builder` keeps it. */
export const THINKING_LEVELS = ["low", "balanced", "high", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LABEL: Record<ThinkingLevel, string> = { low: "Low", balanced: "Balanced", high: "High", ultra: "Ultra high" };
export const THINKING_HINT: Record<ThinkingLevel, string> = {
  low: "Answers quickly, with the least thinking.",
  balanced: "Thinks when it helps. The default.",
  high: "Thinks longer before answering. Slower.",
  ultra: "Thinks the most. The slowest, and it uses the most of the AI service.",
};
