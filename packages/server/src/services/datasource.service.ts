import { z } from "zod";
import { datasourceRepo, type Datasource } from "../repositories/datasource.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { encrypt, decrypt } from "../utils/encryptor.js";
import { schemaIntrospectorService } from "./schema-introspector.service.js";
import { datasourcePrivilegeService, type PrivilegeFinding } from "./datasource-privilege.service.js";
import { datasourceTargetService, type TargetFinding } from "./datasource-target.service.js";
import { RESOURCE_STATUSES, RESOURCE_HEALTHS, RESOURCE_CATEGORIES } from "../db/schema.js";
import { provisionIfAbsent } from "./sandbox-autoprovision.service.js";
import { datasourceFixtureRepo } from "../repositories/datasource-fixture.repo.js";
import { ACCESS_POLICIES, DEFAULT_ACCESS_POLICY } from "./datasource-access-policy.js";
import { rebuildMockDataset, requestMockBuild } from "./mock-dataset.service.js";
import { DATASOURCE_NAME_RE } from "@foundry/shared";
import { dsnFor, fileIdOf, isSqliteType, sqliteFileService, SQLITE_SCHEMA } from "./sqlite-file.service.js";
/**
 * A datasource name has to be a plain identifier, and this is not house style.
 *
 * A `datasource` step's ref is `<datasource>.<query>` and `runNamedQuery` splits
 * it at the FIRST dot. A datasource called `a.b` therefore hosts queries whose
 * refs (`a.b.c`) resolve as datasource `a`, query `b.c` — which does not exist —
 * so every such step 404s at execution time, i.e. after approval, mid-run.
 *
 * It is also a collision: `refFingerprints()` keys one flat map on the
 * concatenation, so `a.b` + `c` and `a` + `b.c` produce the same entry, and two
 * different refs then share one fingerprint. Tool names have carried this exact
 * regex since Phase 0, which is why a tool can never collide with a query ref;
 * datasources were the half that was missed. Named queries became authorable
 * over HTTP in Stage 2, which is what made it reachable.
 *
 * Safe to tighten: no existing row violates it (checked against the live
 * database — `hr_demo` and `hr_demo_alt`), and `updateDatasourceSchema` applies
 * it too, so a rename cannot reintroduce the shape.
 */
// ⚠ ONE definition, in `@foundry/shared` since 2026-09-17, so the onboarding
// form can state this rule beside the box instead of the person meeting it as
// a 400. The enforcement is still here; only the definition moved.
const DATASOURCE_NAME = DATASOURCE_NAME_RE;
const DATASOURCE_NAME_MSG =
  "name must be a plain identifier — a step ref is \"<datasource>.<query>\" split at the first " +
  "dot, so a dot here makes every query on this datasource unresolvable at execution time";

export const createDatasourceSchema = z.object({
  name: z.string().min(1).max(255).regex(DATASOURCE_NAME, DATASOURCE_NAME_MSG),
  type: z.string().min(1).max(50), // postgres, mysql, ...
  // Optional: a mock-only-until-linked row is legal — onboarding builds the
  // deterministic mock from a later introspection, and the credential gates
  // below are skipped until one is stored.
  connectionString: z.string().min(1).max(8192).optional(),
  secretEnvName: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "secretEnvName must be an env-var identifier")
    .max(255)
    .optional()
    .nullable(),
});
/**
 * WS-C.1 — a schema allowlist. Identifiers are validated rather than escaped
 * because they are interpolated into introspection queries as a parameterised
 * array; an unquotable name should fail here, not there.
 */
export const schemaAllowlistSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(63)
      .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, "schema names must be plain identifiers"),
  )
  .min(1)
  .max(20);

export const updateDatasourceSchema = z.object({
  name: z.string().min(1).max(255).regex(DATASOURCE_NAME, DATASOURCE_NAME_MSG).optional(),
  connectionString: z.string().min(1).max(8192).optional(),
  // Nullable so a credential attach can be detached (null clears it).
  secretEnvName: z.string().max(255).optional().nullable(),
  // WS-C.1 — Postgres schemas / MySQL databases to introspect.
  schemaAllowlist: schemaAllowlistSchema.optional(),
  /**
   * P5-I11: the owner's column declarations, `[schema.]table.column` → tag. Saving one re-reads the schema and refuses a
   * declaration that cannot be honoured, so what is stored is always applicable.
   */
  columnTags: z.record(z.string().min(1).max(512), z.string().min(1).max(32)).refine((r) => Object.keys(r).length <= 500, "at most 500 column tags").optional(),
  // B-13 widened fields — all nullable, typed verbatim per S-48
  /**
   * ⚠ **NULLABLE, and `null` is what RESUMING a paused datasource sends.**
   * Pausing writes `"paused"` (see `datasource-model-visibility.ts`), and the
   * only honest way back is to clear the column: the row's status before the
   * pause was whatever `statusFromLegacy` derives from its connection, and
   * writing a concrete value on resume would invent a lifecycle state nobody
   * chose — `"published"` on a source that has never connected, say. Without
   * this, pause is a one-way door.
   */
  resourceStatus: z.enum(RESOURCE_STATUSES).nullable().optional(),
  ownerSubject: z.string().max(512).optional().nullable(),
  ownerName: z.string().max(255).optional().nullable(),
  ownerAvatarUrl: z.string().max(2048).optional().nullable(),
  health: z.enum(RESOURCE_HEALTHS).optional().nullable(),
  healthNote: z.string().max(1024).optional().nullable(),
  resourceCategory: z.enum(RESOURCE_CATEGORIES).optional(),
  /** A sqlite datasource's replacement file — an id from the upload route, never a path. */
  sqliteFileId: z.string().uuid().optional(),
  // has_mock_data is server-derived from the fixtures readiness (mock_status),
  // never client-writable — accepted here it would let a PATCH claim a mock
  // exists that was never built.
});
/** WS-C.1: create accepts the allowlist too, so a named-schema datasource does
 *  not need a second PATCH before its first introspection. */
export const createDatasourceInputSchema = createDatasourceSchema.extend({
  schemaAllowlist: schemaAllowlistSchema.optional(),
  /**
   * What this datasource is ALLOWED to do. Omitted ⇒ `read`.
   *
   * ⚠ **The default is the narrowest, and it has to be.** A caller that does
   * not mention the policy — every existing client, every seed, every harness —
   * gets read-only, which is what all of them were before this field existed.
   * Defaulting to anything wider would silently widen the entire deployment on
   * the day this shipped.
   *
   * ⚠ **This one IS on the schema, unlike `verifyVia`, and the difference is
   * the direction it moves.** `verifyVia` is a way PAST a gate, so putting it on
   * the schema would let a caller switch the gate off from outside (D-44).
   * `accessPolicy` chooses which gate applies and the narrowest is the default,
   * so the worst a caller can do by lying is give themselves LESS. Widening is
   * still a deliberate act recorded on the row.
   */
  accessPolicy: z.enum(ACCESS_POLICIES).optional(),
  /**
   * For `type: "sqlite"`: the uploaded file this datasource reads, from
   * `POST …/datasources/sqlite-files`. The server builds the DSN from it — a
   * caller never supplies a sqlite connection string it could point elsewhere.
   */
  sqliteFileId: z.string().uuid().optional(),
});

function toPublic(d: Datasource, hasMockData: boolean) {
  const raw = d as unknown as Record<string, unknown>;
  // Derive category server-side verbatim as resourceService does
  const rawCat = raw.resourceCategory as string | null;
  const derivedCategory =
    rawCat === "datasource" || rawCat === "connector" || rawCat === "tool"
      ? rawCat
      : (() => {
          const id = (d.type ?? "").toLowerCase();
          if (id.includes("email") || id.includes("rest") || id.includes("slack") || id.includes("connector"))
            return "connector";
          if (id === "tool" || id.includes("tool") || id.includes("app")) return "tool";
          return "datasource";
        })();
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    name: d.name,
    type: d.type,
    // connection string is NEVER returned
    secretEnvName: d.secretEnvName,
    schemaAllowlist: d.schemaAllowlist ?? ["public"],
    columnTags: d.columnTags ?? {},
    testStatus: d.testStatus,
    lastTestedAt: d.lastTestedAt,
    supported: schemaIntrospectorService.supports(d.type),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    // B-13 widened fields — keep typed, nullable for back-compat reads
    resourceStatus: (raw.resourceStatus as string | null) ?? null,
    resourceCategory: derivedCategory,
    resourceType: (() => {
      const id = (d.type ?? "").toLowerCase();
      if (id.includes("postgres")) return "PostgreSQL";
      if (id === "mysql" || id.includes("mysql")) return "MySQL";
      if (id === "sqlite") return "SQLite";
      if (id.includes("s3") || id.includes("amazon")) return "Amazon S3";
      if (id.includes("sftp") || id === "ftp" || id.includes("ftp")) return "SFTP";
      if (id.includes("oracle")) return "Oracle";
      if (id.includes("mongo")) return "MongoDB";
      if (id.includes("email")) return "Email connector";
      if (id.includes("rest")) return "REST connector";
      if (id.includes("slack")) return "Slack";
      if (id.includes("tool")) return "Tool";
      return d.type || "—";
    })(),
    ownerSubject: (raw.ownerSubject as string | null) ?? null,
    ownerName: (raw.ownerName as string | null) ?? null,
    ownerAvatarUrl: (raw.ownerAvatarUrl as string | null) ?? null,
    health: (raw.health as string | null) ?? null,
    healthNote: (raw.healthNote as string | null) ?? null,
    hasMockData,
  };
}

/**
 * Refuse a credential that can write — Stage 9.2.
 *
 * ── Why this is a gate and not a warning ─────────────────────────────────────
 *
 * The whole reason `hr_demo` is a separate database is the credential boundary:
 * *"the DSN handed to generated scripts must be unable to reach the parent DB at
 * all, so a script cannot satisfy 'send the email' with an `INSERT INTO
 * mail_outbox`."* That boundary was enforced for the demo by
 * `demo/hr-roles.ts` and for a customer by nothing.
 *
 * ── Refusing to store an unverifiable credential is deliberate ───────────────
 *
 * If the database cannot be reached, this refuses rather than storing and
 * checking later. "Register now, verify when it comes back" means the row that
 * exists is the unverified one, and the check that would have caught it runs at
 * a moment nobody is watching.
 *
 * ⚠ **Only `postgres` and `mysql` are gated, and that is the whole write path
 * rather than a gap.** `schemaIntrospectorService.supports()` covers exactly
 * those two, so only they can be introspected, only they can host a named query,
 * and only a named query is reachable from a `datasource` step. A registered
 * datasource of any other type is inert — it cannot be called. Add the check
 * WITH the introspector if a third type is ever supported.
 */
/**
 * The DSN to CONNECT WITH when the caller cannot reach the one being stored.
 *
 * ── The problem, which is the same one `OPS_ADMIN_BASE` exists for ───────────
 *
 * A stored DSN has to resolve for whoever later *reads* it — the API container,
 * which reaches the demo databases at `host.docker.internal:5433`. This check
 * runs in whoever is *registering* it, and for every `demo:*` provisioner that
 * is a HOST process, where `host.docker.internal` does not resolve on Linux.
 * The result was a 400 saying the credential could not be verified, on a
 * credential that is verifiably read-only: `pnpm demo:seed` failed outright on a
 * Linux host from the moment this gate landed.
 *
 * ── Why this cannot weaken the gate ──────────────────────────────────────────
 *
 * Verifying credential A and storing credential B would be the obvious hole, so
 * the two are required to differ in HOST AND PORT ONLY. Username, password,
 * database and every connection parameter must match. Postgres and MySQL
 * privileges are properties of (role, database) and not of the hostname used to
 * reach them, so under that constraint the verdict on one is the verdict on the
 * other — while "point the check at a harmless database" is refused by name.
 *
 * ⚠ It is a FUNCTION ARGUMENT and deliberately not a field on
 * `createDatasourceSchema`. `routes/datasources.ts` passes the zod-parsed body
 * and nothing else, so no HTTP caller can reach this. Never add it to the
 * schema.
 */
function assertSameCredential(stored: string, verifyVia: string) {
  let a: URL;
  let b: URL;
  try {
    a = new URL(stored);
    b = new URL(verifyVia);
  } catch {
    throw new Error("verifyVia: both connection strings must be parseable URLs");
  }
  const differs: string[] = [];
  if (a.protocol !== b.protocol) differs.push("scheme");
  if (a.username !== b.username) differs.push("user");
  if (a.password !== b.password) differs.push("password");
  if (a.pathname !== b.pathname) differs.push("database");
  if (a.search !== b.search) differs.push("parameters");
  if (differs.length > 0) {
    throw new Error(
      `verifyVia may differ from the stored connection string in host and port only, but ` +
        `it also differs in: ${differs.join(", ")}. Verifying one credential and storing ` +
        `another is exactly what this gate exists to prevent.`,
    );
  }
}

/**
 * Refuse a credential pointed at Foundry's own state — archive/GAPS.md §1.3.
 *
 * Runs BEFORE `assertReadOnly` and that order is deliberate: a read-only
 * credential on `foundry_parent` passes the D-40 gate with zero findings, so
 * running the privilege check first would produce a clean verdict on the one
 * target that must never be stored. The reasoning, the measurements and what
 * this deliberately does not cover are in `datasource-target.service.ts`.
 */
async function assertRegistrableTarget(
  type: string,
  dsn: string,
  verifyVia?: string,
) {
  if (!datasourceTargetService.supports(type)) return;

  let target = dsn;
  if (verifyVia && verifyVia !== dsn) {
    assertSameCredential(dsn, verifyVia);
    target = verifyVia;
  }

  let verdict;
  try {
    verdict = await datasourceTargetService.verify(type, dsn, target);
  } catch (e) {
    // Unreachable ⇒ refuse, for the same reason D-40 does: "register now, verify
    // when it comes back" leaves the unverified row as the one that exists.
    const err = new Error(
      `could not reach this database to check what it is: ${(e as Error).message}. ` +
        `The datasource was not saved.`,
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  if (verdict.allowed) return;

  const err = new Error(
    `this connection string is not registrable as a tenant datasource. ` +
      verdict.findings.map((f) => f.message).join(" · "),
  ) as Error & { statusCode?: number; findings?: TargetFinding[] };
  err.statusCode = 400;
  err.findings = verdict.findings;
  throw err;
}

/**
 * What this credential can do — **recorded, no longer refused** (2026-09-17).
 *
 * ── ⚠ THE REFUSAL THIS REPLACES, AND WHY IT WENT ────────────────────────────
 *
 * This function used to end by throwing *"this credential can write to the
 * database, and Foundry only registers read-only ones"*. That gate was right
 * about the danger and wrong about who it stopped: a tenant whose only
 * credential is an administrator — an Azure `*_admin` account, say — could not
 * onboard at all, and the remedy on offer was "create a read-only role on the
 * database", which plenty of people have no rights to do. A control a whole
 * class of users must route around is one they route around.
 *
 * ⚠ **The protection did not weaken; it MOVED, and moved somewhere stronger.**
 * `datasources.access_policy` says what the datasource may do, and a `read`
 * datasource runs every statement inside `BEGIN READ ONLY`, where **Postgres
 * refuses the write itself** regardless of the role's grants — including a
 * superuser. The old gate asked the credential to be narrow; the new one stops
 * the statement. See `datasource-access-policy.ts`.
 *
 * ⚠ **An UNVERIFIABLE credential is still a refusal, and that is unchanged.**
 * "Register now, verify when the database comes back" means the row that exists
 * is the unverified one, and the check that would have caught it runs at a
 * moment nobody is watching. A credential we could not probe is not the same as
 * one we probed and found wide.
 *
 * ⚠ **`assertRegistrableTarget` is UNTOUCHED and must stay that way.** That is
 * D-64 — refusing a DSN that points at Foundry's own control plane — and it is
 * a different question from what a credential may do. A read-only credential on
 * `foundry_parent` passed the old privilege gate with zero findings, and it is
 * exactly the credential that can read every workspace's secrets.
 *
 * Returns `null` when the type cannot be probed, which is not the same as
 * `false` and is stored as NULL rather than as "cannot write".
 */
async function measureCredential(
  type: string,
  dsn: string,
  schemas: string[],
  verifyVia?: string,
): Promise<{ canWrite: boolean; findings: PrivilegeFinding[] } | null> {
  if (!datasourcePrivilegeService.supports(type)) return null;

  let target = dsn;
  if (verifyVia && verifyVia !== dsn) {
    assertSameCredential(dsn, verifyVia);
    target = verifyVia;
  }

  let verdict;
  try {
    verdict = await datasourcePrivilegeService.verify(type, target, schemas);
  } catch (e) {
    const err = new Error(
      `could not connect with this credential to check what it can do: ${(e as Error).message}. ` +
        `The datasource was not saved — a credential whose privileges are unknown is the one ` +
        `case this check exists for, and storing it unverified moves that check to a moment ` +
        `nobody is watching.`,
    ) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }

  return { canWrite: !verdict.readOnly, findings: verdict.findings };
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 400;
  return err;
}

/**
 * The sqlite half of registration, standing where `assertRegistrableTarget`
 * and `measureCredential` stand for a networked database: there is no target
 * to classify and no grant to read, so what is checked is that the FILE
 * belongs to this workspace and is not already another datasource's.
 *
 * ⚠ Only the `read` policy. The stored file is a snapshot and is always
 * opened read-only; offering `read_write` would be a screen promising writes
 * that land in a temp copy and vanish — a policy nothing could make true.
 */
async function sqliteFileFor(
  workspaceId: string,
  fileId: string | undefined | null,
  accessPolicy: string | undefined,
): Promise<string> {
  if (!fileId) {
    throw badRequest("a SQLite data source needs its database file — upload it first, then register with sqliteFileId");
  }
  if (accessPolicy !== undefined && accessPolicy !== "read") {
    throw badRequest(
      "a SQLite data source can only be read-only: the uploaded file is a snapshot, so a write would " +
        "land in a temporary copy and be lost. Choose read-only.",
    );
  }
  const meta = await sqliteFileService.assertOwned(workspaceId, fileId).catch((e) => {
    throw badRequest((e as Error).message);
  });
  if (meta.datasourceId) {
    throw badRequest("that database file already belongs to another data source — upload it again for this one");
  }
  return fileId;
}

async function assertWorkspace(workspaceId: string) {
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws) {
    const err = new Error("workspace not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
}

export const datasourceService = {
  async list(workspaceId: string) {
    await assertWorkspace(workspaceId);
    const rows = await datasourceRepo.listByWorkspace(workspaceId);
    // Server-derived: the ONLY thing that satisfies "has mock data" is a READY
    // fixtures row. One batched read for the whole list, never per-row N+1.
    const readyIds = await datasourceFixtureRepo.readyIdsForWorkspace(workspaceId);
    return rows.map((d) => toPublic(d, readyIds.has(d.id)));
  },

  async get(workspaceId: string, id: string) {
    const d = await datasourceRepo.get(workspaceId, id);
    if (!d) return undefined;
    return toPublic(d, await datasourceFixtureRepo.hasReadyMock(d.id));
  },

  /**
   * `opts.verifyVia` is for a caller that cannot itself reach the hostname it is
   * storing — see `assertSameCredential`. Routes never pass it.
   */
  async create(
    workspaceId: string,
    input: z.infer<typeof createDatasourceInputSchema>,
    opts: { verifyVia?: string } = {},
  ) {
    await assertWorkspace(workspaceId);
    if (isSqliteType(input.type)) {
      const fileId = await sqliteFileFor(
        workspaceId,
        input.sqliteFileId ?? (input.connectionString ? fileIdOf(input.connectionString) : null),
        input.accessPolicy,
      );
      const d = await datasourceRepo.create({
        workspaceId,
        name: input.name,
        type: "sqlite",
        connectionStringEnc: encrypt(dsnFor(fileId)),
        secretEnvName: input.secretEnvName ?? null,
        schemaAllowlist: [SQLITE_SCHEMA],
        accessPolicy: "read",
        // The file is always opened read-only, so nothing this "credential" does can write.
        credentialCanWrite: false,
        testStatus: null,
      });
      await sqliteFileService.claim(workspaceId, fileId, d.id);
      return toPublic(d, false);
    }
    if (input.sqliteFileId !== undefined) throw badRequest("sqliteFileId is only for a SQLite data source");
    // A mock-only-until-linked row carries no credential: the gates need a DSN
    // to dial, so they are skipped until one is stored. Behavior-identical
    // whenever a connection string is present.
    let credentialCanWrite: boolean | null = null;
    if (input.connectionString !== undefined) {
      await assertRegistrableTarget(input.type, input.connectionString, opts.verifyVia);
      const measured = await measureCredential(
        input.type,
        input.connectionString,
        input.schemaAllowlist ?? ["public"],
        opts.verifyVia,
      );
      credentialCanWrite = measured ? measured.canWrite : null;
    }
    const d = await datasourceRepo.create({
      workspaceId,
      name: input.name,
      type: input.type,
      connectionStringEnc:
        input.connectionString !== undefined ? encrypt(input.connectionString) : null,
      secretEnvName: input.secretEnvName ?? null,
      schemaAllowlist: input.schemaAllowlist ?? ["public"],
      // ⚠ The DECLARATION and the OBSERVATION, stored separately. The state this
      // feature exists for is the one where they disagree — an administrator
      // credential on a datasource declared `read` — so a single "is it
      // read-only" column would lose exactly the case that matters.
      accessPolicy: input.accessPolicy ?? DEFAULT_ACCESS_POLICY,
      credentialCanWrite,
      testStatus: null,
    });
    // A just-created row has no fixtures row yet — derivation is trivially false.
    return toPublic(d, false);
  },

  async update(
    workspaceId: string,
    id: string,
    input: z.infer<typeof updateDatasourceSchema>,
    opts: { verifyVia?: string } = {},
  ) {
    // A new credential is re-verified, and so is a widened allowlist: the role
    // may be read-only in `public` and an owner in the schema just added, so
    // checking only at creation would let an edit walk straight past the gate.
    let remeasured: boolean | null = null;
    let sqliteFileId: string | null = null;
    {
      const current = await datasourceRepo.get(workspaceId, id);
      if (current && isSqliteType(current.type)) {
        if (input.connectionString !== undefined) {
          throw badRequest("a SQLite data source's connection is its file — replace it by uploading a new file (sqliteFileId)");
        }
        if (input.schemaAllowlist !== undefined && input.schemaAllowlist.join(",") !== SQLITE_SCHEMA) {
          throw badRequest(`a SQLite database has one schema, "${SQLITE_SCHEMA}", and nothing else to allow`);
        }
        if (input.sqliteFileId !== undefined) {
          sqliteFileId = await sqliteFileFor(workspaceId, input.sqliteFileId, undefined);
        }
      } else if (input.sqliteFileId !== undefined) {
        throw badRequest("sqliteFileId is only for a SQLite data source");
      }
    }
    if (input.connectionString !== undefined || input.schemaAllowlist !== undefined) {
      const existing = await datasourceRepo.get(workspaceId, id);
      if (existing) {
        // §1.3 runs on ANY credential-affecting edit, not only a new connection
        // string. One rule rather than two, and it means a row registered before
        // this check existed is caught the next time anyone edits it.
        //
        // Null-safe: a mock-only row has no stored DSN, and an allowlist-only
        // edit on one brings no new credential either — with no DSN on either
        // side there is nothing to dial, so the gates are skipped exactly as in
        // `create` without a credential.
        const storedDsn = existing.connectionStringEnc
          ? decrypt(existing.connectionStringEnc as string)
          : null;
        const effectiveDsn = input.connectionString ?? storedDsn;
        if (effectiveDsn !== null) {
          await assertRegistrableTarget(existing.type, effectiveDsn, opts.verifyVia);
          // ⚠ Re-MEASURED on every credential-affecting edit, and the result is
          // written back below. Swapping in a wider credential must not leave
          // the row still claiming the old one's capability — the screen would
          // then describe a credential that is no longer there. It no longer
          // refuses (see `measureCredential`); the policy is what refuses, and
          // the policy is unchanged by this edit.
          const measured = await measureCredential(
            existing.type,
            effectiveDsn,
            input.schemaAllowlist ?? existing.schemaAllowlist ?? ["public"],
            opts.verifyVia,
          );
          if (measured) remeasured = measured.canWrite;
        }
      }
    }
    const patch: Record<string, unknown> = {};
    if (remeasured !== null) patch.credentialCanWrite = remeasured;
    if (input.name !== undefined) patch.name = input.name;
    if (input.secretEnvName !== undefined) patch.secretEnvName = input.secretEnvName;
    if (input.schemaAllowlist !== undefined) {
      patch.schemaAllowlist = input.schemaAllowlist;
      patch.testStatus = null; // scope changed → stored schema is stale
    }
    if (input.columnTags !== undefined) {
      // Checked against the schema as it is NOW (and stored with the declarations applied) before anything is written.
      // Checked against the CURRENT credential: a new connection in the same edit would check against a schema not yet stored.
      if (input.connectionString !== undefined || input.sqliteFileId !== undefined) {
        throw badRequest("declare column tags in an edit of their own, after the new connection is saved");
      }
      const existing = await datasourceRepo.get(workspaceId, id);
      if (!existing) return undefined;
      if (!existing.connectionStringEnc) {
        throw Object.assign(new Error("no credential linked to this datasource — attach one before declaring column tags"), { statusCode: 409 });
      }
      await schemaIntrospectorService.refresh(id, existing.type, decrypt(existing.connectionStringEnc as string), {
        schemas: input.schemaAllowlist ?? existing.schemaAllowlist ?? ["public"],
        columnTags: input.columnTags,
        strictTags: true,
      });
      patch.columnTags = input.columnTags;
    }
    if (input.connectionString !== undefined) {
      patch.connectionStringEnc = encrypt(input.connectionString);
      patch.testStatus = null; // credentials changed → schema stale
    }
    if (sqliteFileId !== null) {
      patch.connectionStringEnc = encrypt(dsnFor(sqliteFileId));
      patch.testStatus = null; // a new file → stored schema is stale
    }
    if (input.resourceStatus !== undefined) patch.resourceStatus = input.resourceStatus;
    if (input.ownerSubject !== undefined) patch.ownerSubject = input.ownerSubject;
    if (input.ownerName !== undefined) patch.ownerName = input.ownerName;
    if (input.ownerAvatarUrl !== undefined) patch.ownerAvatarUrl = input.ownerAvatarUrl;
    if (input.health !== undefined) patch.health = input.health;
    if (input.healthNote !== undefined) patch.healthNote = input.healthNote;
    if (input.resourceCategory !== undefined) patch.resourceCategory = input.resourceCategory;
    const d = await datasourceRepo.update(workspaceId, id, patch);
    if (d && sqliteFileId !== null) {
      await sqliteFileService.claim(workspaceId, sqliteFileId, d.id);
      await sqliteFileService.removeOthers(d.id, sqliteFileId);
    }
    // A credential or scope change stales the mock: rebuild it (new version,
    // new fingerprint) rather than leaving yesterday's fixture under today's
    // registration. Fire-and-forget like `refreshSchema` — a mock problem can
    // never turn a successful update into a failed one.
    if (d && (input.connectionString !== undefined || input.schemaAllowlist !== undefined)) {
      void rebuildMockDataset(workspaceId, id).catch((e) => {
        console.warn(`[mock:update] could not rebuild ${id}: ${(e as Error).message}`);
      });
    }
    if (!d) return undefined;
    return toPublic(d, await datasourceFixtureRepo.hasReadyMock(d.id));
  },

  async remove(workspaceId: string, id: string) {
    return datasourceRepo.remove(workspaceId, id);
  },

  /** Attempt a live connection; record status. Dial-only — never hooked into mock builds. */
  async test(workspaceId: string, id: string) {
    const d = await datasourceRepo.get(workspaceId, id);
    if (!d) return undefined;
    // A mock-only row has no credential to dial: report, don't throw — the
    // caller asked "can you connect", and the answer is no.
    if (!d.connectionStringEnc) return { ok: false, detail: "no credential linked to this datasource" };
    const conn = decrypt(d.connectionStringEnc as string);
    const result = await schemaIntrospectorService.test(d.type, conn);
    await datasourceRepo.update(workspaceId, id, {
      testStatus: result.ok ? "connected" : "error",
      lastTestedAt: new Date(),
    });
    return { ok: result.ok, detail: result.detail };
  },

  /** Introspect + store the schema; also flips testStatus to connected on success. */
  async refreshSchema(workspaceId: string, id: string) {
    const d = await datasourceRepo.get(workspaceId, id);
    if (!d) return undefined;
    // A mock-only row has no credential to introspect with: refuse with a 409
    // naming the missing link, rather than decrypting null into a driver error.
    if (!d.connectionStringEnc) {
      const err = new Error(
        "no credential linked to this datasource — attach one before refreshing schema",
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    const conn = decrypt(d.connectionStringEnc as string);
    // WS-C.1: introspect exactly the schemas this datasource declares.
    const summary = await schemaIntrospectorService.refresh(id, d.type, conn, {
      schemas: d.schemaAllowlist ?? ["public"],
      columnTags: d.columnTags ?? {},
    });
    await datasourceRepo.update(workspaceId, id, {
      testStatus: "connected",
      lastTestedAt: new Date(),
    });
    /**
     * ⚠ **HERE, AND NOT IN `create`.** A fixture is generated from the
     * INTROSPECTED shape, so at `create` there is nothing to generate from —
     * hooking there would produce a build that fails on every new datasource
     * for a reason that is really "too early".
     *
     * Fire-and-forget, and deliberately not awaited: a build takes ~100s
     * (measured) and this is the call the onboarding wizard blocks on. It also
     * cannot throw into this path — `provisionIfAbsent` refuses rather than
     * throwing, and the detached build catches everything onto the row — so a
     * sandbox problem can never turn a successful introspection into a failed
     * one. Introspection is the product; the sandbox is a consequence of it.
     */
    void provisionIfAbsent(workspaceId, id).catch((e) => {
      console.warn(`[sandbox:auto] could not consider ${id}: ${(e as Error).message}`);
    });
    // Deterministic mock twin of the hook above: same fire-and-forget shape,
    // same guarantee (a mock problem never fails the introspection). The mock
    // build itself is milliseconds (seeded RNG, no model), but the wizard still
    // must not block on it — seeders await it instead, so onboarding through
    // any path yields a ready fixtures row + JSON file.
    void requestMockBuild(workspaceId, id).catch((e) => {
      console.warn(`[mock:auto] could not consider ${id}: ${(e as Error).message}`);
    });
    return summary;
  },

  async getSchema(workspaceId: string, id: string) {
    const d = await datasourceRepo.get(workspaceId, id);
    if (!d) return undefined;
    return schemaIntrospectorService.getStored(id);
  },
};
