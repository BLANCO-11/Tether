## 3. Governing rules

These are load-bearing. Violating any one of them reintroduces a problem the design exists to avoid.

### R1 — Use Kestra unmodified

No fork, no Java plugins, no patches. Every step is `io.kestra.plugin.core.http.Request` against
Foundry. Consequence: upgrades are a version bump, and the AGPL/licence story stays trivial.

### R2 — Use Kestra for everything it can do. Foundry owns exactly two things.

**Maximise Kestra.** Every capability it ships is a capability we do not build. Foundry retains
precisely two responsibilities Kestra must never hold:

1. **Credential custody** — Kestra OSS secrets are env-var based with **no tenant scoping**, so a
   per-tenant credential cannot safely live there.
2. **The client-facing surface** — no tenant model, no RBAC (both EE).

Everything else goes to Kestra by default. The burden of proof is on keeping work in Foundry, not on
moving it to Kestra.

#### The credential test

A step runs in Kestra **if and only if** it needs no tenant credential:

| Step kind | Needs a tenant credential? | Runs in |
| :--- | :--- | :--- |
| `code` | No — pure transform (R9) | **Kestra** — Docker task runner |
| `transform` | No | **Kestra** — native expression |
| `tool` | Yes — API key from `workspace_secrets` | Foundry |
| `datasource` | Yes — `foundry_ro` DSN | Foundry |
| `agent` | Yes — Tether `x-api-key` | Foundry |
| `notify` | Yes — SMTP / Slack | Foundry |

Kestra holds exactly **one** secret: its credential to call Foundry. Passing a tenant DSN or API key
as a flow input is **forbidden** — Kestra persists inputs in its execution history, which would put
tenant credentials in Kestra's database.

### R3 — Tenant identity never travels in a payload

Foundry mints an **execution-scoped token** (tenant + workspace + flow execution, short TTL,
single use) and passes it as a flow input. Kestra presents it on every step callback; Foundry
resolves tenancy *from the token*. Kestra never receives, stores, or asserts a `tenantId`.

Consequence: compromising Kestra exposes in-flight executions only, not the tenant space. This is
what makes a no-tenant-model engine safe to run.

### R4 — Never trust a client-supplied namespace

Inject the namespace server-side from the authenticated tenant on every read path. Kestra's list
endpoints will happily return another client's executions if the parameter is passed through —
textbook IDOR. This is the single highest-severity risk in the migration.

### R5 — `kestra-ui` is never exposed to clients

No tenant isolation, and it's Kestra-branded. Both fatal for a commercial service. Do not iframe
it. Internal engineers use it directly for debugging; that is free and valuable.

### R6 — One system of record per concept

| Concept | Authoritative store |
| :--- | :--- |
| Flow definitions, revisions, executions, step runs | **Kestra** |
| Tools, datasources, manifest, secrets, tenancy, audit, oracle | **Foundry** |
| Agent sessions, run contracts, artifacts | **Tether** |

Do **not** keep flow YAML authoritative in Foundry's Postgres and sync it into Kestra — that is two
sources of truth and guaranteed drift. Foundry's `flows` table is a **pointer plus domain
metadata**, joined on `kestra_flow_id` / `kestra_execution_id` / `kestra_taskrun_id`.

### R7 — No new services beyond Kestra

Anything Kestra lacks gets built in Foundry. No Redis for this, no separate worker, no sidecar.

### R8 — Clients never author raw Kestra YAML

**This is the most important rule in the document**, and it follows from the decision that clients
author their own flows (§6.5).

Clients author against **Foundry's flow model** — a restricted step vocabulary.
`flow-compiler.service.ts` is the *only* component in the system that emits Kestra YAML. That makes
the step vocabulary an allowlist by construction: a client can only express steps the compiler knows
how to emit.

**The compiler's allowlist is exactly three task types.** Nothing else is emittable:

| Emitted type | For | Constraint |
| :--- | :--- | :--- |
| `io.kestra.plugin.core.http.Request` → Foundry | `tool`, `datasource`, `agent`, `notify` | Target host is always Foundry |
| `io.kestra.plugin.scripts.python.Script` | `code` steps | **Docker task runner only**, network off (R9) |
| `io.kestra.plugin.core.flow.*` | `ForEach`, `Pause`, `If`, `Subflow` | Control flow, no I/O |

If clients could submit YAML, they could write **any** Kestra task type:

| Attack | Consequence |
| :--- | :--- |
| A script task (`io.kestra.plugin.scripts.*`) | Arbitrary code execution inside Kestra's container |
| `http.Request` to `169.254.169.254` | Cloud metadata credential theft |
| `http.Request` to Foundry's admin routes or Kestra's own API | SSRF into the trust zone behind R2/R4 |
| A task reading Kestra's filesystem | Reads the Foundry credential from R2 |

Corollaries:

- **Flow import (Phase 6) accepts Foundry's model format only** — never raw Kestra YAML — and
  revalidates every step reference against the *importing* tenant's manifest.
- **Flow export emits Foundry's model, not Kestra YAML.** Bonus: the sharing format doesn't leak the
  engine choice, so the engine stays swappable.
- Every step reference is validated server-side against the authenticated tenant's manifest. Never
  trust refs in submitted flow content.

### R9 — Generated code is always a pure transform

A `code` step is a **pure function**: declared input → declared output. **No network, no database, no
filesystem, no email.** Every side effect lives in a pre-written step kind — `tool`, `datasource`,
`notify` — which are never generated.

Consequences:

| | |
| :--- | :--- |
| Generated code can only compute a **wrong value** | It can never contact the wrong system, write the wrong table, or mail the wrong person |
| Each fragment is **unit-testable** | Declared input → assert declared output. No live datasource, no sandbox network |
| Fragments are **independently regenerable** | No hidden coupling to a neighbour's side effects |
| The blast radius of a bad fragment is one step's output | Not the automation |

This is what makes per-step generation safe enough to do at all, and it is why the failure modes in
§5.3 become inexpressible rather than merely rarer. A fragment that cannot reach the network cannot
guess an API field name.

#### Where the fragment runs

`code` steps execute **in Kestra**, via its Docker task runner — not in Foundry. Under R2 this is the
default, because a pure transform needs no credential and therefore has nothing to protect.

```yaml
- id: compute_variance
  type: io.kestra.plugin.scripts.python.Script
  taskRunner:
    type: io.kestra.plugin.scripts.runner.docker.Docker   # ← Docker, NEVER Process
  containerImage: python:3.12-slim
  script: |
    # generated fragment — pure function over stdin JSON
```

Three non-negotiable constraints:

| | |
| :--- | :--- |
| **Docker task runner only, never Process** | Process runs in Kestra's own process space, where a fragment could read Kestra's Foundry credential. Docker spawns a separate container. |
| **Network disabled** | ⚠ **Verify in Phase 4** that the Docker runner exposes a network-mode setting. If it does not, `code` steps fall back to Foundry's Docker runner. |
| **No credentials in the container** | No env vars, no volumes carrying secrets. The fragment sees only its declared input. |

Gains from running fragments in Kestra: per-step logs land in the same taskrun record as everything
else, no HTTP round-trip for a pure function, container lifecycle handled, and `inputFiles` /
`outputFiles` replaces hand-rolled data passing.

---

