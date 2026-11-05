/**
 * Seeds `legal_demo` — the third domain's database.
 *
 * A separate DATABASE for the same reason `hr_demo` and `finance_demo` are ones:
 * the credential registered as a datasource must be unable to reach anything the
 * workspace has not declared. HR, Finance and Legal are three tenants in the
 * demonstration, so their data must be as separated as three real tenants' would
 * be.
 *
 * ── THIS FILE IS `seed-finance-db.ts` WITH LEGAL DATA IN IT, ON PURPOSE ──────
 *
 * Same function names, same order, same grant sequence, same derivation, same
 * verification-from-`pg_catalog`. There is no shared base module and there is no
 * edit to `seed-finance-db.ts`, because the point of a third tenant is that
 * adding one needs no change to the ones already there. If a fourth tenant needs
 * a shared abstraction, that is a separate change argued on its own merits — see
 * the plan's D-4 for the tenant roster that was considered and set aside here.
 *
 * ── WHY A THIRD READ-ONLY ROLE ───────────────────────────────────────────────
 *
 * `hr_demo` and `hr_demo_alt` share `foundry_ro` (two shapes of one demo);
 * Finance has `finance_ro`; Legal gets `legal_ro`, with `CONNECT` on `legal_demo`
 * and on nothing else. Revoking one tenant's data credential in an incident must
 * not take the other two down, and three DSNs that differ in more than a database
 * name mean a mis-copied connection string fails to authenticate rather than
 * quietly reading the wrong tenant.
 *
 * ── THE GRANTS, AND THE ORDER THEY MUST HAPPEN IN ────────────────────────────
 *
 * `legal-schema.sql` DROPs and recreates every table, and table privileges die
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
  CONTRACTS,
  CONTRACT_CLAUSES,
  CONTRACT_RELATIONSHIPS,
  CONTRACT_TYPES,
  COUNTERPARTIES,
  LEGAL_ENTITIES,
  NOTICE_LOG,
  OBLIGATIONS,
  OBLIGATION_COMPLETIONS,
  ORG_SETTINGS,
} from "./legal-dataset.js";
import { applyColumnTags } from "../address-tags.js";

const here = dirname(fileURLToPath(import.meta.url));

export const LEGAL_DB_NAME = process.env.LEGAL_DB_NAME ?? "legal_demo";
export const LEGAL_RO_ROLE = process.env.LEGAL_DB_RO_ROLE ?? "legal_ro";

/**
 * The databases this role must NOT be able to reach.
 *
 * Hardcoded and local, in the same shape `seed-finance-db.ts` uses — see the
 * plan's D-4 for the shared roster that was considered and deliberately set
 * aside. ⚠ The same claim is also spelled out in `seed-finance-db.ts` and in
 * `services/datasource-target.test.ts`; a fourth tenant needs the edit in all
 * three, and until somebody does that pass this is the only complete direction.
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
  ].filter((name) => name && name !== LEGAL_DB_NAME);
}

/**
 * Derived from `CREDENTIAL_ENC_KEY`, exactly as the HR and Finance read-only
 * passwords are and for the same reason: a reseed must not rotate a password that
 * is already encrypted into `datasources.connection_string_enc`, because every
 * query would then fail to authenticate for a reason nothing reports. Set
 * LEGAL_DB_RO_PASSWORD to rotate deliberately.
 *
 * The salt string differs from HR's and Finance's, so the three roles do not
 * share a password even though they share a derivation.
 */
function derivedRoPassword(): string {
  return (
    process.env.LEGAL_DB_RO_PASSWORD ??
    createHmac("sha256", process.env.CREDENTIAL_ENC_KEY ?? "0".repeat(64))
      .update("legal_demo:read-only-role:v1")
      .digest("hex")
      .slice(0, 32)
  );
}

function adminUrl(): string {
  return config.databaseUrl;
}

/** Owner URL — parent-side only, for DDL and seeding. Never registered anywhere. */
export function legalDbUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${LEGAL_DB_NAME}`;
  return u.toString();
}

/** Read-only URL, parent-facing. Introspection and the privilege tests use this. */
export function legalRoDbUrl(): string {
  const u = new URL(legalDbUrl());
  u.username = LEGAL_RO_ROLE;
  u.password = derivedRoPassword();
  return u.toString();
}

/**
 * The read-only URL as something running in a SIBLING container sees it. Same
 * host/port substitution as `hrDbUrlForScripts()` and `financeDbUrlForScripts()`
 * — `localhost` and the compose service name both resolve to the wrong place from
 * inside another container.
 */
export function legalDbUrlForScripts(): string {
  const u = new URL(legalRoDbUrl());
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
      LEGAL_DB_NAME,
    ]);
    if (rows.length > 0) return false;
    assertIdentifier(LEGAL_DB_NAME, "legal database name");
    await admin.query(`CREATE DATABASE ${LEGAL_DB_NAME}`);
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

export interface LegalRoleReport {
  role: string;
  database: string;
  created: boolean;
  selectableTables: string[];
  /** The other tenant databases this role was actually checked against. */
  isolatedFrom: string[];
  problems: string[];
}

async function ensureLegalReadOnlyRole(client: Client): Promise<LegalRoleReport> {
  const role = assertIdentifier(LEGAL_RO_ROLE, "legal read-only role name");
  const database = assertIdentifier(LEGAL_DB_NAME, "legal database name");
  const password = derivedRoPassword();
  if (!password || password.length < 16) {
    throw new Error("legal read-only password is missing or too short");
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

  return { role, database, created, ...(await verifyLegalReadOnlyRole(client)) };
}

/**
 * Ask Postgres what is true, rather than asserting what we granted. This is what
 * `legal:verify` runs, so a reseed cannot quietly restore write access.
 */
export async function verifyLegalReadOnlyRole(
  client: Client,
): Promise<{ selectableTables: string[]; isolatedFrom: string[]; problems: string[] }> {
  const role = LEGAL_RO_ROLE;
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

  // The point of a third role: it must NOT be able to reach any other tenant's
  // database. Checked here rather than assumed, because CONNECT is granted per
  // database and a stray GRANT elsewhere would be invisible from inside this one.
  //
  // ⚠ Only databases that EXIST are checked, and the ones checked are reported in
  // `isolatedFrom` rather than left implicit — a check that silently skipped a
  // database would read exactly like a check that passed. `has_database_privilege`
  // throws on an unknown name, which is why the filter is a query and not a guess.
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
      problems.push(`${role} can CONNECT to ${datname} — it must reach legal only`);
    }
  }

  return { selectableTables, isolatedFrom, problems };
}

export interface LegalSeedReport {
  databaseCreated: boolean;
  database: string;
  counts: Record<string, number>;
  readOnlyRole: LegalRoleReport;
}

/** Table load order. FK-safe, and `contracts` is a special case — see below. */
const COUNTED_TABLES = [
  "org_settings",
  "legal_entities",
  "counterparties",
  "contract_types",
  "contracts",
  "contract_relationships",
  "contract_clauses",
  "obligations",
  "obligation_completions",
  "notice_log",
];

export async function seedLegalDatabase(): Promise<LegalSeedReport> {
  const databaseCreated = await ensureDatabase();

  const ddl = await readFile(join(here, "legal-schema.sql"), "utf8");
  const client = new Client({ connectionString: legalDbUrl() });
  await client.connect();
  try {
    await client.query(ddl);
    await applyColumnTags(client, "legal_demo"); // I-283: the address columns, declared as the schema owner declares them

    await insertRows(
      client,
      "org_settings",
      ["key", "value", "description"],
      ORG_SETTINGS.map((s) => [s.key, s.value, s.description]),
    );
    await insertRows(
      client,
      "legal_entities",
      ["id", "entity_code", "name", "jurisdiction"],
      LEGAL_ENTITIES.map((e) => [e.id, e.code, e.name, e.jurisdiction]),
    );
    await insertRows(
      client,
      "counterparties",
      ["id", "counterparty_code", "name", "contact_email", "country", "vendor_code", "status"],
      COUNTERPARTIES.map((c) => [c.id, c.code, c.name, c.contactEmail, c.country, c.vendorCode, c.status]),
    );
    await insertRows(
      client,
      "contract_types",
      ["id", "code", "name", "default_notice_period_days", "requires_dpa"],
      CONTRACT_TYPES.map((t) => [t.id, t.code, t.name, t.defaultNoticePeriodDays, t.requiresDpa]),
    );

    // ⚠ TWO PASSES for `contracts`. `superseded_by_id` is a SELF-reference, and
    // the successor does not necessarily have the lower id — here the superseded
    // row is 13 and its successor is 14, so a single-pass insert in id order
    // violates the foreign key. Insert every row with the pointer NULL, then set
    // the chain once every row exists.
    await insertRows(
      client,
      "contracts",
      [
        "id",
        "contract_code",
        "title",
        "counterparty_id",
        "legal_entity_id",
        "type_code",
        "owner_email",
        "start_date",
        "end_date",
        "auto_renew",
        "renewal_term_months",
        "notice_period_days",
        "value_cents",
        "currency",
        "status",
        "superseded_by_id",
        "signed_date",
        "governing_law",
      ],
      CONTRACTS.map((c) => [
        c.id,
        c.code,
        c.title,
        c.counterpartyId,
        c.legalEntityId,
        c.typeCode,
        c.ownerEmail,
        c.startDate,
        c.endDate,
        c.autoRenew,
        c.renewalTermMonths,
        c.noticePeriodDays,
        c.valueCents,
        c.currency,
        c.status,
        null, // pass 2 sets this
        c.signedDate,
        c.governingLaw,
      ]),
    );
    for (const c of CONTRACTS) {
      if (c.supersededById === null) continue;
      await client.query("UPDATE contracts SET superseded_by_id = $1 WHERE id = $2", [
        c.supersededById,
        c.id,
      ]);
    }

    await insertRows(
      client,
      "contract_relationships",
      ["id", "parent_contract_id", "child_contract_id", "relationship"],
      CONTRACT_RELATIONSHIPS.map((r) => [r.id, r.parentContractId, r.childContractId, r.relationship]),
    );
    await insertRows(
      client,
      "contract_clauses",
      ["id", "contract_id", "clause_type", "is_non_standard", "risk_rating", "liability_cap_multiple", "summary"],
      CONTRACT_CLAUSES.map((c) => [
        c.id,
        c.contractId,
        c.clauseType,
        c.isNonStandard,
        c.riskRating,
        c.liabilityCapMultiple,
        c.summary,
      ]),
    );
    await insertRows(
      client,
      "obligations",
      [
        "id",
        "obligation_code",
        "contract_id",
        "description",
        "obligation_type",
        "owner_email",
        "due_date",
        "recurrence",
        "status",
        "notes",
      ],
      OBLIGATIONS.map((o) => [
        o.id,
        o.code,
        o.contractId,
        o.description,
        o.obligationType,
        o.ownerEmail,
        o.dueDate,
        o.recurrence,
        o.status,
        o.notes,
      ]),
    );
    await insertRows(
      client,
      "obligation_completions",
      ["id", "obligation_id", "completed_date", "evidence_ref", "completed_by"],
      OBLIGATION_COMPLETIONS.map((c) => [c.id, c.obligationId, c.completedDate, c.evidenceRef, c.completedBy]),
    );
    await insertRows(
      client,
      "notice_log",
      ["id", "contract_id", "notice_type", "sent_date", "sent_to", "channel"],
      NOTICE_LOG.map((n) => [n.id, n.contractId, n.noticeType, n.sentDate, n.sentTo, n.channel]),
    );

    // ANALYZE as the OWNER, before the grants, so `pg_class.reltuples` is
    // populated: the read-only role introspects afterwards and a never-analysed
    // table reports -1, which the manifest renders as an unknown row count.
    await client.query("ANALYZE");

    const readOnlyRole = await ensureLegalReadOnlyRole(client);

    const counts: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts[t] = rows[0].n as number;
    }

    return { databaseCreated, database: LEGAL_DB_NAME, counts, readOnlyRole };
  } finally {
    await client.end();
  }
}
