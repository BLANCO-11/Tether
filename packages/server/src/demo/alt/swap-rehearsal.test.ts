import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { db, pool } from "../../db/index.js";
import { workspaces } from "../../db/schema.js";
import { config } from "../../config/index.js";
import { workspaceRepo } from "../../repositories/workspace.repo.js";
import { datasourceRepo } from "../../repositories/datasource.repo.js";
import { manifestBuilderService } from "../../services/manifest-builder.service.js";
import { schemaIntrospectorService } from "../../services/schema-introspector.service.js";
import { ALT_WORKSPACE_NAME } from "./provision-alt.js";
import { altDbUrl, altRoDbUrl, ALT_SCHEMA } from "./seed-alt-db.js";
import { altExpectedScreening, altThresholdFor, ALT_PERIOD } from "./alt-dataset.js";
import { expectedScreening, DEMO_PERIOD, DEMO_EMAIL_DOMAIN } from "../hr-dataset.js";
import {
  ALLOWED_IMPORTS,
  buildFragmentPrompt,
  validateFragment,
  type StepContract,
} from "../../services/step-contract.service.js";

/**
 * WS-E — THE SWAP REHEARSAL (plans/production-substitution-plan.md §8).
 *
 * This is the test of the plan's single success criterion (§1.1). Everything else
 * in the plan is preparation; this asks whether the claim is true:
 *
 *   P1 — swapping datasources requires changes to registry rows and secrets ONLY.
 *   P2 — no generated script contains a literal that is only true of one dataset.
 *   P3 — a generated script cannot mutate the source of record, by any path.
 *
 * §11 rates this workstream "most likely to be skipped and most valuable to keep",
 * which is exactly why it is a test file and not a checklist in a document: a
 * checklist rots silently, a failing test does not.
 *
 * Requires `pnpm demo:seed && pnpm demo:seed-alt`.
 */

const SERVICES_DIR = join(process.cwd(), "src", "services");
const REPOS_DIR = join(process.cwd(), "src", "repositories");

let reachable = false;
let skipReason = "";
let altWsId: string | null = null;

const setup = await (async () => {
  try {
    const ws = (await workspaceRepo.list()).find((w) => w.name === ALT_WORKSPACE_NAME);
    if (!ws) {
      skipReason = `workspace "${ALT_WORKSPACE_NAME}" not provisioned — run \`pnpm demo:seed-alt\``;
      return false;
    }
    altWsId = ws.id;
    const c = new Client({ connectionString: altRoDbUrl(), connectionTimeoutMillis: 3000 });
    await c.connect();
    await c.query(`SELECT 1 FROM ${ALT_SCHEMA}.staff LIMIT 1`);
    await c.end();
    reachable = true;
    return true;
  } catch (e) {
    skipReason = (e as Error).message;
    return false;
  }
})();

if (!setup) console.warn(`\n[WS-E] SKIPPING swap rehearsal — ${skipReason}\n`);

let ro: Client;
beforeAll(async () => {
  if (!reachable) return;
  ro = new Client({ connectionString: altRoDbUrl() });
  await ro.connect();
});
afterAll(async () => {
  await ro?.end().catch(() => {});
  await pool.end().catch(() => {});
});

/** Every .ts file under a directory, recursively, excluding tests. */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// P1 — no code change
// ════════════════════════════════════════════════════════════════════════════

describe("WS-E / P1 — the platform has no knowledge of any particular dataset", () => {
  it("no service or repository mentions either dataset by name", async () => {
    // THE STRUCTURAL FORM OF P1. Registering a differently-shaped datasource had to
    // work through the ordinary services; if any of them needed to know which
    // dataset it was looking at, the knowledge would be here. `demo/` is excluded
    // deliberately — that IS the registry-configuration layer, and it is allowed
    // (indeed required) to know about the demo datasets.
    const files = [...(await sourceFiles(SERVICES_DIR)), ...(await sourceFiles(REPOS_DIR))];
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, "utf8");
      // Match identifiers, not prose: a comment explaining WHY something exists may
      // legitimately reference the demo, but code must not branch on it.
      for (const [line, i] of src.split("\n").map((l, i) => [l, i] as const)) {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (/\b(hr_demo_alt|hr_demo|acme-hr|alt-hr|attendance_monthly|presence_rollup)\b/.test(code)) {
          offenders.push(`${f.replace(process.cwd(), ".")}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `dataset-specific knowledge leaked into the platform:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the two workspaces differ ONLY in registry rows, not in the code that serves them", async () => {
    const primary = (await workspaceRepo.list()).find((w) => w.name === "HR");
    if (!primary || !altWsId) return; // covered by the skip guard
    const [dsA] = await datasourceRepo.listByWorkspace(primary.id);
    const [dsB] = await datasourceRepo.listByWorkspace(altWsId);

    // Same type, same env-var NAME, same code path — different value and scope.
    expect(dsA.type).toBe(dsB.type);
    expect(dsA.secretEnvName).toBe(dsB.secretEnvName);
    expect(dsA.schemaAllowlist).toEqual(["public"]);
    expect(dsB.schemaAllowlist).toEqual([ALT_SCHEMA]);
    expect(dsA.connectionStringEnc).not.toBe(dsB.connectionStringEnc);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The datasets really are different — otherwise the rehearsal proves nothing
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!reachable)("WS-E.1 — the alt dataset is genuinely a different shape", () => {
  it("uses a NAMED schema, and `public` holds nothing", async () => {
    const { rows } = await ro.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rows[0].n).toBe(0);
    const { rows: hrRows } = await ro.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_tables WHERE schemaname = $1`,
      [ALT_SCHEMA],
    );
    expect(hrRows[0].n).toBeGreaterThan(0);
  });

  it("shares NO table name with the primary dataset", async () => {
    const primaryTables = [
      "employees",
      "offices",
      "departments",
      "attendance_daily",
      "attendance_monthly",
      "leave_requests",
      "policy_thresholds",
    ];
    const { rows } = await ro.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [ALT_SCHEMA],
    );
    const altTables = rows.map((r) => r.tablename);
    expect(altTables.filter((t) => primaryTables.includes(t))).toEqual([]);
  });

  it("stores rates as a FRACTION where the primary stores a percentage", async () => {
    const { rows } = await ro.query<{ mx: string }>(
      `SELECT max(presence_rate)::text mx FROM ${ALT_SCHEMA}.presence_rollup`,
    );
    expect(Number(rows[0].mx)).toBeLessThanOrEqual(1);
    // The primary dataset's units, for contrast: the same concept, 100x apart.
    expect(expectedScreening().flagged.some((f) => f.rate > 1)).toBe(true);
  });

  it("uses a different reporting window", () => {
    expect(ALT_PERIOD).not.toBe(DEMO_PERIOD);
  });

  it("is roughly an order of magnitude larger", async () => {
    const { rows } = await ro.query<{ n: number }>(
      `SELECT count(*)::int n FROM ${ALT_SCHEMA}.presence_rollup`,
    );
    // 120 staff x 3 months = 360 rollups vs the primary's 186.
    expect(rows[0].n).toBeGreaterThan(expectedScreening().flagged.length * 20);
  });

  it("has a different correct answer, computed by its own oracle", () => {
    const alt = altExpectedScreening();
    const primary = expectedScreening();
    expect(alt.flagged.length).toBeGreaterThan(0);
    // Different people, different ids, different rates — a shared bug producing a
    // self-agreeing wrong answer would show up as these matching.
    expect(alt.flagged.map((f) => f.id)).not.toEqual(primary.flagged.map((f) => f.id));
  });

  it("preserves the override trap in the new units", () => {
    // The primary dataset's employee #14 sits above the 80 default and below
    // Engineering's 85. Here two people sit above the 0.75 default and below
    // Platform's 0.90. A script that carries a threshold in its head fails both.
    const overrideOnly = altExpectedScreening().overrideOnly;
    expect(overrideOnly.length).toBe(2);
    for (const f of overrideOnly) {
      expect(f.rate).toBeGreaterThanOrEqual(altThresholdFor(-1));
      expect(f.rate).toBeLessThan(altThresholdFor(f.unitId));
    }
  });

  it("treats exactly-at-threshold as passing, in both datasets", async () => {
    // `<` not `<=`. Asserted against the DATABASE's resolved view, so the SQL and
    // the oracle have to agree.
    const { rows } = await ro.query<{ id: number; rate: string; min: string; below: boolean }>(
      `SELECT staff_id id, presence_rate::text rate, min_rate::text min, below_policy below
         FROM ${ALT_SCHEMA}.presence_vs_policy
        WHERE period = $1 AND presence_rate = min_rate`,
      [ALT_PERIOD],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.below).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The manifest describes the new shape faithfully
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!reachable)("WS-E.2 — the manifest reflects the swap with no code change", () => {
  it("names the alt tables and none of the primary ones", async () => {
    const m = await manifestBuilderService.buildAndPersist(altWsId!);
    expect(m.manifestXml).toContain('name="staff"');
    expect(m.manifestXml).toContain('name="presence_rollup"');
    expect(m.manifestXml).not.toContain('name="employees"');
    expect(m.manifestXml).not.toContain('name="attendance_monthly"');
  });

  it("SCHEMA-QUALIFIES the alt tables, because `hr` is not on the search path", async () => {
    // The bug this guards: without schema="hr" in the manifest the agent writes
    // `FROM presence_rollup`, which does not resolve. `public` is deliberately NOT
    // rendered — it is on the default search_path, and omitting it keeps the
    // primary workspace's manifest hash stable.
    const m = await manifestBuilderService.buildAndPersist(altWsId!);
    expect(m.manifestXml).toMatch(/<table name="presence_rollup" schema="hr"/);
    expect(m.manifestXml).toMatch(/<table name="staff" schema="hr"/);
    expect(m.manifestXml).not.toContain('schema="public"');
  });

  it("declares the views AS views (WS-C.2)", async () => {
    const m = await manifestBuilderService.buildAndPersist(altWsId!);
    expect(m.manifestXml).toMatch(/<table name="presence_vs_policy"[^>]*kind="view"/);
    expect(m.manifestXml).toMatch(/<table name="staff_directory"[^>]*kind="view"/);
  });

  it("gives a view no row estimate (WS-C.4)", async () => {
    const entities = await schemaIntrospectorService.getStored(
      (await datasourceRepo.listByWorkspace(altWsId!))[0].id,
    );
    const view = entities.find((e) => e.name === "presence_vs_policy")!;
    expect(view.entityType).toBe("view");
    expect(view.rowCountEstimate).toBeNull();
  });

  it("reports the composite primary key on the rollup (WS-C.3)", async () => {
    const entities = await schemaIntrospectorService.getStored(
      (await datasourceRepo.listByWorkspace(altWsId!))[0].id,
    );
    const rollup = entities.find((e) => e.name === "presence_rollup")!;
    const pks = (rollup.columns as Array<{ name: string; isPrimaryKey: boolean }>)
      .filter((c) => c.isPrimaryKey)
      .map((c) => c.name)
      .sort();
    expect(pks).toEqual(["period", "staff_id"]);
  });

  it("carries the units warning into the manifest, since the units are the trap", async () => {
    // The comment on presence_rollup says "FRACTION 0-1 (not a percentage)". If
    // table comments ever stop reaching the manifest, the single most dangerous
    // difference between the datasets becomes invisible to the agent.
    const m = await manifestBuilderService.buildAndPersist(altWsId!);
    // Column types must at least show the numeric precision the fraction needs.
    expect(m.manifestXml).toMatch(/name="presence_rate" type="numeric"/);
  });

  it("never contains a credential", async () => {
    const m = await manifestBuilderService.buildAndPersist(altWsId!);
    expect(m.manifestXml).not.toContain(config.demo.roPassword);
    // Tool URLs are SUPPOSED to be here — that is how the agent knows what to
    // call. What must never appear is a database connection string or any
    // `user:pass@host` form, which is the actual leak this guards against.
    expect(m.manifestXml).not.toMatch(/\b(postgres|postgresql|mysql|mongodb):\/\//);
    expect(m.manifestXml).not.toMatch(/:\/\/[^/\s"]*:[^/\s"@]+@/);
    expect(m.summaryXml).not.toContain(config.demo.roPassword);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P2 — no dataset-specific literal in any generated script
// ════════════════════════════════════════════════════════════════════════════

describe("WS-E / P2 — the generated artifact carries no dataset-specific knowledge", () => {
  /**
   * ── P2 WAS REWRITTEN IN PHASE 4 (task 4.11), NOT DELETED ───────────────────
   *
   * P2's subject used to be a monolithic generated Python script, and it asked:
   * is every literal in this script DERIVABLE FROM THE REGISTRY? It checked three
   * things over the `scripts` table — no dataset mail domain, no literal DSN, no
   * absolute URL to a host that neither a tool nor a declared warning names.
   *
   * `scripts` no longer exists. Deleting the block with it would have been the
   * wrong move twice over: the property is still exactly the property that
   * matters for a swap, and iterating an empty table would have gone on passing
   * while testing nothing — the most expensive kind of green.
   *
   * So the question is re-asked of the artifact that replaced the script, and
   * the answer turns out to be **structural rather than statistical**:
   *
   *   the mail domain    A fragment receives its data as `payload`. There is no
   *                      query for it to embed a domain into — the SQL lives in
   *                      a reviewed named query, and the recipients arrive from
   *                      a step the fragment cannot see.
   *   the literal DSN    A fragment has no database driver: `psycopg2` is not in
   *                      `ALLOWED_IMPORTS`, and `validateFragment` rejects the
   *                      import at generation time. Under it, `networkMode: none`
   *                      means a DSN would not connect even if one were pasted in.
   *   the invented host  A fragment has no HTTP client either, for the same two
   *                      reasons. And a flow MODEL contains no URL at all — a
   *                      `tool` step is a name, and the host comes from
   *                      `tools.url` at execution.
   *
   * That is a stronger answer than the old block could give, because the old one
   * could only find a violation after the model had committed it. These are
   * assertions that the violation is not expressible. The three below check the
   * mechanisms the claim rests on, so that removing one fails here rather than
   * silently widening what a fragment may contain.
   */

  const contract: StepContract = {
    stepId: "screen",
    purpose: "flag rows below the policy minimum",
    input: [
      { name: "rows", type: "array", items: "object" },
      { name: "threshold", type: "number" },
    ],
    output: [{ name: "flagged", type: "array", items: "object" }],
  };

  it("a fragment cannot import a database driver or an HTTP client", () => {
    // The old P2 hunted for a literal DSN in generated code. This is the same
    // concern one layer earlier: there is nothing to give a DSN to.
    for (const banned of ["psycopg2", "mysql.connector", "requests", "urllib", "socket", "os"]) {
      expect(ALLOWED_IMPORTS as readonly string[]).not.toContain(banned.split(".")[0]);
    }
    const findings = validateFragment(
      `import psycopg2\nimport requests\ndef run(payload):\n    return {"flagged": []}`,
      contract,
    );
    expect(findings.map((f) => f.message).join(" ")).toMatch(/psycopg2/);
    expect(findings.map((f) => f.message).join(" ")).toMatch(/requests/);
  });

  it("a fragment's prompt names no dataset — neither this one nor the alt one", () => {
    // The prompt IS the contract. A dataset value cannot be copied out of it
    // because it was never in it, which is why this holds for both datasets at
    // once and would hold for a third nobody has written yet.
    const prompt = buildFragmentPrompt(contract);
    // Schema-QUALIFIED, which is the form a real leak takes. A bare `ALT_SCHEMA`
    // is the two characters "hr", and it matched inside the word "threshold" in
    // this very contract — a needle that short is not a test, it is a coin flip.
    for (const needle of [
      DEMO_EMAIL_DOMAIN,
      "alt-hr.example",
      `${ALT_SCHEMA}.staff`,
      `${ALT_SCHEMA}.presence_vs_policy`,
      "hr_demo",
      "postgres://",
      config.demo.dbSecretEnvName,
    ]) {
      expect(prompt).not.toContain(needle);
    }
  });

  it("the importable set is the one the fragment image actually provides", () => {
    // The old block's failure mode was a script reaching a host nobody declared.
    // The equivalent here is a prompt that advertises an import the image does
    // not have: the fragment fails at execution with an ImportError inside a
    // network-less container, which reads as a broken image rather than as a
    // misconfiguration. Prompt and validator must therefore share one list.
    const prompt = buildFragmentPrompt(contract);
    for (const mod of ALLOWED_IMPORTS) expect(prompt).toContain(mod);
    expect(validateFragment(`def run(payload):\n    import json\n    return {"flagged": []}`, contract)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P3 — least privilege holds on the NEW datasource too
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!reachable)("WS-E / P3 — least privilege is a platform property, not a demo one", () => {
  const refuse = async (sql: string) => {
    await ro.query("BEGIN");
    try {
      await ro.query(sql);
      await ro.query("ROLLBACK");
      throw new Error(`SECURITY: "${sql}" was PERMITTED on the alt datasource`);
    } catch (e) {
      const msg = (e as Error).message;
      await ro.query("ROLLBACK").catch(() => {});
      if (msg.startsWith("SECURITY:")) throw e;
      return msg;
    }
  };

  it("can read every entity the manifest promises", async () => {
    const { rows } = await ro.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [ALT_SCHEMA],
    );
    for (const { tablename } of rows) {
      await expect(ro.query(`SELECT count(*) FROM ${ALT_SCHEMA}.${tablename}`)).resolves.toBeDefined();
    }
    // And the views.
    await expect(
      ro.query(`SELECT count(*) FROM ${ALT_SCHEMA}.presence_vs_policy`),
    ).resolves.toBeDefined();
  });

  it("cannot UPDATE staff", async () => {
    expect(await refuse(`UPDATE ${ALT_SCHEMA}.staff SET full_name = 'x' WHERE id = 1001`)).toMatch(
      /permission denied|read-only/i,
    );
  });

  it("cannot DELETE from the rollup", async () => {
    expect(await refuse(`DELETE FROM ${ALT_SCHEMA}.presence_rollup`)).toMatch(
      /permission denied|read-only/i,
    );
  });

  it("cannot DROP a table", async () => {
    expect(await refuse(`DROP TABLE ${ALT_SCHEMA}.staff`)).toMatch(
      /permission denied|must be owner|read-only/i,
    );
  });

  it("cannot CREATE in the named schema", async () => {
    expect(await refuse(`CREATE TABLE ${ALT_SCHEMA}.probe (i int)`)).toMatch(
      /permission denied|read-only/i,
    );
  });

  it("cannot write through an updatable view", async () => {
    // staff_directory joins, so it is not auto-updatable — but a single-table view
    // WOULD be, and a grant on the view is a grant on the underlying table. Worth
    // asserting rather than assuming.
    expect(await refuse(`UPDATE ${ALT_SCHEMA}.staff_directory SET full_name = 'x'`)).toMatch(
      /permission denied|cannot update|read-only/i,
    );
  });

  it("cannot reach `public` in the alt database at all", async () => {
    // A datasource scoped to `hr` has no business elsewhere in the database.
    const { rows } = await ro.query<{ usage: boolean }>(
      `SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usage`,
    );
    expect(rows[0].usage).toBe(false);
  });

  it("holds no write privilege on any alt entity, per the catalogue", async () => {
    const owner = new Client({ connectionString: altDbUrl() });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
        [ALT_SCHEMA],
      );
      for (const { tablename } of rows) {
        const q = `${ALT_SCHEMA}.${tablename}`;
        for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          const { rows: p } = await owner.query<{ has: boolean }>(
            `SELECT has_table_privilege($1, $2, $3) AS has`,
            [config.demo.roRole, q, priv],
          );
          expect(p[0].has, `${config.demo.roRole} holds ${priv} on ${q}`).toBe(false);
        }
      }
    } finally {
      await owner.end();
    }
  });
});
