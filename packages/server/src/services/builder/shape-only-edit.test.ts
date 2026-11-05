/**
 * Shape-only edits revise the local reader — no restate, no makePlan.
 */
import { describe, expect, it, vi } from "vitest";
import { understand, type Understood } from "./builder.service.js";
import type { Chooser } from "./build.js";
import type { BuilderCatalogue, GoalSpec } from "./goal-spec.js";
import type { LocalReader } from "./local-readers.js";

const ARMS = [
  { test: "at_least", value: "9.5", then: 0, words: "present" },
  { test: "at_least", value: "4.75", then: 0.5, words: "half" },
  { test: "below", value: "4.75", then: 1, words: "full" },
];

const GOAL = "for each employee count half day and full day absences and total, email me the report";
const SPEC: GoalSpec = {
  sources: [{ ref: "Attendance_DB.query.banded_absences", quote: "half day and full day absences" }],
  sinks: [{ ref: "mail_send", quote: "email me the report" }],
  values: [],
  conditions: [],
  schedule: null,
  missing: null,
  unclear: [],
  summary: {
    over: "Attendance_DB.query.banded_absences",
    quote: "for each employee count half day and full day absences and total",
    by: ["Attendance_DB.query.banded_absences.emp_id"],
    byWords: ["employee"],
    measures: [{ name: "absences", fn: "band_count", field: "Attendance_DB.query.banded_absences.hours", words: "absences", bands: ARMS }],
  },
};

const LOCAL: LocalReader = {
  ref: "Attendance_DB.query.banded_absences",
  datasource: "Attendance_DB",
  name: "banded_absences",
  spec: { base: { schema: "public", table: "attendance" }, columns: [], filters: [], joins: [] } as never,
};

const ITEMS: BuilderCatalogue = {
  items: [
    {
      ref: "Attendance_DB.query.banded_absences",
      kind: "reader",
      about: "banded absences",
      fields: [
        { name: "emp_id", ty: "Text" },
        { name: "band_count_half_day_absences", ty: "Number" },
        { name: "band_count_full_day_absences", ty: "Number" },
        { name: "band_count_total_absences", ty: "Number" },
      ],
      params: [],
    },
    { ref: "mail_send", kind: "tool", about: "send email", params: [{ name: "to", about: "" }, { name: "subject", about: "" }, { name: "body", about: "" }] },
    { ref: "Attendance_DB.new_read", kind: "reader", about: "a new read of Attendance_DB" },
  ],
};

function previous(): Understood {
  return {
    goal: GOAL,
    texts: [GOAL],
    checked: { spec: SPEC, dropped: [] },
    readback: [],
    outcome: "build",
    corrected: false,
    calls: 1,
    local: [LOCAL],
  };
}

describe("shape-only edit skips makePlan", () => {
  it("does not call builder:plan or edit:restate; rewrites the local", async () => {
    const labels: string[] = [];
    const chooser: Chooser = async (_p, _s, label) => {
      labels.push(label);
      throw new Error(`unexpected model call: ${label}`);
    };
    let wrote = 0;
    const write = vi.fn(async (..._args: unknown[]) => {
      wrote++;
      return {
        reader: LOCAL,
        item: ITEMS.items[0]!,
        assumed: [],
        leftOut: [],
      };
    });
    const u = await understand(
      GOAL,
      ITEMS,
      chooser,
      { previous: previous(), text: "the output of report should be - emp_id, emp_name, half days, full days, total", words: ["the output of report should be - emp_id, emp_name, half days, full days, total"], shapeColumns: ["emp_id", "emp_name", "half days", "full days", "total"] },
      undefined,
      undefined,
      undefined,
      write,
    );
    expect(labels).toEqual([]);
    expect(wrote).toBe(1);
    expect(write.mock.calls[0]?.[1]).toMatch(/emp_id|emp_name|half|full|total/i);
    expect(u.readback.join(" ")).toMatch(/without re-planning/i);
    expect(u.corrected).toBe(true);
  });

  it("CONTROL: without a written local, shape text still calls the model", async () => {
    const labels: string[] = [];
    const chooser: Chooser = async (_p, _s, label) => {
      labels.push(label);
      throw new Error(`stop-after:${label}`);
    };
    const prev = { ...previous(), local: undefined };
    await expect(
      understand(GOAL, ITEMS, chooser, {
        previous: prev,
        text: "the output of report should be - emp_id, emp_name",
        words: ["the output of report should be - emp_id, emp_name"],
      }),
    ).rejects.toThrow(/stop-after/);
    expect(labels.some((l) => /restate|plan|narrow/i.test(l))).toBe(true);
  });
});
