# Regenerating `route-permissions.md`

The route map is **generated from the live Express stack**, not written by hand. The
hand-written version drifted in six places in two days, in the one document whose only
value is being accurate.

```bash
# from the repo root
cp specs/20260910-130448-feature-rbac-permissions/contracts/dump-routes.mts packages/server/
(cd packages/server && npx tsx dump-routes.mts) \
  | grep -E '^(GET|POST|PUT|PATCH|DELETE) ' > /tmp/routes.clean.tsv
rm packages/server/dump-routes.mts

python3 specs/.../contracts/gen-map.py /tmp        # validates: unmapped / stale
python3 specs/.../contracts/emit-md.py /tmp        # emits the markdown body
```

Three files, three jobs:

| File | What it is |
| :--- | :--- |
| `dump-routes.mts` | Walks `createApp()`'s mounted router stack and prints one `METHOD path\tguards` row per reachable route. ⚠ Must live inside `packages/server/` to run — it imports `./src/app.js` and needs that package's module resolution. |
| `gen-map.py` | The **only hand-authored part**: the `(method, path) → permission` assignment table. It **fails loudly** if any mounted route is unmapped or any map entry is stale. Currently reports `rows=265 ws=194 dep=49 exempt=22`, zero unmapped, zero stale (2026-10-14). |
| `emit-md.py` | Groups by `app.ts` mount, joins the current guards read from source, and writes the markdown. |

⚠ **`dump-routes.mts` reads Express 4's internal layer stack** — `layer.regexp.source` and
`layer.keys` — to reconstruct mount paths. That is internal shape, and it is the same cost
`wrapAsyncRoutes` already accepts on this codebase for the same reason: the alternative is
a regex over source, which reports nine false positives on `local-users.ts` alone (research
M-5). The implementation's own completeness check (`route-permissions.test.ts`) does the
same walk against the same app, so the two cannot disagree.

⚠ **Dedupe on `(method, resolved path)`.** `GET /flows/:flowId/phases` is registered twice
(`flows.ts` has the implementation; `flow-phases.ts`'s router is an unreachable placeholder)
and `releaseGatesRouter` is mounted twice. Without the dedupe the walk reports duplicates
that are not map errors.
