# Issues log — Kestra migration

Append-only. Every issue hit during implementation and the mitigation applied. Newest at the bottom
so the numbering is stable and a `I-nn` reference never moves.

**Status values:** `OPEN` · `MITIGATED` (worked around, root cause remains) · `RESOLVED` (root cause
fixed) · `ACCEPTED` (known, deliberately not fixed) · `WONTFIX`.

**Record an issue when:** something in the pinned design turned out to be wrong or under-specified,
a tool/version behaved differently than the plan assumed, or a fix required a non-obvious workaround.
Do **not** record ordinary implementation steps here — those go in the phase file's work log.

---

## I-01 — Host disk exhausted before any Kestra download

| | |
| :--- | :--- |
| **Phase** | 0 (pre-work) |
| **Found** | 2026-07-28, first environment check |
| **Status** | `RESOLVED` |

**Symptom.** `df -h /` reported 146G total, 140G used, **375M available (100%)**. The pinned Kestra
image is ~3.2 GB, so the very first step of the migration could not have run.

**Why it matters beyond the obvious.** This migration adds a JVM service, a second Postgres database,
Kestra's internal storage volume (O4), and — from Phase 4 — a per-fragment container image. Disk is
now a standing operational dependency of this stack, not a one-off.

**Mitigation.** User reclaimed space; 25G free at the time of the pull.

**Follow-up (not yet done).** O4 requires Kestra's internal storage to get a volume **and a retention
policy**. Without retention, large step payloads accumulate indefinitely and this recurs. Tracked in
[phase-1.md](phase-1.md).

---

## I-02 — Kestra basic auth fails silently unless the username is an email

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.1) |
| **Found** | 2026-07-28, first Kestra boot |
| **Status** | `RESOLVED` |

**Symptom.** `kestra.server.basic-auth` was configured with `username: foundry`. Kestra booted
clean — 53 Flyway migrations applied, 1404 plugins registered, health `UP` — and then **every** API
call returned `401`, including calls carrying exactly the credentials just configured. Unauthenticated
and correctly-authenticated requests were indistinguishable.

**Why it cost time.** There is no error. Nothing in the logs mentions auth, security, or credentials
— `docker logs | grep -i auth` returns nothing at all. The only observable signal is a single field
on an endpoint that happens to stay public:

```
GET /api/v1/configs  →  { ..., "isBasicAuthInitialized": false }
```

The natural diagnosis is "wrong config key path", which sends you looking through the jar for the
right one. The key path was right the whole time.

**Cause.** Kestra OSS ≥ 0.24 makes basic auth **mandatory** — the `enabled` flag is ignored entirely
— and the username is validated as an **email address**. `foundry` fails that validation, the
credential is never initialized, and the instance stays in its pre-setup state where everything 401s.

**Mitigation.** `username: foundry@foundry.local`. `isBasicAuthInitialized` flipped to `true`,
authenticated calls returned `200`, unauthenticated stayed `401`.

**Guard.** `scripts/kestra-boundary-check.sh` asserts unauthenticated API access returns exactly
`401`. That catches a regression in the *enforcing* direction. It does **not** catch this failure,
because an uninitialized instance also returns 401 — so the compose file carries the explanation at
the config site.

---

## I-03 — `internal: true` silently discards published ports (R5 vs R8 collide)

| | |
| :--- | :--- |
| **Phase** | 1 (tasks 1.2, 1.4) |
| **Found** | 2026-07-28 |
| **Status** | `RESOLVED` |

**Symptom.** Kestra was put on an `internal: true` network to enforce
[03 §4](../03-architecture.md)'s egress denials, with `ports: ["127.0.0.1:8080:8080"]` to satisfy R5's
"bound to localhost for internal engineers". Compose accepted both. The port was never reachable:
`docker port foundry-kestra` printed nothing.

**Cause.** A service whose only network is internal has **no gateway**
(`NetworkSettings.Networks[*].Gateway == ""`), so Docker cannot set up the DNAT that publishing
requires. It drops the stanza without warning. The two rules appeared to conflict.

**Resolution — they don't conflict; the port was the wrong mechanism.** The host is itself attached
to the internal bridge, so Kestra is reachable from the host at its container IP while nothing
off-host is routed to it at all. That is a **stronger** R5 boundary than a `127.0.0.1` bind, which
would still be exposed to anything that can reach the host's loopback (including other containers
via `host.docker.internal`).

**Mitigation.**
- `ports:` removed, with a comment at the site explaining that its absence is deliberate — a reader
  who "fixes" the omission re-opens the boundary.
- `pnpm kestra:ui` prints the current URL and credentials, since the container IP changes on recreate.
- `kestra-boundary-check.sh` asserts `docker port` is **empty**, so re-adding a published port fails
  the check.

---

## I-04 — Kestra held the Postgres **superuser** credential, bypassing the step API entirely

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.4) |
| **Found** | 2026-07-28, while verifying the boundary |
| **Status** | `RESOLVED` |

**Symptom.** Not a failure — a passing boundary check that was measuring the wrong thing. The egress
probes were green, but Kestra's datasource DSN was `foundry:foundry`, the Postgres **superuser**, and
`postgres` is necessarily on `kestra-net` because Kestra's own database lives on that instance.

So Kestra could `SELECT * FROM workspace_secrets`. Every credential the design keeps out of Kestra
(R2) was one query away, and the entire step API — the mechanism by which Foundry stays the sole
credential custodian — was **optional** rather than mandatory.

**Why the design reads as contradictory here, and isn't.** [03 §4](../03-architecture.md) says
`Kestra → Foundry's Postgres: deny`, while the deployment delta says to add a `kestra` database *on
the existing Postgres instance*. Those only reconcile through the credential, never through the
route: the route cannot be removed. This is the same lesson `CLAUDE.md` already records for G1 —
*"the primary control is the absent grants, not `default_transaction_read_only`."*

**Mitigation.** `kestra-db-init` now provisions a dedicated `kestra` role that owns only the `kestra`
database, and Kestra's DSN uses it. The owner credential never reaches the Kestra container.

Two details that would have made this wrong if missed:

- **`REVOKE CONNECT ... FROM PUBLIC` first.** `CONNECT` on a database is granted to `PUBLIC` by
  default, and `REVOKE ... FROM <role>` does **not** remove a privilege the role holds via `PUBLIC`.
  Revoking only from the named role would have looked correct and changed nothing. This is verbatim
  the bug the `hr_demo_alt` rehearsal caught (`production-substitution-plan.md` §14.12).
- The `kestra` database already existed, owned by `foundry`, with 53 Flyway migrations applied.
  It had to be **dropped and re-provisioned** under the new owner; changing only the DSN leaves a
  role that cannot touch its own tables.

**Verified.** `kestra` role → `foundry_parent`: `permission denied for database`. → `hr_demo`:
denied as well (WS-A had already revoked `PUBLIC` there). → its own `kestra` database: connects, owns
all 21 tables. Asserted by `pnpm kestra:check`.

---

## I-05 — Kestra ate 8.4 GiB, then OOM'd at 3 GiB. The 1404 bundled plugins were the cause.

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.1) |
| **Found** | 2026-07-28, first flow deployment |
| **Status** | `RESOLVED` |

**Symptom, in three escalating forms.** All of them present as *"Kestra is up and healthy but every
client call hangs"*, which is the least helpful possible signature:

1. Unbounded: **8.4 GiB RSS, 340% CPU**, host down to **242 MiB free**. Kestra logged
   `status: 200 | duration: 221` for a request the client never received — the response was
   generated and then never made it onto the socket.
2. With `mem_limit: 3g`: settled at **2.6 GiB / 3 GiB and 199% CPU with zero flows**, GC-thrashing.
3. Eventually `java.lang.OutOfMemoryError: Java heap space`, preceded by
   `Thread starvation or clock leap detected (elapsed since previous schedule 309483ms)` — a
   **five-minute** JVM stall — after which Kestra's own liveness coordinator declared its EXECUTOR,
   SCHEDULER, INDEXER and WORKER non-responding and shut the server down with **exit code 0**.

That exit code matters: `docker inspect` reports `OOMKilled: false`, so the obvious check says it was
*not* a memory problem. It was; the JVM died of heap exhaustion internally and shut down cleanly.

**Cause.** The full `kestra/kestra` image registers **1404 plugins from 201 groups** at boot. We use
`io.kestra.plugin.core.*` and nothing else. With no container limit the JVM sizes its heap from the
*host's* RAM and grows to fill it.

**Mitigation — two parts, both needed.**

| | |
| :--- | :--- |
| `kestra/kestra:v1.3.29-no-plugins` | **107 core plugins, 0 external.** This is the fix. |
| `mem_limit: 3g` + `-XX:MaxRAMPercentage=70` | Bounds the heap *below* the cgroup ceiling, so an over-run is a diagnosable `OutOfMemoryError` rather than a silent OOM-kill. |

Also `--worker-thread=4`; the default is 2× CPU count, i.e. 32 threads on this host for a flow that
runs seven HTTP tasks.

**Measured before and after, same host, zero flows:**

| | full image | `-no-plugins` |
| :--- | :--- | :--- |
| Steady RSS | 2.6 GiB (thrashing) → OOM | **417–487 MiB, flat over 4 min** |
| Steady CPU | 199% | **~2%** |
| Image size | 3.87 GB | 480 MB |

This **amends D-01**, which chose the full image to avoid pinning a plugin version separately. That
reasoning was sound and the outcome was still wrong: the engine did not fit. Phase 4 will need the
`scripts` plugin installed and pinned explicitly — one extra pin, in exchange for an engine that runs.

**Aftermath worth knowing.** Once Kestra had OOM'd, its database was left in a state where **every
flow write hung forever** while reads kept working and nothing was logged. Dropping and re-creating
the `kestra` database fixed it instantly (a flow write went from ∞ to 0.84s). If writes hang and
reads do not, suspect poisoned queue state before suspecting your own code.

---

## I-06 — `PUT` to a non-existent Kestra flow never responds

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.5) |
| **Found** | 2026-07-28 |
| **Status** | `RESOLVED` |

**Symptom.** `deployFlow` used the conventional shape — `PUT` the flow, and on `404` fall back to
`POST` to create it. Against Kestra `v1.3.29`, **`PUT` to a flow that does not exist yet never
returns.** Not a 404, not a 405, not an error: the connection stays open until the client gives up.
Kestra logs *nothing*, because its access log is written on request completion.

Confirmed by direct comparison, so it is not a client artefact:

| Request | Result |
| :--- | :--- |
| `POST /flows` (create) | **200 in 0.84s** |
| `PUT /flows/{ns}/{id}` where the flow exists | 200 |
| `PUT /flows/{ns}/{id}` where it does **not** | **hangs indefinitely** |
| `POST /flows/validate` with the same YAML | 200 |

**Why it took so long to see.** Node's `fetch` has a **five-minute** default headers timeout and
collapses every transport failure into the string `fetch failed` with the real reason hidden on
`.cause`. So the observable was: the script sits silent for five minutes, then prints `fetch failed`
with no status, no URL, and no code — while `curl` against the same endpoint worked, because the
manual tests were all against flows that already existed. It read like an intermittent network fault
and it was a deterministic API behaviour.

**Mitigation — three changes, each independently worth keeping:**

1. `deployFlow` **checks existence with a GET first**, then POSTs or PUTs. One extra request on the
   create path, and the hang is unreachable.
2. `KestraClient.request()` sets `AbortSignal.timeout(30_000)`. Every call here is a control-plane
   operation that should take milliseconds; five minutes of silence is never the right default.
3. Transport failures unwrap `.cause` into a `KestraError` carrying the URL and the undici code, so
   `UND_ERR_HEADERS_TIMEOUT` and `ECONNREFUSED` stop looking identical.

Change 3 is what actually produced the diagnosis. Without it the error names nothing.

---
## I-07 — `POST /api/executions/begin` trusted the namespace in the request body (R4)

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.9) |
| **Found** | 2026-07-29, writing the assertion-6 verification |
| **Status** | `RESOLVED` |

**Symptom.** Not a failure — a check that passed while measuring the easy half. `begin`
parsed the body's `namespace`, looked it up, and 403'd when it did not resolve. Five forged
namespaces all returned 403 and the assertion looked satisfied.

But `foundry.default.hr-alt-swap-rehearsal` **parses fine and resolves fine.** A flow deployed in
one workspace's namespace could name a *different* real workspace in its `begin` body and be handed
that workspace's execution token — and with it, that workspace's datasources and secrets through
`/api/steps/*`. Measured before the fix: **200, with a token.**

**Why it survived review.** The namespace is validated, and validation reads as authorisation.
It isn't: parsing proves the string is well-formed, and lookup proves the workspace exists. Neither
proves the *caller* is entitled to it. R4 says "never trust a client-supplied namespace" and the body
is client-supplied — the only question was who the client is, and the answer (Kestra) made it feel
trusted.

**Reachability today, stated plainly so it is not overstated.** Only Kestra holds the callback secret,
and only the compiler emits flows (R8), so nothing can currently author the malicious flow. It is a
**defence-in-depth failure, not a live vulnerability** — and Phase 5 is client authoring.

**Mitigation.** The namespace is now **read from Kestra**, not from the body. `begin` calls
`GET /executions/{id}` and uses the namespace and flow id Kestra reports; the body's values are
cross-checked and a mismatch is a 403 with a `console.warn` (the only two ways to reach it are an
attack and a compiler bug, and both need to be visible).

Three properties that make the fix hold:

- **An execution's namespace is set at deploy time.** A flow cannot lie about where it lives, so
  Kestra's record is an authority the flow does not control.
- **It fails CLOSED.** Unknown execution id → 403. Kestra unreachable → **503**, not a fallback to
  the body — otherwise the check is bypassable by anything that can also cause a timeout.
- The extra round trip is one control-plane GET on execution start.

**Verified.** `pnpm kestra:verify` deploys a flow into HR's namespace whose `begin` claims the other
workspace and asserts: `begin` FAILED, no `flow_executions` row, **no token minted**.

---

## I-08 — `PRODUCTION_DRY_RUN.md` is gone, so the "three measured scenarios" are reconstructed

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.12) |
| **Found** | 2026-07-29 |
| **Status** | `ACCEPTED` |

**Symptom.** The README's gate is *"rebuild **the three measured scenarios** as flows"*. The prompts
and results of those three runs lived in `PRODUCTION_DRY_RUN.md`, which was **never tracked in git**
and no longer exists on disk. `d33825e` recovers the other deleted plan docs; it cannot recover this one.

**What survives.** `CLAUDE.md` records the aggregate — 1 of 3 first-pass, and the failure modes:
fabricated dates, invented enum values, guessed response field names, missing `COALESCE`, and the run
that *"hardcoded `period='2023-10'`, emailed 0 of 11, and still exited 0 with `tests_passed=true`"*.

**Mitigation.** Three scenarios **reconstructed from the failure modes** rather than the prompts, each
a different shape (see DECISIONS.md D-08). Every one is scored against an oracle, and the side effects
are scored from `stub_*` independently of what the flow reported.

**What this costs, stated honestly.** "3 of 3 against 1 of 3" is **not** a like-for-like comparison —
the baseline ran different prompts. What the run does establish is stronger than a count: each
scenario targets a specific measured failure mode, and each of those modes is now structurally
unreachable rather than merely less likely. Do not quote the two numbers side by side without this
paragraph.

---

## I-09 — an empty step batch was rejected, so a flow worked in a bad month and broke in a good one

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.8) |
| **Found** | 2026-07-29, running the scenarios at period `2026-05` |
| **Status** | `RESOLVED` |

**Symptom.** Every scenario passed at `2026-06` and two of three **failed** at `2026-05`. In May
nobody is below the attendance bar, so `notify` and `raise_tickets` were called with `params: []` —
and `stepBatchSchema` had `.min(1)`, so the step API returned 400 and the execution FAILED.

**Why it matters more than it looks.** The oracle agreed with the flow throughout: 0 flagged, 0
emails, correct. The *work* was right and the run was marked a failure. Inverted, that is a screening
automation which succeeds in every month with a problem and pages someone in every month without one
— and the alert fires when nothing is wrong, which is exactly the way to teach a team to ignore it.

**Cause.** `.min(1)` was written for the case it does cover — a no-parameter query still needs one
entry to produce one result — and an empty *array* was never distinguished from a malformed request.

**Mitigation.** `params` accepts an empty array, and both handlers short-circuit to
`{results: [], succeeded: 0, failed: 0, warnings: []}` **before** resolving the tool or decrypting a
credential: with nothing to call there is nothing to authorise, and doing the lookup anyway would make
"zero work" fail for reasons unrelated to the work.

**Only visible at a second period.** Every check ran green at `2026-06` beforehand. `pnpm kestra:prove`
now takes `--period=`, and all three scenarios are scored at `2026-04`, `2026-05` and `2026-06`.

---

## I-10 — a failed execution consumed an M3 budget slot permanently

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.9) |
| **Found** | 2026-07-29, immediately after I-09 |
| **Status** | `RESOLVED` |

**Symptom.** Once I-09 had failed a few executions, `begin` started returning **429
`budget_exceeded`** for every new run. `flow_executions` held 5 rows at `status='running'` against the
default budget of 5. The workspace could no longer start anything.

**Cause.** `complete` is a **task in the flow**. An execution that fails never reaches it, so its row
stays `running` for ever. The budget counts rows, not reality — so every failure permanently spent a
slot, and five failures bricked the workspace via a *fairness* control.

This is the same shape as the known Tether defect (`activeRuns` in memory with no boot
reconciliation): state owned by one system, inferred from an event the other system may never send.

**Mitigation.** `begin` reconciles before refusing. On the refusal path only — the one moment the
count must be right — every `running` row is checked against `GET /executions/{id}` and closed with
the terminal status **Kestra reports** (R6: Kestra is the system of record, so this copies a status
and never invents one). Tokens are burned at the same time. A row Kestra has no record of is closed
`cancelled`, since O4's purge deletes old executions and a purged execution is not running. If Kestra
is unreachable the row is left alone — guessing would close a live execution and let the budget be
exceeded.

**Not fixed by "have the flow call complete on error".** An `errors:` handler cannot help when
`begin` itself is what failed: there is no token to authenticate with.

---

## I-11 — two Pebble/jq rules that fail silently, and cost three executions

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.11) |
| **Found** | 2026-07-29, building scenario C |
| **Status** | `RESOLVED` |

Both are properties of Kestra's templating, not of this design, and both will be hit again by the
Phase 5 compiler. Recorded so they are hit once.

**1. Pebble does not re-evaluate `{{ }}` inside an expression's string argument.**

```yaml
# WRONG — reaches jq as the literal characters "{{ inputs.period }}"
| jq('{ text: ("Roll-up for {{ inputs.period }}") }')
# RIGHT — `~` is Pebble's concatenation operator
| jq('{ text: ("Roll-up for ' ~ inputs.period ~ '") }')
```

No error. The braces travel through jq into the output, and the symptom was a chat message reading
*"Attendance roll-up for `{{ inputs.period }}`"*. In the channel-lookup filter the same mistake made
`select(.name == "{{ inputs.channel }}")` match nothing, so the resolved channel was silently empty.

**2. `| first` unwraps a jq STRING into a raw string — quotes and escaping gone.**

So a rendered string cannot be dropped into a JSON body:

| What was interpolated | What the body became |
| :--- | :--- |
| a report containing newlines | `Illegal unquoted character (CTRL-CHAR, code 10)` |
| the channel `#hr-ops` | a bare `#`, read as a YAML/JSON comment |

Arrays and objects **do** render as JSON. So the unit of interpolation must be the array:

```yaml
# The whole params array is built in jq, which does the escaping.
"params": {{ json(outputs.summarise.value).params | jq('.') | first }}
```

**Rule for the compiler: never interpolate a rendered string into a JSON body. Build the JSON value
in jq and interpolate that.**

---

## I-12 — Kestra's execution search returns the OLDEST page, so every recent row lost its engine status

| | |
| :--- | :--- |
| **Phase** | 2 (found while building 2.8) |
| **Symptom** | `GET …/flow-executions` returned `"engineStatus": null` for **every** row |
| **Severity** | High — silent, and it gets worse with age, not better |

`flowVisibilityService.list()` fills each row's live state from one Kestra call:

```ts
const page = await kestra.listExecutions(ns, { size: Math.min(Math.max(limit, 50), 200) });
for (const e of page.results ?? []) engineState.set(e.id, toStatus(e.state.current));
```

**`/api/v1/main/executions/search` defaults to OLDEST first.** Measured on the live instance: 60
executions in the namespace, and page 1 began at `08:17:54` — the *first* run of the day. So the 50
ids fetched and the ~5 rows being rendered had **no overlap at all**, every lookup missed, and every
`engineStatus` came back null.

Three things made it hide:

- **It works on a fresh instance.** While the total is under `size`, the window contains everything
  and the join is correct. It broke silently once the instance passed 50 executions — so it would
  have shipped, and then started failing on its own with no change to blame.
- **`engineStatus: null` is a legal value**, meaning "Kestra could not be asked". The type says
  nothing is wrong.
- **The catch was empty.** Written to survive a restarting engine, it also swallowed the diagnosis;
  it now logs, and that is the general lesson — *a degrade-gracefully catch must still say what it
  degraded from.*

**Fix.** `listExecutions` sorts explicitly: `sort=state.startDate:desc`. Note the field — plain
`startDate` is rejected with `422 Invalid sort field`, and that 422 would have been swallowed by the
same catch, i.e. the obvious spelling fails in exactly the way that hides it.

**Why it did not show up in the UI first.** `listFlowRuns()` fetches every summary in FULL, and
`get()` reads the engine per execution, so History was right by accident. The summary endpoint was
wrong, and its own comment anticipates dropping the N+1 fetch for "a server-side projection" — which
would have promoted this to a visible wrong answer.

**Found by**: needing a *live* row for the 2.8 socket probe, and finding the poll never saw one.
Nothing in the test suite would have caught it: it needs a real Kestra with more executions than the
page size.

---

## I-13 — approval records a "second pair of eyes" that nothing can authenticate

| | |
| :--- | :--- |
| **Phase** | 3 |
| **Status** | **OPEN** — mitigated to the extent this codebase permits |
| **Severity** | Medium. It weakens gate 2 to an audit trail; it does not weaken gates 1 or 3. |

[§6.5](../05-lifecycle-and-flows.md) requires an approver who is "a distinct authenticated human with
the approver role, not the API key that created the flow", and [§5.0](../03-architecture.md) frames
approval as **separation of duties**.

Foundry has **one shared `PARENT_API_KEY` and no user model.** There is nothing to authenticate a
human against, so `flow_approvals.approver_user_id` is whatever the caller puts in the body.

**What was built anyway, and why it is still worth having:**

- The approve endpoint **requires** an approver identity and records it with the approval, so there is
  an audit trail from the first approval rather than a column backfilled later.
- Approval is **refused when the approver equals `flow_revisions.created_by`**. Against a determined
  caller that is nothing; against the actual common case — one engineer clicking through their own
  change — it is the check that catches it.
- `approver_kind` (`client_admin` | `foundry_operator`) is recorded now, which is what §6.5's deferred
  tightening ("require Foundry-operator approval for write-capable flows") will need.

**What must NOT be said about it.** Not "Foundry enforces separation of duties", and not "approvals
are attributable". Both are true only once user auth exists. The revision binding is the real control
in Phase 3: an approval names a specific immutable revision, and that holds regardless of who claimed
to make it.

**Fix when it lands:** authenticate the approver, then this becomes the control §6.5 describes with no
schema change — the columns are already the right ones.

---

## I-14 — the staleness sweep skipped every flow anyone had ever edited

| | |
| :--- | :--- |
| **Phase** | 3 |
| **Status** | FIXED |
| **Severity** | High. The control silently covered almost nothing, and its failure mode is "an armed schedule keeps firing against a manifest nobody re-checked". |

`flowRepo.listArmed()` — the staleness sweep's work list — selected `WHERE status = 'armed'`.

`status` is a **UI-facing summary**, and it moves for reasons that have nothing to do with what is
deployed. In particular `flow.service.writeRevision` sets it to **`draft_pending`** when an armed
flow is edited, which is the normal state of any flow that has been touched since it was approved.
So the sweep's work list was "armed flows nobody has edited" — a set that empties over time and never
refills.

**Fixed** by keying on the fact instead of the summary: `listLive()` selects
`armed_revision IS NOT NULL`.

**Why it was caught.** Only because the verification script does the two things in sequence that a
unit test would have kept apart:

```
11  edit an armed flow      → status becomes draft_pending
12  change a tool's shape   → sweep → expected suspension
```

A test that armed a flow and immediately changed a tool would have passed. So would one that read
`checkStaleness()` directly — the bug was entirely in *which rows it was called for*.

**The general lesson**, worth more than the fix: **a sweep must select on the fact, never on a status
string that exists for display.** A denormalised status has one job — telling a human what is going
on — and the moment a control filters on it, every future status value becomes a silent change to
what that control covers.

**Confirmed both ways.** `pnpm --filter @foundry/server kestra:phase3` fails 4 assertions on the old
query and passes 39 of 39 on the new one, at both `2026-06` and `2026-05`.

---

## I-15 — a `code` step failed with `Permission denied` on a file that plainly existed

| | |
| :--- | :--- |
| **Phase** | 4 (task 4.4) |
| **Status** | FIXED |
| **Severity** | Medium as a bug, high as a trap. It cost an hour and every symptom pointed at the wrong subsystem. |

The first `code` step ever run died with:

```
python: can't open file '/tmp/kestra-wd/tmp/2AL9…/10444432543738752431.py':
  [Errno 13] Permission denied
```

`EACCES` on a script Kestra had just written reads as a **file-mode or uid** problem, and the base
image did in fact run as a non-root user at that point — so the obvious diagnosis was available,
plausible, and wrong. Removing the non-root user made it pass, which *confirmed* the wrong diagnosis.

**The actual cause is path identity.** A `code` step's container is a **sibling** on the host daemon,
not a child of Kestra's, so every path Kestra hands to `docker run` is resolved by the daemon against
the **host** filesystem. `/tmp/kestra-wd` was a named volume, so it exists inside the Kestra container
and **nowhere on the host** — and Docker's response to a missing bind source is to create it, as a
**directory**. `python <a directory>` reports `EACCES`, not `EISDIR`.

Two aggravating facts, both worth knowing before touching this again:

- **Snap Docker's daemon has a private `/tmp`.** Kestra's own DinD documentation says to bind
  `/tmp/kestra-wd:/tmp/kestra-wd`, and on a snap host that silently resolves to a *different*
  directory than the one you created. Verified directly: a file written to the host's
  `/tmp/kestra-wd` is invisible to a container binding the same path.
- **Snap also remaps `$HOME`.** `${HOME}` in the compose file is expanded by the snap-confined
  `docker` CLI, so the working directory is really
  `/home/<user>/snap/docker/<rev>/.foundry/kestra-wd`. That is *fine* — both sides agree, which is
  the only property that matters — but it means comparing the two path strings would not have caught
  the original bug either.

**Fixed** by binding a host path at an identical absolute path
(`${HOME}/.foundry/kestra-wd`) and pointing `kestra.tasks.tmp-dir.path` inside it. The non-root user
was dropped separately and for a separate reason — see `infra/fragment-base/Dockerfile`; Kestra
stages the script mode 600 owned by root and nothing on our side of the boundary can widen it.

**Now asserted, by round trip rather than by string comparison** (`pnpm kestra:check`): Kestra writes
a marker into its working directory and a sibling container is required to read it back. A string
comparison would have passed on the snap host while the two paths pointed at different directories.

---

## I-16 — drizzle-kit emits `DROP TABLE … CASCADE` before the dependants it cascades away

**Phase 4, task 4.11.** Generating the migration that drops `scripts`, `script_versions`,
`test_results` and `execution_results` produced this order:

```sql
DROP TABLE "execution_results" CASCADE;
…
ALTER TABLE "trigger_fires" DROP CONSTRAINT "trigger_fires_execution_id_execution_results_id_fk";
ALTER TABLE "triggers"      DROP CONSTRAINT "triggers_script_id_scripts_id_fk";
DROP INDEX "idx_triggers_script";
ALTER TABLE "triggers" DROP COLUMN "script_id";
```

`CASCADE` has **already removed those constraints** by the time the `ALTER`s run, so each one fails
with `constraint … does not exist`.

**Why it is worth an issue rather than a shrug.** The failure is not the annoying kind that stops
before doing anything — the migration dies **half-applied**. The four tables are gone and
`triggers.script_id` is still there, so the schema matches neither the old code nor the new one, and
re-running fails again on the first statement. On a database with real content there is no forward
path that does not involve hand-written SQL.

**Fixed** by hand-editing `0014_tiny_colossus.sql`: dependants are detached **first**, the drops come
last, and every statement is `IF EXISTS` so a partially-applied run can simply be repeated. The
reasoning is written into the migration itself, because the next person to regenerate it will get
drizzle-kit's order back.

**Also kept deliberately:** `trigger_fires.execution_id` survives as a plain `uuid` with its FK
removed rather than being dropped. `trigger_fires` is an audit trail, and rewriting history so it
matches a new schema is the one thing an audit trail must not do.

---

## I-17 — a two-character needle is not a test

**Phase 4, task 4.11.** Rewriting the swap rehearsal's P2 block for fragments, one new assertion was
*"a fragment's prompt names no dataset"*, checked against a list that included `ALT_SCHEMA`.

It failed immediately. `ALT_SCHEMA` is the two characters **`"hr"`**, and
`expect(prompt).not.toContain("hr")` matched inside the word **`threshold`** — a field name in the
test's own fixture contract.

Trivial to fix, and worth recording for the general shape: a substring assertion over generated text
is only as good as the specificity of its needle, and a short one produces a **false positive that
looks like a real leak**. Half an hour reading `step-contract.service.ts` for a dataset reference
that was never there is the cost, and the more expensive version of the same mistake is the opposite
— a needle so specific it never matches, giving a test that passes for ever.

**Fixed** by asserting the schema-QUALIFIED form (`hr.staff`, `hr.presence_vs_policy`), which is both
specific enough to mean something and the actual shape a leak would take.

---

## I-18 — a partial replay past an `agent` step would pause for ever

**Phase 6, task 6.1.** Not a bug that was hit; a bug that was **found by reading the resume path
before writing the feature**, and then closed structurally rather than fixed.

A Kestra replay from step N rehydrates the upstream outputs — including `outputs.begin`, which carries
the execution credential. So a replayed step authenticates as the **original** execution:
`req.stepAuth.flowExecutionId` names the original row, `agentRunService.start` writes its
`flow_step_runs` row under that row, and the resume path then reads
`flow_executions.kestra_execution_id` **from the original** and calls
`kestra.resumeExecution(<the original, already terminal, execution>)`.

The replay is never resumed. It sits `PAUSED` until `pauseDuration` expires — which is the failure that
looks most like *"the agent is still thinking"*, and the least likely to be diagnosed as a replay
problem. Worse, it consumes an M4 agent-run slot and a Tether run on the way.

**Closed by refusing it.** `flow-replay.service.ts` computes the transitive dependents of the replay
point from `dependsOn` and refuses when any of them is an `agent` step, naming the step and the
alternative ("replay the whole execution"). Fail-closed rather than fixed, because the fix — rewriting
step-run attribution so a replayed step attaches to the replay's own row — needs the credential to
name the replay, and the credential is rehydrated by the engine.

**The mis-attribution itself is left in place and ASSERTED** (`kestra:phase6`): a replayed step writes
its pointer row under the original execution, and zero under the replay's own id. It is harmless for
display, because the step view is assembled from the engine by the replay's own execution id — and the
one path where it is not harmless is the one now refused. Asserting it means a change to it is noticed
rather than discovered.

---

## I-19 — "did this step re-run?" is invisible in both of the obvious signals

**Phase 6, task 6.1.** The single question a replay assertion has to answer is *"did this step run
again, or was its result reused?"* — and **two successive attempts to check it passed for the wrong
reason.**

**Attempt 1: task state.** `expect(taskState(replay, "begin")).toBe("ABSENT")`. It failed with
`SUCCESS`, which read as *"`begin` re-ran, so the whole hazard analysis in D-26 is wrong"*. It is not:
a replay **copies** the taskruns before the replay point into the new execution, carrying their state.
`begin` and `screen` both read `SUCCESS` in a replay that executed neither. State cannot distinguish
the two cases at all.

**Attempt 2: taskrun id.** *"A copied taskrun keeps its id; a re-executed one gets a new one."*
Plausible, and false — the engine mints fresh ids for the copies too. So "the id changed" is true for
every task in the replay and means nothing. This attempt **failed loudly**, which was lucky: the same
assumption written the other way round (`toBe(originalId)` → `not.toBe(originalId)`) would have passed
for every task and looked like a thorough test.

**What actually answers it is the side effect on Foundry.** A `tool` or `datasource` step can only run
by calling back into `/api/steps/*`, and every such call writes a `flow_step_runs` row keyed on its
taskrun. One row → it did not run again. Two → it did. And `begin` is the only thing that mints an
execution credential, so **zero rows in `execution_tokens` for the replay is proof `begin` did not
execute** — which is the fact all of D-26 rests on.

The general shape, and it is the same lesson as I-12 and I-17: when asserting that something did *not*
happen, assert on the **trace it would have left**, not on a status field that a copy also populates.

---

## I-20 — the HR dataset flags nobody outside its reporting month

**Phase 6.** `kestra:phase6` was green at `2026-06` and failed at `2026-05` with
`got 0.00 / want -Infinity`.

`expectedScreening` flags **11** employees at `2026-06` and **0** at both `2026-04` and `2026-05` — the
dataset's traps are tuned to the reporting month. The harness computed its expectation as
`Math.max(...flagged.map(...))`, and `Math.max()` of an empty array is `-Infinity`, so the *expectation*
was nonsense while the flow's answer (`0`) was right.

Two things came out of it, and the second is the useful one:

- **Fixed** with a `worstShortfall()` helper that returns 0 for an empty set. The naive spread is a
  trap in TypeScript specifically because it produces a *plausible-looking numeric* rather than an
  error.
- **A period with nothing to report is now its own assertion.** `max()` over an empty sequence
  *raises* in Python, so a fragment that does not seed its accumulator fails on exactly the period
  where there is nothing to report — and that is the period nobody demos. The harness now asserts that
  an empty run reports `0` and still succeeds.

This is the third time *"run it at more than one period"* has paid for itself (I-09, I-10, now this).

---

## I-21 — the stack came up green with the fragment base image missing

**Deployment prep, after Phase 6.** Symptom: everything healthy, every `code` step dead.

`foundry/fragment-base:py3.12-pandas2.2.3` was built by a `docker build` line **in a comment**
(`infra/fragment-base/Dockerfile`). Nothing in compose, no package script and no CI step built it. On a
host where it had been built by hand once, everything worked; on a fresh host, compose reported
healthy, `kestra:check` passed 13/13, the engine served every request — and the first `code` step failed
at execution with an image-not-found.

What makes this worth an entry is that **every health signal was true.** Nothing was wrong with the
engine, the network, the database or the compiler. The stack was correctly reporting on everything
except the one artefact that had never been produced, and the diagnosis surfaced as a Docker error
inside a task log, after approval, mid-run.

**Mitigation (D-29):** `fragment-base` is a one-shot compose service, so `docker compose build`
produces it and `up` fails at deploy time; `kestra` depends on its completion; and `kestra:check`
asserts the image is present on the **host** daemon (fragments are sibling containers, so the host's
image list is the one that matters).

The general lesson, which applies past this image: **a build artefact that only a comment knows how to
produce is not part of the deployment.** Anything a run needs at run time has to fail at deploy time.

---

## I-22 — two response bodies hand Kestra addressing to a client

**Found by `e2e:ui`, not by a unit test.** Recorded rather than fixed; see the reasoning below.

`ExecutionView.id`'s own docblock says *"The client never sees a Kestra execution id — it is not
addressable by a client (R5)"*, and `flow-executions` is built that way throughout: executions are
addressed by their Foundry id, the socket takes a ticket, replay takes a `fromStepId`. But two write
routes return engine identifiers in their success bodies:

| route | leaks |
| :--- | :--- |
| `POST …/flows/:id/test-run` | `kestraExecutionId`, **and** `namespace` |
| `POST …/flows/:id/triggers/:tid/fire` | `kestraExecutionId` |

The UI ignores both — `flows/[id]/page.tsx` renders *"Test run started against the draft"* and then
finds the run by listing `flow-executions` — so this is reachable only by an API client.

**Why it is not being changed in this pass.** It is not currently exploitable: Kestra publishes no port,
its only network is `internal: true`, and `begin` reads the namespace **from Kestra** rather than from
any request, so a caller holding both strings still cannot address the engine or impersonate a
workspace (I-07). And `kestra:phase3` reads `testRun.kestraExecutionId` to find the execution it
just started, so removing the field is a change to the harness contract, not a one-line edit.

**Why it is written down anyway.** The value is not the leak, it is the drift: a stated invariant and
the code disagree, and the disagreement is in the direction where a future client feature gets built on
the leaked field. The fix, when it happens, is for both routes to return the **Foundry** execution id —
which also removes the poll-the-list dance the UI currently does to find the run it just started.

---

## I-23 — `flowId` on an execution is the KESTRA flow id, not Foundry's

**Found by `e2e:ui` within minutes of it being written, and found the honest way: the harness
filtered the runs list by the flow id it had just been handed, got nothing, and reported two hard
FAILs on runs that had in fact succeeded.**

`flowVisibilityService` sets `flowId: r.kestraFlowId` in **both** `list()` and `get()`. So an
execution's `flowId` is a slug like `"e2e-ui-journey"`, while `flowId` everywhere else in the API —
`/flows/:flowId`, `FAFlow.id`, `flow_executions.flow_id`, `replayOfId` — is a uuid. `ExecutionView`
declares it `flowId: string` with no note to the contrary, and `FAFlowExecutionSummary` mirrors that.

**Why nobody noticed.** The UI only ever renders it as a LABEL: `runs/[id]/page.tsx` uses it as the
page title and `adapters.ts` passes it as `automationName`. A slug reads perfectly well in both
places, and neither is a link. So the product looks right.

**Why it is still wrong.** It is not usable as an identifier, and the way it fails is silent:

- A client holding a flow (a uuid, because that is what every other route returns) and filtering the
  executions list gets **zero rows** — indistinguishable from "this flow has never run".
- `kestraFlowId` comes from the model id, so a flow that is **deleted and recreated** reuses it. Two
  different Foundry flows then produce executions that are indistinguishable in this view. That is not
  hypothetical: `e2e:ui` deletes and recreates `e2e-ui-journey` on every run, which is precisely how
  the harness got a match on a *previous* run's execution.

**Mitigation applied:** none in the API — recorded, and `e2e:ui` now identifies a new run by
snapshotting execution ids before it starts and looking for one that was not there, which is correct
regardless of what `flowId` means.

**The fix, when it is taken:** return Foundry's `flow_id` as `flowId` and add the slug as its own
field (`kestraFlowId`, or better `flowName` for display), updating the two label call sites. Note
`flow_executions.flow_id` is **nullable** — flowless Phase-1 history exists — so the new field must be
`string | null` and the UI must keep a label for the null case.

**The general shape, which is the reusable part.** A field whose only consumer renders it as text will
type-check, look right and stay wrong indefinitely — two id spaces under one name, discovered by the
first consumer that tried to *use* it. This is the same class as I-22 (a documented invariant drifting
from the code) and the reason a journey test that only drives the client surface finds things unit
tests do not.

---

## I-24 — the agent runtime silently destroyed the `insufficient_contract` channel

**Stage:** away-from-demo-mode 6b · **Found by:** `kestra:refusal`, the first time it ran ·
**Mitigation:** D-35

The migration's central mitigation for the measured `period="2023-10"` failure is that a fragment
generator gets a **second output channel** — `insufficient_contract` — so "I was not given a period" is
a successful answer rather than something it has to invent its way past. Every part of it was
unit-tested: the prompt offers both channels, the parser rejects a status-less body, the loop stops on
a refusal rather than re-asking. The one thing never run was a real model against a real insufficient
contract.

**First measurement, through Tether: 0 refusals seen, 0 inventions, 5 unparseable.**

The model refused correctly every single time. Foundry saw none of it. The refusals were sitting in
the raw text describing themselves in the **past tense**:

> *"I cannot fulfill this request because there is no Python script to run. My previous response
> indicated that the contract was insufficient to write the code…"*

Every Tether run "always attaches the mandatory `script-gen` skill" (`Foundry-Harness/API.md`), whose
protocol runs further turns after the model answers — write the script, smoke-test it, emit
`artifacts/RESULT.json`. `finalMessage` is therefore the **last thing the agent said**, not its answer
to the prompt. The JSON was two turns upstream and gone.

⚠ **It failed ASYMMETRICALLY, and that is what made it dangerous rather than merely wrong.** A
satisfiable contract answers on the first turn and its JSON survives — the control passed 5 of 5. So
the transport worked whenever the answer was *yes* and mangled it whenever the answer was *no*.

And the downstream consequence is the exact failure §6.7 exists to forbid: `generateFragment` treats
an unparseable body as a static finding and **retries**. Re-asking is how a correct refusal becomes an
invented value on attempt 2. The rule was never reached, because a refusal never presented as one.

**Mitigation applied:** `GatewayInference` (D-35) — one request, one answer. Re-measured: **5 refused,
0 invented, control 5/5 produced clean code**, naming both missing fields.

**The general shape, which is the reusable part.** A mechanism can be correct at every layer that has
a test and be defeated by the transport underneath them. Nothing in the prompt, the parser or the loop
was wrong; the channel simply never arrived. Unit tests cannot see this class, and the only thing that
can is running the real thing and looking at what actually came back — which is why the harness prints
the raw text on an unparseable response rather than just the parser's message.

---

## I-25 — an agent run that did not complete reported SUCCESS

**Stage:** away-from-demo-mode 6b · **Found by:** running `showcase-agent-triage` end to end ·
**Mitigation:** D-36

`agent-run.service.ts` has always resumed the Kestra pause with an outcome — `succeeded` or `failed`,
covering a failed Tether run, a `needs_review`, and the deadline abandonment. **Nothing read it.**

So the Pause simply un-paused. The downstream step read `.result`, which on a failure is the *error
message*, and posted it to chat as though it were the agent's answer. The execution settled SUCCESS.
The runs list, the dashboard and the step graph all agreed the automation had worked.

Invisible to everything that existed: `kestra:phase4`'s M2 block resumes **by hand** with a scripted
`succeeded` (deliberately — a full agent round trip is minutes and would make the harness unusable as
a gate), so the failure path had never executed. The first end-to-end round trip found it immediately.

**Mitigation applied:** the compiler emits `<id>_await_check` (D-36).

⚠ **The obvious fix was wrong**, and the wrong version would have broken every agent step: see D-36 on
why the condition is `== 'failed'` and not `!= 'succeeded'`.

---

## I-26 — a correct credential, in the correct header, 401ing on a case-insensitive protocol

**Stage:** away-from-demo-mode 5 · **Found by:** `kestra:prove` scenario B, *"all 10 call(s) failed"* ·
**Mitigation:** names read from the config table; `routes/auth.test.ts`

ops-api's `presentedCredential` held its own lowercase list of header names and title-cased them to
build the `via` label:

```
"x-api-key".replace(/(^|-)([a-z])/g, …)   // → "X-Api-Key"
```

`requireKey` then compared that against `OPS_AUTH_STYLE.ticketing.paramName`, which is `X-API-Key`.
The strings differ, so **every ticket call 401'd with a correct credential in the correct header**.
HTTP header names are case-insensitive; only this code was not.

Nothing type-checked wrong, no unit test existed, and the round trip is the identity for every header
name that is not an acronym — so it would have passed a review and passed a test written against
`X-Mail-Key`.

**Mitigation applied:** the names come from the same table the endpoints are configured from, so there
is one spelling. `routes/auth.test.ts` pins both halves: that the table's own value is used, and that
at least one name exists for which title-casing is *not* the identity — without which the test is
vacuous.

---

## I-27 — three assertions that were passing for the wrong reason

**Stage:** away-from-demo-mode 5 · **Found by:** reading them while changing what they covered

Grouped because they are one shape: a check that cannot fail reads exactly like a check that passes.

1. **`kestra:check`'s `ops_ro` write test** returned *"cannot execute INSERT in a read-only
   transaction"* — `default_transaction_read_only` firing **before** privileges were consulted. The
   assertion the repo actually depends on is the **absent grant**. Now the check does
   `SET SESSION default_transaction_read_only = off` in its own `-c` (two statements in one `-c` run
   as one transaction, and a plain `SET transaction_read_only` applies only to that transaction) and
   then the INSERT, and gets `permission denied for table employees`.

2. **`kestra:phase6`'s "secret NAMES only"** asserted `bundle.secretNames.join(",") === ""` and had
   been passing vacuously since the tools were keyless. Rewritten to assert the NAME travels **and**
   that the serialised bundle does not contain `opsServiceKey("mail")`.

3. **`countToolCalls` defaults to `succeededOnly: true`**, so a phase-6 assertion about "reaching the
   real tool endpoint again" counted zero — the run it was checking deliberately mails
   `not-an-email` and gets a 422. The default is right; the call site was wrong.

**The general shape.** Every one of these was green, and every one had stopped discriminating. The
habit that catches them is pairing an assertion with the control that would fail if the mechanism were
absent — which is why `service-keys.test.ts` asserts an acronym header *exists*, and why
`kestra:phase4`'s network probes include a positive control on `bridge`.

---

## I-28 — a second M3 charger with no reconciliation

**Stage:** away-from-demo-mode 5 · **Found by:** `kestra:phase6`, *"workspace has 5 execution(s) in
flight"* · **Mitigation:** `services/execution-reconcile.service.ts`

I-10 in a second location. `begin` reconciles `running` rows against Kestra before refusing a run,
because `complete` is a task in the flow and a failed execution never reaches it. That logic lived
**beside `begin`**, which was the only caller — and that was the bug.

`flow-replay.service.ts` charges the same budget (D-26: a partial replay does not execute `begin`, so
it re-applies the checks itself) and had no reconciliation at all. The replay path therefore refused
with 429 as soon as five failed runs had accumulated, and would never recover on its own.

It presents as a harness or a person hitting "replay" on a failed run — which is exactly when failed
runs exist — and two paths disagreeing about the same number reads as flakiness. `kestra:phase6` found
it by deliberately creating failed runs and then replaying them.

**Mitigation applied:** `reconcileRunning()` extracted to its own module; both callers use it. Call it
only on the refusal path — it is a Kestra round trip per in-flight row, and the count only has to be
exact at the moment something is about to be refused for it.

---

## I-29 — `if (!exists) create` left two tool registrations pointing at a deleted route

**Stage:** away-from-demo-mode 5 · **Found by:** `kestra:retry`, 7 FAILs with `callsFor` returning 0

Stage 5 moved every tool endpoint from `:4000/stub-api/*` to `:4004`. Fourteen registrations followed,
because `demo:seed` upserts by name. The fifteenth did not: `flaky_probe` is registered by
`retry-verify.ts` and `showcase/seed.ts`, and **both used `if (!exists) create`** — so an existing row
kept its old URL and its absent auth for ever.

The symptom was maximally unhelpful: the flow ran, the step failed, and the call log showed **zero**
calls — because the request went to a route that no longer exists, in a different process, which
therefore logged nothing.

**Mitigation applied:** both sites UPSERT.

**The general shape.** "Create if missing" is the right idempotency for a *fixture*, and the wrong one
for a *registration* that encodes an address. The address is the part that changes.

---

## I-30 — a harness that timed out and said nothing, reported as a wrong answer

**Stage:** away-from-demo-mode 6 · **Found by:** the closing full-net run ·
**Mitigation:** the timeout is loud; the assertion reports its evidence

`kestra:phase6 --period=2026-06` failed once, on the replay-boundary check —
`notify` pointer rows: *got 1, want 2* — during a full-net pass that had just run `phase4`, `hitl`
and `retry` back to back. It was green on an immediate re-run and green on two more after that.

**The defect is not the flake; it is that the flake was indistinguishable from a regression.**
`waitFor` returned the last state it had seen when its 240s budget expired, **silently**. Every
assertion after it then ran against a possibly-still-running execution, so a busy engine presents as
a wrong answer with nothing in the output pointing at timing. That is I-12's lesson in a second
place: a degrade-gracefully path must say what it degraded from.

**Mitigation applied:**

- `waitFor` prints a `⚠ TIMEOUT` naming the execution, its last state, and the fact that every
  assertion below it should be read as *unknown* rather than as an answer.
- The replay-boundary check prints the replay execution's state and the **taskrun ids it actually
  saw** when the count is not 2. A real boundary regression and a race look identical from a bare
  "got 1, want 2"; they do not look identical from the taskrun list.

**Still not diagnosed, and stated rather than papered over:** whether the single failure was the
timeout at all. The two candidates are (a) the 240s budget expiring under load, and (b) Kestra
reusing a taskrun id across a replay, which would make `flowStepRunRepo.record`'s
`onConflictDoUpdate` update the existing row instead of inserting — deterministic in principle, and
therefore unlikely given three subsequent greens. The next occurrence will say which, which is the
whole point of the change.

**Operational note that already existed and now has a second reason:** run the harnesses **one at a
time**. They share one call log, and they share one engine.

**Recurred in Stage 7's closing net, twice in one pass** (2026-06, both times mid-net, green on the
immediate re-run each time). Same two assertions — *"the replay boundary is where it was asked to
be"* and *"reaching the real tool endpoint again"* — so the shape is unchanged and Stage 7 did not
cause it. It is therefore **not a one-off**, which retires the "unlikely given three subsequent
greens" reasoning above in favour of candidate (a): it fails only under load, and only in a full-net
pass. Still not diagnosed. The loud-timeout mitigation did its job — the failures were legible as
timing rather than as a wrong answer — but a check that fails one run in three during the pass that
matters most is a check nobody can read cold.

**Recurred again in Stage 8's closing net** (`--period=2026-05`, 3 assertions, green on the
immediate re-run) — a third consecutive session. That pass also produced the direct evidence
candidate (a) predicted: with a measurement script polling Tether while `kestra:verify` ran, **both**
Tether and Kestra returned `UND_ERR_SOCKET — other side closed` mid-call. So the operational note is
now the diagnosis rather than a precaution: **run the harnesses one at a time, and run nothing else
against either service while one is running.** A transport blip inside a harness is indistinguishable
from a failed assertion, which is exactly how this presents.

---

## I-31 — an edit dropped every stored contract, and nothing said so

**Stage:** away-from-demo-mode 7 · **Found by:** building the review surface's narrow edits ·
**Mitigation:** `saveRevision` inherits contracts; `kestra:phase6` asserts it

`flowService.saveRevision` takes `contracts` with a default of `{}`, and `POST
/:flowId/revisions` **passed none**. So the first edit through that route — rename a step, add a
flow input, delete a step — wrote a new revision in which every `code` step's `contract_json` was
NULL.

Nothing failed. The flow still compiled, still deployed, still ran: a fragment is code by then, and
the contract is only read when something wants to regenerate. The consequence surfaced one action
later and in the wrong place — `regenerateStep` refuses a step with no contract, **correctly**, with
a message about hand-written fragments, on a step that was generated. Triage level 1 was gone and
the reason looked like a property of the step.

Invisible until Stage 7 because the only caller that passed contracts was `regenerateStep`, which
passes all of them, and nothing else edited a generated flow.

**Mitigation:** `saveRevision` reads the current draft's contracts and inherits them for steps that
still exist, then lets an explicit argument override. Deleting a step drops its contract with it.
`kestra:phase6` asserts it by editing **without** the argument — the route's shape, not
`regenerateStep`'s — and the assertion was confirmed to fail on the pre-fix code.

⚠ The general lesson is the one D-24 already names in another place: **a per-step record has to
travel with the step through every path that rewrites the array.** `manifest_refs_json` is
recomputed each time and `contract_json` was not, so the two disagreed the moment an edit arrived
from anywhere but one function.

---

## I-32 — the self-approval check is verified on one side only

**Stage:** away-from-demo-mode 9.1 · **Found by:** wiring the verified identity into gate 2 ·
**Mitigation:** none available; recorded so the control is not over-quoted

Gate 2 refuses an approval whose approver matches `flow_revisions.created_by`. After Stage 9.1 the
**approver** is verified — a signed identity, refused if named in the body. The **author** is not,
always: `created_by` comes from the verified identity when the revision was written through the
browser, and from a body field when it came from a harness, a seed, an import or the drafter, which
have no session and must keep working.

So the comparison is between one value the server established and one it may merely have been told,
and **the row does not record which**. A caller holding the API key can create a flow authored by
`someone-else@…` and then approve it as themselves; the refusal does not fire, and nothing looks
wrong.

**Deliberately not mitigated with a `created_by_verified` column.** Nothing would act on it —
refusing to approve a harness-authored flow would break every demo path — and a flag with no
consumer is a flag that goes wrong quietly. What closes this properly is authorship becoming
impossible without a session, which needs the non-interactive paths to have identities of their own.
That is a Stage 10 shape, not a patch.

**Quote it as:** approval binding to an immutable revision is the control that holds; the approver is
verified; the self-approval refusal catches the honest mistake and is not separation of duties.

---

## I-33 — `showcase:verify` reads state a previous harness had moved

**Stage:** away-from-demo-mode 9 · **Found by:** the closing full-net run ·
**Mitigation:** operational — re-seed before verifying

`showcase:verify` failed 4 claims mid-net: the reference flow's Schedule trigger was absent from the
live namespace, and the fragment flow's run had FAILED. Both green immediately after
`pnpm showcase:seed`, at both periods.

Not a regression, and not flakiness either — an **ordering dependency stated here because it is
invisible from the output**. `showcase:verify` checks the claims six *seeded* flows make, in the HR
workspace, against one shared engine. Several other harnesses author, arm, revoke and delete flows in
that same workspace: in Stage 7's net `showcase:verify` ran before `e2e:ui`, and in Stage 9's it ran
after.

The failure presents as a product claim being false, which is the most expensive way to read a stale
fixture. **`showcase:seed` immediately before `showcase:verify`** — it is idempotent and takes
seconds. This is the same operational rule I-30 arrived at from the other direction: the harnesses
share one call log and one engine, so run them one at a time and re-establish the fixture you are
about to assert on.

---

## I-34 — the `profileId` speed-up did not reproduce; what it actually buys is the answer channel

*Stage 8.3, measured 2026-07-31 against the live runtime. Supersedes the number the stage was
planned around.*

**The claim carried into Stage 8 was "6.6 s and a direct answer versus minutes of
write-a-script-then-smoke-test protocol."** It was recorded from a single earlier observation. On
re-measurement it is wrong in both halves, and the correct finding is more interesting.

Two rounds, both against `foundry-agent-step` (`mode: "chat"`, `skills: []`) with the default
profile as the **control** — without which "the profile arm answers" says nothing, because if both
arms behave the same the profile is not what is doing it.

**Round 1 — a bare arithmetic question, no `INPUT` block.** 4 runs per arm.

| arm | answered | `script-gen` protocol instead of an answer | time |
| :--- | :--- | :--- | :--- |
| `profileId` | 2/4 | 2/4 | 6–10 s |
| default | 2/4 | 2/4 | 6–8 s |

**Round 2 — the prompt shaped the way `agent-run.service.ts` builds one** (instruction, blank line,
`INPUT`, upstream JSON), which is the only shape production ever sends. 8 profile runs, 6 default.

| arm | answered | `script-gen` protocol instead of an answer | mean |
| :--- | :--- | :--- | :--- |
| `profileId` | **8/8** | 0/8 | 12.1 s |
| default | **4/6** | 2/6 | 10.5 s |

Three things follow, and the first is the one to carry:

- **Latency is not the axis.** The default profile is *seconds*, not minutes — 10.5 s mean against
  the profile's 12.1 s, i.e. the profile arm is marginally *slower*. Anyone quoting a speed-up from
  8.3 is quoting a number that has been measured and is not there.
- **What differs is whether the reply is the ANSWER.** Roughly a third of default-profile runs came
  back with *"I cannot fulfill this request because there is no script provided…"* — Tether's
  mandatory `script-gen` skill answering instead of the agent. This is **I-24 on the runtime path**:
  the same skill that made a fragment refusal unparseable is eating agent-step replies, and Stage 6b
  only moved *generation* off Tether.
- **The profile suppresses it in this sample, and that is a reading, not a property.** 8/8 is eight
  runs on one model with one prompt. `skills: []` on the profile does not remove a *mandatory* skill
  — `API.md` says runs "always attach" it — so the mechanism is presumably prompt weighting, not
  removal. Round 1 shows it failing 2/4 when the prompt is thin.

### ⚠ Round 3 (2026-07-31, same day) — the third bullet is WITHDRAWN

Instrumenting the mechanism in Tether killed it. **The profile is not a mitigation at all**, and the
rate was overestimated. 27 further runs on the round-2 prompt, with the trigger logged rather than
inferred:

| arm (`runs.mode`) | runs | nudge fired | reply was a refusal |
| :--- | :--- | :--- | :--- |
| `chat` (`foundry-agent-step`) | 14 | **14** | **1** |
| default (control) | 13 | **13** | **1** |

- **Nothing is intermittent.** The trigger fires on **27 of 27** runs, both arms. 8/8 was a six-run
  arm landing on the good side of a ~10% coin.
- **~7%, not "about a third."** 2/27 here, 3/28 across the pre-fix history on this prompt. The
  round-2 figure of 2/6 was small-sample noise in the other direction.
- **The mechanism is not prompt weighting.** It is `HeadlessSocket._ensureAssistant()` reusing the
  answer's message object when Tether adds a turn after the agent has answered: a reply that is
  *text* overwrites the answer, a reply that goes straight to *tool calls* does not touch
  `.content`. 25 of 27 nudge replies were tool-calls-only, which is the entire explanation for why
  it looked random and why the profile appeared to help.

**Fixed in Tether the same day** — defect A only, `agent-backend/server.js`, 29 lines. Verified
26/26 contracts carrying the answer and 27/27 nudge firings logged. See
`../Foundry-Harness/plans/agent-step-run-contract.md`. ⚠ **The harness is no longer unmodified**;
CLAUDE.md's "zero Tether code changes are required" is superseded for that one file.

**Therefore:** `profileId` stays — chat mode is the honest declaration for a step that asks a
question, it costs nothing, and it is where defect B's `expects` default belongs. It is described in
the code and in `/keys` as *"answers directly instead of writing a script first"*, never as a
speed-up — **and never as protection against the `script-gen` contamination, which it is not.**

**And 8.4 gets sharper.** It was scoped as a status-reporting fix — *"once every agent step is
chat-mode, every run returns `needs_review`"*. Every run already does: all 14 runs of round 2 came
back `needs_review`, answered and refused alike, exactly as `outcomeOf`'s docblock predicts. The
real defect was larger than a status field, and the part that destroyed data is now fixed.
**Defects B (`script-gen` cannot be declined) and C (`needs_review` is structural) remain**, both
change the `POST /api/run` surface, and both are a separate decision.

---

## I-35 — every workspace created through the product had a NULL slug, and could never run anything

**Stage:** Programme 3, Stage 1 · **Found by:** provisioning the Finance workspace and reading the
row · **Fix:** `workspaceService.create` assigns both slugs; migration `0022` heals and constrains

Migration `0010` added `slug` / `tenant_slug` and backfilled them **once**. Nothing ever wrote them
again — `workspaceService.create` set neither. So the three workspaces that predate `0010` have
slugs, and **every workspace created since carried NULL for both.**

`tenantMapper.namespacesFor` turns that into a 409, because `<prefix>.<tenant>.<workspace>` cannot be
addressed. The placement of the symptom is what made this survive:

- The workspace provisions **perfectly**. Tools, datasource, named queries, introspected schema,
  manifest, secrets — all correct, all visible in the UI, `secrets/audit` clean.
- The only thing it cannot do is **deploy a flow**, which happens much later and reads as a Kestra
  problem in a stack that started somewhere else entirely.
- Nothing in ~400 assertions creates a workspace and then deploys from it. Every harness runs in the
  HR workspace, which was backfilled and therefore fine.

It would have blocked Stage 3 completely — the first flow authored in Finance, after everything else
about Finance looked right.

**Three parts to the fix, and the third is the one that stops it recurring quietly.**

1. `create` assigns `slug` (slugified name, with a numeric suffix on collision and a `workspace`
   fallback for a name that slugifies to empty) and `tenantSlug` (`"default"`, D-03). Assigned once;
   `update` takes a name and deliberately cannot touch either, because approval, deployed flows and
   execution history all hang off the namespace.
2. Migration `0022` repeats `0010`'s backfill for anything created in between — with byte-identical
   slugification, so a backfilled workspace and a newly created one derive the same namespace from
   the same name.
3. A **partial unique index** on `(tenant_slug, slug) WHERE deleted_at IS NULL`. `getBySlugs`
   resolves the pair to ONE row with `LIMIT 1`, so a duplicate is not a cosmetic clash — it is two
   tenants' flows in one namespace, with `begin` handing whichever row it found first the other's
   execution token. Partial, so a soft-deleted workspace does not hold its name hostage.

`services/workspace-slug.test.ts` pins it, and asserts the property that was actually broken — *the
new workspace can address a Kestra namespace* — rather than "the column is not null", which would
pass against a slug of `""`. Confirmed to FAIL 4 of 5 with the assignment removed.

---

## I-36 — `pnpm demo:seed` had been broken on a Linux host since the read-only gate landed

**Stage:** Programme 3, Stage 1 (defect introduced in away-from-demo-mode 9) · **Found by:**
provisioning Finance · **Fix:** D-44 (`verifyVia`)

```
Error: could not verify that this credential is read-only: getaddrinfo ENOTFOUND
host.docker.internal. The datasource was not saved.
```

D-40's gate connects to the DSN it is about to store. The stored DSN is container-facing
(`host.docker.internal:5433`) because the API container is what later reads it; `demo:seed`,
`demo:reset`, `demo:seed-alt` and `finance:seed` are **host** processes, and that name does not
resolve on a Linux host. Every one of them failed at the datasource step.

Two things are worth carrying from this beyond the fix:

- **It is the third appearance of one root cause.** `OPS_API_BASE` vs `OPS_ADMIN_BASE` is the same
  split, written down in CLAUDE.md, and I-15 is its filesystem cousin. The rule generalises: *a value
  that is STORED must resolve for its future reader; a value that is USED NOW must resolve for the
  current process, and they are different values whenever a host process configures a container.*
  Anything new that stores an address and then dials it needs both.
- **Nothing caught it, and the reason is instructive.** Stage 9's own net passed: the unit tests use
  a local DSN and the harnesses run against a workspace that was already registered. A gate whose
  only *negative* path is "cannot connect" is untested by everything that can connect.

---

## I-37 — `slate:clear` reported 610 refusals against a namespace that was already empty

**Stage:** Programme 3, Stage 1 · **Found by:** the first real run · **Fix:** collect execution ids
into a Set; distinguish 404 from a refusal

The first `slate:clear` printed *"1555 execution(s) found; 945 deleted, 610 failed"* and warned that
610 executions had refused deletion and might be paused runs needing manual intervention. Both
namespaces then reported `total: 0`. Nothing had refused anything.

Two compounding causes:

- **Kestra's paged execution search returns duplicates under a tied sort.** The sort is
  `state.startDate:desc` (mandatory — see I-12), and harness runs share a start second in bulk, so
  ties order differently between page requests and the same execution comes back on two pages.
  945 unique ids, 1555 rows collected.
- **The delete loop treated every error as a refusal.** The 610 second attempts were 404s, which is
  the outcome asked for.

Fixed by collecting into a `Set`, and by letting a 404 pass while counting and *naming* anything
else. The reason this is written down rather than just fixed: the false warning pointed at the one
genuinely dangerous case — a `PAUSED` execution holding a live human approval, which Kestra correctly
refuses to purge — and a report that cries wolf about that is worse than one that says nothing. ⚠
**Never widen the delete loop's catch to make the count look clean**; the refusal is the signal.

---

## I-38 — the backup negative control went INCONCLUSIVE the moment the slate emptied its subject

**Stage:** Programme 3, Stage 1 · **Found by:** `backup:verify` after `slate:clear` ·
**Fix:** choose the perturbed table at runtime

`backup-verify.sh`'s last assertion perturbs the *restored* copy and requires the same comparison to
notice, because `pg_restore` exits 0 against an empty database and the other fifteen checks would
otherwise report green forever. It named `flow_executions` — which `slate:clear` had just emptied.

**It behaved exactly as designed and that is the point of the entry.** It reported
`could not perturb the restored copy (0 rows) — control INCONCLUSIVE` and **failed the whole run**,
rather than passing on a perturbation that never happened. The 15-passed-1-failed output was correct
and the fix took two minutes.

The subject is now **chosen at runtime** from the same list step 4 compares, taking the first that
actually holds rows (`workspaces`, in practice). Naming a different table would have moved the trap
to whichever one is emptied next. It still fails INCONCLUSIVE if every candidate is empty.

⚠ The general shape, since this is the second time it has come up: **a control that names a specific
row, table or fixture inherits every future decision about that fixture.** Derive the subject from
the thing being checked.

---

## I-39 — pressing Save on an unchanged tool deleted its parameter descriptions, and disarmed its flows

**Stage:** Programme 3, Stage 1 follow-up · **Found by:** reading the tools page after being asked
why parameters have no descriptions · **Fix:** the round trip preserves the whole schema, and
`lib/tool-params.test.ts` asserts an identity

`jsonSchemaToParams` read only `type` and `paramsToJsonSchema` wrote only `type`. So opening any tool
in the edit modal and pressing **Save with no edits at all** silently rewrote its `paramsSchema` as a
bare `{type}` map.

Every one of the 15 seeded tools carries per-parameter prose — `sender: "From address"`,
`recipients: "One address or an array of up to 50"`, `mail_send`'s note that a 202 means nothing was
delivered. All of it was destroyed on the first save, with no error and no visible change on the
page, because the page never rendered descriptions either.

**Two costs, and the second is the one that makes this a defect rather than a gap.**

- The descriptions are what the flow drafter reads. Losing them degrades generation quality on a
  path where the measured baseline is already 1-of-3 first-pass, and nothing reports it.
- **`refFingerprints()` hashes `t.paramsSchema` WHOLE.** Removing keys changes the tool's
  fingerprint, so the per-ref staleness sweep marks every flow using that tool `suspended` and
  removes its Kestra schedule. Pressing Save on an unchanged tool disarmed automations.

Three parts to the fix:

1. Both directions preserve `description` and `required`, and `jsonSchemaToParams` reads BOTH shapes
   in the wild — the flat `{name: {type, required, description}}` map the catalogue and the manifest
   builder use, and the JSON-Schema `{properties, required}` envelope the form itself used to write.
2. **The write side emits the FLAT shape**, because `manifest-builder.service.ts` does
   `Object.entries(paramsSchema)` and reads the fields off each value directly. A JSON-Schema
   envelope gives it two entries and the manifest renders two nonsense params called `type` and
   `properties` — which is what every tool created through the UI before this had.
3. The form gained a description input per parameter, so the field can be filled rather than only
   preserved.

Verified against the live API, not only in unit tests: load `mail_send`, map it through the client
adapters, `PATCH` it back untouched → **`paramsSchema` byte-identical, `mail_send`'s fingerprint
unmoved.**

⚠ The test asserts an **identity** — read a stored schema, write it back, require deep equality —
rather than "description is present". A presence check would pass while `required` quietly moved,
and moving `required` suspends flows just as surely.

---

## I-40 — the manifest never rendered parameter descriptions, so the drafter never saw one

**Stage:** Programme 3, Stage 1 follow-up · **Found by:** the same question · **Fix:**
`<param …>description</param>`

Separate from I-39 and discovered with it: even for tools whose descriptions had survived, the
manifest emitted `<param name= type= required=/>` and dropped the prose. Every tool in the catalogue
has carried these since it was written, and **not one has ever reached a model.**

The tell was in the tool descriptions themselves — they had grown to explain their own parameters in
one paragraph, because that was the only channel that worked.

**The check that made this safe to change**, and the one to repeat for anything touching manifest
XML: `refFingerprints()` hashes `paramsSchema` whole, so rendering more of it into the XML changes
the manifest's own hash — a new manifest version, correctly, because what the agent is told did
change — and moves **no ref fingerprint**. Measured across all four workspaces before and after:
`0 moved`. Had it moved them, the sweep would have suspended every armed flow in every workspace.

---

## I-41 — "Queued", for ever, on a datasource nothing was going to test

**Stage:** Programme 3, Stage 1 follow-up · **Found by:** the data sources page showing hr_demo as
Queued · **Fix:** `untested` is its own state; polling only on a real in-flight test

`datasourceService.update` sets `test_status = NULL` whenever the connection string changes, and
`demo:seed` re-registers the DSN on every run. The client mapped NULL → `pending` → the pill
**"Queued"**, and the page polled while any row was `pending`.

So a healthy datasource displayed as work-in-progress permanently, and the page span a request every
few seconds waiting for a transition that only a human pressing Test can cause. `testConnection`
existed in the data seam and **no page called it**, so there was no way to resolve the state from
the UI at all.

This is the `faFallback` family: not fabricated data, but a claim about the system that is not true.
"Not answered" and "answered, nothing there" are different facts — the same distinction `demoStatus`
makes with `-1` for a capture table it could not read.

Fixed by giving `untested` its own neutral pill and its own resting state, restricting the poll to
`pending`/`discovering`, and wiring the Test action that already existed. Two adjacent untruths went
with it: the page described connections "discovered and federated" and queryable "through Virtual
Tables" (deleted in away-from-demo-mode Stage 1), and its **Catalog column was hardcoded `null` in
the adapter** — rendering `—` on every row, in every workspace, permanently.

⚠ The pill map was **copy-pasted into three pages**. Adding a fifth state broke two of them at the
typecheck, which was luck — `Record<ConnectionStatus, …>` happens to be exhaustive, and a loosely
typed copy would have rendered a blank pill instead. It now lives in `lib/connection-status.ts`;
`/keys` keeps its own deliberately, because that page is about a credential and says "Signed in".

---

## I-42

**A value containing a timestamp cannot cross into an `http.Request` body via `jq()`.**
Found on the first three runs of `finance-invoice-chase`. `finance_demo` rows carry real
dates, which Postgres returns as `2026-04-30T00:00:00.000Z`. Hand such a value to `jq()`
inside a `tool` or `approval` step and Kestra dies with:

```
Unable to parse jq value '[{invoice_number=INV-2026-0025, …,
  issue_date=2026-03-16T00:00:00.000Z, …}]' with type 'java.util.ArrayList'
```

Three things make this expensive to diagnose:

- The value in the message is a Java `toString()`, so it reads like malformed **data**
  rather than like a value that could not be serialised. It names neither the field nor
  the reason.
- **The same expression over the same rows works in a `transform` step.** The step that
  fails is not the step that is wrong, and the working precedent sits three lines above.
- **It is invisible to HR.** Not one column in `attendance_below_threshold` is a date, so
  `showcase-attendance-screening` uses the identical construct and has always passed. A
  second domain is what surfaced it — the same way `hr_demo_alt` found three bugs no
  single dataset could.

**Mitigation, and it is a good rule independently: a tool step never consumes a raw query
row.** A `transform` projects exactly the fields the call needs — timestamps flattened to
`YYYY-MM-DD`, minor units converted once — and the tool's jq reads that. It puts the
payload shape in one readable place instead of inside a 400-character expression, and it
makes the timestamp problem structurally impossible.

## I-43

**`@json` is a jq encoder, not a Pebble filter.** Written as `| jq('…') | @json | first`
it fails with `ParserException: Unexpected character [@]`. It belongs inside the program:
`| jq('(…) | @json') | first`. Both forms *look* like the documented fix for the other
half of I-11 (`| first` unwrapping a jq string into raw text, which lands unquoted in a
JSON body), and only one is. The two failures are at different layers and neither message
names the field.

## I-44

**A `code` step's output is `outputs.<id>.vars.result`, not `outputs.<id>.value`.**
`.value` is a `transform`'s output. The failure is
`Unable to find `value` used in the expression …`, which reads as "the step produced
nothing" rather than "you asked for the wrong field" — and the step it names is the
CONSUMER, not the code step. Measured on `finance-budget-variance`'s first run.

## I-45

**`drizzle-kit generate` re-proposed `workspaces.kind`,** because migration `0023` was
hand-written and its snapshot did not record the column. Applying the generated `0024`
verbatim would have failed with "column already exists" on every database that had run
0023 — i.e. every real one. Fixed by making 0024's three `ADD COLUMN`s `IF NOT EXISTS`,
which is also correct against a database restored from a pre-0023 backup. **0024's
snapshot is complete, so the drift ends there.** The lesson is narrower than "never
hand-write a migration": it is that a hand-written migration must be paired with a
hand-corrected snapshot, or the next generated one silently repeats it.

## I-46

**The drafter did not know `approval` existed.** Gate 3 has been a step kind since
away-from-demo-mode Stage 3, and `flow-generation.service.ts` listed five kinds in
`DRAFT_RULES` and had five arms in `draftedStepSchema` — no `approval` in either. So a
goal saying *"wait for someone to approve before sending"* could not produce a gate. The
best the drafter could do was invent something, and it did: `wait_for_approval:tool`,
measured by `outline:measure`.

**A step that names itself after a pause and does not pause is worse than no step**: the
send goes out and the run looks like it stopped for a person.

It survived because gate 3 was only ever added the OTHER way — `FlowReview` splices it
into an existing flow (Stage 7), which is a client-side edit the drafter never sees. Every
test of gate 3 built the model by hand. **Outline mode is what surfaced it**, because a
person writing steps in their own words writes "wait for approval" as a step.

Fixed: the kind is in the rules, in the schema, and in the response example, with the
placement rule stated (before the thing it gates, and rejecting kills the run). Measured
after: the same case now drafts `approve_notices:approval`.

## I-47

**A bad step kind reported itself as `steps: Required`.** `draftResponseSchema.steps` is a
discriminated union, and `ZodError.flatten()` collapses every per-element failure onto the
top-level key. The entire finding was the string `"steps: Required"`, once per bad
element. Three costs, all paid:

- **Unactionable in the redraft loop.** Findings are appended to the prompt verbatim, so
  the model was told "steps: Required" and asked to fix it — three times, then the draft
  failed. Two of three `outline:measure` cases failed this way on the first run.
- **Unactionable for a person.** The measurement read as "outline mode drifted" when what
  had actually happened was I-46.
- **It hid I-46.** That was the only symptom.

Fixed by walking `error.issues` and naming the step, its claimed kind, and the field —
with `invalid_union_discriminator` listing the permitted kinds, because that is the one
whose fix is a single word. ⚠ `draftFindings` never returns an empty list: the loop
appends findings to the prompt, and an empty append re-asks the identical question.

## I-48

**The caps fired only AFTER generation had been paid for.** Found by the control that was
supposed to prove them: `kestra:canvas` planted 17 `code` steps against a cap of 16 and the
control read **DID NOT FIRE** — the answer that came back was `insufficient_contract` with
an empty message.

Nothing was broken. `runGeneration` generates every fragment and only then calls
`flowService.create`, where `flowValidator.assertValid` lives. So the flow *was* refused,
just not for the reason it should have been and not before one inference call per step had
been spent — and the refusal a person saw named a fragment's contract rather than the cap
they had exceeded.

⚠ A cap that bounds a resource has to be checked before the resource is spent. This is the
argument `startGenerationSchema` already makes for the outline's 30-line bound (*"a
500-line outline would otherwise be paid for in inference before the revision cap refused
it"*) — it had simply never been applied to the model itself, because until Stage 5 no
client could post one.

Fixed by calling `flowValidator.checkFlowShape` inside `authorFlow`, before
`generateFragments`. **Not a second copy of the caps** — the same pure function, run
earlier; `writeRevision` remains the authority and still runs it.

⚠ `draftFlow` deliberately did NOT get the same call in this change. The exposure there is
different (the drafter is bounded by its prompt and by `validateOutline`, and no drafted
flow has ever approached a cap), and its loop is a measured artefact — adding a finding
class to it changes what `outline:measure` and `kestra:refusal` are measuring. If a drafted
flow is ever seen exceeding a cap, that is the moment to move it, not before.

## I-49

**The builder's own first expression was I-11, and it broke D-22's scanner as well.**
Caught by `flow-expr.test.ts` on the first run, before any of it shipped.

`buildFanOutParams` mapped a flow input into a jq program the obvious way:

```
jq('[.[] | {"period": "{{ inputs.period }}"}]')
```

Two things are wrong with it, and only the first is documented. **Pebble does not
re-evaluate `{{ }}` inside a filter argument** (I-11), so the flow ships with the literal
text `{{ inputs.period }}` as the value — no error, no warning, just the wrong data. The
fix I-11 names is concatenation with `~`, which means the jq program cannot be one string;
`lib/flow-expr.ts` assembles it from literal chunks with Pebble expressions between them.

The second is new and worth writing down. `TEMPLATE_RE` in
`services/flow-expression.service.ts` is **non-greedy**, so a nested `{{` closes the outer
template at the inner `}}`. The scanner then sees half an expression with an unbalanced
quote, `blankStrings` fails to blank the jq program, and identifiers inside it leak — in
this case `split(…)`, reported as a forbidden call. Order-dependent: the same expression
with the input mapped first produced no finding at all.

So a nested `{{ }}` does not just fail at runtime, it makes **D-22's own check unreliable**
in both directions. Nothing in the product emits one today (the reference flows all
concatenate), and the builder now cannot. Left as-is rather than hardened, because the
construct is wrong for the documented reason anyway and a scanner that tried to parse
nested templates would be pretending they are supported.

## I-50

**`candidateUpstream` asked the question backwards.** The dropdown offering "add a step
before this one" filtered on whether the CANDIDATE depended on the selected step, not on
whether the selected step already depended on the candidate. Both read plausibly; only one
answers "what can I still link".

Symptom: the list offered a step that was already an upstream, and `connect()` then refused
it as a duplicate — a control firing correctly on a choice the UI should never have
offered. Caught by `flow-authoring.test.ts` on its first run. Worth recording because the
failure was in the *offer*, and a wrong offer that a correct refusal catches is exactly the
shape that survives review.

## I-51

**A flow that declared an input could never be approved.** Reported from the browser as
`POST …/test-run → 500`.

Three defects in one path, and each hid the next:

- **The client had no way to supply an input.** `ApprovalPanel`'s "Run a test now" called
  `testRunFlow(flow.id)` with no arguments, so the body was always `{}`. `foundryApi` has
  taken `inputs` since Phase 3 and nothing ever passed any.
- **This makes gate 1 unreachable, not merely inconvenient.** Approval requires one
  succeeded run and the only route to one is a test run. A flow declaring
  `{id: "period", required: true}` — what the drafter produces whenever a step needs a
  period, and now what the canvas produces whenever someone adds an input — was refused by
  Kestra every time. It could not run, so it could not be armed, ever.
- **The engine's diagnosis was thrown away twice.** Kestra answers
  `422 {"message":"Invalid entity: Missing required input:period"}`, which names the fix.
  `flowService.testRun` discarded `KestraError.body` and reported `Kestra POST executions →
  422`; then `errorHandler` honoured `statusCode` **only in the 4xx range**, so the
  deliberate 502 became a **500**. What reached the browser was a server crash.

⚠ The middleware half is wider than this bug. Every deliberate 5xx in the codebase was
being flattened: `assertKestraAccepts`'s 502, `remove`'s 502, and CLAUDE.md's documented
*"Kestra unreachable → 503"* — untrue at the wire for as long as it had been written down.
The message survived and the status did not, which is the wrong half to lose: 502 means an
upstream refused, 503 means it was unreachable, 500 means this process has a bug, and only
the last is ours.

Fixed in three places. `testRun` surfaces Kestra's own sentence and maps **422 → 400**,
because a run refused for missing inputs is the caller's mistake and a 502 would send
someone to look at infrastructure. `errorHandler` honours an explicit 5xx (still logging
it). And `/flows/[id]` reads the draft's declared inputs and renders a panel that collects
them, with the always-failing button hidden while any are declared.

Pinned by `middleware/error.middleware.test.ts` (the 502 and 503 cases are the regression)
and `components/flow/ApprovalPanel.test.tsx`. ⚠ The unreadable case is a stated error, not
an empty form: "could not read what this flow needs" and "this flow needs nothing" look
identical as a blank panel, and only one of them means the button will work.

## I-52

**The model-seam badge vanished from the one node that sends data to a model** — and it
vanished exactly when that node failed.

`StepView.kind` was read from the Foundry pointer row and only from there, and a pointer row
exists only for a step that **called back into Foundry**. An `agent` step whose expression
failed to render never called anything, so it came back `kind: null` — and
`seamOf(null, …)` returns `null`, so the canvas drew it as an unclassified grey "engine
task" with no badge at all.

⚠ That is a privacy marker failing **open**, which Stage 2's rule explicitly forbids: *"a
`tool` step whose ref could not be read renders 'cannot tell', not 'safe'."* The same
argument applies to kind, and it had not been applied. Worse, it fails open precisely when
something has gone wrong — the moment somebody is most likely to be reading the picture.

Fixed by taking `kind` from `flow_steps` at the execution's **own** revision first, falling
back to the pointer row — the identical join Stage 2 added for `ref`, which should have
carried `kind` with it at the time.

**A second thing fell out of the same join.** A model's step list also says which tasks
*nobody wrote*, so `StepView.platform` now marks them. The count that prompted this: a
**two**-step flow with one `agent` step is **six** Kestra tasks — `begin`, the two steps,
the agent's `_await` pause and its `_await_check` (D-21), and `complete`. That is correct
and reads as the product inventing four boxes. The canvas labels them "platform" rather
than "engine task": the first says *ours, not yours*, the second says *unclassifiable*.

⚠ **Reported, never filtered.** `begin` is where the approval gate is re-checked and the M3
slot is taken; a run that failed there failed for the most interesting reason available, and
hiding it would make the most important failure the invisible one. A platform node is drawn
slightly quieter — except when it failed.

## I-53

**Three drafting defects, found by running one flow a person actually asked for**, and each
one produced a flow that compiled, deployed and failed at execution.

**1. The drafter reached for `agent` to write a paragraph.** `DRAFT_RULES` listed `agent` as
"an LLM step, ONLY for genuinely open-ended judgement over text" and never mentioned that
`llm_complete` exists as the ordinary way to have a model write something. `llm_complete`
was one line in a fifteen-tool catalogue with no rule pointing at it. So *"create a summary
report"* became an `agent` step: a separate agent run, a `core.flow.Pause` that parks the
whole execution, and a daily budget slot — for one call's worth of work.

Same shape as **I-46**: a capability exists, the vocabulary does not say when to use it, and
the drafter reaches for the wrong one. Fixed with an explicit block in `DRAFT_RULES`
("writing a paragraph is not judgement") and, after it, `llm_complete` is what a redraft
picks.

**2. It read a `tool` step's output with the `code` step's shape.** `outputs.draft_report
.vars.result` where `draft_report` is `llm_complete` — because `llm_complete` *feels* like
generation. The rule was stated three ways directly above, with a worked example.

⚠ A prompt rule the model can ignore is not a control. `checkOutputShapes` is the control:
it is computed from `OUTPUT_SHAPES`, the same table the canvas builds expressions from, and
it names the step, its kind and the expression that reads it correctly. **Its bound is
stated rather than papered over** — it checks the FIRST path segment only, so
`.body.employees` (an invented response field, and the original failure the user hit) is
invisible to it: `body` is right, and only the tenant's data knows whether `employees`
exists. A check that fired on unknown sub-paths would reject every legitimate
`.results[0].data`.

**3. It interpolated a structure into a JSON string position** —
`"input": "{{ json(outputs.fetch.body) }}"`, which renders an object inside quotes and
breaks the body at the first inner quote. Kestra answers
`JsonParseException: Unexpected character ('r')` against a **redacted** source: no step, no
field, no reason. This is the I-11 family with a documented fix (build it in jq, `@json`-
encode it), so `checkJsonPositions` now catches it and hands back the corrected expression.
⚠ Narrow on purpose: only a WHOLE output read is flagged, because a scalar plucked out of
one belongs in quotes and a check firing on that would be a check people turn off.

⚠ **Both checks run inside `draftFlow`'s redraft loop as findings**, not as hard failures —
the loop exists for exactly this and the fix costs one cycle. They also run in `authorFlow`,
where every finding is returned at once because the fixer is a person.

**What this changed, measured on one goal.** Before: a flow that deployed and died at its
second step. After: goal mode **refuses** with four named findings (and could not recover in
three attempts — the documented goal-mode reliability on this model); **outline mode
produced a clean three-step flow that ran green end to end**, `datasource → llm_complete →
chat_post_message`, with the summary posted and its headline figure — 11 employees — equal
to the oracle's. The one remaining failure on the first attempt was an invented channel
name (`#finance` where the workspace has `#finance-ops`), which the tool answered with a
404 **naming every real channel** — the system working as designed.

---

## I-54 — a refused fixture had already replaced the one it was refusing

**Found by `kestra:sandbox` block 5, which is the block that exists to find it.**

`sandboxService.provision` built in place: drop the sandbox database, create it, load the
rows, create the role, run the taxonomy — and throw if the taxonomy failed. Its own docblock
claimed a failed provision *"leaves a datasource with no sandbox rather than one nobody
verified"*, and that was false in the worst available way. By the time the check ran the rows
were already replaced and the datasource still pointed at the database, so a **refused**
regeneration left every subsequent draft run reading the fixture that had just been rejected.
The check fired, said no, and the damage was done anyway.

It survived a full green run first time round, because the assertion was
*"a refused provision leaves the working sandbox intact"* implemented as *"`hasSandbox` is
still true"* — and the pointer was fine. The pointer was never the thing at risk.

**Mitigation.** Provisioning builds in `<db>_stg`, verifies there, and promotes with
`ALTER DATABASE … RENAME TO` — grants on the database and on every table are catalogue
entries that travel with the rename, so the read-only role needs no second round of GRANTs
(and a second round is exactly where "the sandbox role is not read-only" would come from).
On failure the staging database is dropped and nothing else moves. `rematerialise` does the
same.

**And the assertion was replaced with one that can fail**: block 5 now digests every row in
the sandbox before and after the refused provision and requires them equal. That is the
version that caught it.

## I-55 — a workspace slugged `draft` would have read fixtures on its live runs

**Found by `execution-env.test.ts` while writing the boundary cases.**

The environment rule was *"the namespace ends in `draft` ⇒ it is a draft run"*. A workspace
whose slug is literally `draft` has the **live** namespace `foundry.default.draft`, which
that rule reads as a draft — so a production execution would have read the sandbox. Wrong
data, silently, on the one kind of run where it matters.

The same ambiguity was already in `routes/executions.ts`'s `resolveWorkspaceFromNamespace`,
where it presents differently: it strips the trailing segment and then fails to resolve the
workspace at all, so the flow 403s at `begin` with `unknown namespace`.

**Mitigation.** One `parseNamespace`, in `execution-env.service.ts`, **counting segments
against the configured prefix**: a live namespace is `prefix + 2` segments, a draft one is
`prefix + 3` ending in `draft`, and anything else is not a shape this deployment emits.
`routes/executions.ts` uses the same function — two definitions of "which environment is
this" is how the step callback and the gate came to disagree in the first place.

⚠ It fails **closed**: an unrecognised namespace resolves to `draft`. Reading fixtures on a
production run is a wrong answer somebody is watching; reading production during development
is the exposure the stage exists to close.

## I-56 — the model wrote a perfectly good fixture dated 2023

**Found on the first real run of `kestra:sandbox`, and it would have looked like a bug in
the product rather than in the fixture.**

The model's fixture passed all seven taxonomy categories — including `date_span`, which
requires two calendar months and rows strictly inside the range. Its `work_date` values were
in **October and November 2023**. An HR flow asking for `2026-06` would have read that
sandbox and found **nothing**, and a flow returning zero rows is indistinguishable on screen
from a flow that is broken.

The taxonomy was not wrong: "spans two months" is the property it checks, and the property
held. What was missing is that a fixture has to overlap the periods anyone will actually ask
for.

**Mitigation.** `generateFixture` takes a `DateWindow` and the prompt states it —
`sandboxService.provision` passes the three months ending today. And because a frozen fixture
ages out of any window eventually, `SandboxStatus.dateRange` reports the span the fixture
**actually** holds, rendered on the datasource page beside the fixture version. Re-dating a
frozen fixture silently would be worse than letting it age: that is the "a fixture that moves
under a test" failure the freeze exists to prevent.

---

## I-57 — the expression allowlist rejected valid jq, and that was "autogenerate takes forever"

**Found 2026-08-03**, investigating a user report: *"when we do autogenerate workflow it takes
forever, but if I do stepwise then it is rather quick."* Both halves were true and in the job
table — outline mode 9.5 s ok, goal mode 44.8 s ok / 84.5 s FAILED / 157.7 s FAILED.

`flow-expression.service.ts` found templates with `/\{\{([\s\S]*?)\}\}/g`. Non-greedy, so it
closed at the **first** `}}`. A jq program that builds a nested object ends in one:

```
{{ outputs.p.value | jq('[.[] | {to: .email, vars: {name: .full_name}}]') | first }}
                                                                    ↑↑
                                                    the scan stopped here
```

The body then ended mid-string with an unbalanced quote, `blankStrings` blanked nothing, and
every field name in the jq program came back as an unreadable variable **root** — five to nine
findings per step, naming a problem that did not exist.

That expression is **correct**, and it is the single most common thing a drafted expression
does: reshaping rows for a tool call is what a `transform` is for. So D-22 was systematically
refusing the main case.

Three costs, all paid repeatedly:

1. **The findings are fed to the redraft verbatim.** The model was asked to fix a problem it did
   not have, so it rewrote correct expressions into different ones and was rejected again.
2. **Every attempt re-emits the whole flow.** ~30 s of decode each, three attempts, then failure.
3. **A D-22 bypass was hiding inside it.** `{{ '}}' ~ secret('FOUNDRY_CALLBACK') }}` closed the
   old regex's template inside the quoted `'}}'`, so the body checked was `{{ '` and the call to
   `secret` was never seen at all. The scanner that fixes the false rejection also closes this.

**Fixed** by replacing the regex with a scanner that finds the close while **respecting quotes**,
and detects a nested `{{` while **ignoring** them — the two rules pull opposite ways on purpose,
because `jq('… "{{ inputs.x }}" …')` is I-11 and must still be caught. An unterminated `{{` is
now a refusal rather than a partial scan reporting green over the half it could not read.

Measured before → after on three real goals, `google/gemma-4-26B-A4B-it`: **25 of 26 findings in
a run were this class; afterwards, zero.** See `pnpm --filter @foundry/server draft:measure`.

---

## I-58 — the drafter was marked against a vocabulary the prompt never stated

**Found 2026-08-03**, same investigation as I-57 and the other half of it.

Three real goal-mode drafts were instrumented against the live gateway. Every one designed a
sensible automation on attempt 1 and was rejected for a **field name**:

| what the model wrote | why it was rejected | what the prompt said about it |
| :--- | :--- | :--- |
| `{"kind":"transform", …, "valueExpr": …}` | `expr — Required` | nothing — the RESPONSE example had no `transform` step in it at all |
| `{"kind":"llm_complete", …}` | not a step kind | the rules recommend the `llm_complete` **tool** by name three paragraphs earlier |
| `contract.input[2].type: "integer"` | not in the enum | nothing — the six type names were never listed |
| `\| jq('…') \| @json` | I-43 | the example used `@json` correctly and never stated the rule |
| `"timeoutSeconds": 0` | `Number must be >= 1` | the ranges were never given |

Each costs a whole redraft. Measured end-to-end: 70 s, 92 s, and 89 s for one that produced
nothing, having written `valueExpr` twice.

**Fixed** by making the prompt declare its own schema — a `STEP SHAPES` block listing all six
kinds with their exact fields and bounds, the closed kind set, the contract type enum, I-11 and
I-43 stated as rules, and a worked example that now contains a `transform`.

⚠ **`timeoutSeconds: 0` was introduced BY THE FIX.** The first `STEP SHAPES` block used `0` as a
placeholder for optional numbers, and the model copied it. Placeholders in a schema block are
values as far as a model is concerned; they now read `<1..3600>`.

**Two things guard the class rather than the instances:**

- `flow-generation.test.ts` pulls the worked example out of the prompt text and runs it through
  the three validators `draftFlow` applies to a real answer. An example the drafter's own checks
  would reject teaches a mistake and charges a redraft for it, in every workspace, for ever.
- `contractFieldSchema` normalises type **synonyms** (`integer`→`number`, `bool`→`boolean`, …).
  Bounded deliberately: it maps a name to a name and never guesses at structure — `valueExpr` is
  *not* normalised to `expr`, because that would be this module deciding what the drafter meant
  about the flow's shape.

---

## I-59 — the DAG canvas flashed, and it was a choice of primary key

**Found 2026-08-03** from a user report that the graphs *"flash a lot"*. Two independent causes,
neither in React Flow:

**The outline sketch used the typed line as the node id.** `/flows/new` built its graph in a
local helper whose `id` was `${i+1}. ${line}`. So typing one character renamed every node from
that line onwards: React unmounted and remounted the cards, the canvas's topology key changed,
and the 200 ms `fitView` animation restarted — **on every keystroke.** Fixed by
`canvasFromOutline`, which keys by line **position** and carries the text as a new `label` field.

**Every call site built its graph inline in JSX.** `graph={canvasFromExecution(run.graph,
run.steps)}` constructs a new graph object on every render, so dagre re-laid-out the entire DAG:
on every stream update of a live run, on every keystroke, and — in `FlowReview` — on the render
caused by **clicking a node**, so the graph moved under the cursor at the moment someone was
pointing at it. Fixed with `useMemo` at all five call sites, plus keying `FlowCanvas`'s own
layout memo on a **topology string** rather than on array identity, since `layout()` reads node
ids, edge endpoints and two constants and nothing else.

Two smaller ones fell out of the same read:

- The refit was keyed on `nodes.join("|") + "#" + edges.length`. **Rewiring a flow without
  changing the edge count** left the view fitted to the previous shape.
- The first fit animated from React Flow's default viewport, which is a visible swoop on every
  mount. It is now instant on the first fit and animated thereafter.

`ui-honesty-check.sh` gained two assertions, both proven to fire under perturbation: no adapter
call inside a `graph=` prop (test files exempt — a test renders once), and `canvasFromOutline`
keys by position.

---

## I-60 — a click on the canvas was inert on two of the four surfaces that draw one

**Found 2026-08-03**, from *"clicking on them should provide us more info regarding the component
or that part of workflow."*

Selection was entirely the page's business, and each page did something different:

| surface | what a click did |
| :--- | :--- |
| `/runs/[id]` | selected a step; a detail panel **further down the page** changed — off-screen under a 400 px canvas |
| `/flows/[id]` | highlighted a row in the list below |
| `/flows/new` (outline sketch, refusal panel) | **nothing** — no `onSelect` was passed |
| `/flows/new` (builder) | opened `StepInspector` |

**Fixed** by giving `FlowCanvas` a details panel of its own, directly under the graph, with
selection that is controlled where a page cares and local otherwise — so a click is never inert
without every caller having to take a `useState`.

What it shows is the part every surface shares, and deliberately **not** a copy of `StepDetail`:
what the step is, what it acts on, the facts its adapter attached (a contract's purpose, a
retry policy, how long a gate may hold the run, which database a draft run read), and — the one
thing only the picture knows — **what feeds it and what it feeds**. A leaf reads `nothing`
rather than a blank, because that a step feeds nothing downstream is what makes an
`llm_complete` step a leaf (D-34) and a gate at the end useless.

⚠ The seam claim in the panel carries the **same wording and the same caveat** as the badge and
the legend. A third phrasing of "sends data to a model" is a third thing to keep true.

---

## I-61 — the author of a revision was whatever the writer said, and the row did not record that

**Where.** `flow_revisions.created_by`, and gate 2's self-approval refusal that reads it.
**Found by.** Closing `docs/GAPS.md` §1.2, itself opened by I-32.

Stage 9.1 verified the **approver**: a signed `x-foundry-identity`, and a present-but-invalid token
is a 401 rather than a fallback. The **author** side was never verified. `created_by` came from the
resolved identity when the request came through the browser and from a request body everywhere
else — harnesses, seeds, imports, the drafter, the CLI — **and the column did not record which**.

So the refusal compared one value the server had established against one it may merely have been
told. A caller holding the API key could author a flow as `someone-else@…` and approve it as
themselves, and nothing on the row would look wrong.

⚠ **The tempting fix does not work.** "Stop accepting a name from anyone" takes down the demo, the
seeds and the entire regression net, because none of them has a session and all of them write
revisions. The name has to stay writable by things that are not people. What has to stop is the
name being *read as though somebody checked it* — so the attestation now travels beside it as one
value (`RevisionAuthor`), for the same reason `resolveKey()` returns `{ key, shared, secretName }`
rather than a bare string (D-42): a qualifier that can be dropped at a call site is one that will be.

Two greps guard it, both asserted against the source tree because neither failure has a runtime
symptom — a second `user` minter would work perfectly and report nothing:

1. `createdByKind: "user"` appears in **exactly one** production file. ⚠ Test files are excluded,
   for the same reason `kestra:check` excludes them from the LLM-credential grep: a test asserting
   what `authorOf` returns must write the attested shape down, so counting tests makes the guard and
   the assertion refute each other, and the "fix" is to delete one of them.
2. No route lets a body `createdBy` reach anything but `authorOf`. Both real historical defects were
   re-introduced to prove it still fires: `…/steps/:stepId/regenerate` reading `req.body.createdBy`,
   and `POST …/import` passing `input.createdBy` straight on. Each was caught by file and line.

## I-62 — the guard that cried wolf: three false positives, zero real ones

**Where.** The route grep in `revision-author.test.ts` (I-61's second guard), as first written.

It flagged any line mentioning `createdBy` that was neither a destructure nor an `authorOf(` call.
That fired on `createdBy: z.string()…` — **declaring** the field, which a route must do in order to
parse it and hand it to `authorOf` — and on `createdBy: t.createdBy` in a template list **response**,
which is reading a stored value back out, the opposite direction. Three false positives against zero
real ones, on a suite that was otherwise green.

⚠ **Why this matters more than the bug.** A guard that cries wolf gets relaxed, and the relaxation
somebody reaches for is *"allow `createdBy:` followed by anything"* — which permits precisely the
defect. That is I-38 arriving by a different road: the control does not get deleted, it gets widened
until it cannot fail. It is now stated as what is actually forbidden — a **body-derived** value
reaching anything but `authorOf` — with the legal shapes enumerated rather than pattern-guessed.

## I-63 — two `e2e:ui` verdicts were hardcoded, and one had drifted into nonsense

**Where.** `e2e-ui-journey.ts` steps 20 (`flowId` meaning) and 36 (trigger fires).
**Found by.** Closing §3.2 and §3.3 and finding the report unmoved.

Both recorded their verdict as a **literal** — `verdict: "MISMATCH"`, `verdict: "GAP"` — with the
evidence written as prose beside it. Correct on the day they were written, and unable to notice
anything afterwards. Two consequences, and the second is the interesting one:

- The fixes landed and the report still said they had not.
- Step 20's printed evidence had become self-contradicting: *"it is the KESTRA flow id: X rather
  than the uuid X"* — the same string twice, because this flow's Kestra slug is derived from its
  Foundry uuid. A reader checking the finding against the output would have seen two identical
  values and no way to tell which claim was wrong.

Both are computed now. Step 20 compares the observed `flowId` against the uuid **and** requires the
slug to still be reachable as `flowName` — fixing one alone would have cost the UI the label it
renders. Step 36 decides by **reading the client source**, both layers, because a GAP means *the
client has no method for this* and relabelling it here would make the report agree with itself.

⚠ **It fails closed, and that was not theoretical**: the first version had the relative path off by
one, so the check could not read the client and reported the gap as **still open**. The wrong
direction would have been a silent MATCH.

---

## I-64 — the test that proves a gate is wired can plant the very thing the gate refuses

**Found** 2026-08-03, while closing GAPS.md §1.3 (D-64), by running `sandbox:status` afterwards for
an unrelated reason.

`datasource-target.test.ts` has one test that goes through `datasourceService.create` rather than
calling the checker directly, because a check can be flawless and never called. To prove that test
can fail, the `assertRegistrableTarget` call was removed from `create` — and the test went red, as
intended.

**What was not intended is that the create then SUCCEEDED.** The probe credential is a
`nosuperuser` role with CONNECT and no table grants, so the D-40 read-only gate passed it happily,
and a datasource named `control_plane_probe` pointing at **`foundry_parent`** was written to the
`Sandbox (dev-data rehearsal)` workspace. `sandbox:status` then listed it beside the real ones —
*"4 of 5 datasources would have a DRAFT run read production"* where the documented figure is 3 of 4.

Two things to take from it:

- **It is §1.3 demonstrated in one command**, which is worth more than the prose. A read-only
  credential on the control plane is not a mitigated risk; it is the credential you would choose,
  and before D-64 the product stored it without a single finding.
- **A test that can plant something must remove it, and not only on the happy path.** The wiring
  test now deletes the row in a `finally`, and `afterAll` sweeps the name again in case the test
  never reached its own cleanup. Without both, the next person who perturbs this leaves a live
  control-plane datasource behind and has no reason to look.

⚠ The residue was found by a **read-only status command run for another reason**, not by the suite —
so the suite gained a **sweep** over every stored datasource, because the gate only refuses *new*
registrations and a row that predates it is otherwise re-checked only when somebody edits it
(`datasourceService.update` runs the check on any credential-affecting edit for exactly that reason).

**The sweep needed two fixes before it was a control at all**, and both are the same mistake this
file keeps recording:

- **Its first version examined nothing and passed.** A stored DSN is container-facing
  (`host.docker.internal:5433`) and the suite is a host process, so all four datasources came back
  "unreachable" and the sweep reported clean — I-36's asymmetry, arriving as I-38's shape. It now
  re-dials an unreachable DSN at the local cluster address with the same credential and **names in
  its output** how many rows were reached which way, and it fails if it reached none.
- **It has a negative control, and it must stay.** A sweep over rows that are all fine reports clean
  whether or not it works. So one row is planted through `datasourceRepo` directly — bypassing the
  gate, which is what a pre-gate row looks like — and the sweep is required to notice it; the plant
  failing is INCONCLUSIVE **and a failure**, not a pass. Same rule as `backup-verify.sh`'s last
  assertion.

---

## I-65 — `app.use("/api", requireApiKey, router)` guards every `/api/*` path, not the router's

**Found** 2026-08-03 by `e2e:ui`, while adding `GET /api/signals` (D-66). **4 hard FAILs**, and none
of them named the cause.

The mount was written the way it reads:

```ts
app.use("/api", requireApiKey, signalsRouter);   // WRONG
```

That is not "mount this router under `/api` behind the API key". Express attaches the whole handler
chain to the **path prefix**, so `requireApiKey` ran for every `/api/*` request that reached that
line — including the block mounted below it that is deliberately outside the parent-key boundary:
`/api/steps/*` (authenticated by the execution token, R3) and `/api/executions/begin`
(authenticated by the callback secret, and reading the namespace from Kestra — I-07).

**The symptom was three hops from the cause and mentioned none of it.** Every flow still deployed,
`POST …/test-run` still returned **202**, and then the execution simply never appeared in the
executions list. `begin` is the task that writes the `flow_executions` row, so a 401 there means the
run exists in Kestra and has no Foundry-side record at all — the journey timed out after 121 s with
*"never appeared"*, which reads like a slow engine.

Three things worth keeping:

- **The fix is to mount at the exact path** — `app.use("/api/signals", requireApiKey, signalsRouter)`
  with the route at `"/"`. The guard then applies to this router alone, which is what the first
  version looked like it said.
- ⚠ **`kestra:check` passed throughout, and correctly.** Its 25 assertions are boundary properties —
  ports, networks, images, plugin set, socket ownership — and none of them executes a flow. Only
  `e2e:ui`, which drives the whole journey over the HTTP surface the client uses, could see this.
  That is the argument for keeping a journey test that gates on nothing but hard failures: it is the
  only check in the net that would have noticed.
- ⚠ **The obvious probe did not discriminate.** `curl -X POST /api/executions/begin` with no
  credential returns **401 both before and after** — correctly, because it wants the callback
  secret. Reaching for it as a confirmation would have "disproved" the theory and sent the
  investigation elsewhere. What settled it was re-running the journey.

---

## I-66 — the canvas flickered on hover, and it was the EDGES unmounting, not the nodes

**Found** 2026-08-04, reported from use: *"when I hover over any component in the DAG it flickers
too much."* Reproduced on all four surfaces that draw a canvas. Blocking a production deploy.

**The report points at the nodes and the cause is in the edges.** Hovering a node sets `hovered`,
which recomputes `litSet`, which rebuilds the whole `nodes` array — every node a **new object**.
React Flow's `adoptUserNodes` compares nodes by IDENTITY:

```js
if (_options.checkEquality && userNode === internalNode?.internals.userNode) { /* reuse */ }
else {
  internalNode = { ...userNode,
    measured: { width: userNode.measured?.width, height: userNode.measured?.height },
    internals: { handleBounds: parseHandles(userNode, internalNode), … } }
}
```

and `parseHandles` throws the mount-time bounds away unless the user node carries `measured`:

```js
if (!userNode.handles) return !userNode.measured ? undefined : internalNode?.internals.handleBounds;
```

So a rebuilt array left every node with `measured: {undefined, undefined}` and no `handleBounds`.
`isNodeInitialized` needs both; `getEdgePosition` returns `null` without it; `EdgeWrapper` returns
`null` on a null position. **Every edge in the graph unmounted, and remounted a frame or two later
when the ResizeObserver re-measured** — on every mouse *enter* and every mouse *leave*.

Four things worth keeping:

- ⚠ **It also fired once per poll on a live run**, where the graph legitimately changes and the
  array is rebuilt for a real reason. Nobody reported that, because a run page updating every
  second is *expected* to move — the hover case is what made it visible. Fixing hover alone (by
  moving the highlight out of node `data`) would have left the worse half in place.
- **The fix is to declare the size, and it is not a workaround.** The cards are a fixed 232×76,
  `layout()` already spaces dagre's graph by exactly that pair, and measuring a box whose size is a
  compile-time constant was always the long way round. `stepNodes` now sets `measured`, `width` and
  `height` from `NODE_W`/`NODE_H`. `measured` is the one that does the work — `width`/`height` alone
  do not satisfy `parseHandles`, so the edges would still have gone.
- ⚠ **The new failure mode is quieter than the old one.** A declared size that stops matching the
  rendered card attaches edges to the wrong place, with nothing flickering to say so. `NODE_W`/
  `NODE_H` are now the single source for the card, for dagre and for the declaration — the card had
  `w-[232px]` and `style={{height:76}}` hardcoded beside them — and `FlowCanvas.test.tsx` asserts
  the rendered card is exactly the declared pair. Both new assertions were verified by perturbation:
  dropping `measured` fails one, resizing the card fails the other.
- ⚠ **jsdom cannot see the bug, and the test says so rather than pretending.** No layout means
  React Flow never measures, so no edge reaches the DOM in any client test — an assertion about
  edges disappearing would run over an empty set and pass for ever (I-38). The invariant is pinned
  at the seam that broke instead, with the mechanism written down so the next person can re-derive
  it. `routes.smoke.test.tsx` could not have caught this either; it renders pages with their data
  still in flight.

**Verified.** `pnpm --filter @foundry/client test` **163 passed** (was 160) · `tsc --noEmit` clean ·
`scripts/ui-honesty-check.sh` **37 PASS**, exit 0. Both new assertions were proven able to fail, by
perturbation and restore: deleting the `measured` line fails *"declares `measured`, which is what
preserves the handle bounds"* and nothing else; changing the card's height to 90 fails *"renders the
card at exactly the size it declares"* and nothing else.

⚠ **Established by reading `@xyflow/system`, not by watching it.** There is no headless browser in
this environment, and jsdom cannot reproduce the symptom. The chain — `adoptUserNodes` →
`parseHandles` → `isNodeInitialized` → `getEdgePosition` → `EdgeWrapper` returning `null` — was read
out of the pinned dependency (`@xyflow/system@0.0.79`, `@xyflow/react@12.11.2`). Confirmation that
the flicker is gone on screen is the one part of this that a person still has to do.
