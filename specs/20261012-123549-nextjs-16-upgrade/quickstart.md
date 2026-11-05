# Quickstart: running the gate

Prerequisites: Node 22 (`node -v`; the vitest config throws below 22), `pnpm install --frozen-lockfile`, the stack up
(`docker compose --env-file .env -f infra/docker-compose.yml up -d`) so the proxy has an API to forward to.

Run from the repo root unless stated.

## 1. Baseline (phase 0, once, on the untouched code)

```bash
rm -rf packages/client/.next                       # clears the stale generated types behind the "4 typecheck errors"
pnpm --filter @foundry/client typecheck            # expect 0 errors
pnpm --filter @foundry/client test                 # expect ~51 files / ~750 tests, exit 0
bash scripts/ui-honesty-check.sh                   # expect 196 PASS / 0 FAIL
pnpm --filter @foundry/client build                # record exit code and every warning line
```

Save the outputs in `baseline.md` (see [data-model.md](data-model.md)).

## 2. Prove the new checks can fail (phase 0)

For each new test, apply its perturbation, run only that test, and confirm it goes red; then revert:

| Test | Perturbation that must turn it red |
| :--- | :--- |
| Proxy route reads path from a Promise | read `ctx.params.path` without `await` |
| Deny-list via awaited path | drop one segment from the deny map |
| Login page reads Promise `searchParams` | read `searchParams.callbackUrl` without `await` |
| `[id]` pages given Promise params | call `use()` on a plain object (Next 14) / read `.id` off a Promise |
| Gate matrix | make the gate return `NextResponse.next()` unconditionally |

## 3. The gate (after every phase)

```bash
pnpm --filter @foundry/client typecheck
pnpm --filter @foundry/client test
bash scripts/ui-honesty-check.sh
pnpm --filter @foundry/client build
pnpm --filter @foundry/client start &              # the BUILT app on :4002, not `dev`
```

Then the sign-in-gate matrix ([contracts/sign-in-gate.md](contracts/sign-in-gate.md)), for example:

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:4002/dashboard          # G-1: 307 …/login?callbackUrl=%2Fdashboard
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:4002/api/foundry/x      # G-3: 401 application/json
curl -s -o /dev/null -w '%{http_code}\n'               http://localhost:4002/login                # G-7: 200
```

Legacy redirects (compare to baseline):

```bash
for p in /home /workflows /workflows/abc /runs /create /create/abc /create/templates /workflows/templates; do
  curl -s -o /dev/null -w "$p %{http_code} %{redirect_url}\n" http://localhost:4002$p
done
```

Image:

```bash
docker compose --env-file .env -f infra/docker-compose.yml build web
docker compose --env-file .env -f infra/docker-compose.yml up -d web
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4002/login
```

Finally follow `smoke.md` by hand and append the result to `gate-log.md`.

## 4. Bundler comparison (phase 2)

```bash
pnpm --filter @foundry/client exec next build               # default (Turbopack)
pnpm --filter @foundry/client exec next build --webpack     # comparison
```

Compare: the generated CSS contains the app's Tailwind classes; both font families' files are in the output; the version
label shows the root `package.json` version on any page.

## Expected outcomes

Every gate item green; test count ≥ baseline; the matrix identical to the baseline's; no new build warning; the image
serves `/login` with `200`. A red item sends the work back to the previous phase's commit.
