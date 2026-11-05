import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `begin`'s snapshot writes happen inside a large, side-effecting route handler
 * (credential minting, Kestra calls, tenant budget checks) that this repo does
 * not unit-test at the route level — `flow-visibility.test.ts` covers the READ
 * side of `flowNameSnapshot`/`flowIdSnapshot` (`executionBase`), and the WRITE
 * side is proven end to end by `kestra:phase3`/`kestra:prove` against the real
 * engine, not by a mocked route test here.
 *
 * What a unit test in this file CAN and must assert: `flowIdSnapshot` is
 * actually written, from the same `flowRow` lookup as `flowNameSnapshot`, at
 * the SAME call site. Same idiom as `access-audit-wired.test.ts` and the
 * `TETHER_API_KEY`-in-three-files assertion — a value computed correctly and
 * never written is I-120's exact shape, and the two snapshot fields drifting
 * apart (one written, one forgotten on a future edit) is exactly the failure
 * mode worth a standing guard against.
 */

const REL = "src/routes/executions.ts";

function read(): string {
  return readFileSync(REL, "utf8");
}

describe("`begin` writes flowIdSnapshot alongside flowNameSnapshot", () => {
  it("CONTROL: the scan can find the file and it is the one we mean", () => {
    const src = read();
    expect(src.length, `${REL} read as empty`).toBeGreaterThan(1000);
    expect(src, `${REL} does not look like the begin handler`).toMatch(
      /flowExecutionRepo\.create\(/,
    );
  });

  it("writes flowIdSnapshot from the same flowRow used for flowNameSnapshot", () => {
    const src = read();
    const start = src.indexOf("flowExecutionRepo.create({");
    expect(start, "no flowExecutionRepo.create( call found").toBeGreaterThan(-1);
    const end = src.indexOf("});", start);
    const call = src.slice(start, end + 3);

    expect(call, "flowNameSnapshot missing from the create() call").toMatch(
      /flowNameSnapshot:\s*flowRow\?\.name\s*\?\?\s*null/,
    );
    expect(call, "flowIdSnapshot missing from the create() call").toMatch(
      /flowIdSnapshot:\s*flowRow\?\.id\s*\?\?\s*null/,
    );
  });

  it("flowIdSnapshot is never read from the request body", () => {
    // Same shape as I-62's `createdBy`/`bySuperAdmin` guards: this is a value
    // derived server-side from the trusted `flowRow` lookup, never from a
    // caller-supplied field — a body-sourced id here would let a request
    // assert a workflow identity for a run it didn't actually belong to.
    const src = read();
    const start = src.indexOf("flowExecutionRepo.create({");
    const end = src.indexOf("});", start);
    const call = src.slice(start, end + 3);
    expect(call, "flowIdSnapshot reads from req.body").not.toMatch(
      /flowIdSnapshot:\s*(req\.body|body)\./,
    );
  });
});
