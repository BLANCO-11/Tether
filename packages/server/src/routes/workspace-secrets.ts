import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import {
  workspaceSecretService,
  createSecretSchema,
  updateSecretSchema,
} from "../services/workspace-secret.service.js";

/**
 * WS-B.3 — /api/workspaces/:workspaceId/secrets
 *
 * There is deliberately NO read endpoint for a secret's value, and no `?reveal=`
 * escape hatch. Values leave the server exactly twice: as a `-e` flag on an
 * execution container, and as a generation-time secret. Adding a
 * read endpoint "for the UI" is how a credential ends up in a browser devtools
 * network log.
 */
export const workspaceSecretsRouter = Router({ mergeParams: true });

workspaceSecretsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ secrets: await workspaceSecretService.list(req.params.workspaceId) });
  }),
);

/**
 * Which declared secrets have no stored value, and which names collide. This is
 * the answer to "why did my tool call 401?" before anyone has to ask it.
 */
workspaceSecretsRouter.get(
  "/audit",
  asyncHandler(async (req, res) => {
    res.json(await workspaceSecretService.audit(req.params.workspaceId));
  }),
);

workspaceSecretsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createSecretSchema.parse(req.body);
    res.status(201).json({ secret: await workspaceSecretService.create(req.params.workspaceId, input) });
  }),
);

/**
 * What renaming or deleting this secret would break, WITHOUT doing it.
 *
 * ⚠ A GET, and separate from PATCH on purpose — the same split
 * `datasources/:dsId/queries/:name/impact` makes (D-84). A client has to be able
 * to ask BEFORE it writes, because the consequence here is not visible after:
 * nothing is suspended, no fingerprint moves and no manifest changes. The
 * reference simply stops resolving, and the first sign is a 401 inside a run.
 *
 * ⚠ It returns names and counts and NOTHING from a value. `references` names
 * tools; `nameTaken` is a boolean. There is still no path that reads a secret.
 */
workspaceSecretsRouter.get(
  "/:id/impact",
  asyncHandler(async (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name : undefined;
    const out = await workspaceSecretService.renameImpact(
      req.params.workspaceId,
      req.params.id,
      name,
    );
    if (!out) return res.status(404).json({ error: "not_found" });
    res.json(out);
  }),
);

/**
 * ⚠ A rename that orphans a reference is REFUSED with a 409 unless the body
 * carries `confirmOrphans: true`. The refusal is in the service, so this route
 * cannot be the place it is forgotten; what it adds is that the 409's body
 * carries the impact, so a client does not have to re-ask to render the list.
 */
workspaceSecretsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = updateSecretSchema.parse(req.body);
    const out = await workspaceSecretService.update(req.params.workspaceId, req.params.id, input);
    if (!out) return res.status(404).json({ error: "not_found" });
    res.json(out);
  }),
);

workspaceSecretsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const ok = await workspaceSecretService.remove(req.params.workspaceId, req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.status(204).send();
  }),
);
