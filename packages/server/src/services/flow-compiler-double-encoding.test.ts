import { describe, expect, it } from "vitest";
import {
  flowCompiler,
  FlowCompileError,
  type FlowModel,
} from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";

/**
 * Verbatim `@json`-in-quotes never reaches the engine.
 *
 * Twin of `checkDoubleEncodedJson` in flow-validator.service.ts, placed here
 * deliberately: `writeRevision` normalises before validating, and normalisation
 * parses plain-JSON paramsExpr into typed rows and drops the display string —
 * so the save-time scan sees nothing on the common path. This scan runs on the
 * RAW model before normalisation, guarding deploy, replay, approval and the
 * yaml route, including revisions written before the validator existed.
 */

const draft = namespaceFor("acme", "hr", "draft");

const mailStep = (paramsExpr: string): FlowModel =>
  ({
    id: "m",
    steps: [{ id: "send", kind: "tool", ref: "tether_email_send", paramsExpr }],
  }) as unknown as FlowModel;

describe("compile refuses verbatim double-encoded @json", () => {
  it("throws on the prod shape: @json inside a quoted span", () => {
    expect(() =>
      flowCompiler.compile(
        mailStep(
          '[{ "subject": "S", "body": "{{ json(outputs.x.body).d | jq(\'.t | @json\') | first }}" }]',
        ),
        { namespace: draft },
      ),
    ).toThrow(FlowCompileError);
  });

  it("names the step and the remedy", () => {
    try {
      flowCompiler.compile(mailStep('[{ "body": "{{ x | @json }}" }]'), { namespace: draft });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/"send"/);
      expect((e as Error).message).toMatch(/one quoting, not both/);
    }
  });

  it("lets unquoted-@json and raw-text spans through to normalisation", () => {
    // Unquoted @json: the scan passes; compilation itself may still refuse for
    // unrelated shape reasons — the assertion here is only that THIS refusal
    // does not fire.
    for (const expr of [
      '[{ "body": {{ x | @json }} }]',
      '[{ "body": "{{ outputs.llm.text }}" }]',
    ]) {
      try {
        flowCompiler.compile(mailStep(expr), { namespace: draft });
      } catch (e) {
        expect((e as Error).message).not.toMatch(/one quoting, not both/);
      }
    }
  });
});
