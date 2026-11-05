/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE GENERIC TENANTS, FROM ONE ENGINE — and why THIS is where it was extracted
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `seed-itops-db.ts` sets out the argument this file has to answer. It says a
 * shared tenant roster was considered and set aside twice, because *"the module
 * every tenant seeder imports is the module a bug in one of them reaches all
 * four through"*. And it names the condition for revisiting it:
 *
 *   > If a fifth is ever added, extract the roster THEN and argue it on its own
 *   > merits; do not do it as a tidy-up inside another feature.
 *
 * This is tenants five, six and seven, arriving together. The argument, on its
 * own merits:
 *
 *  * **The duplication risk inverts when domains arrive in a batch.** Four
 *    seeders written months apart drift slowly and visibly. Three written in one
 *    sitting are copy-paste of each other by construction — the bug that reaches
 *    all three is one somebody types once and pastes twice, which is exactly
 *    what a shared module prevents rather than causes.
 *  * **The four existing seeders are UNTOUCHED.** HR, Finance, Legal and IT
 *    Operations still each own their file, so the property those files claim —
 *    that adding a tenant needs no change to the ones already there — is still
 *    literally true, and this feature is its fifth demonstration.
 *  * **The roster is the part that genuinely wanted extracting.** It named four
 *    databases in four files; it now names seven, and a domain declares only
 *    its own name.
 *
 * ⚠ **What is NOT shared is the DATA and the QUERIES.** Every domain brings its
 * own schema, its own rows, its own named queries and its own oracle. That is
 * deliberate and it is the half that matters: a shared oracle lets a shared bug
 * produce a wrong answer that agrees with itself, which is the rule
 * `financeOracle` and `legalOracle` were each written separately to preserve.
 *
 * ── ⚠ EACH DOMAIN TEACHES A DIFFERENT RULE, AND THEY MUST NOT BE MADE
 *      CONSISTENT ──────────────────────────────────────────────────────────────
 *
 * Finance teaches `>` (due today is not overdue). Legal teaches the opposite
 * `<=` (a notice deadline on the as-of date is the last day it can be served).
 * IT Operations teaches a FRACTION of each policy's own budget. The three here
 * continue that: a **cancelled line is not revenue**, a **partial shipment is not
 * a fulfilled order**, and a **non-response is not a satisfied customer**. Two
 * datasets that disagree is the only arrangement where the rule has to be read.
 */
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { config } from "../../config/index.js";
import type { OpsService } from "../../services/ops-client.service.js";
import { applyColumnTags } from "../address-tags.js";

/** A named query as the datasource layer stores it. */
export interface DomainQuery {
  name: string;
  description: string;
  sqlText: string;
  paramOrder: string[];
  paramsSchema: Record<string, { type: string; required: boolean; description: string }>;
}

/** One table's worth of synthetic rows. */
export interface DomainTable {
  table: string;
  columns: string[];
  rows: unknown[][];
}

export interface DomainSpec {
  /** `support` — used for the database name, the role and the secret env var. */
  key: string;
  /** The workspace's display name, as a person sees it on the flows list. */
  workspaceName: string;
  /** `support_demo`. */
  dbName: string;
  /** `support_ro`. */
  roRole: string;
  /** `SUPPORT_DB_URL` — its own, never shared. See the note on the constant below. */
  secretEnv: string;
  /** DDL. DROPs and recreates, so grants must follow it — see `seedDomainDatabase`. */
  ddl: string;
  /** Insert order matters: foreign keys are declared. */
  tables: DomainTable[];
  queries: DomainQuery[];
  /** Which ops-api services this workspace holds a credential for. */
  opsServices: OpsService[];
  /** One paragraph for the person being shown the product. */
  description: string;
}

/**
 * Every demo database, including the four that predate this file.
 *
 * ⚠ **This is the roster `seed-itops-db.ts` said to extract at the fifth
 * tenant.** A read-only role is checked against every OTHER name here, so
 * adding a domain to this list is what makes the existing six check themselves
 * against it — the thing that needed an edit in four files and now needs one.
 *
 * ⚠ It is still NOT symmetric, and saying so matters: the four older seeders
 * carry their own hardcoded lists and this file does not edit them, so
 * `foundry_ro`, `finance_ro`, `legal_ro` and `itops_ro` are still not checked
 * against the three new databases. Never describe this as full tenant isolation.
 */
export const ALL_DEMO_DATABASES = [
  "hr_demo",
  "hr_demo_alt",
  "finance_demo",
  "legal_demo",
  "itops_demo",
  "support_demo",
  "orders_demo",
  "hiring_demo",
  // The compiled-builder held-out domain (D-313). Listed so every role's isolation check covers it.
  "fleet_demo",
];

function adminUrl(): string {
  return config.databaseUrl;
}

function assertIdentifier(name: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe ${what}: ${name}`);
  return name;
}

const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * ⚠ **Derived from `CREDENTIAL_ENC_KEY`, never random per seed** — the same rule
 * the other four follow, and for the same reason: a reseed must not rotate a
 * password that is already encrypted into `datasources.connection_string_enc`,
 * because every query would then fail to authenticate for a reason nothing
 * reports. The salt carries the domain key, so no two roles share a password.
 */
function derivedRoPassword(spec: DomainSpec): string {
  return (
    process.env[`${spec.key.toUpperCase()}_DB_RO_PASSWORD`] ??
    createHmac("sha256", process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64))
      .update(`${spec.dbName}:read-only-role:v1`)
      .digest("hex")
      .slice(0, 32)
  );
}

export function domainOwnerUrl(spec: DomainSpec): string {
  const u = new URL(adminUrl());
  u.pathname = `/${spec.dbName}`;
  return u.toString();
}

export function domainRoUrl(spec: DomainSpec): string {
  const u = new URL(domainOwnerUrl(spec));
  u.username = spec.roRole;
  u.password = derivedRoPassword(spec);
  return u.toString();
}

/**
 * The read-only URL as a SIBLING CONTAINER sees it.
 *
 * ⚠ This is the value that gets STORED, and the distinction is D-44: a value
 * that is stored must resolve for its future reader, a value used now must
 * resolve for the current process. `localhost` resolves to the wrong place from
 * inside another container.
 */
export function domainUrlForScripts(spec: DomainSpec): string {
  const u = new URL(domainRoUrl(spec));
  u.hostname = config.demo.dbHostForScripts;
  u.port = config.demo.dbPortForScripts;
  return u.toString();
}

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

export interface DomainSeedReport {
  dbName: string;
  created: boolean;
  tables: Array<{ table: string; rows: number }>;
  role: {
    name: string;
    canSelect: boolean;
    writeGrants: string[];
    reachableOtherDatabases: string[];
    notChecked: string[];
  };
}

async function ensureDatabase(spec: DomainSpec): Promise<boolean> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [spec.dbName]);
    if (rows.length > 0) return false;
    assertIdentifier(spec.dbName, "database name");
    await admin.query(`CREATE DATABASE ${spec.dbName}`);
    return true;
  } finally {
    await admin.end();
  }
}

async function insertRows(client: Client, t: DomainTable, chunk = 500) {
  for (let i = 0; i < t.rows.length; i += chunk) {
    const slice = t.rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`);
    await client.query(`INSERT INTO ${t.table} (${t.columns.join(",")}) VALUES ${tuples.join(",")}`, params);
  }
}

/**
 * Create the database, load the schema and rows, then grant.
 *
 * ⚠ **THE ROLE IS GRANTED AFTER THE DDL, EVERY TIME.** The schema DROPs and
 * recreates every table and table privileges die with the table — a grant issued
 * earlier silently vanishes, and the role ends up able to connect and unable to
 * read. That failure reads like a connection problem and is not one.
 *
 * ⚠ **The control is the ABSENT grant, never `default_transaction_read_only`.**
 * A session can turn that off (measured, on the HR role: a script issuing
 * `SET transaction_read_only = off` and then writing still gets
 * `InsufficientPrivilege`). It is set anyway as defence in depth, and the
 * verification below re-derives the truth from `pg_catalog` rather than trusting
 * the statements above it.
 */
export async function seedDomainDatabase(spec: DomainSpec): Promise<DomainSeedReport> {
  const created = await ensureDatabase(spec);
  const owner = new Client({ connectionString: domainOwnerUrl(spec) });
  await owner.connect();
  const tables: Array<{ table: string; rows: number }> = [];
  try {
    await owner.query(spec.ddl);
    await applyColumnTags(owner, spec.dbName); // I-283: the address columns, declared as the schema owner declares them
    for (const t of spec.tables) {
      await insertRows(owner, t);
      tables.push({ table: t.table, rows: t.rows.length });
    }

    const role = assertIdentifier(spec.roRole, "role name");
    const pw = derivedRoPassword(spec);
    const { rows: exists } = await owner.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.length === 0) {
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD ${literal(pw)}`);
    } else {
      await owner.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal(pw)}`);
    }
    /**
     * ⚠ **`REVOKE CONNECT ON DATABASE … FROM PUBLIC` IS THE LOAD-BEARING LINE,
     * AND IT WAS MISSING ON THE FIRST RUN.**
     *
     * Postgres grants `CONNECT` to the pseudo-role PUBLIC on every new database.
     * So the schema revokes below are not enough: with them alone, `orders_ro`
     * could connect to `support_demo` and `hiring_ro` to both — MEASURED, by the
     * verification at the bottom of this function on the run that created them.
     * Three tenants, mutually reachable, with every GRANT statement looking
     * correct.
     *
     * This is the third time this exact trap has been recorded in this
     * repository — the demo roles hit it, then the Kestra DB boundary (I-04) —
     * and the rule is always the same: **`REVOKE … FROM <role>` does NOT remove
     * a privilege held through PUBLIC.** Revoke from PUBLIC.
     *
     * ⚠ It is why the verification re-derives from `pg_catalog` instead of
     * trusting the statements above it. A check that read back what it had just
     * written would have reported three isolated tenants.
     */
    await owner.query(`REVOKE CONNECT ON DATABASE ${spec.dbName} FROM PUBLIC`);
    await owner.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await owner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await owner.query(`GRANT CONNECT ON DATABASE ${spec.dbName} TO ${role}`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await owner.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);

    // ── verification, from pg_catalog rather than from the statements above ──
    const { rows: sel } = await owner.query<{ ok: boolean }>(
      `select bool_and(has_table_privilege($1, c.oid, 'SELECT')) as ok
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','v','m')`,
      [role],
    );
    const writeGrants: string[] = [];
    for (const priv of WRITE_PRIVILEGES) {
      const { rows } = await owner.query<{ t: string }>(
        `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','v','m')
            and has_table_privilege($1, c.oid, $2)`,
        [role, priv],
      );
      for (const r of rows) writeGrants.push(`${priv} on ${r.t}`);
    }

    // ⚠ Filtered against `pg_database` BEFORE use: `has_database_privilege`
    // THROWS on a database that does not exist, and on a machine that has never
    // run `demo:seed-alt` there is no `hr_demo_alt`. A seeder that dies there is
    // a seeder nobody can run.
    const others = ALL_DEMO_DATABASES.filter((d) => d !== spec.dbName);
    const { rows: present } = await owner.query<{ datname: string }>(
      `select datname from pg_database where datname = any($1::text[])`,
      [others],
    );
    const presentNames = present.map((r) => r.datname);
    const reachable: string[] = [];
    for (const db of presentNames) {
      const { rows } = await owner.query<{ ok: boolean }>(
        `select has_database_privilege($1, $2, 'CONNECT') as ok`,
        [role, db],
      );
      if (rows[0]?.ok) reachable.push(db);
    }

    return {
      dbName: spec.dbName,
      created,
      tables,
      role: {
        name: role,
        canSelect: sel[0]?.ok ?? false,
        writeGrants,
        reachableOtherDatabases: reachable,
        notChecked: others.filter((d) => !presentNames.includes(d)),
      },
    };
  } finally {
    await owner.end();
  }
}

/**
 * Re-check one role's isolation, from `pg_catalog`, AFTER every domain exists.
 *
 * ⚠ **This is a separate pass because the in-seeder check is order-dependent and
 * that produced a false alarm on the very first run.** Each domain revokes
 * PUBLIC's `CONNECT` on its OWN database, so when Customer Support is seeded
 * first its role is checked against an Orders database that has not been sealed
 * yet — and the honest report was "PROBLEM: reaches orders_demo", which was true
 * at that instant and not true thirty seconds later.
 *
 * The wrong fix is to have a domain revoke on its siblings' databases; the right
 * one is to ask the question once, at the end, when the answer is stable.
 */
export async function checkRoleIsolation(
  spec: DomainSpec,
): Promise<{ reachable: string[]; notChecked: string[] }> {
  const owner = new Client({ connectionString: domainOwnerUrl(spec) });
  await owner.connect();
  try {
    const others = ALL_DEMO_DATABASES.filter((d) => d !== spec.dbName);
    const { rows: present } = await owner.query<{ datname: string }>(
      `select datname from pg_database where datname = any($1::text[])`,
      [others],
    );
    const names = present.map((r) => r.datname);
    const reachable: string[] = [];
    for (const db of names) {
      const { rows } = await owner.query<{ ok: boolean }>(
        `select has_database_privilege($1, $2, 'CONNECT') as ok`,
        [spec.roRole, db],
      );
      if (rows[0]?.ok) reachable.push(db);
    }
    return { reachable, notChecked: others.filter((d) => !names.includes(d)) };
  } finally {
    await owner.end();
  }
}
