import { createHmac } from "node:crypto";

/**
 * Per-service credentials, derived from one root key.
 *
 * ── Why derived rather than five environment variables ──────────────────────
 *
 * Two processes must agree on these values: ops-api checks them, and the parent
 * seeds them into `workspace_secrets` so the step executor can present them.
 * Five literal variables in compose is five chances for the two sides to be
 * configured differently, and the failure would be a 401 that names nothing.
 * One root (`OPS_API_KEY`) plus a deterministic derivation means there is one
 * thing to keep in step.
 *
 * ── Why the derivation is DUPLICATED in the parent, and why that is fine here ─
 *
 * `demo/tool-catalogue.ts` computes the same values so it can register them.
 * That is a second copy of four lines, which the same reasoning that produced
 * `@foundry/redact` would normally reject — so the distinction matters:
 *
 *   * redaction drifting is **silent**. Each copy keeps passing its own tests
 *     while the two disagree about what a secret looks like, and nobody learns
 *     until a credential is in a screenshot.
 *   * this drifting is **loud and immediate**. The two sides no longer agree on
 *     a value, so the very first tool call 401s with `auth_ok: false` and the
 *     call log names the service.
 *
 * A shared package would also mean the control plane taking a build dependency
 * on the service it registers, which is the wrong direction for a four-line
 * pure function.
 *
 * ── Why one style per service ───────────────────────────────────────────────
 *
 * Each service accepts exactly ONE auth style and rejects the others even when
 * the value is right. An endpoint that accepts every style cannot detect a
 * wrong guess, and "the automation authenticated the wrong way" is precisely the
 * failure worth being able to see — it is recorded as
 * `presented: true, ok: false, via: <where it arrived>`.
 */
export type OpsService = "hr" | "mail" | "chat" | "ticketing" | "probe" | "llm" | "paging";

/** The env-var NAME each service's credential is stored and rendered under. */
export const OPS_SECRET_ENV: Record<OpsService, string> = {
  hr: "HR_DIRECTORY_TOKEN",
  mail: "MAIL_API_KEY",
  chat: "CHAT_ACCESS_TOKEN",
  // Unchanged from the pre-Stage-5 name, so an existing workspace secret and an
  // existing tool registration keep working.
  ticketing: "TICKETING_API_KEY",
  probe: "OPS_PROBE_BASIC",
  // ⚠ This is the credential a FLOW presents to ops-api. It is NOT the provider
  // key ops-api presents to the LLM gateway — that one lives in `llm_provider`,
  // is set by an operator, and never leaves this process. Two credentials, two
  // directions; naming them apart is the whole reason this one is not called
  // `LLM_API_KEY`.
  llm: "LLM_TOOL_TOKEN",
  // ⚠ A PAGE IS NOT AN EMAIL, and the separate credential is the first place
  // that is said. Waking somebody at 03:00 is the most expensive thing an
  // automation in this product can do, so it is reached through its own service
  // with its own credential — which means a workspace can hold the ability to
  // send mail and NOT the ability to page, and revoking one leaves the other.
  paging: "PAGING_API_TOKEN",
};

/**
 * How each service expects its credential. Mirrors `tools.auth_style` /
 * `tools.auth_param_name` on the parent side — one identifier, so the manifest,
 * the registration and the endpoint cannot disagree.
 */
export const OPS_AUTH_STYLE: Record<OpsService, { style: string; paramName: string | null }> = {
  hr: { style: "bearer", paramName: null },
  mail: { style: "header", paramName: "X-Mail-Key" },
  chat: { style: "query", paramName: "access_token" },
  ticketing: { style: "header", paramName: "X-API-Key" },
  // `basic` expects the stored value to be `user:pass`; the executor base64s it.
  probe: { style: "basic", paramName: null },
  // A distinct header rather than `bearer`, deliberately. The outbound call this
  // service makes carries `Authorization: Bearer <provider key>`; keeping the
  // inbound credential out of that header means a bug that confused the two
  // would present as a 401 here rather than as this service's own credential
  // being offered to a third party.
  llm: { style: "header", paramName: "X-LLM-Key" },
  // `bearer`, which is what real paging services use. It also happens to be the
  // style Finance and Legal do not exercise — but that is a consequence, not the
  // reason: inventing a service to fill in a style table would be building
  // something to satisfy a checklist, which `legal-tools.ts` says in as many
  // words. `hr` is the other bearer service and its credential is different, so
  // presenting HR's token here is a 401 rather than a cross-service pass.
  paging: { style: "bearer", paramName: null },
};

/**
 * The credential for one service.
 *
 * ⚠ `probe` returns a `user:pass` pair because that is what HTTP Basic needs and
 * what `applyAuth`'s `basic` branch expects to be handed. The others are opaque
 * strings.
 */
export function opsServiceKey(root: string, service: OpsService): string {
  const digest = createHmac("sha256", root).update(`ops-api:${service}:v1`).digest("hex").slice(0, 40);
  return service === "probe" ? `probe:${digest}` : digest;
}
