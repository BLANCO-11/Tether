// src/gate.test.ts — the server-side sign-in gate answers every kind of request as it did before the upgrade.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The gate (`middleware.ts`, renamed `proxy.ts` on Next 16) is the control that keeps every page closed to a person who is not
// signed in, and the product's 401-for-API-paths behaviour. A misdeclared gate does not throw: it simply lets requests through,
// and nobody already signed in would notice. This table is `specs/…/contracts/sign-in-gate.md` G-1…G-13 as assertions.
//
// `@/auth` is mocked so `auth(cb)` hands `cb` a chosen session; what is tested is the gate's own decision logic and its matcher.
// What it cannot show is that Next calls the file at all — that is the request matrix run against the BUILT app.
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

let session: unknown = null;
vi.mock("@/auth", () => ({
  auth: (cb: (req: unknown) => unknown) => (req: { nextUrl: URL }) => cb({ ...req, auth: session }),
}));

// The gate module is `./middleware` on Next 14/15 and `./proxy` on Next 16: whichever exists is the one under test, and
// there must be exactly one (contracts/sign-in-gate.md).
const GATE_FILES = ["middleware.ts", "proxy.ts"].filter((f) => existsSync(fileURLToPath(new URL(`./${f}`, import.meta.url))));

type GateModule = { default?: (req: unknown) => Response; proxy?: (req: unknown) => Response; config: { matcher: string[] } };
async function loadGate(): Promise<GateModule> {
  if (GATE_FILES.length !== 1) {
    throw new Error(`Exactly ONE gate file may exist (contracts/sign-in-gate.md); found ${GATE_FILES.length}: ${GATE_FILES.join(", ") || "none"}`);
  }
  const spec = `./${GATE_FILES[0].replace(/\.ts$/, "")}`;
  return (await import(/* @vite-ignore */ spec)) as GateModule;
}

async function run(path: string, signedIn: boolean) {
  session = signedIn ? { user: { id: "u1" } } : null;
  const gate = await loadGate();
  const handler = (gate.proxy ?? gate.default) as (req: unknown) => Response;
  const req = { nextUrl: new URL(`http://localhost:4002${path}`) };
  return handler(req);
}
const loc = (r: Response) => r.headers.get("location");

describe("no session", () => {
  it("G-1/G-2 sends a page to sign-in with the original address preserved", async () => {
    expect(loc(await run("/dashboard", false))).toBe("http://localhost:4002/login?callbackUrl=%2Fdashboard");
    expect(loc(await run("/flows?view=live", false))).toBe("http://localhost:4002/login?callbackUrl=%2Fflows%3Fview%3Dlive");
  });

  it("G-13 sends the root to sign-in", async () => {
    expect(loc(await run("/", false))).toBe("http://localhost:4002/login?callbackUrl=%2F");
  });

  it("G-3/G-4 answers an API path 401 JSON — never a redirect or a page", async () => {
    for (const p of ["/api/foundry/anything", "/api/foundry-config"]) {
      const res = await run(p, false);
      expect(res.status, p).toBe(401);
      expect(res.headers.get("content-type"), p).toMatch(/application\/json/);
      expect(loc(res), p).toBeNull();
      await expect(res.json()).resolves.toEqual({ error: "not_authenticated" });
    }
  });

  it("the OAuth return (a provider sending the BROWSER back) goes to sign-in and back, not to a JSON 401", async () => {
    const res = await run("/api/oauth/callback?code=c&state=s", false);
    expect(loc(res)).toBe("http://localhost:4002/login?callbackUrl=%2Fapi%2Foauth%2Fcallback%3Fcode%3Dc%26state%3Ds");
    // …and only that path: a near miss is still an API path.
    expect((await run("/api/oauth/callbackx", false)).status).toBe(401);
  });

  it("G-7 lets the sign-in page itself through", async () => {
    const res = await run("/login", false);
    expect(loc(res)).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("a valid session", () => {
  it("G-11 lets an app page through", async () => {
    const res = await run("/dashboard", true);
    expect(loc(res)).toBeNull();
    expect(res.status).toBe(200);
  });

  it("G-12 lets an API path through (the proxy route then checks again itself)", async () => {
    expect((await run("/api/foundry/workspaces", true)).status).toBe(200);
  });

  it("G-8 bounces the sign-in page to the in-app return address", async () => {
    expect(loc(await run("/login?callbackUrl=%2Fflows", true))).toBe("http://localhost:4002/flows");
  });

  it("G-8 bounces to the dashboard when there is no return address", async () => {
    expect(loc(await run("/login", true))).toBe("http://localhost:4002/dashboard");
  });

  it("G-9 stays on the sign-in page when `expired=1`", async () => {
    const res = await run("/login?expired=1", true);
    expect(loc(res)).toBeNull();
    expect(res.status).toBe(200);
  });

  it("G-10 ignores an off-site return address", async () => {
    expect(loc(await run("/login?callbackUrl=https%3A%2F%2Fevil.example%2F", true))).toBe("http://localhost:4002/dashboard");
  });
});

describe("the matcher", () => {
  async function matches(path: string) {
    const { config } = await loadGate();
    const re = new RegExp(`^${config.matcher[0]}$`);
    return re.test(path);
  }

  it("G-5/G-6 excludes the authentication endpoints and the framework's own assets", async () => {
    for (const p of ["/api/auth/session", "/api/auth/providers", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(await matches(p), p).toBe(false);
    }
  });

  it("CONTROL: still covers pages and every other API path", async () => {
    for (const p of ["/dashboard", "/api/foundry/x", "/api/foundry-config", "/login", "/"]) {
      expect(await matches(p), p).toBe(true);
    }
  });
});

describe("there is exactly one gate", () => {
  it("one of middleware.ts / proxy.ts exists, not both and not neither", async () => {
    expect(GATE_FILES).toHaveLength(1);
  });
});
