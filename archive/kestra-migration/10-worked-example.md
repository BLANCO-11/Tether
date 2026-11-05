## 14. Appendix — one request, end to end

A worked example against the HR workspace (`20406b2e-…`, 14 tools, 7 tables, manifest ≈14 KB).
Deliberately includes two places where the draft comes out **wrong**, because that is where the
design earns its keep.

### T0 — the client's request

In `automations/new`, a client admin types:

> *"Every Monday, find employees whose attendance last month was below their department's threshold,
> write each of them a personalised coaching note, and email it. Skip anyone on approved medical
> leave. Send me a summary at the end."*

### T1 — Foundry drafts a flow **model**

The drafting prompt receives the manifest, the step vocabulary, and the flow-model schema. `TASK`
stays **last** (measured: shared prefix 4.4% → 95%).

Output is Foundry's model — **never Kestra YAML** (R8):

```json
{
  "name": "attendance-coaching",
  "inputs": [{ "id": "period", "type": "string", "pattern": "^\\d{4}-\\d{2}$" }],
  "steps": [
    { "id": "fetch_attendance", "kind": "datasource",
      "ref": "hr_demo.attendance_summary", "params": { "period": "{{ inputs.period }}" } },
    { "id": "fetch_policy", "kind": "datasource", "ref": "hr_demo.policy_thresholds" },
    { "id": "fetch_leave", "kind": "tool", "ref": "list-approved-leave",
      "params": { "period": "{{ inputs.period }}" } },
    { "id": "screen", "kind": "transform",
      "expr": "attendance below COALESCE(dept_threshold, org_default) minus leave-excluded" },
    { "id": "write_notes", "kind": "agent",
      "forEach": "{{ steps.screen.output }}",
      "prompt": "Write a coaching note for {{ item.name }} at {{ item.rate }}%" },
    { "id": "send", "kind": "tool", "ref": "send-email",
      "forEach": "{{ steps.write_notes.output }}" },
    { "id": "summary", "kind": "notify", "to": "{{ flow.owner }}" }
  ]
}
```

Note what the model got **right** that a generated script kept getting wrong: `period` is a declared
input, and `screen` references `fetch_policy`'s output rather than a hardcoded `80`. Those two
failure modes are now structurally unreachable.

### T2 — validation rejects it, twice

`flow-validator.service.ts` runs before the compiler:

| # | Finding | Why |
| :--- | :--- | :--- |
| **1** | `list-approved-leave` — **no such tool** | The manifest has 14 tools; this name was invented. Exactly the measured "invented enum values / guessed field names" failure — now caught at author time instead of at 3 a.m. |
| **2** | `write_notes` fan-out = 11 **agent runs** — exceeds `max_agent_runs_per_execution` | 11 × ~6 min ≈ 66 min for what should take seconds. This is §9's ceiling, enforced structurally rather than discovered in production. |

Nothing is deployed. **The client never sees this.** Both findings are LLM errors, so both go back to
the LLM as a structured continuation (§6.4):

```json
{ "attempt": 1, "findings": [
  { "step": "fetch_leave", "rule": "unknown_ref",
    "detail": "no tool \"list-approved-leave\" in this workspace",
    "available": ["get-leave-records", "list-employees", "send-email", "…11 more"] },
  { "step": "write_notes", "rule": "agent_fanout_exceeded",
    "detail": "forEach over 11 items on an agent step; max 2 agent runs per execution",
    "hint": "use \"batch\" to pass all items to one agent run" }
]}
```

### T3 — the LLM redrafts (attempt 2)

~800 chars against a cached prefix, so this costs seconds, not a cycle of human attention.

```diff
-    { "id": "fetch_leave", "kind": "tool", "ref": "list-approved-leave",
+    { "id": "fetch_leave", "kind": "tool", "ref": "get-leave-records",
-    { "id": "write_notes", "kind": "agent", "forEach": "{{ steps.screen.output }}",
+    { "id": "write_notes", "kind": "agent", "batch": "{{ steps.screen.output }}",
```

The corrected tool arrives with its **true parameter shape from the manifest**, so the params cannot
be guessed — the LLM is now binding against facts rather than inventing.

Validation passes on attempt 2. `flow_revisions` gets **revision 1**.

Had it still failed after attempt 3, the flow would escalate to a human with all accumulated
findings — the only path on which a person touches structure.

### T4 — compile to Kestra YAML

`flow-compiler.service.ts` — the only YAML emitter in the system — produces (illustrative):

```yaml
id: attendance-coaching
namespace: acme.hr.draft
inputs:
  - id: period
    type: STRING
  - id: token
    type: SECRET

tasks:
  - id: fetch_attendance
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/datasource"
    method: POST
    headers: { Authorization: "Bearer {{ inputs.token }}" }
    body: '{"ref":"hr_demo.attendance_summary","params":[{"period":"{{ inputs.period }}"}]}'

  - id: fetch_policy
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/datasource"
    body: '{"ref":"hr_demo.policy_thresholds","params":[{}]}'

  - id: fetch_leave
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/tool"
    body: '{"ref":"get-leave-records","params":[{"period":"{{ inputs.period }}"}]}'

  - id: screen                      # no credential → native, stays in Kestra
    type: io.kestra.plugin.core.debug.Return
    format: "{{ … pebble expression over the three outputs … }}"

  - id: write_notes
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/agent"
    body: '{"batch":{{ outputs.screen.value }},"prompt":"…"}'

  - id: await_notes
    type: io.kestra.plugin.core.flow.Pause      # ← Foundry resumes on Tether terminal

  - id: send
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/tool"
    body: '{"ref":"send-email","params":{{ outputs.await_notes.outputs.notes }}}'
    retry: { type: constant, interval: PT30S, maxAttempt: 3 }

  - id: summary
    type: io.kestra.plugin.core.http.Request
    uri: "{{ vars.foundry }}/api/steps/notify"
```

Every task is the same type. That is R8 made visible: **eight steps, one emitted task type, one
reachable host.**

### T5 — test run in the draft namespace

Manual execution against `period: "2026-06"`. Seven taskruns recorded. Then compared to the oracle:

| | Oracle | Run | |
| :--- | :--- | :--- | :--- |
| Below threshold | 11 | 11 | ✓ |
| Excluded (medical leave) | 2 | 2 | ✓ |
| Unmailable (NULL email) | 1 | 1 — surfaced as a `send` warning, not a crash | ✓ |
| Employee #14 @ 80.95% | included (Engineering override 85) | included | ✓ |

Employee #14 is the trap that a script hardcoding `80` always missed. It passes here for a
structural reason: the threshold came from `fetch_policy`, so there was nothing to hardcode.

`enableReadiness()` is now satisfied — one succeeded execution.

### T6 — approval

`RevisionDiff.tsx` shows the approver the seven steps, the two datasource refs, the one tool that
sends mail, and the single agent step. A client admin approves **revision 1**.

`flow-approval.service.ts`: compile → deploy to `acme.hr` (live) → write `flow_approvals` with the
manifest fingerprint. `flows.armed_revision = 1`.

### T7 — arm the schedule

Weekly, Mondays 09:00. All three gates now pass: readiness ✓, approval ✓, step gates none.

### T8 — Monday 09:00, unattended

```
Foundry scheduler tick
  ├─ trigger due · approval valid · fingerprint matches · budget ok
  ├─ mint execution token  (tenant + ws + this execution, short TTL, single use)
  └─ POST Kestra /executions/acme.hr/attendance-coaching  { period: "2026-07", token }

  fetch_attendance   → Foundry → foundry_ro DSN          62 rows      0.4s
  fetch_policy       → Foundry → foundry_ro DSN          8 rows       0.1s
  fetch_leave        → Foundry → get-leave-records       3 records    0.6s
  screen             → native transform                  11 employees 0.0s
  write_notes        → Foundry → Tether POST /api/run    runId        0.2s
  await_notes        → PAUSED ─────────────────────────────────────── 5m 48s
        Tether: one agent run, batch of 11 → 11 notes → sandbox smoke-test
                → contract assembled → findStaleResult / findFailingExitCodes pass
        Foundry poller sees terminal → POST Kestra /executions/{id}/resume
  send               → Foundry → send-email ×11          10 sent, 1 skipped (NULL email)
  summary            → Foundry → notify owner
                                                          TOTAL ≈ 5m 50s
```

**5m 48s of that 5m 50s is the one agent step.** Everything deterministic finished in ~1.1 seconds.
Had validation not caught T2's fan-out, this would have been ~66 minutes.

### T9 — what exists afterwards

| Artifact | Where | Notes |
| :--- | :--- | :--- |
| Flow model, revision 1 | `flow_revisions.model_json` | Immutable. The shareable/exportable form. |
| Compiled YAML | Kestra, namespace `acme.hr` | Derived. Never hand-edited. |
| `flow_executions` row | Foundry | `kestra_execution_id`, trigger fire, inputs |
| **7 × `flow_step_runs`** | Foundry | Per-step status, timing, `kestra_taskrun_id`; `tether_run_id` on `write_notes` |
| Per-step inputs/outputs | Kestra | What the step graph renders |
| 11 coaching notes | Tether artifacts + `flow_step_runs` output | |
| Run contract | Tether, joined via `tether_run_id` | Integrity checks on the agent step only |
| 10 mails, 1 skip | `stub_mail_outbox` | |
| Tool call trail | `stub_call_log` | Now corroborating evidence, not the primary record |
| Approval record | `flow_approvals` | Approver, timestamp, revision, fingerprint |

**What does *not* exist: a generated Python script.** There is no `scripts` row, no
`requirements.txt`, no monolithic artifact whose correctness has to be inferred by regex. Seven
declared steps, one of which called an agent.

### T10 — the following Monday

Nothing regenerates. The scheduler fires the same approved revision; the same seven steps run. Only
`write_notes` produces different text, because it is the only non-deterministic step — and its
inputs are pinned by the six deterministic steps around it.

That is the whole thesis: **non-determinism confined to one named slot instead of spanning the
entire process.**

### If the client edits it in week three

Say they want a Slack ping added. They edit → **revision 2**, unapproved, deployed only to
`acme.hr.draft`. Monday's schedule keeps running **revision 1** from the live namespace, untouched.
When an approver signs off on revision 2, it promotes and takes over the following Monday.

And if someone changes `get-leave-records` to require a new parameter, the manifest fingerprint
stops matching, the approval goes stale, and the schedule **suspends** rather than firing a flow that
is now wrong.
