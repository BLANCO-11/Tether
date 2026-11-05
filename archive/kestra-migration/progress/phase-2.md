# Phase 2 — Visibility

**Status:** ✅ **DONE.** Exit criterion met; 2.6, 2.7 and 2.8 closed. 2.5 is deliberately deferred to
Phase 3 (D-12) — it depends on the `flows` table, which does not exist yet.
**Implements:** [08 §10 "Phase 2"](../08-scale-and-phasing.md) · [07 §7.3](../07-refactor-inventory.md)

The client seam that makes this cheap:

```
pages → lib/api.ts (1130)  →  lib/adapters.ts (445)  →  lib/foundry-client.ts (516)
         UI-shaped types        translation layer         HTTP
```

`adapters.ts` is where a Kestra execution becomes the UI's step-graph shape. Pages mostly don't
change to re-point a backend.

## Tasks

| # | Task | Status |
| :--- | :--- | :--- |
| 2.0 | **server** — `services/flow-visibility.service.ts` + `routes/flow-executions.ts` | ✅ not in the original list; see below |
| 2.1 | `components/flow/StepGraph.tsx` — nodes + edges + per-step status from `taskRunList` | ✅ |
| 2.2 | `components/flow/StepDetail.tsx` — inputs, outputs, logs, duration, error, audit verdict | ✅ |
| 2.3 | `lib/adapters.ts` — **the primary seam.** Kestra execution + Foundry metadata → UI types | ✅ |
| 2.4 | `lib/types.ts` — `StepRun`, `StepStatus`, `StepGraphShape`, `FlowExecutionSummary/Detail` | ✅ |
| 2.5 | Rebuild `app/(app)/automations/[id]/page.tsx` around the step graph | ⏸ **deferred to Phase 3** — built as `app/(app)/runs/[id]` instead (D-12) |
| 2.6 | Repoint `history/`, `dashboard/`, `home/`; `lib/stats.ts` from flow executions | ✅ — and it was hiding a wrong number (D-14) |
| 2.7 | Repurpose `components/automation/GenStageStrip.tsx` as a step-progress strip | ✅ `components/ui/Strip.tsx` + `components/flow/StepStrip.tsx` |
| 2.8 | `ws/progress-server.ts` — per-step progress from Kestra polling | ✅ ticket-authorised socket, polling as the fallback (D-15) |

**2.0 was missing from the plan and is most of the work.** The task list is client-only, but a
browser cannot read Kestra: R5 keeps the engine off any client-reachable network, and D-07 means the
token has to be stripped *before* the payload leaves the server. So the assembly — Kestra execution +
graph + logs + Foundry pointer rows, redacted — is a server concern. `adapters.ts` is still the seam
2.3 describes; it just maps a Foundry response rather than a Kestra one.

## Exit criterion

An engineer diagnoses a **deliberately broken step** from the Foundry UI alone — without opening
`kestra-ui` and without reading `stub_call_log`.

## Work log — 2026-07-29

**The exit criterion is met.** A deliberately broken step (`mail_send` with `recipients:
["not-an-email"]`) was deployed, run, and diagnosed from the Foundry API alone:

```
foundry: failed   engine: failed
  begin        success  580ms  http=200   body [redacted]
  screen       success  107ms  http=200   11 rows
  notify       FAILED    96ms  http=502   POST /api/steps/tool
     tool "mail_send": all 1 call(s) failed
     → HTTP 422 {"code":"unprocessable","message":"invalid recipient address(es)",
                 "details":["not-an-email"]}
  never_runs   — declared in the graph, absent from the run
```

The upstream stub's own 422 reaches the panel, so the answer is the actual reason and not "the step
failed". `kestra-ui` was not opened and `stub_call_log` was not read.

### Built

| | |
| :--- | :--- |
| `services/flow-visibility.service.ts` | The read model. Joins Kestra state/graph/logs to Foundry pointers, normalises the engine vocabulary, and redacts. |
| `routes/flow-executions.ts` | `GET /api/workspaces/:ws/flow-executions[/:id]`. Read-only, workspace-scoped, addressed by FOUNDRY id — a Kestra id is never exposed, so there is nothing for a client to point at Kestra with (R5). |
| `utils/redact.ts` + 7 tests | `redactSecrets` moved out of `routes/stub-api.ts`, plus `redactJsonString` for the JSON **string** Kestra stores a body as — which is where the token actually lives. |
| `components/flow/StepGraph.tsx` | Longest-path column layout over Kestra's real edges. No graph library. |
| `components/flow/StepDetail.tsx` | Error → request → per-item results → output → engine logs. |
| `app/(app)/runs/[id]/page.tsx` | The step graph, polling while the run is live. |
| `lib/{types,adapters,api,foundry-client}.ts` | The seam, plus `runFromFlowExecution` → the existing `Run` shape. |

### Three things worth carrying forward

- **`Run.steps` already existed** and had always held one synthetic entry ("Ran on the server").
  Filling it with real steps made History step-aware **without changing that page's rendering at all**
  — the seam doing exactly what phase-2.md predicted. Dashboard and home read the same `listRuns()`.
- **`engineStatus`, not `status`.** Foundry's row is written by the flow's own `complete` task, so a
  failed run leaves it `running` for ever (I-10). Every UI decision reads the engine's state; reading
  Foundry's would render a failed run as still going, and would never stop the poller.
- **Reconcile-on-read.** `get()` has just asked Kestra for the state, so closing a stale `running` row
  costs nothing — and the I-10 budget leak now heals as soon as anyone *looks* at the run, rather than
  at the moment `begin` refuses. Verified: `running` → `failed` on first read.

## Work log — 2026-07-29 (second pass: 2.6, 2.7, 2.8)

### 2.6 — the aggregates were not just unverified, they were wrong

Checking `lib/stats.ts` against flow rows turned up a real defect rather than a re-point. `Run.outcome`
was `"done" | "stopped"`, so **anything not yet finished was reported as stopped**: the dashboard
counted live runs as failures, the trend drew them red, and History offered *Fix & retry* on a run that
was still working. Invisible today (Phase 1 flows finish in ~1s), permanent from Phase 4 (an `agent`
step decodes for 5–6 minutes; an approval `Pause` sits for days).

Fixed with a third `outcome` value and one rule — **rates divide by settled runs, never by all of
them** — plus a third segment in the trend chart. Full reasoning in [DECISIONS.md](DECISIONS.md) D-14.
The same bug existed on the script path and was fixed there too: both backends land in one History
list and one set of aggregates until Phase 4.

`dashboardSummary` and `homeSummary` now aggregate `listRuns()` instead of reading `mockdb` directly.
That made one more thing necessary: `lib/runstream.ts` **invents** a live run for the "running now"
strip, which was harmless when the whole page was mock and is not harmless beside real numbers. It is
now gated on the rows actually being mock; with a live backend the strip shows real in-flight runs.

### 2.7 — the strip

The ladder markup moved to `components/ui/Strip.tsx`, shared by the Tether generation strip and the
new `components/flow/StepStrip.tsx`. Ordering comes from `lib/flow-graph.ts`, which the graph now uses
too — a strip that ordered steps differently from the graph beside it would undermine the one thing
this view has to be, which is trustworthy for diagnosis. Declared-but-unreached steps are shown greyed:
a strip that listed only what had run would shorten itself on failure and hide the steps that never
happened.

### 2.8 — pushed, and the interesting part is the authorisation

`services/flow-progress.service.ts` polls Kestra **once per execution** and pushes per-step diffs over
`/ws/flow-execution`; `/runs/[id]` consumes it through `lib/flow-stream.ts`, **falling back to the old
2s poll** when the socket is unavailable. Both paths read the same server-side assembly, so nothing is
reachable through one and not the other.

The authorisation was the real design question, because **the browser never holds `PARENT_API_KEY`** —
a same-origin Next route injects it, and a WebSocket cannot use that proxy. An id-only socket would
have been the only unauthenticated read path in the product, carrying the same data as the gated REST
route. So watching is a handshake: an authenticated `POST …/:id/watch` mints a single-use 60s ticket
bound to one (workspace, execution). See D-15.

**Measured against the live stack** (a deliberately slowed flow, so the stream had something to show):

```
1. socket, no ticket                → 1008 "invalid or expired ticket", no data
2. socket, forged ticket            → 1008, no data
4. streaming
     snapshot
     step slow_a=running            ← intermediate state, not just the settled one
     step slow_a=success
     step screen=success   http=200
     step excluded=success http=200
     step partition=success
     step slow_b=running
     step slow_b=success
     step notify=success   http=200
     step complete=success http=200
     execution engine=success
     end engine=success             → server closes 1000
5. replaying that same ticket       → 1008
6. minting from another workspace   → 404
   begin body over the socket       → "[redacted]"      (D-07 holds on the new channel)
```

11 unit tests pin the rest: single-use/expiry/binding, diff-not-poll, one poll for many watchers, a
late subscriber still getting a snapshot, survival of an unreachable engine, and the loop stopping
when nobody is listening.

### And it found a bug (I-12)

Needing a *live* execution row for the socket probe is what surfaced it: **every** row from
`GET …/flow-executions` had `engineStatus: null`. Kestra's execution search defaults to **oldest
first**, so `list()` was joining against the oldest 50 of 60 executions — zero overlap with the page
being rendered. It worked on a fresh instance and broke silently once the instance passed the page
size. Fixed with an explicit `sort=state.startDate:desc`, and the empty catch that hid it now logs.
Full write-up in [ISSUES.md](ISSUES.md) I-12.

### Still open, deliberately

- **2.5** — the automation page waits on the `flows` table (D-12), i.e. Phase 3.
- **`lib/runstream.ts` still exists.** It only runs on mock data now, but it fabricates runs and
  writes them to `mockdb`. It should go when the mock fallback does.
- **`/ws/generation` is still unauthenticated.** Pre-existing, and out of scope here — but the ticket
  pattern D-15 establishes is what it should adopt.
