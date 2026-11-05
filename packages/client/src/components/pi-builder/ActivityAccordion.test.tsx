import { describe, expect, it } from "vitest";
import { activityStatusNote } from "./ActivityAccordion";
import type { PiActivity } from "@/lib/pi-builder";

const act = (kind: PiActivity["kind"], title: string, status: PiActivity["status"] = "running"): PiActivity => ({
  id: title, tool: kind, kind, title, detail: "", status, startedAt: "",
});

describe("what Forge is doing, as a sentence — never a file name", () => {
  it("names the step it is writing, in words", () => {
    expect(activityStatusNote([act("write", "steps/send_report/main.py")])).toBe("Writing the “send report” step…");
  });
  it("the workflow, the catalogue and a question each read as what they are", () => {
    expect(activityStatusNote([act("write", "workflow.json")])).toBe("Laying out the steps…");
    expect(activityStatusNote([act("read", "catalogue.json")])).toBe("Looking at what this workspace has…");
    expect(activityStatusNote([act("write", "questions.json")])).toBe("Preparing a question for you…");
  });
  it("control: nothing running says nothing", () => {
    expect(activityStatusNote([act("write", "workflow.json", "done")])).toBeNull();
  });
});
