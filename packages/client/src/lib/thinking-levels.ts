/** How hard Forge Agent thinks before it answers (0119). Its own module so a test mocking `@/lib/pi-builder` keeps it. */
export const THINKING_LEVELS = ["low", "balanced", "high", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
