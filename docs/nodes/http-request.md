# HTTP Request (Status DRAFT 2026-09-09)

## 1. Purpose

Call an arbitrary external HTTP API as one workflow step: pick a method, address a URL, attach headers/query/body with upstream values interpolated in, authenticate, and expose the response (body, status, headers, files, size) to downstream steps. This is the ad-hoc escape hatch for APIs no catalogue tool covers — fetch data, send webhooks, upload/download files.

## 2. Dify behavior

What we steal (from `local://survey-data-tools.md` § HTTP Request):

- Method picker: GET / HEAD (retrieval), POST / PUT / PATCH (submission), DELETE (resource management); all standard methods supported, HEAD returns headers only.
- URL, headers, query parameters, and body content all interpolatable with `{{variable}}` deep paths (e.g. `{{api_response.data.items[0].id}}`) for chaining prior responses.
- Body type picker: JSON (structured), Form Data (web forms), Binary (file uploads — file variables from previous nodes), Raw Text (custom content types).
- Authentication: no-auth; API key (subtypes Basic = base64 header, Bearer = `Authorization: Bearer <token>`, Custom = custom header name + value).
- Timeouts: connect + read + write phases, each a max time for that phase.
- `ssl_verify` per-node flag (off for self-signed internal services, on for external APIs).
- Retry: auto-retry failed requests up to 10 times, configurable interval (max 5000 ms), covering transient network/service outages.
- Outputs: response body (main content), status code (feeds downstream conditionals), headers (key-value metadata), files (returned file content as file variables), size information (bytes + readable KB/MB). Text responses (JSON/XML/HTML) treated as data; binary detected as files via Content-Disposition → MIME type → first-1024-bytes sampling.
- Failure routing: a configurable error-handling alternative path so the workflow continues when the API is unavailable; status code available for downstream conditionals.
- File upload via binary body (file variables) and downloads auto-becoming file variables for downstream nodes.

What we skip:

- Exact retryable-status-code list (not documented in Dify — open question, §9).
- Exact timeout defaults (not documented — server-bounded, client passes through).
- No JSONPath extractor control on the node (Dify access is via deep `{{}}` paths downstream, not a per-node parse config — open question, §9).

## 3. Model mapping

New stored step kind `http` — a new `AuthoredStep` union variant in `packages/flow-edit/src/index.ts`, a new `StepKind` member in `packages/client/src/lib/canvas-model.ts` (`STEP_KINDS`), and a new `blankStep` case in `packages/client/src/lib/flow-authoring.ts`. **NOT a catalogue tool**: catalogue tools are blessed, reusable, named actions addressed by `ref` with per-tool param forms and server-owned output shapes; `http` is a verbatim per-step request with no named `ref` — the panel says so in one line ("not a catalogue tool: this step sends exactly the request written here"). This keeps one spelling of each blessed action in the catalogue and one spelling of "raw HTTP" in the kind.

Stored fields:

| Stored field | Type | Default | Validation |
|---|---|---|---|
| `method` | `"GET" \| "HEAD" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"` | `"GET"` | required; HEAD sends no body (panel hides the body section) |
| `url` | string (free text with `{{…}}` interpolation) | `""` (required) | non-empty or the save is refused; `{{…}}` refs MUST validate against the served `flow-expr` allowlist — **no allowlist change in this doc** |
| `headers[]` | `Array<{ name: string; value: string }>` (value interpolatable) | `[]` | names non-empty, unique case-insensitively when set |
| `queryParams[]` | `Array<{ name: string; value: string }>` (value interpolatable) | `[]` | names non-empty when set |
| `body` | `{ kind: "none" \| "json" \| "form" \| "binary" \| "raw"; content: string; contentType?: string; fileVar?: string }` | `{ kind: "none", content: "" }` | `json` must parse when no `{{…}}` refs present (refs exempt — checked server-side after render); `binary` requires `fileVar` naming an upstream file variable; `raw` requires `contentType` when set |
| `auth` | `{ kind: "none" \| "api-key" \| "basic" \| "bearer" \| "custom"; headerName?: string; secretRef?: string }` | `{ kind: "none" }` | `basic`/`bearer`/`api-key`/`custom` require `secretRef`; auth values are stored as secret refs (env-var names), never literal tokens (§5) |
| `timeouts` | `{ connectMs?: number; readMs?: number; writeMs?: number }` | unset (server default) | each > 0 when set; server-bounded |
| `sslVerify` | boolean | `true` | stored always; the panel warns when off (external API with verification off is a real hazard) |
| `retry` | existing `StepRetry` (count + interval) | unset (server default) | same editor and semantics as every other retryable kind (`StepBehaviour`) — **decision, stated:** reuse, not inline. Rationale: retry count + interval + backoff is one concept rendered one way; Dify's ≤10 / ≤5000 ms caps are enforced as field validation (count ≤ 10, interval ≤ 5000 ms), not as a second editor |

NOT stored (deliberately): retryable-status list (open question, §9); JSONPath extraction config (open question, §9); rendered request preview (derived, never persisted).

Expr forms: `{{…}}` refs in `url`/`headers`/`queryParams`/`body.content` compile to the existing `outputs.<id>.<field>` / `inputs.<id>` roots `lib/flow-expr.ts` already builds — no new root, no allowlist change in this doc. Deep paths (`a.b.items[0].id`) are paths over already-allowed roots, not new syntax.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Never grows; reuses `heightFor`/`widthFor` like every other kind.

- Pill rule: `` `${method} ${host}` `` where `host` is the URL's hostname with a `www.` prefix stripped and path dropped (`POST https://api.example.com/v1/invoices` → `POST api.example`). If `url` is empty or unparseable, fall back to `KIND_LABEL` (`"HTTP"` — new entry, see §8), never a fabricated host.
- Description-line rule: the step's own `description` (`StepLabel.description`) only. No per-kind sentence — an undescribed HTTP step shows no description line, same as every other kind.

## 5. Panel

Fixed order (Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). Per-section fields:

1. **Step** (open) — kind chip (`KIND_LABEL["http"] = "HTTP"` + `--k-*` hue) + step id + `name` (unchanged idiom).
2. **Description** — the single earned `description` line (e.g. "POST the approved invoice to the ledger webhook").
3. **Inputs** (open, count) — every `{{var}}` the request references (parsed out of `url`, `headers[]`, `queryParams[]`, and `body.content`), one row each (NAME · SOURCE · TYPE idiom, `StepIO` input table). Each row's source picker is the Dify-style `Set variable` grey well reusing the existing `ParamRow`/`Select` options — `flow-expr` allowlist unchanged. File variables bound by `body.fileVar` appear here as rows.
4. **Request editor** (open, count) — the "what it does" body, in this order: method picker → URL field (free text, variable-insert limited to allowlist-valid refs, by construction never typed raw) → headers table → query table → body type picker (None / JSON / Form / Binary / Raw; Binary shows the file-variable picker, Raw shows the content-type field) + body textarea → auth picker (`none` / `api-key` / `basic` / `bearer` / `custom`; any non-none style shows the secret-ref picker, never a plaintext token field) → timeouts (connect/read/write, optional) → `sslVerify` toggle with the off-warning. Opens with the one-line tool-vs-http boundary note: "Not a catalogue tool — this step sends exactly the request written here."
5. **Outputs** — `body`, `status_code`, `headers`, `files`, `size` rows (§6); `StepIO` output table + `StepShape` rename idiom ("Rename what it returns"). Headed "Outputs".
6. **Behavior** — `StepBehaviour` (`retry` count ≤ 10 + interval ≤ 5000 ms, timeouts) + "Require approval before this step" button (unchanged). The error-handling alternative path (workflow continues on failure via an alternate route) is expressed as ordinary downstream `condition` arms on `status_code`, not a stored field.
7. **Connections** (Dependencies) — `dependsOn` editor (unchanged).
8. **Try this step** — only when `onTryStep` (unchanged).
9. **Raw** — escape hatch, collapsed by default (unchanged).
10. **Remove** (danger, unchanged).

Secrets rule: auth values are stored as secret refs (env-var names, mirroring the catalogue-tool `secretEnvName` idiom — a step names a secret, no route returns its value) and rendered masked; secret-type values are masked in run logs and this node's request log (Dify parity). Exact secret-storage shape (new `secretRef` field vs reusing the workspace-secrets `secretEnvName` column) is an open question (§9).

## 6. Outputs

Named vars, read downstream through the existing `outputs.<id>.*` roots (`lib/step-io.ts` `IoOutput` + readers `→ step/field`):

| Var | Shape | When |
|---|---|---|
| `body` | string (text responses: JSON/XML/HTML as data) or parsed JSON when the content type is JSON | always |
| `status_code` | number — feeds downstream `condition` arms | always |
| `headers` | object — key-value response metadata | always |
| `files` | file variable(s) — binary responses detected via Content-Disposition → MIME → byte sampling | only when the response is file-shaped |
| `size` | object — `{ bytes: number; readable: string }` | always |

Single success exit plus failure routing via downstream `condition` arms on `status_code` (the same arm idiom as the human-input doc — `elseOf` chains, never a stored alternate-route field). `stepIo` treats `http` as a producing kind with exactly the five rows above — never a guessed field list.

## 7. Failure behavior

- **Retry** (count ≤ 10 + interval ≤ 5000 ms) via `StepBehaviour`, same semantics as other retryable kinds; attempts surface in the existing `attempt`/retry-policy card facts. Covers transient network/service outages.
- **Fail path:** the workflow continues via an alternate route — authored as ordinary downstream `condition` arms testing `status_code` (or a timeout arm), not as a stored field. No silent drop: an unwired failure fails the run like every other kind.
- **Timeouts:** connect/read/write each fail the attempt (then retry per policy); all attempts exhausted fails the step.
- **SSL:** `sslVerify: false` accepts self-signed certs (internal services); the panel warns when off and the URL points at an external host.
- **No retry:** none beyond the shared `StepBehaviour` refusal rules — `http` is retryable like `tool`.

## 8. Migration/compat

- Additive new kind: existing flows have no `http` steps and are unaffected. No migration of stored revisions.
- **Tool-vs-HTTP boundary (stated):** catalogue tools stay the only spelling of blessed reusable actions (named `ref`, per-tool param form, server-owned shapes). `http` is the ad-hoc escape hatch for endpoints no tool covers. Authors MUST NOT wrap a catalogue tool's endpoint in an `http` step to dodge auth review — the panel's one-line note says the request is sent verbatim. No dedupe pass over existing tools is proposed.
- **blankStep/palette:** add the `http` case to `blankStep` (`method: "GET"`, empty `url`, `body: { kind: "none", content: "" }`, `auth: { kind: "none" }`, `sslVerify: true` — an unconfigured HTTP step refuses save on empty URL, same rule as an empty `condition`); add the HTTP tile to the palette/chat-workbench add menus with `KIND_LABEL` "HTTP". `NEEDS_REF` is untouched (`http` carries no `ref`).
- **Catalogue:** the server's `OutputShapes` gains an `http` entry (template for `body`/`status_code`/`headers`/`files`/`size` + the standard `caution`); until served, `step-io.ts` reports the five rows above as declared by the kind (step-owned data, not a guessed endpoint shape).

## 9. Open questions

1. JSONPath extraction vs deep-`{{}}` downstream — Dify reads nested response data via deep `{{api_response.data…}}` paths with no per-node extractor. Do we add a per-node JSONPath/parse config, or keep deep paths only?
2. Retryable-status list — which statuses retry (5xx + 429? never 4xx?) is undocumented in Dify. Server default or a stored per-step list?
3. Secret storage shape — new `auth.secretRef` field on the step, or reuse of the workspace-secrets `secretEnvName` idiom (one credential per step)? What renders when the referenced secret is deleted or unstored?
4. `custom` auth shape — header name + secret ref only, or name + value pairs (query-param tokens, cookie auth)?
5. Form-body encoding — `form` as flat key-value only, or nested/array encoding (brackets vs JSON-stringified values)?

## 10. Non-goals

- No catalogue-tool replacement — blessed actions stay catalogue tools addressed by `ref`; `http` never gains a `ref`.
- No `flow-expr` allowlist change — `{{…}}` refs use the served roots as-is; anything else stays `unknown`.
- No server/compiler design (how `http` compiles to a task, how file variables upload/download, how masking is enforced at rest) — model mapping stops at the stored shape.
- No retryable-status semantics, no JSONPath extractor, no OAuth2 dance (Bearer/Basic/API-key/Custom only).
- No palette/builder implementation — talk-phase artifact only, no code.
