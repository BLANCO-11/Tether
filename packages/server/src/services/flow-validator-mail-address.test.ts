import { describe, expect, it } from "vitest";
import {
  checkMailAddressSteps,
  checkMailFlatAttachments,
  flowValidator,
  FlowValidationError,
} from "./flow-validator.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * Literal addresses on mail steps must be shaped like addresses.
 *
 * Measured 2026-09-14: a prod flow carried `sender: "HR Compliance"` on
 * `mail_send_template` — through every authoring check, dead ×10 at the run.
 * The run-time 422 stays; this is the save-time net. Only plain-JSON
 * paramsExpr is inspected — templates and jq programs are skipped, never
 * guessed at.
 */

const mailStep = (ref: string, params: unknown, over: Record<string, unknown> = {}) => ({
  id: "send",
  kind: "tool",
  ref,
  paramsExpr: typeof params === "string" ? params : JSON.stringify(params),
  ...over,
});

const model = (steps: Array<Record<string, unknown>>): FlowModel =>
  ({ id: "f", steps }) as unknown as FlowModel;

const GOOD = [{ sender: "ops@example.com", recipients: ["team@example.com"], subject: "S", body: "B" }];

describe("checkMailAddressSteps", () => {
  it("refuses a display name as sender, naming step, field and ref", () => {
    const findings = checkMailAddressSteps(
      model([mailStep("mail_send_template", [{ sender: "HR Compliance", recipients: ["a@example.com"] }])]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("mail_invalid_address");
    expect(findings[0]!.stepId).toBe("send");
    expect(findings[0]!.message).toContain('"sender"');
    expect(findings[0]!.message).toContain('"HR Compliance"');
    expect(findings[0]!.message).toContain("mail_send_template");
  });

  it("refuses one bad address inside a recipients array", () => {
    const findings = checkMailAddressSteps(
      model([mailStep("mail_send", [{ sender: "ops@example.com", recipients: ["good@example.com", "all staff"] }])]),
    );
    expect(findings.some((f) => f.rule === "mail_invalid_address")).toBe(true);
  });

  it("accepts real addresses on every mail ref", () => {
    for (const ref of ["mail_send", "mail_send_template", "foundry_email_send", "test_email_send"]) {
      expect(checkMailAddressSteps(model([mailStep(ref, GOOD)]))).toEqual([]);
    }
  });

  it("skips template params it cannot see — never guesses", () => {
    expect(
      checkMailAddressSteps(model([mailStep("mail_send", "{{ outputs.prev.value | first }}")])),
    ).toEqual([]);
    expect(
      checkMailAddressSteps(model([mailStep("mail_send", '{{ [{sender: "HR Compliance"}] | first }}')])),
    ).toEqual([]);
  });

  it("skips unparseable exprs and non-mail tools carrying address-named keys", () => {
    expect(checkMailAddressSteps(model([mailStep("mail_send", "not json at all")]))).toEqual([]);
    expect(
      checkMailAddressSteps(model([mailStep("chat_post_message", [{ to: "#general", text: "hi" }])])),
    ).toEqual([]);
    expect(
      checkMailAddressSteps(model([mailStep("fetch_rows", [{ to: "HR Compliance" }])])),
    ).toEqual([]);
  });

  it("fires through assertValid, blocking the save", () => {
    expect(() =>
      flowValidator.assertValid(
        model([mailStep("mail_send_template", [{ sender: "HR Compliance" }])]),
        ["mail_send_template"],
      ),
    ).toThrow(FlowValidationError);
  });
});

describe("checkMailFlatAttachments", () => {
  it("refuses attach_rows without attach_name and attach_format", () => {
    const findings = checkMailFlatAttachments(
      model([
        mailStep("foundry_email_send", {
          to: ["me@example.com"],
          subject: "Budgets",
          body: "See attached",
          attach_rows: "{{ outputs.read.value | first }}",
        }),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("mail_flat_attachment");
    expect(findings[0]!.message).toMatch(/without attach_name/);
  });

  it("accepts a complete flat attachment triple", () => {
    expect(
      checkMailFlatAttachments(
        model([
          mailStep("foundry_email_send", {
            to: ["me@example.com"],
            subject: "Budgets",
            body: "See attached",
            attach_rows: "{{ outputs.read.value | first }}",
            attach_name: "budgets",
            attach_format: "csv",
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses attach_name without attach_rows", () => {
    const findings = checkMailFlatAttachments(
      model([mailStep("foundry_email_send", { to: ["a@example.com"], attach_name: "x", attach_format: "csv" })]),
    );
    expect(findings[0]!.message).toMatch(/without attach_rows/);
  });

  it("accepts attach_rows bound the engine's way (whole + text) — not only paramsExpr", () => {
    // The builder binds rows via bind{from:"text"} → stored as {from:"whole", transform:"text"}.
    // A check that only sees step/literal/expression slanders that complete triple as half-bound.
    expect(
      checkMailFlatAttachments(
        model([
          {
            id: "call_1",
            kind: "tool",
            ref: "foundry_email_send",
            paramsExpr: "",
            inputs: [
              { name: "attach_format", source: { from: "literal", value: "xlsx" } },
              { name: "attach_name", source: { from: "literal", value: "Absence results" } },
              { name: "attach_rows", source: { from: "whole", stepId: "read_1", transform: "text" } },
              { name: "body", source: { from: "literal", value: "The absence results are attached." } },
              { name: "subject", source: { from: "literal", value: "Absence results" } },
            ],
            dependsOn: ["read_1"],
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("CONTROL: typed inputs with name/format and NO rows still refuse", () => {
    expect(
      checkMailFlatAttachments(
        model([
          {
            id: "call_1",
            kind: "tool",
            ref: "foundry_email_send",
            paramsExpr: "",
            inputs: [
              { name: "attach_format", source: { from: "literal", value: "csv" } },
              { name: "attach_name", source: { from: "literal", value: "x" } },
            ],
          },
        ]),
      )[0]!.message,
    ).toMatch(/without attach_rows/);
  });

  it("fires through assertValid", () => {
    expect(() =>
      flowValidator.assertValid(
        model([mailStep("foundry_email_send", { to: ["a@example.com"], attach_rows: "[]" })]),
        ["foundry_email_send"],
      ),
    ).toThrow(FlowValidationError);
  });
});

describe("checkMailAddressSteps on typed bindings (phase 3 step 3)", () => {
  const typed = (to: unknown) =>
    model([{ id: "mail", kind: "tool", ref: "foundry_email_send", paramsExpr: "", inputs: [{ name: "to", source: to }, { name: "subject", source: { from: "literal", value: "x" } }] }]);
  it("refuses a literal `to` that is not an address", () => {
    expect(checkMailAddressSteps(typed({ from: "literal", value: "Finance Team" })).length).toBeGreaterThan(0);
  });
  it("CONTROL: a real literal address, or a row-sourced one, is accepted", () => {
    expect(checkMailAddressSteps(typed({ from: "literal", value: "ops@acme.example" }))).toEqual([]);
    expect(checkMailAddressSteps(typed({ from: "step", stepId: "v", field: "email" }))).toEqual([]);
  });
});
