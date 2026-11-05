import { describe, expect, it } from "vitest";
import { inWhere, whereOf } from "./places";

describe("where an item lives, as a filter", () => {
  it("a project wins over visibility; otherwise the Workspace is public and My space is everything else", () => {
    expect(whereOf({ visibility: "public", projectId: "p1" })).toBe("project");
    expect(whereOf({ visibility: "public" })).toBe("workspace");
    expect(whereOf({ visibility: "private" })).toBe("mine");
    expect(whereOf({})).toBe("mine");
  });
  it("Anywhere keeps everything; each place keeps only its own", () => {
    const items = [{ visibility: "private" }, { visibility: "public" }, { visibility: "private", projectId: "p" }];
    expect(items.filter((i) => inWhere(i, "any"))).toHaveLength(3);
    expect(items.filter((i) => inWhere(i, "project"))).toEqual([items[2]]);
    expect(items.filter((i) => inWhere(i, "workspace"))).toEqual([items[1]]);
  });
});
