/** "the first day of the month it runs" — a date a read's `from_date` can take (2026-10-01), from measured Pebble pieces only. */
import { describe, expect, it } from "vitest";
import { computedInputExpression } from "./flow-compiler.service.js";
import { emptyFlow, runTimeChoices, TypeOf as T } from "@foundry/flow-edit";

describe("the first day of the month it runs", () => {
  it("is the month (`yyyy-MM`, measured) joined to -01 with `~` (measured) — on a schedule, the fire's own date", () => {
    expect(computedInputExpression("currentMonthStart", { scheduled: false })).toBe("{{ (now() | date('yyyy-MM')) ~ '-01' }}");
    expect(computedInputExpression("priorMonthStart", { scheduled: true })).toBe("{{ ((trigger.date ?? now()) | dateAdd(-1, 'MONTHS') | date('yyyy-MM')) ~ '-01' }}");
  });
  it("is offered for a date port beside the day it runs; CONTROL: never for a month port", () => {
    const f = emptyFlow("t");
    expect(runTimeChoices(f, "r", "from_date", T.date()).map((c) => c.label)).toContain("the first day of the month it runs (worked out when it runs)");
    expect(runTimeChoices(f, "r", "period", T.month()).map((c) => c.label).some((l) => l.includes("first day"))).toBe(false);
  });
});
