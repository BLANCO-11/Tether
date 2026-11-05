import { describe, expect, it } from "vitest";
import { dualParams } from "./test-dual-params";

describe("dualParams reads as an object AND as a Promise", () => {
  it("reads a field synchronously (the Next 14 shape)", () => {
    expect(dualParams({ id: "a-1" }).id).toBe("a-1");
  });
  it("resolves to the same fields (the Next 15 / 16 shape)", async () => {
    await expect(dualParams({ id: "a-1" })).resolves.toEqual({ id: "a-1" });
    expect((await dualParams({ path: ["x", "y"] })).path).toEqual(["x", "y"]);
  });
  it("CONTROL: a plain object is not a Promise, so a test using one cannot exercise the awaited shape", () => {
    expect(typeof (({ id: "a" }) as { then?: unknown }).then).toBe("undefined");
    expect(typeof dualParams({ id: "a" }).then).toBe("function");
  });
});
