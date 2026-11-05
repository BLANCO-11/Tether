import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  credentialProviderService,
  upsertCredentialSchema,
} from "../services/credential-provider.service.js";

/**
 * Phase 5 — /api/workspaces/:workspaceId/credentials
 *
 * The unified credential surface. One list over the three existing encrypted
 * stores (`workspace_secrets`, datasource DSNs, trigger tokens), grouped by the
 * client.
 *
 * ⚠ There is deliberately NO read endpoint for a value — the same rule the
 * secrets surface has always kept (`workspace-secrets.ts`). `listCredentials`
 * returns `hasValue` booleans and nothing else; `resolveCredential` is
 * server-side only and has no route here. Adding one "for the UI" is how a
 * credential ends up in a browser devtools network log.
 */
export const credentialsRouter = Router({ mergeParams: true });

credentialsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ credentials: await credentialProviderService.listCredentials(req.params.workspaceId) });
  }),
);

credentialsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = upsertCredentialSchema.parse(req.body);
    const credential = await credentialProviderService.upsertCredential(
      req.params.workspaceId,
      input,
    );
    res.status(201).json({ credential });
  }),
);

/**
 * Delete by REF (the env-var name for secret-backed kinds). The seam refuses —
 * 409 — when the ref names a datasource or webhook/api trigger it does not own,
 * so the unified page cannot delete a credential behind another surface's back.
 */
credentialsRouter.delete(
  "/:ref",
  asyncHandler(async (req, res) => {
    await credentialProviderService.deleteCredential(req.params.workspaceId, req.params.ref);
    res.status(204).send();
  }),
);
