/**
 * Route golden corpus — Strategy B Phase 4b.
 * Confusable messages × context → expected RouteKind. Uses the real routePrompt
 * + schema via a stub chooser that returns the expected kind (contract that the
 * kind remains offered), plus live kind-availability asserts.
 */
import { describe, expect, it } from "vitest";
import { routeKinds, routeMessage, type RouteKind } from "./chat-route.js";

type Case = { id: string; message: string; hasSteps: boolean; asking: boolean; expect: RouteKind };

/** Frozen confusable set — domain-free wording. */
export const ROUTE_CORPUS: Case[] = [
  { id: "R01", message: "thanks!", hasSteps: false, asking: false, expect: "chat" },
  { id: "R02", message: "what can you build here?", hasSteps: false, asking: false, expect: "capabilities" },
  { id: "R03", message: "email me overdue loans every Monday", hasSteps: false, asking: false, expect: "build" },
  { id: "R04", message: "what does this automation do?", hasSteps: true, asking: false, expect: "about_flow" },
  { id: "R05", message: "change the recipient to me@example.com", hasSteps: true, asking: false, expect: "change" },
  { id: "R06", message: "send it to me@example.com instead", hasSteps: true, asking: true, expect: "change" },
  { id: "R07", message: "the high ones", hasSteps: true, asking: true, expect: "answer" },
  { id: "R08", message: "what does the branch do?", hasSteps: true, asking: true, expect: "about_flow" },
  { id: "R09", message: "also post a summary to chat", hasSteps: true, asking: true, expect: "build" },
  { id: "R10", message: "leave it", hasSteps: true, asking: true, expect: "answer" },
];

describe("route corpus availability", () => {
  it("while asking, about_flow and change remain offered (pending must not swallow)", () => {
    const kinds = routeKinds(true, true);
    expect(kinds).toContain("answer");
    expect(kinds).toContain("about_flow");
    expect(kinds).toContain("change");
    expect(kinds).toContain("build");
    expect(kinds).toContain("chat");
  });

  it("without steps, change and about_flow are not offered", () => {
    const kinds = routeKinds(false, false);
    expect(kinds).not.toContain("change");
    expect(kinds).not.toContain("about_flow");
    expect(kinds).toContain("build");
  });

  it("stub chooser returns expected kind for each corpus row when that kind is offered", async () => {
    for (const c of ROUTE_CORPUS) {
      const offered = routeKinds(c.hasSteps, c.asking);
      if (!offered.includes(c.expect)) {
        throw new Error(`${c.id}: expected ${c.expect} not in offered ${offered.join(",")}`);
      }
      const kind = await routeMessage(c.message, c.hasSteps, async () => JSON.stringify({ kind: c.expect }), c.asking ? "Which field means priority?" : undefined);
      expect(kind, c.id).toBe(c.expect);
    }
  });
});
