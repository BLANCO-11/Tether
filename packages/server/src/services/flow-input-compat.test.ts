// src/services/flow-input-compat.test.ts
//
// A DATE bound verbatim to a `YYYY-MM` month parameter died at runtime
// (`period must be YYYY-MM, got "2026-06-30"`) with every static check green.
// These pin the refusal: raw reads into a mismatched format name every reader,
// derived bindings pass, and a parameter carrying no format never blocks.
import { describe, expect, it, vi } from "vitest";
import { checkFeederCompatibility, CONVERSIONS } from "./flow-input-compat.js";

import { manifestBuilderService } from "./manifest-builder.service.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import type { FlowModel } from "./flow-compiler.service.js";

vi.mock("./manifest-builder.service.js", () => ({
  manifestBuilderService: { refInterfaces: vi.fn(), buildAndPersist: vi.fn() },
}));
vi.mock("../repositories/datasource.repo.js", () => ({
  datasourceRepo: { listByWorkspace: vi.fn() },
}));
vi.mock("../repositories/schema.repo.js", () => ({
  schemaRepo: { listByDatasource: vi.fn() },
}));

const MONTH_IFACE = {
  hr_tool: {
    kind: "tool",
    params: [{ name: "period", type: "string", required: true, format: "month" }],
    signature: "tool POST(period:string!)",
  },
};

function model(
  steps: Array<Record<string, unknown>>,
  inputs: Array<Record<string, unknown>> = [{ id: "as_of", type: "DATE" }],
): FlowModel {
  return {
    id: "feeder-probe",
    inputs,
    steps,
  } as unknown as FlowModel;
}

function iface(format: string | undefined, param = "period") {
  const p: Record<string, unknown> = { name: param, type: "string", required: true };
  if (format !== undefined) p.format = format;
  return {
    hr_tool: { kind: "tool", params: [p], signature: `tool POST(${param}:string!)` },
  };
}

function rawRead(
  kind: string,
  format: string | undefined,
  param = "period",
  stepId = "fetch",
): { probe: FlowModel; catalogue: ReturnType<typeof iface> } {
  const probe = model(
    [{ id: stepId, kind: "tool", ref: "hr_tool", paramsExpr: `[{"${param}": "{{ inputs.as_of }}"}]` }],
    [{ id: "as_of", type: kind }],
  );
  return { probe, catalogue: iface(format, param) };
}

const RAW_MONTH_READ = model([
  { id: "fetch", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.as_of }}"}]` },
]);

describe("the conversions table", () => {
  it("is keyed by kind×format: the four derivations the chat rule can synthesize", () => {
    expect(CONVERSIONS.map((c) => `${c.from}→${c.to}:${c.name}`)).toEqual(
      expect.arrayContaining([
        "DATE→month:month-from-DATE",
        "DATETIME→month:month-from-DATETIME",
        "DATETIME→date:truncate-DATETIME-to-date",
        "DATE→datetime:midnight-DATE-to-datetime",
      ]),
    );
    expect(CONVERSIONS).toHaveLength(4);
  });

  it("carries no month-semantics STRING→date entry and no age-from-DOB entry", () => {
    const names = CONVERSIONS.map((c) => c.name);
    expect(names).not.toContain("last-day-of-month");
    expect(names).not.toContain("age-from-DOB");
    expect(CONVERSIONS.some((c) => c.from === "STRING")).toBe(false);
    expect(CONVERSIONS.some((c) => c.to === "text")).toBe(false);
  });
});

describe("a DATE read raw into a month reader", () => {
  it("is refused, naming the input, the reader, and the remedy", () => {
    const findings = checkFeederCompatibility(RAW_MONTH_READ, MONTH_IFACE as never);
    expect(findings).toHaveLength(1);
    const [finding] = findings as [string];
    expect(finding).toContain("INCOMPATIBLE");
    expect(finding).toContain('"as_of"');
    expect(finding).toContain('"fetch".paramsExpr');
    expect(finding).toContain('"period"');
    expect(finding).toContain("month");
    expect(finding).toContain("month-from-DATE");
    expect(finding).toContain("outputs.<step>");
  });

  it("names EVERY affected reader, one finding per reader", () => {
    const findings = checkFeederCompatibility(
      model([
        { id: "a", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.as_of }}"}]` },
        { id: "b", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.as_of }}"}]` },
      ]),
      MONTH_IFACE as never,
    );
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.includes('"a".paramsExpr'))).toBe(true);
    expect(findings.some((f) => f.includes('"b".paramsExpr'))).toBe(true);
  });

  it("is accepted once the reader binds the derivation instead of the input", () => {
    const derived = model([
      {
        id: "fetch",
        kind: "tool",
        ref: "hr_tool",
        paramsExpr: `[{"period": "{{ outputs.derive_period.period }}"}]`,
      },
    ]);
    expect(checkFeederCompatibility(derived, MONTH_IFACE as never)).toEqual([]);
  });
});

describe("the compatibility matrix", () => {
  it.each([["month"], ["date"], ["datetime"], ["text"]])(
    "free-text STRING passes into %s — its value is unknowable statically",
    (format) => {
      const { probe, catalogue } = rawRead("STRING", format);
      expect(checkFeederCompatibility(probe, catalogue as never)).toEqual([]);
    },
  );

  it.each([["STRING"], ["DATE"], ["DATETIME"], ["INT"], ["FLOAT"], ["BOOLEAN"]])(
    "text passes every kind (%s) — rendered values are fine prose",
    (kind) => {
      const { probe, catalogue } = rawRead(kind, "text", "note");
      expect(checkFeederCompatibility(probe, catalogue as never)).toEqual([]);
    },
  );

  it("month passes STRING and refuses DATE with month-from-DATE", () => {
    const passing = rawRead("STRING", "month");
    expect(checkFeederCompatibility(passing.probe, passing.catalogue as never)).toEqual([]);
    const { probe, catalogue } = rawRead("DATE", "month");
    const findings = checkFeederCompatibility(probe, catalogue as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("DATE");
    expect(findings[0]).toContain("month-from-DATE");
    expect(findings[0]).toMatch(/refused pending derivation/i);
  });

  it("month refuses DATETIME with month-from-DATETIME", () => {
    const { probe, catalogue } = rawRead("DATETIME", "month");
    const findings = checkFeederCompatibility(probe, catalogue as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("DATETIME");
    expect(findings[0]).toContain("month-from-DATETIME");
    expect(findings[0]).toMatch(/refused pending derivation/i);
  });

  it.each([["INT"], ["FLOAT"], ["BOOLEAN"]])(
    "month refuses %s with no conversion to name",
    (kind) => {
      const { probe, catalogue } = rawRead(kind, "month");
      const findings = checkFeederCompatibility(probe, catalogue as never);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain("INCOMPATIBLE");
      expect(findings[0]).toContain(`no conversion covers ${kind} → month`);
    },
  );

  it("date passes DATE and refuses DATETIME with the truncate derivation", () => {
    const passing = rawRead("DATE", "date");
    expect(checkFeederCompatibility(passing.probe, passing.catalogue as never)).toEqual([]);
    const { probe, catalogue } = rawRead("DATETIME", "date", "day");
    const findings = checkFeederCompatibility(probe, catalogue as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("DATETIME");
    expect(findings[0]).toContain("truncate-DATETIME-to-date");
    expect(findings[0]).toMatch(/refused pending derivation/i);
  });

  it.each([["INT"], ["FLOAT"], ["BOOLEAN"]])(
    "date refuses %s with no conversion to name",
    (kind) => {
      const { probe, catalogue } = rawRead(kind, "date", "day");
      const findings = checkFeederCompatibility(probe, catalogue as never);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(`no conversion covers ${kind} → date`);
    },
  );

  it("datetime passes DATETIME and refuses DATE with the midnight derivation", () => {
    const passing = rawRead("DATETIME", "datetime", "at");
    expect(checkFeederCompatibility(passing.probe, passing.catalogue as never)).toEqual([]);
    const { probe, catalogue } = rawRead("DATE", "datetime", "at");
    const findings = checkFeederCompatibility(probe, catalogue as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("DATE");
    expect(findings[0]).toContain("midnight-DATE-to-datetime");
    expect(findings[0]).toMatch(/refused pending derivation/i);
  });

  it.each([["INT"], ["FLOAT"], ["BOOLEAN"]])(
    "datetime refuses %s with no conversion to name",
    (kind) => {
      const { probe, catalogue } = rawRead(kind, "datetime", "at");
      const findings = checkFeederCompatibility(probe, catalogue as never);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain(`no conversion covers ${kind} → datetime`);
    },
  );

  it("an unknown format never blocks", () => {
    const { probe, catalogue } = rawRead("DATE", "ssn");
    expect(checkFeederCompatibility(probe, catalogue as never)).toEqual([]);
  });
});

describe("the two canonical live cases", () => {
  it("the drafter-canonical STRING period into month passes", () => {
    const probe = model(
      [{ id: "fetch", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.period }}"}]` }],
      [{ id: "period", type: "STRING" }],
    );
    expect(checkFeederCompatibility(probe, MONTH_IFACE as never)).toEqual([]);
  });

  it('the measured DATE "2026-06-30" into month refuses, naming every reader', () => {
    const probe = model(
      [
        { id: "a", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.as_of }}"}]` },
        { id: "b", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.as_of }}"}]` },
      ],
      [{ id: "as_of", type: "DATE" }],
    );
    const findings = checkFeederCompatibility(probe, MONTH_IFACE as never);
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding).toContain("DATE");
      expect(finding).toContain("month");
      expect(finding).toContain("month-from-DATE");
    }
    expect(findings.some((f) => f.includes('"a".paramsExpr'))).toBe(true);
    expect(findings.some((f) => f.includes('"b".paramsExpr'))).toBe(true);
  });
});

describe("the typed binding vehicles", () => {
  const row = (source: unknown) =>
    model([{ id: "fetch", kind: "tool", ref: "hr_tool", inputs: [{ name: "period", source }] }]);

  it("refuses an `inputs`-row bound raw from the input", () => {
    const findings = checkFeederCompatibility(
      row({ from: "input", inputId: "as_of" }),
      MONTH_IFACE as never,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("INCOMPATIBLE");
    expect(findings[0]).toContain('"fetch".inputs');
  });

  it("accepts an `inputs`-row rebound to a derive step", () => {
    expect(
      checkFeederCompatibility(
        model([
          {
            id: "derive_period",
            kind: "code",
            code: "def run(payload):\n    return {'period': '2026-06'}",
            inputExpr: '{"as_of": "{{ inputs.as_of }}"}',
            outputKeys: ["period"],
          },
          { id: "fetch", kind: "tool", ref: "hr_tool", inputs: [{ name: "period", source: { from: "step", stepId: "derive_period", field: "period" } }] },
        ]),
        MONTH_IFACE as never,
      ),
    ).toEqual([]);
  });

  it("reads a `params`-row expression template against its own parameter", () => {
    const findings = checkFeederCompatibility(
      model([
        {
          id: "fetch",
          kind: "tool",
          ref: "hr_tool",
          params: { period: { source: { kind: "expression", template: "{{ inputs.as_of }}" } } },
        },
      ]),
      MONTH_IFACE as never,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"fetch".params');
  });
});

describe("what stays silent", () => {
  it("a parameter carrying no format is unconstrained prose — never blocked", () => {
    const noFormat = {
      hr_tool: {
        kind: "tool",
        params: [{ name: "period", type: "string", required: true }],
        signature: "tool POST(period:string!)",
      },
    };
    expect(checkFeederCompatibility(RAW_MONTH_READ, noFormat as never)).toEqual([]);
  });

  it("an unknown ref is checkFlowRefs' finding, never this one's", () => {
    expect(checkFeederCompatibility(RAW_MONTH_READ, {} as never)).toEqual([]);
  });

  it("a prose parameter takes a STRING input as itself", () => {
    const prose = {
      hr_tool: {
        kind: "tool",
        params: [{ name: "note", type: "string", required: true, format: "text" }],
        signature: "tool POST(note:string!)",
      },
    };
    const reading = model([
      { id: "fetch", kind: "tool", ref: "hr_tool", paramsExpr: `[{"note": "{{ inputs.as_of }}"}]` },
    ]) as unknown as FlowModel;
    const stringModel: FlowModel = {
      ...reading,
      inputs: [{ id: "as_of", type: "STRING" }],
    };
    expect(checkFeederCompatibility(stringModel, prose as never)).toEqual([]);
  });

  it("a jq-built paramsExpr is unreadable — cannot see, says nothing", () => {
    const jq = model([
      {
        id: "fetch",
        kind: "tool",
        ref: "hr_tool",
        paramsExpr: `{{ rows | jq('[.[] | {period: .as_of}]') | first }}`,
      },
    ]);
    expect(checkFeederCompatibility(jq, MONTH_IFACE as never)).toEqual([]);
  });

  it("an input nobody declared is checkDeclaredInputs' refusal, not this check's", () => {
    const ghost = model([
      { id: "fetch", kind: "tool", ref: "hr_tool", paramsExpr: `[{"period": "{{ inputs.ghost }}"}]` },
    ]);
    expect(checkFeederCompatibility(ghost, MONTH_IFACE as never)).toEqual([]);
  });
});

describe("a pair no conversion covers", () => {
  it("is refused without a derivation to name", () => {
    const { probe, catalogue } = rawRead("INT", "month");
    const findings = checkFeederCompatibility(probe, catalogue as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("INCOMPATIBLE");
    expect(findings[0]).toContain("no conversion covers INT → month");
  });
});

describe("a feed bound to a step that is not in the flow (rev-2 live shape)", () => {
  // Turn bound `fetch.period → derive_month.month` with no `derive_month` step;
  // the revision saved with every check green. The binding names the reader,
  // the missing step, and the steps that do exist.
  const rev2 = () =>
    model([
      {
        id: "fetch",
        kind: "tool",
        ref: "hr_tool",
        inputs: [{ name: "period", source: { from: "step", stepId: "derive_month", field: "month" } }],
      },
    ]);

  it("is refused, naming the reader and the missing step", () => {
    const findings = checkFeederCompatibility(rev2(), MONTH_IFACE as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("unknown_binding_step");
    expect(findings[0]).toContain('step "fetch".inputs[period]');
    expect(findings[0]).toContain('"derive_month"');
    expect(findings[0]).toContain("steps: fetch");
  });

  it("blocks before any catalogue is consulted — even an empty one", () => {
    expect(checkFeederCompatibility(rev2(), {} as never)).toHaveLength(1);
  });

  it("is accepted once the derivation step exists — the control", () => {
    const fixed = rev2();
    (fixed.steps as Array<Record<string, unknown>>).unshift({
      id: "derive_month",
      kind: "code",
      code: "def run(payload):\n    return {'month': '2026-06'}",
      inputExpr: '{"as_of": "{{ inputs.as_of }}"}',
      outputKeys: ["month"],
    });
    expect(checkFeederCompatibility(fixed, MONTH_IFACE as never)).toEqual([]);
  });

  it("catches the `params`-row vehicle too", () => {
    const findings = checkFeederCompatibility(
      model([
        {
          id: "fetch",
          kind: "tool",
          ref: "hr_tool",
          params: { period: { source: { kind: "step", stepId: "derive_month", field: "month" } } },
        },
      ]),
      MONTH_IFACE as never,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("unknown_binding_step");
    expect(findings[0]).toContain('step "fetch".params[period]');
  });
});
