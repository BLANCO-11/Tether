// frontend plan Phase 5 task 5.0 (FE-5.1) — pin the write path: *an armed flow
// refined by an edit stays armed, with the draft revision behind it*.
//
// The guarantee is `writeRevision` having no live branch (flow.service.ts:250-260,
// §6.5). That guarantee is asserted behaviorally against real Kestra by
// `kestra/phase3-verify.ts:247-268` for the page-edit path. What was asserted
// NOWHERE is the same claim for the chat and canvas paths — the writers that
// reach `writeRevision` from outside the approval gate. (Refine was the other;
// it went with the generation path, phase 8 D-333.)
//
// These tests read SOURCE rather than exercising behaviour, deliberately: the
// property is an ABSENCE (`armed_revision` must have exactly one writer), and an
// absence cannot be observed by calling something. Same shape as
// `flow-chat-imports.test.ts`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const flowService = here("./flow.service.ts");
const chatService = here("./flow-chat.service.ts");
const canvasService = here("./builder/canvas.service.ts");
const approvalService = here("./flow-approval.service.ts");

/** Every `flowRepo.update( … )` call in a source file, body included. */
function updateCalls(source: string): string[] {
  const out: string[] = [];
  let from = source.indexOf("flowRepo.update(");
  while (from !== -1) {
    let depth = 0;
    let i = source.indexOf("(", from) + 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    out.push(source.slice(from, i + 1));
    from = source.indexOf("flowRepo.update(", i);
  }
  return out;
}

describe("an armed flow refined by an edit stays armed — the write path pin (FE-5.1)", () => {
  it("writeRevision's flowRepo.update never carries armedRevision", () => {
    const calls = updateCalls(flowService);
    // writeRevision (`{ draftRevision, status }`) + updateMeta (`name`/`description`).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).not.toMatch(/armedRevision/);
    }
  });

  it("the canvas writes through flowService.writeRevision and never names armedRevision", () => {
    expect(canvasService).toMatch(/flowService\.writeRevision\(/);
    expect(canvasService).not.toMatch(/armedRevision/);
  });

  it("the approval path is the ONE writer of armed_revision — the control", () => {
    // The count is what makes this a control rather than a wish: if a second
    // writer ever appears, this test fails with the candidate already named.
    const writers =
      (flowService.match(/armedRevision:/g) ?? []).length +
      (chatService.match(/armedRevision:/g) ?? []).length +
      (canvasService.match(/armedRevision:/g) ?? []).length;
    expect(writers).toBe(0);
    // And the one legitimate writer still does its job.
    expect(approvalService).toMatch(/flowRepo\.update\(flow\.id, \{ armedRevision: input\.revision, status(, \.\.\.ANSWERED)? \}\)/);
    const approvalWriters = (approvalService.match(/armedRevision:/g) ?? []).filter((s) =>
      s.includes("armedRevision:"),
    ).length;
    expect(approvalWriters).toBeGreaterThanOrEqual(1);
  });

  it("the status flips to draft_pending, never away from armed — read from the source", () => {
    // writeRevision's status is derived from the armed revision's presence; a
    // draft edit can put a NEW draft behind the armed one but must never clear
    // the armed revision to do it.
    const writeRev = flowService.slice(flowService.indexOf("async writeRevision"), flowService.indexOf("async saveRevision"));
    expect(writeRev).toMatch(/flow\.armedRevision != null \? "draft_pending" : "draft"/);
    expect(writeRev).not.toMatch(/armedRevision: null/);
    expect(writeRev).not.toMatch(/armedRevision: undefined/);
  });
});
