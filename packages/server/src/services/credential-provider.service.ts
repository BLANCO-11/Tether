import { z } from "zod";
import { workspaceSecretRepo, type WorkspaceSecret } from "../repositories/workspace-secret.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { assertNotConnectionCredential, connectionSecretNames } from "./plugin-credentials.js";

/**
 * Phase 5 — unified workspace credentials + vault-relay seam.
 *
 * One abstraction over the three encrypted stores that already exist —
 * `workspace_secrets` (AES-256-GCM), `datasources.connection_string_enc` (AES-
 * 256-GCM) and `triggers.webhook_token` — presenting every credential a
 * workspace holds as one `CredentialView` list, and one `resolveCredential`
 * that returns a VALUE to server-side callers only.
 *
 * ── Why this is a seam and not a new store ──────────────────────────────────
 *
 * Nothing is migrated and nothing moves: a future vault provider replaces the
 * three branches in `resolveCredential` / `listCredentials` with one vault
 * lookup and nothing else changes — the routes, the zod schemas, the
 * `CredentialView` shape and the client all stay. That is the entire point of
 * the abstraction (plan §Phase 5, D-117: no vault is wired now).
 *
 * ── Two hard rules, inherited from WS-B.3 ───────────────────────────────────
 *
 *   1. A value is NEVER returned by the API. `listCredentials` carries
 *      `hasValue` booleans and nothing else; `resolveCredential` is server-side
 *      only and has no route. There is still no endpoint that reads a secret.
 *   2. The `ref` IS the existing identifier, so the seam invents no namespace:
 *      secrets resolve by env-var NAME, database credentials by datasource
 *      NAME, webhook/api credentials by trigger NAME. One identifier per store,
 *      the same one every other surface already uses.
 */

export const CREDENTIAL_KINDS = [
  "tool",
  "database",
  "webhook",
  "api",
  "llm",
  "generic",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export type CredentialView = {
  kind: CredentialKind;
  ref: string;
  label?: string;
  hasValue: boolean;
  lastUsedAt?: Date;
};

/**
 * Kinds whose VALUE lives in `workspace_secrets` — the ones this seam owns.
 *
 * `database` values are `datasources.connection_string_enc` and webhook/api
 * values are `triggers.webhook_token`; both are written and removed by their
 * own surfaces (data sources page, triggers page). The seam reads them so the
 * Credentials page is one list, but upsert/delete refuse them rather than
 * editing a store behind another surface's back.
 */
const SECRET_OWNED_KINDS = new Set<CredentialKind>(["tool", "llm", "generic"]);

const ENV_NAME = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "name must be an env-var identifier (A-Z, 0-9, _)");

export const upsertCredentialSchema = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
  /**
   * The ref. For secret-backed kinds (`tool`/`llm`/`generic`) this is
   * the env-var name the value is stored under and injected with — the same
   * identifier the secrets surface and the manifest use.
   */
  name: ENV_NAME,
  /** Display text for the Credentials page; nothing resolves by it. */
  label: z.string().max(200).optional(),
  /**
   * The value. Optional because an upsert may update only the label or kind of
   * an existing credential; a NEW secret-backed credential without a value is
   * refused (there would be nothing to store).
   */
  value: z.string().min(1).max(8192).optional(),
});

function refusal(message: string, statusCode = 409): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

async function assertWorkspace(workspaceId: string) {
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws) throw refusal("workspace not found", 404);
}

/**
 * A stored `kind` could hold any varchar; a value outside the closed set is
 * rendered `generic` rather than asserted into the union and shown as a kind
 * that does not exist.
 */
function toKind(raw: string | null): CredentialKind {
  return raw && (CREDENTIAL_KINDS as readonly string[]).includes(raw) ? (raw as CredentialKind) : "generic";
}

function toSecretView(s: WorkspaceSecret): CredentialView {
  return {
    kind: toKind(s.kind),
    ref: s.name,
    label: s.label ?? undefined,
    hasValue: Boolean(s.valueEnc),
    lastUsedAt: s.lastUsedAt ?? undefined,
  };
}

export const credentialProviderService = {
  /**
   * Every credential in the workspace as one flat array; the client groups by
   * `kind`. Values are NEVER returned — `hasValue` is the whole truth about
   * content. `lastUsedAt` is the honest signal each store already keeps: the
   * secret's own injection timestamp, a trigger's last fire. A datasource has
   * no usage signal (`lastTestedAt` is a test, not a use), so it is omitted
   * rather than mislabelled.
   */
  async listCredentials(workspaceId: string): Promise<CredentialView[]> {
    await assertWorkspace(workspaceId);
    const out: CredentialView[] = [];

    // A connected service's credential is managed on its Apps page and is not listed here (plugins 8.3).
    const hidden = await connectionSecretNames(workspaceId);
    for (const s of await workspaceSecretRepo.listByWorkspace(workspaceId)) {
      if (!hidden.has(s.name)) out.push(toSecretView(s));
    }

    for (const d of await datasourceRepo.listByWorkspace(workspaceId)) {
      out.push({
        kind: "database",
        ref: d.name,
        label: d.name,
        hasValue: Boolean(d.connectionStringEnc),
      });
    }

    for (const t of await triggerRepo.listByWorkspace(workspaceId)) {
      if (t.type !== "webhook" && t.type !== "api") continue;
      out.push({
        kind: t.type === "api" ? "api" : "webhook",
        ref: t.name,
        label: t.name,
        hasValue: Boolean(t.webhookToken),
        lastUsedAt: t.lastFiredAt ?? undefined,
      });
    }

    return out;
  },

  /**
   * The ONE seam that returns a credential VALUE, server-side only — no route
   * calls it. v1 delegates to the three existing stores, resolving the ref in
   * a fixed precedence: `workspace_secrets` first (the seam's own store),
   * then datasources, then webhook/api triggers.
   *
   * A future vault provider replaces exactly these branches; `metadata` is the
   * shape that would carry vault addressing (kind/ref/source today).
   */
  async resolveCredential(
    workspaceId: string,
    ref: string,
  ): Promise<{ value: string; metadata: Record<string, unknown> }> {
    await assertWorkspace(workspaceId);

    const secret = await workspaceSecretRepo.getByName(workspaceId, ref);
    if (secret) {
      return {
        value: decrypt(secret.valueEnc),
        metadata: { kind: toKind(secret.kind), ref: secret.name, label: secret.label ?? undefined, source: "workspace_secret" },
      };
    }

    const ds = await datasourceRepo.getByName(workspaceId, ref);
    // Mock-only rows carry no prod credential — fall through rather than
    // throwing malformed-ciphertext on decrypt(null).
    if (ds && ds.connectionStringEnc) {
      return {
        value: decrypt(ds.connectionStringEnc),
        metadata: { kind: "database", ref: ds.name, label: ds.name, source: "datasource" },
      };
    }

    const trigger = await triggerRepo.getByName(workspaceId, ref);
    if (trigger && (trigger.type === "webhook" || trigger.type === "api")) {
      if (!trigger.webhookToken) {
        throw refusal(
          `trigger "${ref}" exists but has no stored token — it cannot be resolved as a credential`,
          404,
        );
      }
      return {
        value: trigger.webhookToken,
        metadata: {
          kind: trigger.type === "api" ? "api" : "webhook",
          ref: trigger.name,
          label: trigger.name,
          source: "trigger",
        },
      };
    }

    throw refusal(`no credential named "${ref}" exists in this workspace`, 404);
  },

  /**
   * Write through the seam. Only secret-backed kinds are accepted — a
   * `database`/`webhook`/`api` ref is owned by its own surface and refused
   * with the pointer to it, so the unified page cannot edit a store behind
   * another page's back.
   *
   * A missing `value` updates label/kind of an existing credential; a NEW
   * credential without one is refused (there would be nothing to encrypt).
   */
  async upsertCredential(
    workspaceId: string,
    input: z.infer<typeof upsertCredentialSchema>,
  ): Promise<CredentialView> {
    await assertWorkspace(workspaceId);
    // Refuse non-owned kinds BEFORE name validation: their refs are datasource
    // or trigger names, not env-var identifiers, so the name regex would reject
    // them with a confusing 400 instead of the 409 that names the owner.
    const rawKind = (input as { kind?: unknown }).kind;
    if (
      typeof rawKind === "string" &&
      (CREDENTIAL_KINDS as readonly string[]).includes(rawKind) &&
      !SECRET_OWNED_KINDS.has(rawKind as CredentialKind)
    ) {
      throw refusal(
        `"${rawKind}" credentials are managed by their own surface — ` +
          (rawKind === "database"
            ? "edit them on the data sources page"
            : "edit them on the triggers page"),
      );
    }
    input = upsertCredentialSchema.parse(input);

    if (!SECRET_OWNED_KINDS.has(input.kind)) {
      throw refusal(
        `"${input.kind}" credentials are managed by their own surface — ` +
          (input.kind === "database"
            ? "edit them on the data sources page"
            : "edit them on the triggers page"),
      );
    }

    await assertNotConnectionCredential(workspaceId, [input.name], "cannot be changed here");
    const existing = await workspaceSecretRepo.getByName(workspaceId, input.name);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (input.value !== undefined) patch.valueEnc = encrypt(input.value);
      if (input.label !== undefined) patch.label = input.label;
      if (existing.kind !== input.kind) patch.kind = input.kind;
      if (Object.keys(patch).length === 0) return toSecretView(existing);
      const s = await workspaceSecretRepo.update(workspaceId, existing.id, patch);
      return toSecretView(s!);
    }

    if (input.value === undefined) {
      throw refusal(
        `a new "${input.kind}" credential needs a value — there is nothing to store yet`,
        400,
      );
    }

    const s = await workspaceSecretRepo.create({
      workspaceId,
      name: input.name,
      description: null,
      kind: input.kind,
      label: input.label ?? null,
      valueEnc: encrypt(input.value),
      sandboxValueEnc: null,
    });
    return toSecretView(s);
  },

  /**
   * Delete through the seam, by ref. Only secret-backed kinds are deletable
   * here; a ref that names a datasource or a webhook/api trigger is refused
   * with the owning surface rather than deleted out from under it. An unknown
   * ref is a 404 — the same clean refusal `resolveCredential` gives.
   */
  async deleteCredential(workspaceId: string, ref: string): Promise<boolean> {
    await assertWorkspace(workspaceId);

    const secret = await workspaceSecretRepo.getByName(workspaceId, ref);
    if (secret) {
      await assertNotConnectionCredential(workspaceId, [secret.name], "cannot be removed here");
      return workspaceSecretRepo.remove(workspaceId, secret.id);
    }

    if (await datasourceRepo.getByName(workspaceId, ref)) {
      throw refusal(
        `"${ref}" is a database credential — remove it from the data sources page`,
      );
    }

    const trigger = await triggerRepo.getByName(workspaceId, ref);
    if (trigger && (trigger.type === "webhook" || trigger.type === "api")) {
      throw refusal(
        `"${ref}" is a ${trigger.type} trigger credential — remove it from the triggers page`,
      );
    }

    throw refusal(`no credential named "${ref}" exists in this workspace`, 404);
  },
};
