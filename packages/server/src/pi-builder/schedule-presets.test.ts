import { describe, expect, it } from "vitest";
import { isAllowedScheduleCron, labelForCron, SCHEDULE_PRESETS } from "./schedule-presets.js";
import { parseCron } from "../services/cron.js";

describe("schedule presets (personal Phase 1)", () => {
  it("allowlists only the plain-language presets", () => {
    expect(SCHEDULE_PRESETS).toHaveLength(4);
    for (const p of SCHEDULE_PRESETS) {
      expect(isAllowedScheduleCron(p.cron)).toBe(true);
      expect(() => parseCron(p.cron)).not.toThrow();
      expect(labelForCron(p.cron)).toBe(p.label);
    }
  });

  it("refuses a free-form cron that is not a preset", () => {
    expect(isAllowedScheduleCron("0 7 * * *")).toBe(false);
    expect(isAllowedScheduleCron("*/5 * * * *")).toBe(false);
    expect(labelForCron("0 7 * * *")).toBeNull();
  });
});
