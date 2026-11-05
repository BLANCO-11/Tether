# Data Model: Next.js upgrade

This feature stores **no application data** and changes no schema, route or server behaviour (spec FR-020). The four
"entities" are artefacts the work produces and reads, kept as files in this feature directory.

## Baseline record — `baseline.md` (written in phase 0)

| Field | Content |
| :--- | :--- |
| `commit` | the commit the baseline was taken at |
| `node` | `node -v` (must be 22.x) |
| `typecheck` | exit code, and the error list (the known stale `.next/types` entries are cleaned first so it reads 0) |
| `tests` | test-file count, test count, pass/fail, run time |
| `honesty` | PASS / FAIL counts from `scripts/ui-honesty-check.sh` |
| `build` | exit code, warning lines verbatim, route list |
| `matrix` | the answers recorded for every row of [contracts/sign-in-gate.md](contracts/sign-in-gate.md) |
| `redirects` | status and `Location` for every legacy path |

**Rule**: later phases are compared to it field by field; a count lower than baseline fails the gate even when everything
that ran passed.

## Phase gate — a fixed checklist, not a file

Typecheck · full client tests · honesty check · `next build` · request matrix against the **built** app · smoke script ·
image build and start. A phase passes only when every item passes; the result of each run is appended to `gate-log.md`
with the commit hash it was run at.

## Smoke script — `smoke.md` (written in phase 0)

Ordered manual steps with an expected result each: sign in (local), sign-in with a return address, session expiry banner,
open a workflow, open the builder and hover/click nodes, open a run, trigger anything through the proxy, approvals,
members, audit, data sources, old-link redirects, version label. Every step has an expected result so "looks fine" is not
an answer.

## Gate decision table — `contracts/sign-in-gate.md`

The (request kind × session state) → answer table the gate must reproduce. It is the contract, not documentation.

## Relationships

`baseline.md` → compared by → every phase gate · `smoke.md` and the request matrix → run by → every phase gate ·
`gate-log.md` → one entry per phase gate run, newest last. No state transitions beyond *pending → passed* per phase;
a failed gate sends the work back to the previous phase's commit (spec FR-019).
