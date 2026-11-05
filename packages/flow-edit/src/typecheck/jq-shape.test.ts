/** The transform result shape is read, not guessed (r11 R11/L2 were refused on green runs). */
import { describe, expect, it } from "vitest";
import { jqResultShape } from "./signature.js";

describe("jqResultShape", () => {
  it("r11 R11: a paren group ending in an object, then the lowering's if/else", () => {
    expect(jqResultShape('(.employees | map(select(.a < 80)) as $rows | {text: ($rows | length | tostring)}) | if type == "string" then {text: .} else . end')).toBe("object");
  });
  it("r7 R01: a paren group ending in map(…) is a list", () => {
    expect(jqResultShape("(.employees | map({to: .email}))")).toBe("list");
  });
  it("objects and lists by their last stage", () => {
    expect(jqResultShape("{a: 1}")).toBe("object");
    expect(jqResultShape("[.[] | {a: .b}]")).toBe("list");
    expect(jqResultShape(".rows | sort_by(.n)")).toBe("list");
    expect(jqResultShape('map(.x) | {text: (map(.n) | join("|"))}')).toBe("object");
  });
  it("CONTROL: undecidable is unknown, never a guess", () => {
    expect(jqResultShape('(map(.a) | tostring) | if type == "string" then {text: .} else . end')).toBe("unknown");
    expect(jqResultShape(".[0]")).toBe("unknown");
    expect(jqResultShape("if .a then [1] else {b: 1} end")).toBe("unknown");
  });
  it("brackets and pipes inside strings do not split", () => {
    expect(jqResultShape('{t: "a | [b"}')).toBe("object");
    expect(jqResultShape('[.[] | "x \\(.a | tostring) ]"]')).toBe("list");
  });
});
