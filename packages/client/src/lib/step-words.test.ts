import { describe, expect, it } from "vitest";
import type { EFlow } from "@foundry/flow-edit";
import { stepWords } from "./engine-canvas";

// A step in plain words, read off the step itself — the same rule for a component this code has never seen.
const f = {
  id: "f",
  steps: [
    { id: "r", kind: "datasource", ref: "acme_ops.late_parcels_by_depot", inputs: [], dependsOn: [] },
    { id: "c", kind: "tool", ref: "zz_unknown-widget_fire", inputs: [{ name: "q", source: { from: "step", stepId: "r", field: "x" } }, { name: "label", source: { from: "literal", value: "Parcel late" } }], dependsOn: [] },
    { id: "bare", kind: "tool", ref: "ping_all", inputs: [{ name: "n", source: { from: "literal", value: 3 } }], dependsOn: [] },
    { id: "o", kind: "branch", elseOf: "w", dependsOn: [] },
  ],
} as unknown as EFlow;

describe("stepWords", () => {
  it("names a read and a call from their own declarations, with the call's first fixed text", () => {
    expect(stepWords(f, "r")).toBe("read late parcels by depot");
    expect(stepWords(f, "c")).toBe("zz unknown widget fire — “Parcel late”");
  });
  it("CONTROL: a call with no fixed text is its name alone (a non-text literal is not quoted); an unknown id is itself", () => {
    expect(stepWords(f, "bare")).toBe("ping all");
    expect(stepWords(f, "o")).toBe("otherwise");
    expect(stepWords(f, "nope")).toBe("nope");
  });
});
