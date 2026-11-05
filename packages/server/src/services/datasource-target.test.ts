import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { config } from "../config/index.js";
import {
  datasourceTargetService,
  _hostAllowed,
  _addressClass,
  _resetOwnIdentity,
} from "./datasource-target.service.js";

/**
 * The control-plane refusal, proven by PLANTING the credential it must refuse —
 * archive/GAPS.md §1.3.
 *
 * The refusal that matters here is invisible to every check that existed before
 * it, and the test has to be shaped so that fact is what is being asserted:
 *
 *   * The planted role is **`nosuperuser` with no table grants at all**, so
 *     `datasourcePrivilegeService` returns `readOnly: true` for it. D-40 is
 *     satisfied. That is the whole point — a read-only credential on
 *     `foundry_parent` is not a mitigated risk, it is the ideal credential for
 *     reading every workspace's secrets.
 *   * It is registered **by a second address for the same cluster**
 *     (`127.0.0.1` where `DATABASE_URL` says `localhost`, or the reverse), because
 *     a check that compares hostnames passes this and a check that asks the
 *     cluster who it is does not. Without this case the suite cannot tell the two
 *     implementations apart.
 *   * The positive control registers `hr_demo` — **same cluster, same host, same
 *     process** — and must be ALLOWED. Without it, "refuse everything" scores
 *     100%, and refusing everything would break `demo:seed`, `finance:seed` and
 *     the sandbox provisioner on the first run.
 *   * The allowlist is asserted to be the WEAKER half: satisfying it does not
 *     rescue the control plane. If that test ever goes green the other way round,
 *     the allowlist has become the control and §1.3 has quietly reopened.
 */

const PROBE_ROLE = "foundry_target_probe";
const PROBE_PW = "target-probe-not-a-real-credential";
/** The name the wiring test registers under — swept in `afterAll` as well. */
const PROBE_DATASOURCE = "control_plane_probe";
/** The name the sweep's negative control plants under. Also swept in `afterAll`. */
const PLANTED_DATASOURCE = "planted_control_plane_negative_control";

function ownerUrl(): URL {
  return new URL(config.databaseUrl.replace(/^postgres(ql)?:\/\//, "http://"));
}

function dsnFor(host: string, db: string, user = PROBE_ROLE, password = PROBE_PW): string {
  const u = ownerUrl();
  return `postgres://${user}:${encodeURIComponent(password)}@${host}:${u.port || 5432}/${db}`;
}

const OWN_HOST = ownerUrl().hostname;
/**
 * A different spelling of the same cluster. `localhost` and `127.0.0.1` are the
 * pair on a host process; if `DATABASE_URL` already says `127.0.0.1`, swap the
 * other way so the two strings are always genuinely different.
 */
const ALT_HOST = OWN_HOST === "127.0.0.1" ? "localhost" : "127.0.0.1";

const admin = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 4000 });

const reachable = await (async () => {
  try {
    await admin.connect();
    return true;
  } catch (e) {
    console.warn(
      `\n[gaps-1.3] SKIPPING the control-plane refusal tests — ${config.databaseUrl} unreachable ` +
        `(${(e as Error).message}).\n`,
    );
    return false;
  }
})();

/**
 * Drop the probe role, grants and all.
 *
 * A database-level GRANT is a dependency, so a bare `DROP ROLE` fails with
 * *"cannot be dropped because some objects depend on it"* and leaves a login
 * role behind on every run. Database ACLs live in `pg_database`, so the REVOKEs
 * work from this one connection.
 */
/**
 * Every tenant-shaped database on this cluster. All of them must be ALLOWED, and
 * that is the strong form of the positive control: `demo:seed`, `demo:seed-alt`,
 * `finance:seed`, `legal:seed` and `sandbox:provision` all register one of these, so a check
 * that refused any of them would break the regression net on its first run.
 */
// ⚠ A LITERAL for each tenant, not an import from a shared roster. That is the
// same decision as the plan's D-4 for `seed-legal-db.ts`: the tenant list is
// spelled out in three places (here, `seed-finance-db.ts` and `seed-legal-db.ts`)
// and a fourth tenant needs the edit in all three. Consolidating them is a
// worthwhile separate change; doing it as a side effect of adding a dataset is
// how a shared module arrives without anyone arguing for it.
/**
 * ⚠ **EIGHT NOW, AND FOUR WERE MISSING.** `itops_demo` (2026-09-03) and the three
 * generic domains — `support_demo`, `orders_demo`, `hiring_demo` (2026-09-04) —
 * were never added, so the positive control was asserting that FOUR of the eight
 * tenant databases stay registrable while `itops:seed` and `generic:seed` register
 * the other four. A control that covers half its subject reads exactly like one
 * that covers all of it.
 *
 * ⚠ **A database that does not exist on the machine is SKIPPED, not failed** (see
 * the guard at the call site): this deployment has only `hr_demo`, `hr_demo_alt`,
 * `finance_demo` and `legal_demo`, because `itops:seed` and `generic:seed` have
 * never been run here. A hard failure would report an unrun seed as a product
 * defect — and the skip is LOUD, naming the database and the seed that creates it,
 * so it cannot be mistaken for a pass.
 */
const TENANT_DBS = [
  config.demo.dbName,
  config.demo.altDbName,
  "finance_demo",
  "legal_demo",
  "itops_demo",
  "support_demo",
  "orders_demo",
  "hiring_demo",
  // The compiled-builder held-out domain (D-313).
  "fleet_demo",
];
/**
 * A tenant database that is ACTUALLY PRESENT, chosen at runtime.
 *
 * ⚠ **The allowlist tests below used to name `config.demo.dbName` directly, and
 * that broke the moment `hr_demo` was dropped** — `has_database_privilege` and
 * a connection attempt both throw on a database that is not there, so two
 * tests about the host allowlist failed with `database "hr_demo" does not
 * exist`, which reads like a product defect and is not one.
 *
 * Those tests need only *some* benign, non-control database to point at; which
 * one is irrelevant to what they assert. So it is discovered rather than
 * hardcoded, and if the deployment has none the describe skips LOUDLY rather
 * than passing over nothing (I-38).
 */
const presentTenantDb = await (async () => {
  if (!reachable) return null;
  const { rows } = await admin.query<{ datname: string }>(
    "select datname from pg_database where datname = any($1::text[]) order by datname",
    [TENANT_DBS],
  );
  const found = rows[0]?.datname ?? null;
  if (!found) {
    console.warn(
      "\n[gaps-1.3] SKIPPING the host-allowlist tests — no tenant database is present. " +
        "Run `pnpm --filter @foundry/server finance:seed` (or generic:seed) first.\n",
    );
  }
  return found;
})();

/** The three databases that hold Foundry's own state. None may be registrable. */
const CONTROL_DBS = ["kestra", "foundry_ops"];

async function dropProbe() {
  for (const db of [admin.database ?? "foundry_parent", ...TENANT_DBS, ...CONTROL_DBS]) {
    await admin.query(`revoke all on database "${db}" from ${PROBE_ROLE}`).catch(() => {});
  }
  await admin.query(`drop role if exists ${PROBE_ROLE}`);
}

beforeAll(async () => {
  if (!reachable) return;
  await admin.query(`select 1 from pg_roles where rolname = '${PROBE_ROLE}'`).then(async (r) => {
    if (r.rowCount) await dropProbe();
  });
  // Deliberately harmless: LOGIN, CONNECT on two databases, and nothing else.
  // No SELECT, no INSERT, no CREATE — a credential D-40 is perfectly happy with.
  await admin.query(`create role ${PROBE_ROLE} login password '${PROBE_PW}' nosuperuser`);
  for (const db of [admin.database ?? "foundry_parent", ...TENANT_DBS, ...CONTROL_DBS]) {
    // A database that does not exist on this cluster simply has no case below.
    await admin.query(`grant connect on database "${db}" to ${PROBE_ROLE}`).catch(() => {});
  }
});

afterAll(async () => {
  if (!reachable) return;
  try {
    // Belt and braces: if the wiring test's own `finally` never ran (a crash, an
    // interrupt), the row must still not survive the suite.
    for (const name of [PROBE_DATASOURCE, PLANTED_DATASOURCE]) {
      await admin.query(`delete from datasources where name = '${name}'`).catch(() => {});
    }
    await dropProbe();
  } finally {
    await admin.end().catch(() => {});
  }
});

/** Swap the deployment allowlist for one assertion and always put it back. */
function withAllowlist<T>(list: string[] | null, fn: () => T): T {
  const c = config as { datasourceHostAllowlist: string[] | null };
  const before = c.datasourceHostAllowlist;
  c.datasourceHostAllowlist = list;
  try {
    return fn();
  } finally {
    c.datasourceHostAllowlist = before;
  }
}

describe.skipIf(!reachable)("the control-plane refusal (archive/GAPS.md §1.3)", () => {
  const parentDb = () => new URL(config.databaseUrl.replace(/^postgres(ql)?:\/\//, "http://")).pathname.slice(1);

  it("REFUSES Foundry's own database, for a credential D-40 would pass", async () => {
    _resetOwnIdentity();
    const v = await datasourceTargetService.verify(
      "postgres",
      dsnFor(OWN_HOST, parentDb()),
      dsnFor(OWN_HOST, parentDb()),
    );
    expect(v.allowed).toBe(false);
    // Both arms should recognise it: the exact identity and the schema signature.
    const rules = v.findings.map((f) => f.rule);
    expect(rules).toContain("control_plane_identity");
    expect(rules).toContain("control_plane_signature:foundry_parent");
  });

  it("still refuses it when the connection string spells the host differently", async () => {
    // The discriminating case. A hostname denylist passes this.
    _resetOwnIdentity();
    const v = await datasourceTargetService.verify(
      "postgres",
      dsnFor(ALT_HOST, parentDb()),
      dsnFor(ALT_HOST, parentDb()),
    );
    expect(v.allowed).toBe(false);
    expect(v.checked.host).toBe(ALT_HOST);
    expect(v.checked.host).not.toBe(OWN_HOST);
    expect(v.findings.map((f) => f.rule)).toContain("control_plane_identity");
    // And the identity arm genuinely ran — a null cluster id would mean the
    // assertion above passed on the signature alone.
    expect(v.checked.clusterId).not.toBeNull();
    expect(v.checked.clusterId).toBe(v.checked.ownClusterId);
  });

  it.each(TENANT_DBS)("ALLOWS %s — the positive control, on the very same cluster", async (db) => {
    _resetOwnIdentity();
    let v;
    try {
      v = await datasourceTargetService.verify("postgres", dsnFor(OWN_HOST, db), dsnFor(OWN_HOST, db));
    } catch (e) {
      /**
       * ⚠ **A SKIP THAT NAMES ITS OWN FIX.** Four of the eight tenant databases
       * are absent on a deployment where `itops:seed`/`generic:seed` have not
       * been run, and an unrun seed is not a product defect. The message names
       * the command so the gap cannot be mistaken for coverage.
       */
      const SEED: Record<string, string> = {
        hr_demo: "demo:seed",
        hr_demo_alt: "demo:seed-alt",
        finance_demo: "finance:seed",
        legal_demo: "legal:seed",
        itops_demo: "itops:seed",
        support_demo: "generic:seed",
        orders_demo: "generic:seed",
        hiring_demo: "generic:seed",
        fleet_demo: "heldout:seed",
      };
      console.warn(
        `[gaps-1.3] SKIPPING ${db} — not present on this cluster. Run ` +
          `\`pnpm --filter @foundry/server ${SEED[db] ?? "<its seed>"}\` to exercise this ` +
          `control (${(e as Error).message})`,
      );
      return;
    }
    expect(v.findings).toEqual([]);
    expect(v.allowed).toBe(true);
    // Same cluster, and that is fine: the databases share one instance here, so
    // a cluster-level refusal would take the whole demo with it.
    expect(v.checked.clusterId).toBe(v.checked.ownClusterId);
    expect(v.checked.database).toBe(db);
    expect(v.checked.relations).toBeGreaterThan(0);
  });

  it.each(CONTROL_DBS)(
    "refuses %s by SIGNATURE, where the identity check cannot fire",
    async (db) => {
      _resetOwnIdentity();
      let v;
      try {
        v = await datasourceTargetService.verify("postgres", dsnFor(OWN_HOST, db), dsnFor(OWN_HOST, db));
      } catch (e) {
        console.warn(`[gaps-1.3] no \`${db}\` on this cluster (${(e as Error).message})`);
        return;
      }
      expect(v.allowed).toBe(false);
      // A different database name, so the identity arm is silent by construction
      // and this is the signature arm carrying the refusal on its own.
      expect(v.findings).toHaveLength(1);
      expect(v.findings[0]!.rule).toMatch(/^control_plane_signature:/);
    },
  );
});

describe.skipIf(!reachable || !presentTenantDb)("the host allowlist is the weaker half, and is treated as one", () => {
  const parentDb = () => new URL(config.databaseUrl.replace(/^postgres(ql)?:\/\//, "http://")).pathname.slice(1);

  it("records `null` when the deployment has not set one, rather than passing silently", async () => {
    _resetOwnIdentity();
    const v = await withAllowlist(null, () =>
      datasourceTargetService.verify(
        "postgres",
        dsnFor(OWN_HOST, presentTenantDb!),
        dsnFor(OWN_HOST, presentTenantDb!),
      ),
    );
    expect(v.checked.hostAllowlist).toBeNull();
    expect(v.allowed).toBe(true);
  });

  it("refuses a host outside it", async () => {
    _resetOwnIdentity();
    const v = await withAllowlist(["db.example.com"], () =>
      datasourceTargetService.verify(
        "postgres",
        dsnFor(OWN_HOST, presentTenantDb!),
        dsnFor(OWN_HOST, presentTenantDb!),
      ),
    );
    expect(v.allowed).toBe(false);
    expect(v.findings.map((f) => f.rule)).toEqual(["host_not_allowlisted"]);
  });

  it("⚠ satisfying it does NOT rescue the control plane", async () => {
    // If this ever passes, the allowlist has become the control and §1.3 is open
    // again — an operator who allowlists their own database host has, on that
    // reading, permitted Foundry's own database along with it.
    _resetOwnIdentity();
    const v = await withAllowlist([OWN_HOST], () =>
      datasourceTargetService.verify("postgres", dsnFor(OWN_HOST, parentDb()), dsnFor(OWN_HOST, parentDb())),
    );
    expect(v.allowed).toBe(false);
    expect(v.findings.map((f) => f.rule)).not.toContain("host_not_allowlisted");
    expect(v.findings.map((f) => f.rule)).toContain("control_plane_identity");
  });
});

describe.skipIf(!reachable)("the gate is WIRED INTO registration, not merely correct", () => {
  /**
   * The check above can be flawless and never called. `datasourceService.create`
   * is the one path every registration takes — routes, seeds and provisioners
   * alike — so this asserts the refusal arrives as a 400 from there rather than
   * as a passing unit test beside an ungated route. Proven by removing the call:
   * this is the only test that goes red.
   *
   * ⚠ **It cleans up after itself, and the reason is not tidiness.** When the
   * call was removed to prove the test fires, the create SUCCEEDED — leaving a
   * live datasource pointed at `foundry_parent`, past the D-40 gate, which
   * `sandbox:status` then listed beside the real ones. That is the gap itself,
   * demonstrated in one command; a test that can plant it must also remove it,
   * or the next person to perturb this leaves one behind and does not know.
   */
  it("refuses a control-plane DSN through datasourceService.create, with a 400", async () => {
    const { datasourceService } = await import("./datasource.service.js");
    const { workspaceRepo } = await import("../repositories/workspace.repo.js");
    const ws = (await workspaceRepo.list())[0];
    if (!ws) {
      console.warn("[gaps-1.3] no workspace on this deployment — the wiring test needs one");
      return;
    }
    _resetOwnIdentity();
    const parentDb = new URL(config.databaseUrl.replace(/^postgres(ql)?:\/\//, "http://")).pathname.slice(1);
    try {
      await expect(
        datasourceService.create(ws.id, {
          name: PROBE_DATASOURCE,
          type: "postgres",
          connectionString: dsnFor(OWN_HOST, parentDb),
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/not registrable as a tenant datasource/),
      });
    } finally {
      await admin.query(`delete from datasources where name = '${PROBE_DATASOURCE}'`).catch(() => {});
    }
  });
});

describe.skipIf(!reachable)("no datasource ALREADY registered points at Foundry's own state", () => {
  /**
   * The gate refuses new registrations. It says nothing about rows that predate
   * it — and `datasourceService.update` only re-checks a row when somebody edits
   * it. So this sweeps what is actually stored.
   *
   * ⚠ It exists because of I-64: a perturbation planted a live control-plane
   * datasource and the *suite* did not notice — `sandbox:status`, run for an
   * unrelated reason, did. A residue nothing asserts against is a residue that
   * survives.
   *
   * ⚠ **A stored DSN is container-facing** (`host.docker.internal:5433`) and this
   * suite is a HOST process, where that name does not resolve on Linux — I-36,
   * the same asymmetry `verifyVia` exists for. The first version of this sweep
   * reported all four datasources "unreachable" and passed, which is a control
   * that cannot fail. So an unreachable DSN is retried at the LOCAL cluster
   * address with the same credential, and the retry is **named in the output**:
   * it moves the host, which is the one field a same-credential rewrite is
   * allowed to move, and a reader has to be able to see that it happened.
   *
   * A datasource unreachable both ways is REPORTED and skipped, never counted as
   * clean — "could not check" and "checked and fine" are different states.
   */
  /** The sweep itself, so the negative control below runs the SAME code. */
  async function sweep() {
    const { db } = await import("../db/index.js");
    const { datasources } = await import("../db/schema.js");
    const { decrypt } = await import("../utils/encryptor.js");

    // EVERY stored row, a soft-deleted workspace's included: its credential is still stored, and the question is what
    // a stored credential points at. (Live workspaces only, it examined nothing once the demo workspaces were deleted
    // and recreated without Postgres datasources — and refused, rightly, to call nothing clean.)
    const rows = await db.select().from(datasources);

    _resetOwnIdentity();
    const offenders: string[] = [];
    const unchecked: string[] = [];
    let direct = 0;
    let viaLocal = 0;
    for (const d of rows) {
      if (!datasourceTargetService.supports(d.type)) continue;
      // ⚠ A row that will not decrypt is UNCHECKED, never skipped silently and
      // never fatal to the sweep.
      //
      // Found by running the full suite rather than this file alone:
      // `flow-portability.test.ts` plants `connectionStringEnc: "not-a-real-dsn"`
      // as a fixture, and this threw — so the sweep's verdict depended on which
      // suites had run first, which is the flake that gets a suite retried
      // rather than read. It is not only a test artefact: a key rotation or a
      // corrupt row produces exactly this in production, and the honest answer
      // there is "this one could not be examined", not a crash and not a pass.
      let dsn: string;
      try {
        // Mock-only rows carry no credential to examine — recorded, not skipped.
        if (!d.connectionStringEnc) {
          unchecked.push(`${d.name} (no production credential attached — mock-only row)`);
          continue;
        }
        dsn = decrypt(d.connectionStringEnc);
      } catch (e) {
        unchecked.push(`${d.name} (ciphertext unreadable: ${(e as Error).message})`);
        continue;
      }
      let v;
      try {
        v = await datasourceTargetService.verify(d.type, dsn, dsn);
        direct++;
      } catch {
        try {
          const alt = dsn.replace(/@[^/]+\//, `@${ownerUrl().host}/`);
          v = await datasourceTargetService.verify(d.type, dsn, alt);
          viaLocal++;
        } catch (e2) {
          unchecked.push(`${d.name} (${(e2 as Error).message})`);
          continue;
        }
      }
      // The host allowlist is a deployment policy that may have changed since a
      // row was written; only the control-plane arms are a violation here.
      const control = v.findings.filter((f) => f.rule.startsWith("control_plane"));
      if (control.length) offenders.push(`${d.name}: ${control.map((f) => f.rule).join(", ")}`);
    }
    return { offenders, unchecked, examined: direct + viaLocal, direct, viaLocal };
  }

  it("sweeps every stored datasource", async () => {
    const r = await sweep();
    console.warn(
      `[gaps-1.3] swept ${r.examined} datasource(s) — ${r.direct} at the stored address, ` +
        `${r.viaLocal} re-dialled at ${ownerUrl().host}` +
        (r.unchecked.length ? ` · NOT CHECKED: ${r.unchecked.join(" · ")}` : ""),
    );
    // A sweep that examined nothing must not report clean.
    expect(r.examined, "the sweep reached no datasource at all").toBeGreaterThan(0);
    expect(r.offenders, `registered datasources pointing at Foundry's own state`).toEqual([]);
  });

  /**
   * ⚠ **The negative control, and it must stay last and stay present.**
   *
   * `backup-verify.sh`'s rule, for the same reason: a sweep over rows that are
   * all fine reports clean whether or not it works, and it would go on reporting
   * clean for ever. So one is planted — through `datasourceRepo` directly,
   * BYPASSING the gate, because that is what a row predating the gate looks
   * like — and the sweep is required to notice it.
   *
   * It reports INCONCLUSIVE and **fails** if the plant could not happen, rather
   * than passing on a perturbation that never occurred (I-38).
   */
  it("NEGATIVE CONTROL — a planted control-plane row is caught by that same sweep", async () => {
    const { datasourceRepo } = await import("../repositories/datasource.repo.js");
    const { encrypt } = await import("../utils/encryptor.js");
    const { db } = await import("../db/index.js");
    const { workspaces } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");

    /**
     * ⚠ **Its OWN workspace, not `workspaceRepo.list()[0]`.**
     *
     * Five other test files create and delete workspaces, and vitest runs test
     * FILES in parallel against one database — so the workspace read here could
     * be deleted before the insert below, and this control died with a
     * foreign-key error instead of returning a verdict. Observed twice on
     * 2026-08-07, once as a 5 s timeout and once as the FK violation.
     *
     * ⚠ That matters more than an ordinary flake: this is the NEGATIVE CONTROL,
     * and a control that fails for an unrelated reason is indistinguishable
     * from one reporting a real finding. Borrowing another test's fixture made
     * the one assertion that proves the sweep works the least reliable in the
     * file.
     */
    const stamp = Date.now();
    const [ws] = await db
      .insert(workspaces)
      .values({
        name: `ds-target-control-${stamp}`,
        slug: `dtc-${stamp}`,
        tenantSlug: "e2etest",
        description: "gaps-1.3 negative control; safe to delete",
      })
      .returning();
    expect(ws, "INCONCLUSIVE: could not create a workspace to plant into").toBeTruthy();

    let plantedId: string | undefined;
    try {
      const planted = await datasourceRepo.create({
        workspaceId: ws!.id,
        name: PLANTED_DATASOURCE,
        type: "postgres",
        connectionStringEnc: encrypt(config.databaseUrl),
        secretEnvName: null,
        schemaAllowlist: ["public"],
        testStatus: null,
      });
      plantedId = planted.id;
      expect(plantedId, "INCONCLUSIVE: the row was not planted").toBeTruthy();

      const r = await sweep();
      expect(
        r.offenders.join(" · "),
        "the sweep did not notice a datasource pointed at foundry_parent",
      ).toContain(PLANTED_DATASOURCE);
    } finally {
      await admin.query(`delete from datasources where name = '${PLANTED_DATASOURCE}'`).catch(() => {});
      // The workspace goes too — it exists only to hold the planted row, and a
      // fixture left behind would show up in `/organization` as a real tenant.
      await db.delete(workspaces).where(eq(workspaces.id, ws!.id)).catch(() => {});
    }

    // And the deployment is left as it was found.
    const after = await sweep();
    expect(after.offenders).toEqual([]);
  });
});

describe("suffix matching does not permit a lookalike host", () => {
  it("`.example.com` matches under it, and the bare form matches only itself", () => {
    // The classic: `"evildb.example.com".endsWith("example.com")` is true, which
    // is why an entry only acts as a suffix when it starts with a dot.
    expect(_hostAllowed("db.example.com", [".example.com"])).toBe(true);
    expect(_hostAllowed("example.com", [".example.com"])).toBe(true);
    expect(_hostAllowed("evildb.example.com", ["example.com"])).toBe(false);
    expect(_hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(_hostAllowed("EXAMPLE.COM", ["example.com"])).toBe(true);
    expect(_hostAllowed("example.com.attacker.test", [".example.com"])).toBe(false);
    expect(_hostAllowed("anything", [])).toBe(false);
  });
});

// ── §1.3b — addresses nothing legitimate lives on (D-72) ─────────────────────

describe("an address that is never a database", () => {
  it("classifies the cloud metadata endpoint and the rest of link-local", () => {
    // 169.254.169.254 is the metadata endpoint on AWS, GCP, Azure and
    // DigitalOcean. It is not a database, and reaching it is how a
    // credential-theft chain starts.
    expect(_addressClass("169.254.169.254")).toMatch(/link-local/);
    expect(_addressClass("169.254.1.1")).toMatch(/link-local/);
    expect(_addressClass("fe80::1")).toMatch(/IPv6 link-local/);
    expect(_addressClass("::ffff:169.254.169.254")).toMatch(/IPv6 link-local/);
  });

  it("classifies unspecified, broadcast and multicast", () => {
    expect(_addressClass("0.0.0.0")).toBeTruthy();
    expect(_addressClass("255.255.255.255")).toBeTruthy();
    expect(_addressClass("224.0.0.1")).toMatch(/multicast/);
  });

  it("⚠ does NOT classify private ranges or loopback — the positive control", () => {
    // This is the arm that keeps the control usable. Every demo datasource in
    // this repo points at `host.docker.internal:5433` or `localhost:5433`, and
    // every host-run harness dials loopback. Refusing these would break
    // `demo:seed` and `finance:seed` on day one — I-36 is the record of the last
    // time a datasource check did exactly that, and it broke `pnpm demo:seed`
    // outright for two programmes.
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "172.17.0.2", "192.168.1.10", "8.8.8.8"]) {
      expect(_addressClass(ip), ip).toBeNull();
    }
  });

  it("refuses a literal metadata IP through the real verify(), before dialling", async () => {
    // ⚠ The ordering is the property: nothing may connect to the address being
    // refused. If this returned a `database` name it would mean Foundry had
    // already made the request this exists to prevent.
    const v = await datasourceTargetService.verify(
      "postgres",
      "postgres://u:p@169.254.169.254:5432/anything",
      "postgres://u:p@169.254.169.254:5432/anything",
    );
    expect(v.allowed).toBe(false);
    expect(v.findings[0]!.rule).toBe("address_never_a_database");
    expect(v.checked.database).toBeNull();
    expect(v.checked.relations).toBe(0);
  });

  it("⚠ a HOST ALLOWLIST cannot rescue it", async () => {
    // Same shape as the control-plane test above: the allowlist is the weaker
    // half and must never be able to permit something the strong half refuses.
    const before = config.datasourceHostAllowlist;
    (config as { datasourceHostAllowlist: string[] | null }).datasourceHostAllowlist = [
      "169.254.169.254",
    ];
    try {
      const v = await datasourceTargetService.verify(
        "postgres",
        "postgres://u:p@169.254.169.254:5432/x",
        "postgres://u:p@169.254.169.254:5432/x",
      );
      expect(v.allowed).toBe(false);
      expect(v.findings.some((f) => f.rule === "address_never_a_database")).toBe(true);
    } finally {
      (config as { datasourceHostAllowlist: string[] | null }).datasourceHostAllowlist = before;
    }
  });
});
