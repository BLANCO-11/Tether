/**
 * Plain-language schedule presets (personal Phase 1 / sharing-boundaries P3-I4).
 * Words only — never a free cron box. Server allowlist lives in
 * `packages/server/src/pi-builder/schedule-presets.ts` and must match.
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{ cron: string; label: string }> = [
  { cron: "0 9 * * *", label: "Every day at 9:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 9:00" },
  { cron: "0 9 * * 1", label: "Mondays at 9:00" },
  { cron: "0 9 1 * *", label: "The 1st of each month at 9:00" },
];

/** @deprecated Prefer SCHEDULE_PRESETS — kept as the name PiFlowOverview used. */
export const MY_SCHEDULES = SCHEDULE_PRESETS;
