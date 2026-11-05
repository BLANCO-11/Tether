import pg from "pg";
import mysql from "mysql2/promise";

/**
 * Is this credential read-only? — Stage 9.2.
 * DECISIONS.md D-40, D-44 · ISSUES.md I-27, I-36
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 *
 * `foundry_ro`, `ensureReadOnlyRole()` and the twelve privilege tests are wired
 * through **`demo/` only**. A datasource registered through the API carried
 * whatever credential the caller supplied, so the boundary that protects the
 * demo did not protect a customer — and the failure was quiet: paste an owner
 * DSN, everything works, and a `datasource` step could write.
 *
 * ── ⚠ It tests the ABSENT GRANT, not `default_transaction_read_only` ─────────
 *
 * I-27 records the day that exact confusion made a check pass for the wrong
 * reason. A session setting is a **preference**: `SET transaction_read_only =
 * off` turns it back on, and a connection string carrying
 * `options=-c default_transaction_read_only=on` would sail through a check that
 * read it. The demo's own note is explicit — *"the primary control is the absent
 * grants"*, verified by a script that turned the setting off and still got
 * `InsufficientPrivilege`.
 *
 * So this asks the catalogue what the role is actually **granted**, and it asks
 * through `has_*_privilege`, which resolves grants held via role membership and
 * via the pseudo-role `PUBLIC`. That second one matters twice over: `REVOKE …
 * FROM <role>` does not remove a privilege held via `PUBLIC`, and that bit this
 * codebase twice already (the demo roles, and the Kestra DB boundary in I-04).
 *
 * ── Why probe rather than write ──────────────────────────────────────────────
 *
 * The obvious implementation attempts an INSERT and expects it to fail. It is
 * also the one that writes a row into a customer's database when the credential
 * turns out NOT to be read-only, which is the case this exists to detect. A
 * catalogue read cannot have that failure mode.
 */

/** One reason a credential was refused, written to be shown to the person who pasted it. */
export interface PrivilegeFinding {
  rule: string;
  message: string;
  facts?: Record<string, unknown>;
}

export interface PrivilegeVerdict {
  /** True only when nothing writable was found AND the check actually ran. */
  readOnly: boolean;
  findings: PrivilegeFinding[];
  /** What was examined, so "no findings" can be distinguished from "nothing looked at". */
  checked: { role: string; schemas: string[]; relations: number };
}

/** Write privileges, in the order a person would recognise them. */
const WRITE_PRIVS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

/**
 * Postgres.
 *
 * Four questions, and each one is a way a role can write that the others miss:
 *
 *  1. Is it a **superuser**? Every privilege check returns true for one, so an
 *     implementation that only looked at tables would report a superuser DSN as
 *     read-only and be wrong in the most expensive possible way.
 *  2. Does it hold a write privilege on any relation in the allowlisted schemas?
 *  3. Can it **CREATE** in one of those schemas — because a role that can create
 *     a table owns it, and an owner can write to it. That is why the demo roles
 *     `REVOKE CREATE ON SCHEMA public FROM PUBLIC`: on PG ≤14 `public` grants
 *     CREATE to PUBLIC, and `foundry_ro` could otherwise create, own and write.
 *  4. Can it create a **schema** (CREATE on the database), which is the same
 *     escape one level up.
 */
async function checkPostgres(dsn: string, schemas: string[]): Promise<PrivilegeVerdict> {
  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const findings: PrivilegeFinding[] = [];

    const who = await client.query<{ role: string; superuser: boolean; createrole: boolean; createdb: boolean }>(
      `select current_user as role,
              rolsuper as superuser,
              rolcreaterole as createrole,
              rolcreatedb as createdb
         from pg_roles where rolname = current_user`,
    );
    const role = who.rows[0]?.role ?? "unknown";
    if (who.rows[0]?.superuser) {
      findings.push({
        rule: "superuser",
        message:
          `"${role}" is a SUPERUSER, so every privilege check passes and nothing can restrict it. ` +
          `Create a role with CONNECT + USAGE + SELECT only, and register that instead.`,
        facts: { role },
      });
    }
    if (who.rows[0]?.createrole) {
      // A role that can create roles can create a writable one and become it.
      findings.push({
        rule: "createrole",
        message: `"${role}" has CREATEROLE, so it can grant itself write access at any time.`,
        facts: { role },
      });
    }

    const writable = await client.query<{ schema: string; relation: string; privilege: string }>(
      `select n.nspname as schema, c.relname as relation, p.privilege
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral unnest($2::text[]) as p(privilege)
        where n.nspname = any($1::text[])
          and c.relkind in ('r','p','v','m','f')
          and has_table_privilege(current_user, c.oid, p.privilege)
        limit 50`,
      [schemas, WRITE_PRIVS as unknown as string[]],
    );
    if (writable.rowCount) {
      const byRelation = new Map<string, string[]>();
      for (const r of writable.rows) {
        const key = `${r.schema}.${r.relation}`;
        byRelation.set(key, [...(byRelation.get(key) ?? []), r.privilege]);
      }
      findings.push({
        rule: "writable_relations",
        message:
          `"${role}" can write to ${byRelation.size} relation(s) in ${schemas.join(", ")} — ` +
          `for example ${[...byRelation.entries()]
            .slice(0, 3)
            .map(([rel, privs]) => `${rel} (${privs.join(", ")})`)
            .join("; ")}. A generated step could satisfy "send the email" with an INSERT.`,
        facts: {
          relations: [...byRelation.entries()].slice(0, 20).map(([rel, privs]) => ({ rel, privs })),
        },
      });
    }

    const creatable = await client.query<{ schema: string }>(
      `select s as schema from unnest($1::text[]) as s
        where has_schema_privilege(current_user, s, 'CREATE')`,
      [schemas],
    );
    if (creatable.rowCount) {
      findings.push({
        rule: "schema_create",
        message:
          `"${role}" can CREATE in ${creatable.rows.map((r) => r.schema).join(", ")}. A role that ` +
          `can create a table OWNS it, and an owner can write to it — so this is write access ` +
          `with an extra step. On PostgreSQL 14 and earlier the \`public\` schema grants CREATE to ` +
          `PUBLIC by default; revoke it from PUBLIC, not just from the role.`,
        facts: { schemas: creatable.rows.map((r) => r.schema) },
      });
    }

    const dbCreate = await client.query<{ can: boolean }>(
      `select has_database_privilege(current_user, current_database(), 'CREATE') as can`,
    );
    if (dbCreate.rows[0]?.can) {
      findings.push({
        rule: "database_create",
        message: `"${role}" can create SCHEMAS in this database, which is the same escape one level up.`,
      });
    }

    const counted = await client.query<{ n: string }>(
      `select count(*)::text as n from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1::text[]) and c.relkind in ('r','p','v','m','f')`,
      [schemas],
    );
    const relations = Number(counted.rows[0]?.n ?? 0);

    return { readOnly: findings.length === 0, findings, checked: { role, schemas, relations } };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * MySQL. `SHOW GRANTS` rather than a catalogue join, because MySQL's
 * `information_schema` privilege views do not resolve grants held via roles on
 * every version this could meet.
 *
 * Coarser than the Postgres check and honest about it: it matches the privilege
 * WORDS in the grant text, so an exotic grant it does not recognise is not
 * proven safe — which is why an unparseable grant is a finding rather than a
 * pass.
 */
const MYSQL_WRITE = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|REFERENCES|TRIGGER|GRANT OPTION)\b/i;

async function checkMysql(dsn: string, schemas: string[]): Promise<PrivilegeVerdict> {
  const conn = await mysql.createConnection(dsn);
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
    const grants = rows.map((r) => String(Object.values(r)[0]));
    const [me] = await conn.query<mysql.RowDataPacket[]>("SELECT CURRENT_USER() AS u");
    const role = String(me[0]?.u ?? "unknown");

    const findings: PrivilegeFinding[] = [];
    const writing = grants.filter((g) => MYSQL_WRITE.test(g));
    if (writing.length) {
      findings.push({
        rule: "writable_grants",
        message:
          `"${role}" holds write privileges: ${writing.join(" · ")}. Register a user granted ` +
          `SELECT only.`,
        facts: { grants: writing },
      });
    }
    if (!grants.length) {
      // Nothing came back at all. Not a pass — a check that examined nothing
      // reads exactly like a check that found nothing.
      findings.push({
        rule: "no_grants_visible",
        message:
          `SHOW GRANTS returned nothing for "${role}", so this credential's privileges could not ` +
          `be established. Refusing rather than assuming.`,
      });
    }
    return { readOnly: findings.length === 0, findings, checked: { role, schemas, relations: 0 } };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

export const datasourcePrivilegeService = {
  /** The types this check understands. Anything else cannot be gated — see `verify`. */
  supports(type: string): boolean {
    return type === "postgres" || type === "mysql";
  },

  /**
   * Probe a credential's write privileges.
   *
   * Throws only when the database could not be reached or the query failed —
   * "unreachable" and "writable" are different answers and the caller renders
   * them differently.
   */
  async verify(type: string, dsn: string, schemas: string[]): Promise<PrivilegeVerdict> {
    const scope = schemas.length ? schemas : ["public"];
    if (type === "postgres") return checkPostgres(dsn, scope);
    if (type === "mysql") return checkMysql(dsn, scope);
    throw new Error(`read-only verification is not implemented for datasource type "${type}"`);
  },
};
