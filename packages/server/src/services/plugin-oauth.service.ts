/**
 * Connecting a service by signing in (OAuth) — plans/plugins-2026-10-27, phase 4.
 *
 * ⚠ **Nothing here is written per provider.** A piece DECLARES its sign-in: the authorize and token addresses (with
 * `{prop}` placeholders a connection fills, e.g. Teams' `{tenantId}`), its scopes, PKCE, how the client authenticates
 * at the token address, and any extra parameters. This module is the one generic flow over that declaration:
 *
 *   start    → a single-use `state` (only its hash is kept) and, where declared, a PKCE verifier (encrypted);
 *              answers the provider's authorize URL. The browser goes there; the person consents there.
 *   callback → the provider sends the browser back to `<publicUrl>/api/oauth/callback` (a Next route), which posts the
 *              code here. The state must exist, be unexpired, and belong to THIS person in THIS workspace.
 *   refresh  → before each use (`freshConnection`), a token that expires within a minute is renewed and written back.
 *
 * What a provider needs from us, once, is an app registered with our return address: a platform administrator's
 * client id and secret (`plugin_oauth_apps`), or — for Microsoft — Foundry's own sign-in app (decision 3).
 *
 * ⚠ The stored value carries the refresh token and the token address; `forConnector` strips both before a value
 * travels to the connector. A piece gets the access token, its props and the provider's non-secret answer only.
 */
import crypto from "node:crypto";
import { config } from "../config/index.js";
import { pluginRepo, type PluginOauthApp, type PluginOauthState } from "../repositories/plugin.repo.js";
import { workspaceSecretRepo } from "../repositories/workspace-secret.repo.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import { StepError } from "./step-error.js";

export type OauthDecl = {
  authUrl: string | null;
  tokenUrl: string | null;
  scope: string[];
  grantType: string | null;
  pkce?: boolean;
  pkceMethod?: "plain" | "S256" | null;
  authorizationMethod?: "HEADER" | "BODY";
  extra?: Record<string, string>;
  prompt?: string | null;
};

/** What is stored, encrypted, as an OAuth connection's value. */
export type OauthValue = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  /** Seconds since the epoch at which the token was issued. */
  claimed_at: number;
  token_url: string;
  authorization_method: "HEADER" | "BODY";
  props: Record<string, unknown>;
  /** The provider's answer, minus every token. Some pieces read from it (an instance URL, a tenant). */
  data: Record<string, unknown>;
};

export const CALLBACK_PATH = "/api/oauth/callback";
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_S = 60;

export function redirectUri(): string {
  return `${config.plugins.publicUrl}${CALLBACK_PATH}`;
}

/** Microsoft's identity platform — the only provider Foundry's own sign-in app can sign in to. */
export function isMicrosoft(decl: Pick<OauthDecl, "authUrl">): boolean {
  return /login\.microsoftonline\.com|\{cloud\}/.test(decl.authUrl ?? "");
}

export function signInAppAvailable(): boolean {
  return !!(config.plugins.signInApp.clientId && config.plugins.signInApp.clientSecret);
}

/**
 * Where a person creates the app at the provider, when we know it — a convenience on the setup screen, keyed on the
 * provider's authorize HOST, never on a connector.
 */
export function newAppUrl(decl: Pick<OauthDecl, "authUrl">): string | null {
  const host = (() => {
    try {
      return new URL((decl.authUrl ?? "").replace(/\{[^}]+\}/g, "x")).hostname;
    } catch {
      return "";
    }
  })();
  if (host === "github.com") return "https://github.com/settings/applications/new";
  if (host === "accounts.google.com") return "https://console.cloud.google.com/apis/credentials";
  if (host === "gitlab.com") return "https://gitlab.com/-/user_settings/applications";
  if (host.endsWith("atlassian.com")) return "https://developer.atlassian.com/console/myapps/";
  if (host === "slack.com") return "https://api.slack.com/apps";
  if (isMicrosoft(decl)) return "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
  return null;
}

/** The scopes an app asks for: the stored narrowing, else the piece's own list. */
export function effectiveScopes(decl: OauthDecl, app: Pick<PluginOauthApp, "scopes"> | undefined): string[] {
  return app?.scopes?.length ? app.scopes : decl.scope;
}

/** Narrow only: a scope the piece does not declare is refused, so an app can never ask for more than the piece. */
export function checkScopes(decl: OauthDecl, scopes: string[] | undefined): string[] {
  const want = [...new Set((scopes ?? []).map((s) => s.trim()).filter(Boolean))];
  const extra = want.filter((s) => !decl.scope.includes(s));
  if (extra.length) throw new StepError(`not scopes this connector declares: ${extra.join(", ")} (scopes can be narrowed, never widened)`, 400);
  return want;
}

/** The client a sign-in uses: the app's own, or Foundry's sign-in app. Throws when neither is set up. */
export function clientFor(app: PluginOauthApp | undefined): { clientId: string; clientSecret: string } {
  if (!app) throw new StepError("sign-in for this connector is not set up yet: an administrator enters its OAuth app first", 409);
  if (app.useSignInApp) {
    if (!signInAppAvailable()) throw new StepError("this connector signs in with Tether's sign-in app, which is not configured (AUTH_MICROSOFT_ENTRA_ID_*)", 503);
    return { clientId: config.plugins.signInApp.clientId, clientSecret: config.plugins.signInApp.clientSecret };
  }
  if (!app.clientId) throw new StepError("this connector's OAuth app has no client id", 409);
  return { clientId: app.clientId, clientSecret: app.clientSecretEnc ? decrypt(app.clientSecretEnc) : "" };
}

/** `https://{cloud}/{tenantId}/…` with the connection's props. ⚠ A value is URL-encoded and may not contain a slash. */
export function fillTemplate(url: string, props: Record<string, unknown>): string {
  return url.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = props[name];
    if (v === undefined || v === null || String(v).trim() === "") throw new StepError(`"${name}" is needed to sign in`, 400);
    const s = String(v).trim();
    if (/[/?#@\s]/.test(s)) throw new StepError(`"${name}" may not contain / ? # @ or spaces`, 400);
    return encodeURIComponent(s);
  });
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const hashState = (state: string) => crypto.createHash("sha256").update(state).digest("hex");

/** The authorize URL for one sign-in. Pure but for the random state and verifier, which it returns. */
export function authorizeUrl(
  decl: OauthDecl,
  input: { clientId: string; scopes: string[]; props: Record<string, unknown>; workspaceId: string },
): { url: string; state: string; verifier: string | null } {
  if (!decl.authUrl) throw new StepError("this connector declares no sign-in address", 422);
  // The workspace rides in front of the state so the browser's return can be routed to its workspace's guard; the
  // random half is what authorises, and only its hash is stored.
  const state = `${input.workspaceId}.${b64url(crypto.randomBytes(32))}`;
  const verifier = decl.pkce ? b64url(crypto.randomBytes(48)) : null;
  const u = new URL(fillTemplate(decl.authUrl, input.props));
  const q = u.searchParams;
  q.set("client_id", input.clientId);
  q.set("redirect_uri", redirectUri());
  q.set("response_type", "code");
  if (input.scopes.length) q.set("scope", input.scopes.join(" "));
  q.set("state", state);
  if (verifier) {
    q.set("code_challenge", decl.pkceMethod === "S256" ? b64url(crypto.createHash("sha256").update(verifier).digest()) : verifier);
    q.set("code_challenge_method", decl.pkceMethod === "S256" ? "S256" : "plain");
  }
  if (decl.prompt && decl.prompt !== "omit") q.set("prompt", decl.prompt);
  for (const [k, v] of Object.entries(decl.extra ?? {})) q.set(k, v);
  return { url: u.toString(), state, verifier };
}

/** One POST to a token address. Accepts a JSON or a form-encoded answer (GitHub sends the latter unless asked). */
export async function tokenRequest(
  tokenUrl: string,
  params: Record<string, string>,
  client: { clientId: string; clientSecret: string },
  method: "HEADER" | "BODY",
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (method === "HEADER") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  let res: Response;
  try {
    res = await fetch(tokenUrl, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new StepError(`the sign-in service could not be reached: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = Object.fromEntries(new URLSearchParams(text));
  }
  // GitHub answers 200 with `error` in the body; others answer 400. Both are a refusal, said in the provider's words.
  if (!res.ok || body.error || typeof body.access_token !== "string") {
    const why = [body.error, body.error_description].filter(Boolean).join(": ") || `answered ${res.status}`;
    throw new StepError(`the sign-in service refused: ${String(why).slice(0, 300)}`, 502);
  }
  return body;
}

/** The provider's answer as the stored value. Every token is lifted out of `data`. */
export function toValue(body: Record<string, unknown>, ctx: { tokenUrl: string; method: "HEADER" | "BODY"; props: Record<string, unknown>; prior?: OauthValue }): OauthValue {
  const { access_token, refresh_token, id_token: _id, ...rest } = body;
  const expires = Number(body.expires_in);
  return {
    access_token: String(access_token),
    // A refresh that does not rotate the refresh token keeps the old one.
    ...(typeof refresh_token === "string" && refresh_token ? { refresh_token } : ctx.prior?.refresh_token ? { refresh_token: ctx.prior.refresh_token } : {}),
    token_type: typeof body.token_type === "string" ? body.token_type : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : undefined,
    claimed_at: Math.floor(Date.now() / 1000),
    token_url: ctx.tokenUrl,
    authorization_method: ctx.method,
    props: ctx.props,
    data: rest,
  };
}

export function isOauthValue(v: unknown): v is OauthValue {
  return !!v && typeof v === "object" && typeof (v as OauthValue).access_token === "string" && typeof (v as OauthValue).token_url === "string";
}

/** Expires within the margin, and can be renewed. A token with no expiry (GitHub OAuth apps) is never refreshed. */
export function needsRefresh(v: OauthValue, nowS = Math.floor(Date.now() / 1000)): boolean {
  return !!v.refresh_token && !!v.expires_in && v.claimed_at + v.expires_in - REFRESH_MARGIN_S <= nowS;
}

/** ⚠ What reaches the connector: no refresh token, no token address. */
export function forConnector(v: OauthValue): Record<string, unknown> {
  return { access_token: v.access_token, token_type: v.token_type, scope: v.scope, expires_in: v.expires_in, claimed_at: v.claimed_at, props: v.props, data: v.data };
}

/** One refresh at a time per stored value: two concurrent runs must not both spend a rotating refresh token. */
const inFlight = new Map<string, Promise<OauthValue>>();

/**
 * The connection's value, renewed first if it is about to expire, in the shape the connector takes. Non-OAuth values
 * pass through unchanged. A failed renewal throws — the call cannot succeed on a dead token, and saying so by name
 * beats a 401 three calls deep.
 */
export async function freshConnection(workspaceId: string, secretName: string, piece: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isOauthValue(value)) return value;
  if (!needsRefresh(value)) return forConnector(value);
  const key = `${workspaceId}:${secretName}`;
  let p = inFlight.get(key);
  if (!p) {
    p = refresh(workspaceId, secretName, piece, value).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return forConnector(await p);
}

async function refresh(workspaceId: string, secretName: string, piece: string, value: OauthValue): Promise<OauthValue> {
  const client = clientFor(await pluginRepo.getOauthApp(piece));
  let body: Record<string, unknown>;
  try {
    body = await tokenRequest(value.token_url, { grant_type: "refresh_token", refresh_token: value.refresh_token! }, client, value.authorization_method);
  } catch (e) {
    throw new StepError(`the sign-in for this connection has expired and could not be renewed (${(e as Error).message}); connect it again`, 424);
  }
  const next = toValue(body, { tokenUrl: value.token_url, method: value.authorization_method, props: value.props, prior: value });
  const secret = await workspaceSecretRepo.getByName(workspaceId, secretName);
  if (secret) await workspaceSecretRepo.update(workspaceId, secret.id, { valueEnc: encrypt(JSON.stringify(next)) } as never);
  console.log(JSON.stringify({ event: "plugin_oauth_refreshed", workspaceId, secretName, expiresIn: next.expires_in ?? null }));
  return next;
}

/** A pending sign-in's two encrypted halves: the props the addresses were filled with, and the PKCE verifier. */
export function openState(st: Pick<PluginOauthState, "propsEnc" | "codeVerifierEnc">): { props: Record<string, unknown>; verifier: string | null } {
  return {
    props: st.propsEnc ? (JSON.parse(decrypt(st.propsEnc)) as Record<string, unknown>) : {},
    verifier: st.codeVerifierEnc ? decrypt(st.codeVerifierEnc) : null,
  };
}

export const __test = { inFlight };
