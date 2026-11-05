/**
 * Seeds `finance_demo` — the second domain's database.
 *
 * A separate DATABASE for the same reason `hr_demo` is one: the credential
 * registered as a datasource must be unable to reach anything the workspace has
 * not declared. Finance and HR are two tenants in the demonstration, so their
 * data must be as separated as two real tenants' would be.
 *
 * ── WHY A SECOND READ-ONLY ROLE AND NOT `foundry_ro` ─────────────────────────
 *
 * `hr_demo` and `hr_demo_alt` share `foundry_ro`, and that is defensible: they
 * are two shapes of one demo. Finance is a different tenant, so it gets
 * `finance_ro`, with `CONNECT` on `finance_demo` and on nothing else. The
 * reasoning is the same one that made ops-api's reader `ops_ro` rather than
 * `foundry_ro`: revoking one tenant's data credential in an incident must not
 * take the other tenant down. It also means the two DSNs differ in more than a
 * database name, so a mis-copied connection string fails to authenticate rather
 * than quietly reading the wrong tenant.
 *
 * ── THE GRANTS, AND THE ORDER THEY MUST HAPPEN IN ────────────────────────────
 *
 * `finance-schema.sql` DROPs and recreates every table, and table privileges die
 * with the table. So the role is granted AFTER the DDL and after the data, every
 * time — a grant issued earlier silently vanishes and the role ends up able to
 * connect and unable to read.
 *
 * The primary control is the ABSENT grant, never `default_transaction_read_only`
 * (which a session can turn off). That session default is set anyway, as defence
 * in depth against a future mistaken GRANT, and the verification below
 * re-derives the truth from `pg_catalog` rather than trusting the statements
 * above it.
 */
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { config } from "../../config/index.js";
import {
  BUDGETS,
  COST_CENTRES,
  EMPLOYEES,
  EXPENSE_CLAIMS,
  EXPENSE_POLICY,
  INVOICES,
  ORG_SETTINGS,
  PAYMENTS,
  VENDORS,
} from "./finance-dataset.js";
import { applyColumnTags } from "../address-tags.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FINANCE_DB_NAME = process.env.FINANCE_DB_NAME ?? "finance_demo";
export const FINANCE_RO_ROLE = process.env.FINANCE_DB_RO_ROLE ?? "finance_ro";

/**
 * Derived from `CREDENTIAL_ENC_KEY`, exactly as the HR read-only password is and
 * for the same reason: a reseed must not rotate a password that is already
 * encrypted into `datasources.connection_string_enc`, because every query would
 * then fail to authenticate for a reason nothing reports. Set
 * FINANCE_DB_RO_PASSWORD to rotate deliberately.
 *
 * The salt string differs from HR's, so the two roles do not share a password
 * even though they share a derivation.
 */
function derivedRoPassword(): string {
  return (
    process.env.FINANCE_DB_RO_PASSWORD ??
    createHmac("sha256", process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64))
      .update("finance_demo:read-only-role:v1")
      .digest("hex")
      .slice(0, 32)
  );
}

function adminUrl(): string {
  return config.databaseUrl;
}

/** Owner URL — parent-side only, for DDL and seeding. Never registered anywhere. */
export function financeDbUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${FINANCE_DB_NAME}`;
  return u.toString();
}

/** Read-only URL, parent-facing. Introspection and the privilege tests use this. */
export function financeRoDbUrl(): string {
  const u = new URL(financeDbUrl());
  u.username = FINANCE_RO_ROLE;
  u.password = derivedRoPassword();
  return u.toString();
}

/**
 * The read-only URL as something running in a SIBLING container sees it. Same
 * host/port substitution as `hrDbUrlForScripts()` — `localhost` and the compose
 * service name both resolve to the wrong place from inside another container.
 */
export function financeDbUrlForScripts(): string {
  const u = new URL(financeRoDbUrl());
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
      FINANCE_DB_NAME,
    ]);
    if (rows.length > 0) return false;
    assertIdentifier(FINANCE_DB_NAME, "finance database name");
    await admin.query(`CREATE DATABASE ${FINANCE_DB_NAME}`);
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

/**
 * The other tenant databases `finance_ro` must not be able to reach.
 *
 * ⚠ A hardcoded list local to this file, the same idiom `seed-legal-db.ts` and
 * `seed-itops-db.ts` use — and the same stated cost: **the isolation claim is
 * one-directional.** `finance_ro` is checked against these; none of THEIR roles
 * is checked against `finance_demo`, because that needs an edit to each of
 * their seeders. Never describe it as symmetric.
 *
 * Absent names are reported as `notChecked` rather than skipped.
 */
function otherTenantDatabases(): string[] {
  return [
    config.demo.dbName,
    "hr_demo_alt",
    "legal_demo",
    "itops_demo",
    "support_demo",
    "orders_demo",
    "hiring_demo",
  ].filter((d) => d !== FINANCE_DB_NAME);
}

export interface FinanceRoleReport {
  role: string;
  database: string;
  created: boolean;
  selectableTables: string[];
  /** Databases this role was actually PROVEN unable to reach, named. */
  isolatedFrom: string[];
  /** Databases in the roster that were absent, so nothing could be checked. */
  notChecked: string[];
  problems: string[];
}

async function ensureFinanceReadOnlyRole(client: Client): Promise<FinanceRoleReport> {
  const role = assertIdentifier(FINANCE_RO_ROLE, "finance read-only role name");
  const database = assertIdentifier(FINANCE_DB_NAME, "finance database name");
  const password = derivedRoPassword();
  if (!password || password.length < 16) {
    throw new Error("finance read-only password is missing or too short");
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

  return { role, database, created, ...(await verifyFinanceReadOnlyRole(client)) };
}

/**
 * Ask Postgres what is true, rather than asserting what we granted. This is what
 * `finance:verify` runs, so a reseed cannot quietly restore write access.
 */
export async function verifyFinanceReadOnlyRole(
  client: Client,
): Promise<{ selectableTables: string[]; isolatedFrom: string[]; notChecked: string[]; problems: string[] }> {
  const role = FINANCE_RO_ROLE;
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
    // Nothing was checked, so nothing may be reported as isolated. The roster
    // goes into `notChecked` rather than `isolatedFrom` for the same reason an
    // absent database does — an unasked question is not a passed one.
    return {
      selectableTables,
      isolatedFrom: [],
      notChecked: otherTenantDatabases(),
      problems: [`role ${role} does not exist`],
    };
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

  // The point of a second role: it must NOT be able to reach another tenant's
  // database. Checked here rather than assumed, because CONNECT is granted per
  // database and a stray GRANT elsewhere would be invisible from inside this one.
  //
  // ⚠ **FILTERED AGAINST `pg_database` FIRST, and this was a REAL FAILURE.**
  // `has_database_privilege` THROWS `3D000` on a name that does not exist, so
  // this block used to take the whole of `finance:seed` down the moment
  // `hr_demo` was absent — which is the normal state of a freshly wiped
  // deployment. `seed-legal-db.ts`, `seed-itops-db.ts` and
  // `generic/domain.ts` all already did it this way; Finance is the oldest
  // seeder and never got the fix.
  //
  // ⚠ And the two outcomes are reported SEPARATELY. A database that was absent
  // was not proven unreachable — it was not asked about. Folding it into a
  // silent skip makes a roster that has drifted read exactly like a roster that
  // passed, which is the one thing this check must not do.
  const isolatedFrom: string[] = [];
  const notChecked: string[] = [];
  const roster = otherTenantDatabases();
  const { rows: present } = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
    [roster],
  );
  const found = new Set(present.map((r) => r.datname));
  for (const datname of roster) {
    if (!found.has(datname)) {
      notChecked.push(datname);
      continue;
    }
    const { rows } = await client.query<{ can: boolean }>(
      "SELECT has_database_privilege($1, $2, 'CONNECT') AS can",
      [role, datname],
    );
    isolatedFrom.push(datname);
    if (rows[0]?.can) {
      problems.push(`${role} can CONNECT to ${datname} — it must reach finance only`);
    }
  }

  return { selectableTables, isolatedFrom, notChecked, problems };
}

export interface FinanceSeedReport {
  databaseCreated: boolean;
  database: string;
  counts: Record<string, number>;
  readOnlyRole: FinanceRoleReport;
}

export async function seedFinanceDatabase(): Promise<FinanceSeedReport> {
  const databaseCreated = await ensureDatabase();

  const ddl = await readFile(join(here, "finance-schema.sql"), "utf8");
  const client = new Client({ connectionString: financeDbUrl() });
  await client.connect();
  try {
    await client.query(ddl);
    await applyColumnTags(client, "finance_demo"); // I-283: the address columns, declared as the schema owner declares them

    await insertRows(
      client,
      "org_settings",
      ["key", "value", "description"],
      ORG_SETTINGS.map((s) => [s.key, s.value, s.description]),
    );
    await insertRows(
      client,
      "cost_centres",
      ["id", "code", "name", "owner_email", "active"],
      COST_CENTRES.map((c) => [c.id, c.code, c.name, c.ownerEmail, c.active]),
    );
    await insertRows(
      client,
      "vendors",
      ["id", "vendor_code", "name", "contact_email", "payment_terms_days", "country", "status"],
      VENDORS.map((v) => [v.id, v.code, v.name, v.contactEmail, v.paymentTermsDays, v.country, v.status]),
    );
    await insertRows(
      client,
      "employees",
      ["id", "employee_code", "full_name", "work_email", "cost_centre_id"],
      EMPLOYEES.map((e) => [e.id, e.code, e.name, e.workEmail, e.costCentreId]),
    );
    await insertRows(
      client,
      "invoices",
      [
        "id",
        "invoice_number",
        "vendor_id",
        "cost_centre_id",
        "issue_date",
        "due_date",
        "amount_cents",
        "status",
        "received_date",
      ],
      INVOICES.map((i) => [
        i.id,
        i.number,
        i.vendorId,
        i.costCentreId,
        i.issueDate,
        i.dueDate,
        i.amountCents,
        i.status,
        i.receivedDate,
      ]),
    );
    await insertRows(
      client,
      "payments",
      ["id", "invoice_id", "paid_date", "amount_cents", "method", "reference"],
      PAYMENTS.map((p) => [p.id, p.invoiceId, p.paidDate, p.amountCents, p.method, p.reference]),
    );
    // Before the claims — `expense_claims.category` references it.
    await insertRows(
      client,
      "expense_policy",
      ["id", "category", "limit_cents", "effective_from"],
      EXPENSE_POLICY.map((p) => [p.id, p.category, p.limitCents, p.effectiveFrom]),
    );
    await insertRows(
      client,
      "expense_claims",
      [
        "id",
        "claim_code",
        "employee_id",
        "cost_centre_id",
        "category",
        "claim_date",
        "amount_cents",
        "status",
        "receipt_ref",
      ],
      EXPENSE_CLAIMS.map((c) => [
        c.id,
        c.code,
        c.employeeId,
        c.costCentreId,
        c.category,
        c.claimDate,
        c.amountCents,
        c.status,
        c.receiptRef,
      ]),
    );
    await insertRows(
      client,
      "budgets",
      ["id", "cost_centre_id", "period", "amount"],
      BUDGETS.map((b) => [b.id, b.costCentreId, b.period, b.amount]),
    );

    // ANALYZE as the OWNER, before the grants, so `pg_class.reltuples` is
    // populated: the read-only role introspects afterwards and a never-analysed
    // table reports -1, which the manifest renders as an unknown row count.
    await client.query("ANALYZE");

    const readOnlyRole = await ensureFinanceReadOnlyRole(client);

    const counts: Record<string, number> = {};
    for (const t of [
      "org_settings",
      "cost_centres",
      "vendors",
      "employees",
      "invoices",
      "payments",
      "expense_policy",
      "expense_claims",
      "budgets",
    ]) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n as number;
    }

    return { databaseCreated, database: FINANCE_DB_NAME, counts, readOnlyRole };
  } finally {
    await client.end();
  }
}
