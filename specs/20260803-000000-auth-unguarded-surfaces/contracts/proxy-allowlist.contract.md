# Contract: Next proxy session check, path allowlist and role gate

Surfaces: `packages/client/src/app/api/foundry/[...path]/route.ts` (US3,
FR-009…FR-013) and the `roles` enforcement point (US4, FR-014/FR-015).

## Before

The route forwards **any** path under `/api/foundry/**` to the parent API with
`x-api-key: PARENT_API_KEY` attached, verbatim (`route.ts:16-18`). It performs no
session check of its own; protection comes solely from the middleware matcher
(`middleware.ts:23`).

Accurate statement of today's exposure (spec Finding B): the matcher **does**
currently cover this path, so an anonymous request is redirected to `/login`. The
two real problems are that the protection is one regex from vanishing with no
test to catch it, and that **any** signed-in user can reach **any** parent-API
path with the server's key — including `/demo/reset` and every workspace's
secrets.

## After

### 1. In-route session check (FR-009)

```ts
const session = await auth();
if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });
```

Independent of the matcher. The test that makes this real is the one that
**widens the matcher** to exclude `/api/foundry` and asserts the route still
refuses (SC-005). A session check whose test passes with the check deleted is not
a check.

### 2. Path normalisation, then allowlist (FR-010)

Match on the `path[]` segments Next supplies, **not** on a rejoined string.
Reject any segment that is empty, `.`, `..`, or contains `%2f`, `%2F`, `%5c`,
`%5C`, or a raw `/` or `\` after decoding. Reject before matching, not after.

Then match against `lib/proxy-allowlist.ts` per `(method, template)`. Anything
unmatched is `403` **without contacting the parent API** — no upstream request is
made, so an unmatched path cannot be used as a probe for what exists upstream.

### 3. Role gate (FR-014, FR-015, research R4)

Each allowlist entry carries the role it requires. This is the **single**
enforcement point for `roles` — the only place in the stack with both a verified
session and control over what reaches the parent API, because Q1 defers §9 R2 and
so the parent API has no user identity.

```ts
interface AllowEntry {
  methods: ReadonlyArray<"GET"|"POST"|"PATCH"|"PUT"|"DELETE">;
  segments: ReadonlyArray<string | ":uuid" | ":seg">;  // positional matcher
  requiredRole?: "admin";                              // absent = any signed-in user
}
```

Initial entries per [research.md](../research.md) R5. The two that carry
`requiredRole: "admin"`:

| Method | Path | Why |
|---|---|---|
| POST | `/demo/provision` | mutates demo state |
| POST | `/demo/reset` | **destroys** demo data |

Everything else the UI calls is open to any signed-in user. That is not a claim
that ordinary CRUD is harmless — it is a statement that this feature does not
introduce a per-workspace membership model, which would need R2.

A session lacking the role gets `403`.

### 4. Response passthrough unchanged (FR-012)

Status, body bytes, `content-type` and `content-disposition` forwarded exactly as
today. The existing 502 `upstream_unreachable` envelope keeps its shape but
**stops including `e.message`** (FR-013) — that is a V1-contract leak the audit
did not reach because the proxy is in the client package.

## The honest limit of the role gate

Stated here, in the plan, and required in the `security.md` amendment:

> The role gate constrains what the **browser** can reach **through the proxy**.
> It does not constrain anyone holding `PARENT_API_KEY` who talks to `:4000`
> directly. Closing that is §9 R2's job, deferred by Q1.

Documenting this gate as protecting the parent API would recreate exactly the
defect FR-014 removes.

## FR-011 — the allowlist cannot silently starve the product

`lib/proxy-allowlist.test.ts` extracts every proxy path template used by
`foundry-client.ts` and `adapters.ts` and asserts each is covered by an entry.
A UI change that adds a call the allowlist does not cover **fails the build**.

This is the counterpart to the security tests: those prove the allowlist blocks,
this one proves it does not over-block. The table in research R5 is a starting
point, **not** the source of truth — the extraction is, because a hand-maintained
list drifts on the first UI change after merge.

## Tests

| Test | Asserts |
|---|---|
| no session | 401 from the route itself |
| matcher widened to exclude the proxy, no session | still 401 (**SC-005**) |
| session check removed | at least one test fails (**SC-005**) |
| valid session, allowlisted path | response byte-identical to today, incl. headers |
| valid session, path not on allowlist | 403, **and no upstream fetch occurred** |
| allowlisted path, wrong method | 403 |
| `..` segment | 403 before matching |
| `%2f`-encoded separator | 403 |
| non-admin session, `POST /demo/reset` | 403 |
| admin session, `POST /demo/reset` | forwarded |
| every `foundry-client.ts` call template | covered by an entry (**FR-011**) |
| upstream unreachable | 502 with no `e.message` (**FR-013**) |
| upstream 4xx/5xx | status and body passed through unchanged |
