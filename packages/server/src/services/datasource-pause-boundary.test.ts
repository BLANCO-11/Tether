/**
 * **WHERE A PAUSE MAY AND MAY NOT REACH.**
 *
 * The hiding half is easy and is tested next door. This file is the half that
 * matters: a pause that leaked into a fingerprint would turn a UI button into
 * *"suspend every armed automation in this workspace and remove its Kestra
 * schedule"*, silently, with a reason that is not true. A behavioural test for
 * that needs a database and an armed flow; reading the source is what can be
 * asserted deterministically, and it is this repo's idiom for exactly this
 * shape (`TETHER_API_KEY` in three files, `shadowedSecretCollisions` in
 * `step-execution.service.ts`).
 *
 * ⚠ Every assertion carries a control, because the failure mode of a
 * source-reading test is that it scans nothing and passes for ever (I-38).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");

const MODULE = "datasource-model-visibility";
/** Every symbol this module exports, so a rename cannot slip past the scans. */
const SYMBOLS = ["modelVisible", "isPausedFromModel", "DATASOURCE_PAUSED_STATUS"];

/** The body of `name`, from its declaration to the next top-level `  },`. */
function memberBody(source: string, name: string): string {
  const start = source.indexOf(`  async ${name}(`);
  expect(start, `could not find \`${name}\` — the scan would have run on nothing`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  },", start);
  expect(end, `could not find the end of \`${name}\``).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the manifest builder — hidden from the prompt, NOT from the fingerprints", () => {
  const source = read("./manifest-builder.service.ts");

  it("CONTROL: the file imports the visibility module at all", () => {
    expect(source).toContain(MODULE);
  });

  it("⚠ `refFingerprints` does not filter — a fingerprint change SUSPENDS an armed flow", () => {
    const body = memberBody(source, "refFingerprints");
    for (const symbol of SYMBOLS) expect(body).not.toContain(symbol);
  });

  it("⚠ `refInterfaces` does not filter — it decides whether a saved flow still validates", () => {
    const body = memberBody(source, "refInterfaces");
    for (const symbol of SYMBOLS) expect(body).not.toContain(symbol);
  });

  it("CONTROL: `buildAndPersist` DOES filter, so the scans above are not vacuously clean", () => {
    expect(memberBody(source, "buildAndPersist")).toContain("modelVisible");
  });
});

describe("execution never asks whether a datasource is paused", () => {
  /**
   * A paused source keeps serving the flows already built on it. Stopping a
   * running automation is what revoking its approval or deleting the source is
   * for, and it must not be a side effect of a button whose label says the
   * model will not see this any more.
   */
  const RUNTIME = [
    "step-execution.service.ts",
    "step-try.service.ts",
    "datasource-query.service.ts",
    "db-operation.service.ts",
  ];

  for (const file of RUNTIME) {
    it(`${file} does not import it`, () => {
      const source = read(`./${file}`);
      expect(source.length, `${file} read as empty — the scan would prove nothing`).toBeGreaterThan(1000);
      expect(source).not.toContain(MODULE);
    });
  }
});

describe("the ref validator never asks either", () => {
  it("⚠ `flow-validator.service.ts` does not import it — an existing flow must keep saving", () => {
    const source = read("./flow-validator.service.ts");
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toContain(MODULE);
  });
});

describe("every model-facing assembly DOES ask", () => {
  /**
   * Since phase 8 (D-333) the compiled builder is the one authoring path, and
   * `builderCatalogue` is where its model is handed a list. It filters the
   * model-facing `items` and nothing else — the same split the manifest makes.
   */
  const source = read("./builder/builder.service.ts");
  const start = source.indexOf("export async function builderCatalogue(");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  it("CONTROL: builderCatalogue was found and is not empty", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body.length).toBeGreaterThan(500);
  });

  it("the builder's catalogue asks, for saved readers and table readers alike", () => {
    expect(body).toContain("isPausedFromModel");
    expect(body).toMatch(/paused\.has\(e\.datasource\)/);
    expect(body).toMatch(/if \(paused\.has\(ds\.name\)\) continue;/);
  });

  it("⚠ a paused table reader still reaches `cat` and `tables` — an existing flow must keep checking", () => {
    const sig = body.indexOf("cat.refs[r.ref] = r.sig;");
    const tbl = body.indexOf("tables[r.ref] = ");
    const skip = body.indexOf("if (paused.has(ds.name)) continue;");
    expect(sig).toBeGreaterThan(-1);
    expect(tbl).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(Math.max(sig, tbl));
  });
});
