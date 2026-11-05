/**
 * Provisioning a sandbox WITHOUT anyone running a command.
 *
 * -----------------------------------------------------------------------------
 * Why this is allowed to exist, when `sandbox/cli.ts` says it should not
 * -----------------------------------------------------------------------------
 *
 * That file's docblock says provisioning is a command and not a button, because
 * it "generates rows with a model (minutes), drops and recreates a database,
 * and creates a login role. That is exactly the shape of
 * `POST /api/demo/provision`, which Stage 1 deleted for being a destructive
 * reseed from one authenticated request."
 *
 * WARNING: **That objection is about RE-provisioning, and reading it as a ban on
 * provisioning is the mistake this module exists to avoid making silently.**
 * The danger named is destructiveness — dropping a database somebody is using.
 * At onboarding there is nothing to destroy: the datasource has just been
 * introspected for the first time, no fixture exists, and building one is
 * purely additive. `provisionIfAbsent` REFUSES when a fixture is already there,
 * which is what keeps that distinction real instead of asserted.
 *
 * Re-provisioning stays a command. So does `sandbox:rebuild` and
 * `sandbox:teardown`.
 *
 * -----------------------------------------------------------------------------
 * Three constraints, each from something already measured
 * -----------------------------------------------------------------------------
 *
 * **1. Async, never inline.** A real provision took 102s for 8 tables (measured
 * 2026-09-04, `support_demo`); the sandbox write-up records ~256s over 7. The
 * caller returns immediately and the row carries `building`. An inline call
 * would hang the onboarding wizard for minutes and die at the proxy timeout,
 * leaving a registered datasource and no way to tell whether the build was
 * still going.
 *
 * **2. Bounded.** One model call per table. `MAX_AUTO_TABLES` refuses rather
 * than truncating: a fixture covering some of a schema is a sandbox whose
 * missing tables read as empty, which is a wrong answer that looks like a right
 * one. A big schema is provisioned deliberately, from the CLI, by someone who
 * has decided to pay for it.
 *
 * **3. Failure is LOUD and leaves NO sandbox.** `sandboxService.provision`
 * already writes the fixture only after the taxonomy check passes against the
 * loaded database, so a failure cannot leave a half-built sandbox. What this
 * adds is that the failure is RECORDED — `failed` plus the reason — rather than
 * reverting to a state that reads identically to "nobody ever asked".
 *
 * WARNING: **`failed` DOES NOT SATISFY `hasSandbox`.** A draft run against a
 * datasource whose build failed reads PRODUCTION and says so, exactly as it did
 * before. That is the property that makes an automatic build safe to add: it
 * can only ever move a datasource from "reads production" to "reads fixtures",
 * never the other way, and it cannot half-do it.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceFixtures, datasources } from "../db/schema.js";
import { inference } from "./inference.service.js";
import { sandboxService } from "./sandbox.service.js";

/**
 * The per-datasource table ceiling for an AUTOMATIC build. Not a limit on
 * sandboxes — the CLI has none — a limit on what happens without anyone asking.
 */
export const MAX_AUTO_TABLES = 25;

/** In-flight builds in this process, so two callers cannot start the same one. */
const inFlight = new Set<string>();

export type AutoProvisionOutcome =
  | { started: true }
  | { started: false; why: "already_has_fixture" | "already_building" | "not_postgres" | "too_many_tables" | "no_schema"; detail?: string };

async function tableCount(datasourceId: string, allowlist: string[]): Promise<number> {
  const { schemas } = await import("../db/schema.js");
  const rows = await db
    .select({ id: schemas.id, entityName: schemas.entityName, entitySchema: schemas.entitySchema })
    .from(schemas)
    .where(eq(schemas.datasourceId, datasourceId));
  const keep = rows.filter((r) => allowlist.includes(r.entitySchema ?? "public"));
  return new Set(keep.map((r) => `${r.entitySchema ?? "public"}.${r.entityName}`)).size;
}

/**
 * Start a build if — and only if — this datasource has none.
 *
 * Returns as soon as the decision is made. The build runs detached; its outcome
 * lands on the row and is read back through `sandboxService.status`.
 */
export async function provisionIfAbsent(
  workspaceId: string,
  datasourceId: string,
): Promise<AutoProvisionOutcome> {
  const key = `${workspaceId}:${datasourceId}`;
  if (inFlight.has(key)) return { started: false, why: "already_building" };

  const rows = await db
    .select()
    .from(datasources)
    .where(and(eq(datasources.id, datasourceId), eq(datasources.workspaceId, workspaceId)))
    .limit(1);
  const ds = rows[0];
  if (!ds) return { started: false, why: "no_schema" };

  // Refused by name, not attempted: the DDL emitter, the role model and every
  // taxonomy query are Postgres, and a half-working sandbox is the failure mode
  // the whole stage is about.
  if (ds.type !== "postgres") return { started: false, why: "not_postgres", detail: ds.type };
  if (ds.sandboxBuildStatus === "building") return { started: false, why: "already_building" };

  // ⚠ The check that keeps the "purely additive" claim true. An existing
  // fixture means re-provisioning, which is destructive and stays a command.
  const existing = await db
    .select({ version: datasourceFixtures.version })
    .from(datasourceFixtures)
    .where(eq(datasourceFixtures.datasourceId, datasourceId))
    .limit(1);
  if (existing.length > 0) return { started: false, why: "already_has_fixture" };

  const allowlist = ds.schemaAllowlist ?? ["public"];
  const n = await tableCount(datasourceId, allowlist);
  if (n === 0) return { started: false, why: "no_schema" };
  if (n > MAX_AUTO_TABLES) {
    const detail =
      `${n} tables — an automatic build is capped at ${MAX_AUTO_TABLES} because it costs one ` +
      `model call per table. Provision it deliberately: pnpm --filter @foundry/server ` +
      `sandbox:provision --workspace=${workspaceId} --datasource=${ds.name}`;
    await db
      .update(datasources)
      .set({ sandboxBuildStatus: "failed", sandboxBuildError: detail })
      .where(eq(datasources.id, datasourceId));
    return { started: false, why: "too_many_tables", detail };
  }

  inFlight.add(key);
  await db
    .update(datasources)
    .set({
      sandboxBuildStatus: "building",
      sandboxBuildError: null,
      sandboxBuildStartedAt: new Date(),
    })
    .where(eq(datasources.id, datasourceId));

  // Detached on purpose. `void` rather than an unawaited floating promise so
  // the intent is legible, and the catch is total: a build that throws must
  // land on the row, never as an unhandled rejection that takes the process
  // down while a person watches a spinner.
  void (async () => {
    try {
      await sandboxService.provision({
        workspaceId,
        datasourceId,
        inference,
        onProgress: (m) => console.log(`[sandbox:auto ${ds.name}] ${m}`),
      });
      await db
        .update(datasources)
        .set({ sandboxBuildStatus: "ready", sandboxBuildError: null })
        .where(eq(datasources.id, datasourceId));
      console.log(`[sandbox:auto] ${ds.name}: sandbox ready`);
    } catch (e) {
      const why = (e as Error).message;
      await db
        .update(datasources)
        .set({ sandboxBuildStatus: "failed", sandboxBuildError: why })
        .where(eq(datasources.id, datasourceId))
        .catch(() => {});
      console.warn(`[sandbox:auto] ${ds.name}: build failed — ${why}`);
    } finally {
      inFlight.delete(key);
    }
  })();

  return { started: true };
}

/**
 * Mark every `building` row abandoned — run ONCE at boot, before anything serves.
 *
 * ── ⚠ THE DEFECT THIS CLOSES, MEASURED 2026-09-17 ───────────────────────────
 *
 * Three datasources on this deployment had been reading **`building`** for
 * **seven days** against a panel that says "around two minutes":
 *
 *     hiring_demo   building   2026-09-09 17:26:20   age 7 days
 *     orders_demo   building   2026-09-09 17:26:20   age 7 days
 *     support_demo  building   2026-09-09 17:26:20   age 7 days
 *
 * `provisionIfAbsent` writes `building`, then runs the build as a **detached
 * in-process promise**. Nothing outside this process knows about it. So a
 * restart — a deploy, a crash, a `compose up` — ends every build in flight and
 * leaves its row claiming one is still running, for ever. There is no timeout,
 * no heartbeat and no owner, and `sandboxBuildStartedAt` was written by
 * `provisionIfAbsent` and **read by nothing**: I-120's shape, a value computed
 * and discarded, in the one place that could have detected this.
 *
 * ⚠ **The row said `building` and the exposure sentence said `production`, and
 * BOTH were on screen at once.** That is what was reported. The exposure half
 * was right — `hasSandbox` is false, so a draft run really did read production
 * — and the panel's own docblock argues, correctly, that the exposure must show
 * during a build. What was wrong is the other half: the state said a build was
 * two minutes from landing and no build existed. A person reading "building…"
 * waits. Nobody was coming.
 *
 * ── Why this is EXACT rather than a heuristic ───────────────────────────────
 *
 * ⚠ A build lives only in `inFlight`, a `Set` in this module's memory. At boot
 * that set is empty **by construction**, so at this instant a `building` row
 * cannot have a build behind it — whatever wrote it belonged to a process that
 * is gone. No age threshold, no grace period, nothing to tune and nothing that
 * can be wrong. An age bound was the first version and it is strictly worse:
 * it has to guess how long a slow schema may legitimately take, and it would
 * shoot a genuine build in the head to do it.
 *
 * ⚠ **This is why it must run at BOOT and nowhere else.** The same query inside
 * `status()` or on a timer would mark a live build abandoned — `inFlight` is
 * populated then, and this function does not consult it precisely because it
 * relies on running when consulting it would be pointless.
 *
 * ⚠ **`failed`, never NULL.** Null is "nobody ever asked" and would erase the
 * fact that somebody did; `failed` is "we asked, and here is why not". They are
 * different facts and the panel renders them differently. The reason names the
 * restart and the command, so the sentence a person reads tells them what to do
 * rather than what went wrong.
 *
 * ⚠ **It cannot expose anything.** `failed` does not satisfy `hasSandbox` and
 * neither did `building` — a draft run against these datasources read
 * PRODUCTION before this ran and reads PRODUCTION after. The only thing that
 * changes is that the screen stops promising otherwise. That property is what
 * makes it safe to run unattended at every boot.
 */
export async function reconcileAbandonedBuilds(): Promise<number> {
  const orphaned = await db
    .update(datasources)
    .set({
      sandboxBuildStatus: "failed",
      /**
       * ⚠ **THE REASON AND NOTHING ELSE — it deliberately carries NO command.**
       *
       * The first version ended with `sandbox:provision --workspace=<id>
       * --datasource=<name>`, and both halves of that were wrong. The literal
       * angle brackets are a template somebody copies verbatim — the exact
       * mistake recorded against the chat prompt that emitted the ref
       * `hr_demo.<reader for approved leave requests by period>`, arriving here
       * in UI copy instead of in a prompt. A bulk UPDATE has no per-row values
       * to interpolate, which is *why* it reached for placeholders.
       *
       * ⚠ And it was a SECOND command on a panel that already had the right
       * one. `sandboxService.status` builds `exposure` per datasource with the
       * real workspace id and name resolved, and that sentence renders directly
       * below this one whenever `hasSandbox` is false — which is always true
       * here, because `failed` does not satisfy it. So the screen showed two
       * commands for one job and the broken one was on top. One definition of
       * "how do I fix this" per concept (D-197): `exposure` owns it, this says
       * what happened.
       */
      sandboxBuildError:
        "the build was interrupted when the server restarted — a sandbox build runs in the API " +
        "process and does not survive one. Nothing was left half-built, and a draft run of this " +
        "datasource reads production until a build succeeds.",
    })
    .where(eq(datasources.sandboxBuildStatus, "building"))
    .returning({ name: datasources.name });

  if (orphaned.length) {
    console.warn(
      `[sandbox:auto] ${orphaned.length} sandbox build(s) did not survive a restart and have been ` +
        `marked failed: ${orphaned.map((r) => r.name).join(", ")}. ` +
        `A draft run of each reads PRODUCTION until one succeeds.`,
    );
  }
  return orphaned.length;
}
