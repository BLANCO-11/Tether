/**
 * Plain-language schedule presets for chat → schedule (personal Phase 1).
 * Words only — never a free cron box. Must stay aligned with the client's
 * `lib/schedule-presets.ts` / `MY_SCHEDULES`.
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{ cron: string; label: string }> = [
  { cron: "0 9 * * *", label: "Every day at 9:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 9:00" },
  { cron: "0 9 * * 1", label: "Mondays at 9:00" },
  { cron: "0 9 1 * *", label: "The 1st of each month at 9:00" },
];

const ALLOWED = new Set(SCHEDULE_PRESETS.map((p) => p.cron));

export function isAllowedScheduleCron(cron: string): boolean {
  return ALLOWED.has(cron.trim());
}

export function labelForCron(cron: string): string | null {
  return SCHEDULE_PRESETS.find((p) => p.cron === cron.trim())?.label ?? null;
}
