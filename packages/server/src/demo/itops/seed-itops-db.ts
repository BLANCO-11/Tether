/**
 * Seeds `itops_demo` — the fourth domain's database.
 *
 * A separate DATABASE for the same reason `hr_demo`, `finance_demo` and
 * `legal_demo` are ones: the credential registered as a datasource must be
 * unable to reach anything the workspace has not declared. HR, Finance, Legal
 * and IT Operations are four tenants in the demonstration, so their data must be
 * as separated as four real tenants' would be.
 *
 * ── THIS FILE IS `seed-legal-db.ts` WITH IT-OPS DATA IN IT, ON PURPOSE ───────
 *
 * Same function names, same order, same grant sequence, same derivation, same
 * verification-from-`pg_catalog`. There is no shared base module and no edit to
 * `seed-legal-db.ts` or `seed-finance-db.ts`, because the point of a fourth
 * tenant is that adding one needs no change to the three already there.
 *
 * ⚠ A shared tenant roster HAS now been considered twice and set aside twice
 * (the Legal plan's D-4, and again here). The argument against has not changed:
 * the module every tenant seeder imports is the module a bug in one of them
 * reaches all four through. What HAS changed is the cost — the hardcoded list
 * below now names four databases and the next tenant makes it five, in four
 * files. If a fifth is ever added, extract the roster THEN and argue it on its
 * own merits; do not do it as a tidy-up inside another feature.
 *
 * ── WHY A FOURTH READ-ONLY ROLE ──────────────────────────────────────────────
 *
 * `hr_demo` and `hr_demo_alt` share `foundry_ro` (two shapes of one demo);
 * Finance has `finance_ro`; Legal has `legal_ro`; IT Operations gets `itops_ro`,
 * with `CONNECT` on `itops_demo` and on nothing else. Revoking one tenant's data
 * credential in an incident must not take the other three down, and four DSNs
 * that differ in more than a database name mean a mis-copied connection string
 * fails to authenticate rather than quietly reading the wrong tenant.
 *
 * ⚠ THE ISOLATION CLAIM IS FOUR DIRECTIONS, NOT TWELVE, AND SAYING SO MATTERS.
 * `itops_ro` is checked against the other four databases from the hardcoded list
 * below. `foundry_ro`, `finance_ro` and `legal_ro` are NOT checked against
 * `itops_demo` — that needs an edit to three existing seeders, which this
 * feature deliberately does not make. Never describe this as symmetric tenant
 * isolation.
 *
 * ── THE GRANTS, AND THE ORDER THEY MUST HAPPEN IN ────────────────────────────
 *
 * `itops-schema.sql` DROPs and recreates every table, and table privileges die
 * with the table. So the role is granted AFTER the DDL and after the data, every
 * time — a grant issued earlier silently vanishes and the role ends up able to
 * connect and unable to read.
 *
 * The primary control is the ABSENT grant, never `default_transaction_read_only`
 * (which a session can turn off). That session default is set anyway, as defence
 * in depth against a future mistaken GRANT, and the verification below re-derives
 * the truth from `pg_catalog` rather than trusting the statements above it.
 */
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { config } from "../../config/index.js";
import {
  ASSETS,
  ASSET_VULNERABILITIES,
  CHANGE_FREEZES,
  INCIDENTS,
  INCIDENT_PAUSES,
  ON_CALL,
  ORG_SETTINGS,
  SERVICES,
  SLA_POLICIES,
  TEAMS,
  VULNERABILITIES,
} from "./itops-dataset.js";
import { applyColumnTags } from "../address-tags.js";

const here = dirname(fileURLToPath(import.meta.url));

export const ITOPS_DB_NAME = process.env.ITOPS_DB_NAME ?? "itops_demo";
export const ITOPS_RO_ROLE = process.env.ITOPS_DB_RO_ROLE ?? "itops_ro";

/**
 * The databases this role must NOT be able to reach.
 *
 * ⚠ FILTERED AGAINST `pg_database` BEFORE USE. `has_database_privilege` THROWS
 * on a database that does not exist, and on a machine that has never run
 * `demo:seed-alt` there is no `hr_demo_alt`. A seeder that dies there is a
 * seeder nobody can run.
 */
function otherTenantDatabases(): string[] {
  return [
    config.demo.dbName,
    config.demo.altDbName,
    process.env.FINANCE_DB_NAME ?? "finance_demo",
    process.env.LEGAL_DB_NAME ?? "legal_demo",
  ].filter((name) => name && name !== ITOPS_DB_NAME);
}

/**
 * Derived from `CREDENTIAL_ENC_KEY`, exactly as the other three read-only
 * passwords are and for the same reason: a reseed must not rotate a password
 * that is already encrypted into `datasources.connection_string_enc`, because
 * every query would then fail to authenticate for a reason nothing reports. Set
 * ITOPS_DB_RO_PASSWORD to rotate deliberately.
 *
 * The salt differs from the other three, so the four roles do not share a
 * password even though they share a derivation.
 */
function derivedRoPassword(): string {
  return (
    process.env.ITOPS_DB_RO_PASSWORD ??
    createHmac("sha256", process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64))
      .update("itops_demo:read-only-role:v1")
      .digest("hex")
      .slice(0, 32)
  );
}

function adminUrl(): string {
  return config.databaseUrl;
}

/** Owner URL — parent-side only, for DDL and seeding. Never registered anywhere. */
export function itopsDbUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${ITOPS_DB_NAME}`;
  return u.toString();
}

/** Read-only URL, parent-facing. Introspection and the privilege tests use this. */
export function itopsRoDbUrl(): string {
  const u = new URL(itopsDbUrl());
  u.username = ITOPS_RO_ROLE;
  u.password = derivedRoPassword();
  return u.toString();
}

/**
 * The read-only URL as something running in a SIBLING container sees it. Same
 * host/port substitution the other three use — `localhost` and the compose
 * service name both resolve to the wrong place from inside another container.
 */
export function itopsDbUrlForScripts(): string {
  const u = new URL(itopsRoDbUrl());
  u.hostname = config.demo.dbHostForScripts;
  u.port = config.demo.dbPortForScripts;
  return u.toString();
}

function assertIdentifier(name: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe ${what} (expected lower_snake_case): ${name}`);
  }
  return name;
}

/** Single-quoted SQL literal; Postgres doubles an embedded quote. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function ensureDatabase(): Promise<boolean> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
      ITOPS_DB_NAME,
    ]);
    if (rows.length > 0) return false;
    assertIdentifier(ITOPS_DB_NAME, "itops database name");
    await admin.query(`CREATE DATABASE ${ITOPS_DB_NAME}`);
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

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

export interface ItopsRoleReport {
  role: string;
  database: string;
  created: boolean;
  selectableTables: string[];
  /** The other tenant databases this role was actually checked against. */
  isolatedFrom: string[];
  problems: string[];
}

async function ensureItopsReadOnlyRole(client: Client): Promise<ItopsRoleReport> {
  const role = assertIdentifier(ITOPS_RO_ROLE, "itops read-only role name");
  const database = assertIdentifier(ITOPS_DB_NAME, "itops database name");
  const password = derivedRoPassword();
  if (!password || password.length < 16) {
    throw new Error("itops read-only password is missing or too short");
  }

  const { rows: existing } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  const created = existing.length === 0;
  const attrs =
    `LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT`;
  await client.query(`${created ? "CREATE" : "ALTER"} ROLE ${role} ${attrs}`);

  await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`,
  );

  await client.query(
    `REVOKE ${WRITE_PRIVILEGES.join(", ")} ON ALL TABLES IN SCHEMA public FROM ${role}`,
  );
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
  // ⚠ Revoke from PUBLIC first. On PG <= 14 schema `public` grants CREATE to the
  // pseudo-role PUBLIC, and `REVOKE ... FROM <role>` does NOT remove a privilege
  // the role holds via PUBLIC — so without this the role could CREATE a table,
  // then own it, then write to it freely. This has bitten this repo twice.
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
  await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${role}`);

  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await client.query(
    `ALTER ROLE ${role} SET statement_timeout = ${literal(config.demo.roStatementTimeout)}`,
  );
  await client.query(
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ` +
      literal(config.demo.roIdleTxTimeout),
  );
  await client.query(`ALTER ROLE ${role} CONNECTION LIMIT 10`);

  return { role, database, created, ...(await verifyItopsReadOnlyRole(client)) };
}

/**
 * Ask Postgres what is true, rather than asserting what we granted. This is what
 * `itops:verify` runs, so a reseed cannot quietly restore write access.
 */
export async function verifyItopsReadOnlyRole(
  client: Client,
): Promise<{ selectableTables: string[]; isolatedFrom: string[]; problems: string[] }> {
  const role = ITOPS_RO_ROLE;
  const problems: string[] = [];
  const selectableTables: string[] = [];
  const isolatedFrom: string[] = [];

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
    return { selectableTables, isolatedFrom, problems: [`role ${role} does not exist`] };
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
              ${WRITE_PRIVILEGES.map((p, i) => `has_table_privilege($1, $2, '${p}') AS w${i}`).join(", ")}`,
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

  // The point of a fourth role: it must NOT be able to reach any other tenant's
  // database. Checked here rather than assumed, because CONNECT is granted per
  // database and a stray GRANT elsewhere would be invisible from inside this one.
  //
  // ⚠ Only databases that EXIST are checked, and the ones checked are reported in
  // `isolatedFrom` rather than left implicit — a check that silently skipped a
  // database would read exactly like a check that passed.
  const { rows: present } = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
    [otherTenantDatabases()],
  );
  for (const { datname } of present) {
    const { rows } = await client.query<{ can: boolean }>(
      "SELECT has_database_privilege($1, $2, 'CONNECT') AS can",
      [role, datname],
    );
    isolatedFrom.push(datname);
    if (rows[0]?.can) {
      problems.push(`${role} can CONNECT to ${datname} — it must reach itops only`);
    }
  }

  return { selectableTables, isolatedFrom, problems };
}

export interface ItopsSeedReport {
  databaseCreated: boolean;
  database: string;
  counts: Record<string, number>;
  readOnlyRole: ItopsRoleReport;
}

/** Table load order. FK-safe. */
const COUNTED_TABLES = [
  "org_settings",
  "teams",
  "services",
  "sla_policies",
  "on_call",
  "incidents",
  "incident_pauses",
  "assets",
  "vulnerabilities",
  "asset_vulnerabilities",
  "change_freezes",
];

export async function seedItopsDatabase(): Promise<ItopsSeedReport> {
  const databaseCreated = await ensureDatabase();

  const ddl = await readFile(join(here, "itops-schema.sql"), "utf8");
  const client = new Client({ connectionString: itopsDbUrl() });
  await client.connect();
  try {
    await client.query(ddl);
    await applyColumnTags(client, "itops_demo"); // I-283: the address columns, declared as the schema owner declares them

    await insertRows(
      client,
      "org_settings",
      ["key", "value", "description"],
      ORG_SETTINGS.map((s) => [s.key, s.value, s.description]),
    );
    await insertRows(
      client,
      "teams",
      ["id", "team_code", "name", "contact_email", "escalation_email", "timezone"],
      TEAMS.map((t) => [t.id, t.code, t.name, t.contactEmail, t.escalationEmail, t.timezone]),
    );
    await insertRows(
      client,
      "services",
      ["id", "service_code", "name", "tier", "owner_team_id", "business_hours_only", "criticality_note"],
      SERVICES.map((s) => [s.id, s.code, s.name, s.tier, s.ownerTeamId, s.businessHoursOnly, s.criticalityNote]),
    );
    await insertRows(
      client,
      "sla_policies",
      ["tier", "priority", "respond_mins", "resolve_mins"],
      SLA_POLICIES.map((p) => [p.tier, p.priority, p.respondMins, p.resolveMins]),
    );
    await insertRows(
      client,
      "on_call",
      ["id", "team_id", "starts_at", "ends_at", "person_name", "person_email", "escalation_to"],
      ON_CALL.map((s) => [s.id, s.teamId, s.startsAt, s.endsAt, s.personName, s.personEmail, s.escalationTo]),
    );
    await insertRows(
      client,
      "incidents",
      ["id", "incident_code", "service_id", "priority", "summary", "status", "opened_at", "acknowledged_at", "resolved_at", "assignee_email", "source"],
      INCIDENTS.map((i) => [i.id, i.code, i.serviceId, i.priority, i.summary, i.status, i.openedAt, i.acknowledgedAt, i.resolvedAt, i.assigneeEmail, i.source]),
    );
    await insertRows(
      client,
      "incident_pauses",
      ["id", "incident_id", "reason", "started_at", "ended_at"],
      INCIDENT_PAUSES.map((p) => [p.id, p.incidentId, p.reason, p.startedAt, p.endedAt]),
    );
    await insertRows(
      client,
      "assets",
      ["id", "hostname", "os", "environment", "service_id", "owner_team_id", "last_seen_at"],
      ASSETS.map((a) => [a.id, a.hostname, a.os, a.environment, a.serviceId, a.ownerTeamId, a.lastSeenAt]),
    );
    await insertRows(
      client,
      "vulnerabilities",
      ["cve", "title", "severity", "cvss", "published_at", "kev", "fix_available"],
      VULNERABILITIES.map((v) => [v.cve, v.title, v.severity, v.cvss, v.publishedAt, v.kev, v.fixAvailable]),
    );
    await insertRows(
      client,
      "asset_vulnerabilities",
      ["asset_id", "cve", "state", "detected_at"],
      ASSET_VULNERABILITIES.map((av) => [av.assetId, av.cve, av.state, av.detectedAt]),
    );
    await insertRows(
      client,
      "change_freezes",
      ["id", "freeze_code", "name", "starts_at", "ends_at", "service_id", "reason"],
      CHANGE_FREEZES.map((f) => [f.id, f.code, f.name, f.startsAt, f.endsAt, f.serviceId, f.reason]),
    );

    // ANALYZE as the OWNER, before the grants, so `pg_class.reltuples` is
    // populated: the read-only role introspects afterwards and a never-analysed
    // table reports -1, which the manifest renders as an unknown row count.
    await client.query("ANALYZE");

    const readOnlyRole = await ensureItopsReadOnlyRole(client);

    const counts: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n as number;
    }

    return { databaseCreated, database: ITOPS_DB_NAME, counts, readOnlyRole };
  } finally {
    await client.end();
  }
}
