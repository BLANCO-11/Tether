# Contract: `POST /api/workspaces/:workspaceId/tools/probe`

Mounted on the existing `toolsRouter`, therefore behind `requireApiKey` and workspace-scoped by the
same middleware as tool CRUD ([app.ts:218](../../../packages/server/src/app.ts#L218)). Tenancy comes
from the path, never from the body.

## Request

```jsonc
{
  // Exactly one of `toolId` or `draft`.
  "toolId": "9f5c…",                 // a saved tool in THIS workspace
  "draft": {                         // or what is in the onboarding form right now
    "name": "create_ticket",         // used only in messages; not stored
    "url": "https://api.example.com/v1/tickets",
    "method": "POST",
    "authStyle": "header",           // bearer | header | query | basic | none | oauth2_client_credentials | null
    "authParamName": "X-API-Key",
    "secretEnvName": "TICKETING_TOKEN",     // a NAME. never a value.
    "tokenUrl": null,
    "clientIdSecretRef": null,
    "clientSecretSecretRef": null
  },

  "mode": "reachability",            // optional; defaults to defaultModeFor(method)
  "sampleParams": { "title": "probe" } // live mode only; never persisted
}
```

⚠ **There is no field for a credential value, and adding one is out of contract.** A probe presents
what `workspace_secrets` holds under the named key, or it refuses (424). See plan Decision 3.

`draft` is validated by the same cross-field rules as `createToolSchema` — the auth-style trio rules,
the `authParamName` requirement for `header`/`query`, the https-only `tokenUrl`. A draft that could
not be created cannot be probed (400, with `findings[]` in the same shape the create route emits, so
the form renders them beside the fields it already renders create findings beside).

## Response — 200

The probe ran. **Read `verdict`; the HTTP 200 says only that Foundry managed to ask.**

```jsonc
{
  "probe": {
    "mode": "reachability",
    "verdict": "reachable",
    "invoked": false,                       // ⚠ false ⇒ the tool's own operation did NOT run
    "request": {
      "method": "HEAD",                     // what was actually sent (may differ from tool.method)
      "toolMethod": "POST",                 // what the tool would send in a run
      "urlShown": "https://api.example.com/v1/tickets?api_key=[redacted]",
      "fellBackToGet": false,
      "authPresented": { "style": "header", "placement": "x-api-key" }  // placement, never value
    },
    "status": 405,
    "statusText": "Method Not Allowed",
    "contentType": "application/json",
    "finalUrl": null,                       // set only when a redirect landed elsewhere
    "durationMs": 337,
    "body": {
      "preview": "{\"error\":\"method not allowed\"}",
      "redacted": true,                     // false ⇒ non-JSON: key-name redaction could not apply
      "truncated": false
    },
    "message": "Reached api.example.com — it answered 405 Method Not Allowed to HEAD. The host knows this path; your POST was not sent, so this does not prove the call succeeds.",
    "remedy": null
  }
}
```

### Verdicts

The status→verdict map is the **only** place a code becomes a word. The client renders the word.

| verdict | when | tone |
|---|---|---|
| `ok` | live mode, 2xx | ok |
| `reachable` | reachability mode, any answer from the host (2xx/4xx/5xx) | ok, with the un-sent method stated |
| `auth_rejected` | 401, or 403 with an auth style declared | danger — names the placement, suggests style/name/value |
| `forbidden` | 403 with no auth style declared | danger — the endpoint needs a credential this tool does not present |
| `not_found` | 404 | danger — the path, not the host |
| `upstream_error` | 5xx | warn — the endpoint is reachable and broken; not your configuration |
| `client_error` | other 4xx in live mode | warn — names the params sent (redacted) |
| `unreachable` | DNS failure, TLS failure, connection refused | danger — remedy names the host |
| `egress_refused` | `guardedFetch` threw `egress_rejected: …` | danger — quotes the classification verbatim |
| `timeout` | the 10 s deadline fired | warn |

`message` is one sentence, written server-side, always naming the host and the status. `remedy` is
present only when there is a specific next action (store the credential, fix the header name, widen
nothing — never "try again").

## Response — non-200

Foundry could not attempt the call. Statuses match what execution already speaks, so the two surfaces
cannot disagree about what a number means.

| Status | `error` | Detail | Raised by |
|---|---|---|---|
| 400 | `invalid_draft` | `findings[]` (same shape as create) | shared `createToolSchema` rules |
| 404 | `not_found` | — | `toolRepo.get` |
| 409 | `secret_collision` | `{ envName, collisions[], remedy }` | `shadowedSecretCollisions` — verbatim from execution |
| 409 | `platform_managed_live_probe` | `{ name }` | `mode: "live"` on a `PLATFORM_MANAGED_TOOLS` name |
| 424 | `credential_not_configured` | `{ missing: string[] }` | `resolveToolAuth` — the same 424 `applyAuth` throws |
| 429 | `probe_rate_limited` | `{ retryAfterSec }` | 20/min/workspace, in-process |

⚠ **A 401 from the endpoint is a 200 from this route.** Merging "the API said no" into "Foundry could
not ask" recreates the exact ambiguity WS-B.4's declared auth styles and `applyAuth`'s 424 exist to
remove.

## The tested marker (P3)

Not part of this endpoint's response. A probe of a **saved** tool records
`{ at, verdict, mode, status }` in a module-level `Map` keyed `(workspaceId, toolId)`, and
`GET /api/workspaces/:workspaceId/tools` carries it back as an optional `lastProbe` on each tool —
attached by `toolService.list` the way `usedBy` already is. A draft probe records nothing.

```jsonc
{ "tools": [ { "id": "9f5c…", "name": "create_ticket",
               "lastProbe": { "at": "2026-08-18T12:41:07.220Z", "verdict": "reachable",
                              "mode": "reachability", "status": 405 } } ] }
```

⚠ `lastProbe` carries **no verdict at all** — never a null-with-an-"unknown"-verdict — whenever the
process holds no record: never probed, probed before a restart, probed against another container, or
dropped because the tool's URL/method/auth was edited. A client must render absence as absence.

### ⚠ It is `null`, not an omitted key — amended 2026-08-24 (P3 · T21)

The contract said *absent*. As implemented the key is present and `null`, and the difference is worth
one paragraph:

| | |
|---|---|
| **Why `null`** | It is an explicit answer to the question. An omitted key is ambiguous between *"this server has no record"* and *"this server is too old to have the field"*, and the two want different follow-ups. |
| **Why it changes nothing for a client** | `probeMarkFromWire` in `lib/tool-probe.ts` narrows `undefined`, `null` and a malformed object to the same `null`, so an older server reads exactly like one with no marker. |
| **What the rule actually forbids** | An invented verdict. `null` is not a verdict; `{"verdict": "unknown"}` is, and the client has no way to tell an invented one from a measured one. |

⚠ **And a verdict WORD the client does not know is also `null`.** A newer server adding an eleventh
verdict would otherwise reach the client's `TITLE[verdict]` lookup and render the literal `undefined` in
a pill on every affected row. `probeMarkFromWire` refuses it; the row then renders nothing, which is the
same honest fallback as an absent marker.

⚠ **`update` decides "the tool's URL/method/auth was edited" by comparing the stored row BEFORE the
write to the row AFTER it**, not by inspecting the PATCH body — a body that re-sends an unchanged value
has moved nothing, and a style switch away from `oauth2` clears `tokenUrl` and both refs without the
body ever naming them.

## Invariants a reviewer should check by reading the diff

1. `tool-probe.service.ts` contains no `fetch(` and no `guardedFetch(` — it calls `dialTool`.
   (Asserted by `tool-invoke-single-dial.test.ts`.)
2. No response field can hold a secret: `urlShown` is built after the query-auth value is replaced,
   response headers are never echoed, and the JSON body path goes through `redactJsonString`.
3. `mode: "reachability"` cannot send the tool's own method — the method sent is `HEAD`, or `GET` on
   the single 405 fallback, and `invoked` is `false` on that path unconditionally.
4. **Nothing in the handler writes to the database at all** — no table, no column, no migration. The
   only state a probe leaves behind is the in-process tested marker (P3), which is a `Map` entry.
5. `sampleParams` appears in no persisted row and in no log line.
