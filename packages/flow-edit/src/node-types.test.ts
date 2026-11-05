// The registry's own contract: complete, well-formed, and honest about what runs.
// A kind missing here is a kind the panel, the palette and chat cannot name —
// and a `runtime: null` kind leaking into an offered list is another `notify`.
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_TYPES,
  NODE_TYPES,
  STEP_KINDS,
  offeredKinds,
  propertySpec,
  scratchKinds,
  type PropertySpec,
} from "./node-types.js";
import type { StepKind } from "./index.js";

function allProperties(kind: StepKind): PropertySpec[] {
  const out: PropertySpec[] = [];
  const walk = (props: readonly PropertySpec[]) => {
    for (const p of props) {
      out.push(p);
      if (p.fields) walk(p.fields);
    }
  };
  walk(NODE_TYPES[kind].properties);
  return out;
}

/** Names are unique within their level — group subfields (`body.kind` vs `auth.kind`) share a scope only with siblings. */
function checkUniqueNames(props: readonly PropertySpec[], scope: string) {
  const names = props.map((p) => p.name);
  for (const [i, name] of names.entries()) {
    expect(names.indexOf(name), `${scope}: duplicate property ${name}`).toBe(i);
  }
  for (const p of props) {
    if (p.fields) checkUniqueNames(p.fields, `${scope}.${p.name}`);
  }
}

describe("the registry covers every kind exactly once", () => {
  it("every StepKind has a spec and no spec is orphaned", () => {
    expect(Object.keys(NODE_TYPES).sort()).toEqual([...STEP_KINDS].sort());
  });

  it("STEP_KINDS has no duplicates", () => {
    for (const [i, kind] of STEP_KINDS.entries()) {
      expect(STEP_KINDS.indexOf(kind), `${kind} listed twice`).toBe(i);
    }
  });
});

describe("every property is renderable and writable", () => {
  for (const kind of STEP_KINDS) {
    it(`${kind}: labels, fallbacks and unique names`, () => {
      checkUniqueNames(NODE_TYPES[kind].properties, kind);
      for (const p of allProperties(kind)) {
        expect(p.label.length, `${kind}.${p.name}: label`).toBeGreaterThan(0);
        expect(p.fallback, `${kind}.${p.name}: fallback`).not.toBeUndefined();
      }
    });
  }
});

describe("unimplemented kinds are declared but never offered", () => {
  const offered = offeredKinds();
  for (const kind of STEP_KINDS) {
    const spec = NODE_TYPES[kind];
    if (spec.runtime === null) {
      it(`${kind} is not offered`, () => {
        expect(offered.includes(kind), `${kind} has no runtime but is offered`).toBe(false);
      });
    } else if (spec.engineOnly) {
      // For each (D-361): runnable, but built only by the engine's listed moves — the legacy palette never offers it.
      it(`${kind} is engine-only, not offered by the palette`, () => {
        expect(offered.includes(kind), `${kind} is engine-only but the palette offers it`).toBe(false);
      });
    } else {
      it(`${kind} is offered`, () => {
        expect(offered.includes(kind), `${kind} has a runtime but is not offered`).toBe(true);
      });
    }
  }

  it("catalogue-backed kinds are offered but not from-scratch", () => {
    const scratch = scratchKinds();
    for (const kind of STEP_KINDS) {
      if (NODE_TYPES[kind].catalogueBacked) {
        expect(offered.includes(kind)).toBe(true);
        expect(scratch.includes(kind), `${kind} names a real ref and must not be blank-created`).toBe(false);
      }
    }
    // `llm`/`http` run through Foundry since Stage 4 — offered, and blank-creatable (not catalogue-backed).
    expect([...scratch].sort()).toEqual(["approval", "branch", "code", "http", "llm", "merge", "transform"]);
  });
});

describe("output spellings are readable by construction", () => {
  for (const kind of STEP_KINDS) {
    it(`${kind}: every output expr names its step`, () => {
      for (const o of NODE_TYPES[kind].outputs) {
        expect(o.expr === null || o.expr.includes("<id>"), `${kind}.${o.name}: ${o.expr}`).toBe(true);
      }
    });
  }
});

describe("propertySpec", () => {
  it("finds a declared property and misses an undeclared one", () => {
    expect(propertySpec("llm", "model")?.label).toBe("Model");
    expect(propertySpec("llm", "nope")).toBeUndefined();
    expect(propertySpec("transform", "mode")?.fallback).toBe("expression");
  });
});

describe("boundary types", () => {
  it("the End card declares the output rows", () => {
    expect(BOUNDARY_TYPES.end.properties.some((p) => p.name === "rows")).toBe(true);
  });
});
