/**
 * The schedule gate's refusal, and the half of it that was missing.
 *
 * Each assertion carries its control: the whole risk in a "split the message by
 * a condition" change is that the condition never fires and the new branch is
 * dead text nobody reads (I-38).
 */
import { describe, expect, it } from "vitest";
import { scheduleInputBlock, scheduleInputRefusal } from "./flow-schedule-inputs.js";
import type { FlowModel } from "./flow-compiler.service.js";

const model = (over: Record<string, unknown>) =>
  ({ id: "f", steps: [], inputs: [], ...over } as unknown as FlowModel);

const reads = (id: string) => ({
  id: "read",
  kind: "datasource",
  ref: "hr_demo.q",
  paramsExpr: `[{"as_of": "{{ inputs.${id} }}"}]`,
});

describe("scheduleInputBlock", () => {
  it("⚠ an input nothing reads lands in `unread`, not in `wanted`", () => {
    const b = scheduleInputBlock(
      model({ schedule: { cron: "0 9 * * *" }, inputs: [{ id: "period", type: "STRING", required: true }] }),
    );
    expect(b).toEqual({ wanted: [], unread: ["period"] });
  });

  it("CONTROL: the same input, read by a step, lands in `wanted`", () => {
    const b = scheduleInputBlock(
      model({
        schedule: { cron: "0 9 * * *" },
        inputs: [{ id: "period", type: "STRING", required: true }],
        steps: [reads("period")],
      }),
    );
    expect(b).toEqual({ wanted: ["period"], unread: [] });
  });

  it("an input with a default blocks nothing, read or not", () => {
    expect(
      scheduleInputBlock(
        model({ inputs: [{ id: "period", type: "STRING", required: true, defaults: "2026-06" }] }),
      ),
    ).toEqual({ wanted: [], unread: [] });
  });

  it("a DERIVED input is a decided value — `computed` satisfies the gate", () => {
    expect(
      scheduleInputBlock(
        model({ inputs: [{ id: "period", type: "STRING", required: true, computed: "priorMonth" }] }),
      ),
    ).toEqual({ wanted: [], unread: [] });
  });

  it("an optional input is never a block", () => {
    expect(
      scheduleInputBlock(model({ inputs: [{ id: "period", type: "STRING", required: false }] })),
    ).toEqual({ wanted: [], unread: [] });
  });
});

describe("scheduleInputRefusal", () => {
  it("⚠ says nothing at all when the flow has no schedule — on-demand flows pass", () => {
    expect(
      scheduleInputRefusal(model({ inputs: [{ id: "period", type: "STRING", required: true }] })),
    ).toBeNull();
  });

  it("CONTROL: the identical model WITH a cron is refused", () => {
    expect(
      scheduleInputRefusal(
        model({ schedule: { cron: "0 9 * * *" }, inputs: [{ id: "period", type: "STRING", required: true }] }),
      ),
    ).toBeTruthy();
  });

  it("⚠ an unread input's message names REMOVAL and does not tell anyone to invent a default", () => {
    const msg = scheduleInputRefusal(
      model({ schedule: { cron: "0 9 * * *" }, inputs: [{ id: "period", type: "STRING", required: true }] }),
    )!;
    expect(msg).toContain("read by no step");
    expect(msg).toContain("Remove the declaration");
    expect(msg).toContain('"period"');
    // The wanted-half's advice must not appear — it is the advice that was wrong
    // for this case, and printing both is how a person picks the easy one.
    expect(msg).not.toContain("Give each one a default expression");
  });

  it("CONTROL: a READ input's message names the defaults and not removal", () => {
    const msg = scheduleInputRefusal(
      model({
        schedule: { cron: "0 9 * * *" },
        inputs: [{ id: "period", type: "STRING", required: true }],
        steps: [reads("period")],
      }),
    )!;
    expect(msg).toContain("Give each one a default expression");
    expect(msg).not.toContain("Remove the declaration");
  });

  it("names BOTH halves when a flow has one of each — one round trip, not two", () => {
    const msg = scheduleInputRefusal(
      model({
        schedule: { cron: "0 9 * * *" },
        inputs: [
          { id: "period", type: "STRING", required: true },
          { id: "dead", type: "STRING", required: true },
        ],
        steps: [reads("period")],
      }),
    )!;
    expect(msg).toContain('"period"');
    expect(msg).toContain('"dead"');
    expect(msg).toContain("Give each one a default expression");
    expect(msg).toContain("Remove the declaration");
  });

  it("a scheduled flow whose inputs are all answered is not refused", () => {
    expect(
      scheduleInputRefusal(
        model({
          schedule: { cron: "0 9 * * *" },
          inputs: [{ id: "period", type: "STRING", required: true, defaults: "2026-06" }],
          steps: [reads("period")],
        }),
      ),
    ).toBeNull();
  });
});
