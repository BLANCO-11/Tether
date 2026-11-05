# Quickstart: Request Policy Engine (V8)

Validation scenarios proving the feature works end-to-end. Run from
`packages/shared`, `packages/server`, `packages/client` as noted.

## Prerequisites

- Workspace installed (`pnpm install` at repo root).
- No new env vars, no new services to start beyond what generation already
  requires.

## 1. Shared combinator, in isolation

```bash
cd foundry/packages/shared
pnpm test -- request-policy
```

Expected: `rules.test.ts`, `combinator.test.ts`, `transform.test.ts` all pass.
Confirms, against the fixture table in `fixtures.ts`:

- `"Build Facebook"` → `reject`, evidence includes `productReference` (Facebook)
  and `reproductionIntent`.
- `"Build a social media platform"` → `allow`, empty evidence.
- `"An open-source Slack alternative"` → `allow`, evidence includes
  `productReference` (Slack) and `differentiationQualifier` (alternative), and
  the combinator's reconciliation suppresses reject despite the product match.
- A feature-only description matching a cataloged signature, no product name,
  evaluated `confirmation-available` → `transform`, with a `proposal.task`
  containing no product-specific vocabulary (checked against
  `featureSubstitutes`).
- The same evidence, evaluated `confirmation-unavailable` → `reject`, same
  `reason` text as the transform case would have shown.

## 2. Client/server equivalence

```bash
cd foundry/packages/shared
pnpm test -- equivalence
```

Expected: for every fixture in `fixtures.ts`, the server-side wrapper
(`request-policy.service.ts`, exercised directly, not through HTTP) and the
client-side wrapper (`request-policy-client.ts`) produce byte-identical
`PolicyDecision` objects.

## 3. Server route, end-to-end

```bash
cd foundry/packages/server
pnpm test -- scripts.route
```

Manual check (optional, requires a running server):

```bash
curl -X POST http://localhost:4000/api/workspaces/<id>/scripts \
  -H "Content-Type: application/json" \
  -d '{"task": "Build Facebook"}'
```

Expected: `422`, body `{ "decision": "reject", ... }`, no script row created
(`GET /api/workspaces/<id>/scripts` list unchanged before/after).

```bash
curl -X POST http://localhost:4000/api/workspaces/<id>/scripts \
  -H "Content-Type: application/json" \
  -d '{"task": "Build a CRM"}'
```

Expected: `202`, existing generation-start response — unaffected by this
feature (SC-002, SC-007).

## 4. Client builder flow

```bash
cd foundry/packages/client
pnpm test -- automation-flow
```

Expected: `policyGateFor` fixtures cover the `describe → connect` and
`plan → build` transitions; a request that resolves (post-clarify) into a
full feature match is caught on the second pass even if the first pass
allowed it through on soft phrasing (spec Edge Cases, first bullet).

Manual check: in the builder UI, typing "Build Facebook" at the Describe step
and pressing Next shows a rejection message naming the matched evidence,
without any network call to start generation.

## Success criteria this validates

Maps to spec.md SC-001 through SC-007. If every command above passes and the
manual checks match, the feature meets its stated success criteria.
