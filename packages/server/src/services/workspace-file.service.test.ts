/** Which workflows use a workspace file: every `file:<name>` in any step's uses, at any depth. */
import { describe, expect, it } from "vitest";
import { filesUsedBy } from "./workspace-file.service.js";

describe("filesUsedBy", () => {
  it("finds file uses in top-level steps, loops and branch paths, and nothing else", () => {
    const model = {
      workflow: {
        steps: [
          { id: "a", uses: ["read:x", "file:Rates.xlsx"] },
          { id: "each", foreach: "a.rows", steps: [{ id: "b", uses: ["file:Policy.pdf", "tool:tether_email_send"] }] },
          { id: "c", branch: [{ steps: [{ id: "d", uses: ["file:Rates.xlsx"] }] }] },
        ],
      },
      files: { "steps/a/main.py": "foundry.file('Not declared.csv')" },
    };
    expect(filesUsedBy(model).sort()).toEqual(["Policy.pdf", "Rates.xlsx"]);
  });

  it("a compiled flow's model has no uses and uses no file", () => {
    expect(filesUsedBy({ steps: [{ id: "s", kind: "query" }] })).toEqual([]);
  });
});
