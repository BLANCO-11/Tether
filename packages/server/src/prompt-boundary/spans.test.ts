import { describe, expect, it } from "vitest";
import { spansFromInventory, SPAN_FIELDS, type WorkspaceInventory } from "./spans.js";

// T005/T006/T007 — written before spans.ts (Article II).
//
// This list IS FR-002. If a field reaches the generation prompt and is not
// emitted here, it is neither framed (US1) nor scanned (US2) — the span
// collector is the single point where those two controls agree on what counts as
// untrusted (research R6).
//
// ADAPTED FROM krt/guardrail_validation: v1-alpha's tools have no
// isDummy/dummyResponseTemplate columns, so the inventory fixture and its
// assertions omit both (research.md Decision 3).

const inventory: WorkspaceInventory = {
  tools: [
    {
      name: "employee-lookup",
      description: "Looks up an employee by id",
      method: "GET",
      url: "https://hr.example.internal/employees",
      paramsSchema: { employeeId: { type: "string", required: true } },
      secretEnvName: "HR_API_KEY",
      authStyle: "bearer",
      authParamName: null,
    },
    {
      name: "ticket-stub",
      description: null,
      method: "POST",
      url: "https://tickets.example.internal/create",
      paramsSchema: null,
      secretEnvName: null,
      authStyle: "header",
      authParamName: "X-Api-Key",
    },
  ],
  datasources: [
    {
      name: "hr-db",
      type: "postgres",
      entities: [
        {
          name: "employees",
          schema: "hr",
          entityType: "table",
          columns: [
            { name: "id", type: "uuid", foreignKeyReference: null },
            { name: "manager_id", type: "uuid", foreignKeyReference: "hr.employees.id" },
          ],
        },
        { name: "presence_rollup", schema: null, entityType: "view", columns: [] },
      ],
    },
  ],
};

const spans = spansFromInventory(inventory);
const fieldsPresent = new Set(spans.map((s) => s.field));

describe("spansFromInventory — the FR-002 field registry", () => {
  // Every field the registry declares must actually be emitted for a workspace
  // that has one. A registry entry with no emitting code is a labelled gap.
  for (const field of SPAN_FIELDS) {
    it(`emits a span for '${field}'`, () => {
      expect(fieldsPresent.has(field)).toBe(true);
    });
  }

  it("declares no field it cannot emit", () => {
    // The reverse direction: an emitted field missing from SPAN_FIELDS would be
    // scanned and framed but invisible to anyone reading the registry.
    const declared = new Set<string>(SPAN_FIELDS);
    for (const s of spans) expect(declared.has(s.field)).toBe(true);
  });

  it("carries the raw value, not a normalised one", () => {
    const desc = spans.find((s) => s.field === "description");
    expect(desc?.value).toBe("Looks up an employee by id");
  });

  it("names the item so an operator can find it", () => {
    const fk = spans.find((s) => s.field === "foreignKeyReference");
    expect(fk?.itemName).toBe("hr-db");
    expect(fk?.value).toBe("hr.employees.id");
  });

  it("labels each span with the registry it came from", () => {
    expect(spans.find((s) => s.field === "description")?.source).toBe("tool");
    expect(spans.find((s) => s.field === "type")?.source).toBe("datasource");
    expect(spans.find((s) => s.field === "columnName")?.source).toBe("schema");
  });

  it("emits one span per tool parameter", () => {
    const paramNames = spans.filter((s) => s.field === "paramName").map((s) => s.value);
    expect(paramNames).toContain("employeeId");
  });

  it("skips absent optional fields without emitting empty spans", () => {
    // 'ticket-stub' has a null description. An empty span would be a span the
    // detector has to special-case and the envelope has to render.
    expect(spans.every((s) => s.value.length > 0)).toBe(true);
  });

  it("returns an empty list for an empty workspace", () => {
    expect(spansFromInventory({ tools: [], datasources: [] })).toEqual([]);
  });
});

// T006 — Article VIII. secretEnvName is an identifier; the VALUE behind it must
// never enter a span, because spans are rendered into the prompt and quoted back
// in warnings.
describe("secret hygiene", () => {
  it("emits the secret env-var NAME, never a value", () => {
    const secret = spans.find((s) => s.field === "secretEnvName");
    expect(secret?.value).toBe("HR_API_KEY");
  });

  it("emits no span sourced from a resolved secret value", () => {
    // The inventory type has no field carrying a secret value. This test exists
    // so that adding one is a visible, deliberate act rather than a quiet
    // widening of what reaches the prompt.
    const inventoryKeys = Object.keys(inventory.tools[0]);
    expect(inventoryKeys).not.toContain("secretValue");
    expect(inventoryKeys).not.toContain("resolvedSecret");
  });
});

// T007 — Article XII. spansFromInventory is pure over one workspace's inventory,
// so isolation is a property of the caller; collectUntrustedSpans reads through
// the workspace-scoped repositories.
describe("workspace scoping", () => {
  it("emits only what the given inventory contains", () => {
    const other = spansFromInventory({
      tools: [
        {
          name: "other-ws-tool",
          description: "belongs to a different workspace",
          method: null,
          url: null,
          paramsSchema: null,
          secretEnvName: null,
          authStyle: null,
          authParamName: null,
        },
      ],
      datasources: [],
    });
    expect(other.every((s) => s.itemName === "other-ws-tool")).toBe(true);
    expect(spans.every((s) => s.itemName !== "other-ws-tool")).toBe(true);
  });
});
