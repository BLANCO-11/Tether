import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * T028 (US4, guardrail-port V4/V5/V8) — `policy_reject`/`policy_transform`
 * must reach the client exactly as `runGeneration()`/`flowChatService.turn()`
 * produced them, the same way `insufficient_contract`/`insufficient_catalogue`
 * already do (D-38: a refusal is a 200, its own terminal status, never
 * filtered into a narrower shape a client might mistake for an error).
 *
 * A source-scan rather than an HTTP test: the property under test is the
 * ABSENCE of a route-level branch that special-cases `outcome.status`, and a
 * missing branch is exactly what a runtime test cannot see (it would just
 * pass, having never exercised the deleted-in-spirit path).
 */

const flowsSource = readFileSync(
  fileURLToPath(new URL("./flows.ts", import.meta.url)),
  "utf8",
);
const flowChatSource = readFileSync(
  fileURLToPath(new URL("./flow-chat.ts", import.meta.url)),
  "utf8",
);

describe("routes/flow-chat.ts — POST turns forwards the outcome unfiltered", () => {
  it("responds with the whole outcome object", () => {
    expect(flowChatSource).toContain("res.json(outcome);");
  });

  it("has no branch naming policy_reject or policy_transform in the route itself", () => {
    expect(flowChatSource).not.toContain('"policy_reject"');
    expect(flowChatSource).not.toContain('"policy_transform"');
  });
});
