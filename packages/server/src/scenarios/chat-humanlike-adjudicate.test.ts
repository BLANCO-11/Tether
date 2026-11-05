/**
 * The pure half of `chat:humanlike`.
 *
 * ⚠ This file imports the ADJUDICATOR and never the runner. A scenario
 * script's `main()` runs at import, so importing `chat-humanlike-measure.ts`
 * here would load the repositories and the gateway client and fire real model
 * calls inside the suite — which happened once already, to `propose-measure`,
 * and is written up in CLAUDE.md.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTROLS,
  PROBES,
  behaviourOf,
  buildJudgePrompt,
  inventedRefs,
  judgeIsUsable,
  mentionsGap,
  parseVerdict,
  tally,
  type ControlOutcome,
  type ProbeResult,
} from "./chat-humanlike-adjudicate.js";

const src = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");

const agree = (id: string, expected: boolean, agreed: boolean): ControlOutcome => ({
  id,
  expected,
  got: agreed ? expected : !expected,
  agreed,
});

describe("the probes", () => {
  it("cover both start states, because one of them cannot reach ambiguous_referent", () => {
    // A referent can only be ambiguous when there are steps to be ambiguous
    // between. An empty-only set would report that status's absence as a
    // finding about the model when it was a property of the fixture.
    expect(PROBES.filter((p) => p.start === "empty").length).toBeGreaterThan(0);
    expect(PROBES.filter((p) => p.start === "mid_edit").length).toBeGreaterThan(0);
  });

  it("has a declared gap and gap words for every probe, and unique ids", () => {
    expect(new Set(PROBES.map((p) => p.id)).size).toBe(PROBES.length);
    for (const p of PROBES) {
      expect(p.gap.length, `${p.id} must declare what is underspecified`).toBeGreaterThan(10);
      expect(p.gapWords.length, `${p.id} needs words that would show the gap was addressed`).toBeGreaterThan(2);
      expect(p.text.length).toBeGreaterThan(5);
    }
  });

  /**
   * ⚠ **The load-bearing one.** `defensibleGuess` exists so a reader can tell a
   * helpful assumption from a lazy one. If every probe were on one side of it,
   * the two cross-tabs in the report would be constants — a column that cannot
   * vary is a column that says nothing, which is I-38 wearing a table heading.
   */
  it("has probes on BOTH sides of defensibleGuess", () => {
    expect(PROBES.some((p) => p.defensibleGuess)).toBe(true);
    expect(PROBES.some((p) => !p.defensibleGuess)).toBe(true);
  });

  it("spreads across the vagueness taxonomy rather than testing one thing twelve times", () => {
    expect(new Set(PROBES.map((p) => p.vagueness)).size).toBeGreaterThanOrEqual(6);
  });
});

describe("behaviourOf — ask, guess, or neither", () => {
  it("counts the two clarification statuses as asking", () => {
    expect(behaviourOf("needs_input")).toBe("asked");
    expect(behaviourOf("ambiguous_referent")).toBe("asked");
  });

  it("counts only an applied edit as guessing", () => {
    expect(behaviourOf("applied")).toBe("guessed");
  });

  /**
   * ⚠ A correct refusal is not a guess. Filing `too_structural` or
   * `needs_component` under "guessed" would make the guess rate a number about
   * refusals, and the report's whole point is that ask and guess are read
   * against each other.
   */
  it("counts a correct refusal as NEITHER, not as a guess", () => {
    for (const s of ["too_structural", "needs_component", "answered", "policy_reject", "failed"]) {
      expect(behaviourOf(s), s).toBe("neither");
    }
  });

  it("treats a status this build has never heard of as neither, not as a guess", () => {
    // D-66's ranking: an unknown must not be counted as the confident case.
    expect(behaviourOf("something_new")).toBe("neither");
  });
});

describe("the controls are the only defence, so they are checked here", () => {
  /**
   * ⚠ **BOTH POLARITIES, and this is the assertion that matters most in the
   * file.** A control set that is all-bad is passed by a judge that always says
   * "no"; all-good, by one that always says "yes". Either way the judged half
   * of the report would be unfalsifiable — while looking rigorous, which is
   * worse than having no controls at all.
   */
  it("contains controls a judge must FAIL and controls a judge must PASS", () => {
    expect(CONTROLS.some((c) => c.expectGapAddressed === true)).toBe(true);
    expect(CONTROLS.some((c) => c.expectGapAddressed === false)).toBe(true);
  });

  it("every control names a real probe and says why its verdict is right", () => {
    const ids = new Set(PROBES.map((p) => p.id));
    for (const ctl of CONTROLS) {
      expect(ids.has(ctl.probeId), `${ctl.id} points at a probe that does not exist`).toBe(true);
      expect(ctl.because.length, `${ctl.id} must say why`).toBeGreaterThan(30);
    }
  });

  it("judgeIsUsable demands agreement in BOTH directions, not a hit rate", () => {
    const good = CONTROLS.filter((c) => c.expectGapAddressed).map((c) => c.id);
    const bad = CONTROLS.filter((c) => !c.expectGapAddressed).map((c) => c.id);

    // A judge that always says "no": agrees with every bad control and no good
    // one. Three of five is a 60% hit rate and is worthless.
    const alwaysNo = [
      ...good.map((id) => agree(id, true, false)),
      ...bad.map((id) => agree(id, false, true)),
    ];
    expect(judgeIsUsable(alwaysNo)).toBe(false);

    // A judge that always says "yes".
    const alwaysYes = [
      ...good.map((id) => agree(id, true, true)),
      ...bad.map((id) => agree(id, false, false)),
    ];
    expect(judgeIsUsable(alwaysYes)).toBe(false);

    // The positive control: one of each is enough, and must be.
    const discriminating = [agree(good[0]!, true, true), agree(bad[0]!, false, true)];
    expect(judgeIsUsable(discriminating)).toBe(true);
  });

  it("an unreadable judge reply is not agreement", () => {
    const none: ControlOutcome[] = CONTROLS.map((c) => ({
      id: c.id,
      expected: c.expectGapAddressed,
      got: null,
      agreed: false,
    }));
    expect(judgeIsUsable(none)).toBe(false);
  });
});

describe("the judge prompt", () => {
  const p = buildJudgePrompt({ text: "send it", gap: "who receives it", flowSummary: "empty", reply: "Who to?" });

  /**
   * ⚠ The judge must not be told which answer is preferred. Telling it would
   * put this harness's thumb on the one scale the report explicitly refuses to
   * rank, and the resulting number would measure the instruction.
   */
  it("tells the judge that asking and acting are BOTH allowed", () => {
    expect(p).toMatch(/BOTH can be correct/i);
    expect(p).toMatch(/Do not reward asking over acting/i);
  });

  it("never shows the judge an expected verdict", () => {
    for (const ctl of CONTROLS) expect(p).not.toContain(ctl.because);
    expect(p).not.toMatch(/expect/i);
  });

  it("asks for the two failure modes the controls plant", () => {
    // C1 (asks about what was already said) and C3 (invents data).
    expect(p).toMatch(/already stated/i);
    expect(p).toMatch(/inventing data/i);
  });
});

describe("parseVerdict", () => {
  it("reads a clean reply", () => {
    const v = parseVerdict('{"gap_addressed":true,"quality":4,"options_usable":true,"note":"fine"}');
    expect(v).toEqual({ gapAddressed: true, quality: 4, optionsUsable: true, note: "fine" });
  });

  it("reads JSON wrapped in prose, which is how models actually answer", () => {
    const v = parseVerdict('Sure!\n```json\n{"gap_addressed":false,"quality":2,"options_usable":null,"note":"x"}\n```');
    expect(v?.gapAddressed).toBe(false);
    expect(v?.optionsUsable).toBeNull();
  });

  it("clamps a quality outside the scale rather than trusting it", () => {
    expect(parseVerdict('{"gap_addressed":true,"quality":9}')?.quality).toBe(5);
    expect(parseVerdict('{"gap_addressed":true,"quality":-3}')?.quality).toBe(1);
  });

  /**
   * ⚠ Returns null, never a default. A verdict invented because the reply could
   * not be read is a judgement nobody made, and it would be averaged into the
   * mean quality as if somebody had.
   */
  it("returns null when it cannot read the reply, and never a default", () => {
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseVerdict("{ broken")).toBeNull();
    expect(parseVerdict('{"quality":3}')).toBeNull();
    expect(parseVerdict('{"gap_addressed":"yes","quality":3}')).toBeNull();
  });
});

describe("mentionsGap — the cheap check that is printed BESIDE the judge", () => {
  const probe = PROBES.find((p) => p.id === "P03")!;

  it("finds a gap word regardless of case", () => {
    expect(mentionsGap("WHO should receive this?", probe)).toBe(true);
  });

  it("is false when the reply talks about something else entirely", () => {
    expect(mentionsGap("Added a transform step.", probe)).toBe(false);
  });
});

describe("inventedRefs", () => {
  it("names refs the workspace cannot serve", () => {
    expect(inventedRefs(["a.b", "made_up"], new Set(["a.b"]))).toEqual(["made_up"]);
  });

  it("is empty when everything resolves, and ignores blanks", () => {
    expect(inventedRefs(["a.b", ""], new Set(["a.b"]))).toEqual([]);
  });
});

describe("tally", () => {
  const mk = (probeId: string, behaviourStatus: string): ProbeResult => ({
    probeId,
    round: 1,
    status: behaviourStatus,
    behaviour: behaviourOf(behaviourStatus),
    clarificationRounds: 0,
    mentionedGap: false,
    invented: [],
    verdict: null,
    secs: 1,
    reply: "",
  });

  it("reports ask and guess side by side and cross-tabs each against defensibleGuess", () => {
    const withDefault = PROBES.find((p) => p.defensibleGuess)!.id;
    const without = PROBES.find((p) => !p.defensibleGuess)!.id;
    const t = tally([mk(withDefault, "needs_input"), mk(without, "applied")]);
    expect(t.asked).toBe(1);
    expect(t.guessed).toBe(1);
    expect(t.askedWhereDefaultExisted).toBe(1);
    expect(t.guessedWhereNoDefault).toBe(1);
  });

  it("leaves mean quality null when nothing was judged, rather than reporting zero", () => {
    // A judged mean of 0 on an unjudged run reads as the worst possible result.
    expect(tally([mk(PROBES[0]!.id, "applied")]).meanQuality).toBeNull();
  });
});

/**
 * ⚠ **The guard against this module acquiring a dependency.** It is separate
 * from the runner precisely so a test can import it without loading the
 * database and the gateway; an import added here would undo that silently, and
 * the symptom is a slow test suite firing real model calls.
 */
describe("the adjudicator stays pure", () => {
  it("imports nothing at all", () => {
    const s = src("chat-humanlike-adjudicate.ts");
    // The control: the file really is there and really holds the probes.
    expect(s.length).toBeGreaterThan(2000);
    expect(s).toContain("PROBES");
    expect(s).not.toMatch(/^import /m);
    expect(s).not.toMatch(/\bprocess\./);
  });

  /**
   * ⚠ **No composite score, and the absence is asserted.** Asked for
   * explicitly: ask-rate and guess-rate are reported side by side and neither
   * is the number. A single percentage would encode a preference that was
   * declined, and it would hide the trade a reader is here to see.
   */
  it("computes no overall score", () => {
    const s = src("chat-humanlike-adjudicate.ts");
    expect(s).not.toMatch(/overallScore|compositeScore|totalScore/);
    expect(Object.keys(tally([]))).not.toContain("score");
  });
});
