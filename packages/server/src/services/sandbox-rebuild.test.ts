/**
 * `teardown` → `rebuild` must be a ROUND TRIP.
 *
 * ── ⚠ The defect this exists for, measured 2026-09-17 ────────────────────────
 *
 * `sandbox:rebuild` re-materialised the database, replayed the frozen rows,
 * created the read-only role, verified the taxonomy, promoted it — and wrote
 * **nothing back to the datasource row**. `hasSandbox` is
 * `!!ds.sandboxDsnEnc && !!fixture`, so the product reported *"no sandbox is
 * provisioned"* over a sandbox that was fully built and sitting there.
 *
 * ⚠ It broke the one recovery path the CLI documents. `teardown` nulls the
 * pointer and says in its own success message *"the frozen fixture is KEPT —
 * `sandbox:rebuild` restores it without asking a model again."* It did not. The
 * pair left a datasource at *fixture present, no DSN* — where
 * `provisionIfAbsent` refuses (`already_has_fixture` is the whole of its
 * "purely additive" argument), so the AUTOMATIC path can never retry either.
 * Four datasources on this deployment were found in that dead end.
 *
 * ⚠ **A green `✓ rebuilt` over a sandbox nothing can use is I-38 from the far
 * end** — not a control that cannot fail, but one that reports success and does
 * nothing. That is why the property asserted here is the ROUND TRIP rather than
 * "rebuild writes a DSN": the next field somebody adds to `teardown` has to be
 * restored too, and a test naming three fields by hand would not say so.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const SRC = new URL("./sandbox.service.ts", import.meta.url);

/** The body of one `sandboxService` method, by name, comments stripped. */
async function method(name: string): Promise<string> {
  const src = (await readFile(SRC, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const start = src.indexOf(`async ${name}(`);
  expect(start, `${name} not found in sandbox.service.ts`).toBeGreaterThan(-1);
  // To the next top-level `async <name>(`, or the end.
  const next = src.slice(start + 1).search(/\n {2}async \w+\(/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/**
 * Datasource columns a method assigns in a `.set({...})`.
 *
 * ⚠ Not anchored to line start: `teardown` writes all three on ONE line
 * (`.set({ sandboxDsnEnc: null, sandboxDbName: null, … })`) while
 * `rematerialise` writes one per line. A `^\s*`-anchored version found zero
 * fields in `teardown` and the round-trip check passed over an empty set — the
 * control below is what caught it.
 */
function fieldsSet(body: string): string[] {
  return [...body.matchAll(/\b(sandbox[A-Za-z]*)\s*:/g)].map((m) => m[1]);
}

describe("teardown and rebuild are a round trip", () => {
  it("every sandbox field `teardown` clears, `rematerialise` writes back", async () => {
    const cleared = new Set(fieldsSet(await method("teardown")));
    const restored = new Set(fieldsSet(await method("rematerialise")));

    // Controls: both methods were found and both really do touch the row.
    // Without these the set difference below is empty for the wrong reason.
    expect(cleared.size).toBeGreaterThanOrEqual(3);
    expect(restored.size).toBeGreaterThanOrEqual(3);

    const dropped = [...cleared].filter((f) => !restored.has(f));
    expect(
      dropped,
      `teardown clears ${dropped.join(", ")} and rebuild never restores it — ` +
        `the datasource is left at "fixture present, no sandbox", which ` +
        `provisionIfAbsent refuses and no screen can fix`,
    ).toEqual([]);
  });

  /**
   * ⚠ The specific field, named, because it is the one `hasSandbox` reads. The
   * round-trip test above would also pass if somebody deleted the assignment
   * from BOTH methods, which would leave a stale DSN pointing at a dropped
   * database — a worse state than the one being fixed.
   */
  it("rebuild writes the DSN `hasSandbox` reads, encrypted", async () => {
    const body = await method("rematerialise");
    expect(body).toMatch(/sandboxDsnEnc: encrypt\(storedRoDsn\(dbName, datasourceId\)\)/);
    expect(body).toContain("sandboxDbName: dbName");
    // ⚠ The fixture's OWN version, never a counter — a rebuild restores a
    // fixture, it does not mint a new one.
    expect(body).toContain("sandboxFixtureVersion: fixture.version");
  });

  /**
   * ⚠ And it happens AFTER `promote`. Registering a DSN before the staging
   * database is promoted points the product at a database that does not exist
   * yet, and a rebuild that fails in between would leave it pointing there for
   * good — the same ordering argument `provision` makes (I-54: build in `_stg`,
   * promote by rename, never in place).
   */
  it("registers only after the promote, never before", async () => {
    const body = await method("rematerialise");
    expect(body.indexOf("await promote(dbName)")).toBeGreaterThan(-1);
    expect(body.indexOf("await promote(dbName)")).toBeLessThan(body.indexOf("sandboxDsnEnc:"));
  });
});

/**
 * ⚠ **`status` must not hand the browser a shape it asserted without checking.**
 *
 * The cast `(fixture?.taxonomyJson as TaxonomyReport | undefined) ?? null` is
 * what shipped `taxonomy: {}` to the client, where `.items.map` threw and took
 * the datasource page down. The column really does hold `{}` — every fixture
 * `mock-dataset.service.ts` writes carries it, because a mock dataset runs no
 * taxonomy — so the cast was asserting a shape the schema never guaranteed.
 *
 * Source-read, in this suite's idiom: `status` needs a database and the
 * property is structural.
 */
describe("a stored taxonomy is validated, not asserted", () => {
  it("status normalises through `taxonomyOf` rather than casting", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    const body = await method("status");
    expect(body).toContain("taxonomy: taxonomyOf(");
    expect(body).toContain("dateRange: taxonomyOf(");
    // ⚠ The cast is gone, not merely shadowed. Both fields read the same
    // stored value, and leaving either on the old form puts the shape back on
    // the wire through the other key.
    expect(body).not.toMatch(/as TaxonomyReport \| undefined/);
  });

  it("`taxonomyOf` requires items to be an ARRAY, not merely truthy", async () => {
    const src = (await readFile(SRC, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    const fn = src.slice(src.indexOf("function taxonomyOf"));
    expect(fn.slice(0, 400)).toContain("Array.isArray(t.items)");
    // Control: the function exists and returns null on the other branch, so
    // this cannot pass against a stub that always answers.
    expect(fn.slice(0, 400)).toContain(": null");
  });
});
