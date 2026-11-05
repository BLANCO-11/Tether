import { z } from "zod";
import {
  workspaceSecretRepo,
  type WorkspaceSecret,
} from "../repositories/workspace-secret.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceRepo, decryptDsnIfPresent } from "../repositories/datasource.repo.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { config } from "../config/index.js";
import { assertNotConnectionCredential, connectionSecretNames } from "./plugin-credentials.js";

/**
 * WS-B.3 — workspace secret store
 * (plans/production-substitution-plan.md §5.3).
 *
 * Holds the VALUES behind the env-var names that tools and datasources declare
 * and the manifest renders as `<secretRef env="…"/>`. Two hard rules:
 *
 *   1. A value is NEVER returned by the API. `toPublic` has no value field at
 *      all, so there is no flag to get wrong — reads go through
 *      `resolveForExecution` / `resolveForGeneration`, which are server-side only.
 *   2. `name` is an env-var identifier. The manifest, the prompt, the `-e` flag
 *      and this row all use the same string; validating it here is what stops a
 *      name that cannot be an env var from reaching a container.
 */

const ENV_NAME = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "name must be an env-var identifier (A-Z, 0-9, _)");

export const createSecretSchema = z.object({
  name: ENV_NAME,
  value: z.string().min(1).max(8192),
  description: z.string().max(2000).optional(),
  /** Throwaway credential for generation-time smoke tests (§13 Q1). */
  sandboxValue: z.string().max(8192).optional(),
});

/**
 * ⚠ `name` was ABSENT here until ui-upgrade Phase 8 (`issues.md` I-69), so a
 * secret could be created and deleted but never renamed. Adding it is not a
 * one-word change, because a rename is a BREAKING change that presents as
 * nothing:
 *
 * A secret is referenced by its env-var NAME — not by its id — from
 * `tools.secret_env_name` and, for the per-workspace agent key, from
 * a tool's own declaration. Renaming the row leaves every one of those
 * references pointing at a name nothing holds. Nothing refuses, no fingerprint
 * moves, no flow is suspended and no manifest changes; the first sign is a **401
 * at execution**, hours later, or — worse — an agent step quietly running in the
 * silent fallback. So `confirmOrphans` exists and is deliberately not
 * defaulted: see `renameImpact` and D-110.
 */
export const updateSecretSchema = z.object({
  name: ENV_NAME.optional(),
  value: z.string().min(1).max(8192).optional(),
  description: z.string().max(2000).optional(),
  sandboxValue: z.string().max(8192).nullable().optional(),
  /**
   * Acknowledges the orphan list `renameImpact` returns. A rename that orphans a
   * reference is refused with a 409 unless this is `true` — the caller has to
   * have asked what breaks before it can say it accepts it.
   */
  confirmOrphans: z.boolean().optional(),
});

/** Never includes a value. See rule 1 above. */
function toPublic(s: WorkspaceSecret) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    name: s.name,
    description: s.description,
    // Presence, not content.
    hasValue: Boolean(s.valueEnc),
    hasSandboxValue: Boolean(s.sandboxValueEnc),
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function assertWorkspace(workspaceId: string) {
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws) {
    const err = new Error("workspace not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
}

export interface ResolvedSecret {
  name: string;
  value: string;
  /** Which store the value came from — for logging WITHOUT logging the value. */
  source: "workspace_secret" | "workspace_secret_sandbox" | "datasource";
}

/** One thing declaring one env-var name, before any de-duplication. */
interface Declaration {
  secret: ResolvedSecret;
  /** In the words the audit already uses, e.g. `tool "mail_send"`. */
  owner: string;
}

/**
 * Everything in this workspace that declares an env-var name, and what value it
 * would contribute.
 *
 * ⚠ **This is the ONE place that knows what a declaration is**, and it is
 * factored out rather than inlined twice because it has two readers with
 * different scopes: the audit wants every name, and the execution-time refusal
 * (I-120) wants exactly one. Two walks would be two answers to *"is this
 * shadowed?"*, and the pair would drift in the direction where the cheap one
 * says no — the same argument that made `@foundry/redact` a package.
 *
 * `only` filters BEFORE decrypting, so the single-name case pays for one
 * credential rather than for the workspace.
 */
async function declarationsIn(workspaceId: string, only?: string): Promise<{
  declarations: Declaration[];
  missing: { envName: string; neededBy: string }[];
}> {
  const declarations: Declaration[] = [];
  const missing: { envName: string; neededBy: string }[] = [];

  for (const d of await datasourceRepo.listByWorkspace(workspaceId)) {
    if (!d.secretEnvName) continue;
    if (only && d.secretEnvName !== only) continue;
    // Mock-only rows have no prod value to inject — skip, do not decrypt null.
    const value = decryptDsnIfPresent(d.connectionStringEnc);
    if (value === null) continue;
    declarations.push({
      secret: { name: d.secretEnvName, value, source: "datasource" },
      owner: `datasource "${d.name}"`,
    });
  }

  for (const t of await toolRepo.listByWorkspace(workspaceId)) {
    if (!t.secretEnvName || t.isActive === false) continue;
    if (only && t.secretEnvName !== only) continue;
    const stored = await workspaceSecretRepo.getByName(workspaceId, t.secretEnvName);
    if (!stored) {
      // Reported, not thrown: one unconfigured tool must not block an execution
      // that never calls it. The caller decides how loud to be.
      missing.push({ envName: t.secretEnvName, neededBy: `tool "${t.name}"` });
      continue;
    }
    declarations.push({
      secret: { name: stored.name, value: decrypt(stored.valueEnc), source: "workspace_secret" },
      owner: `tool "${t.name}"`,
    });
  }

  return { declarations, missing };
}

/**
 * Reduce declarations to one value per name, reporting the ones that disagree.
 *
 * ⚠ **The comparison rule lives here and nowhere else.** *Same name, same value*
 * is NOT a conflict — two tools sharing one vendor key is the normal case and the
 * reason this store is per workspace. A check that refused it would be worse than
 * no check, because the workaround is a second copy of the credential.
 */
function dedupe(declarations: Declaration[]): {
  secrets: ResolvedSecret[];
  collisions: string[];
} {
  const byName = new Map<string, Declaration>();
  const collisions: string[] = [];
  for (const d of declarations) {
    const existing = byName.get(d.secret.name);
    if (!existing) {
      byName.set(d.secret.name, d);
      continue;
    }
    if (existing.secret.value !== d.secret.value) {
      collisions.push(
        `${d.secret.name} is declared by ${existing.owner} and ${d.owner} with different values`,
      );
    }
  }
  return { secrets: [...byName.values()].map((v) => v.secret), collisions };
}

/**
 * Every secret an execution needs: datasource connection strings plus the
 * credentials of every active tool that declares one.
 *
 * COLLISIONS ARE AN ERROR, not a last-write-wins (WS-B.1). If a tool and a
 * datasource both declare `API_KEY`, one silently shadows the other and the
 * resulting failure looks like a wrong credential rather than a misconfiguration.
 *
 * ⚠ **This function does NOT enforce that, and used not to say so** (I-120). It
 * is the AUDIT's computation — `workspaceSecretService.audit` is its only
 * production caller — and an audit reports. The refusal that makes the sentence
 * above true is `assertNoShadowedSecret`, called from `invokeTool` at the moment
 * of use. Between Kestra Phase 4 (which deleted the executor that injected these
 * env vars) and 2026-08-10, there was no such caller and the control did not run
 * at all: the docblocks describing it were correct about intent and wrong about
 * mechanism, which is the hardest kind of comment to notice.
 */
export async function resolveForExecution(workspaceId: string): Promise<{
  secrets: ResolvedSecret[];
  missing: { envName: string; neededBy: string }[];
  collisions: string[];
}> {
  const { declarations, missing } = await declarationsIn(workspaceId);
  const { secrets, collisions } = dedupe(declarations);
  return { secrets, missing, collisions };
}

/**
 * The execution-time half of WS-B.1: refuse to use `envName` when something else
 * in this workspace declares it at a DIFFERENT value (I-120).
 *
 * Returns the collision sentences — the same strings the audit reports, from the
 * same `dedupe` — so the two surfaces cannot describe one condition two ways.
 * Empty means safe to proceed.
 *
 * ── ⚠ What can actually collide, which is narrower than it looks ─────────────
 *
 * **Two tools can never collide, structurally.** Both resolve through
 * `workspaceSecretRepo.getByName(workspaceId, envName)` — the same row — so they
 * always contribute an identical value. `checkpoint.md` 1.1 asked for a test of
 * *"two tools declaring one name at different values"*; that state is not
 * reachable, and a test asserting it would have had to fabricate it. See
 * `issues.md` I-120.
 *
 * The reachable collision is **tool versus datasource**, because a datasource's
 * value is its own encrypted DSN and is never looked up in this store. That is
 * already written down in `SecretReference`'s docblock below, which says a
 * datasource sharing a name is *"a COLLISION (reported by the audit, and a 409
 * that refuses the execution), which is loud"* — a sentence that was true about
 * the audit and false about the 409 until this function existed.
 */
export async function shadowedSecretCollisions(
  workspaceId: string,
  envName: string,
): Promise<string[]> {
  const { declarations } = await declarationsIn(workspaceId, envName);
  return dedupe(declarations).collisions;
}

/**
 * The same set, but preferring each secret's SANDBOX value when one exists
 * (WS-B.2). Used by the secret store at generation time, so the
 * agent's smoke test can exercise an authenticated call without a production
 * credential entering an agent workspace.
 */
export async function resolveForGeneration(workspaceId: string): Promise<ResolvedSecret[]> {
  const { secrets } = await resolveForExecution(workspaceId);
  const out: ResolvedSecret[] = [];
  for (const s of secrets) {
    if (s.source !== "workspace_secret") {
      out.push(s);
      continue;
    }
    const stored = await workspaceSecretRepo.getByName(workspaceId, s.name);
    if (stored?.sandboxValueEnc) {
      out.push({
        name: s.name,
        value: decrypt(stored.sandboxValueEnc),
        source: "workspace_secret_sandbox",
      });
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * Something that reads a secret BY NAME, and therefore breaks when the name moves.
 *
 * ⚠ A datasource is deliberately NOT one of these. A datasource declares an
 * env-var name too, but its value is its own encrypted DSN — `resolveForExecution`
 * never looks the name up in this store. So a datasource sharing a name is a
 * COLLISION (reported by the audit, and a 409 that refuses the execution), which
 * is loud. These are the silent ones.
 *
 * ⚠ **That parenthesis was HALF FALSE until 2026-08-10 and is now true** (I-120).
 * The audit reported it; nothing refused it, because the 409 had no call site
 * once Kestra Phase 4 deleted the executor. `shadowedSecretCollisions` +
 * `invokeTool`'s refusal are the 409 this sentence promises. Do not soften the
 * claim back — verify it instead: `grep -n shadowedSecretCollisions` must find a
 * caller under `services/`, and `workspace-secret.test.ts` covers both arms.
 */
export type SecretReference = {
  kind: "tool" | "agent-tenant";
  /** What holds the reference, in the words the audit already uses. */
  label: string;
  /** What actually happens when the name stops resolving. Not "may be affected". */
  breaks: string;
};

export type RenameImpact = {
  /** The name today. */
  name: string;
  /** The name asked about, or null when the caller only asked "what depends on this?". */
  newName: string | null;
  /**
   * Everything that references the CURRENT name. A rename orphans exactly these;
   * a delete does the same thing, which is why this route answers both questions.
   */
  references: SecretReference[];
  /**
   * Another SECRET already holds `newName`. A hard refusal — the unique index
   * would otherwise surface as a raw database error.
   */
  nameTaken: boolean;
  /**
   * A DATASOURCE already declares `newName`. Reported, not refused: it produces a
   * collision, and a collision fails the execution with a 409 rather than picking
   * one at random. Loud beats silent, so this is a warning and the rename stands.
   */
  collidesWithDatasource: string | null;
  /**
   * References currently unsatisfied that `newName` would start satisfying — the
   * case where the rename is the FIX rather than the breakage (someone typed the
   * name wrong when they stored it).
   */
  adopts: SecretReference[];
  /** One sentence, or null when nothing breaks. Never a "may be affected" chip. */
  orphanWarning: string | null;
};

/** Everything in this workspace that reads `name` out of this store. */
async function referencesTo(workspaceId: string, name: string): Promise<SecretReference[]> {
  const out: SecretReference[] = [];
  for (const t of await toolRepo.listByWorkspace(workspaceId)) {
    if (t.secretEnvName !== name || t.isActive === false) continue;
    out.push({
      kind: "tool",
      label: `tool "${t.name}"`,
      breaks:
        `every call this tool makes presents no credential, so the endpoint answers 401 — ` +
        `at execution, inside a run, not now`,
    });
  }
  return out;
}

/**
 * What renaming (or deleting) this secret would break — computed WITHOUT doing it.
 *
 * Modelled on `datasourceQueryService.impact` (D-84) and deliberately reporting
 * something DIFFERENT IN KIND. A named query's edit moves a ref fingerprint, so
 * the staleness sweep unarms the flows using it and the consequence is
 * `willSuspendFlows` — visible, and the flow stops. A secret rename moves no
 * fingerprint at all: the tool row still says `TICKETING_API_KEY`, the manifest
 * still renders it, every armed flow stays armed and keeps running. It just
 * signs in with nothing. That is why this returns `references` and never
 * `willSuspendFlows`; naming it the same would promise a suspension that does
 * not come.
 */
async function renameImpact(
  workspaceId: string,
  id: string,
  newName?: string,
): Promise<RenameImpact | undefined> {
  await assertWorkspace(workspaceId);
  const current = await workspaceSecretRepo.get(workspaceId, id);
  if (!current) return undefined;

  const references = await referencesTo(workspaceId, current.name);
  const target = newName && newName !== current.name ? newName : null;

  let nameTaken = false;
  let collidesWithDatasource: string | null = null;
  let adopts: SecretReference[] = [];
  if (target) {
    nameTaken = Boolean(await workspaceSecretRepo.getByName(workspaceId, target));
    const ds = (await datasourceRepo.listByWorkspace(workspaceId)).find(
      (d) => d.secretEnvName === target,
    );
    collidesWithDatasource = ds ? ds.name : null;
    adopts = await referencesTo(workspaceId, target);
  }

  return {
    name: current.name,
    newName: target,
    references,
    nameTaken,
    collidesWithDatasource,
    adopts,
    orphanWarning:
      references.length === 0
        ? null
        : `${references.length} thing(s) reference "${current.name}" by name. Renaming it does ` +
          "not update them and does not suspend anything — the reference simply stops " +
          "resolving, and the first sign is a failure inside a run.",
  };
}

export const workspaceSecretService = {
  async list(workspaceId: string) {
    await assertWorkspace(workspaceId);
    const hidden = await connectionSecretNames(workspaceId);
    return (await workspaceSecretRepo.listByWorkspace(workspaceId)).filter((s) => !hidden.has(s.name)).map(toPublic);
  },

  async create(workspaceId: string, input: z.infer<typeof createSecretSchema>) {
    await assertWorkspace(workspaceId);
    // Re-parse HERE, not only in the route. `name` becomes a literal `-e NAME=…`
    // flag on a container and a secret key, and internal callers
    // (provisioning, future code) reach this function without passing through the
    // route's parse. Validating at the boundary that matters is the difference
    // between a rejected request and an env var that cannot exist.
    input = createSecretSchema.parse(input);
    if (await workspaceSecretRepo.getByName(workspaceId, input.name)) {
      const e = new Error(
        `a secret named ${input.name} already exists in this workspace`,
      ) as Error & { statusCode?: number };
      e.statusCode = 409;
      throw e;
    }
    const s = await workspaceSecretRepo.create({
      workspaceId,
      name: input.name,
      description: input.description ?? null,
      valueEnc: encrypt(input.value),
      sandboxValueEnc: input.sandboxValue ? encrypt(input.sandboxValue) : null,
    });
    return toPublic(s);
  },

  /**
   * ⚠ Returns `{ secret, rename }`, not a bare secret. `rename` is null for every
   * edit that does not move the name — so a caller that ignores it is correct
   * today and stays correct, and a caller that reads it learns what it just
   * orphaned in the same response that confirmed the write.
   */
  async update(workspaceId: string, id: string, input: z.infer<typeof updateSecretSchema>) {
    // Re-parsed HERE for the same reason `create` re-parses: `name` becomes a
    // literal `-e NAME=…` flag and a secret key, and an internal caller
    // reaching this function does not pass through the route's parse.
    input = updateSecretSchema.parse(input);
    const current = await workspaceSecretRepo.get(workspaceId, id);
    if (!current) return undefined;
    await assertNotConnectionCredential(workspaceId, [current.name], "cannot be changed here");

    const patch: Record<string, unknown> = {};
    let rename: { from: string; to: string; orphaned: SecretReference[] } | null = null;

    if (input.name !== undefined && input.name !== current.name) {
      const impact = (await renameImpact(workspaceId, id, input.name))!;
      if (impact.nameTaken) {
        const e = new Error(
          `a secret named ${input.name} already exists in this workspace`,
        ) as Error & { statusCode?: number };
        e.statusCode = 409;
        throw e;
      }
      // ⚠ The refusal is HERE, not in the browser. A client that forgets to ask
      // cannot orphan a reference by omission — it has to send a field that says
      // it read the list. `confirmOrphans` has no default for exactly that
      // reason: a default of `true` turns the control off, and a default of
      // `false` written anywhere but here is a second place to get it wrong.
      if (impact.references.length > 0 && input.confirmOrphans !== true) {
        const e = new Error(
          `renaming ${current.name} to ${input.name} orphans ${impact.references.length} ` +
            `reference(s): ${impact.references.map((r) => r.label).join(", ")}. ` +
            "Nothing is suspended and nothing errors — they simply stop resolving, and the first " +
            "sign is a 401 inside a run. Confirm the rename to proceed.",
        ) as Error & { statusCode?: number };
        e.statusCode = 409;
        // ⚠ The impact object is deliberately NOT attached to the error.
        // `errorHandler` forwards `findings` and nothing else, so an `impact`
        // field here would be a field that exists, is populated, and never
        // arrives — which reads on this side exactly like one that works. The
        // list a dialog renders comes from `GET …/:id/impact`, which a client
        // has to call before writing anyway; this message is the backstop for
        // one that did not, and it names the references in full.
        throw e;
      }
      patch.name = input.name;
      rename = { from: current.name, to: input.name, orphaned: impact.references };
    }

    if (input.value !== undefined) patch.valueEnc = encrypt(input.value);
    if (input.description !== undefined) patch.description = input.description;
    if (input.sandboxValue !== undefined) {
      patch.sandboxValueEnc = input.sandboxValue ? encrypt(input.sandboxValue) : null;
    }
    const s = await workspaceSecretRepo.update(workspaceId, id, patch);
    return s ? { secret: toPublic(s), rename } : undefined;
  },

  renameImpact,

  async remove(workspaceId: string, id: string) {
    const current = await workspaceSecretRepo.get(workspaceId, id);
    if (current) await assertNotConnectionCredential(workspaceId, [current.name], "cannot be removed here");
    return workspaceSecretRepo.remove(workspaceId, id);
  },

  /** Upsert by name — used by demo provisioning; still never returns a value. */
  async put(workspaceId: string, name: string, value: string, description?: string) {
    const parsed = createSecretSchema.parse({ name, value, description });
    await assertNotConnectionCredential(workspaceId, [parsed.name], "cannot be changed here");
    const s = await workspaceSecretRepo.upsertByName({
      workspaceId,
      name: parsed.name,
      description: parsed.description ?? null,
      valueEnc: encrypt(parsed.value),
    });
    return toPublic(s);
  },

  /**
   * Which declared secrets have no stored value — the answer to "why did my tool
   * call 401?" before it is asked. Surfaced by the API so the UI can show it.
   *
   */
  async audit(workspaceId: string) {
    await assertWorkspace(workspaceId);
    const { missing, collisions, secrets } = await resolveForExecution(workspaceId);
    const hidden = await connectionSecretNames(workspaceId);
    return {
      /**
       * ⚠ "Stored AND REFERENCED", not "stored" (`issues.md` I-96). These come
       * from `resolveForExecution`, which walks declarations — so a secret
       * nothing references does not appear here at all, in either direction. It
       * is not missing and it is not configured; it is simply not part of any
       * execution's environment. `GET /secrets` is the list of what is stored.
       */
      configured: secrets.map((s) => s.name).filter((n) => !hidden.has(n)).sort(),
      missing: missing.filter((x) => !hidden.has(x.envName)),
      collisions,
    };
  },

  resolveForExecution,
  resolveForGeneration,
  shadowedSecretCollisions,
};
