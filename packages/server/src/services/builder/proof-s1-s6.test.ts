/**
 * PROOF fixtures — S1 (contiguous bands) + S6 (settled ban-list).
 * Offline, no model calls. Each case: CURRENT behavior measured, EXPECTED asserted.
 * Green = cure works; red = plan wrong. No source touched — imports live code only.
 */
import { describe, expect, it } from "vitest";
import { checkSpec, readback, settledMatch, specOutcome, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { run, type Understood } from "./builder.service.js";
import { SYNTHETIC } from "@foundry/flow-edit";


describe("PROOF S6: settled ban-list (exact-norm, delta-only)", () => {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const settled = new Set(
    [
      "get me list of employees along with their calculated absence days",
      "email this as a excel report to me",
    ].map(norm),
  );
  const isSettled = (flag: string): boolean => settled.has(norm(flag));

  it("verbatim settled quote drops (never asked)", () => {
    expect(isSettled("email this as a excel report to me")).toBe(true);
  });

  it("new words stay askable (delta scope)", () => {
    expect(isSettled("half day absence")).toBe(false);
  });

  it("paraphrase is NOT silently swallowed (exact-norm, no fuzzy)", () => {
    // 'the email report thing' overlaps but is not the settled quote — stays in delta.
    expect(isSettled("the email report thing")).toBe(false);
  });
});

describe("S6 LIVE: checkSpec replay drops unclear over a settled quote (exact-norm)", () => {
  const CAT: BuilderCatalogue = { items: [
    { ref: "hr.attendance", kind: "reader", about: "absence rows per employee" },
    { ref: "mail_send", kind: "tool", about: "send an email" },
  ] };
  const GOAL = "get absence days for each employee and email this as a excel report to me";
  const spec = (unclear: GoalSpec["unclear"]): GoalSpec => ({
    sources: [{ ref: "hr.attendance", quote: "get absence days for each employee" }],
    sinks: [{ ref: "mail_send", quote: "email this as a excel report to me" }],
    values: [], conditions: [], schedule: null, missing: null, unclear,
  });
  const SETTLED = ["email this as a excel report to me"];

  it("unclear flag overlapping a settled quote is dropped, stated (delta-only)", () => {
    const c = checkSpec(
      spec([{ quote: "email this as a excel report to me", about: "data" }]),
      [GOAL], CAT, [], undefined, SETTLED,
    );
    expect(c.spec.unclear ?? []).toEqual([]);
    expect(c.dropped.map((d) => d.why)).toContain("the automation already has these words as built");
  });

  it("CONTROL: same flag with nothing settled stays askable", () => {
    const c = checkSpec(
      spec([{ quote: "email this as a excel report to me", about: "data" }]),
      [GOAL], CAT,
    );
    expect((c.spec.unclear ?? []).map((u) => u.quote)).toEqual(["email this as a excel report to me"]);
  });

  it("CONTROL: paraphrase over settled words stays askable (no fuzzy swallow)", () => {
    const goal = `${GOAL} — the email report thing`;
    const c = checkSpec(
      spec([{ quote: "the email report thing", about: "data" }]),
      [goal], CAT, [], undefined, SETTLED,
    );
    expect((c.spec.unclear ?? []).map((u) => u.quote)).toEqual(["the email report thing"]);
    expect(settledMatch("the email report thing", SETTLED)).toBe(false);
    expect(settledMatch("  Email THIS as a excel  report to me ", SETTLED)).toBe(true);
  });

  it("LIVE: settled-anchored unclear never reaches the question round (run choke point)", async () => {
    const c = checkSpec(
      spec([{ quote: "email this as a excel report to me", about: "data" }]),
      [GOAL], CAT, [], undefined, SETTLED,
    );
    const u: Understood = {
      goal: GOAL,
      texts: [GOAL],
      checked: c,
      readback: readback(c, CAT),
      outcome: specOutcome(c.spec),
      corrected: false,
      settled: SETTLED,
      calls: 0,
    };
    // checkSpec already dropped it; the run gate holds even if a flag slips through.
    expect(u.checked.spec.unclear ?? []).toEqual([]);
    const cat = SYNTHETIC;
    const asked: string[] = [];
    const never = (async () => { throw new Error("no model call"); }) as never;
    const r = await run(u, CAT, cat, never, async (qs) => { asked.push(...qs.map((q) => q.holeId)); return qs.map(() => null); });
    expect(asked.filter((id) => id.startsWith("unclear:"))).toEqual([]);
    expect(r.trace.questions.filter((q) => q.holeId.startsWith("unclear:"))).toEqual([]);
  });

  it("SOAK SHAPE: 10 sequential rebuilds raise zero settled-anchored questions", async () => {
    // Sequential rebuilds over one settled base: each replan re-checks the SAME unclear
    // flag against the SAME settled list and drops it — convergence, not drift. Each
    // iteration asserts the drop independently, so a re-ask on ANY round fails loudly.
    const cat = SYNTHETIC;
    const never = (async () => { throw new Error("no model call"); }) as never;
    for (let i = 0; i < 10; i++) {
      const texts = [`${GOAL} (update ${i})`];
      const c = checkSpec(spec([{ quote: "email this as a excel report to me", about: "data" }]), texts, CAT, [], undefined, SETTLED);
      const u: Understood = {
        goal: texts[0]!,
        texts,
        checked: c,
        readback: readback(c, CAT),
        outcome: specOutcome(c.spec),
        corrected: false,
        settled: SETTLED,
        calls: 0,
      };
      expect(u.checked.spec.unclear ?? [], `round ${i}: settled flag must drop`).toEqual([]);
      const asked: string[] = [];
      const r = await run(u, CAT, cat, never, async (qs) => { asked.push(...qs.map((q) => q.holeId)); return qs.map(() => null); });
      expect(asked.filter((id) => id.startsWith("unclear:")), `round ${i}: no unclear emission`).toEqual([]);
      expect(r.trace.questions.filter((q) => q.holeId.startsWith("unclear:")), `round ${i}: no unclear trace`).toEqual([]);
    }
  });
});
