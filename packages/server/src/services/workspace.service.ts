import { z } from "zod";
import { workspaceRepo, type Workspace } from "../repositories/workspace.repo.js";
import { registerPlatformTools } from "./platform-tool-catalogue.js";

/**
 * ⚠ **Creating a workspace provisions NOTHING in an external runtime, and a
 * field that says it does is not coming back** (task 1.8, I-131).
 *
 * There was one. It defaulted to `false` and **no caller anywhere passed
 * `true`** — the four provisioners, the slug test and the client all passed
 * `false` or nothing — so the per-workspace tenant it was supposed to create
 * never once existed, and the two columns holding its result were permanently
 * NULL (measured before the drop: **4 workspaces, 0 with either value**). Redis
 * again (GAPS §6.4): every signal a reader could look at said the feature
 * existed, and only a grep said otherwise.
 */
/**
 * The PURPOSE (2026-10-12) is the workspace's `description`: one sentence saying what it is for, required when a
 * workspace is created and given to Forge on every turn so it stays on topic. Steering, not security. Existing
 * workspaces may have none; a purpose once given cannot be emptied.
 */
const purpose = z
  .string()
  .trim()
  .min(10, "Say in a sentence what this workspace is for (at least 10 characters).")
  .max(500, "Keep the purpose to one or two sentences (500 characters at most).");
export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  description: purpose,
  /** Assistant mode — off unless chosen. */
  assistant: z.boolean().optional(),
  /** Forge Agent may propose changes the person confirms (plugins phase 6) — off unless chosen. */
  agentChanges: z.boolean().optional(),
  /** Restricted: closed to everyone above it; its creator becomes its first admin (restricted-workspaces). */
  restricted: z.boolean().optional(),
});
export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: purpose.optional(),
  assistant: z.boolean().optional(),
  agentChanges: z.boolean().optional(),
  /** Members may switch on their own automations that use only their own things (plugins phase 9). */
  selfEnable: z.boolean().optional(),
  /** Workflows and Forge may read public web addresses (`web_fetch`, 0133). On by default. */
  webAccess: z.boolean().optional(),
});

/**
 * What the SERVICE takes. The purpose is required of a PERSON creating a workspace (the route parses
 * `createWorkspaceSchema`); seeds and harnesses that create workspaces directly may leave it out.
 */
export type CreateWorkspaceInput = { name: string; description?: string | null; assistant?: boolean; agentChanges?: boolean };
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

/**
 * ⚠ There is no runtime key on a workspace to leak any more — this comment used
 * to guard one, and the column is gone (1.8). The shape also dropped the two
 * fields that reported it, which were permanently `null`/`false`: a public API
 * field that can only ever hold one value is a feature the client can see and
 * never use.
 */
export function toPublicWorkspace(w: Workspace) {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    /** Assistant mode: Forge does everyday tasks here too, and answers from the real data, read-only. */
    assistant: w.assistant === true,
    /** Forge Agent may propose changes to connected services, each run by the person's own click. Needs `assistant`. */
    agentChanges: w.assistant === true && w.agentChanges === true,
    /** Members may switch on their own automations that use only their own things, with no reviewer (phase 9). */
    selfEnable: w.selfEnable !== false,
    /** Workflows and Forge may read public web addresses (`web_fetch`, 0133). On unless its admins switched it off. */
    webAccess: w.webAccess !== false,
    /** Closed to everyone above it: platform admins see its name and admins only (restricted-workspaces). */
    restricted: w.restricted === true,
    // `null` for a real tenant, `"fixture"` for one that exists to serve a
    // harness. Exposed so the UI can SAY SO rather than hide it: a hidden
    // workspace is one nobody notices has broken, and `demo:rehearse` depends
    // on this one existing.
    kind: w.kind ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

/**
 * The single tenant segment, until there is a tenant model (D-03).
 *
 * Mandatory rather than optional even so: `<prefix>.<tenant>.<workspace>` needs
 * three segments for `resolveWorkspaceFromNamespace` to work at all, and
 * `foundry.system` deliberately has two so a system flow can never resolve to a
 * workspace (D-09).
 */
const DEFAULT_TENANT_SLUG = "default";

/**
 * Byte-for-byte the expression migration 0010 backfilled existing rows with:
 * lowercase, every run of non-`[a-z0-9_-]` to a hyphen, trimmed. Written the
 * same way on purpose — a workspace created today and one backfilled then must
 * produce the same namespace from the same name, or two deployments of the same
 * product address different namespaces.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Assign the IMMUTABLE namespace slug at creation.
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 *
 * `slug` and `tenant_slug` were added by migration 0010 with a one-time backfill
 * and nothing ever wrote them again. So the three workspaces that predate the
 * migration have slugs, and **every workspace created through the product since
 * has had NULL for both** — which `tenantMapper.namespacesFor` turns into a 409
 * at the first deploy. The workspace looks completely healthy: it has tools, a
 * datasource, queries and a manifest, and the only thing it cannot do is run
 * anything. Found when provisioning the Finance workspace, which came out with
 * an empty slug and would have blocked every flow authored in it.
 *
 * ── Uniqueness, and why it is checked here ───────────────────────────────────
 *
 * `workspaceRepo.getBySlugs` resolves `(tenantSlug, slug)` to ONE row and Kestra
 * addresses a namespace by that pair, so two workspaces sharing it is not a
 * cosmetic clash — it is two tenants' flows in one namespace. Migration 0011
 * adds the unique index; this loop is what turns a would-be constraint violation
 * into a usable second slug ("finance-2") rather than a 500 on a legitimate
 * "same name, different workspace".
 */
async function assignSlug(name: string, tenantSlug: string): Promise<string> {
  // A name that is entirely punctuation slugifies to "" and `namespaceFor`
  // rejects an empty segment — with a message about slugification, in a stack
  // that started at "create workspace". Fall back rather than throw.
  const base = slugify(name) || "workspace";
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await workspaceRepo.getBySlugs(tenantSlug, candidate))) return candidate;
  }
  throw new Error(
    `could not assign a unique slug for workspace "${name}" — 50 variants of "${base}" are taken`,
  );
}

export const workspaceService = {
  async list() {
    return (await workspaceRepo.list()).map(toPublicWorkspace);
  },

  async get(id: string) {
    const w = await workspaceRepo.get(id);
    return w ? toPublicWorkspace(w) : undefined;
  },

  async create(input: CreateWorkspaceInput) {
    const tenantSlug = DEFAULT_TENANT_SLUG;
    const w = await workspaceRepo.create({
      name: input.name,
      description: input.description ?? null,
      assistant: input.assistant === true,
      agentChanges: input.assistant === true && input.agentChanges === true,
      // Assigned once, here, and never written again — `update` takes a name and
      // deliberately cannot touch these. A renamed workspace keeps its
      // namespace, or its deployed flows and execution history detach from it.
      slug: await assignSlug(input.name, tenantSlug),
      tenantSlug,
    });

    /**
     * Platform tools — currently just `tether_email_send` (email-send-tool T032).
     *
     * ⚠ Registered **unconditionally**, even when Graph is unconfigured. An absent
     * tool makes the drafter compose a flow around a capability that is not in the
     * manifest, which surfaces as "unknown tool" and a wasted redraft cycle; a
     * present-but-unconfigured tool answers `424` naming exactly which variables
     * to set. The second is a deployment telling the truth about itself.
     *
     * ⚠ It must not be able to fail workspace creation. A workspace with no email
     * tool is a workspace missing one capability; a create that 500s leaves a
     * caller with no workspace at all and a row that may or may not exist. So this
     * is logged loudly and swallowed — the deliberate opposite of
     * `email-send.repo.ts`'s no-swallow rule, because there the lost thing is
     * evidence of a real send and here it is a registration `mail:register` can
     * redo at any time.
     */
    try {
      await registerPlatformTools(w.id);
    } catch (e) {
      console.error(
        `[workspace] platform tool registration failed for ${w.id} — run \`mail:register\` to fix`,
        e,
      );
    }

    return toPublicWorkspace(w);
  },

  async update(id: string, input: UpdateWorkspaceInput) {
    const w = await workspaceRepo.update(id, input);
    return w ? toPublicWorkspace(w) : undefined;
  },

  async remove(id: string) {
    return workspaceRepo.softDelete(id);
  },
};
