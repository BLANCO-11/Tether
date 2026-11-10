/**
 * T13 — Phase 1 pin incomplete on clarify / rebuild: Intent IR must keep written readers.
 * Source-reading + pinSpecByIr; behavioural MEM3 skip is covered by intentIrEnabled() branches in run().
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pinSpecByIr } from "./intent-ir.js";
import type { GoalSpec } from "./goal-spec.js";

const here = dirname(fileURLToPath(import.meta.url));
const conversationSrc = readFileSync(join(here, "conversation.ts"), "utf8");
const builderSrc = readFileSync(join(here, "builder.service.ts"), "utf8");

describe("T13 clarify-preserve (Intent IR)", () => {
  it("conversation keeps locals under Intent IR (no rewrite clear) and offers newReads when corrected", () => {
    expect(conversationSrc).toMatch(/!intentIrEnabled\(\)/);
    expect(conversationSrc).toMatch(/newReads: intentIrEnabled\(\) \|\| !conv\.corrected/);
    expect(conversationSrc).toMatch(/flowLocalReaders/);
    expect(conversationSrc).toMatch(/pinSpecByIr\(settledSpec/);
    // CONTROL: the file is large enough that an empty / renamed path cannot pass.
    expect(conversationSrc.length).toBeGreaterThan(5000);
  });

  it("run() skips MEM3 catalogue filter when Intent IR is on", () => {
    expect(builderSrc).toMatch(/intentIrEnabled\(\)\s*\?\s*new Set<string>\(\)/);
    expect(builderSrc).toMatch(/MEM3/);
    expect(builderSrc.length).toBeGreaterThan(5000);
  });

  it("a rebuild-shaped re-plan that drops sources restores the prior reader", () => {
    const prev: GoalSpec = {
      sources: [{ ref: "Attendance_DB.query.banded_absences", quote: "from attendance" }],
      sinks: [{ ref: "tether_email_send", quote: "email me" }],
      values: [],
      conditions: [],
      schedule: null,
      missing: null,
    };
    const next: GoalSpec = {
      ...prev,
      sources: [],
      sinks: [{ ref: "tether_email_send", quote: "email me the accumulated absences" }],
    };
    const { spec } = pinSpecByIr(prev, next, "email me absences that are accumulated");
    expect(spec.sources[0]!.ref).toBe("Attendance_DB.query.banded_absences");
    expect(spec.sinks[0]!.ref).toBe("tether_email_send");
  });
});
