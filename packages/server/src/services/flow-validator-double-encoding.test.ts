import { describe, expect, it } from "vitest";
import { normaliseModel } from "@foundry/flow-edit";
import {
  checkDoubleEncodedJson,
  flowValidator,
  FlowValidationError,
} from "./flow-validator.service.js";

import type { FlowModel } from "./flow-compiler.service.js";

/**
 * `@json` inside an already-quoted span double-encodes — always fatal.
 *
 * Measured 2026-09-14: a prod `foundry_email_send` step carried
 * `"body": "{{ … | jq('.text | @json') | first }}"`. Kestra rendered
 * `"body": ""# …""` and its Jackson parse died before Foundry was reached.
 * Valid forms are quoted-span-with-raw-text and unquoted-span-with-`@json`.
 */

const toolStep = (paramsExpr: string, over: Record<string, unknown> = {}) => ({
  id: "send",
  kind: "tool",
  ref: "foundry_email_send",
  paramsExpr,
  ...over,
});

const model = (steps: Array<Record<string, unknown>>): FlowModel =>
  ({ id: "f", steps }) as unknown as FlowModel;

describe("checkDoubleEncodedJson", () => {
  it("refuses the exact prod shape: @json inside a quoted span", () => {
    const findings = checkDoubleEncodedJson(
      model([
        toolStep(
          '[{ "subject": "Attendance compliance report", "body": "{{ json(outputs.compliance_report.body).results[0].data | jq(\'.text | @json\') | first }}" }]',
        ),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("json_double_encoded");
    expect(findings[0]!.stepId).toBe("send");
    expect(findings[0]!.message).toMatch(/one quoting, not both/);
  });

  it("accepts both valid forms", () => {
    // Quoted span, raw text.
    expect(
      checkDoubleEncodedJson(model([toolStep('[{ "body": "{{ outputs.llm.text }}" }]')])),
    ).toEqual([]);
    // Whole-expr span ending in @json is unquoted — the regex only sees quoted spans.
    expect(
      checkDoubleEncodedJson(
        model([toolStep('{{ outputs.llm.body | jq(\'[{body: (.text | @json)}]\') | first }}')]),
      ),
    ).toEqual([]);
  });

  it("fires on datasource/query steps too — every callback body is raw JSON", () => {
    expect(
      checkDoubleEncodedJson(
        model([
          toolStep('[{ "body": "{{ x | @json }}" }]', { kind: "datasource", ref: "d.q" }),
          toolStep('[{ "body": "plain" }]', { id: "ok", kind: "query", ref: "d.o" }),
        ]),
      ),
    ).toHaveLength(1);
  });

  it("fires through assertValid, blocking the save", () => {
    expect(() =>
      flowValidator.assertValid(
        model([toolStep('[{ "body": "{{ x | @json }}" }]')]),
        ["foundry_email_send"],
      ),
    ).toThrow(FlowValidationError);
  });
});
describe("typed rows (normalised form)", () => {
  // normaliseModel drops the display string into `inputs` before validation
  // runs — the guard must see the rows, not only paramsExpr.
  const typedStep = {
    id: "send",
    kind: "tool",
    ref: "foundry_email_send",
    inputs: [
      { name: "subject", source: { from: "literal", value: "S" } },
      {
        name: "body",
        source: { from: "literal", value: "{{ json(outputs.x.body).d | jq('.t | @json') | first }}" },
      },
    ],
  };

  it("refuses quoted-@json in a typed literal input", () => {
    const findings = checkDoubleEncodedJson(model([typedStep]));
    expect(findings.map((f) => f.rule)).toEqual(["json_double_encoded"]);
  });

  it("fires through assertValid on the normalised shape", () => {
    expect(() => flowValidator.assertValid(model([typedStep]), ["foundry_email_send"])).toThrow(
      FlowValidationError,
    );
  });
});

/**
 * The draft loop's directed finding for this class — `send_report`/`body`.
 *
 * The loop feeds `repair.findings` back as the redraft prompt, and for this
 * class the finding IS the validator message, verbatim: a reworded duplicate
 * would ask the redraft to reconcile two sentences about one span. So this
 * block pins what the loop hands back — the existing sentence, directed at
 * the step that carries it — rather than introducing any new wording.
 */
describe("the draft loop's directed finding — send_report/body", () => {
  const sendReport = (paramsExpr: string) =>
    model([toolStep(paramsExpr, { id: "send_report", ref: "foundry_email_send" })]);

  it("a quoted @json body on send_report is refused with the existing sentence", () => {
    const findings = checkDoubleEncodedJson(
      sendReport('[{ "subject": "R", "body": "{{ outputs.summary.text | jq(\'@json\') | first }}" }]'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "json_double_encoded", stepId: "send_report", blocking: true });
    expect(findings[0]!.facts).toEqual({ stepId: "send_report", ref: "foundry_email_send" });
    // ⚠ No new wording: the loop reuses this message verbatim.
    expect(findings[0]!.message).toContain('step "send_report"');
    expect(findings[0]!.message).toMatch(/one quoting, not both/);
  });

  it("the repaired shape — unquoted sole span — costs the loop no attempt", () => {
    expect(
      checkDoubleEncodedJson(
        sendReport('[{ "subject": "R", "body": {{ outputs.summary.text | jq(\'@json\') | first }} }]'),
      ),
    ).toEqual([]);
  });
});

/**
 * Double-quoted jq programs and jq string literals — 2026-09-14 gaps.
 *
 * The verbatim half only sees a quoteless `@json` between wrapping quotes, so
 * a double-quoted jq program (`jq(".text | @json")`) sails through it and is
 * caught downstream instead (the draft repair unquotes it; the typed half
 * catches it in a literal). `@json` inside a jq string literal is text and
 * stays silent everywhere. No new wording here — the message above is reused
 * verbatim by the repair and its finder.
 */
describe("double-quoted jq programs and jq string literals", () => {
  it("the repaired shape — unquoted double-quoted-jq span — is validator-clean", () => {
    expect(
      checkDoubleEncodedJson(
        model([toolStep('[{ "subject": "R", "body": {{ outputs.summary.text | jq(".text | @json") | first }} }]')]),
      ),
    ).toEqual([]);
  });

  it("leaves @json inside a jq string literal alone — that text never carried quotes", () => {
    expect(
      checkDoubleEncodedJson(
        model([
          toolStep('[{ "subject": "R", "body": "{{ outputs.summary.text | jq(\'{label: "@json"}\') | first }}" }]'),
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses a typed literal carrying a double-quoted @json program — the typed half catches what verbatim cannot", () => {
    const findings = checkDoubleEncodedJson(
      model([
        {
          id: "send",
          kind: "tool",
          ref: "foundry_email_send",
          inputs: [
            { name: "subject", source: { from: "literal", value: "S" } },
            {
              name: "body",
              source: { from: "literal", value: '{{ outputs.summary.text | jq(".text | @json") | first }}' },
            },
          ],
        },
      ]),
    );
    expect(findings.map((f) => f.rule)).toEqual(["json_double_encoded"]);
  });
});

 /**
  * Full-pipeline regression for the live 2026-09-14 failure chain
  * (`send_report` → `himanshu.saini@microland.com`).
  *
  * The defeating draft carried TWO shapes at once: a literal address array
  * (`"to": [...]`, which the old splitter cut mid-array into an unbound
  * input) and a bare `@json` body (which normalisation literalised into a
  * double-encoded typed row). Either half alone strands or refuses the flow;
  * this pins the whole path — normalise twice (draft-time AND write-time),
  * then validate — so no layer can silently re-break another's fix.
  */
 describe("live pipeline — attendance report to himanshu.saini@microland.com", () => {
   const draftSteps = (): Array<Record<string, unknown>> => [
     {
       id: "generate_attendance_report",
       kind: "query",
       ref: "hr_demo.attendance_period_rows",
       paramsExpr: `[{"as_of":"{{ inputs.as_of }}","period":"{{ inputs.period }}","not_exited":"exited","not_on_leave":"on_leave"}]`,
     },
     {
       id: "send_report",
       kind: "tool",
       ref: "foundry_email_send",
       paramsExpr: `[{"to":["himanshu.saini@microland.com"],"subject":"Attendance report for {{ inputs.period }}","body":{{ json(outputs.generate_attendance_report.body).results[0].data | jq('tostring | @json') | first }} }]`,
       dependsOn: ["generate_attendance_report"],
     },
   ];
   const normalisedSteps = (steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
     (normaliseModel({ id: "f", steps }) as unknown as { steps: Array<Record<string, unknown>> }).steps;

   it("survives draft-time AND write-time normalisation, then validates clean", () => {
     const twice = normalisedSteps(normalisedSteps(draftSteps()));
     const send = twice[1] as Record<string, unknown>;
     // Display authoritative throughout — the emitter reads it verbatim.
     expect(String(send["paramsExpr"])).toContain(`"body":{{`);
     // Address array bound as a literal, never an unbound input.
     const inputs = send["inputs"] as Array<{ name: string; source: unknown }>;
    // The only unbound input is the deliberately-skipped `@json` body, whose
    // display is retained alongside it — `boundSource` never runs while a
    // display exists, and the validator skips null sources.
    expect(inputs.filter((b) => b.source === null).map((b) => b.name)).toEqual(["body"]);
    expect(checkDoubleEncodedJson({ id: "f", steps: twice } as unknown as FlowModel)).toEqual([]);
  });
});
