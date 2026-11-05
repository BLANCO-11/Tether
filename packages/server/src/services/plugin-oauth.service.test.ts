/**
 * Signing in (plans/plugins-2026-10-27, phase 4) against a MOCK OAuth server — a real HTTP token endpoint on a local
 * port, issuing tokens that expire in one second. This is the CI-able half of the phase's proof (decision 5): the
 * refresh-after-expiry Teams cannot be reached for, measured here instead. GitHub is the live half.
 */
import { createServer, type Server } from "node:http";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ secrets: new Map<string, string>(), app: undefined as unknown }));
vi.mock("../repositories/plugin.repo.js", () => ({ pluginRepo: { getOauthApp: async () => store.app } }));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: {
    getByName: async (_ws: string, name: string) => (store.secrets.has(name) ? { id: name, valueEnc: store.secrets.get(name) } : undefined),
    update: async (_ws: string, id: string, set: { valueEnc: string }) => void store.secrets.set(id, set.valueEnc),
  },
}));

import { decrypt, encrypt } from "../utils/encryptor.js";
import {
  authorizeUrl,
  checkScopes,
  fillTemplate,
  forConnector,
  freshConnection,
  needsRefresh,
  tokenRequest,
  toValue,
  type OauthDecl,
  type OauthValue,
} from "./plugin-oauth.service.js";

// ── the mock provider ───────────────────────────────────────────────────────────────────────────────────────────────
let server: Server;
let base = "";
const seen: Array<{ grant: string; auth: string | null; body: URLSearchParams }> = [];
let issued = 0;
let refuseRefresh = false;
let formAnswer = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      seen.push({ grant: body.get("grant_type") ?? "", auth: req.headers.authorization ?? null, body });
      const answer = (o: Record<string, unknown>, status = 200) => {
        if (formAnswer) {
          res.writeHead(status, { "content-type": "application/x-www-form-urlencoded" });
          res.end(new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)] as [string, string])).toString());
        } else {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        }
      };
      if (body.get("grant_type") === "refresh_token" && (refuseRefresh || body.get("refresh_token") !== `r${issued}`)) {
        return answer({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);
      }
      issued++;
      // A short wait, so two concurrent callers would both be in flight if nothing serialised them.
      setTimeout(() => answer({ access_token: `a${issued}`, refresh_token: `r${issued}`, expires_in: 1, token_type: "bearer", scope: "repo", instance_url: "https://x.example" }), 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  seen.length = 0;
  issued = 0;
  refuseRefresh = false;
  formAnswer = false;
  store.secrets.clear();
  store.app = { piece: "@activepieces/piece-mock", useSignInApp: false, clientId: "cid", clientSecretEnc: encrypt("csecret"), scopes: [] };
});

const decl = (over: Partial<OauthDecl> = {}): OauthDecl => ({
  authUrl: "https://{cloud}/{tenantId}/authorize",
  tokenUrl: `${base}/token`,
  scope: ["repo", "gist", "admin:org"],
  grantType: null,
  ...over,
});

describe("the authorize URL", () => {
  it("carries the client, the return address, the scopes and a state led by the workspace", () => {
    const { url, state, verifier } = authorizeUrl(decl({ extra: { access_type: "offline" }, prompt: "consent" }), {
      clientId: "cid",
      scopes: ["repo"],
      props: { cloud: "login.microsoftonline.com", tenantId: "t1" },
      workspaceId: "ws-1",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/t1/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/callback$/);
    expect(u.searchParams.get("scope")).toBe("repo");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(state.startsWith("ws-1.")).toBe(true);
    expect(state.length).toBeGreaterThan(40);
    expect(verifier).toBeNull();
  });
  it("PKCE S256: the challenge is the verifier's hash, never the verifier", () => {
    const { url, verifier } = authorizeUrl(decl({ authUrl: "https://p.example/a", pkce: true, pkceMethod: "S256" }), { clientId: "c", scopes: [], props: {}, workspaceId: "w" });
    const q = new URL(url).searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(crypto.createHash("sha256").update(verifier!).digest("base64url"));
    expect(url).not.toContain(verifier!);
  });
  it("⚠ a template value cannot redirect the sign-in elsewhere (no / ? # @)", () => {
    for (const bad of ["evil.example/x", "a@evil.example", "x?y", "x#y"]) {
      expect(() => fillTemplate("https://{cloud}/t", { cloud: bad })).toThrow(/may not contain/);
    }
    expect(() => fillTemplate("https://{cloud}/t", {})).toThrow(/"cloud" is needed/);
  });
});

describe("scopes", () => {
  it("narrow, never widen", () => {
    expect(checkScopes(decl(), ["repo"])).toEqual(["repo"]);
    expect(checkScopes(decl(), [])).toEqual([]);
    expect(() => checkScopes(decl(), ["repo", "delete_repo"])).toThrow(/delete_repo.*never widened/);
  });
});

describe("the token address", () => {
  it("BODY sends the client in the form; HEADER as basic auth and never in the form", async () => {
    await tokenRequest(`${base}/token`, { grant_type: "authorization_code", code: "x" }, { clientId: "cid", clientSecret: "s" }, "BODY");
    expect(seen[0]!.body.get("client_secret")).toBe("s");
    expect(seen[0]!.auth).toBeNull();
    await tokenRequest(`${base}/token`, { grant_type: "authorization_code", code: "x" }, { clientId: "cid", clientSecret: "s" }, "HEADER");
    expect(seen[1]!.auth).toBe(`Basic ${Buffer.from("cid:s").toString("base64")}`);
    expect(seen[1]!.body.has("client_secret")).toBe(false);
  });
  it("reads a form-encoded answer (GitHub's default)", async () => {
    formAnswer = true;
    const b = await tokenRequest(`${base}/token`, { grant_type: "authorization_code", code: "x" }, { clientId: "c", clientSecret: "s" }, "BODY");
    expect(b.access_token).toBe("a1");
  });
  it("a refusal is said in the provider's words", async () => {
    refuseRefresh = true;
    await expect(tokenRequest(`${base}/token`, { grant_type: "refresh_token", refresh_token: "r0" }, { clientId: "c", clientSecret: "s" }, "BODY")).rejects.toThrow(
      /invalid_grant: refresh token revoked/,
    );
  });
});

describe("⚠ the stored value and what reaches the connector", () => {
  it("every token is lifted out of `data`, and the connector never gets the refresh token or the token address", () => {
    const v = toValue({ access_token: "A", refresh_token: "R", id_token: "I", expires_in: 3600, instance_url: "https://x" }, { tokenUrl: "https://t", method: "BODY", props: { p: 1 } });
    expect(v.data).toEqual({ expires_in: 3600, instance_url: "https://x" });
    const sent = JSON.stringify(forConnector(v));
    expect(sent).toContain('"access_token":"A"');
    expect(sent).not.toMatch(/"R"|refresh_token|token_url|"I"/);
  });
  it("a token with no expiry (a GitHub OAuth app's) is never refreshed; an expiring one is, a minute early", () => {
    const now = 1_000_000;
    expect(needsRefresh({ access_token: "a", refresh_token: "r", claimed_at: now - 10, token_url: "", authorization_method: "BODY", props: {}, data: {} }, now)).toBe(false);
    expect(needsRefresh({ access_token: "a", refresh_token: "r", expires_in: 100, claimed_at: now - 39, token_url: "", authorization_method: "BODY", props: {}, data: {} }, now)).toBe(false);
    expect(needsRefresh({ access_token: "a", refresh_token: "r", expires_in: 100, claimed_at: now - 41, token_url: "", authorization_method: "BODY", props: {}, data: {} }, now)).toBe(true);
    expect(needsRefresh({ access_token: "a", expires_in: 100, claimed_at: 0, token_url: "", authorization_method: "BODY", props: {}, data: {} }, now)).toBe(false);
  });
});

describe("refresh after expiry, against the mock provider", () => {
  async function connected(): Promise<OauthValue> {
    const body = await tokenRequest(`${base}/token`, { grant_type: "authorization_code", code: "c" }, { clientId: "cid", clientSecret: "csecret" }, "BODY");
    const v = toValue(body, { tokenUrl: `${base}/token`, method: "BODY", props: {} });
    store.secrets.set("PLUGIN_MOCK_X", encrypt(JSON.stringify(v)));
    return v;
  }
  const stored = () => JSON.parse(decrypt(store.secrets.get("PLUGIN_MOCK_X")!)) as OauthValue;

  it("an expired token is renewed before use, the new one is stored, and the ROTATED refresh token is kept", async () => {
    const first = await connected();
    expect(first.access_token).toBe("a1");
    // Expires in 1 s, refreshed a minute early: already due.
    const used = await freshConnection("w", "PLUGIN_MOCK_X", "@activepieces/piece-mock", first as never);
    expect(used.access_token).toBe("a2");
    expect(seen.at(-1)!.grant).toBe("refresh_token");
    expect(seen.at(-1)!.body.get("refresh_token")).toBe("r1");
    expect(stored().access_token).toBe("a2");
    expect(stored().refresh_token).toBe("r2");
    // And again: the second refresh spends the rotated token, which only works if it was stored.
    const again = await freshConnection("w", "PLUGIN_MOCK_X", "@activepieces/piece-mock", stored() as never);
    expect(again.access_token).toBe("a3");
  });

  it("⚠ two concurrent calls share ONE refresh — a rotating refresh token spent twice would kill the connection", async () => {
    const v = await connected();
    const [x, y] = await Promise.all([
      freshConnection("w", "PLUGIN_MOCK_X", "@activepieces/piece-mock", v as never),
      freshConnection("w", "PLUGIN_MOCK_X", "@activepieces/piece-mock", v as never),
    ]);
    expect(seen.filter((s) => s.grant === "refresh_token")).toHaveLength(1);
    expect(x.access_token).toBe("a2");
    expect(y.access_token).toBe("a2");
  });

  it("a refused renewal fails by name, asking for a new sign-in — never a call on a dead token", async () => {
    const v = await connected();
    refuseRefresh = true;
    await expect(freshConnection("w", "PLUGIN_MOCK_X", "@activepieces/piece-mock", v as never)).rejects.toThrow(/expired and could not be renewed.*connect it again/);
  });

  it("a value that is not a sign-in passes through untouched", async () => {
    const v = { accessKeyId: "k", secretAccessKey: "s" };
    expect(await freshConnection("w", "X", "@activepieces/piece-amazon-s3", v)).toBe(v);
    expect(seen).toHaveLength(0);
  });
});
