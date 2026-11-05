import pg from "pg";
import mysql from "mysql2/promise";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as parentSchema from "../db/schema.js";
import { pool } from "../db/index.js";
import { config } from "../config/index.js";

/**
 * WHAT is this credential pointed at? — archive/GAPS.md §1.3
 *
 * The companion question to `datasource-privilege.service.ts`, which asks *what
 * can this credential do*. Both have to be asked, because the answers are
 * independent and the dangerous case passes the first one cleanly.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 *
 * D-40 refuses a credential that can WRITE. It says nothing about where the
 * credential points. So a **read-only** credential on `foundry_parent` — the
 * control-plane database holding `workspace_secrets`, every tenant's encrypted
 * DSNs, every flow revision and every generated fragment — is registered as a
 * tenant datasource without a single finding. Read-only is not a mitigation
 * here; it is precisely the credential you would want in order to read it.
 *
 * ⚠ **Measured on this deployment before building it**, because "it would be
 * bad if" is not evidence:
 *
 *   * `foundry_parent`'s ACL is `{=T/foundry, foundry=CTc/foundry}` — CONNECT is
 *     revoked from PUBLIC, so no tenant-shaped role reaches it today. That is a
 *     property of the **cluster**, not something Foundry does or checks, and
 *     nothing re-asserts it.
 *   * `kestra` and `foundry_ops` have `datacl = NULL`, i.e. the default, which
 *     grants CONNECT to PUBLIC. `foundry_ro` connects to **both**. It reads 0
 *     tables and writes 0 tables — so the D-40 gate returns `readOnly: true` and
 *     Foundry stores a datasource pointed at the engine's own database. Harmless
 *     in content terms *today*, and one `GRANT SELECT … TO PUBLIC` in an ops
 *     script away from not being.
 *
 * ── Why the host allowlist archive/GAPS.md proposed is the WEAKER half ───────────────
 *
 * §1.3 called "an allowlist of reachable hosts per deployment" the cheap 80%.
 * Built alone it would have been I-38 twice over:
 *
 *   * **Unset by default it cannot fail.** A control nobody configures protects
 *     nobody, and the deployments that skip configuring it are exactly the ones
 *     that needed it.
 *   * **Set, it is walked past by typing a different address.** One database has
 *     many names — `postgres`, `127.0.0.1`, the container IP,
 *     `host.docker.internal:5433`, a pgbouncer, an SSH tunnel. A denylist of
 *     names refuses the honest mistake and nothing else.
 *
 * So the allowlist is here, opt-in, and **reported when unset** rather than
 * silently passing — but the load-bearing check is the other one: the target is
 * asked **who it is**, over the connection that is being registered.
 *
 * ── Identity by contents, which has no address in it at all ──────────────────
 *
 * Two questions, and each covers the other's blind spot:
 *
 *  1. **Same cluster, same database** (Postgres). `pg_control_system()` gives a
 *     cluster's `system_identifier`; `current_database()` gives the database.
 *     The pair is exact, and no hostname, IP, proxy or tunnel changes it.
 *     ⚠ The pair and not the cluster alone: `hr_demo`, `hr_demo_alt`,
 *     `finance_demo` and `legal_demo` live on the **same cluster** as
 *     `foundry_parent`, so
 *     refusing the cluster would refuse every demo datasource in the repo.
 *     Measured on a genuinely low-privilege connection (PG 16.11): a freshly
 *     created `nosuperuser` role reads `system_identifier` fine. Where it cannot
 *     be read the verdict records `clusterId: null` — an unanswered question,
 *     never a clean bill.
 *  2. **Does it LOOK like a control-plane database** (Postgres and MySQL). The
 *     target's own table names are read out of its catalogue and matched against
 *     three signatures. This is what catches a control plane on a *different*
 *     cluster — a second Foundry deployment, a replica, a restored backup — for
 *     which the identity check has nothing to compare against.
 *
 * **The parent signature is DERIVED from `db/schema.ts`, not written down here.**
 * A migration that renames a table updates the signature the same day. A
 * hardcoded list is a second definition of what Foundry's schema is, and it
 * drifts in the direction that makes the check quietly stop matching.
 *
 * ── The thresholds are where they are because of this measurement ────────────
 *
 * Every database on the deployment cluster, scored against all three signatures
 * (2026-08-03). The separation is not marginal, and the two cross-hits are the
 * reason `min` is not 1:
 *
 * ```
 *   database                 parent   ops   kestra    verdict
 *   hr_demo                       0     0        0    allowed
 *   hr_demo_alt                   0     0        0    allowed
 *   finance_demo                  0     0        0    allowed
 *   legal_demo                    0     0        0    allowed
 *   foundry_sbx_3affba7b…         0     0        0    allowed
 *   foundry_ops                   0     4        0    refused  (min 3)
 *   kestra                        2     0        8    refused  (min 4)
 *   foundry_parent               21     0        2    refused  (min 8)
 * ```
 *
 * Every tenant database scores **zero on all three**, so the positive control is
 * not a near miss. `kestra` and `foundry_parent` each score 2 against the other's
 * signature — `flows` and `triggers`, names they genuinely share — which is
 * exactly what a threshold of 1 would have turned into a refusal for the wrong
 * reason and a message naming the wrong subject.
 *
 * ── What this deliberately does NOT do ───────────────────────────────────────
 *
 *   * **It is not a firewall.** Nothing here stops the API container reaching a
 *     host; it refuses to *store* a datasource that resolves to one of three
 *     things. Reachability is a deployment concern and belongs in the network.
 *   * **It says nothing about a tenant's own database.** archive/GAPS.md §1.3's second
 *     half — *what is a tenant allowed to point Foundry at* — is a product
 *     decision and stays open.
 *   * **A false positive is possible and accepted.** A tenant database that
 *     genuinely contains eight of Foundry's twenty-one table names together is
 *     refused. Requiring co-occurrence rather than any single name is what makes
 *     that essentially impossible; requiring one would refuse every database
 *     with a `tickets` table.
 */

/** One reason a target was refused, written for the person who pasted the DSN. */
export interface TargetFinding {
  rule: string;
  message: string;
  facts?: Record<string, unknown>;
}

export interface TargetVerdict {
  /** True only when nothing was found AND the checks that could run, ran. */
  allowed: boolean;
  findings: TargetFinding[];
  /**
   * What was actually examined. `no findings` and `nothing looked at` are
   * different states and this is how they stay distinguishable — the same
   * reason `PrivilegeVerdict` carries `checked`.
   */
  checked: {
    /** The host in the DSN that will be STORED, which is what a later reader dials. */
    host: string;
    /** `current_database()` as the target reported it, not as the DSN spelled it. */
    database: string | null;
    /** The target cluster's `system_identifier`; null when it could not be read. */
    clusterId: string | null;
    /** Foundry's own, for the same cluster; null when it could not be read. */
    ownClusterId: string | null;
    /** How many table names were read out of the target's catalogue. */
    relations: number;
    /** The configured host allowlist, or null when the deployment has not set one. */
    hostAllowlist: string[] | null;
  };
}

/**
 * The table names Foundry's own control plane has, read off the Drizzle schema.
 *
 * Twenty-one at the time of writing, including `workspace_secrets`,
 * `flow_revisions`, `execution_tokens` and `datasource_fixtures` — names that do
 * not co-occur in anybody else's database by accident.
 */
function parentTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(parentSchema)) {
    if (is(value, PgTable)) names.push(getTableName(value));
  }
  return names.sort();
}

interface Signature {
  id: string;
  label: string;
  /**
   * What is actually at stake for THIS database, per signature.
   *
   * One shared sentence was wrong for two of the three: the Kestra database
   * holds flow definitions and execution history and no `workspace_secrets`, so
   * telling its refusal that it exposes every workspace's secrets overstates in
   * the direction that gets a control disbelieved.
   */
  stake: string;
  tables: string[];
  /**
   * How many must co-occur. High enough that a tenant database cannot reach it
   * by having a few ordinary names, low enough that a version skew — a table
   * added or dropped between this build and the target — does not silently stop
   * matching.
   */
  min: number;
}

function signatures(): Signature[] {
  return [
    {
      id: "foundry_parent",
      label: "Foundry's own control-plane database",
      stake:
        "a read-only credential on it reads every workspace's secrets, encrypted connection " +
        "strings, flow revisions and generated fragments",
      tables: parentTableNames(),
      min: 8,
    },
    {
      // Read off the running engine's `kestra` database. Kestra is pinned
      // (v1.3.29) and these are core tables, not plugin ones.
      id: "kestra",
      label: "the Kestra engine's database",
      stake:
        "it holds every tenant's deployed flow definitions and execution history — not the " +
        "secret values, which live in foundry_parent",
      tables: [
        "executions",
        "queues",
        "flows",
        "triggers",
        "flow_topologies",
        "executorstate",
        "execution_queued",
        "multipleconditions",
      ],
      min: 4,
    },
    {
      // packages/ops-api — the tool layer's own database. It holds the outbox,
      // the tickets and `api_call_log`, which carries redacted request metadata
      // for every tool call every tenant has made.
      id: "ops",
      label: "the ops-api tool layer's database",
      stake:
        "it holds the outbox, the tickets and api_call_log — every tool call every tenant has " +
        "made",
      tables: ["api_call_log", "mail_outbox", "chat_messages", "tickets"],
      min: 3,
    },
  ];
}

function matchSignature(present: Set<string>): TargetFinding | null {
  for (const sig of signatures()) {
    const hits = sig.tables.filter((t) => present.has(t));
    if (hits.length >= sig.min) {
      return {
        rule: `control_plane_signature:${sig.id}`,
        message:
          `this database looks like ${sig.label} — ${hits.length} of its tables are present ` +
          `(${hits.slice(0, 6).join(", ")}${hits.length > 6 ? ", …" : ""}). Foundry's own state is ` +
          `not a tenant datasource — ${sig.stake}. Read-only is not a mitigation here; it is ` +
          `exactly the credential that would be wanted.`,
        facts: { signature: sig.id, matched: hits.length, required: sig.min, examples: hits.slice(0, 6) },
      };
    }
  }
  return null;
}

/**
 * Foundry's own (cluster, database), read once through the existing pool.
 *
 * Cached because it cannot change while the process lives, and because a failed
 * read must not turn into a per-registration reconnect storm. A `null` cluster
 * id disables check (1) and is recorded as such — see `ownClusterId` in the
 * verdict.
 */
let ownIdentityCache: Promise<{ database: string; clusterId: string | null }> | null = null;
function ownIdentity() {
  if (!ownIdentityCache) {
    ownIdentityCache = (async () => {
      const r = await pool.query<{ db: string }>("select current_database() as db");
      let clusterId: string | null = null;
      try {
        const c = await pool.query<{ id: string }>(
          "select system_identifier::text as id from pg_control_system()",
        );
        clusterId = c.rows[0]?.id ?? null;
      } catch {
        // Restricted on this cluster. Check (2) still runs; the verdict says so.
        clusterId = null;
      }
      return { database: r.rows[0]?.db ?? "", clusterId };
    })().catch((e) => {
      ownIdentityCache = null;
      throw e;
    });
  }
  return ownIdentityCache;
}

/** Exposed for tests: forget the cached identity. */
export function _resetOwnIdentity() {
  ownIdentityCache = null;
}

/**
 * Match a host against the deployment's allowlist.
 *
 * `example.com` matches that host exactly; `.example.com` matches any host under
 * it. A bare suffix without the leading dot is NOT treated as a suffix, because
 * `db.example.com` in a list must not silently permit `evildb.example.com`.
 */
export function _hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith(".") ? h === e.slice(1) || h.endsWith(e) : h === e;
  });
}

async function inspectPostgres(dsn: string): Promise<{
  database: string;
  clusterId: string | null;
  tables: Set<string>;
}> {
  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const who = await client.query<{ db: string }>("select current_database() as db");
    let clusterId: string | null = null;
    try {
      const c = await client.query<{ id: string }>(
        "select system_identifier::text as id from pg_control_system()",
      );
      clusterId = c.rows[0]?.id ?? null;
    } catch {
      clusterId = null;
    }
    // `pg_class` is world-readable, so this needs no grant on the tables
    // themselves — which matters: the credential being registered is supposed to
    // be able to read very little.
    const rel = await client.query<{ name: string }>(
      `select c.relname as name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname !~ '^pg_'
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
        limit 5000`,
    );
    return {
      database: who.rows[0]?.db ?? "",
      clusterId,
      tables: new Set(rel.rows.map((r) => r.name)),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function inspectMysql(dsn: string): Promise<{
  database: string;
  clusterId: string | null;
  tables: Set<string>;
}> {
  const conn = await mysql.createConnection({ uri: dsn, connectTimeout: 8000 });
  try {
    const [dbRows] = await conn.query<mysql.RowDataPacket[]>("select database() as db");
    const [relRows] = await conn.query<mysql.RowDataPacket[]>(
      `select table_name as name from information_schema.tables
        where table_schema = database() limit 5000`,
    );
    return {
      database: (dbRows[0]?.db as string) ?? "",
      // MySQL has no cluster identifier a low-privilege role can read that is
      // stable across restarts, so check (1) is Postgres-only and the verdict
      // reports null rather than implying it ran.
      clusterId: null,
      tables: new Set(relRows.map((r) => String(r.name))),
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

// ── Where a datasource may point, beyond "not at Foundry" — §1.3b, D-72 ──────

/**
 * Address classes that are never a tenant's database, refused unconditionally.
 *
 * ── Why this is the ONLY unconditional half of §1.3b ─────────────────────────
 *
 * §1.3b asks what a tenant may point Foundry at beyond "not at Foundry" — a
 * third party's database, an internal service on the deployment network — and
 * says the mechanism exists but the policy needs an answer to what a tenant is,
 * which is §1.1. That is still true and this does not pretend otherwise.
 *
 * What needs no policy is the class below. **Nothing legitimate is a Postgres or
 * MySQL server on a link-local address.** `169.254.169.254` is the cloud
 * metadata endpoint on AWS, GCP, Azure and DigitalOcean; reaching it is how a
 * credential-theft chain starts, and it is not a database. So this is refused
 * for every deployment, allowlist or not, and refusing it breaks nothing that
 * ever worked.
 *
 * ⚠ **Private ranges are deliberately NOT here.** `10.x`, `172.16-31.x`,
 * `192.168.x` and loopback are where this deployment's own demo databases live
 * (`host.docker.internal:5433`, and `localhost:5433` for every host-run
 * harness). Refusing them would break `demo:seed`, `finance:seed` and the
 * sandbox on day one — I-36 is the record of the last time a datasource check
 * did exactly that, and `pnpm demo:seed` was broken outright for two
 * programmes. A control everybody has to route around is not a control.
 *
 * ⚠ **This is registration-time, and DNS can move underneath it.** A name that
 * resolves to a public address now and to `169.254.169.254` on the next lookup
 * walks past — classic rebinding. Closing that needs the resolution to be
 * pinned into the DSN the driver dials, which is a change to every connection
 * path in the product. Stated rather than implied; see §1.3b.
 */
const NEVER_A_DATABASE: Array<{ test: (ip: string) => boolean; what: string }> = [
  {
    // 169.254.0.0/16 — link-local, and the cloud metadata endpoint lives in it.
    test: (ip) => /^169\.254\./.test(ip),
    what: "a link-local address — the cloud metadata endpoint (169.254.169.254) is in this range",
  },
  {
    // fe80::/10, and the IPv4-mapped form a resolver can hand back.
    test: (ip) => /^fe[89ab][0-9a-f]:/i.test(ip) || /^::ffff:169\.254\./i.test(ip),
    what: "an IPv6 link-local address",
  },
  {
    test: (ip) => ip === "0.0.0.0" || ip === "::" || ip === "255.255.255.255",
    what: "an unspecified or broadcast address, which is not a host",
  },
  {
    // 224.0.0.0/4. A multicast group is not a database and a connection to one
    // is a question about what is listening, not a connection.
    test: (ip) => /^2(2[4-9]|3[0-9])\./.test(ip),
    what: "a multicast address",
  },
];

/** Exported for the test — the classifier, without the DNS round trip. */
export function _addressClass(ip: string): string | null {
  return NEVER_A_DATABASE.find((c) => c.test(ip))?.what ?? null;
}

/**
 * Resolve a host and refuse it if ANY address it answers with is in the class
 * above.
 *
 * ⚠ **Any, not all.** A name resolving to one public address and one link-local
 * one is refused: the driver picks whichever the resolver hands it first, so
 * "some of its addresses are fine" is not a property anything can rely on.
 *
 * ⚠ **A host that does not resolve is NOT refused here.** Unreachable is already
 * a refusal one layer down — `inspectPostgres` cannot connect and D-40's
 * privilege check fails closed — and refusing here as well would report a DNS
 * outage as an address-policy violation, sending the reader to the wrong fix.
 */
async function classifyHost(host: string): Promise<TargetFinding | null> {
  if (!host) return null;
  // A literal IP needs no lookup, and going through the resolver for one is how
  // a check acquires a dependency on DNS it does not need.
  const literal = _addressClass(host);
  if (literal) {
    return {
      rule: "address_never_a_database",
      message: `"${host}" is ${literal}. A datasource cannot point there.`,
      facts: { host, addresses: [host], reason: literal },
    };
  }

  let addresses: string[];
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(host, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    return null;
  }

  const bad = addresses.map((a) => ({ a, why: _addressClass(a) })).filter((x) => x.why);
  if (!bad.length) return null;
  return {
    rule: "address_never_a_database",
    message:
      `"${host}" resolves to ${bad.map((b) => b.a).join(", ")}, which is ${bad[0]!.why}. ` +
      `A datasource cannot point there — this is refused on every deployment, with or ` +
      `without a host allowlist.`,
    facts: { host, addresses, reason: bad[0]!.why },
  };
}

export const datasourceTargetService = {
  _addressClass,
  /**
   * Same two types as the privilege gate, and for the same reason: only
   * `postgres` and `mysql` can be introspected, host a named query, or be
   * reached from a `datasource` step. Add this check WITH the introspector if a
   * third type is ever supported.
   */
  supports(type: string) {
    return type === "postgres" || type === "mysql";
  },

  /**
   * @param storedDsn the DSN that will be persisted — its host is what the
   *   allowlist is checked against, because that is the address a future reader
   *   dials.
   * @param dialDsn the DSN to connect with now. Differs from `storedDsn` only
   *   under `verifyVia`, which `assertSameCredential` already constrains to a
   *   host/port change. ⚠ The identity checks therefore describe the database
   *   that was DIALLED; that is the same caveat `verifyVia` already carries, and
   *   `verifyVia` is a function argument no HTTP caller can reach.
   */
  async verify(type: string, storedDsn: string, dialDsn: string): Promise<TargetVerdict> {
    const findings: TargetFinding[] = [];
    const allowlist = config.datasourceHostAllowlist;

    let host = "";
    try {
      host = new URL(storedDsn).hostname;
    } catch {
      host = "";
    }

    // ── §1.3b, D-72 — BEFORE anything dials the target ────────────────────────
    //
    // First, and deliberately: the classes below are ones nothing legitimate
    // lives on, so a connection attempt to one is itself the thing being
    // prevented. Running the identity probe first would mean Foundry had already
    // made the request to `169.254.169.254` that this refuses.
    const addressFinding = await classifyHost(host);
    if (addressFinding) {
      return {
        allowed: false,
        findings: [addressFinding],
        // Nothing was dialled, so there is nothing to report about the target.
        // Reporting a database name here would be inventing one.
        checked: {
          host,
          database: null,
          clusterId: null,
          ownClusterId: null,
          relations: 0,
          hostAllowlist: allowlist,
        },
      };
    }

    if (allowlist && !_hostAllowed(host, allowlist)) {
      findings.push({
        rule: "host_not_allowlisted",
        message:
          `"${host}" is not in this deployment's DATASOURCE_HOST_ALLOWLIST. An operator sets ` +
          `that list; it is not something a request can widen.`,
        facts: { host, allowlist },
      });
    }

    const inspect = type === "mysql" ? inspectMysql : inspectPostgres;
    const target = await inspect(dialDsn);
    const own = await ownIdentity().catch(() => ({ database: "", clusterId: null }));

    if (
      own.clusterId !== null &&
      target.clusterId !== null &&
      own.clusterId === target.clusterId &&
      own.database === target.database
    ) {
      findings.push({
        rule: "control_plane_identity",
        message:
          `this is Foundry's own database ("${target.database}") on Foundry's own Postgres ` +
          `cluster. The address in the connection string does not change that — the cluster ` +
          `was asked who it is.`,
        facts: { database: target.database, clusterId: target.clusterId },
      });
    }

    const bySignature = matchSignature(target.tables);
    if (bySignature) findings.push(bySignature);

    return {
      allowed: findings.length === 0,
      findings,
      checked: {
        host,
        database: target.database,
        clusterId: target.clusterId,
        ownClusterId: own.clusterId,
        relations: target.tables.size,
        hostAllowlist: allowlist,
      },
    };
  },
};
