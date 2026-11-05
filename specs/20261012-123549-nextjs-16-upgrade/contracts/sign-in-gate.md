# Contract: the sign-in gate

The gate is today `packages/client/src/middleware.ts` (`auth((req) => …)` + `config.matcher`); after phase 2 it is
`proxy.ts`. **Exactly one gate file may exist at any time.** The table below is the behaviour that must be identical
before and after, and is checked against the **built** application (`next build && next start`), not the dev server.

Matcher today: `/((?!api/auth|_next/static|_next/image|favicon.ico).*)` — the gate runs on everything except those four.

| # | Request | Session | Expected answer |
| :--- | :--- | :--- | :--- |
| G-1 | `GET /dashboard` (any app page) | none | **302/307** to `/login?callbackUrl=%2Fdashboard` (path + query preserved) |
| G-2 | `GET /flows?view=live` | none | redirect to `/login?callbackUrl=%2Fflows%3Fview%3Dlive` |
| G-3 | `GET /api/foundry/anything` | none | **401** JSON `{"error":"not_authenticated"}` — **never** a redirect or HTML |
| G-4 | `GET /api/foundry-config` | none | **401** JSON (it is under `/api/`, not `/api/auth`) |
| G-5 | `GET /api/auth/session`, `/api/auth/providers` | none | served by the auth handlers, **not** gated |
| G-6 | `GET /_next/static/…`, `/_next/image…`, `/favicon.ico` | none | served, **not** gated |
| G-7 | `GET /login` | none | `200` sign-in page |
| G-8 | `GET /login` | valid | redirect to the safe `callbackUrl` target, else `/dashboard` |
| G-9 | `GET /login?expired=1` | valid | `200` sign-in page (**no** bounce) |
| G-10 | `GET /login?callbackUrl=https://evil.example/` | valid | redirect to `/dashboard` — an off-site return address is ignored (`safeNext`) |
| G-11 | `GET /dashboard` | valid | `200` |
| G-12 | `GET /api/foundry/…` | valid | passes through to the proxy route |
| G-13 | `GET /` | none | redirect to sign-in |
| G-14 | any app page | expired (token present, backend identity ended) | the app's existing behaviour (`identity_expired` → sign-in with `expired=1`); recorded at baseline and compared |

## Identity invariant

The identity token the client signs for the backend carries `token.oid ?? token.sub` (stable per person; the local
account's `sub` is the literal `local-admin`). After the upgrade, signing in as the same person must yield the **same
subject** as before (spec FR-012, SC-005). Compare the `platform_users` subject for a test account before and after: it
must be one row, not two.

## What fails the contract

- G-3 answered with a redirect or HTML (the client's `foundryApi` would then parse an HTML 200 as data).
- Any app page answered `200` with no session.
- A second gate file present (`middleware.ts` **and** `proxy.ts`).
- The identity subject changing between sign-ins.
