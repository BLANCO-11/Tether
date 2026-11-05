import { Client } from "pg";
import { config } from "../config/index.js";
import { hrDbUrl } from "./seed-hr-db.js";
import { opsHrRoRole, opsHrRoPassword } from "../services/ops-client.service.js";

/**
 * `ops_ro` — the credential `ops-api` reads `hr_demo` with.
 *
 * ── Why a SECOND read-only role rather than reusing `foundry_ro` ────────────
 *
 * `foundry_ro` is the credential handed to GENERATED CODE: it is encrypted into
 * the `datasources` row, rendered into the manifest, and a `datasource` step
 * runs its query as that role. `ops-api` is a different consumer with a
 * different lifetime, and giving it the same credential would mean one leak
 * compromises both — and, worse, that revoking the script credential (the thing
 * you would do first in an incident) silently takes the tool layer down with it.
 *
 * Its password is DERIVED from `OPS_API_KEY`, not from `CREDENTIAL_ENC_KEY`.
 * That is the load-bearing difference: `foundry_ro`'s password comes from
 * `CREDENTIAL_ENC_KEY`, which ops-api must never hold — it is the key that
 * decrypts every stored credential in `foundry_parent`. Deriving from the ops
 * root instead means ops-api can compute its own database password from
 * something it is already trusted with, and the two processes cannot drift.
 *
 * ── Why this lives HERE and not in `hr-roles.ts` ────────────────────────────
 *
 * `hr-roles.ts` is deliberately not modified. It is asserted against by
 * `hr-roles.test.ts` and `demo:verify`, both of which check `foundry_ro`'s exact
 * privileges from `pg_catalog`; folding a second role into it would put two
 * subjects behind one set of assertions.
 *
 * ⚠ It must run AFTER the DDL, for the reason `hr-roles.ts` documents:
 * `hr-schema.sql` drops every table, and table privileges die with the table.
 * `provisionDemo()` calls it after `seedHrDatabase()`, and `demo:verify`
 * re-checks the result rather than assuming it.
 */

/** Everything ops-api must NOT be able to do to `hr_demo`. */
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** Postgres has no parameter binding for identifiers or role passwords. */
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

export interface OpsHrRoleReport {
  role: string;
  created: boolean;
  database: string;
}

export async function ensureOpsHrRole(): Promise<OpsHrRoleReport> {
  const role = opsHrRoRole();
  const password = opsHrRoPassword();
  const database = config.demo.dbName;

  const client = new Client({ connectionString: hrDbUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ ok: number }>(
      `SELECT 1 AS ok FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    const created = rows.length === 0;
    await client.query(
      created
        ? `CREATE ROLE ${role} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`
        : // Re-assert on every seed. If the root key rotated, the stored password
          // is stale and every ops-api query fails to authenticate with nothing
          // saying why.
          `ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );

    // `hr-roles.ts` has already run `REVOKE ALL ON DATABASE … FROM PUBLIC`, so
    // CONNECT has to be granted explicitly — it is not inherited.
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`,
    );

    // The absent grants are the control, not `default_transaction_read_only` —
    // a session can turn that off, and this was measured: a client issuing
    // `SET transaction_read_only = off` and then writing still gets
    // InsufficientPrivilege. Revoke explicitly anyway, because `GRANT SELECT`
    // does not displace an `INSERT` left by a previous seed or a hand-run grant.
    await client.query(
      `REVOKE ${WRITE_PRIVILEGES.join(", ")} ON ALL TABLES IN SCHEMA public FROM ${role}`,
    );
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
    await client.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${role}`);
    await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
    await client.query(
      `ALTER ROLE ${role} SET statement_timeout = ${literal(config.demo.roStatementTimeout)}`,
    );

    return { role, created, database };
  } finally {
    await client.end();
  }
}
