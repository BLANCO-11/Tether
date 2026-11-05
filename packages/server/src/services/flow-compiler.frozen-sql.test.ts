import { describe, expect, it } from "vitest";
import { flowCompiler, type FlowModel } from "./flow-compiler.service.js";
import { namespaceFor } from "./kestra-client.service.js";

/**
 * Frozen step SQL carry-through (mock-data plan §2/§4).
 *
 * A `datasource` step may carry the human-approved statement (`sql`) and an
 * explicit address (`datasourceRef`). The compiler's only job is to carry
 * both verbatim into the step callback body — never to generate, rewrite, or
 * resolve them. The executor runs exactly that text through `checkSqlShape`.
 *
 * Pure: no database, no Kestra.
 */

const draft = namespaceFor("acme", "hr", "draft");

const model = (over: Partial<FlowModel> = {}): FlowModel => ({
  id: "hr-screening",
  inputs: [{ id: "period", type: "STRING", defaults: "2026-06" }],
  steps: [
    {
      id: "screen",
      kind: "datasource",
      ref: "hr_demo.attendance_below_threshold",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    { id: "notify", kind: "tool", ref: "mail_send", paramsExpr: "{{ x }}", dependsOn: ["screen"] },
  ],
  ...over,
});

describe("flow-compiler — frozen step SQL carry-through", () => {
  it("carries sql and datasourceRef verbatim into the step callback body", () => {
    const frozen = "SELECT id FROM users WHERE period = $1";
    const { yaml } = flowCompiler.compile(
      model({
        steps: [
          {
            id: "screen",
            kind: "datasource",
            ref: "hr_demo.attendance_below_threshold",
            datasourceRef: "hr_demo",
            sql: frozen,
            paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
          },
        ],
      }),
      { namespace: draft },
    );
    expect(yaml).toContain(`"datasourceRef": "hr_demo"`);
    expect(yaml).toContain(`"sql": ${JSON.stringify(frozen)}`);
  });

  it("emits no sql key for a legacy step, so old revisions compile byte-identically", () => {
    const { yaml } = flowCompiler.compile(model(), { namespace: draft });
    expect(yaml).not.toContain(`"sql":`);
    expect(yaml).not.toContain(`"datasourceRef":`);
  });

  it("never carries sql on a tool step", () => {
    const { yaml } = flowCompiler.compile(
      model({
        steps: [
          {
            id: "notify",
            kind: "tool",
            ref: "mail_send",
            paramsExpr: "{{ x }}",
            sql: "SELECT 1",
          } as unknown as FlowModel["steps"][number],
        ],
      }),
      { namespace: draft },
    );
    expect(yaml).not.toContain(`"sql":`);
  });

  it("moves the structure hash when the frozen statement changes, and only then", () => {
    const base = model();
    const editedSql = model({
      steps: [
        {
          id: "screen",
          kind: "datasource",
          ref: "hr_demo.attendance_below_threshold",
          sql: "SELECT id, name FROM users WHERE period = $1",
          paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
        },
      ],
    });
    const renamedRef = model({
      steps: [
        {
          id: "screen",
          kind: "datasource",
          ref: "hr_demo.attendance_below_threshold",
          datasourceRef: "hr_demo",
          sql: "SELECT id FROM users WHERE period = $1",
          paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
        },
      ],
    });
    expect(flowCompiler.structureHash(editedSql)).not.toBe(flowCompiler.structureHash(base));
    expect(flowCompiler.structureHash(renamedRef)).not.toBe(flowCompiler.structureHash(base));
    // Legacy shape is unchanged: absent sql/datasourceRef hash as null.
    expect(flowCompiler.structureHash(model())).toBe(flowCompiler.structureHash(base));
  });
});
