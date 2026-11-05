import { z } from "zod";
import { flowTemplateRepo, type FlowTemplate } from "../repositories/flow-template.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import {
  exportFlow,
  importFlow,
  planImport,
  flowBundleSchema,
  httpError,
  type FlowBundle,
  type ImportResult,
} from "./flow-portability.service.js";
import { inference, type InferenceClient } from "./inference.service.js";
import type { RevisionAuthor } from "./revision-author.js";

/**
 * The per-tenant template library — phase 6.4.
 * archive/kestra-migration/08-scale-and-phasing.md §10 "Phase 6"
 *
 * A thin layer over `flow-portability.service.ts`, and thin on purpose: a
 * template IS a bundle, so "create from template" is an import and inherits every
 * check an import has — ref revalidation, the expression allowlist, generation
 * before deploy, no live namespace. A template library with its own instantiation
 * path would be a second way into the same place, and the second way is the one
 * that ends up missing a check.
 *
 * The one thing this layer adds is the snapshot rule: `bundle_json` is captured
 * at save time and never refreshed from its source flow. See the table's docblock
 * in `db/schema.ts` — a template that tracked a live flow would make "create from
 * template" mean *"whatever that automation happens to be right now"*.
 */

export const saveTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  /** Which revision to snapshot. Defaults to the flow's draft. */
  revision: z.number().int().min(0).optional(),
  createdBy: z.string().min(1).max(255).optional(),
});

export const instantiateTemplateSchema = z.object({
  /** Origin ref → local ref. Explicit only; nothing is guessed (see `planImport`). */
  refMap: z.record(z.string().max(128)).optional(),
  modelId: z.string().min(1).max(63).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  /** Raw and untrusted — the input to `authorOf()`. See `createFlowSchema`. */
  createdBy: z.string().min(1).max(255).optional(),
});

/**
 * Instantiating a template creates a REVISION, so it needs an attestation for
 * the same reason an import does (archive/GAPS.md §1.2). The template's own
 * `created_by` is not it: a template is a snapshot somebody else saved, and the
 * author of the flow made from it is whoever pressed the button here.
 */
export type InstantiateTemplateInput = Omit<
  z.infer<typeof instantiateTemplateSchema>,
  "createdBy"
> & { author: RevisionAuthor };

export const flowTemplateService = {
  /** Snapshot a flow revision into the library. */
  async saveFromFlow(
    workspaceId: string,
    flowId: string,
    input: z.infer<typeof saveTemplateSchema>,
  ): Promise<FlowTemplate> {
    const ws = await workspaceRepo.get(workspaceId);
    const bundle = await exportFlow(workspaceId, flowId, {
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(ws?.name ? { workspaceName: ws.name } : {}),
      exportedAt: new Date().toISOString(),
    });

    const existing = (await flowTemplateRepo.listByWorkspace(workspaceId)).find(
      (t) => t.name === input.name,
    );
    if (existing) {
      // Not an upsert. Silently replacing a template would change what every
      // future "create from template" produces, with no revision history to
      // notice it by — the library has no equivalent of `flow_revisions`.
      throw httpError(
        `a template named "${input.name}" already exists in this workspace. Delete it or choose ` +
          `another name — templates are snapshots and are never updated in place.`,
        409,
      );
    }

    return flowTemplateRepo.create({
      workspaceId,
      name: input.name,
      description: input.description ?? bundle.flow.description ?? null,
      bundleJson: bundle,
      sourceFlowId: flowId,
      sourceRevision: bundle.source.revision,
      createdBy: input.createdBy ?? null,
    });
  },

  /** Save a bundle someone pasted in, without it having been a flow here first. */
  async saveFromBundle(
    workspaceId: string,
    name: string,
    input: unknown,
    opts: { description?: string; createdBy?: string } = {},
  ): Promise<FlowTemplate> {
    const parsed = flowBundleSchema.safeParse(input);
    if (!parsed.success) {
      throw httpError(
        `not a valid flow bundle: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
        400,
      );
    }
    return flowTemplateRepo.create({
      workspaceId,
      name,
      description: opts.description ?? parsed.data.flow.description ?? null,
      bundleJson: parsed.data,
      sourceFlowId: null,
      sourceRevision: parsed.data.source.revision,
      createdBy: opts.createdBy ?? null,
    });
  },

  list(workspaceId: string) {
    return flowTemplateRepo.listByWorkspace(workspaceId);
  },

  async get(workspaceId: string, id: string): Promise<FlowTemplate> {
    const row = await flowTemplateRepo.get(workspaceId, id);
    if (!row) throw httpError("template not found", 404);
    return row;
  },

  /**
   * What instantiating this template here would find — the findings, before an
   * inference call is spent. This is what a "use template" dialog renders: a
   * template written in a workspace with `hr_demo.*` queries and instantiated
   * somewhere without them is the common case, not the exception, and the useful
   * answer is a list of refs to map rather than a failed create.
   */
  async plan(workspaceId: string, id: string, refMap: Record<string, string> = {}) {
    const row = await this.get(workspaceId, id);
    return planImport(workspaceId, row.bundleJson as FlowBundle, refMap);
  },

  async instantiate(
    workspaceId: string,
    id: string,
    input: InstantiateTemplateInput,
    client: InferenceClient = inference,
  ): Promise<ImportResult> {
    const row = await this.get(workspaceId, id);
    return importFlow(
      workspaceId,
      row.bundleJson,
      {
        ...(input.refMap ? { refMap: input.refMap } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.description ? { description: input.description } : {}),
        author: input.author,
      },
      client,
    );
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    return flowTemplateRepo.remove(workspaceId, id);
  },
};
