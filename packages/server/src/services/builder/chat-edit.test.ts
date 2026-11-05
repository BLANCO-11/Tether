/**
 * Chat edits (phase X, D-336/D-337) — the decision half, over engine states walked on the synthetic catalogue:
 *   - the chooser is offered the canvas's actions and nothing else — never the palette;
 *   - a destructive action is NEVER applied without a confirmation (asserted over every walked state's every such action);
 *   - the same action at several steps, with no words naming one, asks which;
 *   - a value is the person's words, or it is asked for;
 *   - every action decided `apply` applies to a state the checker accepts (P1, through chat).
 */
import { describe, expect, it } from "vitest";
import { canvasActions, checkState, emptyFlow, errorsOf, SYNTHETIC, walk, type CanvasAction, type EFlow } from "@foundry/flow-edit";
import { applyEdit, chooseEdit, decide, editable, findByKey, isDestructive, keyOf } from "./chat-edit.js";
import { pendingOf, replyTo } from "./chat-edit.service.js";
import { editTurnPatch } from "../flow-chat-builder.js";

const cat = SYNTHETIC;
/** Walked states with steps — the shapes a real flow has, reached only by legal moves. */
const states = (): EFlow[] => {
  const out: EFlow[] = [];
  for (let seed = 1; seed <= 60; seed++) for (const s of walk(emptyFlow("t"), cat, 2 + (seed % 12), seed)) if (s.flow.steps.length) out.push(s.flow);
  return out;
};
const ALL = states();

describe("the chooser is offered the canvas's edits, not its palette", () => {
  it("editable = the canvas's actions minus the palette, plus pin-path palette additions", () => {
    let seen = 0, palSeen = 0;
    for (const f of ALL.slice(0, 40)) {
      const all = canvasActions(f, cat), ed = editable(f, cat);
      // Pin-path additions only: palette entries with a one-shot add op. Nothing else from the palette.
      expect(ed.filter((a) => a.where.at === "palette").every((a) => !!a.op && ["add_reader", "add_call", "add_transform", "add_branch", "add_otherwise", "add_merge", "add_loop", "add_gate"].includes(a.op.op))).toBe(true);
      palSeen += ed.filter((a) => a.where.at === "palette").length;
      // minus the two edits that never make a change whole from chat (P4 R8, P7 E07): declaring an input alone, clearing a required port
      const whole = all.filter((a) => a.where.at !== "palette" && a.slot?.kind !== "declare_input");
      expect(ed.filter((a) => a.where.at !== "palette").length).toBeLessThanOrEqual(whole.length);
      expect(whole.filter((a) => !ed.some((e) => e.id === a.id)).every((a) => a.op?.op === "unbind")).toBe(true);
      seen += ed.length;
    }
    expect(seen).toBeGreaterThan(0); // CONTROL: the walk reached states with edits at all
    expect(palSeen).toBeGreaterThan(0); // CONTROL: palette additions really ride the pin path
  });

  it("the model's enum is exactly those ids (plus none_fit), and none_fit picks nothing", async () => {
    const f = ALL.find((x) => editable(x, cat).length > 1)!;
    let enumSeen: string[] = [];
    const out = await chooseEdit("change it", f, cat, async (_p, schema) => {
      enumSeen = ((schema.schema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum);
      return JSON.stringify({ action: "none_fit", step_words: "", value: "", value_meant: "", shape_columns: [] });
    });
    expect(enumSeen.sort()).toEqual([...editable(f, cat).map((a) => a.id), "none_fit"].sort());
    expect(out.pick).toBeNull();
    expect(out.calls).toBe(1);
  });
});

describe("D-337 — what code decides", () => {
  it("⚠ a destructive action is NEVER decided `apply` — over every walked state's every such action", () => {
    let destructive = 0;
    for (const f of ALL) {
      const acts = editable(f, cat);
      for (const a of acts.filter(isDestructive)) {
        destructive++;
        // Even with the step named, the only way to it is a confirmation (or a which-step question first).
        const d = decide("remove it", a, acts, { stepNamed: true });
        expect(d.status, `${a.label} at ${JSON.stringify(a.where)}`).toBe("confirm");
      }
    }
    expect(destructive).toBeGreaterThan(20); // CONTROL: removals were really offered and checked
  });

  it("CONTROL: a non-destructive op action with its step named is applied directly", () => {
    const f = ALL.find((x) => editable(x, cat).some((a) => a.op && !isDestructive(a)))!;
    const acts = editable(f, cat);
    const a = acts.find((x) => x.op && !isDestructive(x))!;
    expect(decide("do it", a, acts, { stepNamed: true }).status).toBe("apply");
  });

  it("the same action at several steps, with no words naming one, asks WHICH — and a quoted name resolves it", () => {
    const f = ALL.find((x) => editable(x, cat).filter((a) => a.label === "remove this step").length >= 2)!;
    expect(f).toBeTruthy();
    const acts = editable(f, cat);
    const a = acts.find((x) => x.label === "remove this step")!;
    const asked = decide("remove the step", a, acts, {});
    expect(asked.status).toBe("which_step");
    if (asked.status === "which_step") expect(asked.candidates.length).toBeGreaterThanOrEqual(2);
    const stepId = (a.where as { stepId: string }).stepId;
    // Named in the message's own words → no question, straight to the confirmation.
    expect(decide(`remove ${stepId}`, a, acts, { stepWords: stepId }).status).toBe("confirm");
    // Words the message does not contain name nothing.
    expect(decide("remove the step", a, acts, { stepWords: stepId }).status).toBe("which_step");
  });

  it("a slot's value is the person's words — absent, or not in the message, it is ASKED", () => {
    const f = ALL.find((x) => editable(x, cat).some((a) => a.slot))!;
    const acts = editable(f, cat);
    const a = acts.find((x) => x.slot)!;
    expect(decide("set it", a, acts, { stepNamed: true }).status).toBe("ask_value");
    const invented = decide("set it", a, acts, { stepNamed: true, value: "42" });
    expect(invented).toMatchObject({ status: "ask_value", why: "“42” is not in your message" });
    expect(decide("set it to 42", a, acts, { stepNamed: true, value: "42" })).toMatchObject({ status: "apply", value: "42" });
  });

  it("P1 through chat: every op action decided `apply` lands on a state the checker accepts", () => {
    let applied = 0;
    for (const f of ALL.slice(0, 80)) {
      const acts = editable(f, cat);
      for (const a of acts.filter((x) => x.op)) {
        const d = decide("x", a, acts, { stepNamed: true });
        if (d.status !== "apply") continue;
        const r = applyEdit(f, cat, a);
        expect(r.ok, a.label).toBe(true);
        if (r.ok) { applied++; expect(errorsOf(checkState(r.flow, cat))).toEqual([]); }
      }
    }
    expect(applied).toBeGreaterThan(50);
  });
});

describe("D-338 — the pending decision rides on its question and is re-found by place + label", () => {
  it("findByKey re-finds an action on a fresh listing, and finds nothing for a key that is gone", () => {
    const f = ALL.find((x) => editable(x, cat).length > 2)!;
    const acts = editable(f, cat);
    const a: CanvasAction = acts[1]!;
    expect(findByKey(editable(f, cat), keyOf(a))?.label).toBe(a.label);
    expect(findByKey(acts, { where: { at: "step", stepId: "no_such_step" }, label: a.label })).toBeUndefined();
  });

  it("a needs_input patch carries its pending, and pendingOf reads it back; anything else is null", () => {
    const pending = { kind: "confirm" as const, message: "remove a", key: { where: { at: "step" as const, stepId: "a" }, label: "remove this step" } };
    const patch = editTurnPatch({ status: "needs_input", text: "t", question: { id: "edit_confirm", question: "Do it?", allow_custom: false }, pending });
    expect(patch.status).toBe("needs_input");
    expect(pendingOf(patch.findingsJson)).toEqual(pending);
    expect(JSON.parse(patch.findingsJson[0]!).questions[0].id).toBe("edit_confirm");
    expect(pendingOf([JSON.stringify({ text: "t", questions: [] })])).toBeNull(); // the builder's own questions carry none
    expect(pendingOf(["not json"])).toBeNull();
  });

  it("a complete-save drafted confirm rides the question payload and pendingOf reads it (flow 8194a125: 'yes' was chat)", () => {
    // The builderTurnPatch asks path serialises question.pending beside the question; the next turn's
    // pendingOf must surface it so the reply is consumed as an answer, never routed as chatter.
    const payload = [JSON.stringify({ text: "So far: it reads …", questions: [{ id: "drafted_call_1_wording", question: "I drafted this subject “Leave applications summary” from your goal — use it?", allow_custom: true, pending: { kind: "drafted", key: "drafted:call_1:wording", subject: "Leave applications summary" } }] })];
    expect(pendingOf(payload)).toEqual({ kind: "drafted", key: "drafted:call_1:wording", subject: "Leave applications summary" });
  });

  it("replyTo strips only its own question's prefix", () => {
    expect(replyTo("edit_value: finance@x.example", "edit_value")).toBe("finance@x.example");
    expect(replyTo("confirm", "edit_confirm")).toBe("confirm");
    expect(replyTo("other_q: y", "edit_value")).toBe("other_q: y");
  });

  it("an answered reply keeps its lines as one paragraph", () => {
    expect(editTurnPatch({ status: "answered", lines: ["a", "b"] })).toEqual({ status: "answered", findingsJson: ["a\nb"] });
  });
});

describe("an action of several ops is destructive when any of them removes (phase C)", () => {
  it("removing a condition on one value with its test asks first; CONTROL: adding one does not", () => {
    expect(isDestructive({ id: "c1", where: { at: "step", stepId: "when_1" }, label: "remove this step", ops: [{ op: "remove_step", stepId: "when_1" }, { op: "remove_step", stepId: "test_1" }] })).toBe(true);
    expect(isDestructive({ id: "c2", where: { at: "step", stepId: "read_1" }, label: "add", ops: [{ op: "add_reader", id: "read_2", ref: "x" }] })).toBe(false);
  });
});

// 2026-10-01 (47d1e01e): "start input should be date" added a second, unread input and left the month — the engine offered no way
// to change an input's type, so the nearest listed action was "add one". The retype is offered now, and an unread input is said.
describe("changing how an input is asked is offered as ITSELF, and an input nothing reads is said", () => {
  const F: EFlow = (() => {
    let f = emptyFlow("t");
    for (const op of [
      { op: "declare_input", id: "period", type: "DATE" },
      { op: "add_reader", id: "read", ref: "store.widgets" },
      { op: "bind", stepId: "read", port: "as_of", source: { from: "input", inputId: "period" } },
    ] as const) { const r = applyEdit(f, cat, { id: "x", where: { at: "flow" }, label: "", op } as unknown as CanvasAction); if (r.ok) f = r.flow; }
    return f;
  })();
  it("the edit list offers asking for the existing input as another type — not only a new input beside it", async () => {
    const { unreadInputs } = await import("./chat-edit.service.js");
    const labels = editable(F, cat).map((a) => a.label);
    const read = F.steps.find((s) => s.id === "read") as { inputs: Array<{ name: string; source?: unknown }> };
    expect(read.inputs.find((b) => b.name === "as_of")?.source).toMatchObject({ from: "input", inputId: "period" });
    // A month asked where a date is meant: the same input, asked as a date, is offered as itself.
    const month = applyEdit(emptyFlow("t"), cat, { id: "x", where: { at: "flow" }, label: "", op: { op: "declare_input", id: "period", type: "STRING", format: "month" } } as unknown as CanvasAction);
    expect(month.ok && editable(month.flow, cat).map((a) => a.label)).toContain("ask for period as a date instead");
    // CONTROL: only types its readers still take are offered — a date port read by \`read\` takes no other.
    expect(labels.filter((l) => /^ask for period as .* instead$/.test(l))).toEqual([]);
    expect(unreadInputs(F, cat)).toEqual([]);
  });
  it("an input no step reads is the engine's own: the ones it would let a person stop asking for", async () => {
    const { unreadInputs } = await import("./chat-edit.service.js");
    const r = applyEdit(F, cat, { id: "x", where: { at: "flow" }, label: "", op: { op: "declare_input", id: "input", type: "DATE" } } as unknown as CanvasAction);
    expect(r.ok && unreadInputs(r.flow, cat)).toContain("input");
  });
});
