# POC results

Branch: `explore/agent-sandbox-thesis`  
Date: 2026-10-09  
Speckit: **not used** (explicit user instruction).

## Machinery (no LLM)

| Check | Result |
| :--- | :--- |
| Verifier | **PASS** — 2 steps; fails when `questions.status=open` |
| Runner + oracle | **PASS** — 3 overdue notifications to `customer_email` |
| openredaction context | **PASS** — 12 PII values scrubbed; leak assert green |
| Clarify simulate → answer | **PASS** — `clarify.mjs` + verifier gate |
| Clarify + apply (stub) | **PASS** — wrong `billing_email` corrected via answers → oracle green |

## openredaction note

Default patterns skip RFC 2606 `.example` emails. Fixtures use consumer domains
(`gmail.com` / `yahoo.com`) so **openredaction** is the real scrubber. Context
walks JSON **string** values only (avoids false-positive redaction of `amount_cents`).

## Pi spawn

| | |
| :--- | :--- |
| Binary | `/Users/himanshu/.local/node/bin/pi` (`@mariozechner/pi-coding-agent` **0.74.2**) |
| Invoke | `pi --print --no-session --append-system-prompt sandbox/SYSTEM.md "<prompt>"` |
| cwd | `poc/agent-sandbox/sandbox` |
| Outcome | **Spawned, model call failed** — `401 LiteLLM Virtual Key expected. Received=$LLM****_KEY, expected to start with 'sk-'.` |
| Log | `sandbox/pi-last-run.log` (gitignored) |

Pi is installed and the harness can launch it. This environment's LiteLLM key
is not accepted by Pi's provider. Clarification + build loop was proven with
`scripts/agent-stub-clarify.mjs` using the **same file protocol** Pi is instructed
to use. Re-run `bash scripts/spawn-pi.sh` once a valid `sk-` key is configured.

## Time-to-green (control, no agent)

- verify + run + oracle: **~1–2 s** wall on this machine
- build-context (openredaction): **~1 s**

## Thesis read

| Claim | Verdict |
| :--- | :--- |
| Closed env + linked scripts + code verifier + oracle | **Proven** |
| openredaction-only agent context | **Proven** |
| Clarification channel (ask → answer → resume) | **Proven** (harness + stub; Pi blocked on auth) |
| Live Pi rebuild of workflow | **Not proven here** — spawn OK, inference 401 |

## Commands to re-run

```bash
cd poc/agent-sandbox
npm install
npm run build-context
npm run control
node scripts/agent-stub-clarify.mjs ask
node scripts/clarify.mjs answer q1=customer_email
node scripts/agent-stub-clarify.mjs apply
npm run control
# when LLM key works:
bash scripts/spawn-pi.sh
```

## Pi spawn — 2026-10-09T11:35:28Z

- PI_BIN: `/Users/himanshu/.local/node/bin/pi`
- provider: foundry-gateway / model: gpt-6-luna
- env: LLM_* from repo .env via load-llm-env.sh
- started: 2026-10-09T11:35:28Z / ended: 2026-10-09T11:35:29Z
- exit: 1
- log: sandbox/pi-last-run.log
- tail: Invalid URL 


## Pi spawn — 2026-10-09T11:36:01Z

- PI_BIN: `/Users/himanshu/.local/node/bin/pi`
- provider: foundry-gateway / model: gpt-6-luna
- env: LLM_* from repo .env via load-llm-env.sh; --api-key passed; baseUrl materialized
- started: 2026-10-09T11:36:01Z / ended: 2026-10-09T11:36:03Z
- exit: 1
- log: sandbox/pi-last-run.log
- tail: 400 litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.  LiteLLM: model group 'gpt-6-luna' failed with the error above. No fallback was attempted. 


## Pi spawn — 2026-10-09T11:36:41Z

- PI_BIN: `/Users/himanshu/.local/node/bin/pi`
- provider: foundry-gateway / model: gpt-5.4-mini
- env: LLM_* from repo .env via load-llm-env.sh; --api-key passed; baseUrl materialized
- started: 2026-10-09T11:36:41Z / ended: 2026-10-09T11:36:42Z
- exit: 1
- log: sandbox/pi-last-run.log
- tail: 403 The requested model 'gpt-5.4-mini' is not available for this API key, or the model name is invalid. Check the models available to you and try again. 


## Pi spawn — 2026-10-09T11:37:01Z

- PI_BIN: `/Users/himanshu/.local/node/bin/pi`
- provider: foundry-gateway / model: gpt-6-luna
- env: LLM_* from repo .env via load-llm-env.sh; --api-key passed; baseUrl materialized
- started: 2026-10-09T11:37:01Z / ended: 2026-10-09T11:37:03Z
- exit: 1
- log: sandbox/pi-last-run.log
- tail: 400 litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.  LiteLLM: model group 'gpt-6-luna' failed with the error above. No fallback was attempted. 


## Pi spawn — litellm + gpt-6-luna (2026-10-09)

- provider: `litellm` via `npm:pi-provider-litellm`
- model: `gpt-6-luna`
- env: `LLM_*` → `LITELLM_*`; `LITELLM_OFFLINE=1`
- exit: **0**
- outcome: wrote `questions.json` with open Q on customer_email vs billing_email (~7s)
- caveat: stock plugin still sends a non-`none` `reasoning_effort` with tools; gateway rejects that on `/v1/chat/completions`. Local patch on `pi-provider-litellm/dist/index.js` forces `reasoning_effort=none` for `*luna*` models. Curl confirmed tools+`none` returns 200.


## Live Pi end-to-end — workflow creation (2026-10-09)

Provider: `litellm` / model: `gpt-6-luna` (auth.json + reasoning_effort=none patch).

| Phase | Result | Wall |
| :--- | :--- | :--- |
| 1 Clarify (blank workflow) | **PASS** — open q1 customer_email vs billing_email; workflow stayed `[]` | ~6 s |
| 2 Answer | **PASS** — `q1=customer_email` via clarify.mjs | — |
| 3 Build | **PASS** — Pi wrote `fetch_overdue` + `notify_invoice` (foreach); verifier OK; runner 3 msgs | ~25 s |
| 4 Oracle (first) | **FAIL** — subject `Overdue invoice {id}` vs required `Invoice {id} is overdue` | — |
| 5 Fix + re-oracle | oracle exit=0 | ~see log |

- Blank-slate start (empty steps, empty workflow) — not golden copy.
- Email column honored from answers (`customer_email`).
- Structural verifier green before oracle.
- Subject mismatch is oracle-strict vs GOAL (“mention the invoice id”); fix turn applied.


## Harness fixes + complex scenario (2026-10-09)

### Fixes
- Verifier refuses empty `workflow.steps`; requires `outbox_append` for outbox writers
- Oracle supports `ORACLE_EXPECTED` + `subjectContains` (exact `subject` still for complex)
- Runner resolves `*_path` / `*Path` params to sandbox paths
- Local Pi extension `pi-extensions/luna-tools-compat.js` forces `reasoning_effort=none` for luna
- `scripts/agent-loop.mjs` + `npm run loop:complex` — clarify → answer → build → fix loop
- SYSTEM.md: templates required, exact subject when stated, params for answers

### Complex scenario (`scenarios/complex`)
GOAL: overdue only · sort amount desc · threshold routing (billing if ≥ T else customer) · exact subject.
Ambiguity: T = 100000 vs 1000 cents.

| | |
| :--- | :--- |
| Loop | **PASS** (`fixes=1`) |
| Clarify | Asked q1 threshold **and** q2 (context fought GOAL) — answer map then failed on q2 |
| Build (first) | Refused (open questions) — correct |
| Fix 1 | Built **3 steps** fetch → sort → notify; used `outbox_append` + `db_query`; oracle green |
| Outbox | INV-1004→AP, INV-1001→AP, INV-1002→customer — matches expected |

Follow-up: softened `fixtures/schema.json` ambiguity so GOAL routing does not spawn a second email question; agent-loop maps extra q-ids from leftover scenario answers.

## Edit probes (2026-10-09)

On the complex 3-step workflow (post-create):

| Probe | Result |
| :--- | :--- |
| A — user Q about workflow, “do not modify” | **PASS** — answered fetch→sort→notify + routing; workflow/notify files unchanged |
| B — surgical param: threshold 100000→150000 | **PASS** — only `workflow.json` params; verify/run/oracle green vs new expected |
| C — rename `sort`→`order_by_amount` + rewire bindings | **PASS** — verifier caught structure; run/oracle still green |

Not yet tested: multi-turn chat edits, delete step, add branch, concurrent edit+clarify, rollback/snapshots.

## Edit harness (2026-10-09)

`scripts/snapshot.mjs` + `scripts/edit-loop.mjs` (+ SYSTEM edit/Q&A rules).

| Probe | Result |
| :--- | :--- |
| QA (`--qa`) | **PASS** — answered; fingerprint unchanged |
| Edit threshold → 150000 | **ACCEPT** — oracle green; snapshot retained |
| Destructive empty steps | **REVERT** — verify failed; restored 3 steps @ threshold 150000 |

Commands: `npm run edit` / `node scripts/edit-loop.mjs --qa --request=...`
