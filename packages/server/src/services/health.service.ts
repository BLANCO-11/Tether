/**
 * What `GET /api/health` can honestly say — GAPS §6.2.
 *
 * Before this, the endpoint answered for the parent's own Postgres and nothing
 * else, so a load balancer read green while the engine was unreachable, ops-api
 * was down, or the schema this build expects had never been migrated. The only
 * check that covered those was `pnpm kestra:check`, which is a harness run by a
 * person and not a runtime signal.
 *
 * ── 200 vs 503: what this endpoint MEANS ─────────────────────────────────────
 *
 * `/api/health` answers exactly one question: **can this process serve
 * requests?** It is 200 unless the process itself is broken — its own database
 * unreachable, or the migration ledger short of what this build ships.
 *
 * It deliberately does NOT go 503 when Kestra or ops-api are down, and
 * the reason is not leniency. With Kestra unreachable the API can still list
 * flows, serve run history, render the datasource pages and — most of the point
 * — show a person the component that is down and why. Failing the whole
 * endpoint takes that surface out of the load balancer at the exact moment it
 * is the only thing that could explain the outage, and it converts one
 * dependency's failure into a total one.
 *
 * A caller that genuinely wants "everything is wired" has
 * `GET /api/health/strict`, which 503s unless every component is `up`. That is
 * a deploy smoke-test and a post-restart readiness probe, not a liveness check,
 * and it is a separate URL so that the choice is made by whoever configures the
 * probe rather than by this file.
 *
 * ── Every component carries the bound of its own probe ───────────────────────
 *
 * `caveat` is not documentation politeness. A component can answer `up` from
 * evidence far weaker than the thing a reader will take it to mean — the
 * runtime component this file used to carry derived `llmConnected` from the
 * mere listing of models, which proves no completion has ever succeeded — and
 * that stayed a trap precisely because the caveat lived in a doc while the
 * boolean travelled on the wire. Every component here states what its probe
 * cannot detect, in the response, beside the answer it could be misread as.
 * `mail` is the surviving example and says so in its own caveat.
 *
 * ── Nothing here may leak ────────────────────────────────────────────────────
 *
 * This route is UNAUTHENTICATED (see `app.ts`). Upstream error text routinely
 * contains a URL, a container hostname, a port, a UUID or a Kestra namespace —
 * `sanitizeDetail` strips all of those, because R5 says a client is never given
 * anything that addresses Kestra, and an unauthenticated endpoint is the worst
 * possible place to hand out the internal topology. Version and edition strings
 * from the engine are dropped for the same reason: an operator has
 * `kestra:check` and the Kestra UI, and neither of those is on the internet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { pgErrorCode } from "../db/pg-error.js";
import { config } from "../config/index.js";
import { kestra } from "../services/kestra-client.service.js";

/**
 * `unknown` and `down` are different answers and the distinction is the whole
 * value of the field: `down` means we asked and got no, or nothing; `unknown`
 * means the probe itself could not run. A critical component that is `down`
 * takes the process out of service; a critical component that is `unknown`
 * degrades it and leaves it serving, because "we could not check" is not
 * evidence of failure and ejecting on it is how a packaging mistake becomes an
 * outage.
 */
export type ComponentStatus = "up" | "degraded" | "down" | "unknown";

export type ComponentName =
  | "database"
  | "migrations"
  | "kestra"
  | "mail";

export interface HealthComponent {
  name: ComponentName;
  status: ComponentStatus;
  /** True when this being `down` means the process cannot serve requests. */
  critical: boolean;
  /** Wall-clock for the probe, including a timeout. `null` if it never ran. */
  latencyMs: number | null;
  /** Human-readable and redacted. Never a URL, hostname, id or credential. */
  detail: string;
  /** What this probe CANNOT tell you. Travels with the answer, never only in a doc. */
  caveat: string;
}

export interface HealthReport {
  /** `ok` — every component up. `degraded` — something is not, but we can serve. `down` — we cannot. */
  status: "ok" | "degraded" | "down";
  /** The load-balancer answer. `/api/health` is 503 only when this is false. */
  serves: boolean;
  /** When the components below were actually probed. */
  checkedAt: string;
  /** How old that is. A cached report says so rather than looking live. */
  ageMs: number;
  cacheTtlMs: number;
  probeTimeoutMs: number;
  components: HealthComponent[];
}

/**
 * Per-probe ceiling.
 *
 * The Kestra client's own ceiling is 30s, which is right for a control-plane
 * call and catastrophic for a health check: a stalled engine would hang the
 * endpoint, and a health check that hangs is worse than one that lies — the
 * load balancer's own timeout fires and every instance drops out together.
 * Probes run concurrently, so the endpoint's worst case is this number, not the
 * sum of five.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long a report is reused.
 *
 * Five upstream calls per request is not something to put behind a 1s liveness
 * probe. The cache is what makes this cheap enough to poll; `ageMs` in the body
 * is what stops it being a lie — a caller can always see how stale the answer
 * it is acting on is, and `?fresh=1` forces a re-probe.
 */
const CACHE_TTL_MS = 5_000;


// ── Redaction ────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Hostnames this deployment is configured with — never for a caller to learn. */
function internalHosts(): string[] {
  const raw = [
    config.kestra.baseUrl,
    config.kestra.foundryUrl,
    config.inference.baseUrl,
    config.databaseUrl,
  ];
  const hosts = new Set<string>();
  for (const u of raw) {
    if (!u) continue;
    try {
      const h = new URL(u).hostname;
      // One- and two-character hosts would match half the alphabet in prose.
      if (h.length > 2) hosts.add(h);
    } catch {
      /* not a URL — nothing to extract */
    }
  }
  return [...hosts];
}

/**
 * Make an upstream error message safe to hand an unauthenticated caller.
 *
 * The order matters: whole URLs first (so a scheme-bearing address never
 * survives as its host), then bare `host:port`, then the configured hostnames
 * on their own (undici's `getaddrinfo ENOTFOUND kestra` carries no port), then
 * Kestra namespaces, then anything long and opaque enough to be an id or a
 * token. A UUID is 36 characters of `[A-Za-z0-9-]` and is caught by the last
 * rule, which is what keeps an execution id out of a public response.
 */
export function sanitizeDetail(raw: string | undefined | null, max = 220): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"()<>]+/gi, "<endpoint>");
  s = s.replace(/\b[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?:\d{2,5}\b/gi, "<endpoint>");
  for (const h of internalHosts()) {
    s = s.replace(new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(h)}(?![A-Za-z0-9._-])`, "gi"), "<host>");
  }
  s = s.replace(
    new RegExp(`\\b${escapeRe(config.kestra.namespacePrefix)}(?:\\.[a-z0-9_-]+)+`, "gi"),
    "<namespace>",
  );
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<redacted>");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── Probes ───────────────────────────────────────────────────────────────────

class ProbeTimeout extends Error {
  constructor(readonly ms: number) {
    super(`no answer within ${ms}ms`);
  }
}

/**
 * Stop waiting. The underlying request is NOT cancelled — the clients own their
 * own abort signals and reaching into them from here would mean a health check
 * could cancel a real call. It resolves later, into nothing. That is the bound:
 * a `down` from here means "did not answer in time", not "is not running".
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeout(ms)), ms);
      // Do not hold the event loop open for a probe nobody is waiting on.
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

/** The migration ledger this BUILD ships — `drizzle/meta/_journal.json`. */
let journalCache: { tags: string[] } | null = null;

export function expectedMigrations(): string[] {
  if (journalCache) return journalCache.tags;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../drizzle/meta/_journal.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    entries?: Array<{ tag?: string }>;
  };
  const tags = (parsed.entries ?? []).map((e) => e.tag ?? "").filter(Boolean);
  if (!tags.length) throw new Error("migration journal is present but names no migrations");
  journalCache = { tags };
  return tags;
}

/**
 * Everything a probe may need, injectable so the report's decision table can be
 * tested without a database, an engine or a network. The defaults are the real
 * clients; a test supplies fakes. There is no branch on environment anywhere in
 * `buildReport` — the only difference between a test run and a live one is what
 * these six functions return.
 */
export interface HealthDeps {
  pingDatabase(): Promise<void>;
  /** Applied count from the ledger, and what this build expects. Throws if it cannot ask. */
  migrations(): Promise<{ applied: number; expected: number; ledgerMissing?: boolean }>;
  kestra(): Promise<{ reachable: boolean; authenticated: boolean; detail?: string }>;
  /**
   * REAL email delivery — email-send-tool T040.
   *
   * ⚠ **Not a probe, and injected anyway.** It reads configuration rather than
   * contacting Microsoft (see the caveat), so it could have read `config.mail`
   * inline — but then `buildReport`'s decision table would depend on the machine's
   * `.env`, and `health.service.test.ts` would pass or fail according to whether
   * the developer running it happens to have Graph configured. Every other
   * component is injected for exactly that reason; this one is no different just
   * because its answer is cheap.
   *
   * Synchronous in nature, `async` in shape, to keep one uniform `HealthDeps`.
   */
  mail(): Promise<{ configured: boolean; enabled: boolean; missing: string[] }>;
}

export const liveDeps: HealthDeps = {
  async pingDatabase() {
    await db.execute(sql`SELECT 1`);
  },

  async migrations() {
    const expected = expectedMigrations().length;
    try {
      const r = await db.execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      const applied = Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
      return { applied, expected };
    } catch (e) {
      // 42P01 = undefined_table. The ledger not existing is not an error we
      // cannot interpret — it is the strongest possible evidence that
      // migrations have never been run against this database.
      // Read through `pgErrorCode`: from drizzle-orm 0.44 the SQLSTATE is on `e.cause`.
      if (pgErrorCode(e) === "42P01") {
        return { applied: 0, expected, ledgerMissing: true };
      }
      throw e;
    }
  },

  kestra: () => kestra.health(),

  // Configuration only. Nothing is dialled — deliberately; see CAVEATS.mail.
  async mail() {
    return {
      configured: config.mail.configured,
      enabled: config.mail.enabled,
      missing: [...config.mail.missing],
    };
  },
};

// ── The decision table ───────────────────────────────────────────────────────

async function timed<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ms: number; value?: T; error?: Error; timedOut: boolean }> {
  const t0 = Date.now();
  try {
    const value = await withDeadline(fn(), timeoutMs);
    return { ms: Date.now() - t0, value, timedOut: false };
  } catch (e) {
    return {
      ms: Date.now() - t0,
      error: e instanceof Error ? e : new Error(String(e)),
      timedOut: e instanceof ProbeTimeout,
    };
  }
}

const CAVEATS: Record<ComponentName, string> = {
  database:
    "One round trip on the parent's own pool. It does not check that any table exists, " +
    "that the pool is not saturated, or that a write would succeed.",
  migrations:
    "Counts rows in the drizzle ledger against the journal this build ships. It proves the " +
    "migrations RAN, not that the schema matches them — a hand-edited column is invisible here.",
  kestra:
    "Reachability and whether the engine accepts our credential. It does NOT prove a flow can " +
    "execute: the Docker task runner, the fragment base image on the host daemon and the " +
    "namespace boundaries are not checked.",
  /**
   * ⚠ **A CONFIG check, not a probe** — and the caveat has to say so, because this
   * is precisely the component where a reader would assume otherwise.
   *
   * It reports whether the four `MAIL_GRAPH_*`/`MAIL_SENDER_UPN` variables are set.
   * It does NOT contact Microsoft, and it deliberately does not: proving delivery
   * means sending a message, and a health endpoint that emails somebody on every
   * poll is worse than an unproven `up`.
   *
   * So `up` here means "configured", never "email works". The two failures it cannot
   * see are the two most likely ones: no tenant admin consent on the `Mail.Send`
   * APPLICATION permission (token succeeds, `sendMail` 403s), and no Exchange
   * application access policy for `MAIL_SENDER_UPN`. The header of this file
   * records the deleted runtime component as the documented example of exactly
   * this mistake — reporting `up` from the mere presence of an endpoint.
   */
  mail:
    "Whether the Graph variables are SET. It does not contact Microsoft, so it cannot see a " +
    "missing admin consent on the Mail.Send application permission or a missing Exchange " +
    "application access policy — the two most likely reasons a fully configured deployment " +
    "still cannot send. `up` here means configured, not working. One real send is what proves it.",
};

function component(
  name: ComponentName,
  critical: boolean,
  status: ComponentStatus,
  latencyMs: number | null,
  detail: string,
): HealthComponent {
  return { name, critical, status, latencyMs, detail: sanitizeDetail(detail), caveat: CAVEATS[name] };
}

export async function buildReport(
  deps: HealthDeps = liveDeps,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HealthReport> {
  const [dbR, migR, kesR, mailR] = await Promise.all([
    timed(() => deps.pingDatabase(), timeoutMs),
    timed(() => deps.migrations(), timeoutMs),
    timed(() => deps.kestra(), timeoutMs),
    timed(() => deps.mail(), timeoutMs),
  ]);

  const components: HealthComponent[] = [];

  // database — critical.
  components.push(
    dbR.error
      ? component(
          "database",
          true,
          "down",
          dbR.ms,
          dbR.timedOut
            ? `the parent database did not answer within ${timeoutMs}ms`
            : `the parent database is unreachable: ${dbR.error.message}`,
        )
      : component("database", true, "up", dbR.ms, "reachable, one round trip"),
  );

  // migrations — critical, and `unknown` when the probe itself could not run.
  if (migR.error) {
    components.push(
      component(
        "migrations",
        true,
        migR.timedOut ? "down" : "unknown",
        migR.ms,
        migR.timedOut
          ? `the migration ledger did not answer within ${timeoutMs}ms`
          : `cannot read the migration state: ${migR.error.message}`,
      ),
    );
  } else {
    const { applied, expected, ledgerMissing } = migR.value!;
    if (ledgerMissing) {
      components.push(
        component(
          "migrations",
          true,
          "down",
          migR.ms,
          `no migration ledger — 0 of ${expected} migrations have ever been applied to this database`,
        ),
      );
    } else if (applied < expected) {
      components.push(
        component(
          "migrations",
          true,
          "down",
          migR.ms,
          `${expected - applied} of ${expected} migrations are not applied — run \`pnpm --filter @foundry/server db:migrate\``,
        ),
      );
    } else if (applied > expected) {
      // Not `down`: the schema is AHEAD, which is a rollback or a mixed-version
      // deploy. The process very likely still serves; saying so and naming the
      // direction is more useful than refusing traffic on a guess.
      components.push(
        component(
          "migrations",
          true,
          "degraded",
          migR.ms,
          `the database has ${applied} migrations applied and this build ships ${expected} — this process is older than the schema`,
        ),
      );
    } else {
      components.push(component("migrations", true, "up", migR.ms, `${applied} of ${expected} applied`));
    }
  }

  // kestra — NOT critical. See this file's header. A deployment with no engine configured (Forge workflows run on
  // flow-runner) has no such component: it is left out, so it can make the deployment neither down nor degraded.
  if (!process.env.KESTRA_BASE_URL?.trim()) {
    // not part of this deployment
  } else if (kesR.error) {
    components.push(
      component(
        "kestra",
        false,
        "down",
        kesR.ms,
        kesR.timedOut
          ? `the engine did not answer within ${timeoutMs}ms`
          : `the engine probe failed: ${kesR.error.message}`,
      ),
    );
  } else {
    const k = kesR.value!;
    components.push(
      k.reachable && k.authenticated
        ? component("kestra", false, "up", kesR.ms, "reachable, and our credential is accepted")
        : k.reachable
          ? component(
              "kestra",
              false,
              "down",
              kesR.ms,
              `the engine answered but REJECTED our credential — flows cannot be deployed or started: ${k.detail ?? ""}`,
            )
          : component(
              "kestra",
              false,
              "down",
              kesR.ms,
              `the engine is unreachable: ${k.detail ?? ""}`,
            ),
    );
  }

  /**
   * mail — NOT critical, and NOT probed (email-send-tool T040).
   *
   * ⚠ `down` when unconfigured, naming every missing variable — the same list the
   * endpoint's `424` gives, from the same `config.mail.missing`, so the health page
   * and the refusal cannot disagree.
   *
   * ⚠ `MAIL_ENABLED=false` is reported as `degraded`, not `down`. A deliberately
   * switched-off capability is not a fault, and reporting it as one trains a reader
   * to ignore the field; but it is not `up` either, because a flow that emails will
   * be refused. There is no probe and therefore no latency — `null`, per
   * `latencyMs`'s own contract ("null if it never ran").
   */
  components.push(
    mailR.error
      ? // Reading config cannot realistically fail, so `unknown` rather than
        // `down`: a broken reader is not evidence that email is misconfigured.
        component("mail", false, "unknown", null, "cannot read the email configuration")
      : !mailR.value!.configured
        ? component(
            "mail",
            false,
            "down",
            null,
            `email delivery is not configured: ${mailR.value!.missing.join(", ")} not set`,
          )
        : !mailR.value!.enabled
          ? component(
              "mail",
              false,
              "degraded",
              null,
              "email delivery is configured but switched off (MAIL_ENABLED=false)",
            )
          : component("mail", false, "up", null, "the Graph variables are set (see caveat)"),
  );

  const criticalDown = components.some((c) => c.critical && c.status === "down");
  const anythingWrong = components.some((c) => c.status !== "up");
  const now = new Date();

  return {
    status: criticalDown ? "down" : anythingWrong ? "degraded" : "ok",
    serves: !criticalDown,
    checkedAt: now.toISOString(),
    ageMs: 0,
    cacheTtlMs: CACHE_TTL_MS,
    probeTimeoutMs: timeoutMs,
    components,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

let cached: { at: number; report: HealthReport } | null = null;
let inFlight: Promise<HealthReport> | null = null;

/**
 * The cached report, with its real age stamped on it.
 *
 * `inFlight` is not an optimisation. Without it, a burst of probes against a
 * cold cache fans out five upstream calls each — a health check that amplifies
 * load is how a wobble becomes an outage.
 */
export async function getHealthReport({ fresh = false } = {}): Promise<HealthReport> {
  const now = Date.now();
  if (!fresh && cached && now - cached.at < CACHE_TTL_MS) {
    return { ...cached.report, ageMs: now - cached.at };
  }
  if (!fresh && inFlight) return inFlight;
  const run = buildReport()
    .then((report) => {
      cached = { at: Date.now(), report };
      return { ...report, ageMs: 0 };
    })
    .finally(() => {
      inFlight = null;
    });
  if (!fresh) inFlight = run;
  return run;
}

/** Tests only — the module-level cache would otherwise leak between cases. */
export function resetHealthCache(): void {
  cached = null;
  inFlight = null;
}
