import type { Client } from "pg";
import { config } from "../config/index.js";

/**
 * WS-A — least-privilege data access
 * (plans/production-substitution-plan.md §4).
 *
 * THE GAP THIS CLOSES (G1). Until now the credential encrypted into
 * `datasources.connection_string_enc` — the one injected into every execution
 * container as HR_DB_URL — was `foundry`: a superuser that OWNS `hr_demo`.
 * `has_table_privilege('foundry','employees','UPDATE'|'DELETE'|'TRUNCATE')` was
 * all true, so LLM-authored code could `UPDATE employees`, `TRUNCATE`, or `DROP
 * TABLE` at will. Harmless against synthetic data; swapping in a production DSN
 * would hand unrestricted write access to the HR source of record to a generated
 * script. This module creates a role that can read and can change nothing, and
 * the enforcement is the database's, not the prompt's.
 *
 * WHY THIS IS TypeScript AND NOT A .sql FILE. The plan sketches
 * `hr-roles.sql` using psql's `:'ro_password'` interpolation. `pg` is not psql
 * and does not expand those, and `CREATE ROLE … PASSWORD $1` is illegal —
 * Postgres does not accept bind parameters in utility statements. So the SQL has
 * to be assembled with the password inlined as a literal, which means the
 * escaping has to be deliberate and reviewable. It lives here, next to the
 * escaping.
 */

/** Role and database names go into SQL as identifiers, so validate rather than escape. */
function assertIdentifier(name: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe ${what} (expected lower_snake_case): ${name}`);
  }
  return name;
}

/** Single-quoted SQL string literal. Postgres doubles an embedded quote. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Privileges we must be able to state were *removed*, not merely never granted.
 * A previous seed (or a hand-run GRANT) may have left them in place, and
 * `GRANT SELECT` does not displace an existing `INSERT`.
 */
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

export interface ReadOnlyRoleReport {
  role: string;
  database: string;
  created: boolean;
  /** Tables the role can SELECT from after this call. */
  selectableTables: string[];
  /** Set only if a verification step found a privilege that should not be there. */
  problems: string[];
}

/**
 * Create or refresh the read-only role and grant it exactly SELECT.
 *
 * MUST run AFTER the DDL. `hr-schema.sql` DROPs and recreates every table, and
 * table privileges die with the table — so grants issued before seeding silently
 * vanish and the role ends up able to connect but not read.
 *
 * `client` must be connected to the demo database AS ITS OWNER.
 */
export async function ensureReadOnlyRole(client: Client): Promise<ReadOnlyRoleReport> {
  const role = assertIdentifier(config.demo.roRole, "read-only role name");
  const database = assertIdentifier(config.demo.dbName, "demo database name");
  const password = config.demo.roPassword;
  if (!password || password.length < 16) {
    throw new Error("demo read-only password is missing or too short");
  }

  const { rows: existing } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  const created = existing.length === 0;

  if (created) {
    await client.query(
      `CREATE ROLE ${role} LOGIN PASSWORD ${literal(password)} ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT`,
    );
  } else {
    // Idempotent refresh: re-assert the password (so rotation via
    // DEMO_DB_RO_PASSWORD takes effect on the next seed) and the attributes, in
    // case the role was created by hand or by an older version of this code.
    await client.query(
      `ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)} ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT`,
    );
  }

  // ── Connect + read ──────────────────────────────────────────────────────────
  await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  // A reseed creates new tables; without this they would be invisible to the
  // role until someone remembered to re-grant.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`,
  );

  // ── Everything that is not read ─────────────────────────────────────────────
  await client.query(
    `REVOKE ${WRITE_PRIVILEGES.join(", ")} ON ALL TABLES IN SCHEMA public FROM ${role}`,
  );
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
  // NOT optional, and easy to miss: on Postgres 14 and earlier, schema `public`
  // grants CREATE to PUBLIC by default, so without this revoke `foundry_ro`
  // could `CREATE TABLE` — and then own, and freely write, that table. PG15+
  // dropped the default grant, so this is a no-op there.
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${role}`);

  // ── Session defaults ────────────────────────────────────────────────────────
  // Defence in depth ONLY. A script can issue `SET transaction_read_only = off`,
  // so this is not the control that stops writes — the absent grants above are.
  // What it does buy is that a mistaken future GRANT is not immediately
  // exploitable.
  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await client.query(
    `ALTER ROLE ${role} SET statement_timeout = ${literal(config.demo.roStatementTimeout)}`,
  );
  await client.query(
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ` +
      literal(config.demo.roIdleTxTimeout),
  );
  const limit = Number.isFinite(config.demo.roConnectionLimit)
    ? Math.max(1, Math.trunc(config.demo.roConnectionLimit))
    : 10;
  await client.query(`ALTER ROLE ${role} CONNECTION LIMIT ${limit}`);

  return {
    role,
    database,
    created,
    ...(await verifyReadOnlyRole(client)),
  };
}

/**
 * Re-derive the role's actual privileges from the catalogue. Asserting what we
 * granted proves nothing; this asks Postgres what is true (WS-A.5 check 9), and
 * is the check `demo:verify` runs so a reseed cannot quietly restore write access.
 */
export async function verifyReadOnlyRole(
  client: Client,
): Promise<{ selectableTables: string[]; problems: string[] }> {
  const role = config.demo.roRole;
  const problems: string[] = [];
  const selectableTables: string[] = [];

  const { rows: roleRow } = await client.query<{
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolbypassrls: boolean;
  }>(
    "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (roleRow.length === 0) {
    return { selectableTables, problems: [`role ${role} does not exist`] };
  }
  const r = roleRow[0];
  if (r.rolsuper) problems.push(`${role} is a superuser`);
  if (r.rolcreatedb) problems.push(`${role} has CREATEDB`);
  if (r.rolcreaterole) problems.push(`${role} has CREATEROLE`);
  if (r.rolbypassrls) problems.push(`${role} has BYPASSRLS`);

  const { rows: tables } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  for (const { tablename } of tables) {
    const qualified = `public.${tablename}`;
    const { rows } = await client.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, $2, 'SELECT') AS sel,
              ${WRITE_PRIVILEGES.map(
                (p, i) => `has_table_privilege($1, $2, '${p}') AS w${i}`,
              ).join(", ")}`,
      [role, qualified],
    );
    const row = rows[0];
    if (row.sel) selectableTables.push(tablename);
    else problems.push(`${role} cannot SELECT ${qualified}`);
    WRITE_PRIVILEGES.forEach((p, i) => {
      if (row[`w${i}`]) problems.push(`${role} still holds ${p} on ${qualified}`);
    });
  }

  const { rows: schemaPriv } = await client.query<{ create_: boolean }>(
    "SELECT has_schema_privilege($1, 'public', 'CREATE') AS create_",
    [role],
  );
  if (schemaPriv[0]?.create_) problems.push(`${role} can CREATE in schema public`);

  return { selectableTables, problems };
}
