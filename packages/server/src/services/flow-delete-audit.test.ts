import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A workflow deleted with no trace (flow e2cbacc1, pi-runtime P4) — the audit record is written in the ONE function
 * every delete passes, before the row goes, and the route hands it the person. Read off disk, with a control that the
 * files were actually read (an empty read would pass any "does not contain").
 */
const service = readFileSync(resolve(__dirname, "flow.service.ts"), "utf8");
const route = readFileSync(resolve(__dirname, "../routes/flows.ts"), "utf8");

describe("deleting a workflow is recorded", () => {
  it("control: both files were read", () => {
    expect(service.length).toBeGreaterThan(10_000);
    expect(route).toContain("flowsRouter.delete(");
  });

  it("remove() records a delete event before it deletes the row", () => {
    const body = service.slice(service.indexOf("async remove(workspaceId: string, flowId: string, by"));
    const end = body.indexOf("return flowRepo.remove(");
    expect(end).toBeGreaterThan(0);
    const before = body.slice(0, end);
    expect(before).toMatch(/auditService\.record\(\{[\s\S]*operation: "delete"[\s\S]*entity: "flow"/);
  });

  it("the DELETE route names the person, from the verified identity", () => {
    expect(route).toContain("flowService.remove(req.params.workspaceId, req.params.flowId, requesterOf(req).actor)");
  });
});
