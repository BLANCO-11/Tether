import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { engineIdOf } from "./flow-engine-id.js";
import { validateModel } from "./flow-compiler.service.js";

describe("a person's flow is addressed in the engine by its own uuid", () => {
  it("f-<uuid> passes the compiler's id rule for any uuid, including one that starts with a digit", () => {
    for (const u of [randomUUID(), "0a1b2c3d-1111-4222-8333-444455556666", "ABCDEF01-2345-4678-89AB-CDEF01234567"]) {
      const id = engineIdOf(u);
      expect(id).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
      let why = "";
      try { validateModel({ id, version: 2, inputs: [], steps: [] } as never); } catch (e) { why = (e as Error).message; }
      expect(why).not.toMatch(/not slug-shaped/);
    }
  });
  it("CONTROL: the id shapes it replaces are refused by the same rule", () => {
    for (const id of ["0a1b2c3d-1111-4222-8333-444455556666", "get_me_a_list-muk3fluv"]) {
      expect(() => validateModel({ id, version: 2, inputs: [], steps: [] } as never)).toThrow(/not slug-shaped/);
    }
  });
});
