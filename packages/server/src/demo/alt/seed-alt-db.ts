import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { config } from "../../config/index.js";
import {
  ALT_MONTHS,
  ALT_ORG_UNITS,
  ALT_POLICIES,
  ALT_ROSTER,
  ALT_SITES,
  ALT_WORKING_DAYS,
  altEmail,
  altRate,
} from "./alt-dataset.js";

/**
 * WS-E.1 — seeds `hr_demo_alt` (plans/production-substitution-plan.md §8.1).
 *
 * A separate DATABASE for the same reason `hr_demo` is one: the credential handed
 * to generated scripts must reach only the data the workspace declares. A separate
 * SCHEMA inside it (`hr`, not `public`) is the additional point — it is what
 * exercises WS-C.1, which was a hardcode until this workstream.
 *
 * The read-only role is created here too, by the same code path as the primary
 * dataset. That is deliberate: if `ensureReadOnlyRole` only ever worked against
 * `hr_demo`'s `public` schema, WS-A would be a property of one demo rather than of
 * the platform, and the rehearsal is supposed to find exactly that kind of
 * accidental specificity.
 */

const here = dirname(fileURLToPath(import.meta.url));

export const ALT_DB_NAME = config.demo.altDbName;
export const ALT_SCHEMA = "hr";

function adminUrl(): string {
  return config.databaseUrl;
}

/** Owner URL for the alt DB — parent-side only (DDL, seeding). */
export function altDbUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${ALT_DB_NAME}`;
  return u.toString();
}

/** Read-only URL, parent-facing. What introspection and the negative tests use. */
export function altRoDbUrl(): string {
  const u = new URL(altDbUrl());
  u.username = config.demo.roRole;
  u.password = config.demo.roPassword;
  return u.toString();
}

/** Read-only URL as a generated script in a sibling container sees it. */
export function altDbUrlForScripts(): string {
  const u = new URL(altRoDbUrl());
  u.hostname = config.demo.dbHostForScripts;
  u.port = config.demo.dbPortForScripts;
  return u.toString();
}

async function ensureDatabase(): Promise<boolean> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
      ALT_DB_NAME,
    ]);
    if (rows.length > 0) return false;
    if (!/^[a-z_][a-z0-9_]*$/.test(ALT_DB_NAME)) {
      throw new Error(`unsafe alt database name: ${ALT_DB_NAME}`);
    }
    await admin.query(`CREATE DATABASE ${ALT_DB_NAME}`);
    return true;
  } finally {
    await admin.end();
  }
}

async function insertRows(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunk = 500,
) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((r) => {
      const ph = r.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
      params,
    );
  }
}

/**
 * Grants for the alt database. Deliberately NOT a copy of `ensureReadOnlyRole`'s
 * body: it grants on `public`, and the whole point here is a NAMED schema. This
 * asserts the same properties against `hr` instead.
 */
async function ensureAltReadOnlyRole(client: Client): Promise<{ role: string; problems: string[] }> {
  const role = config.demo.roRole;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`unsafe role name: ${role}`);
  const db = ALT_DB_NAME;

  // The role is cluster-wide, so it already exists from the primary seed; only the
  // per-database grants are needed here.
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (rows.length === 0) {
    throw new Error(
      `role ${role} does not exist — run \`pnpm demo:seed\` first so the read-only role is created`,
    );
  }

  await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA ${ALT_SCHEMA} TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ALT_SCHEMA} TO ${role}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ALT_SCHEMA} GRANT SELECT ON TABLES TO ${role}`,
  );
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ${ALT_SCHEMA} FROM ${role}`,
  );
  // The role must NOT be able to read `public` here — a datasource scoped to `hr`
  // has no business elsewhere in the database.
  //
  // ⚠ `REVOKE ... FROM <role>` IS NOT ENOUGH, and the WS-E rehearsal is what
  // caught it. USAGE on schema `public` is granted to the pseudo-role PUBLIC by
  // default, and revoking from a specific role does not remove a privilege that
  // role holds *via* PUBLIC. So this looked correct, passed no test, and left
  // `foundry_ro` able to read anything in `public`. Revoke from PUBLIC first.
  await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM PUBLIC`);

  // Belt and braces for the schema-qualification problem, and what a real DBA
  // would do: put `hr` on this role's search_path FOR THIS DATABASE ONLY, so an
  // unqualified `FROM staff` also resolves. The manifest now states schema="hr"
  // and the prompt requires qualification — this means a script that forgets still
  // works rather than dying on 'relation "presence_rollup" does not exist'.
  // `IN DATABASE` scoping matters: a cluster-wide search_path would leak `hr` into
  // every other database this role touches.
  await client.query(`ALTER ROLE ${role} IN DATABASE ${db} SET search_path = ${ALT_SCHEMA}, public`);

  // Verify from the catalogue rather than trusting the grants above.
  const problems: string[] = [];
  const { rows: tbls } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [ALT_SCHEMA],
  );
  for (const { tablename } of tbls) {
    const q = `${ALT_SCHEMA}.${tablename}`;
    const { rows: p } = await client.query<{ sel: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege($1,$2,'SELECT') sel,
              has_table_privilege($1,$2,'UPDATE') upd,
              has_table_privilege($1,$2,'DELETE') del`,
      [role, q],
    );
    if (!p[0].sel) problems.push(`${role} cannot SELECT ${q}`);
    if (p[0].upd) problems.push(`${role} still holds UPDATE on ${q}`);
    if (p[0].del) problems.push(`${role} still holds DELETE on ${q}`);
  }
  return { role, problems };
}

export interface AltSeedReport {
  databaseCreated: boolean;
  database: string;
  schema: string;
  counts: Record<string, number>;
  readOnlyRole: { role: string; problems: string[] };
}

export async function seedAltDatabase(): Promise<AltSeedReport> {
  const databaseCreated = await ensureDatabase();
  const ddl = await readFile(join(here, "alt-schema.sql"), "utf8");
  const client = new Client({ connectionString: altDbUrl() });
  await client.connect();
  try {
    await client.query(ddl);

    await insertRows(
      client,
      "hr.sites",
      ["id", "site_code", "city", "country", "zone"],
      ALT_SITES.map((s) => [s.id, s.siteCode, s.city, s.country, s.zone]),
    );
    await insertRows(
      client,
      "hr.org_units",
      ["id", "unit_code", "unit_name", "ledger_code"],
      ALT_ORG_UNITS.map((u) => [u.id, u.unitCode, u.unitName, u.ledgerCode]),
    );

    // supervisor_id is a self-reference, so supervisors must land before reports.
    const ordered: typeof ALT_ROSTER = [];
    const placed = new Set<number>();
    let guard = 0;
    while (ordered.length < ALT_ROSTER.length) {
      if (guard++ > ALT_ROSTER.length + 5) {
        throw new Error("could not order staff by supervisor — cycle in ALT_ROSTER?");
      }
      for (const s of ALT_ROSTER) {
        if (placed.has(s.id)) continue;
        if (s.supervisorId === null || placed.has(s.supervisorId)) {
          ordered.push(s);
          placed.add(s.id);
        }
      }
    }

    await insertRows(
      client,
      "hr.staff",
      [
        "id",
        "badge",
        "full_name",
        "work_mailbox",
        "unit_id",
        "site_id",
        "supervisor_id",
        "role",
        "contract_type",
        "state",
        "joined_on",
        "left_on",
      ],
      ordered.map((s) => [
        s.id,
        s.badge,
        s.fullName,
        altEmail(s),
        s.unitId,
        s.siteId,
        s.supervisorId,
        s.role,
        s.contractType,
        s.state,
        s.joinedOn,
        s.leftOn,
      ]),
    );

    await insertRows(
      client,
      "hr.attendance_policy",
      ["id", "unit_id", "min_rate", "active_from"],
      ALT_POLICIES.map((p) => [p.id, p.unitId, p.minRate, p.activeFrom]),
    );

    const rollup: unknown[][] = [];
    for (const s of ALT_ROSTER) {
      for (const period of ALT_MONTHS) {
        rollup.push([
          s.id,
          period,
          ALT_WORKING_DAYS[period],
          s.attended[period],
          altRate(s, period),
        ]);
      }
    }
    await insertRows(
      client,
      "hr.presence_rollup",
      ["staff_id", "period", "working_days", "days_present", "presence_rate"],
      rollup,
    );

    // ANALYZE as owner before granting, so row estimates are populated for the
    // read-only introspection that follows (same reasoning as WS-A.6).
    await client.query("ANALYZE");
    const readOnlyRole = await ensureAltReadOnlyRole(client);

    const counts: Record<string, number> = {};
    for (const t of ["sites", "org_units", "staff", "attendance_policy", "presence_rollup"]) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM hr.${t}`);
      counts[t] = rows[0].n as number;
    }

    return {
      databaseCreated,
      database: ALT_DB_NAME,
      schema: ALT_SCHEMA,
      counts,
      readOnlyRole,
    };
  } finally {
    await client.end();
  }
}
