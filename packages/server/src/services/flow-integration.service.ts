import { flowRepo } from "../repositories/flow.repo.js";
import { triggerRepo } from "../repositories/trigger.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { config } from "../config/index.js";

/**
 * `flowIntegrationService` — everything a person needs to call an approved flow
 * from outside, assembled in ONE place.
 *
 * ── Why this is one read and not four ────────────────────────────────────────
 *
 * The facts are spread across four tables — the flow's armed revision, its
 * declared inputs, its triggers, and the workspace secret that may or may not
 * be what a Bearer header is compared against. A screen that fetched them
 * separately would be free to render a URL beside "ready" while the flow is not
 * approved, or a Bearer example that 401s. So the assembly is server-side and
 * the client renders what it is given.
 *
 * ⚠ **It states what is MISSING as plainly as what is ready.** An endpoint
 * section that renders only when everything is in place is one a person stares
 * at wondering why it is blank.
 */

export interface FlowInputDecl {
  id: string;
  type: string;
  required: boolean;
}

/**
 * Where the Bearer value for an `api` trigger actually comes from.
 *
 * ⚠ **THIS IS THE ONE THING THIS FEATURE EXISTS TO SAY OUT LOUD.**
 * `credentialProviderService.resolveCredential` resolves the trigger's NAME in
 * a fixed precedence — `workspace_secrets`, then datasources, then the trigger
 * row — and the api receiver requires the resolved credential's kind to be
 * `api`. Three outcomes, and two of them surprise people:
 *
 *  - `workspace_secret` — a secret of that name with kind `api` exists. The
 *    Bearer is a genuinely separate value. This is the arrangement to want.
 *  - `trigger_token` — no such secret, so it falls back to the trigger row and
 *    the Bearer is **byte-identical to the token already in the URL**. The call
 *    is authenticated in the sense that the token must be presented twice, and
 *    in no stronger sense. ⚠ **Never call that "credential-authenticated"
 *    unqualified** — anyone holding the URL holds the credential.
 *  - `wrong_kind` — a secret of that name exists with some OTHER kind, so the
 *    receiver's `kind === "api"` check fails and **every call 401s**, including
 *    one presenting exactly the right value. Nothing else in the product says
 *    this, and the 401 is deliberately silent about which part failed.
 */
export type BearerSource = "workspace_secret" | "trigger_token" | "wrong_kind";

export interface FlowEndpoint {
  triggerId: string;
  name: string;
  type: "webhook" | "api";
  /** The public path, token included. Null when the trigger has no token. */
  path: string | null;
  /**
   * ⚠ Reported, with NO reason beside it. `triggerService.enableReadiness()` is
   * the real gate and it is the only thing that may explain itself — a second,
   * weaker implementation here would eventually disagree with the one that
   * actually refuses, in the direction where this page says "ready". The
   * triggers surface is where a blocked trigger explains itself.
   */
  enabled: boolean;
  auth: "bearer" | "none";
  /** `api` only. See `BearerSource`. */
  bearerSource: BearerSource | null;
}

export interface FlowIntegration {
  /**
   * The origin a caller reaches this deployment's API at, or null.
   *
   * ⚠ **Null is the honest answer and the page must render the path alone.**
   * The browser's own origin is the WEB app (:4002) and the receiver is on the
   * API (:4000), so building a URL from `window.location` produces one that
   * looks right and does not work — which is worse than an incomplete example a
   * person completes themselves. Set `PUBLIC_API_BASE_URL` to fill it in.
   */
  baseUrl: string | null;
  /** True when an approved revision is armed — the only state these URLs fire. */
  live: boolean;
  /** Why not, when not. Null when live. */
  liveBlockedReason: string | null;
  /** The armed revision's declared inputs — the body's `inputs` object. */
  inputs: FlowInputDecl[];
  endpoints: FlowEndpoint[];
}

async function bearerSourceFor(workspaceId: string, triggerName: string): Promise<BearerSource> {
  const secret = await workspaceSecretRepo.getByName(workspaceId, triggerName);
  if (!secret) return "trigger_token";
  return secret.kind === "api" ? "workspace_secret" : "wrong_kind";
}

async function get(workspaceId: string, flowId: string): Promise<FlowIntegration> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) {
    const e = new Error("flow not found") as Error & { statusCode?: number };
    e.statusCode = 404;
    throw e;
  }

  const revision = flow.armedRevision;
  const live = revision != null && revision >= 1;

  // ⚠ Read from the ARMED revision, never the draft. The body a caller must
  // send is the one the deployed flow declares; showing the draft's inputs
  // would document a request the live namespace refuses.
  let inputs: FlowInputDecl[] = [];
  if (live) {
    const row = await flowRepo.getRevision(flow.id, revision!);
    const model = (row?.modelJson ?? null) as {
      inputs?: Array<{ id: string; type?: string; required?: boolean }>;
    } | null;
    inputs = (model?.inputs ?? []).map((i) => ({
      id: i.id,
      type: i.type ?? "string",
      required: i.required === true,
    }));
  }

  const triggers = (await triggerRepo.listByFlow(flow.id)).filter(
    (t) => t.type === "webhook" || t.type === "api",
  );

  const endpoints: FlowEndpoint[] = [];
  for (const t of triggers) {
    const type = t.type as "webhook" | "api";
    endpoints.push({
      triggerId: t.id,
      name: t.name,
      type,
      path: t.webhookToken ? `/api/triggers/${t.webhookToken}/${type}` : null,
      enabled: t.enabled === true,
      auth: type === "api" ? "bearer" : "none",
      bearerSource: type === "api" ? await bearerSourceFor(workspaceId, t.name) : null,
    });
  }

  return {
    baseUrl: config.publicApiBaseUrl,
    live,
    liveBlockedReason: live
      ? null
      : "This flow has no approved revision armed, so none of these URLs will start a run yet.",
    inputs,
    endpoints,
  };
}

export const flowIntegrationService = { get };
