### 5.1 Where code lives — and what generation still does

This migration does **not** remove code generation. It changes its unit from *one script per
automation* to *small fragments where no declared step covers the work*. Three distinct layers get
conflated easily:

| Layer | Code? | Author | Per-flow? |
| :--- | :--- | :--- | :--- |
| **Step kind** — the six handlers in `step-execution.service.ts` | **Yes — ours** | Us, written once | No. Six, forever. |
| **Step instance** — "call `get-leave-records` with `period`" | **No — data.** A `flow_steps` row | **LLM drafts.** Client may edit. | Yes |
| **What the step invokes** | Client API / SQL / **generated Python** / Tether's loop | **LLM** for `code`/`agent` | Only `code` and `agent` |

**The user never writes code, and never writes flow structure by hand as the default path.** The LLM
drafts the model *and* any code fragments. The client's role is intent (the prompt), review, and
approval — with editing available as an override, not a requirement. See §6.4.

Only the third layer is ever generated, and only for two of the six kinds:

| Step kind | Generated? |
| :--- | :--- |
| `tool`, `datasource`, `notify`, `transform` | No — declared bindings against the manifest |
| **`code`** | **Yes** — a Python fragment, run in Docker (`POST /api/steps/code`) |
| **`agent`** | **Yes** — Tether's generate → sandbox → smoke-test → iterate loop |

**Code-step frequency is inversely proportional to manifest coverage.** §14's worked example has
zero code steps because the HR manifest covers its domain well (14 tools, 7 tables); a thin manifest
produces flows that are mostly `code` steps. Neither is a defect.

**The graduation loop:** a fragment appearing across many flows is a candidate to become a
pre-written tool — the same path by which a prompt-run graduates into a flow. Track recurring
fragments; each one promoted removes a class of generation error permanently.

### 5.2 Sharing semantics — generated code does not travel

Flows are shareable (Phase 6). The export is **Foundry's model**, and:

| Component | Exported? |
| :--- | :--- |
| Step declarations, inputs, branching, retry config | **Yes** |
| Tool / datasource refs (by name) | Yes — **revalidated against the importing tenant's manifest** |
| Secret references (env-var names) | Yes — names only. Values never leave `workspace_secrets`. |
| **Generated code in `code` steps** | **No.** Stripped; the step imports as `needs_regeneration` |
| Execution history, step runs, approvals | No |

Stripping generated code is not caution, it is correctness. WS-E already demonstrates why:
`hr_demo_alt` uses different table names, exposes attendance as **views**, and expresses rates as a
**0–1 fraction** where the primary uses **0–100**. A fragment generated against one is wrong against
the other, and shipping it would also leak the origin tenant's schema.

Consequence: **a shared flow is a recipe, not a binary.** Structure travels; fragments refit to local
schema on first run. This also means the export format never contains Kestra YAML, so the engine
stays swappable (R8).

---

### 5.3 How per-step generation actually works

The single most important mechanism in this document, and the one most easily misread as "a script
gets generated." It does not. **Each `code` step is generated separately, from its own contract.**

#### The step contract

Every step declares an input shape and an output shape. For a `code` step that contract *is* the
entire generation prompt:

```
Step:    compute_variance
Input:   { attendance: [{employee_id, days_present, days_expected}],
           payroll:    [{employee_id, paid_days}] }
Output:  { rows: [{employee_id, variance_pct}] }
Rules:   pure function · no I/O · no network · no DB · stdlib + pandas
```

~50 tokens of context, against today's 8.3 KB boilerplate plus 14 KB manifest. The fragment does
not see the automation's goal, the other steps, the tenant's schema, or the tool catalogue. It sees
two shapes.

#### Worked contrast — a code-heavy flow

*"Reconcile our payroll CSV against HRMS attendance and flag mismatches over 2%."*

| Step | Kind | Generated |
| :--- | :--- | :--- |
| 1 `fetch_attendance` | `datasource` | — declared |
| 2 `parse_payroll` | **`code`** | **Fragment A** ~20 lines |
| 3 `compute_variance` | **`code`** | **Fragment B** ~15 lines |
| 4 `format_report` | **`code`** | **Fragment C** ~25 lines |
| 5 `file_tickets` | `tool` | — declared |
| 6 `summary` | `notify` | — declared |

| | Today — one script | Per-step |
| :--- | :--- | :--- |
| Inference calls | 1 | 3, independent |
| Output tokens | 8–10k · 5–6 min | ~400 each · seconds |
| Artifacts | one `main.py` + `requirements.txt` | 3 fragments, each bound to a contract |
| Fragment B wrong | regenerate the whole script | **regenerate B alone** — A and C stay verified |
| Diagnosis | read `stub_call_log`, infer | step 3's row: exact input, output, error |
| Test granularity | end-to-end smoke test only | **each fragment against its contract — a unit test** |
| Replay | re-run everything | re-run step 3 with steps 1–2 rehydrated |

#### Why this eliminates the measured failure class mechanically

The worst recorded failure: *"hardcoded `period="2023-10"`, emailed 0 of 11, exited 0 with
`tests_passed=true`."*

Fragment B's input contract is `{attendance, payroll}`. **There is no date in it, and the fragment
has no I/O with which to fetch one.** The bug is not less likely — it is inexpressible. Likewise the
fragment cannot email anybody, because sending is step 5, which is pre-written.

| Measured failure | Why inexpressible per-step |
| :--- | :--- |
| Hardcoded date | Not in the contract; no I/O to obtain one |
| Missing `COALESCE` to policy default | Threshold arrives as a declared input |
| Guessed response field names | Fragment never touches an API |
| Invented enum values | Fragment never touches the schema |
| Emailed 0 of 11 | Fragment cannot send |

#### Per-step, at every level

| Level | What "per-step" means |
| :--- | :--- |
| **Generation** | One inference call per `code` step, scoped to that contract only |
| **Execution** | Own container invocation; receives only declared inputs |
| **Record** | Own `flow_step_runs` row — inputs, outputs, timing, exit code |
| **Verification** | Contract conformance: did declared input produce declared output shape? |
| **Regeneration** | Rewrite one fragment; neighbours stay verified |
| **Replay** | Re-run from that step with upstream outputs rehydrated |

### 5.3.1 How generation connects to Kestra — it doesn't

Kestra never calls an LLM. The two are separated **in time**, not wired together.

```
AUTHOR TIME — Foundry ↔ LLM, Kestra absent
   prompt ─▶ LLM ─▶ flow model
          ─▶ LLM ─▶ one fragment per `code` step
          ─▶ compiler EMBEDS fragments into the YAML
          ─▶ deploy to Kestra
════════════════════ deployment boundary ════════════════════
EXECUTION TIME — Kestra ↔ Foundry, LLM absent (one exception)
   Kestra reads YAML ─▶ runs steps ─▶ HTTP to Foundry for credentialed steps
```

The generated Python ships **inside the flow definition**:

```yaml
- id: compute_variance
  type: io.kestra.plugin.scripts.python.Script
  taskRunner: { type: io.kestra.plugin.scripts.runner.docker.Docker }
  containerImage: python:3.12-slim
  script: |
    import json, sys
    data = json.load(sys.stdin)        # ← the generated fragment, baked in
    …
    print(json.dumps({"rows": rows}))
```

Kestra sees a script task with Python in it. It has no knowledge that an LLM produced it.

#### The only two touchpoints

| | Generation happens | How Kestra sees it |
| :--- | :--- | :--- |
| **`code` step** | **Author time** | It doesn't — the code is already in the YAML |
| **`agent` step** | **Execution time** | An `http.Request` to Foundry, indistinguishable from a `tool` step |

The `agent` step is the *only* runtime path to an LLM, and it is reached the way everything else is:
through Foundry (§6.2).

#### Consequence 1 — regeneration is a new revision, not a hot patch

Fix a fragment → recompile → **new revision** → deploy. If the flow was already approved, approval
**goes stale and must be renewed** (§6.5). Regeneration while in draft is free; regenerating an
approved flow re-enters the gate. Correct, but it carries a real UX cost — surface it clearly in
`ApprovalPanel`.

#### Consequence 2 — imports generate before deploying

Import strips generated code (§5.2), so `code` steps arrive empty. Generation happens **at import**,
an author-time operation.

> **A flow must never reach Kestra with an empty `script:` block.** That would require Kestra to
> trigger generation, inverting the entire model.

#### Which generation path — resolves open question 6

Under R9 a fragment is a pure function, so verification needs no sandbox network and no datasource:
run it against the contract's example input, assert the output shape.

**Use Tether anyway, initially.** It already owns generate → run → read error → iterate. Building a
second generation loop to save unmeasured overhead is premature.

The throughput math supports this: the measured 5–6 minutes is for **8–10k output tokens** at
~37 tok/s. A fragment is ~400 tokens — roughly **10–20 s** of decode plus spawn overhead. Tether is
not slow; *large outputs* are slow. Revisit only if per-fragment overhead measures badly in Phase 4.


### 5.3.2 The `code` step execution contract

**Decided:** all `code` steps execute in **Kestra's** Docker task runner. Foundry runs no containers
at all — `execution.service.ts` is **deleted** (§7.0). Nothing is retained for compatibility.

Four conventions must be pinned before the first fragment is generated, or they will be reinvented per
fragment.

#### One pinned base image, and the prompt states what's importable

Kestra's Docker task runner requires `containerImage`. **Use one standard image across all `code`
steps.** Per-flow images mean per-flow dependency resolution — slow, and a supply-chain surface.

Under R9 this is cheap: a pure transform with no I/O needs almost nothing. Stdlib plus `pandas` covers
the large majority.

| | |
| :--- | :--- |
| **`requirements.txt` generation is deleted** | Nothing to resolve per fragment (§7.0.1) |
| **The fragment prompt must name the exact importable set** | Otherwise the model imports `requests` and you get an `ImportError` that reads like a code bug |
| **The validator rejects imports outside that set** | Cheaper than discovering it at execution, and it's a one-line check |

Bumping the image is a deliberate, versioned change — every existing fragment was generated against
the previous import set.

#### stdin JSON in, stdout JSON out

The §5.3 contract is a pure function, so the wire format should match:

```
stdin  ← { "attendance": [...], "payroll": [...] }      the declared input
stdout → { "rows": [...] }                              the declared output
```

⚠ **Pin this in Phase 4.** Kestra script tasks can surface outputs more than one way — captured
stdout, `outputFiles`, or emitted output markers. Pick one, encode it in the compiler, never mix.
Stdout-JSON is recommended: it matches the pure-function model and needs no filesystem convention.

#### Large payloads go to internal storage, not the execution context

Task outputs travel through Kestra's execution context, which is **persisted in its database**. 62
employee rows are fine; 500k rows would bloat every execution record and eventually the UI.

> **Rule:** step outputs above a threshold (start at ~1 MB) are written to Kestra's internal storage
> and passed **by reference**, not inline.

M1 caps taskrun *count*; this caps payload *size*. They are different limits, and the Tier 4 scenario
(~5,000 tickets/day) hits this one first.

#### No credentials, ever

No env vars, no volumes, no mounted config. The container sees its stdin and nothing else (R2, R9).
