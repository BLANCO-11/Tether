// src/app/api/oauth/callback/callback.test.ts — the page a provider sends the browser back to (plugins phase 4).
//
// ⚠ What it must never do: post a code without the signed-in person's identity, or decide anything itself. The API
// checks the state; this route forwards it and turns the answer into a page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: () => authMock() }));

import { GET } from "./route";

const WS = "6db5693f-981a-40fc-99f2-b517459364b7";
function req(search: string) {
  const url = new URL(`http://localhost:4002/api/oauth/callback${search}`);
  return Object.assign(new Request(url), { nextUrl: url }) as never;
}
/** Named so `fetchSpy` can take its type without spelling out fetch's overloads (the proxy test's idiom). */
const spyOnFetch = () => vi.spyOn(globalThis, "fetch");
let fetchSpy: ReturnType<typeof spyOnFetch>;
beforeEach(() => {
  fetchSpy = spyOnFetch();
});
afterEach(() => {
  vi.restoreAllMocks();
  authMock.mockReset();
});

describe("/api/oauth/callback", () => {
  it("signed out: to sign-in, then straight back here — nothing is posted", async () => {
    authMock.mockResolvedValue(null);
    const r = await GET(req(`?code=c&state=${WS}.abc`));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/\/login\?callbackUrl=%2Fapi%2Foauth%2Fcallback%3Fcode%3Dc/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the code and state for THIS person (identity from the session) to the state's workspace", async () => {
    authMock.mockResolvedValue({ backendToken: "jwt-of-person" });
    fetchSpy.mockResolvedValue(Response.json({ piece: "github", connection: { id: "c1" } }));
    const r = await GET(req(`?code=the-code&state=${WS}.abc`));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/api/workspaces/${WS}/plugins/oauth/callback$`));
    expect((init.headers as Record<string, string>)["x-foundry-identity"]).toBe("jwt-of-person");
    expect(JSON.parse(String(init.body))).toMatchObject({ code: "the-code", state: `${WS}.abc` });
    expect(r.headers.get("location")).toMatch(/\/apps\/github\?connected=c1$/);
  });

  it("a refusal comes back to the page in Foundry's words; a state with no workspace is refused without posting", async () => {
    authMock.mockResolvedValue({ backendToken: "t" });
    fetchSpy.mockResolvedValue(Response.json({ message: "this sign-in was started by somebody else" }, { status: 403 }));
    const r = await GET(req(`?code=c&state=${WS}.abc`));
    expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/\/apps\?oauthError=this sign-in was started by somebody else/);
    fetchSpy.mockClear();
    const bad = await GET(req(`?code=c&state=../../x`));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bad.headers.get("location")).toMatch(/oauthError=/);
  });

  it("a provider-side refusal (the person declined) reaches the connector's page", async () => {
    authMock.mockResolvedValue({ backendToken: "t" });
    fetchSpy.mockResolvedValue(Response.json({ piece: "github", message: "GitHub did not sign in: access_denied" }, { status: 400 }));
    const r = await GET(req(`?error=access_denied&state=${WS}.abc`));
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body)).error).toBe("access_denied");
    expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/\/apps\/github\?oauthError=GitHub did not sign in/);
  });
});
