import { describe, expect, it } from "vitest";
import { checkFanOutFirstResult } from "./flow-output-shape.js";
import { pureModelFindings } from "./flow-model-findings.js";

const steps = (expr: string) => [
  { id: "people", kind: "transform", expr: "{{ 1 }}" },
  { id: "lookup", kind: "tool", ref: "hr_get_employee", over: { stepId: "people", field: "" } },
  { id: "list", kind: "transform", expr },
];

describe("a fan-out step is not read as one call (phase 7, R03)", () => {
  it("refuses results[0] of a fan-out step, in the Pebble path and inside jq", () => {
    expect(checkFanOutFirstResult(steps("{{ json(outputs.lookup.body).results[0].data | jq('.') | first }}"))).toHaveLength(1);
    expect(checkFanOutFirstResult(steps("{{ json(outputs.lookup.body) | jq('.results[0].data') | first }}"))).toHaveLength(1);
    expect(checkFanOutFirstResult(steps("{{ json(outputs.lookup.body).results[0].data }}"))[0]).toMatch(/results\[\]\?\.data/);
  });
  it("allows reading every call, and results[0] of a step that runs once", () => {
    expect(checkFanOutFirstResult(steps("{{ json(outputs.lookup.body) | jq('[.results[]?.data]') | first }}"))).toEqual([]);
    const single = steps("{{ json(outputs.lookup.body).results[0].data }}");
    delete (single[1] as { over?: unknown }).over;
    expect(checkFanOutFirstResult(single)).toEqual([]);
  });
  it("is one of the checks every path runs", () => {
    const f = pureModelFindings(steps("{{ json(outputs.lookup.body).results[0].data }}") as never, []);
    expect(f.join("\n")).toMatch(/runs once per element/);
  });
});
