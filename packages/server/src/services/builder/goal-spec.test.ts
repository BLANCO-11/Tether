import { describe, expect, it } from "vitest";
import { checkSpec, maxValues, noneFitCandidates, unaccountedClauses, cronWords, EDIT_NOT_ADDITIVE, FILLS_NONE, paramPairs, goalSpecPrompt, goalSpecSchema, NONE_FIT, norm, quoted, quotedWord, readback, specOutcome, cannotReasons, type BuilderCatalogue, type GoalSpec } from "./goal-spec.js";
import { schemaProblem, validate } from "./strict-schema.js";

const CAT: BuilderCatalogue = { items: [
  { ref: "hr_demo.attendance_below_threshold", kind: "reader", about: "employees below their department's attendance threshold for a period" },
  { ref: "mail_send", kind: "tool", about: "send an email" },
  { ref: "chat_post_message", kind: "tool", about: "post to a chat channel" },
] };
const GOAL = "Every Monday at 9, flag anyone whose attendance dropped below their dept threshold last month and email me the list";
const spec = (x: Partial<GoalSpec> = {}): GoalSpec => ({ sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "attendance dropped below their dept threshold" }], sinks: [{ ref: "mail_send", quote: "email me the list" }], values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }, { role: "period", from: "goal", quote: "last month", fills: "none" }], conditions: [], schedule: { cron: "0 9 * * 1", quote: "Every Monday at 9" }, missing: null, unclear: [], ...x });

describe("GoalSpec (phase 4 task 1, D-304)", () => {
  it("the schema is strict, and its enums are exactly this workspace's components plus the explicit exit", () => {
    const s = goalSpecSchema(CAT);
    expect(schemaProblem(s)).toBeNull();
    expect(validate(s, spec())).toBeNull();
    expect(validate(s, spec({ sinks: [{ ref: "slack_post", quote: "x" }] }))).toMatch(/not one of/);
    expect(validate(s, spec({ sources: [{ ref: NONE_FIT, quote: "x" }] }))).toBeNull();
    // E5.5: the model cannot ask — `ask_person` is not a value it may give.
    expect(validate(s, spec({ values: [{ role: "subject", from: "ask_person", quote: "", fills: "none" }] }))).toMatch(/not one of/);
  });
  it("a quote must be the person's words — case and spacing aside", () => {
    expect(quoted("EMAIL me  the list", [GOAL])).toBe(true);
    expect(quoted("send it to me by email", [GOAL])).toBe(false);
    expect(quoted("", [GOAL])).toBe(false);
    expect(quoted("\"last month\".", [GOAL])).toBe(true);
  });

  it("norm: the one quote normalisation — casefold, curly quotes straightened, whitespace collapsed", () => {
    expect(norm("  The   REGULAR Ones ")).toBe("the regular ones");
    expect(norm("“relevant body message”")).toBe('"relevant body message"');
    expect(norm("it’s “fine”  here")).toBe("it's \"fine\" here");
    // Stable identity: the same unknown always normalises to the same key, whatever the surface form.
    expect(norm("The Regular Ones")).toBe(norm("the   regular ones"));
  });

  it("accepts an ELIDED quote only when every fragment is the person's words, in order, in one text", () => {
    const g = "Post the open roles to LinkedIn every Monday";
    expect(quoted("post ... to linkedin", [g])).toBe(true);
    expect(quoted("post … to linkedin", [g])).toBe(true);
    expect(quoted("to linkedin ... post", [g])).toBe(false);
    expect(quoted("post ... to twitter", [g])).toBe(false);
    expect(quoted("post ... monday", ["post it", "every monday"])).toBe(false);
  });
  it("checkSpec drops what is not quoted or not here, drops an unquoted stated value (the parameter stays open), and refuses a bad cron", () => {
    const c = checkSpec(spec({ sinks: [{ ref: "chat_post_message", quote: "post it in #hr" }], values: [{ role: "threshold", from: "goal", quote: "80%" }], schedule: { cron: "0 25 * * 1", quote: "Every Monday at 9" } }), [GOAL], CAT);
    expect(c.spec.sinks).toEqual([]);
    expect(c.spec.values).toEqual([]);
    expect(c.spec.schedule).toBeNull();
    expect(c.dropped.map((d) => d.what).sort()).toEqual(["schedule", "threshold “80%”", "tool chat_post_message"]);
    // CONTROL: the well-formed spec loses nothing
    expect(checkSpec(spec(), [GOAL], CAT).dropped).toEqual([]);
    // a correction's words count as the person's words
    expect(checkSpec(spec({ sinks: [{ ref: "chat_post_message", quote: "post it in #hr" }] }), [GOAL, "no — post it in #hr instead"], CAT).spec.sinks).toHaveLength(1);
  });
  it("the outcome follows the spec: a missing component is cannot, an unstated value asks, else build", () => {
    expect(specOutcome(spec())).toBe("build");
    expect(specOutcome(spec({ values: [{ role: "recipient", from: "ask_person", quote: "" }] }))).toBe("asks");
    expect(specOutcome(spec({ missing: "a pager" }))).toBe("cannot");
    expect(specOutcome(spec({ sinks: [{ ref: NONE_FIT, quote: "page the on-call" }] }))).toBe("cannot");
  });
  it("a refusal names what it refused on — the same test decides cannot and lists why", () => {
    const s = spec({ sources: [{ ref: NONE_FIT, quote: "each open ticket" }], sinks: [{ ref: NONE_FIT, quote: "page the on-call" }], missing: "No listed reader provides open tickets." });
    expect(cannotReasons(s)).toEqual(["No reader here provides “each open ticket”.", "No action here does “page the on-call”.", "No listed reader provides open tickets."]);
    // CONTROL: a buildable spec has no reason, and every spec with a reason is cannot
    expect(cannotReasons(spec())).toEqual([]);
    for (const x of [s, spec({ missing: "a pager" }), spec({ sinks: [{ ref: NONE_FIT, quote: "p" }] })]) expect(specOutcome(x)).toBe("cannot");
  });
  it("the readback is built from the catalogue, the enums and quotes — every line", () => {
    const lines = readback(checkSpec(spec(), [GOAL], CAT), CAT);
    expect(lines).toEqual([
      "Reads: employees below their department's attendance threshold for a period (hr_demo.attendance_below_threshold) — for “attendance dropped below their dept threshold”",
      "Does: send an email (mail_send) — for “email me the list”",
      "Who receives it: you — the person who runs it",
      "Which period: “last month”, from your goal",
      "Runs: every Monday at 09:00 — for “Every Monday at 9”",
    ]);
  });
  it("cron in words for the shapes goals state; anything else as fields", () => {
    expect(cronWords("30 6 * * *")).toBe("every day at 06:30");
    expect(cronWords("0 8 1 * *")).toBe("on day 1 of every month at 08:00");
    expect(cronWords("*/15 * * * *")).toMatch(/`\*\/15 \* \* \* \*`/);
  });
  it("the prompt puts the goal LAST and the catalogue before it (a stable prefix per workspace)", () => {
    const p = goalSpecPrompt(GOAL, CAT);
    expect(p.endsWith(`GOAL\n${GOAL}`)).toBe(true);
    expect(p.indexOf("mail_send")).toBeLessThan(p.indexOf(GOAL));
    expect(goalSpecPrompt("other goal", CAT).slice(0, p.indexOf("GOAL"))).toBe(p.slice(0, p.indexOf("GOAL")));
  });

  it("a stated value that states nothing of its kind stands as written — no silent fix (Step 5)", () => {
    const goal = "tell managers when someone has been missing a lot this month";
    const raw: GoalSpec = { sources: [], sinks: [], values: [{ role: "threshold", from: "goal", quote: "missing a lot" }, { role: "period", from: "goal", quote: "this month" }], conditions: [], schedule: null, missing: null, unclear: [] };
    const c = checkSpec(raw, [goal], CAT);
    expect(c.spec.values[0]).toEqual({ role: "threshold", from: "goal", quote: "missing a lot" });
    expect(c.spec.values[1]).toMatchObject({ role: "period", from: "goal", quote: "this month" });
    expect(c.dropped).toEqual([]);
  });

  it("`missing` beside no absent component is an unstated detail — dropped, so the goal builds (the builder asks) instead of refusing", () => {
    const goal = "email the widget codes";
    const raw: GoalSpec = { sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "the widget codes" }], sinks: [{ ref: "mail_send", quote: "email" }], values: [], conditions: [], schedule: null, missing: "the recipient is not stated" };
    const c = checkSpec(raw, [goal], CAT);
    expect(c.spec.missing).toBeNull();
    expect(specOutcome(c.spec)).toBe("build");
    // A real absence keeps it; so does D-321's refusal of a non-additive edit.
    expect(checkSpec({ ...raw, sinks: [{ ref: NONE_FIT, quote: "email" }], missing: "a pager" }, [goal], CAT).spec.missing).toBe("a pager");
    expect(checkSpec({ ...raw, sources: [], sinks: [], missing: EDIT_NOT_ADDITIVE }, [goal], CAT).spec.missing).toBe(EDIT_NOT_ADDITIVE);
  });

  it("D-322: a value names the parameter it fills — from the enum of real params, and only of a component the spec KEPT", () => {
    const cat: BuilderCatalogue = { items: [
      { ref: "hr_demo.attendance_below_threshold", kind: "reader", about: "below threshold", params: [{ name: "period", about: "the month, YYYY-MM" }] },
      { ref: "mail_send", kind: "tool", about: "send an email", params: [{ name: "to", about: "recipients" }] },
      { ref: "chat_post_message", kind: "tool", about: "post", params: [{ name: "channel", about: "" }] },
    ] };
    expect(paramPairs(cat)).toEqual(["hr_demo.attendance_below_threshold.period", "mail_send.to", "chat_post_message.channel"]);
    expect(validate(goalSpecSchema(cat), spec({ values: [{ role: "period", from: "goal", quote: "last month", fills: "made.up" }] }))).toMatch(/not one of/);
    const c = checkSpec(spec({ values: [{ role: "period", from: "goal", quote: "last month", fills: "hr_demo.attendance_below_threshold.period" }, { role: "channel", from: "goal", quote: "email", fills: "chat_post_message.channel" }] }), [GOAL], cat);
    expect(c.spec.values[0]!.fills).toBe("hr_demo.attendance_below_threshold.period");
    // chat_post_message is not one of this spec's components, so its parameter cannot be where the person's words go.
    expect(c.spec.values[1]!.fills).toBe(FILLS_NONE);
    expect(c.dropped.map((d) => d.why)).toContain("not a parameter of a component this goal uses");
    expect(goalSpecPrompt(GOAL, cat)).toContain("params: period (the month, YYYY-MM)");
  });
  it("D-326: a compared value must be a WHOLE word of the goal — \"0\" is not quoted by \"2026-06-30\"", () => {
    expect(quotedWord("0", ["as of 2026-06-30"])).toBe(false);
    expect(quotedWord("80%", ["below 80% this month"])).toBe(true);
    expect(quotedWord("critical", ["the Critical vulns"])).toBe(true);
    expect(quotedWord("crit", ["the critical vulns"])).toBe(false);
  });
  it("D-323: a parameter the catalogue STATES is never asked — the value is dropped, stated; one it does not state still is", () => {
    const cat: BuilderCatalogue = { items: [{ ref: "ops.findings", kind: "reader", about: "findings", params: [{ name: "prod_env", about: "", default: "prod" }, { name: "as_of", about: "" }] }] };
    const raw: GoalSpec = { sources: [{ ref: "ops.findings", quote: "findings" }], sinks: [], conditions: [], schedule: null, missing: null,
      values: [{ role: "other", from: "ask_person", quote: "", fills: "ops.findings.prod_env" }, { role: "date", from: "ask_person", quote: "", fills: "ops.findings.as_of" }] };
    const c = checkSpec(raw, ["list the findings"], cat);
    // E5.5: a spec never asks. Both are dropped, each with its reason; the builder asks for `as_of` if the flow still needs it.
    expect(c.spec.values).toEqual([]);
    expect(c.dropped).toContainEqual({ what: "other → ops.findings.prod_env", why: "the catalogue states it (“prod”), so it is not asked" });
    expect(c.dropped).toContainEqual({ what: "date → ops.findings.as_of", why: "what to ask is the builder's to decide, from what the flow still needs" });
  });

  it("E5.5: an unclear flag on words the spec already tied to a value or the schedule is dropped; one on a component choice is kept", () => {
    const goal = "weekly, email the account owner the usual report";
    const raw: GoalSpec = { sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "the usual report" }], sinks: [{ ref: "mail_send", quote: "email" }],
      values: [{ role: "recipient", from: "goal", quote: "the account owner", fills: "none" }], conditions: [], schedule: { cron: "0 9 * * 1", quote: "weekly" }, missing: null,
      unclear: [{ quote: "weekly", about: "data" }, { quote: "the account owner", about: "data" }, { quote: "the usual report", about: "data" }] };
    const c = checkSpec(raw, [goal], CAT);
    expect(c.spec.unclear).toEqual([{ quote: "the usual report", about: "data" }]);
    expect(c.dropped.filter((d) => d.why.startsWith("the spec already ties")).map((d) => d.what)).toEqual(["unclear “weekly”", "unclear “the account owner”"]);
  });
  it("2026-10-06: an unclear flag on the summary's grouping, a measure, or its quote is dropped — the words are placed work", () => {
    const goal = "for each employee return halfday absence and total absences which is full + half";
    const raw: GoalSpec = { sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null,
      summary: { over: "r", quote: "return halfday absence and total absences which is full + half", by: ["for each employee"],
        measures: [{ name: "m1", fn: "sum", field: null, words: "halfday absence" }, { name: "m2", fn: "sum", field: null, words: "total absences which is full + half" }] },
      unclear: [{ quote: "for each employee", about: "action" }, { quote: "return halfday absence", about: "action" }, { quote: "and total absences which is full + half", about: "action" }] };
    const c = checkSpec(raw, [goal], CAT);
    expect(c.spec.unclear ?? []).toEqual([]);
  });
  it("2026-10-07: band weight phrases and for-each are dropped as unclear when the summary already has those arms", () => {
    const goal = "for each employee. Weight half = 0.5. full = 1. present = 0. email Absence days per employee to me";
    const raw: GoalSpec = {
      sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "attendance" }],
      sinks: [{ ref: "mail_send", quote: "email" }],
      values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }],
      conditions: [], schedule: null, missing: null,
      summary: {
        over: "hr_demo.attendance_below_threshold", quote: "Absence days per employee", by: ["employee_id"], byWords: ["for each employee"],
        measures: [{ name: "absence_days", fn: "band_count", field: "hours", words: "Absence days", bands: [
          { test: "equals", value: "0.5", then: 0.5, words: "half" },
          { test: "equals", value: "1", then: 1, words: "full" },
          { test: "equals", value: "0", then: 0, words: "present" },
        ] }],
      },
      unclear: [
        { quote: "for each employee", about: "action" },
        { quote: "Weight half = 0.5", about: "action" },
        { quote: "full = 1", about: "action" },
        { quote: "present = 0", about: "action" },
      ],
    };
    const c = checkSpec(raw, [goal], CAT);
    expect(c.spec.unclear ?? []).toEqual([]);
  });
});


describe("words for a person (2026-09-27, a chat build)", () => {
  it("words that DESCRIBE a message are not its text; quoted words are", () => {
    const g = "email me the list as a well structured report";
    const cat: BuilderCatalogue = { items: CAT.items.map((i) => (i.ref === "mail_send" ? { ...i, params: [...(i.params ?? []).filter((p) => p.name !== "body"), { name: "body", about: "", message: true }] } : i)) };
    const described = checkSpec(spec({ values: [{ role: "text", from: "goal", quote: "a well structured report", fills: "mail_send.body" }] }), [g], cat);
    expect(described.spec.values.filter((v) => v.role === "text")).toEqual([]);
    expect(described.dropped.map((d) => d.why)).toContain("it describes the message rather than giving its words — the message is the data");
    const q = "email me the list saying “all done for today”";
    const said = checkSpec(spec({ values: [{ role: "text", from: "goal", quote: "all done for today", fills: "mail_send.body" }] }), [q], cat);
    expect(said.spec.values.filter((v) => v.role === "text")).toHaveLength(1);
  });
  it("the readback shows a description's first sentence, never the text written for a model", () => {
    const cat: BuilderCatalogue = { items: [...CAT.items.filter((i) => i.ref !== "mail_send"), { ref: "mail_send", kind: "tool", about: "Sends one email. Do NOT write HTML or markup; pass the upstream output in body." }] };
    const lines = readback(checkSpec(spec(), [GOAL], cat), cat).join("\n");
    expect(lines).toMatch(/Does: Sends one email\. \(mail_send\)/);
    expect(lines).not.toMatch(/Do NOT/);
  });
  it("with nothing sent, a recipient is dropped and stated — never read back as someone who receives it", () => {
    const c = checkSpec(spec({ sinks: [] }), [GOAL], CAT);
    expect(c.spec.values.some((v) => v.role === "recipient")).toBe(false);
    expect(c.dropped.map((d) => d.why)).toContain("nothing is sent, so nobody receives it");
  });
  it("a model's text delivers nothing: with only that action, a recipient is dropped too", () => {
    const cat: BuilderCatalogue = { items: [...CAT.items, { ref: "writer", kind: "tool", about: "writes a paragraph", modelText: true, params: [{ name: "instruction", about: "" }] }] };
    const c = checkSpec(spec({ sinks: [{ ref: "writer", quote: "email me the list" }] }), [GOAL], cat);
    expect(c.spec.values.some((v) => v.role === "recipient")).toBe(false);
  });
  it("a clause of the goal no claim touches is UNACCOUNTED — read back as not built, never silently dropped", () => {
    const g = "read the rows of store alpha, turn them into a tidy summary for the team";
    const only = checkSpec({ ...spec(), sources: [], sinks: [], values: [], schedule: null }, [g], CAT);
    expect(only.unaccounted).toEqual(["read the rows of store alpha", "turn them into a tidy summary for the team"]);
    const one = unaccountedClauses(g, { ...only.spec, sources: [{ ref: "x", quote: "the rows of store alpha" }] }, []);
    expect(one).toEqual(["turn them into a tidy summary for the team"]);
    // CONTROL: a claim quoting it — or a drop that STATES it — accounts for it.
    expect(unaccountedClauses(g, { ...only.spec, sources: [{ ref: "x", quote: "the rows of store alpha" }], values: [{ role: "text", from: "goal", quote: "a tidy summary", fills: "none" }] }, [])).toEqual([]);
    expect(unaccountedClauses(g, { ...only.spec, sources: [{ ref: "x", quote: "the rows of store alpha" }] }, [{ what: "text “a tidy summary”", why: "…" }])).toEqual([]);
    expect(readback({ ...only, spec: { ...only.spec, sources: [{ ref: "x", quote: "the rows of store alpha" }] }, unaccounted: one }, CAT).join("\n")).toMatch(/Not built: “turn them into a tidy summary for the team”/);
  });
  it("an ANSWER's words nothing uses are STATED, not unmet — they explain the goal; the goal's own clauses stay work (2026-10-01)", () => {
    const g = "read the rows of store alpha";
    const answer = "yes, it should also have their hours worked for the day";
    const c = checkSpec({ ...spec(), sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "the rows of store alpha" }], sinks: [], values: [], schedule: null }, [g, answer], CAT);
    expect(c.unaccounted ?? []).toEqual([]);
    expect(c.unused).toEqual(["it should also have their hours worked for the day"]);
    expect(readback(c, CAT).join("\n")).toMatch(/From your answers, not used: “it should also have their hours worked for the day”/);
    // CONTROL: a claim quoting the answer accounts for it.
    const quotedIt = checkSpec({ ...spec(), sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "the rows of store alpha" }, { ref: "hr_demo.attendance_below_threshold", quote: "their hours worked for the day" }], sinks: [], values: [], schedule: null }, [g, answer], CAT);
    expect([quotedIt.unaccounted ?? [], quotedIt.unused ?? []]).toEqual([[], []]);
  });
  it("in an EDIT, a condition may test the rows the automation ALREADY reads (2026-10-01)", () => {
    const cat: BuilderCatalogue = { items: [{ ref: "hr_demo.attendance_below_threshold", kind: "reader", about: "", fields: [{ name: "days", ty: "Int" }] }] };
    const edit = "only the ones with more than 10 days";
    const raw: GoalSpec = { sources: [], sinks: [], values: [], conditions: [{ quote: "more than 10 days", field: "hr_demo.attendance_below_threshold.days", test: "above", value: "10" }], schedule: null, missing: null };
    const existing = { lists: [{ key: "step:read_1" as const, words: "the rows read_1 reads", ref: "hr_demo.attendance_below_threshold" }], producers: [], paths: [] };
    expect(checkSpec(raw, [edit], cat, [], existing).spec.conditions[0]).toMatchObject({ field: "hr_demo.attendance_below_threshold.days", value: "10" });
    // CONTROL: without that reader in the automation, the condition has nothing to test.
    expect(checkSpec(raw, [edit], cat).spec.conditions[0]!.field).toBe(FILLS_NONE);
  });
  it("a “.” between two digits is a decimal, never a clause end — “9.5+ hours” is one clause (2026-10-01)", () => {
    const g = "read the rows of store alpha. if someone worked 9.5+ hours thats a full day";
    const s = { ...spec(), sources: [{ ref: "x", quote: "the rows of store alpha" }], values: [], sinks: [], schedule: null };
    expect(unaccountedClauses(g, s, [])).toEqual(["if someone worked 9.5+ hours thats a full day"]);
    // CONTROL: a full stop after a word still ends a clause — the sentence before it is accounted, the one after is not.
    expect(unaccountedClauses("read the rows of store alpha. then send them to the team lead", s, [])).toEqual(["send them to the team lead"]);
  });
  it("words a WRITTEN READ carries out are accounted and stated — dropped silently once that read is not a source", () => {
    const g = "read the rows of store alpha, if 0 hours on a working day then thats a leave";
    const base = { ...spec(), sources: [{ ref: "hr_demo.attendance_below_threshold", quote: "the rows of store alpha" }], sinks: [], values: [], schedule: null };
    const by = "hr_demo.attendance_below_threshold";
    const c = checkSpec({ ...base, covered: [{ quote: "if 0 hours on a working day then thats a leave", by }] }, [g], CAT);
    expect(c.unaccounted ?? []).toEqual([]);
    expect(readback(c, CAT).join("\n")).toMatch(/Done by the read hr_demo\.attendance_below_threshold: “if 0 hours on a working day then thats a leave”/);
    // CONTROL: without the claim, both halves are work nobody built.
    expect(checkSpec(base, [g], CAT).unaccounted).toEqual(["if 0 hours on a working day", "thats a leave"]);
    // A claim of a read this spec no longer reads, or of words not the person's, is gone — and NOT reported as theirs lost.
    const gone = checkSpec({ ...base, covered: [{ quote: "if 0 hours on a working day then thats a leave", by: "other.read" }, { quote: "a rule nobody said", by }] }, [g], CAT);
    expect(gone.spec.covered).toBeUndefined();
    expect(gone.dropped).toEqual([]);
  });
  it("P9: band covers using accounting's clause split clear A01-style unaccounted band meaning", () => {
    const g = "for each employee show half-day absences and calculate the full absence day from hours worked";
    const by = "hr_demo.attendance_below_threshold";
    const base = { ...spec(), sources: [{ ref: by, quote: "for each employee show half-day absences" }], sinks: [], values: [], schedule: null };
    expect(checkSpec(base, [g], CAT).unaccounted?.some((c) => /full absence/i.test(c))).toBe(true);
    const covered = [
      { quote: "for each employee show half-day absences", by },
      { quote: "calculate the full absence day from hours worked", by },
    ];
    expect(checkSpec({ ...base, covered }, [g], CAT).unaccounted ?? []).toEqual([]);
  });
  it("short fragments (under three words) are never flagged", () => {
    expect(unaccountedClauses("the rows of store alpha, pls", { ...spec(), sources: [{ ref: "x", quote: "the rows of store alpha" }] }, [])).toEqual([]);
  });
});

describe("value domains (I-301): a compared value on a known domain is a member, else the person is asked with the real values", () => {
  const D: BuilderCatalogue = { items: [
    { ref: "store.lines", kind: "reader", about: "order lines", fields: [{ name: "status", ty: "Text<OneOf[open, shipped, cancelled]>", values: ["open", "shipped", "cancelled"] }, { name: "note", ty: "Text" }] },
  ] };
  const G = "get me the fulfilled lines with note urgent";
  const s = (c: GoalSpec["conditions"]): GoalSpec => ({ sources: [{ ref: "store.lines", quote: "the fulfilled lines" }], sinks: [], values: [], conditions: c, schedule: null, missing: null, unclear: [] });
  it("an open-text field is never presented as checked", () => {
    const c = checkSpec(s([{ quote: "note urgent", by: "the_flow", field: "store.lines.note", test: "equals", value: "urgent" }]), [G], D);
    expect(readback(c, D).join("\n")).toMatch(/could not check that “urgent” is a value of `note`/);
  });
  it("CONTROL: with no domain, an unquoted value is still dropped as not the goal's words", () => {
    const c = checkSpec(s([{ quote: "note urgent", by: "the_flow", field: "store.lines.note", test: "equals", value: "high" }]), [G], D);
    expect(c.dropped.map((d) => d.why).join()).toMatch(/not the goal's words/);
  });
});

describe("an unscheduled flow says so (E5.13): nothing runs it on its own", () => {
  it("read back as run-when-started; CONTROL: a scheduled one reads back its schedule instead", () => {
    const none = checkSpec(spec({ schedule: null, values: [] }), [GOAL], CAT);
    expect(readback(none, CAT).join("\n")).toMatch(/Runs: when it is started .* nothing runs it on its own/);
    const weekly = checkSpec(spec({ values: [] }), [GOAL], CAT);
    expect(readback(weekly, CAT).join("\n")).not.toMatch(/when it is started/);
  });
});

describe("a goal can state as many values as its actions have inputs (2026-09-30: a cap of 8 dropped a sender said three times)", () => {
  const mail = (n: number): BuilderCatalogue => ({ items: [
    { ref: "r", kind: "reader", about: "rows", params: [{ name: "as_of", about: "" }] },
    { ref: "mail", kind: "tool", about: "send an email", params: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, about: "" })) },
  ] });
  const values = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "other" as const, from: "goal" as const, quote: `v${i}`, fills: "mail.p0" }));
  it("three emails, each with a recipient, a sender and a subject — plus a date and two thresholds — fit the schema", () => {
    const cat = mail(4);
    expect(validate(goalSpecSchema(cat), spec({ sources: [], sinks: [], values: values(3 * 3 + 3) }))).toBeNull();
  });
  it("the bound is the catalogue's, and grows with it — CONTROL: past it the schema refuses", () => {
    expect(maxValues(mail(5))).toBeGreaterThan(maxValues(mail(4)));
    expect(validate(goalSpecSchema(mail(4)), spec({ sources: [], sinks: [], values: values(maxValues(mail(4)) + 1) }))).not.toBeNull();
  });
});

describe("the person an approval asks is not a recipient (2026-09-30)", () => {
  const goal = "Every Monday at 9, flag anyone whose attendance dropped below their dept threshold last month and email me the list — ask me to approve it first";
  const w = { paths: [], actions: [{ takes: "reader:0" as const, path: "always" as const, approve: "ask me to approve it first" }] };
  it("“ask ME to approve it first”: the approver, dropped by name — not a recipient left untied", () => {
    const r = checkSpec(spec({ values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }, { role: "period", from: "goal", quote: "last month", fills: "none" }], wiring: w } as never), [goal], CAT);
    expect(r.dropped.filter((d) => d.why.startsWith("the person asked to approve")).map((d) => d.what)).toEqual(["recipient “me”"]);
    expect(r.spec.values.map((v) => v.quote)).toEqual(["last month"]); // the rest stay, renumbered
  });
  it("CONTROL: with no approval, “email me the list”'s “me” is the recipient and stays", () => {
    const r = checkSpec(spec({ values: [{ role: "recipient", from: "requester", quote: "me", fills: "none" }], wiring: { ...w, actions: [{ ...w.actions[0]!, approve: null }] } } as never), [goal], CAT);
    expect(r.spec.values.some((v) => v.role === "recipient" && v.quote === "me")).toBe(true);
  });
});

describe("the shape schema stays inside the gateway's enum budget (2026-10-01)", async () => {
  const { shapeSchema } = await import("./goal-spec.js");
  const { ENUM_BUDGET, enumCount } = await import("./strict-schema.js");
  const reader = (ref: string, n: number) => ({ ref, kind: "reader" as const, about: ref, fields: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, ty: "Text" })) });
  const slot = (s: unknown, path: string[]) => path.reduce((x: any, k) => (k === "[]" ? x.items : k === "?" ? x.anyOf[0] : x.properties[k]), s);
  const stage = (s: unknown) => slot(s, ["shapes", "[]", "stages", "[]"]);

  it("CONTROL: a narrow reader keeps the field list as an enum in every slot", () => {
    const s = shapeSchema({ items: [reader("ds.a", 10)] }, ["ds.a"]);
    expect(slot(stage(s), ["field", "?"]).enum).toBeDefined();
    expect(slot(stage(s), ["against", "?"]).enum).toBeDefined();
  });

  it("a wide reader (one table joined to what it refers to) stays under the budget: `field` keeps its enum, the rest are strings", () => {
    const s = shapeSchema({ items: [reader("ds.a", 220)] }, ["ds.a"]);
    expect(enumCount(s)).toBeLessThanOrEqual(ENUM_BUDGET);
    expect(slot(stage(s), ["field", "?"]).enum).toBeDefined();
    expect(slot(stage(s), ["against", "?"]).enum).toBeUndefined();
  });

  it("wider still: every field slot is a string — never a schema the gateway refuses", () => {
    const s = shapeSchema({ items: [reader("ds.a", 600), reader("ds.b", 600)] }, ["ds.a", "ds.b"]);
    expect(enumCount(s)).toBeLessThanOrEqual(ENUM_BUDGET);
    expect(slot(stage(s), ["field", "?"]).enum).toBeUndefined();
  });
});

describe("a clause's own words decide what it compares with and what it needs (P5-I5, P5-I6)", () => {
  const C: BuilderCatalogue = { items: [{ ref: "r", kind: "reader", about: "", fields: [{ name: "due_date", ty: "Date" }, { name: "vendor_name", ty: "Text" }, { name: "hostname", ty: "Text" }, { name: "cost_centres_name", ty: "Text" }] }] };
  const base = (goal: string, quote: string): [GoalSpec, string[]] => [{ sources: [{ ref: "r", quote: "the invoices" }], sinks: [], values: [], conditions: [], schedule: null, missing: null,
    shapes: [{ over: "r", stages: [{ op: "filter", quote, field: "r.due_date", test: "date_passed" }] }] }, [goal]];
  const stage = (c: ReturnType<typeof checkSpec>) => c.spec.shapes![0]!.stages[0]!;
  it("CONTROL: no stated day, or two different days, stays the day it runs", () => {
    expect(stage(checkSpec(...base("read the invoices past their due date", "past their due date"), C))).toMatchObject({ test: "date_passed" });
    expect(stage(checkSpec(...base("read the invoices past due between 1 june 2026 and 30 june 2026", "past due between 1 june 2026 and 30 june 2026"), C))).toMatchObject({ test: "date_passed" });
  });
  it("a clause that only names fields the read rows carry is done by reading them", () => {
    const s: GoalSpec = { sources: [{ ref: "r", quote: "the open invoices" }], sinks: [], values: [], conditions: [], schedule: null, missing: null };
    expect(checkSpec(s, ["read the open invoices, with the vendor name"], C).unaccounted ?? []).toEqual([]);
    expect(checkSpec(s, ["read the open invoices, including the hostname and vendor name"], C).unaccounted ?? []).toEqual([]);
    // A joined table's column (`cost_centres_name`) is named by its singular words too.
    expect(checkSpec(s, ["read the open invoices, with the cost centre name"], C).unaccounted ?? []).toEqual([]);
    // CONTROL: a field the rows do not carry is still work nobody built.
    expect(checkSpec(s, ["read the open invoices, with the colour of the box"], C).unaccounted).toEqual(["with the colour of the box"]);
  });
});

describe("a pronoun is never unclear on its own (2026-10-01, H06)", () => {
  it("“it” in “email their managers about it” points back at the goal — stated, not asked", () => {
    const g = "find the late rows and email their managers about it";
    const s = { ...spec(), unclear: [{ quote: "it", about: "data" as const }, { quote: "the late rows", about: "data" as const }] };
    const c = checkSpec(s, [g], CAT);
    expect(c.spec.unclear?.map((u) => u.quote)).not.toContain("it");
    expect(c.dropped.map((d) => d.why)).toContain("a pronoun refers to what the goal already says");
    // CONTROL: words that say something of their own stay the person's to settle.
    expect(c.spec.unclear?.map((u) => u.quote)).toContain("the late rows");
  });
});

describe("words a reader DECLARES of every row it gives are settled by it (2026-10-01, S02)", () => {
  const C: BuilderCatalogue = { items: [{ ref: "r", kind: "reader", about: "Every open ticket with its customer and plan", fields: [] }] };
  const s = (quote: string): GoalSpec => ({ sources: [{ ref: "r", quote: "the tickets" }], sinks: [], values: [], conditions: [], schedule: null, missing: null, unclear: [{ quote, about: "data" }] });
  it("“open” over “Every open ticket …” is not asked", () => {
    const c = checkSpec(s("open"), ["if any customer has an open ticket, read the tickets"], C);
    expect(c.spec.unclear ?? []).toEqual([]);
    expect(c.dropped.map((d) => d.why)).toContain("the reader it reads says this of every row it gives");
  });
  it("CONTROL: words the description does not say — or only says inside another word — stay the person's", () => {
    expect(checkSpec(s("late"), ["if any customer has a late ticket, read the tickets"], C).spec.unclear?.map((u) => u.quote)).toEqual(["late"]);
    expect(checkSpec(s("pen"), ["if any customer has a pen ticket, read the tickets"], C).spec.unclear?.map((u) => u.quote)).toEqual(["pen"]);
  });
});

describe("P2 (RC-3, 2026-10-07): a `none_fit` shortlist is structured — catalogue order, never word overlap", () => {
  const WS: BuilderCatalogue = { items: [
    { ref: "fin.table.invoices", kind: "reader", about: "overdue invoices, with due dates" },
    { ref: "hr.staff.attendance", kind: "reader", about: "employees below their department's attendance threshold for a period" },
    { ref: "mail_send", kind: "tool", about: "send an email" },
    { ref: "chat_post_message", kind: "tool", about: "post to a chat channel" },
    { ref: "chan_lookup", kind: "tool", about: "list chat channels", lookup: true },
  ] };
  const HR: BuilderCatalogue = { items: WS.items.filter((i) => i.ref === "hr.staff.attendance" || i.ref === "mail_send") };
  it("FAILING-BEFORE: every offered component of the kind is named, in catalogue order — even with zero shared words", () => {
    // "wifi routers" shares no word with any reader's catalogue text: the old overlap gate returned [] and the
    // refusal stood unquestioned. The shortlist names what the workspace HAS, so the re-ask can question it.
    expect(noneFitCandidates("invoices wifi routers", "reader", WS)).toEqual(["fin.table.invoices", "hr.staff.attendance"]);
    expect(noneFitCandidates("invoices", "reader", WS)).toEqual(["fin.table.invoices", "hr.staff.attendance"]);
    expect(noneFitCandidates("the chat channel", "tool", WS)).toEqual(["mail_send", "chat_post_message"]);
  });
  it("a lookup is never a candidate; an empty quote names nothing", () => {
    expect(noneFitCandidates("the chat channel", "tool", WS)).not.toContain("chan_lookup"); // lookup excluded
    expect(noneFitCandidates("", "reader", WS)).toEqual([]);
    expect(noneFitCandidates("   ", "tool", WS)).toEqual([]);
  });
  it("CONTROL: genuinely absent kind — no offered component, so nothing questions the refusal", () => {
    expect(noneFitCandidates("the finance table", "reader", HR)).toEqual(["hr.staff.attendance"]);
    expect(noneFitCandidates("invoices", "reader", { items: [] })).toEqual([]);
    expect(noneFitCandidates("log it", "tool", { items: HR.items.filter((i) => i.kind !== "tool") })).toEqual([]);
  });
});


describe("P3 (RC-4): a negative or builder-directed clause is never a phantom obligation", () => {
  const FIN: BuilderCatalogue = { items: [
    { ref: "ds.invoices", kind: "reader", about: "the invoices with their due dates" },
    { ref: "mail_send", kind: "tool", about: "send an email" },
    { ref: "audit_log_write", kind: "tool", about: "write an audit log entry" },
  ] };
  const base = (sinks: GoalSpec["sinks"]): GoalSpec => ({ sources: [{ ref: "ds.invoices", quote: "the overdue invoices" }], sinks, values: [], conditions: [], schedule: null, missing: null });

  it("“leave the otherwise arm empty” where the arm IS empty: stated unmet (Step 5: no direction mining)", () => {
    const g = "email the overdue invoices, leave the otherwise arm empty";
    const c = checkSpec(base([{ ref: "mail_send", quote: "email the overdue invoices" }]), [g], FIN);
    expect(c.unaccounted).toEqual(["leave the otherwise arm empty"]);
    expect(c.dropped).toEqual([]);
    expect(c.spec.missing).toBeNull();
    expect(specOutcome(c.spec)).toBe("build");
    expect(readback(c, FIN).join("\n")).toMatch(/leave the otherwise arm empty/);
  });


  it("nothing there to remove: the direction is still stated work — builds, asks nothing", () => {
    const g = "email the overdue invoices, drop the log step";
    const c = checkSpec(base([{ ref: "mail_send", quote: "email the overdue invoices" }]), [g], FIN);
    expect(c.unaccounted).toEqual(["drop the log step"]); // no direction mining: stated as unmet work…
    expect(c.spec.missing).toBeNull(); // …and no refusal: there is nothing to take away
    expect(c.dropped).toEqual([]);
    expect(specOutcome(c.spec)).toBe("build");
  });
  it("CONTROL: a clause that asks for work and no part of it exists is still stated unmet", () => {
    const g = "email the overdue invoices, sort them by due date";
    const c = checkSpec(base([{ ref: "mail_send", quote: "email the overdue invoices" }]), [g], FIN);
    expect(c.unaccounted).toEqual(["sort them by due date"]);
  });
});

describe("R2 (2026-10-08): a row exclusion lowered NOWHERE stays unaccounted — overlap with a read's claim never covers it", () => {
  const R: BuilderCatalogue = { items: [
    { ref: "store.widgets", kind: "reader", about: "widgets with their state", fields: [{ name: "state", ty: "Text" }] },
    { ref: "notify_me", kind: "tool", about: "send a message" },
  ] };
  const GOAL = "post the widget codes, dont include rows where state is damaged";
  const base = (over: Partial<GoalSpec> = {}): GoalSpec => ({ sources: [{ ref: "store.widgets", quote: "the widget codes" }], sinks: [{ ref: "notify_me", quote: "post" }], values: [], conditions: [], schedule: null, missing: null, ...over });
  const by = "store.widgets";
  it("FAIL-BEFORE: a `covered` claim quoting the words with no condition/filter leaves it unaccounted (and unmet downstream)", () => {
    const c = checkSpec(base({ summary: { over: by, quote: "the widget totals", by: [], measures: [] }, covered: [{ quote: "dont include rows where state is damaged", by }] }), [GOAL], R);
    expect(c.unaccounted).toEqual(["dont include rows where state is damaged"]);
    expect(readback(c, R).join("\n")).toMatch(/Not built: “dont include rows where state is damaged”/);
  });
  it("CONTROL: the same words as a condition quote are accounted — lowered, not dropped", () => {
    const c = checkSpec(base({ conditions: [{ quote: "dont include rows where state is damaged", by: "the_flow", field: "store.widgets.state", test: "not_equals", value: "damaged" }] }), [GOAL], R);
    expect(c.unaccounted ?? []).toEqual([]);
  });
  it("CONTROL: the same words asked as unclear are accounted — asked, never silently dropped", () => {
    const c = checkSpec(base({ unclear: [{ quote: "dont include rows where state is damaged", about: "condition" }] }), [GOAL], R);
    expect(c.unaccounted ?? []).toEqual([]);
    expect(c.spec.unclear?.map((u) => u.quote)).toEqual(["dont include rows where state is damaged"]);
  });
  it("CONTROL: a `covered` claim still covers a NON-exclusion clause (the band/definition rule, P9)", () => {
    const g = "for each employee show half-day absences and calculate the full absence day from hours worked";
    const b = ({ sources: [{ ref: by, quote: "for each employee show half-day absences" }], sinks: [], values: [], schedule: null } as Partial<GoalSpec>);
    const covered = [
      { quote: "for each employee show half-day absences", by },
      { quote: "calculate the full absence day from hours worked", by },
    ];
    expect(checkSpec(base({ ...b, covered }), [g], R).unaccounted ?? []).toEqual([]);
  });
});
