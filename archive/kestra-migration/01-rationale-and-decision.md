## 1. What problem this solves

Today an automation is a **prompt in, monolithic Python script out**. That produces four
problems, all measured in `foundry/CLAUDE.md`:

1. **No per-step visibility.** An execution records whole-script stdout, exit code and duration.
   `stub_call_log` lets you reconstruct what happened forensically, after the fact. There is no
   structural record of "step 3 received X and produced Y".
2. **No per-step debugging.** A wrong script is regenerated whole. The measured loop is
   *generate → execute → read `stub_call_log` → feed the error back*, and it re-runs everything.
3. **No sharing.** An automation is a blob of generated Python in one workspace. It cannot be
   exported, reviewed, diffed, or handed to another tenant as a starting point.
4. **Failure modes that decomposition eliminates outright.** Measured: 1 of 3 scripts achieved its
   objective first-pass. One *"hardcoded `period="2023-10"`, emailed 0 of 11, and still exited 0
   with `tests_passed=true` and audit `clean`."*

That fourth point is the load-bearing one. The recurring failure modes are not model-quality
problems, they are **blast-radius** problems:

| Measured failure mode | Why it becomes impossible under a flow |
| :--- | :--- |
| Fabricated dates (`period="2023-10"`) | `period` is a declared **flow input**. Not generatable. |
| Missing `COALESCE` to a policy default | Threshold resolution is a **pre-written step**. |
| Guessed response field names | The tool call is **pre-written** against the real API. |
| Invented enum values | Step params validate against the manifest **before** execution. |

You already discovered this move at the SQL layer — WS-E's `presence_vs_policy` view
"pre-resolves the policy join". This applies it at the process layer.

---

## 2. Decision record

### Chosen: Kestra, Apache-2.0, single instance behind Foundry

Screened on the criteria that actually matter for this system — **per-step execution records,
per-step debug/replay, portable flow definitions, and a licence that survives commercial resale
to external clients.**

| Engine | Per-step visibility | Replay one step | Share/export | Licence for resale | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Kestra** | Gantt + per-task I/O | **Replay from task** | YAML + blueprints | **Apache-2.0** | **Chosen** |
| n8n | Best in class | Yes | JSON + templates | ✗ Sustainable Use License | Rejected |
| Windmill | Excellent | Yes | Hub | ✗ AGPL + "re-exposing to end-users" | Rejected |
| Activepieces | Good | Yes | JSON (git-sync is paid) | ⚠ MIT core + proprietary `packages/ee/` | Rejected |
| Temporal / Cadence | Operator event history only | No | N/A | MIT / Apache-2.0 | Rejected |
| Airflow / Prefect / Dagster | Task logs, no business-readable graph | Partial | Python files | Apache-2.0 | Rejected |
| Node-RED / Huginn | — | — | — | — | Category mismatch |

**Why the rejections landed where they did:**

- **n8n** — SUL permits internal business use but prohibits reselling inside a commercial service.
  Foundry is sold to external clients, which is the prohibited case.
- **Windmill** — AGPL plus an explicit "re-exposing components to end-users requires a commercial
  licence." Selling clients a service where they use the flow surface is that scenario verbatim.
  Best technical fit on the list; blocked outright.
- **Activepieces** — MIT core, TypeScript (our stack), but git-sync is Ultimate-plan only, so on the
  free core flows live solely in its Postgres. Also requires policing the MIT/`packages/ee/`
  boundary on every upgrade — a permanent compliance tax worse than a JVM.
- **Temporal / Cadence** — wrong category. You write every workflow yourself in Go/TS, maintain a
  hand-written parameter catalog, and accept replay-determinism versioning discipline forever. It
  buys durability, not the visibility surface, and its UI is operator-grade rather than
  business-readable.
- **Airflow** — heaviest ops, no native HITL, and DAGs are Python files, so a generated flow would
  be an RCE surface in the control plane.

### Rejected: build it in-house

A cursor-driven walker in Foundry is ~600–800 lines and gets you sequencing. It gets you **none**
of the per-step data model, replay-from-step semantics, or a portable flow format — which are the
actual requirement and are months of work. The engine is worth having *because* of the surface, not
because sequencing is hard.

### The honest cost of the choice

Kestra OSS gates multi-tenancy, RBAC and SSO behind enterprise — as does every engine on that
table, because multi-tenancy is what they sell. So:

| Free from Kestra OSS | Still ours to build |
| :--- | :--- |
| Per-step execution records (via API) | Client-facing step-graph UI, tenant-scoped |
| Replay from any task | Per-tenant isolation and authz |
| Portable YAML flow definitions | Per-tenant resource budgets |
| Pause/resume, retries, `ForEach`, subflows | Everything in §6.2 |
| `kestra-ui` — **internal engineers only** | — |

That is roughly 60% of the win, not 100%. The data model and replay semantics are the hard parts
and we get those; a read-only step-graph view over an API is far less work than the engine beneath it.

### Trademark

Apache-2.0 grants no trademark rights. Do not market as "powered by Kestra" without checking
Kestra's trademark policy first.

---

