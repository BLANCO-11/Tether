/**
 * Fixtures — rows written from the SHAPE, and the taxonomy that says they are
 * worth testing against.
 * DECISIONS.md D-53, D-54 · ISSUES.md I-54…I-56
 *
 * ── What the model is allowed to see, and why that is the whole design ───────
 *
 * `buildTablePrompt` takes a `SandboxShape` and a set of already-generated key
 * values. It has no database handle, no DSN, no datasource id and no way to
 * obtain one. That is deliberate and it is the property the stage rests on: the
 * generator **adds zero exposure**, because the schema is already the largest
 * block of the drafting prompt and a model that has seen the manifest has seen
 * everything this function passes.
 *
 * ⚠ **The model must never be shown real rows to imitate.** Not as examples, not
 * as "a few representative records", not summarised. The moment it is, the
 * fixture becomes a lossy copy of production and the sandbox is no longer a
 * substitute for it — it is a redistribution of it. `sandbox-fixture.test.ts`
 * asserts this function's signature cannot reach data.
 *
 * ── The three named traps, and the compensating control for each ─────────────
 *
 * 1. **A self-agreeing oracle.** If one model invents the rows AND certifies
 *    them, a misreading lands in both and agrees with itself. So the model does
 *    not certify anything: `verifyTaxonomy` is deterministic code running SQL
 *    against the loaded database, and it can fail a fixture the generator was
 *    perfectly happy with. Same argument `demo:rehearse` uses for keeping its
 *    oracle a separate function.
 * 2. **"Tested on fixtures" ≠ "correct on production."** Nothing here claims
 *    otherwise, and `sandbox.service.ts` puts the caveat on the run itself.
 * 3. **A generated artefact is load-bearing.** D-34 says a model's output must be
 *    terminal, and a fixture is consumed by every draft run — this deliberately
 *    crosses that line. The compensating controls are that it is verified before
 *    it is accepted, frozen once accepted, and fingerprinted against the shape
 *    it was written for.
 */
import type pg from "pg";
import type { SandboxShape, SandboxTable, ValueKind } from "./sandbox-ddl.service.js";
import { qualify } from "./sandbox-ddl.service.js";
import type { InferenceClient } from "./inference.service.js";

/** Rows per table. Small enough to generate reliably, large enough that a group can be empty. */
export const TARGET_ROWS = 12;
/** Below this a table is bland by construction — see the `volume` taxonomy item. */
export const MIN_ROWS = 8;

export type FixtureRows = Record<string, Array<Record<string, unknown>>>;

/**
 * The window generated dates must fall in.
 *
 * ── Why this is a parameter and not left to the model ────────────────────────
 *
 * Measured on the first real run of `kestra:sandbox`: the model wrote a
 * perfectly good fixture whose `work_date` values were in **October 2023**. Every
 * taxonomy category passed — the dates spanned two months, there were rows
 * strictly inside the range — and an HR flow asked for `2026-06` would have read
 * that sandbox and found **nothing**, which on screen is indistinguishable from a
 * flow that is broken.
 *
 * Passed in rather than computed here so the value is one a caller chose and a
 * test can pin. `sandboxService.provision` uses the three months ending today.
 */
export interface DateWindow {
  from: string;
  to: string;
}

// ── the taxonomy ─────────────────────────────────────────────────────────────

export interface TaxonomyItem {
  id: string;
  /** What a person is being promised. */
  title: string;
  satisfied: boolean;
  /**
   * ⚠ Required when satisfied. A check that answers "yes" without naming the
   * table, column and values that satisfied it is unfalsifiable — it reads
   * identically whether it looked or not.
   */
  evidence: string | null;
}

export interface TaxonomyReport {
  items: TaxonomyItem[];
  /** Referential integrity is not a taxonomy item: it MUST hold, it is not a flavour. */
  integrity: { ok: boolean; problems: string[] };
  /**
   * The earliest and latest date anywhere in the fixture, or null if it holds no
   * dates. Reported because it is the question a person asks after their first
   * sandbox run returns zero rows — see `DateWindow`.
   */
  dateRange: { from: string; to: string } | null;
  passed: boolean;
}

/**
 * The seven categories, as prose the generator is given verbatim.
 *
 * ⚠ These strings appear in BOTH the prompt and the checks, and that is the
 * point: `sandbox-fixture.test.ts` asserts every id in `TAXONOMY` has a checker
 * and vice versa, so a category can never be asked for and not verified. Asking
 * without verifying is the failure mode — it produces a document claiming seven
 * properties and a fixture with none of them.
 */
export const TAXONOMY: Array<{ id: string; title: string; ask: string }> = [
  {
    id: "volume",
    title: "enough rows that a group can be empty",
    ask: `every table has at least ${MIN_ROWS} rows`,
  },
  {
    id: "near_threshold",
    title: "a boundary value that would fall the wrong side of a policy override",
    ask:
      "at least one numeric column contains two rows sitting a hair either side of a round " +
      "number (e.g. 79.6 and 80.4 where 80 is a plausible policy threshold) — the case a rule " +
      "that hardcodes the threshold gets wrong",
  },
  {
    id: "null_in_optional",
    title: "a NULL in an optional but load-bearing column",
    ask:
      "at least one nullable column has a NULL in some rows and a value in others — never a " +
      "column that is entirely NULL, which tests nothing",
  },
  {
    id: "empty_group",
    title: "a group with no members",
    ask:
      "at least one parent row (a department, a cost centre, an office) that NO child row " +
      "references, so a grouped query returns it with nothing in it — or omits it",
  },
  {
    id: "date_span",
    title: "dates spanning more than one period, with entries inside it",
    ask:
      "date and timestamp columns span at least two different calendar months, and at least " +
      "one row falls strictly between the earliest and the latest",
  },
  {
    id: "duplicate",
    title: "two records that look like the same entity",
    ask:
      "exactly one pair of rows shares a value in a column that is otherwise unique " +
      "(the same email address, or the same full name) while having different primary keys",
  },
  {
    id: "unicode_text",
    title: "a name that is not ASCII",
    ask: "at least one text value contains non-ASCII characters (accents, or a non-Latin script)",
  },
];

// ── the prompt ───────────────────────────────────────────────────────────────

function columnLine(c: SandboxTable["columns"][number]): string {
  const bits = [c.sqlType];
  if (!c.nullable) bits.push("NOT NULL");
  if (c.isPrimaryKey) bits.push("PRIMARY KEY");
  if (c.references) bits.push(`references ${c.references}`);
  return `  - ${c.name}: ${bits.join(", ")}`;
}

/**
 * The prompt for ONE table.
 *
 * One call per table rather than one for the whole schema, for three reasons
 * that all turned out to matter: a whole-schema answer runs into the gateway's
 * output cap and truncates mid-row (which parses as "the model misbehaved");
 * foreign keys can only be satisfied if the parent's keys are already decided;
 * and a per-table call makes the call COUNT observable, the same argument
 * `inference.service.ts` makes for its own existence.
 *
 * `parentKeys` carries values from tables already generated IN THIS RUN. They
 * are synthetic by construction — there is no path by which a real row reaches
 * this parameter, because the only writer is `generateFixture` below and its
 * only source is a previous call's output.
 */
export function buildTablePrompt(opts: {
  table: SandboxTable;
  shape: SandboxShape;
  parentKeys: Record<string, unknown[]>;
  rows: number;
  /** The window every date must fall in. See `DateWindow`. */
  window: DateWindow;
}): string {
  const { table, shape, parentKeys, rows, window } = opts;
  const siblings = shape.tables
    .filter((t) => t.key !== table.key)
    .map((t) => `  ${t.key}(${t.columns.map((c) => c.name).join(", ")})`)
    .join("\n");

  const fkLines = table.columns
    .filter((c) => c.references)
    .map((c) => {
      const available = parentKeys[c.references!];
      return available && available.length
        ? `  - ${c.name} must be one of: ${JSON.stringify(available)}`
        : `  - ${c.name} references ${c.references}, whose rows are not yet decided — use plausible values`;
    })
    .join("\n");

  return [
    "You are writing SYNTHETIC TEST DATA for one table. It will be loaded into a throwaway",
    "database used to exercise automations during development. No real person, company,",
    "address or account may appear. Use invented names and RFC 2606 reserved domains",
    "(example.com, example.org) for anything that looks like an email or a hostname.",
    "",
    "TABLE",
    `  ${table.key}`,
    ...table.columns.map(columnLine),
    "",
    "OTHER TABLES IN THIS SCHEMA (for context — do not write rows for them)",
    siblings || "  (none)",
    "",
    fkLines ? `FOREIGN KEYS\n${fkLines}\n` : "",
    "REQUIRED PROPERTIES",
    "The point of this data is to catch bugs, so it must contain the awkward cases. Where a",
    "property below can apply to this table, make it apply:",
    ...TAXONOMY.map((t) => `  - ${t.ask}`),
    "",
    "RULES",
    `  - Write exactly ${rows} rows.`,
    "  - Every value must be valid for its declared SQL type. Dates are \"YYYY-MM-DD\";",
    "    timestamps are \"YYYY-MM-DD HH:MM:SS\". Use null for SQL NULL.",
    `  - Every date and timestamp must fall between ${window.from} and ${window.to}.`,
    "    A flow filters on a reporting period, and rows outside the window it asks for are rows",
    "    it will never see — a sandbox that returns nothing looks like a broken flow.",
    "  - Primary key values must be unique.",
    "  - Do not add columns that are not declared, and do not omit declared ones.",
    "",
    "ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE:",
    '  { "rows": [ { "<column>": <value>, ... }, ... ] }',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Pull the first balanced JSON object out of a model answer, fences and all. */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error("the answer contains no JSON object");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error("the answer's JSON object is not closed — the model was probably truncated");
}

/**
 * Coerce a model-written scalar to something `pg` will bind for this column.
 *
 * Narrow on purpose. A value that is the wrong shape must reach the database and
 * be REFUSED there, because the database is the authority on what the column
 * accepts and a helpful coercion here is how a fixture ends up holding something
 * production would reject.
 */
export function bindValue(kind: ValueKind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (kind === "json") return JSON.stringify(v);
  if (kind === "array") return Array.isArray(v) ? v : [v];
  return v;
}

/** Order tables so a parent is inserted before anything referencing it. */
export function topoOrder(tables: SandboxTable[]): SandboxTable[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const done = new Set<string>();
  const out: SandboxTable[] = [];
  // Bounded rather than recursive: a circular FK is legal in Postgres and must
  // not hang provisioning. After `tables.length` passes anything still unplaced
  // is in a cycle, and is appended in declaration order — which is safe here
  // precisely because the DDL does not enforce foreign keys.
  for (let pass = 0; pass < tables.length + 1 && done.size < tables.length; pass++) {
    for (const t of tables) {
      if (done.has(t.key)) continue;
      const parents = t.columns
        .map((c) => c.references?.split(".")[0])
        .filter((n): n is string => !!n && n !== t.name && byName.has(n));
      if (parents.every((p) => done.has(byName.get(p)!.key))) {
        done.add(t.key);
        out.push(t);
      }
    }
  }
  for (const t of tables) if (!done.has(t.key)) out.push(t);
  return out;
}

export interface GenerateResult {
  rows: FixtureRows;
  /** One entry per inference call — the count is the observable, so it is returned. */
  calls: Array<{ table: string; chars: number }>;
}

/**
 * Ask the model for every table's rows, parents first.
 *
 * A per-table failure is fatal. There is no partial fixture: a schema loaded with
 * five of its seven tables filled is a sandbox whose joins silently return
 * nothing, which is the single most convincing way to make a broken flow look
 * like a correct one that found no matches.
 */
export async function generateFixture(opts: {
  shape: SandboxShape;
  client: InferenceClient;
  window: DateWindow;
  rows?: number;
  onProgress?: (msg: string) => void;
}): Promise<GenerateResult> {
  const rowTarget = opts.rows ?? TARGET_ROWS;
  const ordered = topoOrder(opts.shape.tables);
  const out: FixtureRows = {};
  const parentKeys: Record<string, unknown[]> = {};
  const calls: GenerateResult["calls"] = [];

  for (const table of ordered) {
    const prompt = buildTablePrompt({
      table,
      shape: opts.shape,
      parentKeys,
      rows: rowTarget,
      window: opts.window,
    });
    opts.onProgress?.(`generating ${table.key} (${rowTarget} rows)`);
    const answer = await opts.client.complete(prompt, {
      label: `fixture:${table.key}`,
      timeoutMs: 180_000,
    });
    calls.push({ table: table.key, chars: prompt.length });

    let parsed: unknown;
    try {
      parsed = extractJsonObject(answer);
    } catch (e) {
      throw new Error(`fixture for ${table.key}: ${(e as Error).message}`);
    }
    const rows = (parsed as { rows?: unknown }).rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`fixture for ${table.key}: the answer has no "rows" array`);
    }
    const declared = new Set(table.columns.map((c) => c.name));
    const cleaned = rows.map((r) => {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
        // Extra keys are dropped rather than rejected: the model occasionally
        // echoes a helper field, and failing the whole table for it would cost a
        // regeneration to gain nothing. Missing keys are NOT dropped — they
        // arrive as NULL and a NOT NULL column refuses them at insert.
        if (declared.has(k)) row[k] = v;
      }
      return row;
    });
    out[table.key] = cleaned;

    /**
     * Publish this table's key values for anything that references it.
     *
     * ⚠ **EVERY REFERENCED COLUMN, NOT ONLY THE PRIMARY KEY.** This read
     * `if (!c.isPrimaryKey) continue;` and it broke every NATURAL-key foreign
     * key in the product — measured 2026-09-04, provisioning all seven demo
     * datasources:
     *
     *   legal:   contracts.type_code -> contract_types.code   12 of 12 dangling
     *   finance: expense_claims.category -> expense_policy.category   1 dangling
     *
     * `contract_types.code` is UNIQUE and referenced, and is not the primary
     * key (the table has a surrogate `id`), so its values were never published.
     * `buildTablePrompt` then fell through to its own else-branch — *"whose
     * rows are not yet decided — use plausible values"* — and the model duly
     * invented twelve plausible codes that matched nothing. `topoOrder`
     * already generates the parent first, so the values existed the whole
     * time; nothing handed them over.
     *
     * ⚠ It failed **loudly**, at the integrity check, with no sandbox left
     * behind — which is why it is a fixed bug rather than a silent one. But it
     * failed on exactly the two schemas whose codes carry meaning, and the
     * surrogate-key tables passed, so "it works" was true of the easy half.
     */
    const referenced = new Set(
      opts.shape.tables.flatMap((t) =>
        t.columns.filter((c) => c.references).map((c) => c.references!),
      ),
    );
    for (const c of table.columns) {
      const ref = `${table.name}.${c.name}`;
      if (!c.isPrimaryKey && !referenced.has(ref)) continue;
      parentKeys[ref] = cleaned.map((r) => r[c.name]).filter((v) => v !== null && v !== undefined);
    }
  }
  return { rows: out, calls };
}

// ── loading ──────────────────────────────────────────────────────────────────

/**
 * Insert the fixture into a materialised sandbox database.
 *
 * `client` must be connected AS THE SANDBOX OWNER. It is never the read-only DSN
 * a draft run uses, and never a tenant credential — D-40 guarantees Foundry
 * holds no writable credential for a tenant database, so there is no handle here
 * that could reach one.
 */
export async function loadFixture(
  client: pg.Client,
  shape: SandboxShape,
  rows: FixtureRows,
): Promise<void> {
  for (const table of topoOrder(shape.tables)) {
    const data = rows[table.key] ?? [];
    if (data.length === 0) continue;
    const cols = table.columns;
    const colList = cols.map((c) => `"${c.name}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${qualify(table)} (${colList}) VALUES (${placeholders})`;
    for (const [i, row] of data.entries()) {
      const values = cols.map((c) => bindValue(c.kind, row[c.name] ?? null));
      try {
        await client.query(sql, values);
      } catch (e) {
        throw new Error(
          `fixture row ${i + 1} of ${table.key} was refused by the database: ${(e as Error).message}`,
        );
      }
    }
  }
}

// ── verification: SQL against the loaded database, never against the JSON ────

/**
 * Why every check below runs SQL rather than reading `rows`.
 *
 * The JSON is what the model said; the database is what a flow will actually
 * read. They differ whenever a coercion, a NOT NULL, a length limit or a numeric
 * scale changed the value on the way in — `numeric(5,2)` silently rounds 80.955
 * to 80.96, and a taxonomy check reading the JSON would certify a boundary case
 * the query cannot see. The plan says "verify with SQL"; this is why.
 */
async function scalar<T>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await client.query(sql, params);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return Object.values(row)[0] as T;
}

const NUMERIC_KINDS: ValueKind[] = ["int", "decimal"];
const TEXT_KINDS: ValueKind[] = ["text"];
const DATE_KINDS: ValueKind[] = ["date", "timestamp"];

async function checkVolume(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  let worst: { table: string; n: number } | null = null;
  for (const t of shape.tables) {
    const n = Number(await scalar<string>(client, `SELECT count(*) FROM ${qualify(t)}`));
    if (!worst || n < worst.n) worst = { table: t.key, n };
  }
  if (!worst) return item("volume", false, null);
  return item(
    "volume",
    worst.n >= MIN_ROWS,
    `smallest table is ${worst.table} with ${worst.n} row(s); the floor is ${MIN_ROWS}`,
  );
}

/**
 * A boundary value: two rows straddling a round number, close enough together
 * that a rule using the wrong threshold gets exactly one of them wrong.
 *
 * "Round" is scaled to the column, not hardcoded: a step of 10 across a 0–100
 * attendance rate and a step of 100000 across amounts in minor units are the
 * same idea. The tolerance is 2% of the column's own range, so the check does
 * not become trivially true on a wide column or impossible on a narrow one.
 */
async function checkNearThreshold(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  for (const t of shape.tables) {
    for (const c of t.columns) {
      if (!NUMERIC_KINDS.includes(c.kind) || c.isPrimaryKey || c.references) continue;
      const r = await client.query(
        `SELECT DISTINCT "${c.name}"::double precision AS v FROM ${qualify(t)} WHERE "${c.name}" IS NOT NULL ORDER BY 1`,
      );
      const vs = r.rows.map((x) => Number((x as { v: number }).v)).filter((n) => Number.isFinite(n));
      if (vs.length < 2) continue;
      const range = vs[vs.length - 1]! - vs[0]!;
      if (range <= 0) continue;
      const step = Math.pow(10, Math.round(Math.log10(range / 10)));
      const tol = range * 0.02;
      for (let i = 1; i < vs.length; i++) {
        const a = vs[i - 1]!;
        const b = vs[i]!;
        if (b - a > tol) continue;
        const threshold = Math.ceil(a / step) * step;
        if (threshold > a && threshold <= b) {
          return item(
            "near_threshold",
            true,
            `${t.key}.${c.name} has ${a} and ${b} straddling ${threshold} (step ${step}, ` +
              `tolerance ${tol.toFixed(3)} = 2% of the column's range)`,
          );
        }
      }
    }
  }
  return item("near_threshold", false, null);
}

async function checkNullInOptional(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  for (const t of shape.tables) {
    for (const c of t.columns) {
      if (!c.nullable || c.isPrimaryKey) continue;
      const r = await client.query(
        `SELECT count(*) FILTER (WHERE "${c.name}" IS NULL) AS nulls, count(*) AS total FROM ${qualify(t)}`,
      );
      const { nulls, total } = r.rows[0] as { nulls: string; total: string };
      const n = Number(nulls);
      const all = Number(total);
      if (n > 0 && n < all) {
        return item(
          "null_in_optional",
          true,
          `${t.key}.${c.name} is NULL in ${n} of ${all} rows — present in the rest, so a query ` +
            `that forgets to handle it produces a partial answer rather than an empty one`,
        );
      }
    }
  }
  return item("null_in_optional", false, null);
}

async function checkEmptyGroup(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  for (const child of shape.tables) {
    for (const c of child.columns) {
      if (!c.references) continue;
      const [parentName, parentCol] = c.references.split(".");
      const parent = shape.tables.find((t) => t.name === parentName);
      if (!parent || !parentCol) continue;
      const orphanFree = `SELECT count(*) FROM ${qualify(parent)} p WHERE NOT EXISTS (
           SELECT 1 FROM ${qualify(child)} k WHERE k."${c.name}" = p."${parentCol}")`;
      const n = Number(await scalar<string>(client, orphanFree));
      if (n > 0) {
        return item(
          "empty_group",
          true,
          `${n} row(s) of ${parent.key} are referenced by no row of ${child.key}.${c.name} — ` +
            `a grouped query over them returns an empty group, which is also the zero-row case`,
        );
      }
    }
  }
  return item("empty_group", false, null);
}

async function checkDateSpan(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  for (const t of shape.tables) {
    for (const c of t.columns) {
      if (!DATE_KINDS.includes(c.kind)) continue;
      const r = await client.query(
        `SELECT count(DISTINCT date_trunc('month', "${c.name}")) AS months,
                min("${c.name}")::text AS lo, max("${c.name}")::text AS hi,
                count(*) FILTER (
                  WHERE "${c.name}" > (SELECT min("${c.name}") FROM ${qualify(t)})
                    AND "${c.name}" < (SELECT max("${c.name}") FROM ${qualify(t)})) AS inside
         FROM ${qualify(t)}`,
      );
      const row = r.rows[0] as { months: string; lo: string; hi: string; inside: string };
      if (Number(row.months) >= 2 && Number(row.inside) > 0) {
        return item(
          "date_span",
          true,
          `${t.key}.${c.name} spans ${row.months} months (${row.lo} … ${row.hi}) with ` +
            `${row.inside} row(s) strictly inside — so a period filter can include and exclude`,
        );
      }
    }
  }
  return item("date_span", false, null);
}

/**
 * A duplicate that means something: a collision in a column that is otherwise
 * unique.
 *
 * A repeated department name is not a duplicate record, it is a category — so
 * the column has to be near-unique (>70% distinct) before a collision in it
 * counts. Without that bound this check passes on every fixture with an enum in
 * it, and a check that cannot fail is worse than none.
 */
async function checkDuplicate(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  for (const t of shape.tables) {
    for (const c of t.columns) {
      if (!TEXT_KINDS.includes(c.kind) || c.isPrimaryKey || c.references) continue;
      const r = await client.query(
        `SELECT count(*) AS total, count(DISTINCT "${c.name}") AS distinct_values FROM ${qualify(t)}
         WHERE "${c.name}" IS NOT NULL`,
      );
      const { total, distinct_values } = r.rows[0] as { total: string; distinct_values: string };
      const n = Number(total);
      const d = Number(distinct_values);
      if (n < 2 || d === n) continue;
      if (d / n < 0.7) continue; // a category, not an identity
      const dup = await client.query(
        `SELECT "${c.name}"::text AS v, count(*) AS n FROM ${qualify(t)}
         WHERE "${c.name}" IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 1`,
      );
      const hit = dup.rows[0] as { v: string; n: string } | undefined;
      if (hit) {
        return item(
          "duplicate",
          true,
          `${t.key}.${c.name} is ${d}/${n} distinct and "${hit.v}" appears ${hit.n} times — ` +
            `two rows that look like the same entity`,
        );
      }
    }
  }
  return item("duplicate", false, null);
}

async function checkUnicode(client: pg.Client, shape: SandboxShape): Promise<TaxonomyItem> {
  for (const t of shape.tables) {
    for (const c of t.columns) {
      if (!TEXT_KINDS.includes(c.kind)) continue;
      const r = await client.query(
        `SELECT "${c.name}"::text AS v FROM ${qualify(t)} WHERE "${c.name}" ~ '[^\\x00-\\x7F]' LIMIT 1`,
      );
      const hit = r.rows[0] as { v: string } | undefined;
      if (hit) return item("unicode_text", true, `${t.key}.${c.name} contains "${hit.v}"`);
    }
  }
  return item("unicode_text", false, null);
}

function item(id: string, satisfied: boolean, evidence: string | null): TaxonomyItem {
  const spec = TAXONOMY.find((t) => t.id === id);
  return { id, title: spec?.title ?? id, satisfied, evidence: satisfied ? evidence : null };
}

/**
 * ⚠ Keyed by id and asserted complete by a test. A category in `TAXONOMY` with
 * no entry here would be asked for in the prompt and never checked, which is the
 * shape of a control that cannot fail.
 */
const CHECKS: Record<string, (c: pg.Client, s: SandboxShape) => Promise<TaxonomyItem>> = {
  volume: checkVolume,
  near_threshold: checkNearThreshold,
  null_in_optional: checkNullInOptional,
  empty_group: checkEmptyGroup,
  date_span: checkDateSpan,
  duplicate: checkDuplicate,
  unicode_text: checkUnicode,
};

export const TAXONOMY_CHECK_IDS = Object.keys(CHECKS);

/** Every foreign key resolves. Not a flavour — a fixture with orphans is wrong. */
export async function verifyIntegrity(
  client: pg.Client,
  shape: SandboxShape,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const child of shape.tables) {
    for (const c of child.columns) {
      if (!c.references) continue;
      const [parentName, parentCol] = c.references.split(".");
      const parent = shape.tables.find((t) => t.name === parentName);
      if (!parent || !parentCol) continue; // reported as a note by deriveShape
      const n = Number(
        await scalar<string>(
          client,
          `SELECT count(*) FROM ${qualify(child)} k WHERE k."${c.name}" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${qualify(parent)} p WHERE p."${parentCol}" = k."${c.name}")`,
        ),
      );
      if (n > 0) {
        problems.push(
          `${child.key}.${c.name} has ${n} value(s) with no matching ${parent.key}.${parentCol}`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Run every check against the loaded sandbox.
 *
 * `passed` requires ALL of them plus integrity. A partial pass is not a fixture
 * worth freezing: the categories are not a wish list, they are the reason the
 * fixture is more useful than random rows.
 */
export async function verifyTaxonomy(
  client: pg.Client,
  shape: SandboxShape,
): Promise<TaxonomyReport> {
  const items: TaxonomyItem[] = [];
  for (const spec of TAXONOMY) {
    const check = CHECKS[spec.id];
    if (!check) throw new Error(`taxonomy category "${spec.id}" has no checker`);
    items.push(await check(client, shape));
  }
  const integrity = await verifyIntegrity(client, shape);
  return {
    items,
    integrity,
    dateRange: await observedDateRange(client, shape),
    passed: integrity.ok && items.every((i) => i.satisfied),
  };
}

/** The span every date column in the fixture actually covers. */
async function observedDateRange(
  client: pg.Client,
  shape: SandboxShape,
): Promise<{ from: string; to: string } | null> {
  let lo: string | null = null;
  let hi: string | null = null;
  for (const t of shape.tables) {
    for (const c of t.columns) {
      if (!DATE_KINDS.includes(c.kind)) continue;
      const r = await client.query(
        `SELECT min("${c.name}")::text AS lo, max("${c.name}")::text AS hi FROM ${qualify(t)}`,
      );
      const row = r.rows[0] as { lo: string | null; hi: string | null };
      if (row?.lo && (lo === null || row.lo < lo)) lo = row.lo;
      if (row?.hi && (hi === null || row.hi > hi)) hi = row.hi;
    }
  }
  return lo && hi ? { from: lo.slice(0, 10), to: hi.slice(0, 10) } : null;
}
