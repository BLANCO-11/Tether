/**
 * The reply reader's CONTRACT: one structured reply over a group of questions — the schema the gateway admits, the code
 * validator's rules (each intent's requirements, a qid that was never asked, chips that bind their options), and the failed-read
 * fallback (null, never a throw). The conversational reading itself is the MODEL's; these tests hold what CODE decides.
 */
import { describe, expect, it } from "vitest";
import { interpretReplies, replyIntentsSchema, replyPrompt, validateReplies, type GroupQuestion } from "./reply-intents.js";
import { enumCount, schemaProblem, validate } from "./strict-schema.js";
import type { Chooser } from "./build.js";

const QS: GroupQuestion[] = [
  { holeId: "unclear:manager:data", ask: "I cannot give “manager” from this data — no manager column exists. What do you mean by it?" },
  { holeId: "delivery:0:delivery", ask: "Where should the result go?", options: ["#ops", "#general"] },
  { holeId: "shape:0:0:threshold", ask: "What counts as “late”?", options: ["30"], onlyOptions: true },
];

const replies = (...entries: Array<Record<string, unknown>>) => ({ replies: entries });

describe("reply intents: schema", () => {
  it("is inside the strict subset and inside the gateway's enum budget", () => {
    const s = replyIntentsSchema(3);
    expect(schemaProblem(s)).toBeNull();
    expect(validate(s, replies({ qid: "a", intent: "answer", value: "x" }))).toBeNull();
    expect(enumCount(s)).toBeLessThan(50);
  });
});

describe("reply intents: the code validator", () => {
  it("routes an answer to its question, a confirm to a yes, a defer to state", () => {
    const r = validateReplies(replies(
      { qid: "unclear:manager:data", intent: "answer", value: "  the person each row reports to  " },
      { qid: "delivery:0:delivery", intent: "confirm", value: null },
      { qid: "shape:0:0:threshold", intent: "answer", value: "30" },
    ), QS);
    expect(r).toEqual({
      answers: { "unclear:manager:data": "the person each row reports to", "delivery:0:delivery": "yes", "shape:0:0:threshold": "30" },
      deferred: [], newInstruction: false,
    });
  });

  it("a defer closes its question in state, not in words", () => {
    expect(validateReplies(replies({ qid: "unclear:manager:data", intent: "defer", value: null }), QS)).toEqual({
      answers: {}, deferred: ["unclear:manager:data"], newInstruction: false,
    });
  });

  it("CONTROL: a qid that was never asked is rejected — the reply cannot answer a question outside the group", () => {
    expect(validateReplies(replies({ qid: "unclear:when:time", intent: "answer", value: "x" }), QS)).toBeNull();
    expect(validateReplies(replies({ qid: "h_call_1_subject", intent: "answer", value: "x" }), QS)).toBeNull();
  });

  it("a duplicate qid keeps the first valid entry and drops the repeat (S5: per-entry)", () => {
    expect(validateReplies(replies(
      { qid: "unclear:manager:data", intent: "answer", value: "x" },
      { qid: "unclear:manager:data", intent: "defer", value: null },
    ), QS)).toEqual({ answers: { "unclear:manager:data": "x" }, deferred: [], newInstruction: false });
  });

  it("an answer without a value, and a value on a defer, are rejected", () => {
    expect(validateReplies(replies({ qid: "unclear:manager:data", intent: "answer", value: null }), QS)).toBeNull();
    expect(validateReplies(replies({ qid: "unclear:manager:data", intent: "answer", value: "   " }), QS)).toBeNull();
    expect(validateReplies(replies({ qid: "unclear:manager:data", intent: "defer", value: "keep it" }), QS)).toBeNull();
  });

  it("chips bind their options: an onlyOptions question takes only a listed value", () => {
    expect(validateReplies(replies({ qid: "shape:0:0:threshold", intent: "answer", value: "30" }), QS)).not.toBeNull();
    expect(validateReplies(replies({ qid: "shape:0:0:threshold", intent: "answer", value: "whatever" }), QS)).toBeNull();
  });

  it("drop is only a GOAL-words reading — never a value port's intent", () => {
    expect(validateReplies(replies({ qid: "unclear:manager:data", intent: "drop", value: "leave manager out of the flow" }), QS)?.answers)
      .toEqual({ "unclear:manager:data": "leave manager out of the flow" });
    expect(validateReplies(replies({ qid: "delivery:0:delivery", intent: "drop", value: "drop delivery" }), QS)).toBeNull();
    expect(validateReplies(replies({ qid: "shape:0:0:threshold", intent: "drop", value: "drop it" }), QS)).toBeNull();
  });

  it("new_instruction stands alone — a whole reply that answers nothing", () => {
    expect(validateReplies(replies({ qid: "unclear:manager:data", intent: "new_instruction", value: null }), QS))
      .toEqual({ answers: {}, deferred: [], newInstruction: true });
  });
  it("S5: one bad entry no longer poisons the good ones — valid entries are kept", () => {
    // Unknown qid beside a good answer: good kept, unknown dropped.
    expect(validateReplies(replies(
      { qid: "delivery:0:delivery", intent: "answer", value: "#ops" },
      { qid: "never_asked", intent: "answer", value: "x" },
    ), QS)).toEqual({ answers: { "delivery:0:delivery": "#ops" }, deferred: [], newInstruction: false });
    // Confirm carrying a value beside a good answer: confirm dropped, answer kept.
    expect(validateReplies(replies(
      { qid: "delivery:0:delivery", intent: "answer", value: "#ops" },
      { qid: "unclear:manager:data", intent: "confirm", value: "yes definitely" },
    ), QS)).toEqual({ answers: { "delivery:0:delivery": "#ops" }, deferred: [], newInstruction: false });
    // new_instruction mixed with an answer: the answer stands, the instruction is dropped.
    expect(validateReplies(replies(
      { qid: "delivery:0:delivery", intent: "answer", value: "#ops" },
      { qid: "unclear:manager:data", intent: "new_instruction", value: null },
    ), QS)).toEqual({ answers: { "delivery:0:delivery": "#ops" }, deferred: [], newInstruction: false });
    // Off-option chip beside a good defer: defer kept, bad chip dropped.
    expect(validateReplies(replies(
      { qid: "unclear:manager:data", intent: "defer", value: null },
      { qid: "shape:0:0:threshold", intent: "answer", value: "whatever" },
    ), QS)).toEqual({ answers: {}, deferred: ["unclear:manager:data"], newInstruction: false });
  });
  it("S5: null only when NOTHING valid remains", () => {
    expect(validateReplies(replies({ qid: "never_asked", intent: "answer", value: "x" }), QS)).toBeNull();
    expect(validateReplies(replies({ qid: "delivery:0:delivery", intent: "answer", value: "  " }), QS)).toBeNull();
    expect(validateReplies(replies({ qid: "delivery:0:delivery", intent: "drop", value: "drop delivery" }), QS)).toBeNull();
  });

  it("an empty reply set is rejected — the read answered nothing", () => {
    expect(validateReplies(replies(), QS)).toBeNull();
    expect(validateReplies({}, QS)).toBeNull();
    expect(validateReplies(null, QS)).toBeNull();
  });
});

describe("reply intents: the prompt carries the whole context", () => {
  it("the goal, every question's ask, its options, and the reply are all in view", () => {
    const p = replyPrompt({ goal: "list employees by manager", answers: { "unclear:x:data": "weekly" }, questions: QS, reply: "leave it" });
    expect(p).toContain("list employees by manager");
    expect(p).toContain("unclear:manager:data");
    expect(p).toContain("no manager column exists");
    expect(p).toContain("#ops | #general");
    expect(p).toContain("leave it");
    expect(p).toContain("weekly"); // prior answers give the read its history
    expect(p).toContain("I cannot give X from this data"); // the judgment rule that fixes the field case
  });
});

describe("reply intents: a failed read is a fallback, never a throw", () => {
  const q: GroupQuestion[] = [{ holeId: "a", ask: "A?" }];
  it("a chooser that throws → null", async () => {
    const boom: Chooser = async () => { throw new Error("gateway 500"); };
    await expect(interpretReplies({ goal: "g", answers: {}, questions: q, reply: "x" }, boom)).resolves.toBeNull();
  });
  it("malformed JSON → null", async () => {
    const junk: Chooser = async () => "not json {";
    expect(await interpretReplies({ goal: "g", answers: {}, questions: q, reply: "x" }, junk)).toBeNull();
  });
  it("schema-valid but validator-rejected (unknown qid) → null", async () => {
    const evil: Chooser = async () => JSON.stringify(replies({ qid: "never_asked", intent: "answer", value: "x" }));
    expect(await interpretReplies({ goal: "g", answers: {}, questions: q, reply: "x" }, evil)).toBeNull();
  });
  it("a well-formed read → routed", async () => {
    const good: Chooser = async () => JSON.stringify(replies({ qid: "a", intent: "answer", value: "the value" }));
    expect(await interpretReplies({ goal: "g", answers: {}, questions: q, reply: "the value" }, good))
      .toEqual({ answers: { a: "the value" }, deferred: [], newInstruction: false });
  });
});
