# Manual smoke script

Run against the **built** app (`pnpm --filter @foundry/client build && pnpm --filter @foundry/client start`, or the rebuilt
`web` image), signed out first. Tick each step; "expected" is the pass condition — "looks fine" is not an answer. Record
the commit hash and result in `gate-log.md`.

Needs: the stack up (API reachable), one local account, and ideally one saved workflow with a run.

| # | Step | Expected |
| :--- | :--- | :--- |
| 1 | Open `/dashboard` signed out | Redirected to `/login?callbackUrl=%2Fdashboard` |
| 2 | Sign in with local credentials | Lands on `/dashboard` (the return address) |
| 3 | Open `/login` while signed in | Bounced into the app, not shown the form |
| 4 | Open `/login?expired=1` while signed in | The sign-in page **is** shown, with "Your session ended…" |
| 5 | Open `/login?callbackUrl=https://evil.example/` signed in | Lands on `/dashboard`, never the other site |
| 6 | Open `/flows` | The workflow list loads; `?view=live` (or another view tab) is honoured on a direct link |
| 7 | Open one workflow by clicking, then by pasting its `/flows/<id>` link into a new tab | **Same workflow** both ways (not an empty or "no longer exists" state) |
| 8 | From that workflow open the builder (`/flows/<id>/builder`) | The builder opens on **that** workflow |
| 9 | In the builder, hover nodes/edges, click a node | Edges do not disappear while hovering; a click opens the details panel and does not re-lay-out the canvas |
| 10 | Open a run (`/runs/<id>`), then `?technical=1` | That run's steps show; the technical view toggles |
| 11 | Open `/resources`, then one resource, then its impact page | Each opens **that** resource (`/resources/<id>`, `/resources/<id>/impact`) |
| 12 | Open `/data-sources`, then one data source | Opens that data source |
| 13 | Open `/approvals`, switch tabs; open `/approvals/<id>` | Tab choice survives reload; the page names that approval |
| 14 | Open `/admin/members?tab=roles` and `?tab=platform` | The right tab shows (needs permission; otherwise the refusal page) |
| 15 | Open `/admin/audit?view=…&q=…&page=2` | The filters/page in the address are applied |
| 16 | Do any action that calls the API (e.g. save a setting, refresh a list) | Succeeds; the network tab shows `/api/foundry/...` answering 2xx, never `/api/foundry/undefined` |
| 17 | Open `/api/foundry/test-oracle/x` signed in (address bar) | `403` JSON `not_proxyable` |
| 18 | Sign out, then open `/api/foundry/workspaces` | `401` JSON, not a redirect or a page |
| 19 | Old links: `/home`, `/workflows`, `/runs`, `/create`, `/create/templates` | Land on `/dashboard`, `/flows`, `/history`, `/flows/new`, `/flows/new` |
| 20 | Read the version label beside "Beta" | Shows the root `package.json` version |
| 21 | Look at the page chrome and fonts | Styling and both fonts present (no unstyled flash, no fallback-serif text) |
| 22 | Sign out and back in as the same person | Same account, memberships unchanged (no re-assignment needed) |

**Identity-provider (Entra) sign-in**: if a test tenant is available, repeat steps 2 and 22 with it. If not, this path is
**not verified by this script** and the gap must be stated in the gate log — only the credentials path was exercised.
