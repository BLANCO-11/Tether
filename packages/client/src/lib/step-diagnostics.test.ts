import { describe, expect, it } from "vitest";
import { diagnosticsByStep, FLOW_WIDE, typeErrorBadge, typeErrorTitle } from "./step-diagnostics";

describe("diagnosticsByStep — structured (a refused save)", () => {
  it("groups by span.stepId, keeping port, help and severity", () => {
    const m = diagnosticsByStep({
      diagnostics: [
        { code: "FT0202", severity: "error", span: { stepId: "send", port: "to" }, message: "expected string", help: "bind an email", owner: "wiring" },
        { code: "FT0601", severity: "warning", span: { stepId: "send" }, message: "untyped", owner: "person" },
        { code: "FT0204", severity: "error", span: { stepId: "read" }, message: "missing input", owner: "wiring" },
      ],
    });
    expect([...m.keys()].sort()).toEqual(["read", "send"]);
    expect(m.get("send")).toEqual([
      { code: "FT0202", severity: "error", port: "to", message: "expected string", help: "bind an email" },
      { code: "FT0601", severity: "warning", message: "untyped" },
    ]);
  });

  it("puts a diagnostic with no stepId under the flow-wide key", () => {
    const m = diagnosticsByStep({ diagnostics: [{ code: "FT0101", severity: "error", span: {}, message: "no steps" }] });
    expect(m.get(FLOW_WIDE)?.[0]?.code).toBe("FT0101");
  });

  it("CONTROL: malformed entries are ignored, never thrown on", () => {
    const m = diagnosticsByStep({
      diagnostics: [null, 7, "FT0202 x: y", { code: "", message: "m" }, { code: "FT0202" }, { message: "no code" }, { code: "FT0202", message: "ok", span: "nope" }],
    });
    // Only the last is readable — and a non-object span makes it flow-wide.
    expect([...m.entries()]).toEqual([[FLOW_WIDE, [{ code: "FT0202", message: "ok", severity: "error" }]]]);
    expect(() => diagnosticsByStep({ diagnostics: { length: 3 } })).not.toThrow();
    expect(diagnosticsByStep(undefined as never).size).toBe(0);
  });

  it("structured wins — the joined message lines in findings are not counted twice", () => {
    const m = diagnosticsByStep({
      diagnostics: [{ code: "FT0202", severity: "error", span: { stepId: "send" }, message: "m" }],
      findings: ["FT0202 send: m"],
    });
    expect(m.get("send")).toHaveLength(1);
  });
});

describe("diagnosticsByStep — finding lines (a failed authored job)", () => {
  it("parses step, port, message and help", () => {
    const m = diagnosticsByStep({ findings: ["FT0202 send.to: expected string, got null — help: bind an address"] });
    expect(m.get("send")).toEqual([
      { code: "FT0202", port: "to", message: "expected string, got null", help: "bind an address", severity: "error" },
    ]);
  });

  it("a line with no step is flow-wide; a step with no port has none", () => {
    const m = diagnosticsByStep({ findings: ["FT0101: the flow has no steps", "FT0204 read_rows: missing input"] });
    expect(m.get(FLOW_WIDE)?.[0]?.message).toBe("the flow has no steps");
    expect(m.get("read_rows")?.[0]).toEqual({ code: "FT0204", message: "missing input", severity: "error" });
  });

  it("CONTROL: prose findings in the same array are left alone", () => {
    const m = diagnosticsByStep({
      findings: [
        "step send: ref tether_email_send does not exist",
        "could not draft a valid flow in 3 attempts",
        " FT0202 send: leading space is trimmed",
        "XFT0202 send: not at the start",
        "FT02 send: short code",
        { rule: "cap", stepId: "send", message: "too many steps" },
        42,
      ],
    });
    expect([...m.keys()]).toEqual(["send"]);
    expect(m.get("send")).toHaveLength(1);
    expect(m.get("send")?.[0]?.message).toBe("leading space is trimmed");
  });
});

describe("badge text", () => {
  const list = [
    { code: "FT0202", port: "to", message: "expected string", help: "bind it", severity: "error" as const },
    { code: "FT0204", message: "missing", severity: "error" as const },
  ];
  it("names the first code and how many more — never a bare colour", () => {
    expect(typeErrorBadge(list)).toBe("FT0202 +1");
    expect(typeErrorBadge(list.slice(0, 1))).toBe("FT0202");
    expect(typeErrorBadge([])).toBe("");
  });
  it("titles every diagnostic, one per line", () => {
    expect(typeErrorTitle(list)).toBe("FT0202 to: expected string — bind it\nFT0204: missing");
  });

  it("⚠ keeps a HOLE a hole — an undecided site is not painted as an error (D-317)", () => {
    const m = diagnosticsByStep({ diagnostics: [{ code: "FT0801", severity: "hole", span: { stepId: "read" }, message: "undecided: which data `read` reads is not chosen" }] });
    expect(m.get("read")?.[0]?.severity).toBe("hole");
    // CONTROL: an unreadable severity still reads as an error, as it always has.
    expect(diagnosticsByStep({ diagnostics: [{ code: "FT0202", severity: "???", span: { stepId: "s" }, message: "x" }] }).get("s")?.[0]?.severity).toBe("error");
  });
});
