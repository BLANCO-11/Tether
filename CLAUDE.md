# Foundry — session entry point

Foundry is a **parent application** over the **Tether Foundry Harness**. It owns tenancy,
credentials, tools, datasources, the workspace manifest and the client UI; Tether owns agent
sessions, run contracts and artifacts.

## Repo layout

| Path | What |
| :--- | :--- |
| `packages/server` | Express API :4000 + WS :4001 (TypeScript, Drizzle, Postgres) |
| `packages/client` | Next.js UI :4002 |
| `packages/mcp-bridge` | :4003 — read-only schema tools. **Not on any live path today.** |
| `packages/ops-api` | :4004 — **the tool layer**, own database, auth on every route. Was `/stub-api/*` INSIDE `server` until Stage 5. |
| `packages/redact` | `@foundry/redact` — `redactSecrets`, shared because drift there is silent. |
| `packages/shared` | `@foundry/shared` — **new 2026-08-12.** Generic request-validation/rate-limit/egress/shared-rules primitives, ported additively from an unrelated branch's V1/V3/V6/V7 guardrail work. See "The guardrail infrastructure port" below. |
| ~~`docs/away-from-demo-mode/`~~ | The second programme: Stages 1–7, 8.1–8.3, **8.4A** and 9 closed; 8.4 B/C and 10 remain. ⚠ **Its `VERIFICATION.md` was DELETED on 2026-08-04** as superseded. The reasoning survives in `DECISIONS.md` **D-30…D-45** and `ISSUES.md` **I-24…I-41**. |
| ~~`docs/canvas-and-sandbox/`~~ | **The third programme** — the DAG canvas and the sandbox. **ALL FIVE STAGES CLOSED** plus the authoring modes. ⚠ **Its `VERIFICATION.md` was DELETED on 2026-08-04** as superseded. The reasoning survives in `DECISIONS.md` **D-46…D-59** and `ISSUES.md` **I-42…I-60**. |
| `infra/docker-compose.yml` | server :4000/:4001 · web :4002 · mcp-bridge :4003 · **ops-api :4004** · Postgres :5433 · Kestra (**no port, and cannot have one**) · **`kestra-plugins`**, a one-shot loader on its own egress-only network. ⚠ **No Redis** — removed 2026-08-03 |
| `infra/kestra/plugins.txt` | **The declared plugin set — the record the image used to be** (D-139). Adding a plugin is a line here plus `pnpm kestra:plugins`; **no rebuild**. A removal needs a ledger entry or CI fails. See `docs/kestra-plugin-layer/EXECUTION.md`. |
| `docs/kestra-migration/` | **The programme.** Phases 0–4 and 6 are done; 5 is deliberately deferred. See below. |
| `docs/GAPS.md` | **Every known gap across all three programmes**, each labelled OPEN / DELIBERATE / UNPROVEN / UPSTREAM / **CLOSED** with its evidence. Read it before "fixing" anything that looks wrong — several entries are decisions, and the seven closed on 2026-08-03 are kept in place because several closed *narrower* than the original entry implied. |
| `docs/programmes/` | **The record for the three NEWEST programmes** — `ui-upgrade` (**D-74…D-112**, **I-67…I-102**), `platform-coherence` (**I-103…I-119**) and `breaking-2026-08-07`. ⚠ Restored here on 2026-08-10 from `git show HEAD:plans/…`; they had been deleted from the working tree and survived only in git history. **`docs/` is the durable home** — the spec gate always permits `docs/**`, where `plans/` is permitted only by the `*.md` rule. See "The three newest programmes" below. ⚠ **UNTRACKED as of 2026-08-18 — see the warning directly below this table.** |
| `plans/foundations-2026-08-10/` | **The CURRENT plan** — a three-mode automation builder. `findings.md` first (what is true), then `plan.md` (what to do), then the **eight** per-phase directories. Reserves **I-120…I-131** and **D-116…D-130**; has since taken up to **I-151 / D-139**. ⚠ **LOCAL-ONLY AND NOT IN GIT — see the warning directly below.** |
| `../Foundry-Harness/` | The Tether runtime. Separate compose, publishes :6800. **Unmodified** — its public API is in `../Foundry-Harness/API.md`; verify claims against that code before relying on them. |

`README.md` is an untouched template — ignore it.

⚠ **THE CURRENT PLAN IS NOT IN THIS REPOSITORY.** `plans/foundations-2026-08-10/` was moved out of
`docs/programmes/` on **2026-08-11** at the user's instruction and left **untracked** — `/plans` is
gitignored (`.gitignore:64`). **If you cloned this repo, that directory does not exist for you**, and
every `plans/foundations-2026-08-10/…` citation in this file and in source docblocks is a
programme-and-section label rather than a resolvable path — read them exactly as the
`../Foundry-Harness/plans/agent-step-run-contract.md` citations are already read.

Its last committed state is **`cd4387c`**, when it still lived under `docs/`:

```bash
git show cd4387c:docs/programmes/foundations-2026-08-10/plan.md          # read one file
git checkout cd4387c -- docs/programmes/foundations-2026-08-10/          # restore it all
```

⚠ **Future edits to the plan are not in git.** That exposure was stated before the move and accepted;
it is recorded here rather than left to be discovered. `docs/programmes/README.md` carries the fuller
note, including the argument the move went against — kept verbatim because it was overruled, not
withdrawn.

⚠ **THERE WAS A SEVENTH PROGRAMME — the UX upgrade, started 2026-09-01, CLOSED
2026-09-11.** `plans/ux-upgrade-2026-09-01/` — a 19-phase rebuild of the client against the
`ux-flow/` design handoff pack (10 docs, 14 flow files, 30 PNGs, **75 screens**), scoped by
the user to include the **backend**: new routes, services, tables and migrations, not a
design-language retrofit. **The programme record was removed 2026-09-11 along with the pack;**
the component-model rework superseded it, and the live record is now
`plans/workflow-ux-2026-09-11/PLAN.md`.

⚠ **BOTH the plan and its source pack were gitignored while live, and both are now gone.**
`/plans` at `.gitignore:64` and **`ux-flow/` at `.gitignore:17`** — so a fresh clone has neither the
programme nor the specification it was built from. The `/plans` half was **asked and answered
twice and the user confirmed it stays** on 2026-09-01; **do not raise it again and do not
`git mv` anything to `docs/` to "recover" them.** Read every `plans/ux-upgrade-2026-09-01/…` citation the
way this file already asks you to read `plans/foundations-2026-08-10/…` — a
programme-and-section label, **not a resolvable path**. Do not "fix" one by inventing the
file.

⚠ **Phase 0 is DONE and must never be repeated.** All 30 PNGs were read **once** and the
reading committed as 22 per-screen specs under `reference/screens/`, each with a fixed
structure and **verbatim copy**. That is the point of the phase: **no later phase opens an
image.** Tasks T0.4–T0.7 (the geometry table, the static HTML mockups, the gallery, the
coverage table) are **not** started. It reserves **`UX-001…`** for decisions and
**`UXI-001…`** for issues — deliberately outside this repo's `D-nn`/`I-nn` sequence, which
`issues.md` states.

⚠ **Two findings from that pass touch this repo rather than the pack.** The pack's per-kind
**task-type fallback table names six classes outside `FOUNDRY_EMITS`** (`transform.Filter`,
`notifications.mail.MailSend`, `core.output.OutputValues`, `core.execution.Exit` among
them) — rendering a task type the compiler cannot emit is a claim the runtime will not
honour (`UXI-003`). And the pack's approval model must **not** be allowed to swallow
`flow_approvals`: its `approval_requests` is a *queue*, ours is **revision-bound**, and
merging them loses the control that stops approve-once being a blank cheque.

⚠ **`docs/programmes/`, `docs/intent/`, `docs/ui-mock/` AND THE GUARDRAILS ROADMAP ARE ALSO
UNTRACKED NOW — 2026-08-18.** Asked for as *"docs needs to go into gitignore"*, and **scoped** rather
than applied to all of `docs/`: `docs/kestra-migration/` (the pinned design), `docs/GAPS.md`,
`docs/STANDARDS.md`, `docs/TEAM-WORKFLOW.md` and `docs/design/README.md` **stay in git**, so every
`docs/…` citation in this file and the 92 in code, scripts and CI still resolve, and
`ci/spec-policy.sh`'s `docs/*` exemption still means something. The five files that left were removed
with `git rm -r --cached`, so **their last tracked state is `c157947`**:

```bash
git show c157947:docs/programmes/README.md          # read one file
git checkout c157947 -- docs/programmes/            # restore it all
```

⚠ **This is the `plans/` exposure again, applied to the records that document it.** From that commit
on, edits to these four paths are not in git — the same trade stated and accepted for `plans/` on
2026-08-11, and the same one `docs/programmes/` was restored to `docs/` on 2026-08-10 to escape,
because records kept only in a gitignored directory had already been lost once. **The paragraph above
about `docs/` being the durable home is now true of the reference half only.** `.gitignore`'s docs
section carries the full note, including which paths must never be added to it.

⚠ **`docs/programmes/README.md` is the sharpest case** — this file states it is *"now the only copy of
that reasoning in the working tree"*. It is now also outside git. Do not delete it casually; recover
it from `c157947` if it goes.

⚠ **SIX programmes ran on this branch, and the sections below describe the first three.** This
paragraph said "three" until 2026-08-10 and the count is corrected rather than the sentence rewritten,
because the three it describes are the three the rest of this file is *about*. The Kestra migration
(below) came first; **away from demo mode** (Stages 1–7, 8.1–8.3 and 9) came after and changed several
things the migration sections still describe in the old shape — most sharply, `routes/stub-api.ts` and
`DEMO_MODE` no longer exist, and **Phase 5's deferral is partly spent** (Stage 7 built task 5.2 and an
authoring surface, not the editor). Then **the canvas-and-sandbox programme** (all five stages closed)
cleared every seeded flow, added a second domain, made a flow a DAG you can build, and put draft runs
on generated fixtures. Where they disagree, the later programme is newer. **Then three more ran, and
they are the newest of all — read the next section.**

### ⚠ The three newest programmes — this file does NOT describe them

⚠ **Their records were DELETED from the working tree on 2026-08-11** and live in git at **`5dfb959`**.
`docs/programmes/ARCHIVE.md` has the recovery commands and maps each programme to the `D-nn`/`I-nn` it
holds; `docs/programmes/README.md` keeps the load-bearing summaries and is **now the only copy of that
reasoning in the working tree**. Everything below this section predates them, so **where this file and one
of those records disagree, the record is newer.**

⚠ **CITATION CONVENTION, and it is repo-wide.** A path of the form `<programme>/<file>.md` where the
programme is **not** `foundations-2026-08-10` is an **archived** record, not a live path — 29 such
citations were rewritten on 2026-08-11 to drop the `docs/programmes/` prefix precisely so that none of
them names a file that is not there, and **13 of those are in source docblocks**. The same convention
already applied to bare `plans/…` citations, which `README.md` lists and which are **unrecoverable**.
**Read them as programme-and-section labels.** Do not "fix" one by inventing the document.

| Programme | Record | Holds | What it was |
| :--- | :--- | :--- | :--- |
| `ui-upgrade` | `ui-upgrade/` (`plan.md`, `checkpoint.md`, `decisions.md`, `issues.md`, `evidence.md`, `session-notes.md`) | **D-74…D-112** (39 entries) · **I-67…I-102** (36) | The client upgrade. **D-81 deleted `/home` for the third time** and made `/dashboard` the landing page — the bullet further down that restored `/home` is superseded by it. |
| `platform-coherence` | `platform-coherence/` (`findings.md` 882 lines, `plan.md` 441) | **I-103…I-119** | Making the drafter's advice true. Four criticals, each **reproduced from a real run**: **I-117** (a step's `body` is Foundry's envelope and every rule said otherwise), **I-118** (D-22's allowlist named three filters the engine does not have), **I-119** (a flow fed the model a *description* of the data instead of the data). |
| `breaking-2026-08-07` | `breaking-2026-08-07/` (`report.md` 505 lines, `plan-provider-and-scope.md`, four `measure-*.txt`) | — | The four `measure-*.txt` files are **raw `outline:measure` output**, kept as taken. ⚠ Its own report records that the investigation **destroyed its own evidence with `slate:clear`** (7 flows, 62 executions, 33 generation jobs). |

⚠ **Do not merge these into one file or into this one.** Three programmes with three stage-numbering
schemes; a reader who finds only a merged latest cannot tell which work belonged to which programme.
That is the same reasoning this file already applies to the three `/home` decisions. **The 2026-08-11
deletion did not merge them** — it removed the files and kept the summaries and the numbering ranges
separated by programme, in `README.md`.

⚠ **`mocks/` and `ui-upgrade-plan.md` were deleted with the rest.** They were the mockups and the
original brief the `ui-upgrade` decisions were taken **against**, kept until then because deleting the
mock a decision was taken against removes the evidence for the decision. That reasoning is why they are
named in `ARCHIVE.md` rather than simply dropped.

**Numbering is one repo-wide sequence and it is unbroken**: `docs/kestra-migration/progress/` ends at
D-73 / I-66, `ui-upgrade` runs to D-112, `platform-coherence` to I-119 and records *"Next free: I-120,
D-116"* — which is exactly what `plans/foundations-2026-08-10/` reserves. **Next free after that plan:
I-132, D-131.**

⚠ **Finance holds three real flows** (`scenarios:seed`) — see the Stage 3 section below.
The warning about a cleared slate below still applies to HR and to `slate:clear`.

⚠ **This deployment held ZERO flows and ZERO executions after Stage 1, deliberately.** Every flow that existed
was a harness fixture; `pnpm slate:clear` removed them and the matching Kestra state. Harnesses
re-create their own. **`showcase:verify` fails against a cleared deployment** — re-run
`showcase:seed` immediately before it (I-33), and expect `slate:clear` to remove those flows again.

⚠ **There are SEVEN product domains now** — HR, Finance, Legal, IT Operations, and (2026-09-04)
**Customer Support, Orders & Fulfilment and Recruitment**. `demo:verify` covers HR only;
`finance:verify`, `legal:verify` and `itops:verify` each cover their own domain *and* check its
named queries against its oracle. ⚠ This paragraph said THREE until 2026-09-03 and FOUR until
2026-09-04; see "The IT Operations domain" and "The three generic domains" near the end.

⚠ **The three newest have NO verify harness and no oracle, and that is a stated gap rather than an
oversight.** Their traps are resolved in the named queries and their demo flows are proven by
running both arms, but nothing scores a query against an independently computed answer the way
`financeOracle()` does. Never describe them as verified to the same standard as the four older ones.

---

## The client UI reconciliation (2026-08-05/06)

Branch `ui-restoration-old-app`, driven by `old-ui-restoration/old-ui-restoration.md`
(⚠ it lived in the gitignored `plans/` and was **restored to `docs/` on 2026-08-10** — the whole point
of that move is that `plans/` is gitignored, so a record kept only there is one `rm` from gone, which is
what happened. It was **deliberately not a spec-kit feature**: it created nothing under `specs/`, and no
`speckit-*` skill applies to it). The finding that shaped the work: the new
app's UI was never a new design — it is byte-identical to the old app's on every shared primitive,
layout, hook and config file (`tailwind.config.ts`, both layouts, `lib/hooks.ts`, all 11 `ui/*`
components diff at **0 lines**). So this was page-by-page structural reconciliation — old layouts,
navigation and copy restored on top of the new app's real data and behaviour — not a re-skin, and
not a rewrite. Five scope decisions (the plan's §8) drove the outcome:

- **`/virtual-tables` is removed** — no page, no nav entry, no `lib` helper; its subject
  (`listVirtualTables` et al.) has no server route.
- **`/apps` is back as a DECLARED PLACEHOLDER, not the old mock-backed page.** Literal rows in the
  page file itself, no `useAsync`/`fetch`/`foundryApi`/`localStorage`, and an on-screen banner
  stating it's a placeholder with nothing read from or written to the tenant — the property that
  makes it not a repeat of the deleted `faFallback` defect. `ui-honesty-check.sh`'s blanket
  "no apps page" assertion was replaced with four scoped checks that assert exactly this
  (`absent_code_in`/`present_code_in`, added for this); every other assertion is unchanged.
  `tools/page.tsx`'s own "apps" notion (labels derived from tool endpoint hosts) is a **separate,
  older thing** that this placeholder does not and should not match yet — both files say so.
- **`/home` is back** — see the corrected bullet in "The pre-deployment cleanup" below; the entry
  that used to say it was deleted forever is now marked superseded, not removed, so the history of
  *why* it was once deleted stays legible.
- **Flow URLs are unchanged** — `/flows`, `/flows/new`, `/flows/[id]`, `/runs/[id]` keep their
  paths; only the flows-list page's on-screen title changed to "My Automations" (old's name for
  the same concept). No redirects, no route renames.
- **The arm/disarm switch on the flows list follows the real approval gate** — off is a one-click
  `revokeFlowApproval` behind a confirmation, on routes into `/flows/[id]`'s `ApprovalPanel` rather
  than ever arming directly from the list row.

Every Class C new-only surface from the plan's §3 (`flows/new`'s wizard, `flows/[id]`, `runs/[id]`,
`approvals`, `ai-provider`, all of `components/flow/*` and `components/data/*`, `SignalsPanel`,
`MembersPanel`, `TriggerFires`) was kept and re-dressed in the old app's page grammar — none of it
was removed to make room for the restoration. `scripts/ui-honesty-check.sh` grew from 37 to **40**
assertions (the one approved `/apps` change above) and stays green; `pnpm --filter @foundry/server
e2e:ui` stayed **65 MATCH · 0 MISMATCH · 0 GAP · 5 NOTE · 0 FAIL** at both `2026-06` and `2026-05`
throughout, because the work never touched a server route. See `old-ui-restoration/old-ui-restoration.md` and
its per-phase `old-ui-restoration/phase-<N>-completion.md` files (0–9) for the full
record — restored there on 2026-08-10 from commit `03c2634`, along with the baseline, the progress log,
`ui-changes-2026-08-06.md` and `ui-migration-report.md`.

---

## ⚠ The Kestra migration

**Branch `kestra-migration`.** **Phases 0–4 and 6 are closed. Phase 5 (client authoring) is deliberately
deferred — read `progress/phase-5.md` before starting it; it says "do not build this yet" and names the
condition for un-deferring.** Read
[`docs/kestra-migration/progress/00-STATUS.md`](docs/kestra-migration/progress/00-STATUS.md)
**first** — it carries the current phase, resumption instructions, and links to:

| | |
| :--- | :--- |
| `docs/kestra-migration/01…10` | The **pinned design.** Implementation does not edit these. Start with `02-rules.md` (R1–R9), then `10-worked-example.md`. |
| `progress/ISSUES.md` | Every issue hit and the mitigation applied (`I-nn`) |
| `progress/DECISIONS.md` | Implementation-time decisions (`D-nn`) |
| `progress/phase-0…6.md` | Per-phase checklist, traps, exit criterion, work log |

**Phase 2 is done, and is where run visibility lives.** `GET /api/workspaces/:ws/flow-executions[/:id]`
→ `services/flow-visibility.service.ts` joins Kestra's state, graph and logs to Foundry's pointer rows
and returns a **redacted** step view; the UI is `components/flow/{StepGraph,StepStrip,StepDetail}.tsx`
and `app/(app)/runs/[id]`, fed live by `services/flow-progress.service.ts` over
`ws://…/ws/flow-execution`. Five things about it are load-bearing:

- **Redaction is server-side and stays there.** `begin`'s response body carries the execution token and
  Kestra persists task outputs (`DECISIONS.md` D-07). Redacting in the browser would be theatre — the
  token would already have crossed the wire. **Never add a path that fetches a raw execution.**
- **Read `engineStatus`, never `flow_executions.status`** (D-13). They legitimately disagree: Foundry's
  row is written by the flow's own `complete` task, so a failed run stays `running` for ever (I-10).
  A UI reading it shows a failed run as still going, and a poller on it never stops.
- **Executions are addressed by their Foundry id** (R5), so the read surface gives a client nothing to
  point at Kestra with. ⚠ **Two WRITE routes do leak engine addressing** and this was measured, not
  assumed: `POST …/test-run` returns `kestraExecutionId` *and* `namespace`, and `POST …/triggers/:tid/fire`
  returns `kestraExecutionId` (`ISSUES.md` I-22). The UI ignores both. Not exploitable today — Kestra
  publishes no port and `begin` reads the namespace from Kestra, never from a request (I-07) — but do not
  quote "clients are never given a Kestra id" as unqualified. Separately, an execution's **`flowId` is the
  Kestra slug, not Foundry's uuid** (I-23); see the `e2e:ui` section below before building on it.
- **The progress socket is authorised by a single-use ticket, and it has to be** (D-15). The browser
  never holds `PARENT_API_KEY` — `app/api/foundry/[...path]/route.ts` injects it server-side — and a
  WebSocket cannot use that proxy. `POST …/flow-executions/:id/watch` is API-key authenticated and
  mints a 60s, single-use ticket bound to one (workspace, execution). **Never add a socket that takes
  an execution id directly**; it would be the only unauthenticated read path in the product.
  `/runs/[id]` still falls back to polling, and both paths read the same server-side assembly.
- **A run that is still going is not a failed run** (D-14). `Run.outcome` has three values, and
  `lib/stats.ts` divides rates by **settled** runs. It used to be binary, so the dashboard counted
  in-flight work as an incident. Invisible while flows take ~1s; permanent once a Phase 4 `agent` step
  takes minutes.

**What it changes.** An automation stops being *prompt in, monolithic Python out* and becomes a
**flow of declared steps** in Kestra, where only steps that genuinely need generation get generated,
each from its own contract. The measured problem it exists to fix: **1 of 3 scripts achieved its
objective first-pass**, and one *"hardcoded `period="2023-10"`, emailed 0 of 11, and still exited 0
with `tests_passed=true` and audit `clean`."*

**Phase 1 was the falsifiable decision point, and it PASSED: 3 of 3 scenarios against their oracles,
at three periods.** Two caveats that must travel with that number — all three flows are **hand-written
with zero `code` steps**, so per-step *generation* is Phase 4's claim, not this one; and the original
three prompts are unrecoverable (`ISSUES.md` I-08), so "3 of 3 vs 1 of 3" is **not like-for-like**.
Read `progress/00-STATUS.md` before quoting it.

**Phase 3 is done, and is where the approval gate lives.** A flow is `flows` + immutable
`flow_revisions` + `flow_steps` + `flow_approvals`; `services/flow-compiler.service.ts` turns a model
into YAML, `flow.service.ts` owns the draft, `flow-approval.service.ts` owns the live namespace, and
the UI is `components/flow/{ApprovalPanel,RevisionDiff}.tsx` on `app/(app)/flows/[id]`.
`pnpm --filter @foundry/server kestra:phase3` re-proves all of it against the running engine. Six
things about it are load-bearing:

- **Approval binds to a REVISION, never to the flow.** Editing an approved flow would otherwise
  repoint an armed schedule at different behaviour — approve-once as a blank cheque, which is
  privilege escalation by editing. Revisions and steps are **insert-only**; approvals are closed by
  timestamp and never deleted.
- **`flow-approval.service.ts` is the only module that writes to the live namespace**, and
  `flow.service.ts` has no live branch at all. That is deliberate: "editing cannot change what the
  schedule runs" stays checkable by grepping for the caller instead of reading every path. **Do not
  add a live deploy anywhere else.**
- **The gate is structural, not a check.** A Kestra Schedule trigger is part of the flow definition,
  so approval *deploys* it and revoking *removes* it — never `disabled: true`, which is one accidental
  redeploy away from firing. `begin` re-checks approval + fingerprint on the live namespace as a second
  layer, and the **draft namespace is exempt** (a draft run is how gate 1 is satisfied in the first place).
- **The compiler is the sole YAML emitter (R8), and it landed a phase early** (`DECISIONS.md` D-16).
  Safe because task types and the one host are chosen by the compiler and free text is re-indented into
  a block scalar — not because of a blocklist. But **`paramsExpr` is an opaque string emitted verbatim**;
  it is safe only while models are Foundry-authored. Read D-16 before any client-facing route accepts one.
- **Staleness is per REF, not per manifest version** — a manifest bump touching nothing a flow uses
  must not suspend it (§6.5). The sweep runs on the surviving poll loop and **selects on
  `armed_revision IS NOT NULL`, never on `status`**: `status` becomes `draft_pending` the moment anyone
  edits an armed flow, and a sweep filtering on it silently covered almost nothing (`ISSUES.md` I-14).
- **The approver is NOT authenticated** (`ISSUES.md` I-13). One shared `PARENT_API_KEY`, no user model,
  so `approver_user_id` is self-asserted; self-approval is refused against the recorded author and that
  is all. **Never describe Phase 3 as enforcing separation of duties.** The revision binding is the
  control that holds.

A flow's cron lives on its **model**, not in a `triggers` row (`DECISIONS.md` D-18) — Foundry refuses
to create a `schedule` trigger for a flow, because that would be a second way to fire it on a timer
that no approval covers. Flow-bound `manual`/`poll`/`webhook` triggers fire the **approved live
revision or nothing**, and their inputs come from `triggers.config.inputs`, never from a webhook body.

**Phase 4 is done — runtime, generation and the deletions.** `pnpm --filter @foundry/server
kestra:phase4` runs 26 assertions against the engine. Six things about the RUNTIME are load-bearing;
generation has its own section below, and the deletions are listed after that.

- **V1 is answered: YES, at the task level.** `networkMode: none` on Kestra's Docker task runner, so
  R9 is *"a fragment cannot reach the network"*, not *"should not"*. Measured: `server:4000`
  gaierror, `1.1.1.1:53` OSError, `169.254.169.254` OSError, `postgres:5432` gaierror — **with a
  positive control** on `bridge` that connects, so the test discriminates. `kestra:phase4` flips the
  mode to run that control; **nothing in the product may set `KESTRA_FRAGMENT_NETWORK_MODE`.**
- **A `code` step is a function BODY, not a program** (`DECISIONS.md` D-19). The fragment defines
  `run(payload)`; a fixed compiler-emitted wrapper does all the I/O, checks the declared output keys
  **inside the container** before the value crosses back, and enforces the 1 MB cap (D-20 — one
  output channel, the cap as a named failure). So a fragment cannot pick an output channel,
  half-write one, or declare its own contract satisfied. **Do not let a fragment do its own I/O**;
  `validateFragment` rejects `print()` for exactly that reason.
- **`io.kestra.plugin.scripts.runner.docker.Docker`, never `…runner.process.Process`.** `Process`
  runs the fragment *in the Kestra container* — same filesystem, same network, same credentials as
  the engine. One word, and every containment property above disappears.
- **The fragment prompt is the contract and nothing else** (`step-contract.service.ts`). No
  automation goal, no manifest, no sibling step, no tool catalogue — each is a way for a pure
  function to reference something it cannot reach. `TASK` stays last, and here the payoff is that
  sibling fragments share a byte-identical prefix — which is what makes *"three code steps produced
  three independent generations"* checkable by diffing prompts. **A prompt offering only "produce
  code" is misconfigured**: the `insufficient_contract` refusal is the mitigation for the measured
  hardcoded-date failure, and a parser that read a status-less response as "ok" would delete it.
- **An agent step's wait lives in Kestra's DATABASE, not on a socket** (D-21). Two tasks: `<id>`
  starts the Tether run and returns, `<id>_await` is a `core.flow.Pause`. The poller's work list is a
  **query** (`tether_run_id IS NOT NULL AND resumed_at IS NULL`), which is what makes `reattachAll()`
  correct after a restart. `onResume` inputs must be posted **multipart** — Kestra accepts JSON with
  a 2xx and silently drops them.
- **`promptExpr` is an expression producing a JSON STRING, quotes included.** It reads like a place
  for free text and is not: interpolating rendered text into a JSON body is I-11, and it produced a
  body Kestra rejected with a 400 that named nothing.

### The monolithic path is DELETED (Phase 4, task 4.11)

Gone, not deprecated. If you find a reference to any of these, it is a leftover — do not restore it.

| Deleted | Replaced by |
| :--- | :--- |
| `services/script-generation.service.ts` | `services/flow-generation.service.ts` |
| `services/execution.service.ts` | Kestra's Docker task runner |
| `services/generation-audit.service.ts` + ~18 tests | Structural manifest compliance + R9 |
| `services/generation-events.ts` and the `/ws/generation` socket | — (see below) |
| `routes/scripts.ts` + `script`/`execution`/`test-result` repos | `routes/flows.ts` |
| The script branch of `trigger.service.ts` | Flow-bound triggers only |
| `requirements.txt` generation | One pinned base image, `foundry/fragment-base` |
| Tables `scripts`, `script_versions`, `execution_results`, `test_results` | `flows`, `flow_revisions`, `flow_executions`, `flow_step_runs` |
| `app/(app)/automations/**` + the script half of `lib/api.ts` | `/flows` |

**`generation-audit.service.ts` was deletable ONLY because `datasource` steps run named queries
rather than generated SQL.** If a generated-SQL step kind is ever introduced, resurrect the audit for
that kind alone — and keep its `attempted_write` negative tests, which exist because ordinary prose
(*"Rows to insert into the spreadsheet"*) otherwise matches.

**`/ws/generation` is worth knowing about because of what it was.** It streamed generation progress
and was authorised by **nothing** — `?scriptId=<uuid>` and you were subscribed. That is exactly the
shape D-15 refuses for flow progress; it was never made safe, it simply outlived its subject. The
one surviving channel redeems a single-use ticket from an API-key-authenticated route, and anything
added must do the same.

**Two test files were rewritten, not deleted, and they must stay that way.** `trigger-gate.test.ts`
now asserts the enable gate against flows, and the swap rehearsal's **P2** block now asks its
question of a fragment. Both subjects changed; neither property did. Deleting them would have been
the quiet option and iterating an empty table would have been worse — a test that passes over no
rows reads exactly like a test that passes.

### Generation, after the migration

`services/flow-generation.service.ts` is the whole path, and it is **two stages with deliberately
different visibility**:

- **`draftFlow()` — ONE call.** Sees the goal, the manifest and the callable catalogue; returns a
  flow of *declared* steps, and for each `code` step a **contract, not code**.
- **`generateFragments()` — one call PER `code` step.** Each sees `buildFragmentPrompt(contract)` and
  nothing else. Most steps are never generated at all: the five-step reference flow costs **three**
  inference calls, and the two that touch a credential contain no generated code.

Five things are load-bearing:

- **`outputKeys` is DERIVED from `contract.output`, never accepted from the drafter.** Accepting both
  lets a draft declare one contract and enforce another; the mismatch then surfaces as a
  `contract_violation` blaming the fragment for obeying the contract it was handed.
- **A refusal ends the loop immediately and is never retried** (§6.7). Re-asking is precisely how a
  correct `insufficient_contract` becomes an invented `period="2023-10"` on attempt 2. It returns
  **200** from `POST …/flows/generate` — filing the most useful diagnosis this system produces under
  "error" is how a client renders it as a failure and retries.
- **`InferenceClient.complete()` has no `sessionId`, and must not gain one** (`DECISIONS.md` D-23).
  Foundry's rule is *session = automation, run = version*; for fragments that is exactly wrong,
  because a session carries its history and fragment B's context would then contain fragment A's
  code — defeating the isolation *downstream of the prompt*, where no prompt test would see it.
- **Generated expressions are ALLOWLISTED before they reach the compiler** (D-22, and read it before
  touching `flow-expression.service.ts`). Five roots, **four** functions, everything else fails by
  name — so a Pebble builtin nobody here has heard of is rejected on the day it ships. ⚠ **It said
  "seven functions" until 2026-08-07 and three of the seven DID NOT EXIST** (**I-118**): `tostring`,
  `tonumber` and `not` are jq's vocabulary, not Pebble's, and the draft prompt offered all three by
  name — so the prompt taught a runtime failure and the control configured from the same list waved
  it through. A real user run died on `| tostring` after passing every static check. **Every name on
  that list has now been RUN against the engine; never add one from memory.** The check lives in
  `flowService.writeRevision`, the one function every revision passes through, **not** on the routes.
  This closes a hole that predates 4.10: `POST /flows` has accepted a client-supplied model since
  Phase 3, and `{{ secret(''FOUNDRY_CALLBACK'') }}` in a `paramsExpr` posts Kestra''s callback secret
  to a tool endpoint the tenant controls.
- **No secret is pushed anywhere.** The old path pushed credentials into an agent sandbox so a
  generated script could smoke-test, with a documented caveat about production keys. A fragment has
  no network and no credentials, so the exposure is gone rather than mitigated.

**MEASURED as of 2026-07-31, and the first measurement failed.** *Does a real model refuse rather
than invent?* — `pnpm --filter @foundry/server kestra:refusal`. **5 refused, 0 invented**, against a
control contract that produced clean code 5 of 5 (without which "refuses everything" scores 100%).

⚠ **Read `ISSUES.md` I-24 before quoting that.** The first run, through Tether, saw **0 refusals and
5 unparseable responses** — the model was refusing correctly every time and Foundry never saw it,
because every Tether run attaches the mandatory `script-gen` skill whose protocol adds turns *after*
the model answers, so `finalMessage` was the tail of a conversation rather than the answer. It failed
**asymmetrically**: a satisfiable contract answers on turn one and its JSON survives, so the transport
worked whenever the answer was yes. Generation now goes through `GatewayInference` (D-35); Tether
still runs `agent` steps. Five rounds on one model is a reading, not a property of the design.

⚠ **Stage 7 gave this a UI** — `/flows/new` → `…/flows/generate/jobs`, polled. The synchronous
`POST …/flows/generate` still exists and is what the harnesses use; both call one function
(`runGeneration`), so the refusal arm has one implementation. See D-38.

**Phase 6 is done — replay and sharing.** `pnpm --filter @foundry/server kestra:phase6` runs 70
assertions against the engine, green at two periods. Six things are load-bearing.

- **An import is a STRUCTURAL check, not a correctness one, and that is measured.** The exit criterion
  imports one bundle into the rehearsal tenant **twice**, against two named queries differing in exactly
  one `×100`: both import with **zero findings** and run green, and only one matches the alt oracle
  (`0.2` vs `20.00`). `refInterfaces()` proves every ref exists and every call signature matches. It
  cannot tell whether a tenant's query returns the same columns in the same **units**, and nothing but
  that tenant's oracle can. **Never describe an import as validating a flow.**
- **The CONTRACT travels; the code does not** (`DECISIONS.md` D-24). §5.2 says strip the code and does
  not say what replaces it — and "nothing" makes the flow permanently un-runnable, because
  `regenerateStep` refuses a step with no contract and the compiler rejects the placeholder. §5.2's
  *stated* reason for stripping ("a fragment generated against one schema is wrong against the other") is
  **false after Phase 4** — a fragment never sees a schema. Coupling moved into the named query and the
  contract, both tenant-local. `bundleStep` is an **allowlist per kind**, so a new `CodeStep` field does
  not travel until someone writes it down.
- **`refInterfaces()` is NOT `refFingerprints()`** (D-25). The fingerprint includes a query's `sql_text`
  by design (D-17), and across tenants the SQL is exactly what must differ — so comparing fingerprints at
  import reports "every ref changed" for two correctly-configured workspaces, a check that fires always
  and therefore says nothing. **Do not merge the two.**
- **A partial replay does not execute `begin`** (D-26), measured: the replay's row holds **zero**
  execution credentials of its own. `begin` is the approval gate, the credential mint and the row
  creation — so `flow-replay.service.ts` re-applies all three itself and **refuses** where it cannot.
  `full` replay is the safe default. A **succeeded** run can never be partially replayed (`complete`
  burns the credential) and the refusal says that rather than "expired". A partial replay past an
  `agent` step is refused outright — it would pause for ever (`ISSUES.md` I-18).
- **A client names a STEP, never a taskrun** (R5). §6.3's diagram ends `{taskRunId}`; the API takes
  `{ fromStepId }` and resolves it server-side. `downstreamOf` is computed from `dependsOn`, **never
  from ordinal position** — on a branching flow an ordinal version both refuses safe replays and permits
  hanging ones.
- **Templates and `fragment-candidates` are per workspace with no cross-workspace listing** (D-27). A
  template carries ref names and contracts written against one tenant's data; a promotion candidate
  quotes those contracts verbatim. A template is a **snapshot**, so a second save under an existing name
  is a 409, never an upsert — and instantiating one goes through `importFlow`, the same path a pasted
  bundle takes. **Do not add a second instantiation path.**

**Fragment promotion is a surfacing heuristic and must never be called a detector.** It groups `code`
steps by contract interface at each flow's **draft** revision only (all revisions would make the
most-iterated flow look like the most reusable), counts **distinct flows**, and reports every purpose
verbatim and unmerged. `distinctBodies: 1` across several flows is the strong signal; `shapeOnly: true`
means only the interface matched. The `caveat` is served **with the payload** because presenting a shape
coincidence as a finding is the failure mode here.

### Kestra operational facts

⚠ **THE DOCKERFILE IS NO LONGER THE RECORD OF WHAT IS INSTALLED — 2026-08-31, D-139.**
`infra/kestra/plugins.txt` is, and **adding a plugin no longer needs an image rebuild**. Plugins live
on the `kestra_plugins` volume, reconciled against that manifest by the `kestra-plugins` loader; the
image now carries **`plugin-script-python` alone**, as a bootstrap floor. The full record — seven
phases, five decisions, six issues — is
**[`docs/kestra-plugin-layer/EXECUTION.md`](docs/kestra-plugin-layer/EXECUTION.md)**, and the operating
procedure is `pnpm kestra:plugins`.

⚠ **THE PARAGRAPH BELOW IS AMENDED, NOT REWRITTEN, AND EVERY WORD OF THE I-05 REASONING STILL HOLDS.**
Two sentences of it are now false and are marked; the argument they sit inside is not, and it matters
*more* under a volume than it did under a Dockerfile — the friction that used to stop somebody adding
plugins by the dozen was the rebuild, and a text file is a far lower bar. What replaces that friction
is the manifest, the CI gate on it, and `kestra:check`'s class-count bound.

Built as **`foundry/kestra:v1.3.29-scripts`** from `infra/kestra/Dockerfile`, whose base is pinned
**`kestra/kestra:v1.3.29-no-plugins`**. Do not float the tag, and **do not drop `-no-plugins`**: the
full image registers 1404 plugins and **OOMs the engine** (`ISSUES.md` I-05). Every symptom presented
as *"healthy but every call hangs"*, and it died with exit 0 / `OOMKilled: false`, so the obvious
check said it was not memory. ⚠ **This paragraph said "adds back exactly one plugin" until 2026-08-10
and it has not been true since the platform-coherence programme.** ~~The Dockerfile adds back **seven
jars across six `RUN` layers**~~ — **FALSE SINCE 2026-08-31**: it adds back **one**, and the other six
(`plugin-slack:1.3.0` + `plugin-email:1.3.1`, `plugin-serdes:1.3.5`, `plugin-azure:1.3.1`,
`plugin-aws:1.3.0`, `plugin-git:1.3.3`) are declared in `plugins.txt` and installed onto the volume by
the loader. The one that remains is `plugin-script-python:**1.3.1**` (the fragment runner) — ⚠ **and it
is a floor, NOT a second authority**: the manifest still declares it and the loader **refuses** a
manifest that does not, so there is one authority and a floor beneath it. Plugin artefacts do **not**
track the engine's patch version, so `…:1.3.29` is a 404 and every version above is one resolved
against Maven Central by hand. The Docker task *runner* is already in core.

**Every word of the `-no-plugins` / I-05 reasoning above still holds, and the count being wrong does
not soften it.** I-05's OOM was **1404** plugins; this is seven jars — one baked, six on the volume —
which is a different order of magnitude rather than a smaller amount of the same risk. ⚠ **The set is
still seven; only where they live changed.** Re-measured on a fresh boot after the 2026-08-31 trim:
**464 MiB / 3 GiB (15%)**, with the same caveat written down beside it — that reading and the older
811 MiB one are **not comparable** (a days-old JVM holds garbage it has not been pressured to
collect), so it is a floor and not a budget.

⚠ **Registering a group is not the same as offering it, and moving them onto a volume changed nothing
about that.** All seven contribute **zero emittable step types** — `flow-compiler.service.ts` is the
sole YAML emitter (R8) and emits **eight** `core.*` / `scripts.*` classes (⚠ this said *seven* until
2026-08-31; `FOUNDRY_EMITS` has held eight since `core.flow.If` was added, and the number is **read
from that array by a test**, so trust the array and not this sentence), none of them from these jars,
so `/apps` correctly reads "0 of N" on every non-core card. Making one usable is Phase 4 of `plans/foundations-2026-08-10/`, and its blocker is a
server-side capability allowlist plus the credential question (D-124), not the install.

- ⚠ **Phase 4's plugin pass-through work (added 2026-08-11 as a separate Phase 7 and MERGED into
  `phase-4-plugins/` the same day) is how that stops being true, and the
  measurement that unlocked it is worth knowing on its own: THE ENGINE SELF-DESCRIBES.**
  `GET {KESTRA_BASE_URL}/api/v1/plugins/{cls}` → **200** with a JSON Schema of the task's own
  properties, their types and their human descriptions, plus `schema.outputs`. So allowing a capability
  costs **a row, not a template** (**D-138**) — the shape is derived; only *which fields are secret* and
  *which are required* are declared, because the schema answers neither (`required` came back **`[]`**
  for a class whose `url` is mandatory, and `url` is a credential for a Slack webhook and not for a
  generic HTTP call — deriving sensitivity from a field name is **I-121**'s exact failure).
  - ⚠ **The path is NOT under `/main`** — every other Kestra call in `kestra-client.service.ts` is, so
    the consistent spelling 404s, and against a registry where `reachable` is false everywhere that
    reads as *"the jars are not installed"* (**I-150**). And a class name **cannot be constructed** from
    its group: `io.kestra.plugin.slack.SlackIncomingWebhook` is a 404,
    `…slack.notifications.SlackIncomingWebhook` is the real one (**I-151**). Take `cls` from the registry.
  - **D-137** answers the credential question differently from D-124 **without retracting it**: inject at
    the **egress**, so the credential never enters Kestra and the plugin executes as itself. D-124's four
    rejections all stand — they are about the secret landing somewhere Kestra persists or displays, and
    this one does not. ⚠ **Its cost is that the execution token stops "granting nothing on its own" (R3)**,
    and task 7.4 exists to change every place that says so *in the same commit*.
  - ⚠ **It preserves the network posture rather than trading it.** A plugin dialling out directly would
    need Kestra's egress opened, discarding the three denials `kestra:check` asserts. Proxying does not.
  - ⚠ **`serdes`, `aws`, `azure` and `git` stay unavailable after that work lands** — their outputs are Kestra
    internal-storage URIs nothing in the product can read (I-128), an R5/R6 question. **"All 267 classes
    become available" is the wrong summary.**

⚠ **The counts disagree across three places and one is a double count (I-129).** The Dockerfile's own
comments say "6 jars / 253 registered classes" in one paragraph and "8 plugins · 214 task classes" in
the next; the engine answers **327 distinct classes** to `GET /api/v1/plugins`, of which **18** are
`core.flow`. **Measure it, do not quote any of them.**

`code` step fragments run in **`foundry/fragment-base:py3.12-pandas2.2.3`** (O2), built from
`infra/fragment-base/Dockerfile` with a digest-pinned base and **by the compose stack** — a one-shot
`fragment-base` service that `kestra` depends on (D-29). It used to be built only by a `docker build`
line in a comment, and the failure that caused is worth remembering: a fresh host came up **entirely
green** — compose healthy, `kestra:check` passing, the engine serving — and then every `code` step died
at execution with an image-not-found, after approval, mid-run (`ISSUES.md` I-21). `kestra:check` now
asserts the image is present on the **host** daemon, because fragments are sibling containers. The tag
names both versions on purpose: every existing fragment was generated against that import set, so
**bump it, never re-point it**. It runs as **root**, and that is forced, not lazy — Kestra stages the
script mode 600 owned by root and a non-root image cannot read it. What contains a fragment is
`networkMode: none`, no credentials, no volumes and an ephemeral container.

**The API server holds no Docker socket, and its image has no Docker CLI** (`DECISIONS.md` D-28). Both
existed for `execution.service.ts`, which Phase 4 deleted; nothing in `packages/server` spawns a
subprocess of any kind now, which one grep confirms. Kestra is the sole holder — not client-reachable
(R5), emitting only compiler-chosen task types (R8). `kestra:check` fails if the mount comes back, so
the next "the server just needs to run one container" is a failing check rather than a passing review.
Ports are one block: **4000** API · **4001** WS · **4002** web · **4003** mcp-bridge · **4004**
ops-api. Postgres keeps its `+1` offset (**5433**) and that is load-bearing — registered datasources
hold an encrypted DSN naming `host.docker.internal:5433` and `demo:reset` does not re-register.
⚠ **Redis and 6380 are gone** (2026-08-03) — see the Redis note further down.

```bash
pnpm --filter @foundry/server slate:plan       # what a fresh slate would delete — DRY RUN
pnpm --filter @foundry/server slate:clear --yes # every flow + run, Foundry AND Kestra. No undo.
pnpm --filter @foundry/server finance:seed     # the Finance workspace + finance_demo
pnpm --filter @foundry/server finance:verify   # its traps, AND every named query vs its oracle
pnpm --filter @foundry/server legal:seed       # the Legal workspace + legal_demo (contract lifecycle)
pnpm --filter @foundry/server legal:verify     # its 9 traps, AND every named query vs its oracle, at 3 dates
pnpm --filter @foundry/server itops:seed       # itops_demo + the IT Operations workspace
pnpm --filter @foundry/server itops:verify     # its 8 traps, AND every named query vs its oracle, at 4 instants
./scripts/harness-in-net.sh <path/to/harness.ts>  # run a Kestra-touching harness from INSIDE the compose networks
pnpm --filter @foundry/server itops:scenarios        # the 2 IT Ops flows: author -> run -> arm  (needs the runner above)
pnpm --filter @foundry/server itops:scenarios-verify # DID THE RIGHT ARM FIRE? (needs the runner above)
pnpm kestra:check                              # 29 boundary assertions — after ANY infra change
pnpm kestra:plugins                            # apply plugins.txt: reconcile, restart if needed, verify
pnpm kestra:plugins --dry-run                  # what would change, changing nothing
ci/check-plugin-manifest.sh <base>..<head>     # the manifest gate CI runs — a removal needs a ledger entry
pnpm kestra:ui                                 # UI url + credentials
pnpm backup                                    # STOPS the writers, dumps the whole state surface
pnpm backup:verify                             # restores it beside the live DBs and compares
pnpm restore <dir> --suffix s | --force        # never both, never neither
pnpm --filter @foundry/server kestra:prove     # deploy 3 flows, execute, score vs the oracles
pnpm --filter @foundry/server kestra:verify    # assertions 6, 7, 28, V2, O4
pnpm --filter @foundry/server kestra:phase3    # the approval gate: 10, 11, 12, 13, 25
pnpm --filter @foundry/server kestra:phase4    # code + agent steps: 20, 21, 22, 24 (V1), 26, M2
pnpm --filter @foundry/server kestra:phase6    # replay + export/import, WITH the 0-1 negative control
pnpm --filter @foundry/server kestra:system    # deploy foundry.system/retention (O4)
pnpm --filter @foundry/server kestra:hitl      # gate 3 — pause, approve, reject-kills
pnpm --filter @foundry/server kestra:retry     # runtime retry, 22 assertions, with the no-retry control
pnpm --filter @foundry/server kestra:refusal   # does a real model refuse rather than invent? A MEASUREMENT
pnpm --filter @foundry/server showcase:seed    # six clickable flows, one per capability
pnpm --filter @foundry/server showcase:verify  # every showcase description, checked (22)
pnpm --filter @foundry/server e2e:ui           # the UI's journey over HTTP → progress/e2e-ui-journey.md
pnpm --filter @foundry/server scenarios:seed   # the three REAL Finance flows: author → run → arm
pnpm --filter @foundry/server scenarios:verify # each one scored against financeOracle() (13 / 14)
pnpm --filter @foundry/server outline:measure  # does a real model keep the shape it was given? A MEASUREMENT
pnpm --filter @foundry/server draft:measure    # where does a draft's time GO? attempts, seconds, and WHY. A MEASUREMENT
pnpm --filter @foundry/server kestra:canvas    # the editable canvas's controls, each PLANTED and proven to fire
pnpm --filter @foundry/server sandbox:status   # per datasource: does a DRAFT run read fixtures, or production?
pnpm --filter @foundry/server sandbox:provision --workspace=<id> --datasource=<name>
pnpm --filter @foundry/server sandbox:rebuild  # re-materialise from the FROZEN fixture — no model
pnpm --filter @foundry/server kestra:sandbox   # draft reads fixtures, live reads production — from the executed SQL
pnpm --filter @foundry/server kestra:expect    # a flow's claims about its own output, and gate 1 checking them
pnpm --filter @foundry/server signals         # the four silent-failure signals; exit 1 = warn, 2 = unreadable
```

`kestra:prove`, `kestra:phase3` and `kestra:phase6` take `--period=YYYY-MM`. **Run them at more than one
period** — three real bugs (I-09, I-10, I-20) were invisible at `2026-06` and appeared immediately at
`2026-05`. The HR dataset flags **11** employees at `2026-06` and **zero** at `2026-04`/`2026-05`: its
traps are tuned to the reporting month, so a second period is also the only run that exercises the empty
case.

- Kestra's **only** network is `internal: true`. No route to the internet, cloud metadata, Tether or
  **ops-api**. It reaches exactly two things: Foundry `:4000` and its own database. It also mounts
  `/var/run/docker.sock` — a unix socket, not a network route, so that boundary still holds — because
  `code` steps run as **sibling** containers on the host daemon.
- **The Kestra working directory must be the SAME ABSOLUTE PATH inside the container and on the
  host** (`ISSUES.md` I-15). Sibling containers mean the daemon resolves Kestra's paths against the
  *host* filesystem, and Docker creates a missing bind source **as a directory** — so the failure is
  `python: [Errno 13] Permission denied` on a script that plainly exists, which reads as a uid
  problem and is not. Snap Docker makes it worse twice: its daemon has a private `/tmp` (so Kestra's
  own DinD instructions bind the wrong directory) and it remaps `$HOME`. `kestra:check` asserts this
  **by round trip**, because comparing the path strings passes while they point at different places.
- It therefore **cannot publish ports** — Docker discards the stanza silently. The UI is reached at
  the container IP, which changes on recreate; hence `pnpm kestra:ui`. Re-adding `ports:` fails
  `kestra:check`.
- **`kestra-ui` is for internal engineers only.** No tenant isolation, and it is Kestra-branded.
  Never proxy it, never iframe it, never give a client the URL.
- Kestra connects as a dedicated **`kestra` role** reaching only the `kestra` database — not the
  `foundry` superuser, which would put `workspace_secrets` one query away and make the step API
  optional. See `ISSUES.md` I-04.
- **`POST /api/executions/begin` reads the namespace FROM KESTRA, never from the request body.** The
  body's value is only cross-checked. Validating it instead — parse, then look up, then 403 if it does
  not resolve — reads as authorisation and is not: a real *other* workspace's namespace parses and
  resolves fine, and `begin` handed over that workspace's token. See `ISSUES.md` I-07. It fails closed:
  unknown execution → 403, Kestra unreachable → 503, never a fallback to the body.
  ⚠ That 503 was **untrue at the wire until 2026-08-01** (**I-51**): `errorHandler` honoured
  `statusCode` only in the 4xx range, so every deliberate 5xx a service threw — 502 from
  `testRun` and `assertKestraAccepts`, 503 here — arrived as a **500**. The message survived
  and the status did not, which is the wrong half to lose. Fixed and pinned by
  `middleware/error.middleware.test.ts`; **do not narrow that branch back to 4xx**.
- **A failed execution does not release its M3 budget slot on its own** — `complete` is a task in the
  flow, so a failure never reaches it. `begin` reconciles `running` rows against Kestra before refusing
  a run. Without that, five failures brick a workspace via a *fairness* control (I-10).
- **`foundry.system` is the operational namespace**, and it has only two segments. Three are required
  to resolve a workspace, so a system flow can never obtain an execution token even though it runs on
  the same instance with the same callback secret. `namespaceFor()` therefore rejects `system` as a
  tenant slug. See `DECISIONS.md` D-09.
- **Retention is a scheduled flow, not a config setting** — Kestra OSS has no `kestra.retention.*`.
  30 days, nightly, `KESTRA_RETENTION_DAYS` / `KESTRA_PURGE_CRON`, read through
  `config.kestra.retentionDays` by both the retention flow and replay's 410 message — two independent
  defaults would eventually promise 30 days while purging at 7. **That number is the replay window**:
  replay needs the engine's copy of the upstream step outputs, and Foundry keeps the pointer, not the
  data (R6). Terminal states only: purging a `PAUSED` execution destroys a live human approval.
- **`/executions/search` returns the OLDEST page by default** (I-12). Always pass
  `sort=state.startDate:desc` — plain `startDate` is rejected `422 Invalid sort field`. This is
  already in `listExecutions`; the trap is writing a new query without it. It fails *silently and
  late*: correct while the instance holds fewer executions than the page size, then joins against a
  window with no overlap. A degrade-gracefully catch around a Kestra call must **log** what it
  degraded from, or this class of bug presents as "the field is just null sometimes".
- **Kestra templating has two silent traps** (I-11), and the Phase 5 compiler will hit both. Pebble does
  not re-evaluate `{{ }}` inside a filter argument — use `~` to concatenate. And `| first` unwraps a jq
  *string* into a raw string, so **never interpolate a rendered string into a JSON body**; build the
  JSON value in jq and interpolate that.
- Host-run scripts get their Kestra env from `scripts/kestra-env.sh`, which reads it out of the running
  server container rather than duplicating the secrets (`DECISIONS.md` D-11).
- Basic auth is **mandatory** in Kestra OSS ≥0.24 and the username **must be an email**. A bare word
  is rejected *silently* — clean boot, no log line, every API call 401s. See `ISSUES.md` I-02.

---

## ⚠ The second programme — away from demo mode (1–7, 8.1–8.3, 8.4A, 9 CLOSED — 8.4 B/C and 10 remain)

⚠ Its `VERIFICATION.md` was **deleted on 2026-08-04** as superseded; what survives is
`DECISIONS.md` **D-30…D-42** and `ISSUES.md` **I-24…I-34**, and they are now the record. It ran on the same branch after
the Kestra migration and changed things the migration docs above still describe in the old shape.

| Stage | What changed | Read |
| :--- | :--- | :--- |
| 1 | The client's **localStorage mock database and `faFallback` are deleted** | D-30 |
| 2 | **Named queries have HTTP routes**; a showcase workspace with one flow per capability | — |
| 3 | **`approval` is a step kind** — gate 3 exists | D-31 |
| 4 | **Runtime retry** — the compiler emits `retry:` | D-32 |
| 5 | **The tool layer left the parent process** → `packages/ops-api` on :4004 | D-33 |
| 6a | **`llm_complete`** — a text tool a flow can call, with a configurable provider | D-34 |
| 6b | Tether measured — and the **refusal channel was being destroyed by the transport** | **I-24**, D-35, D-36 |
| 7 | **A flow can be authored from a browser** — `/flows/new`, the caps, the review surface | D-37, D-38, I-31 |
| 8.1–8.3 | **An agent's question reaches a person**; one Tether tenant per workspace | D-41, D-42, **I-34** |
| 9 | **Identity stopped being discarded**, and a tenant datasource must be read-only | D-39, D-40, I-32, I-33 |

Six things are load-bearing and are the ones most likely to be contradicted by an older paragraph
further down this file.

- **`faFallback` returned fabricated rows on any server error**, logging a `console.warn`. In a demo
  you could not tell the product from a browser cache. `scripts/ui-honesty-check.sh` (now 37 assertions)
  guards its absence, including that **every `useAsync` consumer reads `error`** — a page that cannot
  report failure renders an empty list instead, which is the same lie with fewer steps.
  ⚠ `manifest-builder.service.ts` emits a **hardcoded `isDummy: false`** and the manifest keeps
  `kind="real"`: that key is inside `refFingerprints()`'s hash, so dropping it would have suspended
  every armed flow in every workspace. **Do not tidy it away.**
- **Gate 3 is a step, and placement is the mechanism.** Kestra runs tasks in emission order, so a gate
  emitted before the send makes the send unreachable. Rejecting **kills** the run rather than resuming
  it with a "no" — resuming would execute the send. `onResume` must be posted **multipart** (D-21).
  The approver is still self-asserted (I-13): **never** call gate 3 separation of duties either.
- **Retry is opt-in per step and refused for `agent`/`approval`/`transform`.** What makes `tool` safe
  is that `stepExecutionService.tool` throws only when EVERY item failed, so "7 of 10 sent, retry
  sends all 10 again" is structurally impossible. ⚠ The residual is stated, not hidden: a call whose
  *response* was lost had its effect. `CREATE_NEW_EXECUTION` must never appear in the emitter — it
  would mint a second execution token and M3 slot per attempt; `kestra:check` asserts that.
- **ops-api holds no control-plane credential and the parent holds no ops database credential.** The
  parent reads four named record sets over HTTP with the root key; there is no path from it to
  arbitrary SQL. `ops_ro` is a **second** read-only role, deliberately not `foundry_ro`, so revoking
  the script credential in an incident does not take the tool layer down.
- **`llm_complete`'s output is TERMINAL, never load-bearing** (D-34). Not "reported vs decided" — a
  summary often *is* the deliverable. The line is whether anything downstream **consumes** it. No JSON
  mode, no structured output. It earned the rule on its first real run: a digest whose figures were all
  correct ranked two departments in an order its own numbers contradicted.
- **Generation no longer goes through Tether** (D-35, caused by I-24). Tether runs `agent` steps;
  `InferenceClient` speaks to a completion endpoint. ⚠ **Runtime and generation inference must not be
  merged** — different credentials, different processes, no shared abstraction.
  ⚠ **STRUCTURAL AS OF 2026-08-10 (task 1.8, D-116) — the qualification that stood here is GONE, and
  what it warned about is now impossible rather than merely not happening.** It read *"that first
  sentence is a property of THIS DEPLOYMENT'S CONFIG, not of the code"*: `TetherInference` existed,
  `ResolvingInference.complete` began `if (!usesGateway()) return this.tether.complete(...)`, and the
  only thing between an unset `LLM_BASE_URL` and a silent return of I-24 was a boot `console.warn`.
  **A warning is not a control.** Now: `TetherInference` is deleted, `ResolvingInference` is
  gateway-only with no branch, and `LLM_BASE_URL`/`LLM_API_KEY` are `required()` in `config/index.ts`
  — so a deployment that would generate through the agent runtime **cannot boot**.
  - ⚠ **Required in `config`, deliberately not asserted at the server entry point.** Every `kestra:*`
    harness and every `demo:*`/`finance:*` provisioner imports these services directly and never runs
    `index.ts`, so an entry-point check would leave exactly the processes that *measure* generation
    calling a gateway with an empty base URL.
  - The control is `config/inference-required.test.ts`, and it is a **perturbation** rather than a
    claim: it blanks each variable and requires the module to throw, with a control that the module
    loads cleanly when both are set — proven to fire by reverting `required()`. ⚠ It sets the variable
    to the **empty string** rather than `delete`-ing it, because `config` loads the repo-root `.env`
    itself and dotenv would put a deleted key straight back; `delete` reads more naturally and is the
    version that cannot fail.

**Stage 7 — a flow can be authored from a browser.** `/flows/new` types a goal;
`components/flow/FlowReview.tsx` on `/flows/[id]` reviews the result and makes the narrow edits.
Five things are load-bearing:

- **The caps live in `flowService.writeRevision`, beside D-22's expression allowlist** (D-37) — the
  one function every revision passes through, so a new route cannot forget them. Step, per-kind,
  **total pause budget** and model size, plus tenant-scoped **ref validation** whose finding carries
  the workspace's actual ref list. ⚠ Two of task 5.2's four caps are deliberately elsewhere or absent:
  **fan-out cannot be checked statically** (the cap is `stepBatchSchema.params.max(1000)`, pinned by a
  test in the validator's own file), and **subflow depth has no subject** — there is no `subflow` kind.
- **A refusal is a 200, its own terminal status, and its screen has NO Retry button** (D-38). The
  "design it again" button is disabled until the goal actually changes: a button that resubmits the
  identical sentence is a Retry with a different label, and re-asking is how a correct
  `insufficient_contract` becomes an invented `period="2023-10"` on attempt 2 (§6.7).
- **Generation is a polled job, not a socket.** `…/flows/generate/jobs` + `flow_generation_jobs`.
  `/ws/generation` did this and was authorised by nothing; a socket here would owe a single-use ticket
  (D-15) and polling needs no new auth surface. The synchronous route still exists and **both call
  `runGeneration`**, so the refusal arm has one implementation.
- **Editing must not disarm a `code` step** (I-31). `saveRevision` inherits stored contracts for steps
  that survive; `POST /:flowId/revisions` passed none, so the first edit through it left every
  fragment un-regenerable and the symptom appeared one action later as `no_contract`.
- **Gate 3 is added by SPLICING, never appending.** `FlowReview` inserts the `approval` step
  immediately before its target and repoints the target at it. Kestra runs tasks in emission order, so
  a gate at the end satisfies every assertion about a pause and stops no email.

⚠ **This paragraph is SUPERSEDED — Programme 3 Stage 5 closed it, and not the way it warned against.**
It used to read *"`POST /workspaces/:ws/flows` is still a GAP and stays one … a `createFlow` taking
arbitrary JSON would be a step palette by another route."* There is a step palette now, and there is
still no `createFlow`: a canvas-authored flow is posted as **`authored`** to the generation route and
goes through `authorFlow`, which is the drafter's own parse, allowlist, `splitDraft` and
`validateModel`. See D-49 and the third-programme section below.

**Stage 8.1–8.3 — the agent step grows up.** Four things are load-bearing:

- **An agent's question is an APPROVAL ROW, not a second pause** (D-41). `awaiting_input` was on
  `RunContract`'s union and absent from the poller's `TERMINAL` set, so a run that asked was polled
  for 45 minutes and resumed Kestra with a **failure**. The agent step's Pause is *already open*; a
  question just needs a person, so it lands in gate 3's inbox with `flow_step_approvals.kind =
  "question"`. Answering posts to **Tether**, not to Kestra. Declining fails **that step**, unlike a
  gate rejection which kills the execution. ⚠ **Never add `awaiting_input` to `TERMINAL`** — that is
  the one-line "fix" and it resumes the flow while the agent is still parked.
- **The agent's tenant is RESOLVED, never read** (D-42). `agentRuntimeService.resolveKey()` returns
  `{ key, shared, secretName }` — not a bare string, because `shared` is the whole mechanism by
  which a workspace on the fallback says so. `kestra:check` asserts `TETHER_API_KEY` is read in
  exactly three files; a fourth reader would work perfectly and report nothing.
- ⚠ **`profileId` buys NEITHER a speed-up NOR protection, and I-34 is the record — read round 3.**
  The speed-up was measured away first (12.1 s with vs 10.5 s without; the profile arm is marginally
  *slower*). Then instrumenting Tether withdrew the rest: the contaminating turn fires **27 of 27**
  runs, **both arms**, and the refusal lands **once in each**. The original 8/8-vs-4/6 was a six-run
  arm on a ~10% coin. `profileId` stays because chat mode is the honest declaration and it is where
  `expects` will hang — **never quote it as suppressing `script-gen`.**
- **8.4 is COMPLETE — A on 2026-07-31, B and C on 2026-08-03** (see "The Tether changes" below).
  `../Foundry-Harness/` is therefore no longer unmodified, in two commits.
- **8.4 part A was the first of them.** 29 lines in
  `agent-backend/server.js`, no API change. The defect was not the status field — every agent run
  already returns `needs_review` — it was `HeadlessSocket._ensureAssistant()` **overwriting the
  agent's answer in place** when Tether adds its own turn afterwards. See the "one Tether change"
  section below and `../Foundry-Harness/plans/agent-step-run-contract.md`. **B and C are now built
  too** — `expects: "script" | "answer"` on `POST /api/run`, defaulting to today's behaviour.

**Stage 9 — the identity exists at the API, and a tenant datasource must be read-only.** Four things
are load-bearing:

- **Two secrets, and `kestra:check` asserts they differ** (D-39). `PARENT_API_KEY` authorises a
  *request*; `RUNTIME_JWT_SECRET` attests a *person*. The proxy forwards the token `src/auth.ts` was
  already minting, as `x-foundry-identity` — never `authorization`, which `requireApiKey` also reads.
  **Say "holding the API key no longer lets you name a person", which is measured; never
  "authenticated user"**, because anything holding the signing secret can mint one and `e2e:ui` does.
- **Identity is resolved globally and required per ROUTE.** Kestra's step callbacks and every harness
  hold the key and no session, so a blanket requirement breaks the engine. ⚠ **A present-but-invalid
  token is a 401, never treated as absent** — the fallback would record an approval attributed to
  nobody, which is worse than before because the field now looks verified.
- ⚠ **There ARE roles now** (D-67, GAPS §1.1) **and it is STILL not separation of duties.**
  `workspace_members` — `author`/`approver`/`admin`, keyed on the identity **subject** — and
  `requireWorkspaceRole("approver")` guards approve, revoke and gate 3's decide. Say *"a person who
  has not been granted the approver role in this workspace cannot approve in it"*; never the
  unqualified phrase, because anything holding `RUNTIME_JWT_SECRET` mints an identity and a minted
  identity with an approver row approves.
  - ⚠ **Every existing workspace has ZERO members and refuses approvals until a SUPER ADMIN assigns
    somebody.** Migration 0027 backfills nothing on purpose: backfilling admins grants the role to
    everybody, *"no members ⇒ allow"* turns the control off wherever it was never configured, and
    *"first approver becomes admin"* grants it to whoever arrives.
  - ⚠ **`POST …/members/claim` IS DELETED (2026-08-20).** It was the bootstrap — identity-only, first
    caller becomes admin, refused once the workspace had any member — and its stated cost is what
    removed it: *on a deployment where anyone can sign in, whoever claims first owns it*. See "The
    super-admin workspace assignment" at the end of this file. `granted_by = 'bootstrap'` rows still
    exist and the badge explaining them **must keep working**.
  - ⚠ **The check is at the ROUTE, not in the approval services**, because it needs `req.user` and a
    harness has none — in the service it would be satisfied by a constant or break every harness.
    A test reads the route tree for it, **and a second test asserts that scan finds the call sites
    at all**, so a rename cannot leave it scanning nothing.
  - **The last admin cannot be demoted or removed** — a workspace with members and no admin can
    never grant again, and `claim` refuses it too.
  - ⚠ **§1.1b and §1.2b are CLOSED as of 2026-08-04** (D-70, D-69) and this paragraph used to say
    they were open. Gate 3 now has a run requester to compare a decider against, and an unattested
    revision now needs an `admin` rather than an `approver`. Both live at the **route** for the same
    reason this role check does, and neither makes any of it separation of duties.
  - The self-approval refusal is still verified on the approver side only — `created_by` is
    self-asserted whenever a revision came from a harness, a seed, an import or the drafter
    (**I-32**), which is what `created_by_kind` records (D-60).
- **A registered datasource is refused if it can write** (D-40), tested by the **absent grant** and
  never by `default_transaction_read_only` (I-27) — there is a test that an owner DSN *asking* for a
  read-only session is still refused. Catalogue reads via `has_*_privilege`, so grants held through
  `PUBLIC` count; no trial write, which would insert a row into a customer's database in exactly the
  case being detected. Unreachable ⇒ refuse. Only `postgres`/`mysql`, which is the whole write path.

⚠ **Re-run `showcase:seed` immediately before `showcase:verify`** (**I-33**). Other harnesses author,
arm and revoke flows in the same workspace on the same engine, and a stale fixture presents as a
product claim being false.

**Two harnesses are honesty-shaped rather than gate-shaped, and that is deliberate.**
`showcase:verify` (22 assertions, two periods) checks the **claim each showcase description makes** —
the oracle's list rather than a green run, and gate 1 asserted *satisfied* before the 403 so the
refusal is genuinely gate 2. `kestra:refusal` is a **measurement**: it exits non-zero only if the
harness could not run or the control failed, because a refusal rate is a number to read, not a
boolean to go green on.

---

## The UI-path journey test — `e2e:ui`

`pnpm --filter @foundry/server e2e:ui` → `docs/kestra-migration/progress/e2e-ui-journey.md`. Every call
the client makes to author, dry-run and production-run a flow, with **intended behaviour beside real
behaviour** per step. **65 MATCH · 0 MISMATCH · 0 GAP · 5 NOTE · 0 FAIL** as of 2026-08-04, at both
periods — clean since 2026-08-03; phase 5d (expectations, GAPS §2.3) added the last five. The first
fully clean run. ⚠ Two of those verdicts used to be **hardcoded literals** and could not notice their
own fixes (I-63); the three findings described below are now CLOSED and the paragraphs are kept for
the reasoning. Green at 2026-06 and 2026-05.
Phases 5a (HITL) and 5b (retry) were added in Stage 6; the paused-run check asserts the outbox has not
moved, matched on **this flow's own subject** — the first version counted the whole outbox and went
MISMATCH because phase 4 leaves a `full` replay in flight that also mails.

Its one rule is the method: **the journey may only use the HTTP surface `packages/client` uses.** The
`kestra:phaseN` harnesses import services directly — right for engine properties, wrong here, because a
script that can call a repo or reach Kestra silently grants itself access no browser has. Every step
names the `foundryApi.*` method it stands for, and a step with no such method is recorded as a **GAP**
rather than routed around. **It does not gate on its own findings**: MISMATCH and GAP are the output,
and only a hard FAIL exits non-zero. Run it at a second period — `--period=2026-05` is the empty case.

Three of its findings are worth knowing before touching the runs surface:

- **An execution's `flowId` is the KESTRA slug, not Foundry's uuid** (`ISSUES.md` I-23), in both
  `list()` and `get()`. The UI survives because it only ever renders it as a label. It is not usable as
  an identifier: a client filtering the runs list by the uuid it holds gets **zero rows**, and a
  deleted-then-recreated flow reuses the slug, so two different flows become indistinguishable. Do not
  build anything on it; fix it by returning `flow_id` and adding the slug as its own field (nullable —
  flowless Phase-1 history exists).
- **`test-run` and `fire` return `kestraExecutionId`** (and `test-run` also `namespace`) — against the
  invariant `ExecutionView`'s own docblock states (I-22). Not exploitable today (Kestra publishes no
  port, and `begin` reads the namespace from Kestra, never from a request — I-07), but it is drift in
  the direction where a client feature gets built on it.
- **`engineStatus` says `success` where `flow_executions.status` says `succeeded`.** Two vocabularies
  for one outcome, and a poller written against the wrong spelling is silently never true. This harness
  made that exact mistake first.

⚠ **Named queries DO have HTTP routes** since Stage 2 (`/workspaces/:ws/datasources/:dsId/queries`),
and **a flow can be authored from a browser** since Stage 7. Both GAPs were closed by building the
route — the intended outcome; closing one by relaxing the harness's rule would have made the report
agree with itself. The generation step now runs a **real** generation (202 → poll → terminal), and
`approval` and `retry` are declared through `foundryApi.saveFlowRevision`, which is what
`FlowReview`'s per-step controls call.

⚠ **Three GAPs closed in Programme 3 Stage 5, and they were one fact repeated:** *"the client cannot
post a hand-authored model."* It can now — the canvas posts one as `authored`, and the journey creates
its three flows that way. **The remaining GAP is unrelated**: `GET /…/triggers/:tid/fires`, the fire
audit trail, has no client method. There is still no `createFlow`; see D-49 for why `authored` is not
one.

---

## The regression net — do not touch it

`demo:verify` and `demo:rehearse` are how this migration stays honest. The `hr_demo_alt`
rehearsal **found three real bugs on its first run**, including one no single dataset could find.
Everything below is deliberately kept, not legacy.

⚠ **They are `pnpm --filter @foundry/server demo:verify`, NOT `pnpm demo:verify`.** Every `demo:*` and
`finance:*` script lives in `packages/server/package.json` and **none is aliased at the root**, so the
root form fails `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "demo:verify" not found` with exit **254**.
This file wrote the root form for both until 2026-08-10 and the plan's gate list inherited it.
`kestra:check`, `backup`, `backup:verify`, `restore` and `e2e` **are** root scripts and the bare `pnpm`
form is correct for those — which is exactly why the wrong one looked right.

### The HR demo

Workspace **`HR`** = `6db5693f-981a-40fc-99f2-b517459364b7`. ⚠ This said
`20406b2e-1c7c-43eb-a1c8-2b7238b73a84` until 2026-09-03 and that workspace does not exist — the id
above is read from `workspaces` on this deployment. **15 real tools** (14 operational +
`llm_complete`) served by **`packages/ops-api` on :4004**, backed by a **separate `hr_demo` Postgres
database**. 62 employees, 7 tables, 44 columns, manifest ≈17 KB.

⚠ **`routes/stub-api.ts` and `DEMO_MODE` are GONE** (Stages 1 and 5). The endpoints did not move
because the name was embarrassing: they ran *inside the parent process*, so a tool call terminated in
the process holding `PARENT_API_KEY`, `TETHER_API_KEY` and `CREDENTIAL_ENC_KEY`, on a connection to
the database holding `workspace_secrets`. See `DECISIONS.md` D-33.

**ALL DATA IS SYNTHETIC.** Invented names on RFC 2606 reserved domains (`acme-hr.example`,
`acme-hr-bounce.example`) that cannot resolve or receive mail. **Never replace with real data.**

- `pnpm demo:seed` / `demo:reset` / `demo:status` / `demo:verify` / `demo:seed-alt` / `demo:rehearse`
  (all in `packages/server`). `demo:verify` asserts ~20 dataset invariants — run it after any dataset edit.
- **`GET /api/demo/oracle` is the correctness oracle** — the right answer computed from the dataset
  definition, not from any script. 11 employees below threshold, 2 excluded, 1 unmailable, 1 bouncing.
  ops-api's **`api_call_log`** shows which tools an automation actually called — read it through
  `opsClient.callLog()` or `GET /api/ops/outbox/calls`, never by SQL: the parent holds no credential
  for the ops database and must not acquire one.
- Deliberate traps: employee **#14 at 80.95%** (above the org-wide 80% default, below Engineering's
  85% override — a script that hardcodes 80 misses them), an empty department, a single-occupant
  office, a NULL-email contractor, an approved-medical-leave exclusion, a mid-month leaver.
- ⚠ **`POST /api/demo/provision|reset` are DELETED** (Stage 1) — destructive reseed from one
  authenticated request. Reseeding is CLI-only: `demo:reset` reseeds `hr_demo` and calls
  `opsClient.reset()` to truncate the four capture tables, and never touches workspaces, flows or
  triggers. The read surface survives as `/api/ops/*`.

**Why a separate database.** The original reason (a hardcoded `table_schema='public'`) is obsolete —
that hardcode is gone. The reason that remains is the **credential boundary**: the DSN handed to
generated scripts must be unable to reach the parent DB at all, so a script cannot satisfy "send the
email" with an `INSERT INTO mail_outbox`. A schema inside the parent database could not give that —
and since Stage 5 those capture tables are not even in the same *database*, let alone the same schema.

### The swap rehearsal — run it, don't skip it

`pnpm demo:seed-alt` provisions **`hr_demo_alt`**, schema **`hr`**: same domain, deliberately
different shape — new table names, attendance as **views**, rates as a **0–1 fraction** (the primary
uses 0–100), composite PK, window `2025-11`, ~10× rows, and a `presence_vs_policy` view that
pre-resolves the policy join. `pnpm demo:rehearse` runs 29 assertions.

It is provisioned through **the same services with no branch anywhere** — that absence is the
evidence, and a test asserts no service or repository names either dataset. Its oracle is a
**separate function** from `expectedScreening`, not a parameterisation: a shared oracle would let a
shared bug produce a wrong answer that agrees with itself.

**Do not touch the demo dataset or `demo/hr-roles.ts`.**

⚠ **`workspaces.kind`** is `null` for a real tenant and `"fixture"` for one that serves a harness —
today only `HR (alt — swap rehearsal)`, which `demo:rehearse` requires and which must not be deleted.
Shown with a badge and sorted last rather than hidden: a hidden workspace is one nobody notices has
broken. A column and not a name prefix, because a display name is text somebody will edit.
⚠ **That workspace's 14 tools are scenery** — `demo:rehearse` never calls them, and its seven `hr_*`
tools read `hr_demo`, so inside it the tools and the datasource disagree about who exists.
The empty `Foundry` workspace was soft-deleted in Programme 3.

### The Finance domain — the second dataset

Workspace **`Finance`**, database **`finance_demo`**, read-only role **`finance_ro`** (⚠ *not*
`foundry_ro` — D-43), 8 tools, 5 named queries, 9 tables. `pnpm finance:seed` / `finance:verify`.
Its write-up went with the deleted `canvas-and-sandbox/VERIFICATION.md`; `finance:verify` is now the record. **ALL DATA IS SYNTHETIC**, every
address on an RFC 2606 reserved `.example` domain. Five things are load-bearing:

- ⚠ **The units trap. `invoices.amount_cents` / `expense_claims.amount_cents` are MINOR units;
  `budgets.amount` is MAJOR.** Budget-versus-actual needs a `×100` on one side, and getting it wrong
  reports Engineering as 62× over budget. Deliberate — the `0–100` vs `0–1` lesson from
  `hr_demo_alt`, reproduced in a second domain so a Finance flow needs an oracle rather than a green
  run.
- **`financeOracle()` is a SEPARATE FUNCTION from `expectedScreening()`** and must never become a
  parameterisation of it — a shared oracle lets a shared bug produce a wrong answer that agrees with
  itself. It is computed from the dataset definitions, never from a query result.
- **`finance:verify` runs every named query against the oracle at all three periods**, which
  `demo:verify` does not do for HR. That half is what proves the COALESCE to the org-wide payment
  terms and the `×100` are right in *both* implementations. It **fails rather than skipping** when
  the database is unreachable. Both negative controls are recorded and both fire.
- **Periods `2026-04` / `05` / `06` give 0 / 6 / 15 overdue and 0 / 3 / 4 claims over policy** —
  `2026-04` is the empty case and the only period that exercises it. Three counts hold at *every*
  period (one duplicate pair, one stale-status invoice, one zero-spend cost centre) and are asserted
  as such.
- **No `hr_*` tool is registered here and Finance holds no `HR_DIRECTORY_TOKEN`** (D-45). Those are
  HTTP endpoints over `hr_demo`, so registering them would be a cross-tenant read that no datasource
  boundary catches. `finance-tools.test.ts` asserts the absence, and that every shared tool points at
  the identical URL, method, auth style and parameter set as HR's.

### The Legal domain — the third dataset

Workspace **`Legal`**, database **`legal_demo`**, read-only role **`legal_ro`**, 8 tools, 5 named
queries, 10 tables, 24 contracts. `pnpm --filter @foundry/server legal:seed` / `legal:verify`.
**ALL DATA IS SYNTHETIC**, every address on an RFC 2606 reserved `.example` domain. Six things are
load-bearing:

- ⚠ **THE BOUNDARY RULE IS THE OPPOSITE OF FINANCE'S, AND THAT IS THE POINT.** `finance_demo` teaches
  *due today is not overdue* (`>`). Here a notice deadline **on** the as-of date is the LAST DAY notice
  can be served, so it is IN the report and in the `0-14` bucket (`<=`). A developer carrying Finance's
  `<` across silently drops the one contract that could still have been saved. **Do not "make these
  consistent".** Two datasets that disagree is the only arrangement where the rule has to be read.
- ⚠ **THE AUTO-RENEW INVERSION, and it is resolved STRUCTURALLY.** Same date arithmetic, one boolean,
  two opposite actions and two opposite recipients: miss the deadline on `auto_renew = true` and you
  are locked into another term (notice goes OUTWARD to the counterparty); miss it on `false` and the
  contract lapses (warning goes INWARD to the owner). Getting it backwards serves a **termination
  notice on a counterparty you meant to renew with**, and every step still exits zero. So there are
  **two named queries**, `contracts_renewal_due` and `contracts_expiring_no_autorenew`, not one with a
  flag — the recipient is a different CALL SITE, which review can see. `legal:verify` asserts at every
  as-of date that the two are disjoint and that their union is complete, which is what stops the
  duplicated date arithmetic drifting.
- **A TWO-level notice fallback** (contract → contract type → `org_settings`), where Finance's COALESCE
  is one level. ⚠ The org-wide default is **45** and is deliberately unequal to every contract-type
  default: with both at 60 (the first version) a query that skips the middle hop resolved the right
  number anyway and the trap was undetectable. One contract needs both hops and is the highest-value
  one in the dataset, so the shortcut loses precisely the expensive contract.
- **`legalOracle()` is a THIRD independently written oracle** and must never become a parameterisation
  of `financeOracle()` or `expectedScreening()`. `legal-dataset.ts` imports **nothing at all**, and a
  test asserts that — you cannot call what you have not imported.
- **`legal:verify` has the same two halves as `finance:verify`** and half B runs all five named queries
  as `legal_ro` at **three** as-of dates against the oracle. `2026-04-30` is the empty case — ⚠ scoped
  to `contracts_renewal_due`, because a boundary or missed auto-renew deadline in May or June
  necessarily falls inside April's 90-day window, so "both deadline queries empty in April" and "all
  four buckets populated in June" cannot both be true. It **fails rather than skipping** when the
  database is unreachable. **Proven to fail**: three perturbations (inclusive bound, the COALESCE hop,
  the date-bounded suppression) each turn it red.
- ⚠ **The isolation claim is THREE directions, not six.** `legal_ro` is checked against `hr_demo`,
  `hr_demo_alt` and `finance_demo`, from a hardcoded list local to `seed-legal-db.ts` — the same idiom
  Finance uses. **`finance_ro` and the HR role are NOT checked against `legal_demo`**, because that
  needs an edit to existing seeders and the Legal feature deliberately edited none. The list is spelled
  out in three files (`seed-legal-db.ts`, `seed-finance-db.ts`, `datasource-target.test.ts`) and a
  fourth tenant needs the edit in all three. **Never describe this as symmetric or four-way tenant
  isolation.** A shared roster module was considered and set aside; see
  `specs/20260819-080932-legal-contract-demo-domain/plan.md` D-4.

---

## ⚠ The third programme — the canvas, the flows, and how a flow gets authored

⚠ Its `VERIFICATION.md` was **deleted on 2026-08-04** as superseded; what survives is
`DECISIONS.md` **D-46…D-59** and `ISSUES.md` **I-42…I-60**, and they are now the record. **All five stages are closed**, plus the
authoring modes and the 2026-08-03 drafting/canvas follow-up (see the last section below).

### The canvas (Stage 2)

`components/flow/FlowCanvas.tsx` — React Flow 12 + dagre — on `/runs/[id]`,
`/flows/[id]` and `/flows/new`. **`StepGraph.tsx` and `stepColumns()` are DELETED**; if
you find a reference, it is a leftover. `depths()` survives, because `orderedStepIds` (the
strip) still needs it. Six load-bearing facts:

- **ONE node model, two adapters** (D-46). `lib/canvas-model.ts` is pure and
  `canvas-model.test.ts` asserts both adapters classify the same step identically. Two
  pictures of one flow is the disagreement `lib/flow-graph.ts` was extracted to prevent.
- **Position is DERIVED every render** and must never become state. A model has no
  coordinates; the moment a node carries an `x`/`y`, layout can drift from the graph.
- ⚠ **The model-seam badge fails CLOSED.** `seamOf()` returns `agent`/`llm`/`null`/**
  `unknown`** — a `tool` step whose ref could not be read renders "?" and *"treat it as
  unknown, not as safe"*. The rule is narrow on purpose (`agent`, and `tool` where ref =
  `llm_complete`) and the legend states that bound on screen. **`ui-honesty-check.sh`
  asserts `llm_complete` is compared in exactly one file** — a second copy is how one of
  them silently stops matching.
- **`StepView.ref` exists for the badge** and is joined from `flow_steps` at the
  execution's **own revision**, never the flow's current draft.
- **`StepStrip` is the canvas's TEXT EQUIVALENT** and must not be deleted as a duplicate.
  A canvas that is the only representation is a flow some people cannot read.
- **An empty graph renders empty**, never a placeholder node.

**The client now renders in tests.** `src/app/routes.smoke.test.tsx` loads every page under
`(app)` plus the layout in jsdom; `FlowCanvas.test.tsx` renders the canvas against real graphs.
⚠ **Proven against the real bug**: reintroducing `use(params)` turns exactly one test red.
Its bound is in its own docblock — every `@/lib/api` call hangs, so it covers the loading
branch, not data-shaped crashes. `ui-honesty-check.sh` is **37** and asserts every page
under `(app)` has a render test — plus, since I-59, that no page builds a canvas graph inline
in a `graph=` prop, and that an outline node's id is its position rather than its text.

### Three real Finance flows (Stage 3)

`pnpm --filter @foundry/server scenarios:seed` → `scenarios:verify`. **13/13 at `2026-06`,
14/14 at `2026-04`** (the empty case). `src/scenarios/` — separate from `src/showcase/`,
which is organised by capability; these are organised by job and scored against
`financeOracle()` rather than against a green run.

- `finance-invoice-chase` — fan-out, retry, the empty case, and a projecting `transform`.
- `finance-expense-policy` — **gate 3**, verified as an ABSENCE matched on this flow's own
  subject line. ⚠ Left **unapproved deliberately**: a gated flow cannot satisfy gate 1
  unattended, and arming one lets a schedule park a run in an inbox at 03:00. Its draft run
  PAUSES, and the harness **kills** the paused execution — a pause holds an M3 slot and
  retention purges terminal states only.
- `finance-budget-variance` — a `code` fragment, the **units trap** live, and
  `llm_complete` as a **LEAF** (D-34, and the tool's own description). The digest's figures
  come from the fragment; the model's paragraph is read by a person and by no later step.

⚠ **Three Kestra/Pebble traps were found by running these, and all three are invisible to
HR** because no HR column is a date:

- **I-42 — a timestamp cannot cross into an `http.Request` body via `jq()`.** It dies with
  `Unable to parse jq value '[{…}]' with type 'java.util.ArrayList'`, which reads like bad
  DATA and names neither field nor reason — and **the same expression works in a
  `transform`**. Mitigation, and a good rule anyway: **a `tool` or `approval` step never
  consumes a raw query row.** A `transform` projects the fields the call needs, dates
  flattened to `YYYY-MM-DD`.
- **I-43 — `@json` is a jq encoder, not a Pebble filter.** `| jq('(…) | @json')`, never
  `| jq('…') | @json`.
- **I-44 — a `code` step's output is `outputs.<id>.vars.result`**, not `.value`.

### How a flow gets authored — TWO MODES, outline is the default (D-47)

`/flows/new` opens on **"I'll write the steps"**: the person writes the steps, one per
line, and the drafter chooses only the kind, the ref and the expressions. **"Design it for
me"** is the old goal path, unchanged. Five things are load-bearing:

- **The DAG is on screen from the first line typed**, before any inference. Nodes are
  deliberately KINDLESS — which line becomes a query or a tool call is not decided yet, and
  guessing from keywords would put a claim on screen the next screen contradicts.
- ⚠ **`validateOutline()` enforces the step count.** A prompt rule the model can ignore is
  not a control. A mismatch is a finding, so the redraft loop re-asks with both numbers.
- **The goal-mode prompt stays a literal PREFIX of the outline one** (pinned by a test).
  Everything above the outline is byte-identical across the workspace — the only reason the
  prefix caches. Goal mode gains nothing, so `kestra:refusal`'s numbers stay comparable.
- **The refusal arm is untouched.** No Retry button, ever.
- **Progress is advisory and INDETERMINATE while drafting** (D-48). `total` is null until
  the draft names its `code` steps; the bar shows no percentage. `status` decides
  everything; `setProgress` filters on `status = 'running'` so it cannot resurrect a
  finished job.

⚠ **`approval` was missing from the drafter's vocabulary until 2026-08-01 (I-46).** Gate 3
had been a step kind since the previous programme's Stage 3 and the drafter was never told
— so a goal asking for a human decision produced `wait_for_approval:**tool**`, a step named
after a pause that does not pause. It survived because gate 3 was only ever added by
`FlowReview` splicing it in, which the drafter never sees. **Outline mode found it**, and
**I-47** is why it hid: a bad step kind reported itself as `steps: Required`, which was fed
back into the retry prompt verbatim.

**MEASURED** — `pnpm --filter @foundry/server outline:measure`, with a goal-mode control:
**2 of 3 kept the shape, 0 drifted, 1 produced no parseable draft; the control reached the
same shape 0 of 3** (it produced twelve steps for a five-line outline). Read
`DECISIONS.md` D-47 before quoting it: the one outline failure was D-22 refusing jq variable
bindings, not a wrong count, and **goal-mode draft reliability on this model is poor** —
two of three failed after three attempts. Three cases on one model is a reading.

### The editable canvas (Stage 5) — the one architectural reversal

`/flows/new` has a THIRD mode, **"Build it on the canvas"**, beside outline and goal.
`components/flow/{FlowBuilder,StepInspector}.tsx` over an `editable` `FlowCanvas`;
`lib/flow-authoring.ts` (pure edits) and `lib/flow-expr.ts` (expression building) are the
seams. `pnpm --filter @foundry/server kestra:canvas` plants a regression per control —
**7 fired · 2 passed · 1 N/A · 0 missed.** Decisions **D-49…D-51**, issues **I-48…I-50**.
Seven things are load-bearing:

- ⚠ **There is no `createFlow`, and the palette is safe because of where the model GOES.**
  `FlowBuilder` emits the **drafter's own response shape** and posts it as `authored` to
  `POST …/flows/generate/jobs`. `runGeneration` branches once — `authored ? authorFlow :
  draftFlow` — and `authorFlow` is `draftFlow` minus the inference call: same
  `parseDraft`, same D-22 allowlist, same `splitDraft`, same `unknownRefs`, same
  `validateModel`. A hand-authored model therefore cannot reach a weaker path than a
  generated one. **`ui-honesty-check.sh` fails if a `createFlow` appears in the client.**
- **A `code` step on the canvas gets a CONTRACT, never code.** `outputKeys` stays derived
  from `contract.output` in `splitDraft`; there is no code box in the inspector and no
  `code` field in `lib/flow-authoring.ts`, asserted by `ui-honesty-check.sh`.
- ⚠ **The inspector BUILDS expressions; it does not ask for one** (D-50). D-22 is a good
  boundary and a terrible text box — `outline:measure` had a real draft refused for a jq
  variable binding. The form asks *which upstream step* and *which field goes in which
  parameter*, and `lib/flow-expr.ts` assembles a string that is inside the allowlist by
  construction. A raw escape hatch exists and is checked against **the allowlist the
  catalogue served** — never a hardcoded copy, which is a second definition of the boundary
  that drifts silently in both directions.
- **Input and output are NOT uniformly editable.** Output is editable for `transform` and
  `code` only; a `datasource`/`tool` step's output belongs to the query or the endpoint,
  and an editable box there lets someone type a shape the call will ignore.
- **`GET /api/workspaces/:ws/catalogue` is the palette's one read** — the refs (from the
  same `refFingerprints()` keys `checkFlowRefs` is handed), their parameter descriptions,
  D-22's allowlist, D-37's caps, and the per-kind output shapes. `drift` reports a ref the
  two ref sets disagree about, because the symptom otherwise is a tool simply missing from
  the list.
- **Position is still derived every render** (D-51). `nodesDraggable` stays false even in
  edit mode: a node carrying an `x`/`y` is a layout that can drift from the graph. The
  canvas reports intents and never writes; every rule lives in the pure functions.
- ⚠ **`spliceApproval` in `lib/flow-authoring.ts` is the ONLY gate-placement implementation
  now** — `FlowReview` had its own copy. An appended gate compiles, deploys and stops
  nothing, so two implementations of "before, not after" is one implementation and one bug.

⚠ **Two of the seven controls are not refusals, and the harness says so rather than faking
them.** A **fan-out** cap cannot be checked statically (an authored flow declares an
expression, not an item count) — the real bound is `stepBatchSchema.params.max(1000)` at
runtime. And an **appended gate is a legal flow**: nothing server-side can refuse it, so the
control is that the canvas can only splice, that the finding is shown, and that emission
order is asserted against the compiler. A control that cannot fail is worse than none (I-38).

⚠ **I-48 came out of this and is worth knowing generally: the caps used to fire only AFTER
generation had been paid for.** `flowValidator.checkFlowShape` now also runs inside
`authorFlow`, before `generateFragments` — the same pure function, earlier.
`writeRevision` is still the authority. `draftFlow` deliberately did NOT get the same call;
its loop is a measured artefact.

### The development sandbox (Stage 4)

`pnpm --filter @foundry/server kestra:sandbox` — eight blocks against the running engine, green
with the model's own fixture and with `--authored`. Decisions **D-52…D-54**, issues
**I-54…I-56**. It closes an exposure that was verified in code, not suspected: `resolveRef`
had no draft/live distinction, so a **test** run read the tenant's real database — and gate 1
*requires* a successful run before arming, so a flow with an `agent` step sent real rows to an
external model **before anyone had approved anything**. Eight things are load-bearing:

- **Selection is bound to the NAMESPACE and there is no flag** (D-52).
  `foundry.<t>.<ws>.draft` → the sandbox DSN, `foundry.<t>.<ws>` → the real one. The
  environment is read off `flow_executions.kestra_namespace`, which `begin` wrote from
  **Kestra's own record** (I-07); `stepBatchSchema` has no field for it and `routes/steps.ts`
  is the only caller of `envForExecution`. ⚠ It fails **CLOSED** — an unrecognised namespace
  is `draft`, because reading fixtures on a production run is a wrong answer somebody is
  watching and the other direction is silent.
- ⚠ **A draft run against a datasource with NO sandbox reads PRODUCTION, and says so on every
  batch.** Refusing sounds stronger and is worse: every flow, harness and demo does its gate-1
  run against a real datasource, so a day-one refusal is a change everybody routes around —
  and what gets routed around is the control. `StepBatchResult.readFrom`, `StepView.readFrom`
  and the datasource page all state it. **Never say "test runs no longer touch real data"**;
  say *if a sandbox exists a draft run reads it, and nothing in a request can change that.*
- **`flow_step_runs.read_from` is PERSISTED, never recomputed.** Deriving it later from the
  datasource's current state would rewrite the history of every draft run that read production
  the moment somebody provisions a sandbox — the record of an exposure becoming a record of
  there never having been one.
- **The fixture is DATA in `foundry_parent`; the sandbox database is a projection** (D-53).
  `datasource_fixtures` is insert-only and holds the rows, the DDL and the shape fingerprint,
  so `sandbox:rebuild` replays them byte-identically with no model involved. ⚠ **`foundry_sbx_*`
  is therefore in neither of `backup.sh`'s lists on purpose**, and that is written beside the
  lists — every *other* new database still has to go in one.
- **The model writes rows from the SCHEMA ONLY and certifies nothing** (D-54).
  `buildTablePrompt` has no database handle, DSN or datasource id, asserted against its own
  source. ⚠ **It must never be shown real rows to imitate** — at that point the fixture is a
  lossy copy of production rather than a substitute for it. `verifyTaxonomy` is deterministic
  code running **SQL against the loaded database** (not the JSON — `numeric(5,2)` rounds
  80.955 and a JSON-side check would certify a boundary case the query cannot see).
- **Seven categories, every one with a checker and every satisfied one with EVIDENCE.** A
  category asked for and never verified reads exactly like one that was checked; a "yes" with
  no table, column and values is unfalsifiable. **MEASURED 2026-08-02: 2 of 2 real-model runs
  passed all seven first attempt**, ~256 s over 7 tables — but that is two runs on one schema
  on one model, and the harness falls back to an authored fixture *and says so* when refused.
- **Provisioning builds in `<db>_stg` and promotes by rename** (I-54). The in-place version
  replaced the rows *before* the taxonomy could refuse them, so a refused regeneration left
  every draft run reading the fixture that had just been rejected — and the first version of
  the assertion checked the sandbox POINTER, which was never what was at risk.
- ⚠ **Gate 1 still requires a supervised real run before arming, and a sandbox run proves
  EXECUTION, not correctness.** `hr_demo` stores attendance 0–100 and `hr_demo_alt` as a 0–1
  fraction; the swap rehearsal found three real bugs on its first run. Same rule Phase 6 states
  for imports — **never describe it as validating a flow.**

⚠ **No product workspace has a sandbox, deliberately.** `demo:verify`, `showcase:verify` and
`scenarios:verify` all score a DRAFT run against an oracle computed from the real dataset, so
turning fixtures on under them would make them fail for a correct reason. The proof runs in
its own `kind: "fixture"` workspace through the production execution path.
`sandbox:provision --workspace=<id> --datasource=<name>` turns it on for any datasource, and
doing that to HR **will** change what those harnesses measure.

⚠ **Two things the copy does not reproduce**, stated in `shape.notes` rather than guessed at:
a view becomes a plain **table** (introspection records a view's columns, not its definition)
and **UNIQUE constraints are absent** (it records primary keys only), so the sandbox is
slightly *more* permissive than production. An unmappable column type is a **refusal naming
the column**, never a widening to `text` — a widened enum accepts values the real column
rejects. Postgres only; MySQL is refused by name.

### The drafting/canvas follow-up (2026-08-03) — read this before "speeding up" generation

Three user reports, one investigation each. Record: `DECISIONS.md` **D-55…D-59** and `ISSUES.md`
**I-57…I-60** (the programme's own `VERIFICATION.md` was deleted on 2026-08-04). Six things are load-bearing.

- ⚠ **"Autogenerate takes forever" was NOT the model being slow, and it was NOT Tether.**
  Generation is decode-bound at ~35 tok/s and a draft is 900–1,200 completion tokens, so **one
  attempt costs ~20–30 s and nothing makes it cheaper except emitting less.** What varied
  between 30 s and 158 s was **attempts**, and every attempt re-emits the whole flow. Measure
  before tuning: `pnpm --filter @foundry/server draft:measure` reports attempts, seconds and the
  **reason** each rejection happened.
- ⚠ **I-57 is the one to know. The expression allowlist was rejecting VALID jq.**
  `flow-expression.service.ts` found `{{ … }}` with a non-greedy regex, so a jq program that
  builds a nested object — `jq('[.[] | {to: .email, vars: {name: .n}}]')` — closed the template
  at its own `}}`. Every field name in the program then came back as an unreadable variable
  root. **25 of 26 findings in a measured run were this**, and they were fed to the redraft
  verbatim, so the model rewrote correct expressions into different ones. It is now a **scanner**:
  the close respects quotes, a nested `{{` is detected ignoring them (I-11 must still be caught),
  and an unterminated `{{` is a refusal rather than a partial scan reporting green. ⚠ It is also
  **stricter** — `{{ '}}' ~ secret('FOUNDRY_CALLBACK') }}` used to hide the call to `secret`
  inside the quoted `'}}'`, and there is a test.
- **The draft prompt now declares its own schema** (D-55) — `STEP SHAPES`, all six kinds, exact
  field names, bounds, and I-11/I-43 as stated rules. ⚠ **The worked example is run through the
  drafter's own validators by a test.** A model copies the example far more reliably than it
  follows prose, so an example the validators would reject teaches a mistake and charges a
  redraft for it in every workspace, for ever. That test is what catches the *next* instance.
  ⚠ And placeholders in a schema block are **values**: the first version wrote
  `"timeoutSeconds"?:0` and the model emitted `0`, which `min(1)` rejects.
- **A type synonym is normalised; a structural guess is not** (D-55). `integer`→`number` has one
  reading. `valueExpr` is **not** rewritten to `expr` and `{"kind":"llm_complete"}` is **not**
  rewritten to a tool step — both would be the parser deciding what the drafter meant about the
  flow's shape, and a wrong guess there compiles and does the wrong thing.
- ⚠ **Goal-mode reliability did NOT improve, and the doc says so.** Outline mode went 0/1 at 3.0
  attempts → **2/2 at 1.0**. Goal mode scored 3/3, 1/3 and 1/6 across three runs — the
  run-to-run variance is larger than the change. What changed is that the remaining rejections
  are *correct*. **Never quote a goal-mode improvement from this work.** The real remaining lever
  is that a rejection re-asks for the **whole flow**; see `docs/GAPS.md` §5.1.
- ⚠ **The canvas flashing was a choice of primary key, not React Flow** (I-59). The outline
  sketch used the typed line as the node **id**, so a keystroke was a rename and a rename is an
  unmount. `CanvasNode` now has a `label`; `canvasFromOutline` keys by line **position**.
  Separately every call site built its graph **inline in JSX**, so dagre re-laid-out the whole
  DAG per render — including the render caused by clicking a node. `ui-honesty-check.sh` (now
  **37**) fails on an adapter call inside a `graph=` prop, and `FlowCanvas` memoises layout on a
  **topology string**: if `layout()` ever sizes a node by its content, that key must grow the
  same day.
- ⚠ **A SECOND flicker, reported from use on 2026-08-04, and it was the EDGES** (**I-66**).
  Hovering rebuilt the node array, and React Flow compares nodes by **identity** — so a rebuild reset
  `measured` and, through `parseHandles`, discarded the handle bounds measured at mount. Without both,
  `getEdgePosition` returns null and **every edge unmounts**, on every mouse enter and every leave. It
  fired once per poll on a live run too, where it read as ordinary movement. `stepNodes` now declares
  `measured`/`width`/`height` from `NODE_W`/`NODE_H` — **`measured` is the half that does the work**,
  `width`/`height` alone do not satisfy `parseHandles` — and the card takes its size from the same
  constants instead of a hardcoded `w-[232px]`. ⚠ **The declared size must stay true**: a card that
  outgrows it attaches edges to the wrong place with nothing flickering to say so, and
  `FlowCanvas.test.tsx` pins the rendered card against the constants. jsdom performs no layout, so no
  client test can assert on edges at all — one over an empty set would pass for ever (I-38).
- **Clicking a node opens a details panel on the canvas itself** (I-60) — it was inert on two of
  the four surfaces. It shows what every surface shares and does **not** duplicate `StepDetail`:
  the facts the adapter attached, and **what feeds it and what it feeds**. A leaf reads
  `nothing`, because feeding nothing downstream is what makes `llm_complete` a leaf (D-34) and a
  gate at the end useless. Its seam sentence carries the **same caveat** as the badge and the
  legend — a third phrasing is a third thing to keep true.

---

## ⚠ The residue batch (2026-08-04) — five entries, and two closed only in part

Decisions **D-69…D-73**. `docs/GAPS.md` §1.1b, §1.2b and §6.1b are CLOSED; §1.3b and §2.3b are
**partly** closed and the open halves are named in each. Five things are load-bearing.

- ⚠ **Gate 3 has a subject now** (D-70, §1.1b). `flow_executions` records **who asked** for a run,
  written at `begin` from a **pointer label** the starting route records first — the person never
  travels to Kestra, because a label renders in `kestra-ui`, which has no tenant isolation. The
  refusal compares identity **subjects**, not names, and **stands down** on a schedule, a trigger, a
  harness or a pre-migration run. Say *"the person who started a run cannot also approve its
  pause"*; **never** separation of duties.
- ⚠ **The provenance policy ESCALATES rather than refuses** (D-69, §1.2b). An `approver` may approve
  a revision a person is recorded as writing; an unattested one needs an `admin`. At the **route**,
  so the whole regression net — which arms flows through `systemAuthor()` and calls the services
  directly — is untouched by design. **Revoke deliberately does not carry it**, and a test pins the
  absence: making an unattested flow harder to turn *off* points the control backwards.
- ⚠ **`/api/signals` has two readers and one is not a screen** (D-71, §6.1b). `SignalsPanel` on
  `/dashboard` for a person; `pnpm --filter @foundry/server signals` for a scheduler — **0** ok, **1**
  warn/alarm, **2** unreadable. That third code is the point: *"unhealthy"* and *"I could not find
  out"* need different responses. `unknown` exits 0, matching D-66's ranking.
- ⚠ **A datasource may not point at a link-local address** (D-72, §1.3b) — 169.254.0.0/16 is the
  cloud metadata endpoint, and it is not a database. Refused on every deployment, allowlist or not,
  and **before** the identity probe so nothing dials it. **Private ranges and loopback are NOT
  refused** — that is where the demo databases live, and I-36 is the record of what happens when a
  datasource check breaks `demo:seed`. Still open: DNS can move underneath it, and the policy half
  needs §1.1's answer to what a tenant is.
- ⚠ **A claim can be SUGGESTED but is never generated** (D-73, §2.3b). Suggestions are derived
  mechanically from the flow's shape and are **deliberately weak** — `gte 1`, `failed eq 0`, `present`
  — with a test pinning that no suggestion guesses a number. Asking the drafter what its own flow
  should produce is `generation-audit.service.ts` with a new name, and that service marked `clean` a
  script which emailed 0 of 11 people.

## ⚠ Gate 1 grew a second half (2026-08-04) — GAPS §2.3, D-68

`pnpm --filter @foundry/server kestra:expect` · 26 assertions, green at `2026-06` and `2026-05`.
The full reasoning is **D-68** and the entry is `docs/GAPS.md` §2.3, now CLOSED; the trigger-gate
section further down carries the five load-bearing facts. Two things to know here:

- **It closed narrower than the original entry read.** The entry asked for fixtures carrying
  expected outputs; what exists is per-FLOW claims, which is the smaller half its own "fixing it"
  paragraph recommended. A sandbox fixture still carries no expected output. **§2.3b is the residue**
  — nothing generates or even suggests a claim, so a generated flow arrives with none, and those are
  the flows most likely to drift.
- ⚠ **The harness found a real defect on its first run, in its own flow.** The transform projected
  `.name`/`.email`; the query emits `full_name`/`work_email`. Eleven rows of nulls, a green run, and
  the only thing that noticed was the expectation under test. That is the whole case for the feature,
  arriving unprompted.

## ⚠ The gap-closing batch (2026-08-03) — eight entries, and two closed narrower than they read

Record: `docs/GAPS.md` (each entry marked **CLOSED** in place); decisions **D-60…D-64**, issues
**I-61…I-63**. **§1.3 landed after the first seven** — a datasource is now refused for *where it
points*, and the host allowlist the entry proposed turned out to be the weaker half; see the
Security-posture bullet above and D-64. `e2e:ui` went **55 MATCH · 2 MISMATCH · 1 GAP** → **58 MATCH · 0 MISMATCH · 0 GAP ·
5 NOTE · 0 FAIL** — the journey is fully clean for the first time. Six things are load-bearing.

- ⚠ **§1.2 records a provenance and deliberately refuses NOTHING on it.**
  `flow_revisions.created_by_kind` (`user`/`system`/`unknown`, NOT NULL, **no default**) says whether
  authorship was attested; **gate 2's refusal is unchanged** and still compares strings. Refusing
  every system-authored revision breaks `kestra:phase3`, the seeds and the whole regression net,
  which arm flows that way. **§1.1 is still open and this is its job.** Never call any of it
  separation of duties (I-13). The backfill is `unknown`, not `system` — 37 rows whose origin nobody
  recorded, and that absence *is* the gap.
- **`authorOf()` is the ONLY minter of `user`**, asserted by reading the source tree, because a
  second one would work perfectly and report nothing (the `TETHER_API_KEY`-in-three-files shape). A
  body `createdBy` is an *input* to it and is **refused with a 400 from a signed-in caller**. A
  second grep forbids a body value reaching anything else; both real historical defects
  (`…/regenerate` off `req.body`, `POST …/import` off `input.createdBy`) were re-introduced to prove
  it still fires.
- ⚠ **I-62 is the one to remember: that guard's first version had three false positives and zero
  real ones.** It flagged `createdBy: z.string()` (declaring the field — mandatory before you can
  hand it to `authorOf`) and `createdBy: t.createdBy` (reading a stored value *out*). A guard that
  cries wolf gets widened, and the widening people reach for permits the defect — I-38 by another
  road. State what is forbidden (a **body-derived** value), not a pattern that resembles it.
- **`flowId` on an execution is now the Foundry uuid**, nullable; the Kestra slug is **`flowName`**.
  Dropping the slug would have cost `/runs/[id]` its page title — a regression delivered as a fix.
  `executionBase()` is **one** function both routes project through: I-23 was two identical bugs, and
  fixing one alone leaves the routes disagreeing about what `flowId` means. `test-run`/`fire` are
  stripped **at the route, not in the service**, so `kestra:phase3` still reads the engine id.
- ⚠ **Two `e2e:ui` verdicts were HARDCODED literals** (I-63) and could not notice their own fixes.
  Step 20's prose had drifted into *"the KESTRA flow id X rather than the uuid X"* — the same string
  twice. Both compute now, and step 36 decides a GAP by **reading the client source**, because
  relabelling it would make the report agree with itself. It **fails closed**, and did.
- ⚠ **`GET /api/signals` is the second endpoint and is NOT `/api/health`** (D-66, §6.1). Health
  answers *"can this process serve a request"*; signals answers *"is the system still doing its
  job"* — the four things that fail with nothing raising an error anywhere: a scheduled flow stops
  firing, the agent poller stalls, the staleness sweep stops (it logs only when it suspends
  something, so its silence looks like success), M3 slots leak. It is **authenticated** because it
  names workspaces and flows; **never merge it into `/api/health`**, which would either put tenant
  names on an open route or the liveness probe behind a credential. `unknown` is a real state and
  ranks *below* `warn`: a signal with nothing to go on must not say `ok`, and must not shout over a
  real warning either. The scheduled-flow period is **learned from history, never parsed from the
  cron**, and the slot signal **does not ask Kestra** (that is `reconcileRunning`, refusal-path
  only) — both stated in the payload. ⚠ **Nothing reads it yet** (§6.1b).
- **`/api/health` reports five components; only the process's own prerequisites are `critical`**
  (D-62). `status` stays `ok` while Kestra is down — taking the API out of the load balancer removes
  the only surface that could say why. ⚠ **Every caveat is in the payload**, including Tether's
  naming `llmConnected` as a documented false green. Probes are timeout-bounded and the cache reports
  its own age. It does **not** prove a flow can execute — `kestra:check` is what proves that.
- **Retention's coupling is stated beside the run it applies to** (D-63). `services/retention.ts`,
  one sentence every surface quotes, plus `replayWindow()` per run. ⚠ "Expiring soon" is a
  **fraction** of the window, never a fixed week, and the tests read the number back from
  `retentionDays()` rather than writing `30` — a hardcoded expectation is how a second default gets
  born.

## ⚠ The pre-deployment cleanup (2026-08-04) — a clean slate and two deletions

Driven by a production deploy, not by a programme. Four things happened and three of them are
deletions; **I-66** (the canvas flicker) is written up in the canvas section above.

- **The deployment holds THREE flows and they are the Finance scenarios.** `slate:clear` removed 13
  flows, 126 Foundry execution rows and 430 Kestra executions; `scenarios:seed` re-created
  `finance-invoice-chase`, `finance-expense-policy` and `finance-budget-variance`, and
  `scenarios:verify` scores **13/13**. Two are armed; **`finance-expense-policy` is deliberately not**
  - ⚠ **RE-CHECKED 2026-08-27: FIVE flows, 2 armed.** The three above plus **two `Untitled flow`
    drafts** (Finance, created 08-24; HR, created 08-25) that nothing in this repo's harnesses cleans
    up — `chat:measure` deletes the flow it creates by id, verified. Not deleted here: they are
    somebody's working state, not junk this feature may decide about. ⚠ And the "three flows" claim
    was **false in the other direction** earlier the same week: when this feature's Phase 2 began the
    deployment held **zero** flows and zero `db_operations`, and `scenarios:seed` is what put the
    state this bullet describes back. **Re-run the count; do not quote this line.**
  — a gated flow cannot satisfy gate 1 unattended, and its harness kills the paused run because a
  pause holds an M3 slot. ⚠ **`showcase:seed`, `kestra:phase3/4/6`, `kestra:expect`, `kestra:canvas`
  and `e2e:ui` all author flows into this deployment.** Running any of them puts the flow count back
  up; that is the cost of the harnesses sharing the demo instance, and it is not a bug in either.
- ⚠ **SUPERSEDED IN TURN, 2026-08-06, by `ui-upgrade/` Phase 3.4 (D-81) — `/home` is DELETED
  AGAIN and `/dashboard` is the landing page.** All five landing paths named in the bullet below now
  point at `/dashboard`; `app/(app)/home/` is gone, the `Home` nav row is gone, and
  `routes.smoke.test.tsx` covers **18** pages rather than 19 (`ui-honesty-check.sh` derives that
  count by walking the filesystem, so it followed on its own). The reason is the one the bullet below
  never answered: two pages competing to be the first thing you see means neither is trusted as the
  place where the truth is, and `/home`'s figures were a softer copy of `/dashboard`'s own.
  `homeSummary()` stays deleted — it was not resurrected when `/home` came back and nothing here
  changes that, so *"runs today"* still has exactly one computation.
  ⚠ **This is the THIRD answer to the same question and all three stay in place, in order.** Deleted
  2026-08-04 (two bullets down), restored 2026-08-05 (below), deleted again here. Do not tidy them
  into one: a reader who finds only the latest answer cannot tell whether the question was hard or
  whether somebody was careless.
- ⚠ **SUPERSEDED 2026-08-06 by `old-ui-restoration/old-ui-restoration.md` — `/home` is back, and five landing
  paths point at it again, not at `/dashboard`.** This bullet used to record `/home`'s deletion as
  a permanent decision; it was not one. The old app's UI was reconciled onto the new app's data and
  behaviour (branch `ui-restoration-old-app`), and `/home`'s three static "door" cards plus one live
  health sentence came back as part of that — **not** as a reversion of the reasoning above, which
  still explains why `/home` had been removed once. The **five** landing paths are `app/page.tsx`'s
  root redirect, `proxy.ts`'s (`middleware.ts` before Next 16) already-signed-in bounce, the local sign-in button
  (`login/local-login-form.tsx`), the Entra sign-in (`login/page.tsx`), and the sidebar logo lockup
  (`Sidebar.tsx`) — all five now `redirect`/`push`/`href` to `/home`. `Sidebar.tsx`'s separate
  `Dashboard` nav row is untouched and still points at `/dashboard`; that link was never a landing
  path. `homeSummary()` was **not** resurrected — `/home` reads the surviving `dashboardSummary()`
  plus `listConnections()` directly, exactly as this section originally argued it should if it ever
  came back, so "runs today" still has exactly one computation. See
  `old-ui-restoration/old-ui-restoration.md` §3.2 and `old-ui-restoration/phase-8-completion.md` for the mapping.
- ⚠ **The connector catalogue offers TWO entries, because the server can register two.** MongoDB,
  Amazon S3 and Google Cloud Storage were pickable on `/data-sources/new` and were **inert** once
  registered — `schemaIntrospectorService.supports()` covers `postgres`/`mysql` alone, so only they
  can be introspected, only they can host a named query, and only a named query is reachable from a
  `datasource` step. **Inert is worse than refused**: a refusal names the reason in front of the
  person who chose it, while inert surfaces weeks later as a broken flow. `lib/connectors.test.ts`
  pins it, and ⚠ **its `REGISTRABLE` set is a MIRROR of the server and says so** — it goes red when
  the catalogue runs ahead of the server (a dead end shipped) and stays green when the server runs
  ahead of the catalogue (a missing option somebody complains about). One of its four assertions
  needs no mirror at all: `assembleConnectionString` must produce a type the product understands,
  which is what caught `s3://host:5432/bucket`.
- ⚠ **Two programme VERIFICATION.md files were deleted** — `docs/away-from-demo-mode/` and
  `docs/canvas-and-sandbox/` — deliberately, as superseded. **Every reference to them as a FILE is
  gone**: thirteen source docblocks and `phase-5.md` now point at the `DECISIONS.md` / `ISSUES.md`
  entries that hold the same reasoning. ⚠ **What survives is the programme NAMES** — `**Stage:**
  away-from-demo-mode 6b` in `ISSUES.md`, `| **Stage** | away-from-demo-mode 9.2 |` in
  `DECISIONS.md`, "deleted in away-from-demo-mode Stage 1" in a comment. Those are correct and must
  stay: the programmes happened, and the stage number is how an entry says when. Renaming them to
  match a deleted directory would erase the only remaining index of which work belonged to which
  programme. `00-STATUS.md` records where the content went (D-30…D-45 / I-24…I-41 and D-46…D-59 /
  I-42…I-60) and that `git show bc72cc4:<path>` recovers either.

## Load-bearing facts

### The client's test suite

`pnpm --filter @foundry/client test` — vitest, added in Programme 3. **There were no client tests at
all before it**, which is how `use(params)` broke every flow page for two days while 400+ server-side
assertions stayed green: `e2e:ui` only speaks HTTP, `ui-honesty-check.sh` greps source, and every
vitest suite lived in `packages/server`. It starts on the pure data seam (`lib/adapters.ts` and
friends) where silent data loss lives; the rendering half is Stage 2's exit criterion and will want
`environment: "jsdom"`. `vitest.config.ts` mirrors the `@/*` alias — without it a suite reports
"0 tests", which reads like an empty file rather than a broken alias.

### A workspace's namespace slug

`workspaces.slug` + `tenant_slug` are the Kestra namespace `<prefix>.<tenantSlug>.<slug>`, and they
are **IMMUTABLE** — a renamed workspace keeps its namespace, or its deployed flows, approvals and
execution history detach from it. Four things:

- **`workspaceService.create` assigns both**, and it only started doing so in Programme 3 Stage 1.
  Before that they were set by migration `0010`'s one-time backfill and by nothing else, so **every
  workspace created through the product carried NULL for both and could never deploy a flow**
  (**I-35**). The symptom is badly placed: the workspace provisions perfectly — tools, datasource,
  queries, manifest, secrets — and fails only at the first deploy, with a 409 that reads like a
  Kestra problem.
- **A partial unique index enforces `(tenant_slug, slug) WHERE deleted_at IS NULL`.** `getBySlugs`
  resolves the pair to ONE row with `LIMIT 1`, so a duplicate is two tenants' flows in one namespace.
- **Slugification must stay byte-identical to migration `0010`'s regexp** — a backfilled workspace
  and a newly created one must derive the same namespace from the same name.
- `services/workspace-slug.test.ts` asserts the property that broke — *a new workspace can address a
  Kestra namespace* — not "the column is not null", which passes against `""`.

### Tether integration

Foundry → Tether is the only path to the runtime; the web container has no route to it. ⚠ **"Zero
Tether code changes are required" was true until 2026-07-31 and is no longer** — exactly one change
has been taken, in `agent-backend/server.js`, and it is described in "The one Tether change" below.
The bar stays high: nothing Foundry-specific, no API surface, taken on its own.

- `POST /api/run` reuses `sessionId` → **session = automation (durable), run = version.** Same
  session across regenerations, each run a new `seq` (v1, v2…) — *not* a new session per generation.
- The run-contract validator is **permissive** (ignores unknown fields); the assembler drops extras.
  Raw `RESULT.json` is snapshotted in artifacts, and **it is truth and lags the contract.**
- `POST /api/connectors` accepts a `url` → remote MCP (`transport: "http"`).
- Template **scaffold** seeds workspace files at spawn but **only when the workspace is empty, and
  never clobbers** — so it cannot refresh a manifest on a reused session.
- `/api/ws` streams `message` / `tool_start` / `tool_end` / `agent_end` / `question_request` (HITL) /
  `build_state`. There is **no** workspace file *write* API (GET-only).
- Env vars are `TETHER_BASE_URL` / `TETHER_API_KEY`; DB columns `tether_*`; JSON fields
  `tetherSessionId` / `tetherRunId`; `TetherClient` / `TetherError` in `services/tether-client.service.ts`.
  **No back-compat aliases** — a stale `ORBIT_*` var reads as an empty key and 401s.
- New runtime keys are minted `tth_live_…`, older `orb_live_…` still work. **Never validate a key by
  prefix.**
- Health: `GET /api/tether/health`. ⚠ `llmConnected:true` can be a false green — the probe only lists
  models.

⚠ **The `activeRuns` orphan defect is FIXED** (2026-08-03, upstream `f4ac654`, GAPS.md §7.1). It
used to read as a known defect here. Tether schema 21 adds `runs.owner_instance` and an `instances`
table; every process heartbeats every 15 s and reclaims, at boot, runs whose owner is provably gone
— **5 real orphans on the first boot**, all stuck at `running` since a restart. Two caveats travel
with it: the one-line version ("fail every non-terminal run on boot") is *worse* than the bug
because it kills a live sibling's runs, which is why the heartbeat exists; and this did **not** make
Tether multi-replica — `findRunBySession`/`cancelRun` still need the in-process handle, so HITL and
cancel work only on the owning instance. That limit is now *stated* rather than implied:
`POST /api/run/:id/cancel` returns a 409 naming `ownerInstance` instead of "run is not in flight".

### ⚠ The Tether changes — 2026-07-31 and 2026-08-03

**`../Foundry-Harness/` is NO LONGER unmodified**, and there are now **two** commits, so the
paragraph two sections up saying "zero Tether code changes are required" is superseded. The
write-up is **`../Foundry-Harness/plans/agent-step-run-contract.md`** (that repo gitignores
`plans/`, so the doc is local-only by its own convention; the commit messages carry the reasoning).
**All three defects are done**, plus the orphan reconciliation above. Five things are load-bearing:

- **The defect was data loss, not a status field.** `finalMessage` is `socket.getResult()`, the
  **last** assistant message, and the auto-finalize nudge (`server.js` ~1643) sends a turn *after*
  the agent has already answered. Worse, `handleStartTask` never calls `addUserMessage`, so
  `HeadlessSocket._ensureAssistant()` finds the last message is already the assistant's and
  **reuses it** — the answer was overwritten in the persisted transcript too. The fix captures
  `answerAtDone` before any post-hoc turn and records the nudge as a real turn.
- **This is I-24 on the runtime path** (Stage 6b moved only *generation* off Tether), and it fails
  the same way round: a run that genuinely wrote a script leaves a valid `RESULT.json`, is never
  nudged, and survives. Only correct *answer* runs were corrupted, so every generation-path test
  passed.
- ⚠ **It was never intermittent — 27 of 27 runs are nudged, both profile arms.** What varies is the
  nudge *reply*: tool-calls-only (25/27) leaves `.content` alone, text (2/27) overwrites it. That is
  the whole of the apparent randomness, and it is why `profileId` looked protective and is not.
  Read **I-34 round 3** before quoting any number from 8.3.
- **Defects B and C are DONE** (2026-08-03), together, in that order, and after A. `POST /api/run`
  takes **`expects: "script" | "answer"`**, defaulting to `"script"` — today's behaviour exactly.
  `"answer"` gets the profile's own skills with nothing merged in, **is never nudged**, and a clean
  completion is `succeeded`. Foundry's side is one field: `agentRunService` sends
  `expects: "answer"`. C after A was mandatory and was honoured — an accurate status over a
  still-corruptible payload reads `succeeded` with a refusal inside, and `needs_review` was the only
  reason anyone looked.
- ⚠ **`profileId` was never the mitigation, and `expects` is.** `skills: []` cannot remove a
  mandatory skill; this field can. Keep `profileId` — chat mode is the honest declaration — and
  **never quote it as suppressing `script-gen`** (I-34 round 3).
- ⚠ **An answer-run that says NOTHING is `needs_review`, not `succeeded`**, and an unrecognised
  `expects` is a **400** rather than a silent fall back to `"script"`. Both are the same rule from
  opposite ends: a field accepted and ignored reads as a field that works, and `succeeded` over an
  empty payload is the false green this whole defect is about, arriving from the other side.
- ⚠ **`outcomeOf` still tolerates `needs_review` and that branch must stay.** An older Tether
  ignores `expects` and returns it for every answer run, so deleting the branch is a version
  coupling on a runtime in a different repo and a different compose stack — and `needs_review` now
  *means* something on an answer run: it completed cleanly and the agent said nothing.
- **Measured as a matched pair on the live runtime**, same prompt and profile: `expects: "answer"` →
  `succeeded` with `[Run] no nudge` logged; the control → `needs_review` with the nudge logged.
  Both answered correctly. Without the control, the `succeeded` could have come from anywhere.

### Backup and restore — Stage 10.1

`scripts/{backup,restore,backup-verify}.sh`. `pnpm backup:verify` is the record — 16 assertions. Five
things are load-bearing:

- **Five databases share one instance and three are mutually referential.**
  `foundry_parent.flow_executions` points into `kestra`; `pg_dump` is consistent within a database
  and guarantees nothing across them. So **the default mode stops kestra, server and ops-api** and
  restarts them from an `EXIT` trap. `--online` warns and stamps `crossDbConsistent: false`.
  `hr_demo`/`hr_demo_alt` are excluded — reseedable from the CLI.
- **`CREDENTIAL_ENC_KEY` is never in the artifact; its fingerprint always is.** Both halves matter:
  key-beside-ciphertext makes every backup a credential compromise, and omitting it *silently* means
  a restore under the wrong key **succeeds** and fails hours later on the first secret read.
  `restore.sh` refuses on a fingerprint mismatch.
- **`roles.sql` carries SCRAM password hashes** (roles are cluster state and no per-database dump
  has them). Artifact dir `0700`, the file `0600`, `backups/` gitignored.
- **Never bind-mount an output directory into a `docker run`** — the daemon resolves it against its
  own filesystem, which under Snap Docker is a private `/tmp`, so the write lands nowhere and exits
  **0**. That is I-15, and it silently dropped `kestra-storage.tgz` from the first real backup. Both
  scripts stream tar over stdin/stdout instead.
- **`pnpm backup:verify` is 16 assertions and it PASSES** — restore beside the live databases, the
  live ones untouched, six tables round-tripped, cross-database pointers resolving, both refusals
  firing. ⚠ **Run it after any schema or infra change, and never delete its last assertion**: the
  negative control perturbs the *restored* copy and requires the comparison to notice, because
  `pg_restore` exits 0 against an empty database and the other fifteen would report green forever.
  It is sequenced last on purpose (the perturbation would corrupt the pointer check) and reports
  **INCONCLUSIVE and fails** if the perturbation cannot happen.

⚠ **`DEMO_DBS` in `backup.sh` must gain every new demo database** — it is now
`hr_demo hr_demo_alt finance_demo legal_demo`. One in neither the core nor the demo list is silently in no
backup at all, and the omission is invisible: the artifact's manifest names what it *has*, never what
it skipped.

⚠ **`itops_demo` WAS NOT IN THAT LIST AND WAS THEREFORE IN NO BACKUP — CLOSED 2026-09-04.** It was
created 2026-09-03, recorded here as owed, and then not done for a day. `DEMO_DBS` is now
`hr_demo hr_demo_alt finance_demo legal_demo itops_demo support_demo orders_demo hiring_demo` —
eight, and the comment above it in `backup.sh` names this incident so the next omission has a
precedent to read.

⚠ **`backup-verify.sh`'s negative control picks its subject at RUNTIME** (I-38). It named
`flow_executions`, and `slate:clear` emptying that table made the control INCONCLUSIVE — which
correctly failed the run rather than passing on a perturbation that never happened. It now takes the
first round-tripped table that holds rows. **Do not re-hardcode a table name**; the trap just moves to
whichever one is emptied next.

⚠ **Redis is GONE** (2026-08-03, `docs/GAPS.md` 6.4 — the entry said "trivial, deliberately
deferred" and this is the commit it was deferred to). Measured before removing: `DBSIZE` 0, no
`redis`/`ioredis` dependency in any `package.json`, `config.redisUrl` defined once and read by
nothing. Removed the service, the volume declaration, `REDIS_URL` from the compose environment and
from `.env.example`, `config.redisUrl`, and the Redis line from `backup.sh`'s `notCovered`.

**Why removing beat leaving it.** A healthy container is the most convincing possible evidence of a
working dependency — it answered `PING`, `depends_on` made the server wait for it, and `REDIS_URL`
sat in the server's environment. Every signal a person or a check could look at said "in use"; the
only thing that said otherwise was a grep nobody had a reason to run.

⚠ **`kestra:check`'s "Foundry redis" DENY probe was replaced, not deleted** — and it had stopped
being a control twice over. With Redis gone the hostname does not resolve, so it would have passed
because there was nothing there (I-38: a control that cannot fail is worse than none); and Redis
never spoke HTTP, so `curl` could not have told "no route" from "connected and got nothing" even
before that. It now probes **`http://ops-api:4004/healthz`** — a live HTTP service on `default` and
not on `kestra-net`, holding the outbox, the tickets, the call log and the one billable outbound
credential in the stack. Verified at the wire in both directions: **200** from the parent container,
**000** from Kestra.

⚠ **The volume was NOT deleted.** `infra_foundry_redisdata` is now an orphan Compose ignores
(holding an empty appendonly file); reclaim it with `docker volume rm infra_foundry_redisdata`.
A compose edit that silently deletes a volume is the wrong default even when the volume is empty.

**Not edited: `docs/kestra-migration/03-architecture.md`**, which still lists `redis :6380` and
denies Kestra a route to it. That file is the **pinned design** and implementation does not edit it.

### Security posture

- **Datasource credentials are read-only.** Generated scripts get **`foundry_ro`** — `CONNECT` +
  `USAGE` + `SELECT`, nothing else — created by `demo/hr-roles.ts` during seeding. The owner
  credential stays parent-side for DDL, seeding and `demo:reset`, and is never encrypted into
  `datasources`.
  - `ensureReadOnlyRole()` must run **after** the DDL — `hr-schema.sql` drops every table, and table
    privileges die with the table.
  - The primary control is the **absent grants**, not `default_transaction_read_only`. Verified: a
    script issuing `SET transaction_read_only = off` and then writing still gets `InsufficientPrivilege`.
  - `REVOKE CREATE ON SCHEMA public FROM PUBLIC` is load-bearing on PG ≤14, where `public` grants
    CREATE to PUBLIC and `foundry_ro` could otherwise create — and then own and write — a table.
  - **`REVOKE … FROM <role>` does NOT remove a privilege held via the pseudo-role `PUBLIC`.** Revoke
    from `PUBLIC` first. This bit twice: once in the demo roles, once in the Kestra DB boundary (I-04).
  - The RO password is **derived** from `CREDENTIAL_ENC_KEY`, not random per seed: `demo:reset`
    reseeds without re-registering the datasource, so a rotating password would silently invalidate
    the stored DSN. Set `DEMO_DB_RO_PASSWORD` to rotate deliberately.
  - Introspection runs **as `foundry_ro`**, so the manifest is exactly the script's visible surface.
  - `demo/hr-roles.test.ts` (12 tests) and `demo:verify` both assert privileges from `pg_catalog`.
    Both were confirmed to FAIL on a deliberate `GRANT UPDATE` regression.
- ⚠ **The read-only gate connects from the REGISTERING process, so it needs `verifyVia`** (D-44,
  caused by **I-36**). A stored DSN is container-facing (`host.docker.internal:5433`); every `demo:*`
  and `finance:*` provisioner is a HOST process, where that name does not resolve on Linux — so the
  gate refused a demonstrably read-only credential and **`pnpm demo:seed` was broken outright from
  the day Stage 9 landed until Programme 3 Stage 1.** `verifyVia` supplies the DSN to *dial*, and
  `assertSameCredential` requires it to differ in **host and port only**. It is a function argument
  and **must never become a field on `createDatasourceSchema`** — that would turn the gate off from
  outside. Same split as `OPS_API_BASE` / `OPS_ADMIN_BASE`; the rule is that a value which is *stored*
  must resolve for its future reader and a value *used now* must resolve for the current process.
- ⚠ **A datasource is also refused for WHERE it points, and the address is not how that is decided**
  (D-64, GAPS.md §1.3 — this used to read "still open"). D-40 asks what a credential can *do*;
  a **read-only** credential on `foundry_parent` passed it with zero findings, and that is precisely
  the credential needed to read every workspace's secrets and encrypted DSNs. Registration now asks
  the target **who it is**, over the connection being registered — `(system_identifier,
  current_database())` against Foundry's own, plus a table-name signature for the parent, Kestra and
  ops-api databases. The parent signature is **derived from `db/schema.ts`**, so a rename tracks it.
  It runs **before** the privilege check, because running D-40 first yields a clean verdict on the
  one target that must never be stored.
  - **The `(cluster, database)` PAIR, never the cluster** — five databases share one instance here,
    so a cluster-level refusal takes `demo:seed`, `finance:seed` and the sandbox with it. Measured:
    every tenant database scores **0** on all three signatures; `foundry_ops` 4, `kestra` 8,
    `foundry_parent` 21. `kestra` and `foundry_parent` each score 2 against the *other's* signature
    (`flows`, `triggers`), which is why no threshold is 1.
  - ⚠ **`DATASOURCE_HOST_ALLOWLIST` is the WEAKER half and must never be called the control.** Unset
    it cannot fail; set, it is walked past by spelling the same database differently. It is `null`
    when unset rather than `[]`, and a test asserts that satisfying it does **not** rescue the
    control plane.
  - **Still open (§1.3b):** what a tenant may point Foundry at *beyond* "not at Foundry" — a third
    party's database, an internal service on the deployment network. The mechanism exists; the
    policy needs an answer to what a tenant is, which is §1.1.
- ⚠ **`/stub-api/*` was unauthenticated and is gone.** Every ops-api route authenticates, across all
  four auth styles, and `kestra:check` asserts the LLM route 401s without a credential. The old
  argument — "one broken credential should not take the whole demo down" — was a reasonable trade for
  routes inside the parent and the wrong one for a service on a port.

### Tool authentication

Secret VALUES live in **`workspace_secrets`** (name → encrypted value, per workspace). `tools` and
`datasources` reference an entry by its **env-var name**, which is also what the manifest renders —
one identifier, so manifest / prompt / `-e` flag / row cannot disagree.

- `tools.auth_style` (`bearer|header|query|basic|none`) + `auth_param_name` render as
  `<auth style= name= env=/>`, and the prompt documents the four styles **once**.
- **A name collision fails the step (409)** rather than last-write-wins — a shadowed credential must
  present as a wrong key, not as a silent misconfiguration. Two tools sharing one secret is *not* a
  collision.
  ⚠ **This bullet described a control with NO CALL SITE from Kestra Phase 4 until 2026-08-10**
  (**I-120**), and it also said *"secrets are injected at execution"*, which stopped being true when
  that phase deleted `execution.service.ts` — a `code` fragment gets no environment at all. The
  refusal lived in `resolveForExecution`, whose only production caller is the **audit**, so the
  collision half was a number nothing acted on and `invokeTool` resolved its secret inline with no
  cross-declaration comparison. **The fix was the call site, and the prose second** — correcting this
  bullet first would have made the claim true and the behaviour unchanged, which is worse than the
  original state because it removes the evidence.
  - **The refusal now lives in `invokeTool`** (`services/step-execution.service.ts`) via
    `shadowedSecretCollisions`, checked **before** the value is decrypted and used — a refusal that
    fires after the request has gone out is a log line, not a control. It is scoped to the one name
    that step needs, so it neither refuses a batch over a credential the step never touches nor reads
    the workspace's other credentials to decide.
  - **`declarationsIn` + `dedupe` are the ONE definition** of what declares a name and what counts as
    disagreement, shared by the audit and the refusal. A test asserts the scoped answer equals the
    audit's for the same name: two implementations would drift in the direction where the cheap one
    says no, which is the direction that fails silently.
  - ⚠ **Two TOOLS at different values is UNREACHABLE, so the reachable collision is tool-vs-datasource.**
    Every tool resolves through `workspaceSecretRepo.getByName(workspaceId, envName)` — the same row —
    so two tools always contribute an identical value. A datasource's value is its own encrypted DSN
    and is never looked up in this store, which is why *it* can disagree. `checkpoint.md` 1.1 asked
    for a tool-vs-tool test; that state cannot be created without fabricating it.
  - **A collision reports one entry per disagreeing DECLARATION, not per name** — three declarations
    of one name where one disagrees with two yields two entries. A report naming only the first would
    leave the second shadowed after the first was fixed. Do not assert the count as a constant.
  - **The guard against this recurring is a test that reads `step-execution.service.ts` off disk** and
    requires `shadowedSecretCollisions` to appear in it, with a control (source length > 1000, and
    `invokeTool` present) so a renamed file cannot pass by reading as an empty string. Same idiom as
    the `TETHER_API_KEY`-in-three-files assertion. **A correct detector nothing calls is what I-120
    was, so the detector's own tests cannot close it.**
- **`sandbox_value_enc`** is used at generation when set, so a production key need not enter an agent
  workspace. Caveat: with a sandbox key, `endpoint_connectivity` passing does not prove production
  connectivity.
- **All 15 SIMULATED tools authenticate**, across **seven** ops-api services and all four styles.
  ⚠ This said SIX until 2026-09-03: `paging` was added for the IT Operations domain, and
  `routes/ops.ts` now serves **16** operational endpoints rather than 14. The DEMO catalogue is
  still 15 tools and `demo/tool-catalogue.test.ts` still correctly asserts 15 — what changed is the
  number of services, not that catalogue. Each service accepts
  exactly ONE style and rejects the others *even when the value is right*, because an endpoint that
  accepts every style cannot detect a wrong guess — the outcome worth seeing is
  `presented: true, ok: false, via: <where it arrived>`, recorded in `api_call_log`.
  ⚠ The values are **derived** from `OPS_API_KEY` on both sides (`opsServiceKey`), deliberately
  duplicated rather than shared: that drift is *loud* (the first call 401s naming the service) while
  redaction drift is *silent*, which is why only `redactSecrets` became a package. See D-33, and
  **I-26** for the time a correct credential in the correct header 401'd anyway.
  ⚠ **Fifteen is the count of the *demo* catalogue, and it is no longer the count of every tool a
  workspace has.** `foundry_email_send` (email-send-tool, D-74) is a **sixteenth**, registered from
  `services/platform-tool-catalogue.ts` rather than `demo/tool-catalogue.ts` — it is a product
  capability, not demo data, so it exists in every workspace whether or not a seed was ever run. It is
  the one tool that does NOT point at ops-api: it calls Foundry's own `POST /api/mail/send`, which
  really does deliver to a mailbox via Microsoft Graph. `demo/tool-catalogue.test.ts` still asserts
  15, correctly — that test is about the demo catalogue.
- **`redactSecrets()` is load-bearing:** a key sent as `?api_key=…` was being written verbatim into
  `api_call_log.query`. It redacts credential-shaped *keys*, so it holds for params not yet thought
  of. **Never remove it to "debug" a 401.**
- `GET /api/workspaces/:ws/secrets/audit` → `{configured, missing, collisions}`. There is
  deliberately **no endpoint that returns a secret value**, and no `?reveal=`.

### Introspection

- `datasources.schema_allowlist` (default `["public"]`) replaced the `table_schema='public'` hardcode.
  An allowlist, not "all non-system schemas" — the manifest is already ~60% of the generation prompt.
- Entity kinds are real (`table|view|materialized_view|foreign_table`) from `pg_class.relkind`. Views
  render `kind="view"` and **no** row estimate.
- **FKs come from `pg_constraint.conkey/confkey` with `unnest(...) WITH ORDINALITY`, not
  `information_schema.constraint_column_usage`** — the latter returns the *cartesian product* of a
  multi-column FK's columns, so a 2-column FK mispairs its references. **Do not "simplify" this back.**
- `reltuples = -1` → `null`. Enum/array columns carry `udt_name`; MySQL uses `COLUMN_TYPE` so an enum
  shows its members.
- The `schemas` unique key includes `entity_schema` — without it `hr.staff` and `public.staff`
  collide, i.e. it would fail the first time anyone used an allowlist.

### The workspace manifest

⚠ **`<param>` carries its DESCRIPTION, and until Programme 3 it did not** (**I-40**). Every tool has
carried per-parameter prose since it was written and the manifest rendered only `name`/`type`/
`required`, so not one had ever reached a model — which is why the tool-level descriptions had grown
to explain their own parameters. The check that made it safe to change is the one to repeat for
anything touching manifest XML: `refFingerprints()` hashes `paramsSchema` **whole**, so rendering
more of it changes the manifest's own hash (a new version — correct) and moves **no ref fingerprint**
(measured: 0 across all workspaces). Had it moved them, the sweep would have suspended every armed
flow everywhere.

⚠ **A tool's `paramsSchema` is the FLAT `{name: {type, required, description}}` map**, not a
JSON-Schema `{type, properties}` envelope. `manifest-builder` iterates `Object.entries` and reads the
fields off each value, so an envelope renders two nonsense params called `type` and `properties`.
The client's edit form used to write the envelope, and also **stripped every description on save** —
which changed the fingerprint and disarmed the flows using that tool (**I-39**). `lib/tool-params
.test.ts` pins the round trip as an identity.

Single source of truth for tools + datasource schemas + constraints, versioned and hashed. Delivered
**summary-always inline**, with the **full manifest inline only on the run where it changed** (the
agent then overwrites `.foundry/manifest.xml`). Because scaffold never clobbers, this in-prompt
rewrite is what keeps a reused session's manifest current.

### Generation — measured behaviour

These are measurements, not estimates. The migration is designed around them.

- **Reliability: 1 of 3** scenarios achieved its primary objective first-pass on
  `google/gemma-4-26B-A4B-it`. Recurring failure modes: fabricated dates, invented enum values,
  guessed response field names, missing `COALESCE` to a policy default in hand-written SQL.
  **Do not assume a generated script is correct.**
- Feeding the specific error back **fixed it every time** — continuation prompts are ~800 chars
  against a cached prefix. The working loop is *generate → execute → read `api_call_log` → feed the
  error back*.
- **Prompt block order is load-bearing.** `TASK` is **last**, after the manifest, so the ~8.3 KB of
  boilerplate forms a stable cacheable prefix (measured: shared prefix 292 → 8,322 chars, 4.4% → 95%).
  **Do not move `TASK` back up** or interpolate anything run-specific into earlier blocks.
- **Prefix caching is real but does NOT reduce tokens.** Measured: unseen 6.3k-token prefix ≈1.4 s,
  repeat ≈320 ms, `prompt_tokens` **identical**, no `cached_tokens` field. The reorder buys
  **latency, not cost** — and the boilerplate is a real ~33% token increase. Never call it "N× cheaper".
- **Generation is decode-bound at ~37 tok/s.** ~8–10k output tokens ⇒ **5–6 min is normal, not a
  hang**; three concurrent runs take ~6–7 min each. Prompt-side work touches only the ~1.4 s prefill,
  so it will **not** make generation feel faster.
  ⚠ **Those token counts are the MONOLITHIC path's and it is deleted.** Re-measured 2026-08-03 on
  the flow path: a draft is **900–1,200** completion tokens at ~35 tok/s, so **one attempt is
  ~20–30 s**. A five-minute generation today is not one slow call — it is three attempts plus
  fragments, and `draft:measure` will say which. The half that still holds is the conclusion:
  prompt-side work buys prefill, and the only way to make a draft cheaper is to emit less.
- `RESULT.json` requires a **`warnings[]`** array plus the `schema_alignment` and
  `endpoint_connectivity` categories. The parent had been reading the latter two without ever asking
  for them, so they were structurally always NULL.
- `generation-audit.service.ts` verifies **plausibility, not correctness** — it marked a script
  `clean` that emailed 0 of 11 people. Never present it as a quality gate. (Being deleted; see above.)

### Trigger gate

A trigger may be enabled only when its bound **flow** has completed at least one successful run
(`triggerService.enableReadiness()`). So the sequence is **author → test-run once → then arm.**
⚠ The wording used to name `scripts` and `execution_results`; both tables were deleted in Phase 4 and
`trigger-gate.test.ts` was rewritten against flows. The property did not change.

**An enabled trigger means "it ran once", NOT "it ran correctly."** Only the oracle shows correctness.
Do not present the green "Ran successfully" chip as a quality gate.

⚠ **Since 2026-08-04 gate 1 has a second half, and it moved that sentence rather than deleting it**
(GAPS §2.3, **D-68**). A flow may declare **expectations** on its model — `rowCount`, a `field` on
the output, or a predicate over `every`/`none` of the rows — and gate 1 additionally requires each
to have held on a succeeded run. Five things:

- **A flow that declares nothing is unchanged.** Opting in is the mechanism; a day-one refusal is a
  control everybody routes around (D-52's argument).
- ⚠ **An expectation is NOT an oracle.** It is written by whoever wrote the flow and can be wrong in
  the same direction. It catches the *hardcoded-date* failure — a flow drifting from its author's
  stated intent — and **not** the units trap. Never call a passing expectation a correct run;
  `ui-honesty-check.sh` fails if either screen showing one drops that caveat.
- ⚠ **`unevaluable` does not satisfy the gate.** A step whose output could not be read as rows is a
  claim nobody checked, and it must not read as one that held (I-38) nor blame the flow.
- **The gate is keyed on the CLAIM's content**, not the revision — so rewording a description
  re-blocks nothing and changing a number does. `description` is out of the hash for that reason.
- **Evaluation reads the REDACTED view**, which is a security property: an expectation is a
  predicate a tenant can re-run at will, so `contains` over unredacted output would read a
  credential out one character at a time.

- `createTriggerSchema.enabled` defaults to **false** (it was `true`, so a client omitting the field
  armed the trigger).
- `triggerService.fire()` **rethrows** the status code, so "Fire now" on an ungenerated automation is
  a 409, not a 202 carrying an `error` field. The `trigger_fires` row is still written first.
- **Known bug, deliberately unfixed:** the H.1 three-layer type inconsistency — a trigger created as
  **Email** reloads as **Webhook**. Triggers are rewritten in migration Phase 3; don't fix the old
  bug, just don't reproduce it.

### Executor — ⚠ this section is HISTORY

`execution.service.ts` and `runDocker` were **deleted in Phase 4**. Nothing in `packages/server`
spawns a subprocess of any kind now, and its image has no Docker CLI and no socket (D-28). A `code`
step runs as a sibling container started by **Kestra**, not by the API server. The one item that
survives:

- `packages/server` **`build` copies `src/demo/*.sql` into `dist/`** — `tsc` doesn't, and the
  Dockerfile only copies `dist/` + `drizzle/`.

The stdin bug and the privilege-refusal message are kept in `ISSUES.md` history only; do not go
looking for the code.

---

## Environment gotchas

- **`.env` changes need `docker compose up -d`, not `restart`** — `restart` reuses the old environment.
- Compose secrets come from `../.env` via `env_file`. **Do not re-declare them under `environment:`
  with `${VAR}`** — Compose looks for its `.env` next to the compose file (`infra/.env`, absent), so
  `${VAR}` resolves to empty and blanks the value `env_file` just loaded.
- Tether runs in a **separate compose stack** and is reached via `host.docker.internal:6800`.
- **`OPS_API_BASE` and `OPS_ADMIN_BASE` are two knobs on purpose.** The first is *stored on a tools
  row* and must resolve for whoever later reads it (`host.docker.internal:4004`); the second is used
  *immediately* by the evaluating process, which is a HOST process for every `demo:*`/`kestra:*`
  harness — and `host.docker.internal` does not resolve on a Linux host. Sharing one value breaks
  every harness with `fetch failed`. `scripts/kestra-env.sh` also exports `OPS_API_KEY` out of the
  running container, so a host harness derives the same six credentials the server does.
- **`LLM_*` are a FALLBACK, not the configuration.** The live provider for `llm_complete` is a row in
  ops-api set through `/ai-provider`. Both containers load the same `../.env`, so `LLM_API_KEY` is
  visible in the server's environment too — that is a property of one secrets file, not a decision.
  What is pinned is that `packages/server` reads it in **`config/index.ts` and nowhere else**
  (`kestra:check`), so it reaches the generation seam and cannot acquire a second consumer.
- ⚠ **THERE ARE TWO MODEL SETTINGS AND THEY ARE DELIBERATELY SEPARATE (D-35), AND THIS HAS NOW CONFUSED
  A USER TWICE.** `/ai-provider`'s tool panel sets the model behind **`llm_complete`** (a row in
  ops-api). **Generation reads its own row** — `GET|PUT /api/generation/llm/provider`, backed by
  `generation_llm` (D-115, migration `0031`) — and when that row is empty it falls back to
  **`LLM_REASONING_MODEL ?? LLM_FAST_MODEL`** in `config/index.ts`. So setting the model on the panel
  most people find changes `llm_complete` and **not** drafting.
  - D-115 was created by the report *"I changed to 5.4-mini for better speed and it is still slow"* —
    measured at the wire then, with the ops-api row saying `gpt-5.4-mini` while generation carried on
    running gemma. ⚠ **It recurred on 2026-08-11 from the other end**: `generation_llm` was **empty**
    (`source: "environment"`, `updatedAt: null`) on a deployment whose tool model had been set, so every
    draft ran on the slow model and the panel looked correct.
  - ⚠ **The difference is nearly 4×, and it is measured, not estimated.** On a 900-token completion
    through this gateway: `google/gemma-4-26B-A4B-it` **23.7 s / 38.0 tok/s**; `gpt-5.4-mini` **5.8 s /
    147.7 tok/s**; `gpt-5-nano` 134.0; `gpt-5.4-nano` 107.3. A draft is 900–1,200 completion tokens and
    generation is **decode-bound**, so the model choice is the largest single lever on how long
    authoring takes. ⚠ **`gpt-4o-mini` and `Qwen/Qwen3.6-35B-A3B-FP8` are offered by the gateway's model
    list and BOTH ERROR when called** — which is what the endpoint's own caveat says (*"a model list only
    proves the gateway answered a GET"*). Use the panel's test button.
  - ⚠ **Changing it requires a SIGNED-IN USER, not the API key** — the route refuses with *"changing this
    needs a signed-in user. The API key authorises the request; it does not name a person"* (D-39),
    because it records `updated_by`. **Do not mint an identity with `RUNTIME_JWT_SECRET` to do it from a
    script**: that records a config change against a person who did not make it.
  - ⚠ **Every generation measurement in this repo was taken on gemma — UNTIL 2026-08-27.**
    `kestra:refusal`, `outline:measure`, `draft:measure`, `chat:measure` and `propose:measure` are all
    model-specific. **Changing the model owes a re-take, and each number must record the model beside
    it.**
    - ⚠ **This deployment resolves `gpt-5.4-mini`, not the env's gemma.** `generation_llm` carries a
      `/ai-provider` override, so `config.inference.model` (`google/gemma-4-26B-A4B-it`) is **not**
      what drafts. Every number taken on 2026-08-27 is `gpt-5.4-mini`. Read
      `resolveGenerationProvider()`, never the env var — printing the env's model beside a number the
      override produced files it under the wrong model's name, which is worse than leaving it off.
      ⚠ **`refusal-verify.ts` and `outline-measure.ts` printed no model at all** until 2026-08-27;
      both now print the resolved one.
    - ⚠ **gemma was DOWN on 2026-08-27** and a run against it produced *"1 attempt, then a failure"* —
      which is indistinguishable from the model behaving badly. A gateway failure that looks like a
      measurement is the worst output a harness has; **`draft:measure --model=<name>`** exists so a
      cross-model comparison needs no change to `generation_llm`, and the credential still comes from
      `config.inference` alone (D-35: this seam gains a *model*, never a credential).

## The guardrail infrastructure port (2026-08-12)

A separate, unrelated-history branch (`krt/guardrail_validation`) had built a "Validation &
Guardrails" programme (V1–V8) against a different product shape (standalone Python script
generation, no `flows`/Kestra domain). Feature `20260812-075013-guardrail-infra-port` ports the
four slices of that work that are generic and not coupled to script-generation — V1 (validation
kernel), V3 (rate limits/abuse controls), V6 (egress/SSRF policy) and V7 (shared client+server
validation package) — into this codebase as new, additive infrastructure. V2 (auth), V4/V5/V8
(prompt-boundary, generation audit, request-policy) are explicitly deferred: they're built around
auditing a generated script's task prompt, and this codebase's generation surface
(`flow-chat`/`flow-generation-job`) needs its own design pass before those concepts transfer.
Full reasoning: `specs/20260812-075013-guardrail-infra-port/{spec,plan,research,tasks}.md`.

**The single biggest planning finding: FR-006 (concurrency ceilings on flow generation and
execution) was already fully implemented, three times over, before this feature touched anything.**
`flow-chat.service.ts` (`MAX_CONCURRENT_CHAT_TURNS` per workspace, plus a 409 for a second turn on
one thread), `flow-generation-job.service.ts` (`MAX_CONCURRENT_GENERATIONS = 3` per workspace), and
`routes/executions.ts` + `tenant-budget.service.ts` (the M3 budget, `POST …/executions/begin`) all
independently refuse immediately, never queue, and are all already tested. This feature adds **no**
fourth ceiling — building one would either sit in front of the existing checks doing nothing, or
create a second refusal path for the same resource that can disagree with the first. **Do not
"fix" this by adding a generic rate limiter over flow generation/execution** — read
`specs/20260812-075013-guardrail-infra-port/research.md` Decision 5 first.

**V1 — validation kernel.** `packages/shared/src/validation/index.ts`'s `validate({params, query,
body})` factory closes two measured gaps only — `routes/catalogue.ts`'s unchecked `workspaceId` and
`routes/ops-proxy.ts`'s `/llm/provider|models|test` manual coercion — and does **not** retrofit the
~20 routes already validating inline with `zod`, which already satisfied the intent. On mismatch it
calls `next(zodError)`, flowing through `error.middleware.ts`'s pre-existing `ZodError` branch — one
response shape, not two.

**Request id and the error-leak fix.** `middleware/request-id.middleware.ts`'s `requestId` is
mounted first in `app.ts`, always server-generated (`crypto.randomUUID()`, never trusted from a
caller's `X-Request-Id` header), and surfaced via `req.id` + the `X-Request-Id` response header.
`error.middleware.ts`'s `statusCode >= 500` branch and its untyped fallback branch used to echo
`err.message` verbatim — real exposure, since `flow.service.ts:240`'s `` Kestra rejected the
compiled flow: ${JSON.stringify(e.body ?? e.message)} `` is exactly that shape. Both branches now
return `{ error: "upstream_error" | "internal_error", requestId }` only; the real message is still
`console.error`'d server-side, tagged with the same id. **The `ZodError`/`TetherError`/4xx branches
were not touched** — none of those leaked and none needed to change.

**V3 — auth-failure throttling** (the one part of FR-005/FR-007 this codebase genuinely lacked;
everything else FR-005 asked for is the pre-existing ceilings above). `middleware/auth.middleware.ts`
exports one `authFailureThrottleInstance` (`@foundry/shared`'s `authFailureThrottle`, in-memory,
per-IP, 20 failures/60s), shared with `identity.middleware.ts`'s `resolveIdentity` failure branches —
a caller's failures against either check count toward the same throttle. Every failure is logged
with IP + path + timestamp, never the presented credential value. Throttled requests get 429 +
`Retry-After`; a single failure is still a plain 401. Per-process in-memory is deliberate — this
server runs as one process today (no `deploy.replicas`, no clustering), so a restart clearing the
throttle is an accepted tradeoff, not a gap.

**V6 — egress/SSRF policy.** `packages/shared/src/egress/index.ts` generalizes
`datasource-target.service.ts`'s existing `NEVER_A_DATABASE`/`_addressClass` classifier — that file
is **not modified**; it keeps its own separate, already-tested, deliberately-permissive check
(loopback and RFC 1918 allowed, because this deployment's demo databases live there). The new module
exposes two profiles: `STRICT` (denies loopback + link-local + RFC 1918) applied to the three
genuinely open gaps — poll trigger firing (`trigger-scheduler.ts`'s `_tick`), tool endpoint
invocation (`step-execution.service.ts`'s `tool()`), and the ops-proxy LLM `baseUrl` write path
(`routes/ops-proxy.ts`'s `PUT /llm/provider`) — and `PERMISSIVE`, byte-for-byte equal to
`NEVER_A_DATABASE`'s behavior (datasource registration keeps its own implementation).
**Do not extend `STRICT` to datasource connections** — that would break
`demo:seed`/`finance:seed` on day one; see Decision 2.

⚠ **Two sentences here were wrong and are corrected rather than deleted, 2026-08-14.**

- It said `guardedFetch` **closes** the DNS-rebinding gap. **It narrows it.** The check resolves the
  host, and then `fetch` resolves it AGAIN to open the socket — so the address classified is not
  provably the address dialled. Closing it needs the check at connection time (an `undici` dispatcher
  with a `connect`/`lookup` hook, or dialling the checked IP with Host/SNI preserved); `undici` is
  not a dependency and Node's global `fetch` exposes no such hook. `guardedFetch`'s own docblock now
  carries a **⚠ WHAT THIS DOES NOT DO** block, and `egress.test.ts`'s last `describe` was renamed off
  the stronger claim. What IS closed outright: **every alternate encoding of a reserved address**
  (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `::ffff:127.0.0.1`, …) via `canonicalizeHost`,
  and an **unresolvable host under STRICT**, which now fails closed. Both were reachable in a single
  request with no rebinding race at all — the literal bypass was the real hole, and the rebinding
  window was the smaller half.
- It said `PERMISSIVE` is *"kept for documentation but not called by anything"*. Since **D-32**
  (2026-08-13) `step-execution.service.ts`'s `tool()` calls it — a registered tool endpoint resolves to
  `172.17.0.1` on this stack and STRICT egress-rejected every call. So one of the three STRICT call
  sites is now PERMISSIVE, and **tool-endpoint SSRF is out of scope for V6** until "tool endpoints on
  private addresses" has a different answer.

⚠ **`STRICT` gained two ranges and a fail-closed rule** (2026-08-14): CGNAT `100.64.0.0/10` and IPv6
ULA `fc00::/7` are now `rfc1918`, IPv6 multicast `ff00::/8` is `multicast`, `deniesLinkLocal` is
actually honoured (it was ignored — link-local was unconditional), and `allowsUnresolvable` is a
profile field: **STRICT refuses an unresolvable host, PERMISSIVE does not.** A resolver failing at the
instant of a dial-time check is indistinguishable from one being made to fail; a registration-time
refusal on a DNS blip is recoverable, a dial-time ALLOW is not. `100.63.255.255` and `100.128.0.1` are
outside the CGNAT block and stay allowed, with tests saying so.

⚠ **The two classifiers are NOT merged, and that is now pinned by a test.** One caller needs loopback
allowed and another needs it refused, which is exactly what the two profiles are — so
`services/egress-parity.test.ts` asserts they agree on link-local / unspecified / broadcast /
multicast, agree that loopback and RFC 1918 are *allowed* under `PERMISSIVE`, and **disagree** under
STRICT, with a control that each classifier can produce both answers. Duplicated regex drifts in the
direction where the untested copy stops matching and nothing reports it.

**V7 — shared validation rules.** `packages/shared/src/rules/index.ts` exports `ENV_NAME_RE` and
`AUTH_STYLES`, closing a duplication risk the client's own code had already flagged in comments:
`secret-edit.ts` and `tool-edit.ts` each independently defined `ENV_NAME_RE`, and `tool-edit.ts`
carried a documented MIRROR of `tool.service.ts`'s `AUTH_STYLES`. **A third, previously-unknown,
undocumented copy was found during implementation**: `app/(app)/keys/page.tsx` had its own
`ENV_NAME_RE` (`/^[A-Z][A-Z0-9_]{0,63}$/`) — stricter than, and actually wrong relative to, the
server's real rule (`workspace-secret.service.ts`'s `/^[A-Za-z_][A-Za-z0-9_]*$/`), so it silently
rejected some env names the server would have accepted. All three client copies plus the server's
`AUTH_STYLES` now import from `@foundry/shared` instead of maintaining their own definitions.

**Package shape.** `packages/shared` mirrors `packages/redact` exactly — `"type": "module"`,
`NodeNext`, raw `tsc` build, `declaration: true`, tests excluded from the build — and is in root
`postinstall`'s build-order list alongside `@foundry/redact`/`@foundry/flow-edit`. `@foundry/server`
and `@foundry/client` both depend on it as `workspace:*`.

**Known pre-existing gaps, unrelated to this feature, found and left alone during implementation:**
the local Postgres container is behind on migrations (`column "slug" does not exist` — 17 test files
fail on this across the whole server suite, same failures with or without this feature's diff); the
client package has no ESLint config at all (`next lint` prompts for interactive setup); and
`packages/client`'s Vitest run reports 17 unhandled `TypeError: webidl.util.markAsUncloneable is not
a function` errors from a jsdom 30 / undici 8.9 / Node 20 version mismatch (`engines` wants `>=22`) —
all 351 tests still pass; `pnpm -r test` exits non-zero anyway because Vitest treats the unhandled
teardown error as a process failure regardless. None of these are this feature's to fix.

⚠ **TWO OF THOSE THREE ARE CLOSED as of 2026-08-18** and the paragraph above is kept as written
because it is the record of what was true then. Verified at the database and at the wire:

- **The migration gap is GONE.** `drizzle.__drizzle_migrations` holds **39** rows against **39**
  journal entries, its watermark (`1786800000000`) equals the journal's max `when`, `workspaces.slug`
  and `tenant_slug` both exist, and `tsx src/db/migrate.ts` is now a genuine **no-op** — run twice, the
  count stays 39, so the `_journal.json` rewrite trap documented at the end of this file no longer
  bites this database. **The server suite is `84 files / 1193 passed / 0 failed`.**
  - ⚠ Its **23 skips are deliberate and loud**, not the old failures in disguise: they are
    `swap-rehearsal.test.ts`, whose guard prints `SKIPPING swap rehearsal — workspace "HR (alt — swap
    rehearsal)" not provisioned — run \`pnpm demo:seed-alt\``. A skip that names its own fix is the
    honest form; do not read the green count as covering the rehearsal.
- **The jsdom/Node gap is GONE** — see "The client's whole rendering test layer was DEAD" at the end of
  this file. It was worse than this paragraph knew (**21** files, not 17 errors, and none of them ran).
- **The client ESLint gap is still open.** Untouched.

## The guardrail infrastructure port, continued — V2/V4/V5/V8 (2026-08-12)

Feature `20260812-101032-guardrail-v2-v4-v5-v8` picks up the four slices the port above deferred.
Full reasoning: `specs/20260812-101032-guardrail-v2-v4-v5-v8/{spec,plan,research,tasks}.md`.

**V5 — nothing to build, only to record.** The source branch's V5 audited a generated script's
`RESULT.json` for plausibility (`generation-audit.service.ts`, deleted in the Kestra migration's
Phase 4 — see "The monolithic path is DELETED" above). Its underlying concern — *a claim about
output must be checked, and "nothing to check against" must never read as passing* — is **already
satisfied on v1-alpha, by code that predates this feature**:
`flow-expectation.service.ts`'s `ExpectationStatus` union is `"passed" | "failed" | "unevaluable"`,
and its own module comment states `unevaluable` does not satisfy the gate; `trigger.service.ts`'s
`flowEnableReadiness()` requires a succeeded run with every declared expectation `passed`. Both
together are V5's exact discipline, independently arrived at, for the same reason V5 existed in the
first place: the shared hardcoded-period/0-of-11 incident (see "Generation — measured behaviour"
above) is what both this feature's V5 and the "Gate 1 grew a second half" section's D-68 are
defending against. **No code was added for V5** — the finding is that the equivalent already
exists, not a gap to close.

⚠ **"Already satisfied" was OVERSTATED, and one half was closed on 2026-08-14.** The union was
enforced **in TypeScript only** — `flow_expectation_results.status` is a bare `varchar(16)` with no
constraint, while `workspace_members.role` beside it has had a CHECK since 0027 and `schema.ts` said
so in its own comment. The gate reads `status = 'passed'`, so the failure mode of a typo is silent and
points the wrong way: a row written `'pass'` can never satisfy gate 1 and never says why, and a value
outside the union is neither a pass, a failure, nor the deliberate third state that must **not**
satisfy the gate. `drizzle/0038_expectation_status_check.sql` adds it — **VALID, not NOT VALID**
(every existing row was checked first: `passed` and `failed` only, so a NOT VALID constraint would
have grandfathered in exactly the rows it exists to prevent). Proven to fire against the live database
with an `UPDATE … SET status='pass'`, which was refused.

**V2 — mcp-bridge is not an open door.** `packages/mcp-bridge` (documented above as "not on any live
path today") had zero auth logic on any route. `packages/mcp-bridge/src/auth.ts`'s `requireApiKey`
now guards `POST /mcp` on a shared `MCP_BRIDGE_API_KEY` (`x-api-key` header), fails closed (missing
key → 500, not "anonymous is fine"), and leaves `GET /health` open — matching the parent server's own
health-endpoint precedent. Hand-rolled rather than importing `@foundry/shared`'s
`authFailureThrottle` or the server's `requireApiKey`: this package has never depended on either.

⚠ **AUTH WAS NOT THE WHOLE PROBLEM, and the rest was closed on 2026-08-14.** Three facts held at once
and only the first had been addressed: it is on **no live path** (nothing in `packages/server`,
`packages/client` or the Tether stack references :4003 or `MCP_BRIDGE_API_KEY`), it **published :4003
on the host**, and it connected to `foundry_parent` with the **OWNER credential** — one query from
`workspace_secrets` — because `schema-store.ts` defaulted to
`postgres://foundry:foundry@localhost:5433/foundry_parent` in its own source. A container answering on
a published port is the most convincing possible evidence of a working dependency (the argument that
removed Redis), and this one also carried a real credential.

- **It is no longer started by default.** `profiles: ["mcp-bridge"]` in `infra/docker-compose.yml`;
  nothing is deleted and `docker compose … --profile mcp-bridge up -d` turns it back on. The running
  container was stopped and :4003 now refuses connections.
- **The DSN is required and no longer defaulted.** `schema-store.ts` throws at import with a message
  naming the variable and saying why there is no fallback — a misconfigured deployment used to get
  **full** read access instead of an error. `schema-store.test.ts` pins it, with a control that the
  module loads when the DSN is set.
- **The key compare is constant-time** (`timingSafeEqual`, length compared on the **buffers** — string
  length disagrees outside ASCII and `timingSafeEqual` throws on a mismatch, which would turn a wrong
  credential into a 500 a caller can trigger at will). Same change in `packages/server`'s
  `requireApiKey`, which was the only remaining `!==` on a secret; the Kestra callback secret and the
  api-receiver Bearer check were already constant-time.
- ⚠ **STILL OPEN, and it is why the profile matters:** its tools take `workspaceId` from the
  **caller's arguments** and it authenticates with one shared key, so any holder reads **every**
  workspace's schema. There is no tenant model on the bridge to scope that with. And it wants its own
  least-privilege role on `foundry_parent` (it reads `schemas` + `datasources` and nothing else) rather
  than the owner DSN, which compose still hands it. Fix both before putting it on a live path.

**V4 — the provenance envelope + injection detection.** `packages/server/src/prompt-boundary/`
(`normalize.ts`, `patterns.ts`, `envelope.ts`, `spans.ts`, `detect.ts`) ported near-verbatim from
`krt/guardrail_validation`, with one adaptation: `spans.ts`'s `SPAN_FIELDS`/`InventoryTool` drop
`isDummy`/`dummyResponseTemplate` — v1-alpha's `tools` table has no such columns (dummy tools were
removed before this feature existed). `manifestBuilderService.buildAndPersist()` gains a `warnings`
field (`detectInjection(spansFromInventory(...))` over the same tools/datasources/entities already
assembled — no extra query), computed alongside the render and **never fed into `hashBody`**: a
planted injection pattern changes `warnings` alone, never `manifestXml`/`summaryXml`/`hash`.
`flow-generation.service.ts`'s `buildDraftPrompt` wraps `opts.manifestXml` in
`PROVENANCE_DECLARATION` + `wrapUntrusted(...)` at the one place manifest text enters a generation
prompt — audited as the *only* such site outside `manifest-builder.service.ts` itself.
⚠ **The detector's answer was COMPUTED AND DISCARDED until 2026-08-14, which is I-120's exact shape.**
Every generation path called `buildAndPersist` and dropped `warnings`, so the check was correct, its
tests passed, and no behaviour anywhere depended on the result — meaning nothing would notice when it
stopped being true. `flow-generation.service.ts`'s `reportManifestWarnings` now logs a detection at
both `buildAndPersist` call sites (draft and authored), and `manifest-builder.service.test.ts` reads
the file off disk to assert one report per build site, with a control that the build sites exist at all.
Three bounds on it, all deliberate: it **reports and does not refuse** (a refusal blocks every draft in
a workspace on one pattern match in one tool description, over heuristics on ordinary prose — the
reason `generation-audit.service.ts`'s verdict was never allowed to gate anything); the **`excerpt` is
not logged**, because it is the one field carrying attacker-authored text, while `itemName` + `field`
name the row to open, and the full `warnings` including excerpts stays on
`GET /api/workspaces/:id/manifest` behind the parent key; and it **reports and does not refuse**.
⚠ **The third bound used to be "it is not on a screen" and that was closed on 2026-08-18** — see
"The guardrail UI surfacing pass" at the end of this file. The placement decision it was waiting for
is the **tools page**, and `foundryApi.getManifest` is now the one thing in `packages/client` that
reads the manifest.

`catalogueText()`'s tool/query rendering is a **separate, distinct artifact** this feature
deliberately did not wrap (spec.md's User Story 2 names "the manifest" specifically) — a legitimate
future extension, not done here.

**V8 — the request-policy engine.** `packages/shared/src/request-policy/` (`evidence.ts`,
`config.ts`, `rules.ts`, `transform.ts`, `combinator.ts`, plus `fixtures.ts` for
`combinator.test.ts`) ported verbatim — genuinely domain-agnostic, its only inputs are `{task:
string}` and a plain-data `PolicyConfig`. `packages/server/src/services/request-policy.service.ts`
is the thin wrapper tracking issued `transform` proposals in-memory (30-minute TTL, single-use).
Two call sites, evaluated **before** any manifest build or inference call:
`flow-generation-job.service.ts`'s `runGeneration()` (on `input.goal` + every `input.outline` line
joined as one text — outline mode is still one automation request; skipped entirely for
`input.authored`, which has no free text) and `flow-chat.service.ts`'s `turn()` (on
`parsed.message`, before `readThreadFlow`/`runTurn`, so a reject/transform decision never reaches
`running` status). Both gain `policy_reject`/`policy_transform` outcomes following the exact 200-not-
error convention `insufficient_catalogue`/`insufficient_contract` already established (D-38). A
`transform` resubmission carries `acceptedProposal: {proposalId, task}`; `verifyAcceptedTransform`
re-evaluates the confirmed text before proceeding rather than trusting "this was already confirmed."

⚠ **A quirk in the ported policy engine, found while testing, not fixed (out of scope for an
unchanged port — research.md Decision 5):** the vertical-differentiation pattern
(`\bfor\s+[a-z][a-z\s]*$`, meant to let "Uber for doctors" through) matches ANY request ending in
"for <noun phrase>", including this feature's own quickstart.md example for capability-signature
transform ("...channels, threads, and a workspace concept **for teams**"). That trailing clause
triggers `differentiationQualifier` evidence, which suppresses the capability-signature match to
`allow` rather than `policy_transform`. The quickstart example as literally written does not
reproduce `policy_transform`; drop the trailing "for teams" clause to see it fire. Not a v1-alpha
defect — it is present, unchanged, in the source branch's own combinator logic.

## Historical note

Commit `c1b2ecc` removed `plans/`, `MIGRATION_FIX_PLAN.md` and `AUTOMATION_RESTORE_PLAN.md` when the
Kestra migration plan landed, and the earlier `FEASIBILITY_REPORT.md` / `IMPLEMENTATION_PLAN.md` /
`MANIFEST_CONTRACT.md` no longer exist either. Their load-bearing content is summarised above; the
originals are recoverable from `d33825e` if a detail is ever needed.

## The guardrail remediation — v1-alpha's own gaps (2026-08-14)

The two ports above brought krt's guardrail slices onto this branch. This pass audited what they
actually left true and closed the gaps, **natively** — no krt file was copied and no krt architecture
was reproduced. Nine phases, each with its own tests and each proven by perturbation (removing the
control turns the test red). Ordered by what it changed:

| # | What | Where |
| :--- | :--- | :--- |
| F4 | **`TetherError` stopped echoing the upstream body.** It returned `message`, `status` and `body` verbatim, undoing — for the error type most likely to CARRY upstream detail — the redaction the generic 5xx branch performs 20 lines below it. It fires first, being more specific, so the correct branch was unreachable for it. Now 502 + `{error:"upstream_error", requestId}`, detail logged against `req.id`. | `middleware/error.middleware.ts` |
| F1b/c | **Alternate encodings + fail-closed egress.** See the V6 corrections above. | `@foundry/shared/egress` |
| F3 | **The proxy authenticates in the route, not only in middleware.** | `client/app/api/foundry/[...path]/route.ts` |
| F2 | **mcp-bridge off by default, DSN required, constant-time compare.** See the V2 addendum above. | `packages/mcp-bridge`, compose |
| F8 | **Abuse controls.** Constant-time key compare; a rate limit on the two PUBLIC receivers; a per-tick bound on poll triggers. | below |
| F5 | **A malformed uuid is a 400, not a 500.** | `middleware/error.middleware.ts` |
| F6 | **`flow_expectation_results.status` is CHECK-constrained.** See the V5 addendum above. | `drizzle/0038` |
| F9 | **One policy evaluator, asserted.** `combinator.ts` claimed a second caller (`request-policy-client.ts`) and an equivalence test over "both wrappers"; neither exists, and there is no policy code in `packages/client` at all — which is the correct shape, since a decision the browser can compute is one it can skip. What is pinned is the **absence** of a second evaluator, read off disk with a control that the grep can find anything. | `request-policy.service.test.ts` |
| F7 | **The injection detector's answer is consumed.** See the V4 addendum above. | `flow-generation.service.ts` |
| F11 | **`TETHER_BASE_URL` is validated at config load**, where the message can name the variable — it was an arbitrary string, so a bare host or a Compose `${VAR}` that resolved to empty booted cleanly and failed later as an opaque `fetch failed` on the first agent step. Deliberately **not** an egress check: Tether legitimately lives on loopback here, so STRICT would refuse the correct value. | `config/index.ts` |
| F12 | **The two reserved-address classifiers are held in agreement by a test**, not merged. See the V6 corrections above. | `services/egress-parity.test.ts` |

Six things are load-bearing.

- ⚠ **The proxy route's session check is the substantive half of F3, and the reason is the matcher.**
  `proxy.ts` (`middleware.ts` before Next 16) redirects an unauthenticated request to `/login`, and that redirect **was** the whole
  control on the one route in `packages/client` holding `PARENT_API_KEY`. Its matcher is a single
  negative-lookahead regex, and the idiom every Next codebase reaches for — adding `api` to that
  exclusion — would have handed the entire parent API to anonymous callers with the root key, silently,
  with no test failing. The route now answers **401 JSON** on its own; `proxy.test.ts` calls the handler
  directly, which is exactly the state that matcher change would create. A 302-to-HTML was also the
  wrong shape for an API path — `foundryApi` parses JSON, so the symptom was a parse error rather than
  "you are signed out".
- ⚠ **F3 is a short DENY list and NOT an allowlist, deliberately.** The client's surface is ~200 paths
  in `foundry-client.ts` and grows with every UI feature; a hand-transcribed allowlist is a broken
  screen with an error that never names the list. So it denies the three segments *documented* as never
  browser-reachable — `test-oracle` (`routes/oracle.ts`: "nothing in the product may call it", and the
  proxy was presenting the root key to it for any signed-in user), `steps` and `executions` (engine
  callbacks, "deliberately NOT" the parent key). **`foundryApi.demoOracle` is deleted**: it was the only
  client method reaching the oracle, it had **no callers**, and its comment claimed one. ⚠ **Say what
  this is**: every `requireApiKey` route stays reachable by any signed-in user, because this route holds
  the one shared key — the control for that is `requireWorkspaceRole` on the API side, not here.
- ⚠ **The public-receiver limit is a DoS bound and not an authentication control.** `POST
  /api/triggers/:token/webhook` and `…/api` are the only routes that answer an anonymous caller and then
  do work, and they had no bound of any kind. It is keyed on IP, which is spoofable-by-proxy and shared
  behind NAT — the token in the URL is the credential. It bounds the unauthenticated **lookups**, never
  executions: concurrent executions per workspace are already bounded by the M3 tenant budget, and
  `@foundry/shared`'s rate-limit docblock is the record of why one resource with two disagreeing limits
  is worse than one. `PUBLIC_RECEIVER_RATE_PER_MINUTE`, default 60. **`/api/health` is deliberately not
  throttled** — it is the liveness probe at a fixed cadence, and a limiter there turns a busy moment into
  a restart loop.
- ⚠ **The poll-trigger cap exists because of what runs AFTER it, not because of outbound volume.** The
  poll loop is sequential with an 8s timeout per dial, and the approval-staleness sweep runs in the
  **same tick** — so enough due poll triggers starve the sweep, which is one of the four
  silent-failure signals precisely because its silence looks like success (D-66). `POLL_TRIGGERS_PER_TICK`,
  default 25. **Fairness needs no rotation state**: `lastPollAt` is stamped only for the triggers a tick
  actually polls, so a skipped one stays due and is taken next tick — which is why the cap sits *before*
  the stamp, and moving it after would starve the tail permanently. **Never a silent cap** — the
  shortfall is logged with the knob's name.
- ⚠ **F5 is one branch in the error handler, NOT a `validate({ params })` retrofit, and that is a
  decision.** There are 152 `req.params` reads across 17 route files; they are uuids handed to
  parameterized queries, so there is no injection to close. The only real defect was the status code —
  Postgres `22P02` arrived as an unclaimed 500, and once F4 stopped 5xx echoing `message`, a caller's
  typo became a bare `internal_error` with nothing to act on. One branch fixes every route at once; a
  17-file mechanical retrofit would risk a 400 on a screen that works today for a bug class that does
  not exist. `@foundry/shared`'s `validate` says the same about scope in its own docblock. ⚠ Only
  `22P02` — a **control test** asserts `42P01` and friends stay 500, or a real incident starts reading
  as "somebody typed the wrong id".
- ⚠ **A workspace-creation quota was in the plan and was deliberately NOT built.** Every `demo:*` and
  `finance:*` provisioner and several harnesses create workspaces with the same credential, so a
  per-credential bound refuses the regression net on day one — and CLAUDE.md's own FR-006 note already
  says not to add a fourth ceiling over a resource three existing checks bound. Recorded here rather
  than left to be rediscovered as an omission.

⚠ **Migrations: the merge rewrote `_journal.json`'s `when` for migrations that were already applied**
(`0033_flow_chat`: `1786393142790` → `1786600000000`). drizzle's watermark is `max(created_at)` and its
test is `created_at < folderMillis`, so the rewritten entry sorted **above** the watermark and
`db:migrate` re-ran 0033 for ever — `relation "flow_chat_threads" already exists`, which reads like a
corrupt database rather than a rewritten timestamp. Any database migrated before that merge hits it. The
repair is to realign each applied row's `created_at` with its journal `when`; **a new migration's `when`
must exceed every applied `created_at`**, which is why `0038`'s is `1786800000000`.

## The guardrail UI surfacing pass (2026-08-18)

The two ports and the remediation above built the guardrails server-side and left four of them with
**no way for a person to see them fire**. This pass went through `docs/validation-and-guardrails-roadmap.md` and
`krt/guardrail_validation` (where every path is nested under `foundry/`) and closed what was missing
on **this** branch's client. No krt file was copied verbatim; two were adapted and one was
deliberately not ported.

| # | What was wrong | Where |
| :--- | :--- | :--- |
| S1 | **A policy decision rendered as a BLANK PANEL.** The server has returned `policy_reject`/`policy_transform` since the V8 port; the client's `GenerationJob` status union carried neither, so none of `/flows/new`'s four terminal branches matched. | `lib/types.ts`, `lib/foundry-client.ts`, `flows/new/page.tsx` |
| S2 | **The same decision read as a red failure in chat.** `TONE[turn.status] ?? TONE.failed` labelled it **"Not applied"** in danger, and the reason went unrendered because that line is gated on `status === "failed"`. | `components/flow/ChatPanel.tsx` |
| S3 | **The injection detector was correct and unseen** — the third bound this file used to record. | `components/PromptBoundaryWarnings.tsx`, `lib/prompt-boundary-copy.ts`, `tools/page.tsx` |
| S4 | **A 429 arrived as raw JSON.** `rate_limited` carries no `message`, so `req()` fell through to the literal body and a person saw `{"error":"rate_limited","retryAfterSeconds":60}` in a toast. | `lib/foundry-client.ts` |
| S5 | **V7's named gap was still open**: `FormField` has always carried `required`/`min`/`max`/`integer` and **nothing checked a value against them**, so the connector wizard accepted `abc` in a port field. | `lib/manifest-form.ts`, `components/ui/DynamicForm.tsx`, `data-sources/new/page.tsx` |

Seven things are load-bearing.

- ⚠ **A blank screen is the worst of the available lies, and that is why S1 and S2 rank above the
  rest.** Both surfaces were wrong about a decision the product was making *correctly* — one showed
  nothing, one showed danger-red "Not applied" — so the guardrail's most defensible moment presented
  as the product breaking. D-38's rule (a refusal is a 200 and never a failure) was already honoured
  at the route and lost at the last hop, in the least visible place.
- ⚠ **`TONE`'s `?? TONE.failed` default STAYS.** The fix was to stop the two known states reaching it,
  not to soften it: a status this build has never heard of must not read as fine (D-66's ranking).
- ⚠ **The TRANSFORM confirm button exists on `/flows/new` and deliberately NOT in chat.** It is not
  the Retry §6.7 forbids because it sends *different text* — a substitute the person read and may have
  edited. Chat gets no such button because `flow-chat`'s turn endpoint has **no `acceptedProposal`
  parameter**: a button there would either do nothing or resubmit the message unchanged, which is
  precisely that Retry wearing a helpful label. It shows the suggestion as text to send instead, which
  routes it back through the same evaluation every message gets.
  - **Confirmation is not authorisation.** `acceptedProposal` carries the id *and* the text, and
    `verifyAcceptedTransform` re-evaluates the confirmed text — an unrecognised or expired id falls
    through to a fresh evaluation. Measured end-to-end on 2026-08-18: a confirmed proposal was
    accepted, re-evaluated to `allow`, and proceeded to drafting.
- ⚠ **`policy_reject` is in the page's `refused` set and `policy_transform` is NOT.** That set gates
  the footer's "design it again", which unlocks once the goal changes — right for a rejection, wrong
  for a transform, where the proposal on screen is the action. One decision with two competing
  buttons is worse than either.
- ⚠ **`listPromptBoundaryWarnings` THROWS and krt's version did not.** krt caught everything and
  returned `{items: []}`, which renders as "no flagged content" when the truth is "the check did not
  run" — the deleted `faFallback` shape exactly, and worse here than anywhere, because the one thing
  this panel must never do is imply an absence of findings it never obtained. So there are **three**
  states: warnings, nothing matched (renders nothing — an empty list is not a safety claim), and
  unreadable (renders, and says the check did not run). A second `useAsync` rather than a field on the
  first, so a manifest failure cannot empty the tools table and a tools failure cannot read as "no
  flagged content".
- ⚠ **`request-policy-client.ts` was NOT ported, and that is F9's decision standing.** krt has one; on
  this branch `request-policy.service.test.ts` pins the **absence** of a second evaluator by grepping
  `packages/client/src` for `evaluatePolicy|policyRules|request-policy`. So `lib/policy-copy.ts` maps a
  decision *already made* onto words and names none of those identifiers — the comment in it saying so
  is the reason, not a coincidence. **Do not add a client-side evaluator to "show the decision sooner".**
- ⚠ **Both copy modules keep their strings out of the components so the RULES can be asserted**
  (`generation-findings.ts`'s idiom). `policy-copy.test.ts` asserts no refusal string contains
  "error"/"failed"/"try again"/"retry"; `prompt-boundary-copy.test.ts` asserts no all-clear string
  exists and that the explainer states the flagged content is still sent **unaltered** — the detector
  alters nothing and pins the manifest's byte-identity, so a panel implying the text had been cleaned
  would turn a warning into false reassurance. Both proven by perturbation.

### ⚠ The client's whole rendering test layer was DEAD, and this is how it was found and fixed

**Every one of the 21 jsdom render-test files was silently not running** — `routes.smoke.test.tsx`
(the suite that exists because `use(params)` broke every flow page for two days while 400+ server
assertions stayed green), `FlowCanvas.test.tsx`, `ChatPanel.test.tsx` and 18 others — all failing to
load with `TypeError: webidl.util.markAsUncloneable is not a function`: jsdom 30 calling an undici 8.9
path that needs a Node 22 API, on **Node 20.20.0**, while both `package.json`s have declared
`"node": ">=22"` the whole time.

**The measured difference: `30 files / 410 tests` on Node 20 → `51 files / 709 tests` on Node 22.**
Nearly 300 assertions, none of which had ever run.

- ⚠ **The summary line said GREEN.** Vitest listed the 21 as "Unhandled Errors" and then printed
  `Test Files 30 passed` — the number a person actually reads. The run did exit 1, which was the one
  honest signal, and an exit code is not what anyone looks at first.
- ⚠ **This is I-38 at the largest scale in the repo** — a whole layer of controls that could not fail.
  It also means `ui-honesty-check.sh`'s *"every page under `(app)` has a render test"* was satisfied
  throughout by files that never executed a single assertion: it greps, and greps pass.
- **Fixed by installing Node 22.23.2** (checksum-verified against nodejs.org's `SHASUMS256.txt`) to
  `~/.local/share/node-versions/v22.23.2` rather than by touching system packages — the host still has
  Node 20 as `/usr/bin/node` for everything else.
  - ⚠ **`.nvmrc` ALREADY said `22`.** So the requirement was written down in *three* places — two
    `engines` fields and that file — and the host simply was not honouring any of them. That is the
    whole argument for the throw below: three declarations and no control. `.nvmrc` is left at the
    major-only pin it had (a `22.23.2` in there would demand one exact patch), and `.node-version` was
    added beside it with the same value for the tools that read that name instead.
- ⚠ **`vitest.config.ts` now THROWS below Node 22**, and that is the durable half. A declaration in
  `engines` is not a control; the throw names the version, the consequence and the 21 files, so the
  next person on an old runtime gets one message instead of a green count over a dead layer. Verified
  both ways: Node 20 → exit **1** with the message and no tests run, Node 22 → **51 files / 709
  tests**, exit **0**.
- ⚠ **The layer's FIRST ACT was to catch a regression in this very pass.** Mounting
  `PromptBoundaryWarnings` on the tools page added a `lib/api` read, and `tools/page.test.tsx`'s
  `vi.mock` is a whole-module replacement — so the omitted `listPromptBoundaryWarnings` came back
  `undefined`, `useAsync` invoked it, and the page crashed in **all 27** of that file's tests. On Node
  20 that would have shipped silently. The mock is fixed and carries a note for the next person adding
  a read to that page.

**Green at the end of this pass, on Node 22:** client typecheck clean · **709 tests / 51 files, 0
errors** · `ui-honesty-check.sh` **189 PASS / 0 FAIL** · the server's `request-policy.service.test.ts`
**14/14**, so the no-second-evaluator assertion still holds with the new client files in place.

**Every control added in this pass is proven by perturbation**, including the three `ChatPanel` policy
tests that could not be run when they were written: removing the two `TONE` entries turns 2 red,
disabling the reason branch turns 1 red, and blanking `gatewayFailed`'s regex turns 3 red. The
prompt-boundary panel has three render tests — a warning shown with its excerpt and the
"nothing has been removed or rewritten" sentence, the empty case drawing **nothing**, and the
unreadable case saying the check did not run.

### ⚠ The server was compiling its TESTS into `dist/` — and that is what the "39 failures" were

Chased on 2026-08-18 from a pasted run reading `Test Files 39 failed | 168 passed (207)`. **Not one of
those was a failing test.** Three causes, in order of how much they mattered:

- ⚠ **`packages/server/dist/` held 73 compiled test files, and the Docker image ships `dist/`
  wholesale — so test code was in production.** `tsconfig.json`'s `exclude` was
  `["node_modules", "dist"]`, with no `src/**/*.test.ts`, while `packages/{shared,redact,flow-edit}`
  have excluded exactly that all along. Among the compiled copies: the suites that read the source tree
  and assert on what they find, and the ones that open Postgres.
  - **The fix keeps type coverage, which the obvious fix loses.** Those three packages have ONE
    `tsconfig.json` used by both `build` and `typecheck` (`tsc --noEmit`), so their exclusion silently
    stops their tests being typechecked too. This package has **53** test files, several of them
    source-reading, so trading that away to tidy the build would swap one silent gap for another. New
    `packages/server/tsconfig.build.json` extends `tsconfig.json` and adds the test exclude; `build`
    points at it, `typecheck` still points at `tsconfig.json`. Verified both ways: `dist` now holds **0**
    test files and still has its entrypoint and its `demo/*.sql`, and appending a deliberate type error
    to a `.test.ts` is still caught by `tsc --noEmit`.
  - ⚠ **This was invisible from the command anyone runs.** The root `test` script is `pnpm -r test`, and
    each package's run is scoped to `src/`. Only a root-level collection ever saw `dist/**/*.test.js`.
- ⚠ **The paste came from `npx vitest run` AT THE REPO ROOT, which is not a supported entry point.**
  The root has no vitest config and **no `devDependencies` at all**, so `npx` fetches its own vitest
  into `~/.npm/_npx/…`, which then cannot resolve the workspace's `jsdom` — that is the 21 "errors",
  every one of them a client render file. The root also supplies no `@/` alias, so ~20 pure client
  suites fail on `Cannot find package '@/lib/stats'`, and the three server suites that read source or
  load env relative to cwd fail for that reason alone. **All three pass from `packages/server`.**
- **The command that means what it says is `pnpm test` (= `pnpm -r test`)**, which delegates to each
  package's own config. On Node 22 it is **exit 0**: server 84/1193 · client 51/709 · shared 8/105 ·
  flow-edit 3/88 · ops-api 3/17 · mcp-bridge 2/9 · redact 1/7.

**Removing the `dist` duplicates took the root run from `39 failed files / 14 failed tests` to
`24 / 3`** — and the remaining 24 are the two root-only causes above, not defects. A root
`vitest.workspace.ts` would fix the collection but not the resolution (the fetched vitest still has no
`jsdom`), and making it work properly means giving the root a vitest devDependency it has never had —
**recorded here as a deliberate non-goal rather than left to be rediscovered.**

## The super-admin workspace assignment (2026-08-20)

`specs/20260820-193547-superadmin-workspace-assignment/`. Workspace lifecycle and membership stopped
being self-service. Four things changed and the first is a deletion.

| # | What | Where |
| :--- | :--- | :--- |
| 1 | **`POST …/members/claim` and `claim()` are DELETED**, client method and button with them. | `routes/members.ts`, `services/workspace-member.service.ts`, `components/workspace/MembersPanel.tsx` |
| 2 | **Membership writes and workspace create/rename/delete are `requireSuperAdmin`.** Workspace CRUD had **no gate at all** before — anyone who could sign in could create or delete a tenant. | `middleware/super-admin.middleware.ts` |
| 3 | **`platform_users`** — every identity that has presented a verified token, so an assignment is a choice rather than transcribing an OID. `GET /api/platform/users`. | migration `0040`, `services/platform-user.service.ts` |
| 4 | **`GET /api/me`** → `{ superAdmin, superAdminConfigured }`, and `/organization` + its nav row are gated on it. | `routes/me.ts`, `app/(app)/organization/page.tsx`, `components/shell/Sidebar.tsx` |

Eight things are load-bearing.

- ⚠ **`SUPER_ADMIN_EMAILS` IS NOW LOAD-BEARING AND USED TO BE OPTIONAL.** Empty is no longer "the
  feature off": with `claim` gone, **no workspace can be created and no memberless workspace can ever
  get a member**. That state is surfaced rather than discovered — `config.superAdminConfigured`,
  `/api/me`, and a *different* refusal from `requireSuperAdmin`, `check` and the page, each naming the
  variable. **Two refusals, two actions** (ask a person / set an env var) is the rule everywhere here.
- ⚠ **It matched on the SUBJECT only, from a variable named `…_EMAILS`, and that was a silent bug.**
  A `FoundryIdentity.subject` is the token's `sub` — for Entra, the **OID**. So a deployment that
  listed emails, i.e. did what the name says, granted nothing at all, with a correct value in a
  correct variable and no error anywhere. It only ever appeared to work because the local credentials
  account's subject is the literal `local-admin`. Now subject **or** email (email case-insensitively,
  subject exactly) through **one predicate**, `config.isSuperAdmin` — three call sites, and three
  copies of a membership test is how the original bug survived. The regression test is in
  `workspace-member.test.ts` and goes red on a subject-only revert.
- ⚠ **Deleting `claim` is safe ONLY because `check`'s super-admin branch runs before the member list
  is read**, so a super admin passes `admin` in a workspace with zero members and can grant its first
  one. That is the whole argument; on an empty allowlist it becomes a dead end instead, which is why
  the paragraph above exists.
- ⚠ **A SUPER ADMIN IS EXEMPT FROM THE LAST-ADMIN REFUSAL, and that was MEASURED, not reasoned.** The
  first version kept it absolute and the wire test found the consequence in one command: a super admin
  assigned the wrong person as a workspace's only member and **could not take it back** — the removal
  409'd, and with `claim` gone there was no way back at all. An irreversible mis-assignment is worse
  than the state the refusal protects. The refusal still holds for every other caller (seeds and
  harnesses call the service directly), and the flag is derived from the verified identity —
  **never from a body**, which would make the exemption something a caller asserts.
- ⚠ **The gate is at the ROUTE and the client only ASKS.** `session.user.roles` is sitting right
  there and already says `["superadmin","admin"]` for the local account, from a password check in
  `packages/client/src/auth.ts`, while the server decides from its own environment. Reading the
  session would be a second definition that can disagree with the only one that refuses anything — and
  it would disagree in the worse direction: a page that renders over routes that all 403.
  `ui-honesty-check.sh` asserts the absence of that read.
- ⚠ **`/organization` has FOUR states and the fourth is the one to get right.** Super admin; not one;
  none configured; and **`/api/me` failed**, which renders as *"could not be checked"* and as neither
  answer. Same rule as `PromptBoundaryWarnings`: unreadable renders as unreadable. The nav row is
  hidden while loading and hidden on failure — *"we could not check"* must not render as *"you may"*.
- ⚠ **`platform_users` is NOT a user directory and is deliberately not called `users`.** A row means
  one thing: this subject presented a token that verified against `RUNTIME_JWT_SECRET`. Not an
  account, not an entitlement, not proof of who anybody is (I-13), and **not a record of who is signed
  in** — there is no session in it. Written from `resolveIdentity` (already verified, no new trust
  boundary) rather than from Auth.js, which runs in a process holding no database credential; the cost,
  stated on screen, is that somebody appears on their first API call rather than at sign-in. The write
  is **throttled, unawaited and cannot throw** — bookkeeping on the path of every authorisation check
  must not add latency to one or turn one into a 500.
- ⚠ **`e2e:ui`'s membership step was rewritten and CANNOT mint its own super admin.** The allowlist
  lives in the API server's environment, a different process, so the harness takes the **first entry
  of `SUPER_ADMIN_EMAILS`** and presents that. With the variable unset it records a **NOTE** naming it
  rather than a MISMATCH — a harness reporting its own environment as a product defect is worse than
  no assertion — and the refusal half (a non-super-admin is 403'd) is checked either way.

⚠ **One test in this repo asserted the OLD refusal text** and is corrected rather than deleted:
`generation-provider.test.ts` required `requireDeploymentAdmin`'s unconfigured message to contain
`members/claim`. The property (two distinguishable messages, each naming its own fix) is unchanged;
the fix it names is not, and a refusal pointing at a deleted route is worse than one pointing at none.

⚠ **A test of mine was WRONG in the way this repo keeps warning about**, and the live table is what
caught it: `platform-user.test.ts`'s *"never throws"* used a 40,000-character subject, which a `text`
column accepts happily — so the assertion passed over a **successful** write and left a junk row
behind. It now uses a NUL byte, which Postgres genuinely refuses. ⚠ And the obvious verification
query throws on that same byte, so the check reads back with a prefix filter instead.

**Verified at the wire on 2026-08-20**, against the running deployment with a rebuilt server image:
`/api/me` returns `superAdmin: true` for an **email-listed** super admin whose subject is an OID (the
bug above, fixed); `/…/members/claim` is **404**; assignment is **201** for a super admin and **403**
for a signed-in non-super-admin; workspace creation is **403** for a non-super-admin and **401** with
the API key and no identity; an assigned member reads the workspace's members and is still **403** on
assigning anyone; and assign-then-remove of a sole admin round-trips **201 → 200**.

**Green:** server **1458 passed / 23 skipped**, client **739 passed / 55 files**, both typechecks
clean, `ui-honesty-check.sh` **196 PASS / 0 FAIL**.

### ⚠ The follow-up pass (2026-08-21) — and the identity SUBJECT was rotating

Four reports from use. The fourth turned out to be the cause of the second and third.

- ⚠ **THE ROOT CAUSE: `packages/client/src/auth.ts` SIGNED `token.sub`, WHICH IS NOT STABLE HERE.**
  Measured on the live deployment: **one Entra user held FIVE `platform_users` rows**, one per
  sign-in, same email, five different subjects. The visible complaint was a duplicated people list.
  The serious half is that **`workspace_members.subject` is keyed on that value**, so a member's role
  silently stopped applying the next time they signed in — the assignment still existed, the new token
  named somebody the server had never seen, and the refusal read *"you are not a member of this
  workspace"* with the row sitting right there. `token.oid` (the Entra OID) is stable and is what
  `session.user.id` had always preferred; the backend token now signs `token.oid ?? token.sub`, the
  tail being the local account whose `sub` is the fixed literal `local-admin`.
  - ⚠ **Do not "simplify" it back.** It looks equivalent, it type-checks, and every symptom appears a
    sign-in later somewhere else in the product.
  - ⚠ **Rows written before the fix are ORPHANS** — those subjects can never appear in a token again.
    Five `platform_users` rows were deleted; **two `workspace_members` rows were left in place** (they
    record real intent and the person's new subject is unknown until they next sign in), so that
    person must be **re-assigned once** after signing in. A `subject = '..'` membership row from
    somebody's earlier testing was also left alone.
- ⚠ **`admin ⊇ approver ⊇ author` was ALREADY TRUE and needed no change.** `RANK` has been ordered
  since GAPS §1.1, so an admin has always passed `requireWorkspaceRole("approver")`. What actually
  refused an admin was the rotating subject above. It is now pinned by a named test, whose docblock
  says so — *a role model that reads correctly can still refuse the right person if the KEY it is
  looked up by is unstable.*
- **An empty nav GROUP no longer renders its heading.** Hiding the one super-admin row left every
  other user looking at an empty **"Admin"** section — a label for a capability they cannot reach,
  which reads as a broken page rather than an absent permission. The visibility test moved into a
  per-group filter so the heading and its rows cannot disagree. Its test asserts **both** directions;
  a one-sided version passes against a rail that renders nothing.
- ⚠ **A SUPER ADMIN NOW PASSES THE TWO ACCOUNTABILITY GATES, AND THIS IS A REAL LOSS — SAY IT
  PRECISELY.** Asked for directly ("all access … including the workflow approvals and rejections"),
  and unavoidable on a single-operator deployment where the person who authors an automation is the
  only person who could ever approve it — an absolute refusal means nothing can be armed at all.
  - Gate 2's **self-approval refusal** stands down for them, and the approval row records it:
    `flow_approvals.self_approved_override` (migration **0041**, NOT NULL default false, so every
    pre-existing row keeps the stronger meaning). Gate 3's **self-decision refusal** stands down too,
    and is **logged rather than recorded** — a step approval has no column for it, and inventing one
    on the strength of a log line would be the wrong order.
  - ⚠ **The sentence to use from now on is *"a NON-super-admin cannot approve their own revision"*.**
    Never the unqualified *"an author cannot approve their own work"* — it is no longer true, and this
    was the one control in the product that was a genuine second pair of eyes.
  - **Both flags come from the verified identity and neither is in a schema.** `approveSchema` is
    `.strict()` precisely so an approver cannot name themselves; an exemption a caller could assert
    would be that hole under a new field name. A test greps the route for
    `bySuperAdmin: config.isSuperAdmin(req.user)` and against `req.body`.
  - The refusal is **narrowed, not deleted**: the guard is `selfApproval && !override`, greppable, and
    pinned by a test that goes red if it ever becomes an unconditional pass.

⚠ **A wire test armed a live flow, and undoing it took three steps.** Approving revision 2 of
`Attendance report` as a super admin proved the access (a workspace it is not a member of, a revision
somebody else authored) and **deployed a live schedule**. Revoke removed the Kestra trigger — verified
`triggers: []` on the live namespace — but leaves the flow `suspended`/`armed_revision=2`, which is
revoke's normal resting state and was **not** where this flow started: it had never been approved. The
row was restored to `draft`/NULL and the approval row **deleted**, against `flow_approvals`'
insert-only rule, because it recorded a decision no human made and the table is the audit artefact.
**Verify approval paths against a flow you created for the purpose.**

**Green:** server **1508 passed / 23 skipped**, client **741 passed**, both typechecks clean,
`ui-honesty-check.sh` **196 PASS / 0 FAIL**.

## The chat-builder and approval-note UI pass (2026-08-21)

Two surfaces, asked for from use. Both are client-only; no route, service or schema changed.

| # | What | Where |
| :--- | :--- | :--- |
| 1 | **A gate-3 note is never sent empty, and which default it carries is chosen by the button pressed.** | `components/flow/ApprovalCard.tsx` |
| 2 | **The chat builder reads as a conversation** — welcome bubble, typing indicator, the first message on screen, no progress bar, no mode switch. | `components/flow/{ChatPanel,ChatWorkbench}.tsx` |

Five things are load-bearing.

- ⚠ **The note default is a MITIGATION for run `71be8add` and must not be read as the fix.** The
  blank note was sent as `""`, the compiled `approval` step's `onResume` declares `note` as a bare
  `type: STRING` — which Kestra defaults to **required** — so the resume came back **422**, the row was
  stamped `decided`, the run stayed **paused holding an M3 slot**, and the inbox stopped listing it
  (`listPending` filters `decided_at IS NULL`). Reproduced in isolation on a throwaway
  `foundry.system` flow: `note=` → 422, `note=x` → 204. **The server halves are still open**: emit
  `required: false` for `note`/`decision` (and the `agent` await's `result`/`status`, same latent
  shape), and give `decided_at NOT NULL AND applied_at IS NULL` a way to be re-delivered — the card
  already renders that state as *"recorded, but the engine never received it"* and nothing acts on it.
  A client that always sends a non-empty string stops **this browser** producing the state and does
  nothing for a flow already compiled or any other caller.
- ⚠ **Four defaults, not one, and none of them reads as a judgement.** A single constant passes an
  approve test while writing *"Approved"* into a rejection's audit row, and a default like *"verified"*
  puts a finding nobody made into the one row that records what a person decided. Both are pinned:
  `defaultNote` is exported and tested for four distinct strings and against a
  `verified|checked|looks|correct|reviewed` regex. The text names **no surface** — this card renders on
  the run page as well as the inbox.
- ⚠ **The conversational shape added no sentence a model wrote.** The welcome is a constant chosen by
  mode (`welcomeFor`), the indicator is driven by `busy` and the caller's `thinking` label, and every
  assistant bubble still renders only computed fields — `describeOp`'s change line and
  `flowApprovalService.diff`. **Do not make the welcome dynamic**: the moment that string comes from a
  model, `ui-honesty-check.sh`'s ban on `turn.text` is being satisfied by a different field name.
  All five of that file's ChatPanel assertions still pass, the no-retry rule included.
- ⚠ **The routed first message is now echoed locally, and it is the only bubble on that screen with no
  row behind it.** It is not a turn (decision ①), so `chatTurns` will never return it — and a
  transcript beginning at message two reads as a reply to a message it never showed. It is session-only
  and that is exactly as durable as the rest of the surface: `ChatWorkbench` holds the thread, the flow
  id, the model and the arrangement in memory too. ⚠ **Do not persist it to storage to "fix" that** — a
  client-stored message replayed beside server turns would look like history the server has.
- ⚠ **`SeedProgress`'s BAR is gone and its honest half is not.** `total` is null for the whole drafting
  phase, so the bar rendered a moving stripe carrying no information for most of the wait, which is
  D-48's own point stated as an animation. `seedPhase()` keeps the phase words and the elapsed clock —
  the two facts separating *still working* from *hung* — and keeps the count only where `total` is real.
  ⚠ **"Switch mode" was removed deliberately**: it abandoned the conversation from a head where every
  other control shapes the flow, one click from Send, with no confirmation and nothing to return to.
  The door is still on the sidebar. Both are pinned by tests, the absence with a control.

**Green:** client typecheck clean · **752 tests / 56 files** · `ui-honesty-check.sh` **196 PASS / 0
FAIL**. Every new control is proven by perturbation — one constant for four, a blank note sent as
`undefined`, the echo removed, one welcome for every mode, the indicator removed, Enter not sending,
and "Switch mode" restored: **seven perturbations, seven red runs.**

### ⚠ The chat builder's two prompt gaps (2026-08-21) — enforcing what it never taught

Two failures reported from one conversation in chat mode, both in `flow-chat.service.ts`, both the
same shape: **the turn path enforced a rule the prompt did not carry.**

- ⚠ **`expressionsBlock()` WAS A FIVE-LINE SUMMARY AND IS NOW `EXPRESSION_RULES`.** A turn wrote
  `json(outputs.report.body).text` and `checkOutputShapes` refused it — the sentence naming Foundry's
  envelope (`{results, succeeded, failed, warnings}`, payload at `.results[0].data`) has been in
  `DRAFT_RULES` for weeks and had never reached a chat turn. **This is I-127 one module over**: the
  refine path had the identical defect, `flow-expression-rules.ts` was extracted to fix it, and this
  third consumer was missed. The old comment even argued the case — *"the drafter's own rules already
  carry the long form"* — which is true of a prompt the model never sees.
  - ⚠ **Do not shorten it again "because chat turns are small".** The block is identical for every turn
    in a workspace, so it sits in the cached prefix and costs prefill, not decode. What it saves is a
    whole turn.
  - The guard against a **fourth** consumer: `flow-expression-rules.test.ts` now reads all three
    enforcing modules off disk and requires each to import the rules, with a control that the scan can
    find anything. A test docblock saying "BOTH prompts" was itself this bug's cover.
- ⚠ **`too_structural` SWALLOWED "add the step that isn't there".** *"send the report to
  <address>"* on a draft with no email step came back *"adding a send step would be a new component
  rather than a one-component change"*. The model reasoned correctly from what it was told: the opening
  line said *"one component at a time"*, which reads as one **existing** component, and the
  `too_structural` paragraph listed only shape changes and never said what the status is **not** for.
  `CHAT_RULES` now says adding, changing and removing are all one-component changes, and that an absent
  step is the reason to add it, never a reason to refuse.
  - ⚠ **THE PROMPT IS THE ONLY LEVER FOR THIS ONE, and that is the exception worth stating.** I-118's
    pairing — teach it in the prompt, catch it with a check — has no second half here: nothing
    server-side can know whether a request really was structural, so a `too_structural` cannot be
    validated, only believed. Every other rule in that block has a check behind it.
- **A bounded corrective pass** now sits under both. When `authorFlow` refuses with findings, the turn
  makes **one** more call with them quoted verbatim and re-applies. Three bounds, all deliberate:
  only a **validation finding** is `correctable` (a strayed op is a bug in `applyOp` — re-asking hides
  it and hands back an edit nobody asked for); a **refusal** never routes through it (§6.7 —
  `insufficient_contract` is keyed and cached, D-118); and on a failed correction the **first**
  findings stand, because they are the ones a person can act on. ⚠ Findings are quoted verbatim and
  nothing is added — I-57 is the warning, where 25 of 26 findings were a scanner bug fed to the model
  as fact.

⚠ **Both prompt edits are UNMEASURED.** `chat:measure`, `draft:measure` and `outline:measure` were all
taken against the old text, so they are stale for this path — and `CHAT_RULES`/`EXPRESSION_RULES` are
what the model obeys, which no unit test can stand in for. **Re-take `chat:measure` before quoting any
chat number.**

## Corporate CA trust for Docker builds (2026-08-25)

`specs/20260824-211547-docker-ca-trust/`. Every image failed to build on a network that
re-signs TLS with a private root CA — `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` at
`corepack`, `CERTIFICATE_VERIFY_FAILED` at `pip`, `PKIX path building failed` at the
Kestra plugin downloads. A build container inherits no host environment and no host
filesystem, so the workstation's own `NODE_EXTRA_CA_CERTS` cannot reach a `RUN` step.

`./scripts/stage-corp-ca.sh` stages the certificate into **`infra/certs/`**;
`CORP_CA_FILE=corp-ca.pem` in `.env` turns it on. `pnpm ca:check` verifies it, and
`pnpm ca:check --control` verifies the checks can fail. Six things are load-bearing.

- ⚠ **THREE MECHANISMS, NOT ONE, AND THE UNIFORM DESIGN IS IMPOSSIBLE RATHER THAN
  MERELY WORSE.** `node:22-slim` has **no system trust store at all** — no
  `ca-certificates` package, no `/etc/ssl/certs/ca-certificates.crt`, no
  `update-ca-certificates`, no `openssl` — and carries compiled-in roots. So the
  obvious "add it to the system store and point everything at it" plan works on
  **two of six** images, and the four failures read as an unrelated problem. Node gets
  `NODE_EXTRA_CA_CERTS` (**appends**), fragment-base gets the anchor dir +
  `update-ca-certificates` + `PIP_CERT` (**replaces**, so it names the FULL bundle,
  never the lone root), Kestra gets `keytool -importcert -cacerts` because the JVM
  honours none of the others. Measured; see `baseline-pre-change.txt`.
- ⚠ **`.gitignore` covers `*.pem` and NOT `*.crt`.** Debian's anchor directory only
  processes `*.crt`, so the naive naming would put key material under a name git does
  not exclude (Constitution VIII). The staged file is `.pem` and the rename to `.crt`
  happens inside the `COPY`. **Never stage a `.crt`** — the staging script refuses it.
- ⚠ **Trust follows the BUILD ARGUMENT, never the presence of a file.** A staged but
  unrequested certificate is copied in and ignored, so two developers' builds cannot
  differ by the contents of an untracked directory. `ENV
  NODE_EXTRA_CA_CERTS=${CORP_CA_FILE:+…}` yields the empty string when unset — Docker
  does expand `:+` in `ENV`, measured — so there is no dangling path.
- ⚠ **The refusals exist because the default behaviour is the opposite.** Node treats
  an **unreadable** `NODE_EXTRA_CA_CERTS` as *absent* and silently falls back to its
  bundled roots, so a typo reproduces the original error several steps later with
  nothing naming the cause. Validation uses `crypto.X509Certificate` because there is
  no openssl in those images.
- ⚠ **`fragment-base` and `kestra` build contexts moved from `./fragment-base` /
  `./kestra` to `.` (i.e. `infra/`)**, so one staged certificate serves every context.
  The standalone build commands in both Dockerfile headers changed with them —
  `docker build -f infra/kestra/Dockerfile … infra`, not `… infra/kestra`.
- ⚠ **Run compose from the REPO ROOT with `--env-file .env`.** Compose interpolates
  `${VAR}` from the directory holding the compose file (`infra/`), and there is no
  `infra/.env`. Without the flag `CORP_CA_FILE` expands to empty, the build proceeds
  **untrusted**, and fails at the first fetch looking exactly like the original bug.

**MEASURED 2026-08-25, every mechanism with a control that fires.** All six images
build behind the proxy; `ca:check` is **15/15**. The Kestra arm is the sharpest: with
the certificate all seven jars download from Maven Central, and without it the build
dies at the *first* plugin layer with the JVM's own `PKIX path building failed:
unable to find valid certification path to requested target`.

⚠ **TWO THINGS ARE NOT PROVEN AND MUST NOT BE QUOTED AS IF THEY WERE.**

- **FR-003 (a no-CA build is unchanged on a network with no interception) has NOT been
  verified.** It cannot be, from this workstation: every connection here is
  intercepted, so a no-CA build fails for the *expected* reason and the test cannot
  discriminate. What *was* measured is that an empty `NODE_EXTRA_CA_CERTS` behaves
  identically to an unset one, and that the trust `RUN` is a genuine no-op (no
  `/etc/foundry`, empty env) — verified with a probe built from the real Dockerfile's
  own lines. **The claim needs one build elsewhere, or CI.**
- ⚠ **THE REPOSITORY'S GIT HOOKS ARE NOT INSTALLED ON THIS MACHINE, and that is a
  PRE-EXISTING gap this feature merely uncovered.** `core.hooksPath` is unset and
  `.git/hooks/` holds only samples, so `.githooks/pre-commit` never runs — meaning
  Constitution VIII's enforcement layer 2 and Constitution I's commit-time spec gate
  are both **inert** here. Measured: a deliberate `git add -f` of the staged
  certificate **committed successfully** (the commit was immediately reset and the
  certificate is in no commit). Running `.githooks/pre-commit` by hand **does** refuse
  it, naming the file — so the policy is correct and only the installation is missing.
  Fix with `git config core.hooksPath .githooks`.

## ⚠ Proposed DB operations (2026-08-27) — a model fills in a form, a person approves it

`specs/20260827-053157-proposed-db-operations/`. Four phases, each shipping alone; **P4 was the
measurement phase and it is where the two findings below came from.**

**The complaint**: a datasource onboarded and introspected but given no reader appears in the prompt
in full (the manifest renders its schema) and in CALLABLE STEPS not at all. Nothing joined those two
true facts, so the drafter invented `<datasource>.<table>`, burned all three attempts, and answered
*"could not draft a valid flow in 3 attempts."*

- **P0 — the honest refusal.** One `DRAFT_RULES` rule (a manifest table is **not callable**; a
  visible-but-unreadable datasource is `insufficient_catalogue`) and one sharper ref finding —
  *"A table is not callable: create a DB operation or a named query"* — emitted **only** when the
  datasource has introspected tables and no readers, because that is the one case a person can act on.
- **P1 — `proposeOperation()` behind a route.** A model fills in the `DbOperationSpec` **form**; every
  operator is an enum and there is no field a string of SQL could go into. `compileOperation` — the
  same function the visual builder uses, unchanged — emits every byte of SQL. Two channels: a
  proposal, or `insufficient_schema` with what is missing. ⚠ **A refusal is never retried**: re-asking
  a correct *"this schema cannot express that"* is how it becomes a plausible-looking column on
  attempt 2.
- **P2 — the approval surface.** Readback-led, SQL collapsed, **no sample rows**. The person approves
  plain-English clauses generated by code; `inner` and `left` produce the same clause text and
  **different notes**, and that difference is the whole value. `ui-honesty-check.sh` **196 → 206**.
- **P3 — chat as a setup step.** `needs_component` is a turn status and a **success**. ⚠ See the
  finding below: it does not fire end to end.

### The load-bearing shape

**A model fills in a form; existing, tested, deterministic code turns that into SQL.** `SELECT`-only,
identifiers quoted, values parameterised — none of it new, and none of it re-derived. The proposer
imports no `datasourceRepo` (whose row carries `connectionString`), reads no rows, and is asserted
against **its own source**, not only its behaviour: a field that is present and unused passes a
behavioural test and fails this one.

Also: **`db_operations` is additive to ref fingerprints.** Creating one adds one key and moves no
other — pinned in `manifest-fingerprint.test.ts` with two controls proving those fingerprints *can*
move, and measured by `fingerprint:measure` at **0 moved across 8 workspaces / 45 refs / 2 armed
flows**. Had it moved one, the staleness sweep would unarm every armed flow in every workspace and
give a reason that is not true.

### ⚠ Two findings from P4 that a reader must not miss

**1. Chat's `needs_component` did not fire — ✅ FIXED in Phase 5 (2026-08-28), see below.** Every piece
was built and unit-proven — the gap travels on `FlowDraftError` from the pass that already computed it,
the client renders the offer, 14 tests cover it. End to end on `gpt-5.4-mini` the turn answered
**`too_structural`** first, and the model stated the gap correctly *in prose* while filing it under the
wrong status:

> *"The requested step depends on a specific hr_demo source that does not exist in the available
> callable steps, and there is no single valid one-component change…"*

The op call self-refuses, so `authorFlow` — the only place the gap is detected — never runs. Measured
three phrasings, including one naming the datasource outright, on an empty flow. ⚠ **This is the
2026-08-21 `too_structural` defect returning one level deeper.** `CHAT_RULES` already says an absent
*step* is a reason to add it, never to refuse; the model now reasons past that to *"there is no
reader to add"*. And that entry's own warning is why it went unnoticed: **this rule has no mechanical
second half** — nothing server-side can know whether a request was really structural, so a
`too_structural` can only be believed. `chat:measure --scenario=2` is now that second half, as a
measurement rather than a check. **Fixing it is a prompt change to the most controlled module here
and it was NOT taken as part of a measurement task.**

**2. P0's rule made no measurable difference on this model.** SC-001's before/after, `n=3` each half,
same model, same goal, T01's four rule lines deleted and restored: **3/3 refused on attempt 1 both
ways.** `gpt-5.4-mini` already declines to call a table without being told. That does not make the
rule worthless — the failure it was written for was measured on gemma, whose 84.5 s and 157.7 s
FAILED runs are in `draft-measure.ts`'s own docblock — but **the improvement is unproven on the model
this deployment actually uses**, and gemma was down on the day, so it could not be shown either way.

### ⚠ RE-TAKEN 2026-09-06 on `gpt-5.6-luna` — the debt below is DISCHARGED

The four generation measurements were owed for four separate reasons (the Phase 6 date work,
the `merge` kind, the `agent` removal, and the model change). They were re-taken on
**`gpt-5.6-luna`**, which is what `/ai-provider` resolves on this deployment — read
`resolveGenerationProvider()`, never the env var, which still says gemma.

| Harness | `gpt-5.6-luna`, 2026-09-06 | was, `gpt-5.4-mini` 2026-08-27 |
| :--- | :--- | :--- |
| `kestra:refusal` | **3 refused · 0 invented**; control **2 produced · 1 refused** | 3 refused, 0 invented; control 3 of 3 |
| `outline:measure` | kept the shape **2 of 3** · drifted 0 · no parseable draft 1 | identical |
| `draft:measure` | goal **4/4, 2.0 attempts, 34.4 s** · outline **1/1, 2.0, 51.8 s** · one attempt 16.6 s | goal 7/12, 1.1, 2.5 s · outline 3/3, 2.0, 5.7 s |
| `chat:measure` s1 | 5 turns · applied **5** · refused 0 · failed 0 · **steps reached 5 of 5** | applied 2 · refused 2 · failed 1 · 2 of 5 |
| `chat:measure` s2 | FR-028 control still **`too_structural`**; the US3 probe came back `applied` | — |

⚠ **THE CONTROL WEAKENED, AND IT IS THE MOST IMPORTANT LINE IN THE TABLE.** `kestra:refusal`'s
control exists because a model that refuses everything scores 100% on the refusal arm while being
useless. On `gpt-5.4-mini` it produced clean code 3 of 3; **on luna it refused 1 of 3, on a
satisfiable contract**, naming a field it had been given. So luna refuses *correctly* every time it
should — and also sometimes when it should not. A user meeting that sees `insufficient_contract` on
a contract that is fine. **Never quote the 3/3 refusal rate without this beside it.**

⚠ **`draft:measure` is ~14× SLOWER per draft and more reliable.** 34.4 s mean against 2.5 s, and
4/4 drafted against 7/12. Generation is decode-bound, so that is the model, not the prompt — and the
harness says the lever is ATTEMPTS, not seconds per attempt, because every rejection re-emits the
whole flow.

⚠ **`chat:measure` scenario 1 went 2 of 5 → 5 of 5, and DO NOT attribute that to any change in this
repo.** It is n=1 against n=1 on a scenario whose variance is already recorded as large: the
2026-08-27 run cascaded from a single turn-1 failure, and this one did not. The honest reading is
that both are single conversations.

⚠ **Scenario 2's US3 probe answered `applied` where the harness wanted `needs_component`.** That is
the NON-DETERMINISM already recorded for that probe (*applied three times in four*), not a
regression — and the FR-028 control beside it still held `too_structural`, which is the half that
would have caught a rule widened too far.

⚠ **`chat:measure` IS ALREADY STALE AGAIN**, by one commit: it was taken before `add_guarded_step`
was added to `CHAT_RULES`. `propose:measure` and `fingerprint:measure` were NOT re-taken.

### ⚠ RE-TAKEN 2026-09-10 — `draft:measure` only (Stage-2 kind cutover)

`STEP_SHAPES` moved again: the cutover retired the seven unemittable spellings
(`action`, `notify`, `report`, `end`, `trigger`, `calculate`, `condition`), so a
draft no longer wastes a turn reaching for one — digest `a95a76fff1bb4fa7`,
pinned in `flow-step-shapes.test.ts`. Re-taken on the same model
(`gpt-5.6-luna`, read off `/ai-provider`), rounds=1:

| Harness | `gpt-5.6-luna`, 2026-09-10 | was, 2026-09-06 |
| :--- | :--- | :--- |
| `draft:measure` | goal **4/4, 1.8 attempts, 29.3 s** · outline **1/1, 2.0, 33.6 s** · one attempt 15.8 s | goal 4/4, 2.0 attempts, 34.4 s · outline 1/1, 2.0, 51.8 s · one attempt 16.6 s |

The 09-06 reading and the new one agree within noise — the cutover removed
vocabulary the model was not reaching for, which is the cheap kind of prompt
change. `outline:measure`, `kestra:refusal` and `chat:measure` were NOT
re-taken against the new bytes and still owe one; do not quote their 09-06
numbers as current.

### ⚠ RE-TAKEN 2026-09-10 (2) — `draft:measure` only (Stage-4 wave-1 runtime)

`STEP_SHAPES` moved again: the `llm`/`http` staged lines started emitting (their
emitters landed), the retired-alias lines are gone from what the model is told,
and one guidance paragraph covers the two new kinds — digest `aa53ee382f80bd2b`,
pinned in `flow-step-shapes.test.ts`. Re-taken on the same model
(`gpt-5.6-luna`, read off `/ai-provider`), rounds=1:

| Harness | `gpt-5.6-luna`, 2026-09-10 (2) | was, 2026-09-10 (Stage 2) |
| :--- | :--- | :--- |
| `draft:measure` | goal **4/4, 1.5 attempts, 26.1 s** · outline **1/1, 2.0, 48.0 s** | goal 4/4, 1.8 attempts, 29.3 s · outline 1/1, 2.0, 33.6 s · one attempt 15.8 s |

Agrees within noise — decode-bound, attempts flat. `outline:measure`,
`kestra:refusal` and `chat:measure` still owe a re-take against current bytes;
do not quote their older numbers as current.

### ⚠ RE-TAKEN 2026-09-10 (3) — `chat:measure` s1 only (Stage-6 vocabulary)

`CHAT_RULES` replaced `set_field` with `set_property`/`set_binding`/
`set_output_rows` plus a generated per-kind property appendix, so the s1
conversation ran against genuinely new bytes. Same model (`gpt-5.6-luna`),
rounds=1, via the host→Kestra TCP proxy (round trips 163 ms — the prior
104 s wall was connect timeouts, not engine time):

| Harness | 2026-09-10 (3) | was, 2026-09-06 |
| :--- | :--- | :--- |
| `chat:measure` s1 | 5 turns · applied **4** · refused 0 · failed 0 · **steps reached 7 of 5** · 8 inference calls · wall 52.5 s · first-attempt parse 4/5 | 5 turns · applied 5 · refused 0 · failed 0 · steps reached 5 of 5 |

Same n=1 caveat as ever — one conversation is a reading, not a property.
`chat:measure` s2, `outline:measure`, `kestra:refusal` and `chat:measure`'s
old s1 still owe re-takes against current bytes; do not quote them as current.


### ⚠ RE-TAKEN 2026-09-22 — ALL FIVE, at `6a60dc4` (the Jev programme's phase 6)

The whole set, on `gpt-5.6-luna` read off `resolveGenerationProvider()`, with
**`JEV_EDIT_ADVICE` absent from `.env`** — so this is the flag-OFF path, which is
also what the 2026-09-21 baseline measured. Like for like.

| Harness | 2026-09-22 · `6a60dc4` | was, 2026-09-21 baseline |
| :--- | :--- | :--- |
| `draft:measure` | goal **5/5 · 1.0 attempts · 28.4 s** · outline 1/1 · 1.0 · 45.3 s | goal 4/4 · 1.0 · 24.3 s · outline 1/1 · 1.0 · 19.5 s |
| `outline:measure` | kept **3/3** · drifted 0 · unparseable 0 · control **1/3** | kept 3/3 · drifted 0 · unparseable 0 · control 0/3 |
| `kestra:refusal` | **3 refused · 0 invented** · control **3 produced** | identical |
| `chat:measure` s1 | 5 turns · applied 5 · failed 0 · 7 of 5 steps · **8 calls** · 85.8 s · parse **2/5** | applied 5 · failed 0 · 7 of 5 · 11 calls · 56.0 s · parse 1/5 |
| `chat:measure` s2 | 3 turns · applied 2 · refused 1 · **FR-028 control HELD** | applied 1 · refused 1 · harness 1 · FR-028 HELD |

⚠ **NOTHING HERE IS A RESULT, and saying so is the point of re-taking them.**
Every cell is n=1 against n=1 on a model whose run-to-run variance this file
already records as large. The wall-clock moves in both directions (chat s1 is
30 s slower on **three fewer** calls), which is decode variance, not a change.
**Do not attribute any of these to the programme's work.**

⚠ **The two qualitative checks in `draft:measure` are GREEN and AMBER — not both
green, and the commit message that landed this said otherwise.** SC-001 is green
(*"reached `hr_demo.*` on attempt 1"*). The scoped check is **amber**: the
harness prints `c.ok("all")` only at `used === of`, and this run scored *"some —
1 of 3 refs were preferred"*. A record overstating a qualitative arm is the exact
defect I-180 is about, so the correction is written here rather than the sentence
quietly reworded. A 5/5 that hides either is the whole lesson of I-180.

⚠ **`draft:measure`'s goal arm 4/4 → 5/5 is NOT a like-for-like move.** Phase 3
changed what that row counts (SC-001's `expectRefusal` became `mustReach` —
D-232), so the two 100%s have different denominators. Do not subtract them. The
scoped arm's `0 of 3 → 1 of 3` **is** attributable, to the selection check — and
it is still the open half of I-180.

⚠ **`outline:measure`'s CONTROL moved 0/3 → 1/3, and that is the line to read.**
Goal mode reached the same shape once. The harness says it itself: *"High here
means the cases are too easy, not that outline mode works."*

⚠ **`kestra:refusal`'s control held at 3 of 3 produced.** Read the 2026-09-06
note before quoting the refusal rate — on that day the control refused 1 of 3 on
a satisfiable contract. It has now been 3/3 twice running.

⚠ **`resolved_by` OVER REAL TURNS CANNOT BE ANSWERED, AND THE REASON IS WORTH
KNOWING.** 161 persisted `flow_chat_turns`: **79 `model`, 1 `selection`, 81
NULL, and ZERO `jev`/`jev_degraded`** — because `chat:measure` **deletes its own
thread and turns** at the end of every run (`chat-measure.ts:781`). So the only
Jev-path turns that have ever existed were erased by the harness that created
them. That is `breaking-2026-08-07`'s finding in miniature — *an investigation
that destroyed its own evidence* — and it means threshold tuning on real turns
(I-187) is still blocked on the flag being on somewhere a person is using it.


### The numbers, all `gpt-5.4-mini`, all 2026-08-27

| Harness | Reading |
| :--- | :--- |
| `propose:measure` **(new)** | proposing **9 unedited · 3 edited · 0 rejected** (n=12) · refusing **6 correct · 0 proposed anyway** (n=6) · 3 rounds, all three agreeing |
| `kestra:refusal` | **3 refused, 0 invented**; control produced clean code 3 of 3 |
| `outline:measure` | kept the shape **2 of 3** · drifted 0 · no parseable draft 1 (a step id over 63 chars) |
| `draft:measure` | goal **7/12 drafted, 1.1 attempts mean, 2.5 s** · outline **3/3, 2.0 attempts, 5.7 s** |
| `chat:measure` | 5 turns · applied 2 · refused 2 · failed 1 · steps reached 2 of 5 |
| `fingerprint:measure` | **0 fingerprints moved**, 8 workspaces / 45 refs / 2 armed |

⚠ **`draft:measure`'s ordering INVERTED.** The complaint this harness was built for was *"goal mode
takes forever, stepwise is quick"*; on `gpt-5.4-mini` outline mode costs **2.0 attempts and 5.7 s**
against goal mode's **1.1 and 2.5 s**. Do not quote the old reading as current.

⚠ **`chat:measure`'s `2 of 5` is one failure plus its consequences, not five.** Turn 1 failed on a
nested `{{ }}` (I-11), leaving the flow empty, so turns 2 and 3 correctly answered `too_structural`
— *"the automation is empty"*. A cascade reads as a 40% success rate.

### ⚠ How SC-006 was measured, because "acceptance rate" cannot be measured here

SC-006 asks how many proposals **a reviewer** accepts unedited, edits, and rejects. There is no
reviewer, and both fakes are worse than useless: an implementer eyeballing their own system's output
with the answer in front of them, or a model judging a model (two draws from one distribution). So
`propose:measure` adjudicates against an **expectation declared before the proposal is seen**, in the
commit that created the file — the expectations cannot be relaxed to fit a bad result without the
relaxation being in the diff.

- **What the number is**: agreement with a declared expectation. A real reviewer would accept some
  cases filed as `edited` (an extra column nobody minds), so **`edited` is an upper bound** and
  `unedited` a **lower** bound — the safe direction for a figure that gates a reliability claim.
- **Three of seven cases must REFUSE**, and that half is what makes the rest mean anything: without
  it, *"proposes well"* and *"always proposes something"* score identically.
- ⚠ **The hard case is reported separately and it fails.** *"Employees below their own department's
  threshold"* needs a column-to-column comparison; a filter compares a column to a **param** and there
  is no such form. Every table exists, so the prompt's refusal channel — worded for missing *data* —
  does not authorise the right answer. It proposed a compiling spec joining
  `attendance_monthly.employee_id` to `policy_thresholds.department_id`: **an employee id equated to a
  department id**, 3 of 3 rounds. ⚠ **And the readback caught it in plain English** — *"each row
  matched to policy_thresholds, by employee_id = policy_thresholds.department_id"*. That is the
  clearest evidence in this feature that the readback is the right review artefact, and it was
  produced by the case designed to fail.
- ⚠ **A high unedited rate is AMBIGUOUS** and the harness prints so: the proposals are good, **or**
  the expectations were written by the same hand as the prompt. It is never a quality score. And
  `--rounds` defaults to **3** because the first two runs of the file disagreed at n=6.
- ⚠ **The compiler does not require a join to follow a declared FK.** Two integer columns compile.
  Pre-existing — a person can build the same join visually — but a *model* can now reach it, and the
  readback is the only thing standing there. An FK-awareness check is a real improvement and is **not
  in this feature**.

**Green:** 7/7 typechecks clean · server **1763 passed / 23 skipped** (109 files), client **908** ·
`ui-honesty-check.sh` **206 PASS / 0 FAIL**. ⚠ Two failures are **pre-existing and not this
feature's**: `trigger-gate.test.ts` (staged-modified by another feature) and `flow-replay.test.ts`.
**Do not fix them here.**

⚠ **SC-004 held against the real database**, incidentally and more strongly than its unit test: `~35`
live propose calls across 5 runs of `propose:measure` left `hr_demo` with **0** `db_operations`.

⚠ **A scenario script's `main()` runs at IMPORT, and nothing in this repo guarded it** — because no
scenario file had ever been imported. `propose-measure.test.ts` imported the harness to reach its
adjudicator and silently loaded the repos, the config and the gateway client; a live run would have
fired ~7 model calls and `process.exit` **inside the test suite**. Symptom, if you need to spot it
again: vitest's `collect` was **903 ms** for a 13-test file, and **72 ms** after the fix. The
adjudicator now lives in `propose-adjudicate.ts` — pure, no database, no gateway, no `process` —
which is the same reason `db-operation-readback.ts` and `flow-expression-rules.ts` are separate
modules. ⚠ **Do not import a `scenarios/*.ts` or `kestra/*.ts` script from a test.** Extract what you
need to assert.

### ⚠ Phase 5 (2026-08-28) — making the chat turn reach the machinery Phase 3 built

`needs_component` **0 of 4 runs → 3 of 3**, on `gpt-5.4-mini`. Three changes, and **two of them were
found by reading the code before writing the prompt rule.** The phase would have failed without either.

**1. ⚠ `operations` WAS MISSING FROM CHAT'S CATALOGUE — a pre-existing bug, unrelated to any of this.**
The drafter passes `{tools, queries, operations}` to `resolveSelection`; the chat turn passed
`{tools, queries}`. `operations` is **optional** on that signature and defaults to `[]`, so nothing
errored — **every saved DB operation was invisible to every chat turn.** Build one visually on the
datasource page, then ask chat to use it: chat could not see it.
- ⚠ **I-127's shape a third time.** `expressionsBlock` was a five-line summary in chat while the drafter
  had the full `EXPRESSION_RULES`, and the comment then argued the case. **A shared builder with an
  OPTIONAL input is how one consumer silently gets less than another.** The posture, not just the call
  site: `buildChatPrompt`'s new `readerless` parameter is **required**, and two existing tests were
  updated rather than the type loosened.
- ⚠ It would have broken US3's second half whichever option was chosen: `refInterfaces` resolves a new
  operation's ref fine, so the operation existed — the model was never *told* about it. The offer would
  have worked and the retry would not.

**2. ⚠ A PROMPT RULE ALONE COULD NOT HAVE WORKED.** A chat turn's prompt is `CHAT_RULES` + the CALLABLE
STEPS catalogue + expression rules + the current automation + recent turns + the message. **There is no
manifest.** `catalogueText` renders only what is *callable*, so a reader-less datasource appears
**nowhere** — the op call cannot name `hr_demo` because it has no way to know `hr_demo` exists. (The one
earlier run that named it did so because the probe message did.) And naming it is not optional:
`refFindings` detects the gap by **matching a ref's prefix against a real datasource name**; a guess
produces *"does not exist"* and no gap.
- So there is now a `DATASOURCES WITH NO READER YET` section, **chat only**. Never the drafter's prompt:
  `DRAFT_RULES` deliberately says a manifest table is not callable, and advertising these there invites
  the invented `<ds>.<table>` ref T01 exists to stop — a headless draft has nobody to offer a component
  to. It would also move `catalogueText`'s bytes, which every generation measurement was taken against.
- `readerlessDatasources()` lives beside `refFindings` in `flow-generation.service.ts` and uses
  **byte-for-byte the same condition**. ⚠ **A test asserts the two agree datasource for datasource** —
  two definitions would break US3 in one of two silent ways, and nothing else notices. Computing it in
  the chat service is the exact alternative D-197 rejected. The allowlist grew **6 → 8**;
  `readerlessDatasources` is the first allowlisted symbol with a **query** behind it, admitted because
  it returns **data, not a decision**.
- ⚠ `countEntities()` was extracted so the table count has **one** implementation. The first draft of
  `readerlessDatasources` had a second one that dropped the schema qualifier and depended on
  entity-level rows existing — it would have silently omitted a datasource from the prompt. Caught by
  checking whether its own comment was true.

**3. Two prompt-authoring rules, both learned by getting them wrong and measuring the raw reply:**
- ⚠ **State the reply SHAPE as concrete JSON, never as "answer X".** Every other rule in `CHAT_RULES`
  says *"answer `too_structural`"* — and those **are** status values. So *"answer `add_step`"* read as
  *"put `add_step` in `status`"*, and that is exactly what came back:
  `{"status":"add_step","op":{"op":"add_step",…}}` → rejected by the discriminated union → turn
  `failed`. **The rule was wrong in a way that looked like the model failing.**
- ⚠ **Never put an angle-bracket template in a prompt.** `<datasource>.<the reader you need>` produced
  the literal ref `hr_demo.<reader for approved leave requests by period>`.

**⚠ FR-028's control is the load-bearing test, and it is a MEASUREMENT not a check.** A rule widened one
notch — *"add_step whenever anything is missing"* — would satisfy SC-009 **and** silently delete the
`too_structural` channel, with the prompt test green either way. So `chat:measure --scenario=2` carries
a genuinely structural probe **last**, arriving against a flow that has steps. It held `too_structural`
3 of 3. ⚠ `CHAT_RULES` remains the one rule set with no mechanical half (I-118 has no partner here) —
this is the substitute, and it must be re-run deliberately.

**Numbers, `gpt-5.4-mini`, 2026-08-28:**

| | Before | After |
| :--- | :--- | :--- |
| `needs_component` reached | **0 of 4** | **3 of 3** |
| FR-028 control still `too_structural` | — | **3 of 3** |
| Revision written on the gap turn | — | **none** (0 Kestra round trips) |
| `chat:measure` scenario 1 | applied 2 · refused 2 · failed 1 · 2 of 5 | applied 4 · refused 1 · failed 0 · **4 of 5** |

⚠ **Do not attribute scenario 1's improvement to Phase 5.** Its turn 1 previously failed on a nested
`{{ }}` (I-11) and cascaded; this run's turn 1 succeeded. Variance on that scenario is large.

⚠ **The natural multi-sentence phrasing is no longer a dead end but is NOT deterministic**: `applied`
three times in four, `needs_component` once. Both are defensible answers to an ambiguous request, so
that probe deliberately declares **no** expected status — declaring one would fail the harness for a
turn that did nothing wrong.

**Green:** 7/7 typechecks clean · server **1778 passed / 23 skipped** (1804 total), client **908** ·
`ui-honesty-check.sh` **206 PASS / 0 FAIL**.
⚠ **`datasource-target.test.ts` is FLAKY, not broken** — 5-second timeouts against a live Postgres, **2
failures on one run and 1 on the next with identical code**, and it imports nothing this feature
touches — and its own stderr says *"NOT CHECKED: collide_db (password authentication failed for user
u)"*, so the environment is what varies. It is also the test that leaves `ds-target-control-*`
workspaces behind: **6 now, up from 4**, i.e. it died mid-run twice more.
`trigger-gate.test.ts` and `flow-replay.test.ts` remain the two deterministic pre-existing failures.

### ⚠ Phase 6 (2026-08-28) — the date a month cannot have

**The first real use of P5's machinery failed**, and the failure is worth knowing by heart because the
cause is not where it looks. A drafted flow read a proposed operation whose filters are `type: date`, the
person gave a **month** (`{"period":"2026-06"}`), and the drafter bound the range end as
`"{{ inputs.period }}-31"`. June has 30 days. Kestra execution `7cwL1ris`, 0.4 s in:

```
date/time field value out of range: "2026-06-31"
```

⚠ **Before D-204 no step in any workspace had ever had a `type: date` parameter to bind** — a tool takes
whatever its endpoint takes. The drafter met this problem because that fix handed it the problem, which is
why P6 lives in that feature and not a new one.

⚠ **The literal `2026-06-31` is nowhere in the flow.** It is rendered from a template plus two
characters, so a check for bad *values* would not have caught it. `checkConstructedDates`
(`flow-date-params.ts`, in `SHAPE_CHECKS`) catches the **construction**.

⚠ **The rule is categorical because `ALLOWED_CALLS` is `{json, jq, first, length}`** — no date function,
no arithmetic. *"The last day of the month a person named"* is genuinely not expressible in an expression,
so the two remedies (declare the input **as a date**; or compute the range in a `code` step) are the
complete set. **Verify the allowlist before teaching any expression rule** — teaching filters the engine
does not have is I-118's original failure.

⚠ **`-01` … `-28` are NOT flagged and that is the load-bearing half.** The same failing step's
`period_start` was `"{{ inputs.period }}-01"` and correct. February is checked at **29**, not 28. The
check refuses only what is impossible, never what is unlikely.

⚠ **`EXPRESSION_FIELDS` is now exported** from `flow-expression.service.ts` and has two consumers. Its
docblock warns a missing field *"is not checked at all — the omission is silent"*; do not make a second
copy (D-197).

⚠ **When diagnosing a failing run, do NOT trust `flow_executions.status` alone.** It said `running` an
hour after Kestra said `FAILED`. Read the Kestra execution and its logs. A still-open bug, not P6's.

⚠ **`chat:measure`, `draft:measure` and `outline:measure` are STALE again** — P6 moved the prompt text on
every path. Do not quote a number from them for any path without a re-take.
## The secret gate: templates are committable, and the scan is single-pass (2026-08-28)

`specs/20260828-125520-secret-scan-templates-and-speed/`. Three defects in
`ci/secret-policy.sh` + `ci/check-secrets.sh`, plus two more found by the tests.
`bash ci/secret-policy.test.sh` is the record — **74 assertions**.

- ⚠ **A `.env`-family TEMPLATE is recognised by SHAPE, not by a list.** The
  exemption was three literal basenames, so **`.env.local.example` was forbidden**
  and **every `git push` of a new branch was refused** over a placeholder file that
  was already on `origin/v1-alpha` and matched no content pattern. `.env*` ending
  in `.example`/`.sample`/`.template` is now allowed at any depth. ⚠ **The suffix
  must be FINAL** — `.env.example.bak` and `.env.examples` stay forbidden, and
  widening that by one character is how `.env.production` gets admitted.
- ⚠ **TEMPLATES ARE NOW CONTENT-SCANNED, and that is the point of the change.**
  Allowing a name used to *also* exempt the content, so the obvious fix — add the
  name to both lists — would have made that file committable **and unexamined**. A
  false positive is loud and recoverable; a blind spot is silent. Verified a no-op
  first: neither existing template matched any pattern. **`.env`/`.env.local` stay
  content-exempt** — they are the correct home for real secrets, and the name rule
  keeps them out of git.
- ⚠ **Both rules now decide from the BASENAME**; they used to disagree, so a nested
  `.env.example` was scanned and the root one was not. The scanner's own two files
  stay matched on **full path** — a `secret-policy.sh` elsewhere is not this policy.
- ⚠ **The scan is ONE `grep` pass, and the old one was 1,216× slower — MEASURED.**
  `scan_line` spawned `printf | grep` per pattern per line: 2,915 processes for 265
  lines = **363,684 ms**, versus **299 ms** now; the full 608-file push range went
  ~12 min → **4.3 s**. The amplifier is this workstation's EDR (Cisco Secure
  Endpoint), which makes a bare `/usr/bin/true` cost **62 ms** instead of 1–3.
  ⚠ **It was not only slow.** A commit that prints nothing for six minutes reads as
  broken — it was reported as "stuck", interrupted twice, and diagnosed as a block
  it never was. A gate people believe is hanging is a gate people bypass.
- ⚠ **`scan_matches` TAKES ITS INPUT AS AN ARGUMENT, never from a pipe.**
  `... | scan_matches` puts it in a subshell where `report`'s `FOUND=1` never
  reaches `exit "$FOUND"` — the scan finds the secret, prints SECRET-BLOCK and
  **exits 0**. That was written for real during this change and only the
  planted-secret tests caught it. **Never turn it back into a pipe.**
- ⚠ **TWO PRE-EXISTING BUGS THAT SILENTLY SKIPPED CONTENT, both found by a test
  rather than by reading.** git appends a **TAB** to `+++ b/<path>` when the path
  contains a space, so `odd dir/.env.local.example` arrived tab-suffixed, stopped
  matching `*.example`, was classified forbidden — and forbidden files are
  content-exempt, so a planted key in it was never scanned. And git **quotes**
  non-ASCII paths (`+++ "b/pa\303\251th"`), which matches no branch at all, so every
  line of such a file was skipped. Fixed by stripping at the first tab and passing
  `-c core.quotePath=false`.
- ⚠ **`emit_diff_candidates` MUST STAY A TOP-LEVEL FUNCTION.** macOS ships **bash
  3.2.57**, which cannot parse a `case` statement inside `<( )` or `$( )` — it dies
  with `syntax error near unexpected token ';;'`. Inlining it at the call site is
  not a refactor, it is a syntax error on the platform this repo is developed on.
- **`grep -a` is DEFENSIVE AND UNREACHABLE, and the file says so.** Removing it is
  the one perturbation of five that does **not** fail, because bash's `read` drops
  NULs before grep sees them and git reports NUL-carrying files as binary with no
  `+` lines. ⚠ **A known bound falls out of that: content in a file git considers
  BINARY is never content-scanned.** Name rules still apply.
- ⚠ **NOT DONE, deliberately**: `.githooks/pre-push` still scans
  `merge-base(origin/main)..HEAD` for a new branch — 68 commits already on the
  remote. Real, and deliberate (it catches history created before the hooks
  existed). After this change it costs seconds, which is why it can wait.



## The IT Operations domain (2026-09-03) — a fourth tenant, and a capability that wakes people

The domains programme ran 2026-09-03 (⚠ closed; record removed 2026-09-11 — read this
section as the in-git record). Three of seven stages closed: `0112178`, `f440bec`, `6a669d6`.
Workspace **`IT Operations`** = `672d75e8-739e-4dfa-803b-1663d30a7ec1`, database **`itops_demo`**,
read-only role **`itops_ro`**, 10 tools, 7 named queries, 11 tables.

**ALL DATA IS SYNTHETIC**: invented hostnames and people on RFC 2606 `.example` domains, and an
invented `CVE-2026-9xxxx` block that is not a real NVD or CISA range. Nothing is fetched from
anywhere; both are asserted by tests.

### ⚠ AN SLA CLOCK IS NOT `resolved_at - opened_at`, AND THAT IS THE WHOLE DOMAIN

Two corrections come off it, and each **inverts an answer** rather than shifting a number:

- **Business hours.** For a service with `business_hours_only` the clock runs 09:00–17:00 Mon–Fri.
  INC-1007 opened 16:40 Friday and resolved 09:20 Monday: **forty business minutes** against a
  480-minute budget, and **3,880** if you subtract the timestamps.
- **Paused spans.** Time awaiting the customer is not the service desk's time.

⚠ **INC-1012 NEEDS BOTH AND NO SINGLE FIX RESCUES IT** — naive 8,400 breached; business hours only
1,680 *still* breached; raw elapsed minus raw pause 2,400 *still* breached; both together 480
against 1,440, healthy.

⚠ **The `sla_policies` key is TWO COLUMNS.** A bronze P1 has 480 minutes and a platinum P1 has 60;
four policy rows deliberately share `resolveMins = 480` so a priority-only lookup often lands on a
plausible number. This is `hr_demo`'s employee #14 in a second domain.

⚠ **All of it is resolved in `itops-queries.ts`, in SQL, not in the flows.** A trap resolved in the
catalogue is structurally unreachable; a trap left for a fragment to remember is one the measured
baseline says will be missed. **`BUSINESS_MINUTES` uses `ISODOW`, not `DOW`** — `DOW` numbers Sunday
0, so `< 6` would include Sunday and exclude Friday while the number stayed plausible.

**The band rule is a third kind of rule on purpose**: Finance teaches `>`, Legal the opposite `<=`,
and this teaches a **fraction** of each policy's own budget — breached at 100%, at risk at 80%.
Never a number of minutes: 80% of a platinum P1 is 48 and of a bronze P4 is 5,760.

⚠ **THE EVIDENCE IS THAT TWO INDEPENDENT IMPLEMENTATIONS AGREE TO THE MINUTE.** `itopsOracle()`
walks days in TypeScript; the catalogue does it in SQL with `generate_series`. `itops:verify`
compares `consumed_mins`, `paused_mins`, `naive_elapsed_mins`, `resolve_mins` and `notify_email` per
incident across 30 incidents at four instants — **not merely which band each landed in**, because
two wrong figures in one band read as agreement.

### ⚠ `paging` is a SEVENTH ops-api service, and a page is not an email

`page_oncall` / `page_search`, `bearer`, credential `PAGING_API_TOKEN`, capture table `pages`.

⚠ **THE ASYMMETRY IS THE CONTROL.** Only this workspace holds the credential, so Finance and Legal
cannot wake anybody **even with a hand-written tool row** — the endpoint 401s, so the refusal is at
the service and not at the catalogue. `itops-tools.test.ts` asserts it in both directions.

⚠ **IT DEDUPLICATES, and that is the real capability.** A flow on a fifteen-minute schedule pages the
same unresolved incident four times an hour, every call correct in isolation. Repeats are suppressed
on `dedupe_key` (the incident code) within a window. **Retry on the paging step is safe ONLY because
of this** — remove one and the other has to go.

⚠ **SUPPRESSION COUNTS ONLY *DELIVERED* PAGES.** A previous attempt that found nobody home has told
nobody anything; suppressing against it turns one unanswered page into permanent silence during an
outage. The decision lives in `packages/ops-api/src/paging-decision.ts` as a pure function precisely
so that rule can be asserted without standing up Postgres.

⚠ **None of the three outcomes is an error** — `delivered`, `suppressed`, `no_responder` all return
201 with the outcome in the body. A 4xx would make a retry re-page, which is what suppression exists
to prevent. And there is deliberately **no email template for a breach**: a breach is a page, and
offering the cheap wrong action beside the expensive right one is how a run goes green with an
incident unattended.

### ⚠ Two flows, two DIFFERENT branch shapes, and the contrast is the lesson

`itops-sla-triage` uses an **if/elif/else chain** — its arms are alternative ANSWERS to one question
(*how loudly does this run escalate?*), so exactly one fires: page · ticket · digest, three
recipients, three costs. `itops-vuln-remediation` uses **two independent guards** and is NOT a chain,
because its conditions describe **disjoint sets of work** that can both be non-empty at once.

> **A chain is right when the arms are alternative answers to one question. Separate guards are right
> when each arm is its own piece of work.**

⚠ **A BRANCHING FLOW THAT PICKS THE WRONG ARM IS GREEN.** Every expression renders, every task that
ran succeeded, the execution settles SUCCESS — because the tasks in the arm that should have fired
were never scheduled. Nothing in the seed, in `kestra:check` or in any unit test reports it. The only
evidence is which task ids appear in `taskRunList` versus the oracle, which is what
`itops:scenarios-verify` exists for — and it asserts **both directions**, because "the page task ran"
is satisfied by a flow that runs every arm every time.

⚠ **EVERY TOOL `paramsExpr` MUST END `| first`.** Pebble's `jq()` returns a LIST, so `jq('[…]')`
renders `[[…]]` and the callback refuses it with `params: ["Expected object, received array"]` — a
message about the shape of one element, which reads like the projection being wrong.

### ⚠ NO Kestra-touching harness runs from a macOS host, and that is PRE-EXISTING

Measured 2026-09-03: the host cannot reach Kestra's container IP at all. Kestra publishes no ports
and cannot (I-03/I-05), so `scripts/kestra-env.sh` resolves that IP — routable on Linux, where this
repo was developed, and not on Docker Desktop. **`scripts/harness-in-net.sh`** runs a harness in the
same network position the server already occupies.

⚠ **It deliberately is NOT a socat port-forward.** A forwarder is a real host→Kestra route for as
long as it runs, one `--restart` from permanent, and **`kestra:check`'s "Kestra publishes no ports"
assertion would still pass while the route existed** — the boundary intact in the file and gone on
the machine.

### ⚠ Still owed

**`itops_demo` is in `backup.sh`'s `DEMO_DBS`: NO.** See the warning beside that list. It is also
absent from `services/datasource-target.test.ts`'s roster. The isolation claim is **four directions,
not twelve** — `itops_ro` is checked against the other four databases; the other three roles are not
checked against `itops_demo`. **Never call it symmetric.**

## The three generic domains (2026-09-04) — and a clean, demo-able slate

⚠ **THE FLOW SLATE WAS CLEARED AND REBUILT.** `slate:clear` removed **13 flows** (3 armed) and 397
executions; every capability was preserved. The deployment now holds **8 flows across 5 workspaces,
all armed**, all named for the job they do rather than the mechanism they use:

| Workspace | Flow | Shape |
| :--- | :--- | :--- |
| HR | Monthly attendance check | branch + **merge** + shared tail |
| HR | Chase the ones we could not email | one guard |
| HR | Department attendance digest | `llm_complete` as a leaf (D-34) |
| IT Operations | SLA triage — page, ticket or digest | if/elif/else chain |
| IT Operations | Vulnerability remediation, freeze-aware | two independent guards |
| Customer Support | Chase tickets that missed their target | branch + **merge** |
| Orders & Fulfilment | Tell customers when their order is late | branch + **merge** |
| Recruitment | Chase offers before they expire | branch + **merge** |

Seeded by `hr:demo-flows`, `itops:scenarios` and `generic:flows`. ⚠ **On macOS every one of these
needs `scripts/harness-in-net.sh`** — Kestra publishes no ports and the host cannot reach its
container IP.

### ⚠ The `merge` kind — a condition can finally have a shared tail

`armOf` is a blind transitive closure over `dependsOn`, so **any** step reading an arm member's
output BECOMES an arm member. A shared tail after a branch was therefore **unexpressible**, not
merely awkward: it had to be duplicated into every arm and the copies drift. ⚠ **A `transform` does
not escape it** — it is swallowed identically.

The whole mechanism is one line: **the closure stops at a `merge`.** Deliberately NOT a per-step arm
marker, which D-123 already refused.

- **The coalesce is `??` and must never become `default(…)`.** Both work on the engine (measured,
  with a positive control proving they discriminate). `??` is an **operator**, and D-22's allowlist
  governs which *functions* may be called — so it passes the scanner unchanged while `default` would
  need a new entry on the one list standing between a drafted expression and a runtime failure.
  **Verified against `validateGeneratedExpr`, not assumed.** Merge cost **zero** allowlist change.
- **Sources are restricted to `tool`/`datasource`/`query`/`transform`** — the kinds whose raw output
  is a JSON string, so one spelling (`json(outputs.<merge>.value)`) reads the result whichever arm
  ran. `code`'s `vars.result` is an object; `agent` is free text; `approval` and `branch` produce
  nothing.
- ⚠ **A tail must read `.succeeded`/`.failed` off the merge, never `.results[0].data`.** The envelope
  is identical whichever arm ran; the payload inside it is not, and a tail depending on which arm won
  is the bug a merge exists to prevent.
- ⚠ **`agent` and `approval` INSIDE AN ARM ARE NOW ALLOWED.** The old refusal's stated reason was
  *"unverified against this engine"* — a want of evidence, not a property. Measured: a
  `core.flow.Pause` inside an `If` arm works end to end (PAUSED → resume 204 → arm completed →
  top-level tail ran). **A nested `branch` stays refused**, and its message now says honestly that
  this is a COMPILER limit, not an engine one — the engine allows it.
- ⚠ **`STEP_SHAPES`' bytes moved**, so `draft:measure`, `outline:measure`, `chat:measure` and
  `kestra:refusal` **owe a re-take**. They were already stale from the Phase 6 date work. The digest
  test carries the reason; do not quote a number from any of them meanwhile.
  - ⚠ **PAID 2026-09-06 on `gpt-5.6-luna`** — see "RE-TAKEN 2026-09-06" above for all four, and read
    the note about `kestra:refusal`'s CONTROL weakening before quoting its refusal rate.
    `chat:measure` went stale again one commit later (`add_guarded_step` joined `CHAT_RULES`).

### The three domains

`packages/server/src/demo/generic/` — `generic:seed` then `generic:flows`. Workspaces **Customer
Support** (`support_demo`), **Orders & Fulfilment** (`orders_demo`), **Recruitment** (`hiring_demo`),
each with its own read-only role and six named queries. **No new ops-api service**: they use mail,
chat, ticketing and `llm_complete`, which is Finance's and Legal's arrangement.

⚠ **EACH TEACHES A DIFFERENT RULE AND THEY MUST NOT BE MADE CONSISTENT** — the same reasoning
Finance's `>` and Legal's `<=` already carry:

- **Support: a non-response is not a satisfied customer.** `avg(score)` over responders is
  arithmetically correct and answers a question nobody asked. `csat_by_team` returns
  `response_rate_pct` beside it. Also: the SLA budget is keyed on **(plan, priority)**, and a ticket
  is judged by the priority it carries **now**, not the one it opened with.
- **Orders: a partial shipment is not a fulfilled order.** `EXISTS (shipment)` calls it done and
  removes exactly the orders somebody needs to chase from the list of orders to chase. Also: a
  **cancelled line is not revenue**, and `unit_price_cents` is MINOR while `credit_limit` is MAJOR.
- **Recruitment: an application is not a candidate.** People apply twice, so every funnel on
  `COUNT(*)` double-counts the keenest applicants — the ones most likely to reach a late stage, so
  the error is *biased*, not spread. And **"at a stage" is not "reached a stage"**: a rejected
  candidate reached the interview stage. Time-to-hire has two legitimate denominators and both are
  returned, named, in one row.

⚠ **THE ENGINE IS SHARED; THE FOUR OLDER SEEDERS ARE UNTOUCHED.** `seed-itops-db.ts` said to extract
the roster at the fifth tenant and to argue it on its own merits. The argument, recorded in
`demo/generic/domain.ts`: four seeders written months apart drift slowly and visibly, three written
in one sitting are copy-paste by construction. **The data, the queries and the traps stay
per-domain** — a shared oracle lets a shared bug produce a wrong answer that agrees with itself.

⚠ **A REAL SECURITY DEFECT, CAUGHT BY THE CHECK RATHER THAN BY READING.** On the first run
`orders_ro` could `CONNECT` to `support_demo` and `hiring_ro` to both. **Postgres grants CONNECT to
PUBLIC on every new database**, and revoking on the *schema* does not touch it — so
`REVOKE CONNECT ON DATABASE … FROM PUBLIC` is load-bearing. **This is the third time this exact trap
is recorded here** (the demo roles, then I-04). It was caught only because the verification
re-derives from `pg_catalog` instead of reading back what it had just written.

⚠ **The isolation check is a FINAL PASS, deliberately.** Each domain seals its own database, so
asking mid-sequence gets an answer true at that instant and false a moment later — which is what the
first run reported, alarmingly and correctly. The wrong fix is a domain revoking on its siblings'
databases; the right one is to ask once, at the end.

⚠ **Isolation is still NOT symmetric.** The three new roles are checked against all seven other
databases; `foundry_ro`, `finance_ro`, `legal_ro` and `itops_ro` are **not** checked against the
three new ones — that needs an edit to four seeders this feature deliberately did not make.

### ⚠ Three bugs found by RUNNING, that no amount of reading would have caught

- **I-11 again.** Splicing a period as `{{ inputs.period }}` puts a template INSIDE a jq program,
  which Pebble does not re-evaluate — the literal braces would have reached an employee's inbox.
  Concatenate with `~`: `' ~ inputs.period ~ '`. It applies to jq programs only; a `datasource`
  step's `paramsExpr` is plain JSON and takes the template form.
- **`json(…).results[0].data.text | jq(…)` fails at execution.** Plucking the field first hands jq a
  raw multi-line string, and jq's input must be valid JSON — so it breaks exactly when the step does
  its job, because a model's prose has newlines in it. Put the whole envelope into jq and pluck
  inside the program.
- **A query that ignores its own `as_of` makes its empty case unreachable**, so a branching flow
  built on it can never take its other arm. Found only by running the empty instant. ⚠ **Run every
  branching flow at a second instant**; a green run does not prove the right arm fired.

⚠ **A tool DESCRIPTION naming a chat channel the service does not have is not a documentation slip.**
The call 404s at runtime, after the flow is authored, approved and armed — which is how all three
generic demo flows failed their first run. Six channels were added to `packages/ops-api`'s
`CHANNELS`; that list and `demo/generic/tools.ts` must stay in step.

## ⚠ A version is an APPROVAL, and the workflows list agrees with the engine (2026-09-07)

Three reports from UAT, all client-visible, one of them a real defect that made a working
server look broken. **No spec-kit feature** — the user directed that spec-kit be set aside for
this pass, so there is no `specs/` directory for it and this section is the record.

### ⚠ 1. "Turning a flow off does not work" — it worked, and the row said otherwise

`flowApprovalService.revoke` removes the Schedule trigger from Kestra, closes every approval
row, writes `status: "suspended"` — and **deliberately leaves `armed_revision` set**, because
re-approval and the diff both need to know which revision was live. Four client call sites read
`armedRevision != null` as *"running unattended"*, so a successfully revoked flow kept a green
ON toggle, stayed in the `Live` view, and offered no explanation. Pressing it again revoked
again, to the same invisible effect.

⚠ **MEASURED on the deployment, not inferred**: three flows at `status = suspended` with
`armed_revision` set and **zero open approvals**, every one rendering as live and on. The `Live`
tab said 4; one flow was actually live.

- **`isRunningUnattended(flow)` in `lib/flow-views.ts` is the ONE definition**, read by
  `VIEWS.live`, `VIEWS.scheduled`, `ArmSwitch`, `FlowRow`'s suspended treatment and — a **fifth**
  site found while fixing it — `/live`'s own filter, which listed turned-off automations on a page
  titled "Live workflows" beside a Run control.
- ⚠ **`draft_pending` IS RUNNING, and a narrower predicate gets this wrong.** An armed flow
  edited since approval keeps firing the APPROVED revision. `status === "armed"` would render OFF
  on a flow that fires at 09:00 — the one direction of this bug that is dangerous rather than
  merely annoying. There is a named test.
- ⚠ **An exhaustive `Record<FlowStatus, boolean>`, not a comparison or a `Set`.** Both defaults
  are wrong and they are wrong *asymmetrically*, so a new status must not be able to arrive
  without somebody deciding. It fails to compile until they do.
- ⚠ **`offReason` gives the two causes two sentences.** `staleReason` is written by the staleness
  sweep alone; `revoke` writes none. The row's `suspended` flag used to require `staleReason`, so
  a revoked flow got no warn ground, no `Review` and no explanation at all.

### ⚠ 2. The list scrolled sideways because `truncate` WIDENS a table cell

The purpose sentence was rendered with Tailwind `truncate` inside an `auto`-layout `<td>`.
`truncate` sets `white-space: nowrap`, and under `table-layout: auto` a cell's min-content width
is then **the whole string** — descriptions here run to 221 characters. So `truncate` was
widening the column, not clipping it, and the last column (the arm switch and the row menu) was
pushed off the right edge where nobody could reach it. **That is why report 1 looked worse than
it was.**

`table-fixed` + `<colgroup>` is what makes the declared widths authoritative, and it is the only
arrangement in which `truncate` or `line-clamp` mean anything inside a cell. `whitespace-nowrap`
now survives only on Status (the pill and the version tag are one statement); Owner was the
second-largest contributor, being full email addresses with no break opportunity.
⚠ **`overflow-x-auto` was REMOVED, not kept** — it would hide a regression rather than prevent
one. The sentence is one clamped line with a chevron disclosure, and the button lives **outside**
the row's `<Link>`: a `<button>` inside an `<a>` has a click target the browser picks.

### ⚠ 3. A VERSION IS AN APPROVAL — `revision` is an engine identifier and is off the screen

Reported twice. First *"for each change on builder it increments the version… it should only
increment once we save a draft"*; the earlier answer hid intermediate revisions from the version
LIST (`hidden_at`, `saveDraft`) and left the NUMBER climbing, so it came back. Then, decisively:
**"increment revision only on approval — without that there won't be any versioning."**

- **`FlowSummary.version` is the count of approvals** — `flowRepo.approvalCountsFor`, one grouped
  query for the whole list, `null` until somebody approves. It cannot move while anybody edits,
  because editing approves nothing.
- ⚠ **Revoked and stale approvals are COUNTED.** `flow_approvals` is insert-only and closed by
  timestamp; excluding them would renumber every version above one the moment somebody turned it
  off, silently changing which version an audit trail refers to.
- ⚠ **`versionsFromApprovals` orders by `approvedAt`, NOT by `revision`.** They usually agree and
  are not the same claim — gate 1 having been downgraded to a warning (below), somebody may
  deliberately approve an older revision, and numbering by revision would then show v2 approved
  before v1. A null `approvedAt` sorts **last**, because `?? ""` would win an ascending compare
  against every real timestamp and make an unstamped row v1.
- ⚠ **`revision` still travels and is still what an approval binds to** (§6.5 — the binding is
  what stops approve-once being a blank cheque). It is in `foundry_revision`,
  `flow_executions.flow_revision` and every replay. **What changed is only that it is no longer
  shown to a person.** This is the `flowId` hazard again — a Kestra slug and a Foundry uuid under
  one name (I-23) — so it is named rather than left to be inferred.
- **De-numbered surfaces**: the list chip, `/flows/[id]`'s ribbon and tag, the builder header
  (`Draft · unsaved changes`, no number), `ApprovalPanel` (*"Approve this draft"* — there is no
  version to name **before** approving, because approving is what creates it), `RevisionBanner`,
  and `VersionTimeline`, which now renders **approvals** and keeps a retired version in the list
  with its number.
- ⚠ **`RevisionDiff` takes `of: "approval" | "edit"`.** In chat it printed
  `Changes from v1 to v2` once per sentence typed — the quoted symptom — and a `needs a human`
  verdict on a decision nobody had been asked to make. `of="edit"` says *"What this change did"*
  and renders **no** approval-requirement chip; the §6.5 asymmetry is **scoped, not deleted**, and
  the footer sentence is **not rendered** rather than `hidden`, because a `hidden` attribute still
  reaches a screen reader.

⚠ **The approval-ordinal route was chosen over minting revisions at approval time**, and the
reason is worth keeping: the latter needs ~38 `writeRevision`/`create` and 10 `approve` call
sites changed, schema semantics, and — decisively — **a new control on `approve`**. `approve`
takes an explicit revision today, which is what makes *"the thing you read is the thing you
armed"* true; minting from "the current draft" opens a TOCTOU on the product's most
safety-critical path. The cost accepted instead is the double numbering named above.

### ⚠ 4. `more` was asked for in the prompt and read by NOTHING — the chat builder's truncation

`CHAT_RULES` has said for months: *"ONE op per reply. If the instruction needs more than one, do
the FIRST one and set `more`:true — you will be asked again."* `more` was declared on
`chatTurnResponseSchema`, defaulted, and read by **nothing** — not the service, the route, the
repo or the client — and `flow_chat_turns` has no column for it. **Nobody asked again.**

From the report, on `finance_demo`, with `llm_complete` and `foundry_email_send` both registered
in that workspace:

> *"generate a summary of this and send me the report on email"* → added a transform step
> `overdue_invoices_summary_input`

That is op 1 of 3 (project → summarise → send), **correct** per I-42's rule that a tool step never
consumes a raw query row — the step is even named for it — and truncated. It reads as the model
doing something unrelated; it was the server dropping the flag.

⚠ **This is I-120's shape at the top of the product**: a value computed, defaulted and discarded,
so the check was correct, its tests passed, and no behaviour depended on the answer.

- **The loop is the SERVER asking again**, which is what the prompt already promised.
  ⚠ **`chat-turn-one-op.test.ts` is UNTOUCHED**: the reply still carries **one op, singular**, no
  array form, one op per model call. That control is what stops a chat box becoming a goal box and
  it must not be traded for this.
- **`attemptOp` now takes the flow the op applies to.** It closed over `base` and could therefore
  only ever run once. Its emptiness guard moved from `!flow` (the DB row) to `!current.steps.length`
  — equivalent for op 1, and correct for op 2, where the row does not exist yet but a step does.
- **Five bounds, all deliberate**: `MAX_OPS_PER_TURN = 5`; `more: false`; any non-`ok` status stops
  the loop **and does not fail the turn** (a continuation answering `too_structural` is the model
  declining to guess, and op 1 was still right); a refused `attemptOp` keeps what was applied; and
  ⚠ **an op that changes nothing ends the loop** — the bound that actually fires, because a model
  told to send "the smallest harmless op" when finished will re-send the last one.
- ⚠ **No corrective pass on a continuation.** The one extra call it costs is justified for the op a
  person typed; per continuation it doubles the bound and its findings would be about an op nobody
  asked for. Pinned by there being exactly **one** `:correct` label in the file.
- ⚠ **ONE write per turn, however many ops.** Each op used to mean a `writeRevision` — a compile, a
  Kestra deploy and an insert-only row — so a three-part request would have cost three of each.
  Pinned by asserting `create`/`saveRevision` appear **below** the loop and exactly once.
- **`findingsJson` carries one `describeOp` line per op, each against the flow IT was applied to**
  (`bases[i]`) — describing op 2 against the turn's original flow names the wrong neighbour.
  `op_json` stays a single op: it is what `resolvedStepId`/`resolvedBy` are about, and those are the
  mis-resolution measurement. The panel renders every line, numbered only when there is more than
  one.

### Domain-relevant example copy

Four placeholders were hardcoded Finance/HR prose shown in **every** workspace — the chat composer
said *"Add a step that reads the overdue invoices"* in Legal. `exampleSubject`/`composerHint` in
`lib/chat-suggestions.ts` derive them from the workspace's own catalogue: **derived, never
generated** (D-73), no inference, and `null` when the catalogue is unreadable so the fallback is
**domain-free** rather than another domain's nouns.
⚠ **`welcomeFor` stays a constant and must not be derived** — `ui-honesty-check.sh` bans
`turn.text` on that surface so no unchecked prose reaches it, and a welcome assembled from data
would satisfy the ban under a different field name.
⚠ `NeedsComponent`'s *"what this step needs to read"* placeholder is **deliberately** domain-free
and NOT derived: that input exists because the datasource has **no** reader, so the catalogue has
nothing to name for it and `exampleSubject` would offer a different datasource's data as an
example of what to read from this one.

### ⚠ Findings a reader must not miss

- ⚠ **GATE 1 IS NO LONGER A GATE**, and CLAUDE.md describes it as blocking in about a dozen
  places. `flow-approval.service.ts` now reads *"Gate 1 — now WARNING not BLOCK … Previously this
  threw 409 when !hasSucceeded"* and `console.warn`s instead. Asked for deliberately ("switch to
  any version even if never run"), but **do not quote gate 1 as refusing an unrun flow.**
- ⚠ **`Awaiting approval` CANNOT MATCH ANY FLOW.** Its predicate is
  `status === "approved" && armedRevision == null`, and `approve` sets both in the same `update` —
  so it has counted `0` for every flow that has ever existed. **Pinned as a named `DEFECT:` test
  rather than fixed**: what the tab should mean is a product decision, and redefining a view while
  fixing an unrelated predicate is how a tab comes to mean something nobody chose.
- ⚠ **Two test suites were pinned against IMPOSSIBLE fixtures**, which is why the old predicate
  looked correct: `flow({ armedRevision: 3 })` inherits `status: "draft"`, and `writeRevision`
  writes `draft_pending` whenever a revision is armed. Every fixture in these files is now a state
  the server actually writes.
- ⚠ **`datasource-target.test.ts`'s tenant roster was FOUR of eight** — `itops_demo` and the three
  generic databases were never added, so its positive control covered half its subject. Now eight,
  with a skip that names the seed to run. (`backup.sh`'s `DEMO_DBS` was already complete; the
  "still owed" note above it is stale.)
- ⚠ **THIS DEPLOYMENT HAS THREE DOMAINS, NOT SEVEN.** `itops_demo`, `support_demo`, `orders_demo`
  and `hiring_demo` do not exist here, the four workspaces are absent from `workspaces` including
  soft-deleted rows, and the IT Operations workspace id this file names does not resolve. **The
  code is entirely intact and committed** (`f440bec`, `6a669d6`, `eccb22a`) — the seeds were simply
  never run on this machine. Migrations are fully applied (58/58). Read a workspace id off the
  database, never out of this file.

### Verification

Client typecheck clean · server typecheck clean · client **121 files / 1992 tests** ·
`ui-honesty-check.sh` **212 PASS / 12 FAIL, byte-identical to the pre-change baseline** (all
pre-existing; the diff was compared, not eyeballed) · `next build` exit 0.

**Nineteen perturbations, nineteen red runs** — the predicate reverted to `armedRevision != null`,
`staleReason` re-required, `table-fixed` dropped, the chevron rendered unconditionally, versions
sorted by revision, `VersionTimeline` printing the engine revision, the list chip reverted,
`of="edit"` dropped, `let more = false`, the no-change bound removed, a refused continuation
failing the turn, every op described against the original base, a continuation applied to `base`,
and the change-line list reduced to `findings[0]`.

⚠ **One perturbation did NOT fire, and that gap is now closed**: reverting `RevisionDiff` to print
`Changes from v1 to v2` turned **nothing** red — the most-quoted symptom in the whole report had no
test. I-38 exactly, found by perturbing rather than by reading.

⚠ **STILL OWED, and stated rather than left to be discovered:**

- **`chat:measure` has NOT been re-taken.** It was already stale by two commits, and the `more`
  loop changes what a turn costs and what it accomplishes — so there is currently **no valid chat
  accuracy or cost number for this build**. `chat:measure --scenario=1` and `--scenario=2` are
  owed, and scenario 2 carries the FR-028 control that must still answer `too_structural`. **Do not
  quote any chat number until it is re-run.**
- **ChatWorkbench's 10 canvas gestures still write a revision each.** The visible symptom is gone
  (no number climbs any more), but a drag is still a compile, a Kestra deploy and an insert-only
  row. Batching them behind its existing Save is the remaining half.
- **Nothing was re-seeded and nothing destructive was run** — see the domain finding above for the
  commands.

## ⚠ A workflow has an ANSWER now, and the catalogue stopped being the limit (2026-09-08)

Five UAT reports in one session. **No spec-kit feature** — the user directed that spec-kit be set
aside, so there is no `specs/` directory for any of this and this section is the record.

### ⚠ THE DEPLOYMENT'S STATE, MEASURED AT THE END OF THE SESSION

**Read it off the database, never out of this file** — the paragraph this replaces was wrong twice.

| | |
| :--- | :--- |
| Workspaces | **4** — Finance, Customer Support, Orders & Fulfilment, Recruitment. HR, Legal, IT Ops and the three 2026-09-04 domains **do not exist here**. |
| Flows | **12**, three per workspace, **none armed, none approved**. Every one authored through `flowChatService.turn`. |
| Readers | **12** DB operations, three per datasource (`demo/catalogue/operations.ts`). The four single ones were **pruned**. |
| Tools | **20** — five per workspace: `test_email_send`, `foundry_email_send`, `llm_complete`, `ticket_create`, `chat_post_message`. |
| Triggers | **8**, all **disabled** (gate 1 needs a successful run first). Zero before this. |
| Templates | **4** real `flow_templates`. Zero before this. |

`pnpm --filter @foundry/server catalogue:seed` (add `--prune`) rebuilds the catalogue;
`catalogue:flows` (add `--purge`) rebuilds the flows. **Both need `scripts/harness-in-net.sh`.**

### ⚠ 1. A step could read a column its DB operation never returns

A real run failed with `{"to":["Expected string, received null"]}` on all 8 email calls (Kestra
`3VRhNsJO8222ebwGOQClFH`). The transform read `.customer_email` off `orders_demo.past_due_orders`,
which projects seven columns and never joins `customers`. **The literal null is nowhere in the
flow** — it is what a jq read of an absent key yields — so no check for bad VALUES could see it.

⚠ **The failing case was the LUCKY one.** A null recipient is refused by the mail route.
`sort_by(.created_at) | first` over rows with no `created_at` returns an arbitrary row and the
execution settles SUCCESS. Measured: **14 of 29** transform steps over an operation read a column
that does not exist, and only the email ones failed. D-68's finding with a new subject.

- **`RefInterface.columns`** carries the projection and `catalogueText`'s `operationLine` renders it.
  That line showed an operation's INPUTS and nothing about its output, so a model chose field names
  from the operation's *name*. I-126 and I-40 a third time — except **exactly knowable**:
  `specJson.columns[].alias` IS the key set of `.results[0].data[i]`.
- **`checkRefOutputFields`** refuses such a read at `assertValid`, the mirror of `checkFlowParams`.
- ⚠ **`checkOutputShapes` stops one level above and states the bound it believed** — *"only the
  tenant's data says whether `employees` exists."* That sentence was already corrected once (the body
  is Foundry's envelope, hence checkable); it is wrong a second time for the same reason, one level
  down, **for an operation alone**. A tool and a named query genuinely do not declare their output.
- ⚠ **THE CHECK IS STAGE-AWARE BECAUSE A FLAT NAME LIST HAD FALSE POSITIVES.** jq is a pipeline and
  only the first stages see the query rows: in
  `map({customer: .[0].customer, amount_owed: (map(.amount)|add)}) | sort_by(.amount_owed)` the first
  two reads are wrong and `.amount_owed` is **correct**. The flat version slandered it — I-62, where
  a guard that cries wolf gets widened until the widening permits the defect.

### ⚠ 2. A WORKFLOW HAD NO ANSWER — verified at the wire before it was built

`FOUNDRY_EMITS` carries no `core.output.OutputValues`, so a compiled flow declares no outputs;
`POST …/triggers/:tid/fire` answers `202 {fireId, started, error}`. Getting a value meant: fire →
list the trigger's fires → match `fireId` → `flowExecutionId` → poll the execution → pluck
`steps[i].output.value` **by a hardcoded step id**. Rename the step and it breaks silently.

⚠ **`FOUNDRY_EMITS` is SEVEN classes, not eight** — this file said eight; `core.execution.Fail` went
with the `agent` step.

- **`FlowModel.output`** names the step. The compiler reads it and **emits nothing**, exactly as
  `expectations` does: an `OutputValues` task would put an unemittable class in the YAML (UXI-003)
  and need a new allowlist entry. The value already crosses back through the **redacted** step view.
- ⚠ **NOT in `structureHash`**, following `expectations`, and the counter-argument is recorded: the
  steps that run are identical and the value was already readable, but this DOES change what a caller
  receives, so a reviewer is not approving the choice of result step.
- ⚠ **`flow-result.ts` treats "no answer" as FOUR states with four sentences**, never one null:
  nothing declared · the step is not in this run · the step did not succeed · the output could not be
  read. D-66's ranking — a caller that cannot tell them apart retries the wrong one. **`failed > 0`
  does NOT make a result unavailable**: 7 of 10 sent is a real answer AND a real failure.
- ⚠ **`checkFlowOutput` refuses `approval` and `branch`.** Both yield null for ever on a run where
  every task is green.
- ⚠ **`CanvasNode.boundary`'s docblock said there is no `"end"` and gave three reasons. Two became
  false and the third is now beside the point.** Corrected in place, not deleted. `withEnd` is drawn
  **even when nothing is declared** — a flow with no result is the most common broken state and the
  canvas is the only place a person would find out. A declared-but-missing step attaches to
  **nothing**; falling back to the leaves would draw a correct-looking exit point over a broken
  declaration. ⚠ Written the wrong way first; the test caught it.
- ⚠ **`set_output` is the NINETEENTH flow-edit op, and without it the feature did not exist.** The
  builder's exit-point panel reports and does not edit (a form there would be a second author of
  `model.output`, D-197) and points at chat, which had no op to point at. A field only a seed script
  can write is a field the product does not have. **Reached from a plain sentence, 8 of 8.**
- ⚠ **`touchedBy` and `resolvedStepId` both answer EMPTY** though the op names a step — declaring a
  step the result changes nothing about it, and `resolvedStepId` exists to make mis-resolution
  measurable.
- **PROVEN AT THE WIRE**: `Open ticket digest` (`tickets_opened_since` → transform →
  `llm_complete`), draft-run, `read_from: sandbox`, and the execution answers
  `result.value.text = "This week, 2 support tickets were opened…"`.

### ⚠ 3. The catalogue was the limit on what an automation could be

Four workspaces held **three tools and ONE DB operation each**. Measured consequences:
every buildable automation was "read the one thing, email it"; **`needs_component` fired ZERO times
across eleven conversations** because a reusable-looking reader always existed, so flows reused it
where it was plainly wrong; and the single reader projected no address, which invited the guess above.

- ⚠ **EVERY READER A NOTIFICATION COULD FOLLOW PROJECTS AN ADDRESS**, asserted over every reader so
  a new one cannot be added without a decision.
- ⚠ **The two action tools were removed on request and the argument is KEPT**: they are the cheap
  arms of a branch. They are back because the catalogue was the limiting factor.
  `ticket_search`/`ticket_update`/`chat_list_channels` stay **out** — reading is the datasource's job.
- ⚠ **`ACTION_WORDS` moved to `lean-catalogue.ts` as the ONE copy of the channel names.** A tool
  description naming a channel `ops-api`'s `CHANNELS` lacks 404s at runtime *after* approval.
- ⚠ **An operation can now carry AUTHORED parameter prose.** The derived description is
  `"lt filter on public.invoices.due_date"` — silent about whether `as_of` is `2026-06` or
  `2026-06-30`, which is I-126 and what produced `"{{ inputs.period }}-31"`. Only `description` is
  taken; `type` and `required` stay derived.
- ⚠ **TWO COMPILER LIMITS the specs are written around — AND BOTH ARE NOW FALSE.** The paragraph is
  corrected in place rather than deleted, because the specs written around these limits still carry
  their shape. It read: *"There is **no `is_null` op**, so 'no shipment yet' is a `left` join
  returning the null for a transform to select on. And **a column name cannot be qualified — an
  ambiguous one silently resolves to the first owner with no finding**, which is a real gap in the
  VISUAL builder too."*
  - **`is_null` EXISTS**, and appears never to have been missing in the form this claimed:
    `FILTER_OPS` carries `is_null` and `is_not_null`, with zod refinements, readback text and SQL
    emission (`db-operation.service.ts`, `db-operation-readback.ts`). The `left`-join workaround is
    still legal; it is no longer the only way.
  - **A column name CAN be qualified** since 2026-09-22 (`cb1eb68`) — `table.column` or
    `schema.table.column`, on the eight fields that resolve against the whole join chain and on no
    others. An ambiguous bare name still resolves to the first owner, which is deliberate, but it is
    **no longer silent**: `CompiledOperation.ambiguousColumns` carries the choice and
    `OperationReview` renders it. ⚠ It is REPORTED, not refused — joining on `id` is the ordinary
    case, so a refusal would have rejected most correct operations on day one.
  - ⚠ **Neither had a measurement, and the `is_null` sentence survived here for weeks while the op
    worked.** A limit written down and never re-checked is one every later spec is designed around.
- ⚠ **A THIRD COMPILER LIMIT, AND IT IS THE ONE STILL OPEN: A BRANCH CANNOT CONTAIN A BRANCH.**
  `flow-compiler.service.ts` throws by name — *"the engine allows a nested condition; this compiler
  does not emit one yet — its assembler nests arms through `otherwise`, not recursively."* Flagged
  here on 2026-09-22 so it can be picked up deliberately rather than rediscovered as a bug.
  - ⚠ **THE REFUSAL IS OURS, NOT KESTRA'S.** A nested `core.flow.If` with a native `else:` was
    **measured working** against v1.3.29 on 2026-09-04, in the same pass that admitted `approval`
    inside an arm. So this is a compiler limit that knows it is one — do not describe it as an
    engine constraint, and do not re-measure the engine before starting; that half is done.
  - **What it would take.** Recursive emission in `flow-compiler.service.ts`, which is the **sole
    YAML emitter (R8)** and the most safety-critical module in the compiler. The assembler renders
    one arm at a **fixed depth**; nesting needs it to call itself. Every existing branching flow
    re-renders through the changed path, so it wants perturbations over each existing branch shape
    (chain, independent guards, `merge` tail) before it is trusted, plus an engine proof of a
    two-level nest **at two instants** — a green run does not prove the right arm fired.
  - ⚠ **4a.1 SHRANK THIS GAP AND THE PLAN PREDATES THAT.** Since a branch arm can require two
    things at once (`conditions` is a conjunction, `935f582`), most two-level nesting **flattens
    into a chain the compiler already emits**: `if late AND vip → phone · elif late → email · else
    → nothing` is the nested form written flat. Reach for that first.
  - **Where flattening stops working**: the arms multiply. Two levels of three choices is 3 nested
    entries and **9** flat ones, each repeating its parent's condition — and duplicated conditions
    drift, which is the same argument the `merge` kind was added for.
  - ⚠ **The plan called this "nearly free" and it is not.** `plans/jev-integration-2026-09-21/
    phase-4-branched-creation/` records the sizing (4a.2), and the `BranchStep` docblock still
    lumps nested `If` in with the retracted *"unverified against this engine"* reason — **two
    refusals, two reasons**, and only this one survives.
- ⚠ **`catalogue:seed` uses `getRevision`, NOT `listRevisions`**, to find what references a superseded
  reader. `listRevisions` is the one place `hidden_at` is honoured and a chat turn writes its revision
  already hidden — using it would report "unreferenced" for an operation every chat-built flow reads.

### ⚠ 4. The collapsed sidebar was off-centre, and it was ONE bug six times

Collapsing labels animate via `max-w-0 / opacity-0` rather than `display:none`, and **a zero-width
flex item still gets its `gap`** — so every `flex items-center gap-2` around `[icon][label]` put the
icon 4px left of centre, and the header (an outer gap plus the lockup's own) put the logo 8px off.
`ml-auto` on a collapsing trailing badge is the same class with a bigger radius: on a
`justify-center` row it absorbs ALL the free space, so `/approvals` jumped out of line **only** when
somebody had a pending approval. Also the group rule rendered BELOW its own heading.

⚠ The tests assert CLASS INTENT — jsdom performs no layout, so no test here can measure a pixel —
and the container count is **EXACT, not a floor**: a floor of five passed with one of the six fixes
reverted. The expanded direction is asserted too.

### ⚠ 5. The `/flows/new` template cards advertised three automations that did not exist

Three HARDCODED labels — HR patterns on a deployment with no HR workspace — all doing the same thing
on click: set the mode and open the shelf, **carrying nothing**. `flow_templates` held zero rows and
the 34 `reviewed_templates` are names and blurbs with **no client reader at all**.

The door now reads `flow_templates`, the same list the shelf renders, with three states — templates ·
none yet · **unreadable, which says the check did not run rather than "none"**.

⚠ **THE PACK'S COPY WAS OVERRULED AND THE CONFLICT IS RECORDED.** The pack's S-03
(record removed 2026-09-11) specified those three names and three tests pinned them verbatim; the tests now assert the pack's **layout** plus the
data states. ⚠ **Still open**: `search.service.ts` reads `reviewed_templates`, so a global search can
still surface a template name with no model behind it.

### ⚠ Nothing checked that an edit op was ever TAUGHT to the model

Three places an op must appear and they drift independently: `FLOW_EDIT_OPS` (what a refusal and a
prompt are built from), `flowEditOpSchema` (what a turn accepts), `CHAT_RULES` (what the model is
told). **`set_schedule` was absent from the first for months while the op worked.** Missing from the
schema, a turn fails loudly; missing from the RULES, the capability is unreachable and nothing errors
— indistinguishable from a model that never wants the op. `chat-op-vocabulary.test.ts` closes it,
with a control per assertion.

### ⚠ Owed, and stated rather than left to be discovered

- ⚠ **MEASUREMENT DEBT, now four prompt changes deep.** `DRAFT_RULES` gained the output rule,
  `catalogueText`'s `operationLine` gained the returns line, and `CHAT_RULES` gained `set_output`. So
  **`draft:measure`, `outline:measure`, `chat:measure` and `kestra:refusal` are ALL stale.**
  `chat:measure` was already owed three times over. **Quote no generation number for this build.**
- ⚠ **`packages/flow-edit`'s `typecheck` fails on 2 errors in `from-model.test.ts`** —
  `authoredFromModel` called with one argument where 2-3 are expected. **PRE-EXISTING**: verified at
  `2b3e3b8`, the session's starting commit, with the same count. `pnpm test` passes because the build
  config excludes tests; only `tsconfig.typecheck.json` includes them.
- **Two of the eight declared results are defensible but not what was asked** — Recruitment's chase
  named its query step and Finance's report named its transform rather than the `llm_complete`
  output. Both legal, neither the step a person would pick. n=1 per conversation.
- **`foundry.system/retention` is still not deployed** — nothing bounds Kestra's growth.
- **`getFlowCatalogue()` resolves the ACTIVE workspace, not the flow's** — a latent wrong-workspace
  catalogue.
- **ChatWorkbench's 10 canvas gestures still write a revision each** — a compile, a Kestra deploy and
  an insert-only row per drag.

## ⚠ A step can no longer read a column that is not there, and a workflow has a RESULT (2026-09-08)

Six UAT reports in one session, plus a rebuild. **No spec-kit feature** — the user directed that
spec-kit be set aside, so there is no `specs/` directory for any of it and this section is the record.
Commits `8a33e70`, `73532d1`, `709300f`, `7e0afc1`, `7b3e41f`, `88d9c76`, `3a0a678`.

### ⚠ THE DEPLOYMENT'S STATE, MEASURED AT THE END. Read it off the database, never out of this file.

| | |
| :--- | :--- |
| Workspaces | **4** — Finance, Customer Support, Orders & Fulfilment, Recruitment. Unchanged. |
| Flows | **12**, three per workspace, **none armed, none approved**. The 34 `UAT …` flows are GONE. |
| Readers | **12** DB operations, three per datasource. The four single ones are **pruned**. |
| Tools | **20** — five per workspace: `test_email_send`, `foundry_email_send`, `llm_complete`, **`ticket_create`**, **`chat_post_message`**. |
| Triggers | **8** (4 `manual`, 4 `api`), all **disabled** — gate 1 needs a successful run first. Zero before. |
| Templates | **4** real `flow_templates`. Zero before. |
| Declared results | **8 of 12** flows declare `model.output`. |

`pnpm --filter @foundry/server catalogue:seed` (add `--prune`) rebuilds the catalogue;
`catalogue:flows` (add `--purge`) rebuilds the flows. **Both need `scripts/harness-in-net.sh`.**

### ⚠ 1. A step could read a column its DB operation never returns

A real run failed `{"to":["Expected string, received null"]}` on all 8 email calls (Kestra
`3VRhNsJO8222ebwGOQClFH`). The transform read `.customer_email` off `orders_demo.past_due_orders`,
which projects seven columns and never joins `customers`. **The literal null is nowhere in the flow**
— it is what a jq read of an absent key yields — so no check for bad VALUES could see it.

⚠ **THE FAILING CASE WAS THE LUCKY ONE.** A null recipient is refused by the mail route.
`sort_by(.created_at) | first` over rows with no `created_at` returns an arbitrary row and the
execution settles SUCCESS. Measured: **14 of 29** transform steps over an operation read a column
that does not exist, and only the email ones failed. D-68's finding with a new subject.

- **`RefInterface.columns`** carries the projection and `catalogueText`'s `operationLine` renders it.
  That line showed an operation's INPUTS and nothing about its output, so a model chose field names
  from the operation's *name*. I-126 and I-40 a third time — except **exactly knowable**:
  `specJson.columns[].alias` IS the key set of `.results[0].data[i]`.
- **`checkRefOutputFields`** refuses such a read at `assertValid`, the mirror of `checkFlowParams`.
- ⚠ **`checkOutputShapes` stops one level above and states the bound it believed** — *"only the
  tenant's data says whether `employees` exists."* That sentence was already corrected once (the body
  is Foundry's envelope, hence checkable); it is wrong a second time for the same reason, one level
  down, **for an operation alone**. A tool and a named query genuinely do not declare their output.
- ⚠ **THE CHECK IS STAGE-AWARE BECAUSE A FLAT NAME LIST HAD FALSE POSITIVES.** jq is a pipeline and
  only the first stages see the query rows: in
  `map({customer: .[0].customer, amount_owed: (map(.amount)|add)}) | sort_by(.amount_owed)` the first
  two reads are wrong and `.amount_owed` is **correct**. The flat version slandered it — I-62, where
  a guard that cries wolf gets widened until the widening permits the defect.

### ⚠ 2. A WORKFLOW HAD NO ANSWER — verified at the wire before it was built

`FOUNDRY_EMITS` carries no `core.output.OutputValues`, so a compiled flow declares no outputs;
`POST …/triggers/:tid/fire` answers `202 {fireId, started, error}`. Getting a value meant: fire → list
the trigger's fires → match `fireId` → `flowExecutionId` → poll the execution → pluck
`steps[i].output.value` **by a hardcoded step id**. Rename the step and it breaks silently.

⚠ **`FOUNDRY_EMITS` is SEVEN classes, not eight** — this file said eight; `core.execution.Fail` went
with the `agent` step.

- **`FlowModel.output`** names the step. The compiler reads it and **emits nothing**, exactly as
  `expectations` does: an `OutputValues` task would put an unemittable class in the YAML (UXI-003)
  and need a new allowlist entry. The value already crosses back through the **redacted** step view.
- ⚠ **NOT in `structureHash`**, following `expectations`, and the counter-argument is recorded: the
  steps that run are identical and the value was already readable, but this DOES change what a caller
  receives, so a reviewer is not approving the choice of result step.
- ⚠ **`flow-result.ts` treats "no answer" as FOUR states with four sentences**, never one null:
  nothing declared · the step is not in this run · the step did not succeed · the output could not be
  read. D-66's ranking — a caller that cannot tell them apart retries the wrong one. **`failed > 0`
  does NOT make a result unavailable**: 7 of 10 sent is a real answer AND a real failure.
- ⚠ **`checkFlowOutput` refuses `approval` and `branch`.** Both yield null for ever on a run where
  every task is green.
- ⚠ **`CanvasNode.boundary`'s docblock said there is no `"end"` and gave three reasons. Two became
  false and the third is now beside the point.** Corrected in place, not deleted. `withEnd` is drawn
  **even when nothing is declared** — a flow with no result is the most common broken state and the
  canvas is the only place a person would find out. A declared-but-missing step attaches to
  **nothing**; falling back to the leaves would draw a correct-looking exit point over a broken
  declaration. ⚠ Written the wrong way first; the test caught it.
- ⚠ **`set_output` is the NINETEENTH flow-edit op, and without it the feature did not exist.** The
  builder's exit-point panel reports and does not edit (a form there would be a second author of
  `model.output`, D-197) and points at chat, which had no op to point at. A field only a seed script
  can write is a field the product does not have. **Reached from a plain sentence, 8 of 8.**
- ⚠ **`touchedBy` and `resolvedStepId` both answer EMPTY** though the op names a step — declaring a
  step the result changes nothing about it, and `resolvedStepId` exists to make mis-resolution
  measurable.
- **PROVEN AT THE WIRE**: `Open ticket digest` (`tickets_opened_since` → transform →
  `llm_complete`), draft-run, `read_from: sandbox`, and the execution answers
  `result.value.text = "This week, 2 support tickets were opened…"`.

### ⚠ 3. The catalogue was the limit on what an automation could be

Four workspaces held **three tools and ONE DB operation each**. Measured consequences:
every buildable automation was "read the one thing, email it"; **`needs_component` fired ZERO times
across eleven conversations** because a reusable-looking reader always existed, so flows reused it
where it was plainly wrong (`orders_demo.past_due_orders` for "unshipped orders",
`hiring_demo.expiring_offers` for "where every candidate is in the process"); and the single reader
projected no address, which invited the guess above.

- ⚠ **EVERY READER A NOTIFICATION COULD FOLLOW PROJECTS AN ADDRESS**, asserted over every reader so
  a new one cannot be added without a decision.
- ⚠ **The two action tools were removed on request and the argument is KEPT**: they are the cheap
  arms of a branch. They are back because the catalogue was the limiting factor.
  `ticket_search`/`ticket_update`/`chat_list_channels` stay **out** — reading is the datasource's job.
- ⚠ **`ACTION_WORDS` moved to `lean-catalogue.ts` as the ONE copy of the channel names.** A tool
  description naming a channel `ops-api`'s `CHANNELS` lacks 404s at runtime *after* approval.
- ⚠ **An operation can now carry AUTHORED parameter prose.** The derived description is
  `"lt filter on public.invoices.due_date"` — silent about whether `as_of` is `2026-06` or
  `2026-06-30`, which is I-126 and what produced `"{{ inputs.period }}-31"`. Only `description` is
  taken; `type` and `required` stay derived.
- ⚠ **TWO COMPILER LIMITS the specs are written around — AND BOTH ARE NOW FALSE.** The paragraph is
  corrected in place rather than deleted, because the specs written around these limits still carry
  their shape. It read: *"There is **no `is_null` op**, so 'no shipment yet' is a `left` join
  returning the null for a transform to select on. And **a column name cannot be qualified — an
  ambiguous one silently resolves to the first owner with no finding**, which is a real gap in the
  VISUAL builder too."*
  - **`is_null` EXISTS**, and appears never to have been missing in the form this claimed:
    `FILTER_OPS` carries `is_null` and `is_not_null`, with zod refinements, readback text and SQL
    emission (`db-operation.service.ts`, `db-operation-readback.ts`). The `left`-join workaround is
    still legal; it is no longer the only way.
  - **A column name CAN be qualified** since 2026-09-22 (`cb1eb68`) — `table.column` or
    `schema.table.column`, on the eight fields that resolve against the whole join chain and on no
    others. An ambiguous bare name still resolves to the first owner, which is deliberate, but it is
    **no longer silent**: `CompiledOperation.ambiguousColumns` carries the choice and
    `OperationReview` renders it. ⚠ It is REPORTED, not refused — joining on `id` is the ordinary
    case, so a refusal would have rejected most correct operations on day one.
  - ⚠ **Neither had a measurement, and the `is_null` sentence survived here for weeks while the op
    worked.** A limit written down and never re-checked is one every later spec is designed around.
- ⚠ **A THIRD COMPILER LIMIT, AND IT IS THE ONE STILL OPEN: A BRANCH CANNOT CONTAIN A BRANCH.**
  `flow-compiler.service.ts` throws by name — *"the engine allows a nested condition; this compiler
  does not emit one yet — its assembler nests arms through `otherwise`, not recursively."* Flagged
  here on 2026-09-22 so it can be picked up deliberately rather than rediscovered as a bug.
  - ⚠ **THE REFUSAL IS OURS, NOT KESTRA'S.** A nested `core.flow.If` with a native `else:` was
    **measured working** against v1.3.29 on 2026-09-04, in the same pass that admitted `approval`
    inside an arm. So this is a compiler limit that knows it is one — do not describe it as an
    engine constraint, and do not re-measure the engine before starting; that half is done.
  - **What it would take.** Recursive emission in `flow-compiler.service.ts`, which is the **sole
    YAML emitter (R8)** and the most safety-critical module in the compiler. The assembler renders
    one arm at a **fixed depth**; nesting needs it to call itself. Every existing branching flow
    re-renders through the changed path, so it wants perturbations over each existing branch shape
    (chain, independent guards, `merge` tail) before it is trusted, plus an engine proof of a
    two-level nest **at two instants** — a green run does not prove the right arm fired.
  - ⚠ **4a.1 SHRANK THIS GAP AND THE PLAN PREDATES THAT.** Since a branch arm can require two
    things at once (`conditions` is a conjunction, `935f582`), most two-level nesting **flattens
    into a chain the compiler already emits**: `if late AND vip → phone · elif late → email · else
    → nothing` is the nested form written flat. Reach for that first.
  - **Where flattening stops working**: the arms multiply. Two levels of three choices is 3 nested
    entries and **9** flat ones, each repeating its parent's condition — and duplicated conditions
    drift, which is the same argument the `merge` kind was added for.
  - ⚠ **The plan called this "nearly free" and it is not.** `plans/jev-integration-2026-09-21/
    phase-4-branched-creation/` records the sizing (4a.2), and the `BranchStep` docblock still
    lumps nested `If` in with the retracted *"unverified against this engine"* reason — **two
    refusals, two reasons**, and only this one survives.
- ⚠ **`catalogue:seed` uses `getRevision`, NOT `listRevisions`**, to find what references a superseded
  reader. `listRevisions` is the one place `hidden_at` is honoured and a chat turn writes its revision
  already hidden — using it would report "unreferenced" for an operation every chat-built flow reads.

### ⚠ 4. The collapsed sidebar was off-centre, and it was ONE bug six times

Collapsing labels animate via `max-w-0 / opacity-0` rather than `display:none`, and **a zero-width
flex item still gets its `gap`** — so every `flex items-center gap-2` around `[icon][label]` put the
icon 4px left of centre, and the header (an outer gap plus the lockup's own) put the logo 8px off.
`ml-auto` on a collapsing trailing badge is the same class with a bigger radius: on a
`justify-center` row it absorbs ALL the free space, so `/approvals` jumped out of line **only** when
somebody had a pending approval. Also the group rule rendered BELOW its own heading.

⚠ The tests assert CLASS INTENT — jsdom performs no layout, so no test here can measure a pixel —
and the container count is **EXACT, not a floor**: a floor of five passed with one of the six fixes
reverted. The expanded direction is asserted too.

### ⚠ 5. The `/flows/new` template cards advertised three automations that did not exist

Three HARDCODED labels — HR patterns on a deployment with no HR workspace — all doing the same thing
on click: set the mode and open the shelf, **carrying nothing**. `flow_templates` held zero rows and
the 34 `reviewed_templates` are names and blurbs with **no client reader at all**.

The door now reads `flow_templates`, the same list the shelf renders, with three states — templates ·
none yet · **unreadable, which says the check did not run rather than "none"**.

⚠ **THE PACK'S COPY WAS OVERRULED AND THE CONFLICT IS RECORDED.** The pack's S-03
(record removed 2026-09-11) specified those three names and three tests pinned them verbatim; the tests now assert the pack's **layout** plus the
data states. ⚠ **Still open**: `search.service.ts` reads `reviewed_templates`, so a global search can
still surface a template name with no model behind it.

### ⚠ Nothing checked that an edit op was ever TAUGHT to the model

Three places an op must appear and they drift independently: `FLOW_EDIT_OPS` (what a refusal and a
prompt are built from), `flowEditOpSchema` (what a turn accepts), `CHAT_RULES` (what the model is
told). **`set_schedule` was absent from the first for months while the op worked.** Missing from the
schema, a turn fails loudly; missing from the RULES, the capability is unreachable and nothing errors
— indistinguishable from a model that never wants the op. `chat-op-vocabulary.test.ts` closes it,
with a control per assertion.

### ⚠ Owed, and stated rather than left to be discovered

- ⚠ **MEASUREMENT DEBT, now four prompt changes deep.** `DRAFT_RULES` gained the output rule,
  `catalogueText`'s `operationLine` gained the returns line, and `CHAT_RULES` gained `set_output`. So
  **`draft:measure`, `outline:measure`, `chat:measure` and `kestra:refusal` are ALL stale.**
  `chat:measure` was already owed three times over. **Quote no generation number for this build.**
- ⚠ **`packages/flow-edit`'s `typecheck` fails on 2 errors in `from-model.test.ts`** —
  `authoredFromModel` called with one argument where 2-3 are expected. **PRE-EXISTING**: verified at
  `2b3e3b8`, the session's starting commit, with the same count. `pnpm test` passes because the build
  config excludes tests; only `tsconfig.typecheck.json` includes them.
- **Two of the eight declared results are defensible but not what was asked** — Recruitment's chase
  named its query step and Finance's report named its transform rather than the `llm_complete`
  output. Both legal, neither the step a person would pick. n=1 per conversation.
- **`foundry.system/retention` is still not deployed** — nothing bounds Kestra's growth.
- **`getFlowCatalogue()` resolves the ACTIVE workspace, not the flow's** — a latent wrong-workspace
  catalogue.
- **ChatWorkbench's 10 canvas gestures still write a revision each** — a compile, a Kestra deploy and
  an insert-only row per drag.

## ⚠ Feature-level RBAC — a workspace is closed now, and access is per FEATURE (2026-09-13)

`specs/20260910-130448-feature-rbac-permissions/`. Branch
`20260910-130448-feature-rbac-permissions`, eight phases, one commit each. **This is the
largest change to who-can-do-what the product has had.**

### ⚠ THE NUMBER THAT MATTERS: 106 ROUTES WERE OPEN

Of **142** workspace-scoped routes, **36** carried a role check and **106 carried no
authorisation check at all**. `DELETE /api/workspaces/:ws/flows/:flowId` and
`POST …/flows/:flowId/test-run` were reachable by **anyone who could sign in**. The reason
that survived for months is that nothing anywhere could tell you the number — the file-level
figure in the original spec ("22 of 43 route files") understated it **six times over**.

Measured at the wire after the change, `pnpm --filter @foundry/server rbac:verify`:

```
150 workspace-scoped routes × 4 probes
SC-001  no grant anywhere, refused           150 / 150
SC-002  a grant in A is not a grant in B     150 / 150
CONTROL an admin of A is PERMITTED there     150 / 150   ← without this, "refuse
        an allowlist holder, no member row   150 / 150      everything" scores 100%
```

### The shape

| Thing | Where | Note |
| :--- | :--- | :--- |
| The catalogue | `src/auth/permissions.ts` | **49 = 38 workspace + 11 platform.** CODE, never a table — FR-001 says no administrator may invent, rename or delete a permission, and a table makes all three possible. |
| Presets | `src/auth/role-presets.ts` | 19 / 23 / 38, **built by union** so `admin ⊇ approver ⊇ author` is true by construction. |
| The conferral | `src/auth/platform-conferral.ts` | D-9. **One key**, image of **exactly two**. |
| The route map | `src/auth/route-permissions.ts` | ⚠ **GENERATED. Do not edit.** |
| The resolver | `src/services/effective-permissions.service.ts` | One union, provenance in the same pass. |
| The guards | `src/middleware/{require-permission,platform-permission}.middleware.ts` | 401 / 403 / **500**, never a pass. |
| The splice | `src/middleware/mount-permission-guards.ts` | Walks the stack once in `createApp()`. |

### ⚠ Five things that will bite somebody

- **`RANK` IS DELETED.** `admin ⊇ approver ⊇ author` is **set containment** now. The
  property survives; the mechanism does not, and it is strictly more general — a custom
  role is not on any ladder and no integer could place it.
- ⚠ **NEVER `app.use("/api", guard)`.** That form attaches to every `/api/*` request
  reaching the line and silently puts the Kestra callbacks behind the parent key, after
  which every flow dies at `begin` with no `flow_executions` row (I-65). The guard is
  **spliced per handler at boot**, the `wrapAsyncRoutes` shape. A router-level middleware
  *cannot* do this job: it runs before Express matches the sub-route, so it would have to
  re-implement `path-to-regexp` and route ordering — and ordering is load-bearing here
  (`GET /flows/generate/jobs` vs `GET /flows/:flowId` are separated by registration order
  alone).
- ⚠ **PAIRING A ROLE GUARD WITH A PERMISSION IS AN `AND`, AND IT IS NOT ALWAYS HARMLESS.**
  I wrote that it was, reasoning that the permission sits inside the role's preset. True,
  and **only one direction**. Somebody may hold the PERMISSION without holding a
  MEMBERSHIP ROW — which is exactly a platform administrator — and the role guard demands
  the row. `GET /workspaces/:ws/members` carried `requireWorkspaceRole("author")` beside
  `members.read` and refused them at the one read D-9 exists to make reachable.
  **Before pairing, ask whether anybody can hold that permission without a row.** Found by
  `rbac:platform-verify` reporting 10 of 11, not by reading.
- ⚠ **THE ROUTE MAP IS GENERATED AND MUST BE REGENERATED, NOT EDITED.**
  `specs/…/contracts/README.md` has the four-command procedure. The surface moved
  **three times during this feature alone**; the hand-written version was wrong six times
  in two days. Adding a route without declaring it turns `route-permissions.test.ts` red
  with *"N mounted route(s) declare no permission and no exemption. A route nobody
  declared ships OPEN."* — which it did, on the first run after the roles router was
  mounted.
- ⚠ **`SUPER_ADMIN_EMAILS` IS NOW THE ONLY WAY INTO A MEMBERLESS WORKSPACE, FOR
  EVERYTHING** — not just approvals. This deployment has **zero members across eight
  workspaces**, so on day one every one of them refuses every non-super-admin on every
  route. **Accepted, not fixed** (spec D-5), and stated in four places.

### ⚠ The platform tier, and the sentence to use about it

`requireDeploymentAdmin` was satisfied by being an admin in **any** workspace, so one
tenant's administrator could change a deployment-wide setting. It is **deleted** — leaving
it importable leaves two answers to "who may change a deployment setting", and the weaker
one takes no argument to satisfy.

`platform.members.grant` **confers `members.read` + `members.grant` in every workspace**
(D-9), because a platform admin could otherwise create a workspace and put nobody in it.

> ⚠ **A platform administrator cannot see a tenant's data, but CAN give themselves the
> ability to, and doing so leaves an audit entry naming them.**

**Never** the unqualified *"a platform admin cannot access tenant data"* — it is false.
The bound is the number two, asserted as a **set equality** (a subset assertion passes
while somebody adds `flows.read`) and, from the other end, by `rbac:platform-verify`
requiring **exactly 11** reachable workspace routes rather than "at least".

### Commands

```bash
pnpm --filter @foundry/server rbac:verify           # SC-001 / SC-002, with the control
pnpm --filter @foundry/server rbac:platform-verify  # SC-010 / SC-015, auditor + support + platform admin
pnpm --filter @foundry/server rbac:backfill         # DRY RUN by default; --apply writes
```

### ⚠ I-62 four times, and I-120 a fourth time — in ONE feature

- **I-120** (a value computed and discarded): `accessAuditService.recordDenial` was
  written, tested and **called by nothing**. The detector's own tests cannot close that —
  only a call site can, so `access-audit-wired.test.ts` reads both guards off disk.
- **I-62** (a guard that cries wolf gets widened until the widening permits the defect)
  fired **four times, every time on my own explanatory comment**: a ban on
  `session.user.roles` flagged the docblock explaining why it must not be read; the
  honesty check's policy-table ban flagged three docblocks explaining why those tables
  were deleted; the `req.originalUrl` ban flagged the comment *inside the call* saying not
  to use it. **A well-commented control is the single most likely thing to trip its own
  guard, because the comment and the violation say the same words.** Match a USE — an
  import, an index, a call — or strip comments first.
- ⚠ **And the mirror of it, found by perturbing**: `revision-provenance.test.ts`'s mount
  scan matched `src.includes("requireProvenanceAuthority")`, which **the import line
  satisfies**. The guard could be removed from the route and the test stayed green. Fixed
  to match a CALL. Found only by removing the control and watching nothing go red.

### What is NOT done, stated rather than left to be found

- **Affordance gating is not applied to all 34 client pages.** The primitives exist
  (`Can`, `useCan`, `PermissionGate`) and are used on the surfaces this feature touched.
  The rest rely on the server refusing — correct, but not the same as an affordance that
  matches. ⚠ **There are 34 pages, not 36**: `admin/downtime` and `admin/policies` exist
  only in stale `.next/types`, which is also the entire content of the client's "4
  typecheck errors".
- **The Topbar's switcher has no explaining state of its own** (the list it reads is
  already filtered server-side).
- **`pnpm test` is not green and was not green before**: 5 server failures (`elseOf` /
  `failureMode` stripped by the storage schema — a live defect on this branch, not this
  feature's) and 2–5 client failures from a **flaky** `runs/[id]/page.test.tsx` whose
  `vi.mock` omits `emailsForRun` at `HEAD` too. `baseline-pre-change.txt` records all of
  them from before the feature started.

## ⚠ History's Workflow ID / Run ID columns, and a second frozen field (2026-09-20)

`specs/20260918-123817-flow-history-name-snapshot/`. Builds on the branch's own earlier
work in the same spec (User Stories 1–2: `flow_name_snapshot`, `runLabel`'s
snapshot-then-slug chain). Three things changed on `/history`.

- **The combined "Automation" cell (name stacked over the run id) is split into THREE
  columns**: Workflow name, Workflow ID, Run ID. `DataTable.tsx`'s `run` named set grew
  from 5 columns to 6 (`time, workflowName, workflowId, runId, status, actions`) —
  **Time taken moved into the Details modal only**, per the requested column list, which
  does not include it. `subject`/`summary`/`duration` as column keys are gone; do not
  reintroduce them.
- ⚠ **`flow_id_snapshot` is the id's `flow_name_snapshot`, same rule, same call site.**
  `flow_executions.flow_id` is `ON DELETE SET NULL` (migration `0070`), so a run's
  Workflow ID column would blank the moment its workflow is deleted — exactly the failure
  `flow_name_snapshot` was built to prevent, one field over. Written at `begin` in
  `routes/executions.ts` from the same `flowRow` lookup, in the same `create()` call, no
  FK (must outlive the row it points at). `runWorkflowId(e)` in `adapters.ts` mirrors
  `runLabel`'s exact shape: prefer the snapshot, fall back to the live `flowId`, else
  `null` — never a fabricated value for a pre-snapshot orphan.
- **`CopyableId`** (`components/ui/CopyableId.tsx`) is the one implementation behind both
  id columns: 5 leading characters + `…`, full id in `title`, a copy button *before* the
  text, `useToast()` on both success and failure of `navigator.clipboard.writeText` (best
  effort — same absent-over-plain-http shape `FlowIntegrationPanel.tsx`/`AllowRequest.tsx`
  already handle). `null` renders `"—"` with no button. **Do not duplicate this per
  column** — that is exactly the drift this repo's own V7 section warns about.
- **The Action column is Status**, plain words (`completed`/`stopped`/`running`), not the
  internal `run.*` spelling. Search now also matches `runWorkflowId(r)`, not only the run
  id and the automation name — an id visible in its own column that a search box can't
  find is a gap a user would notice.
- ⚠ **A discriminating test exists on purpose**: a row with `flowId: null` and NO
  `flowIdSnapshot` cannot tell a correct implementation (`runWorkflowId(r)`) from a wrong
  one (`r.flowId ?? null`) apart — both render `"—"`. `history/page.test.tsx`'s "shows the
  FROZEN id" case supplies a snapshot on an otherwise-orphaned row specifically because
  this session wrote the wrong version first and only a snapshot-present case caught it.

### User Story 7, same day — the ids became links

`CopyableId` gained an optional `href` — the truncated text becomes a `next/link` `Link`
when given one; the copy button stays a plain **sibling**, never nested inside the link,
so a button-inside-an-anchor accessibility hazard was never on the table. History passes
`href={workflowId ? \`/flows/${workflowId}\` : undefined}` (using the **same**
`runWorkflowId(r)` value already computed for the cell's `id`, not a second call re-typed
as `r.flowId`) to the Workflow ID column, and an unconditional `href={\`/runs/${r.id}\`}`
to the Run ID column. Two things are load-bearing:

- ⚠ **The link target and the copied value are the SAME variable, computed once.** The
  discriminating test from the bullet above (snapshot present, live `flowId` null) has a
  link-targeting sibling: a link built off the bare `flowId` would point at `/flows/null`
  or nowhere for exactly the row this whole feature exists to keep working.
- **An orphaned run with no id at all renders no link and no copy button** — `CopyableId`'s
  existing `id === null` branch already covered this; `href` needed no new null-handling.

## ⚠ The decision seam is LOCAL now — laya via LayaWatch replaced the hosted Jev API (2026-09-23)

The Jev programme's seam (D-206) dialled TypeSafe's hosted System One API. It now dials the
open **laya** engine in the **`layawatch`** compose service. Same question vocabulary
(`choice` / `score` / `noul`); what moved is the transport.

| | |
| :--- | :--- |
| Source | **`packages/layawatch`** — plain source in this repo, vendored from BLANCO-11/LayaWatch @ `cf3c2af` (upstream `main`, incl. our PR #1). **Not a submodule — edit it directly.** It was a submodule for one day (2026-09-23) and a fresh clone without `--recurse-submodules` got an empty folder and a bare `"/web": not found`. |
| Image | `foundry/layawatch:0.1.0-laya0.3.5` from **`packages/layawatch/Dockerfile`** — upstream's plus the optional corporate-CA blocks. ⚠ `.gitignore` negates `packages/layawatch/web/package-lock.json`: the blanket lockfile rule would drop it and `npm ci` needs it. |
| Where | `default` network only (never `kestra-net`); console + key management on **`127.0.0.1:4005`**. Server reaches it as `http://layawatch:8050`. |
| Client | `services/laya.service.ts` (was `jev.service.ts`) → `POST {LAYA_API_URL}/predict`, `X-API-Key`. |
| Env | **`LAYA_API_URL`**, **`LAYA_API_KEY`** (+ `LAYA_EDIT_ADVICE`, `LAYA_CONFIDENCE_*`, `LAYA_TIMEOUT_MS`, `LAYA_MAX_RETRIES`). **No `JEV_*` aliases.** `LAYWATCH_BOOTSTRAP_OWNER` is LayaWatch's own console super user. |

Seven things are load-bearing.

- ⚠ **CPU ONLY.** The image carries the `+cpu` torch wheel and compose pins `LAYA_DEVICE=cpu`;
  `/healthz` reports `"device":"cpu"`. Measured: ~0.8 s for a small state, **~3.5 s** for the
  edit-advice map (~1,600 tokens) — ~3× the hosted API's ~1.2 s.
- ⚠ **PERMISSIVE egress, not STRICT — a changed decision, not a relaxed one.** `layawatch`
  resolves to rfc1918, which STRICT refuses on every call (D-32's move, for the same reason).
- ⚠ **Retry is 429 ONLY** (`rate_limited` and `engine_saturated`). LayaWatch has no 529.
- ⚠ **A missing/malformed answer THROWS** (`normalise`) instead of returning `undefined`, and a
  laya noul's extra `confidence` is DROPPED so the "a noul has no confidence" contract holds.
- ⚠ **Key auth must be ARMED in LayaWatch** (`POST /api/v1/keys/auth`) — unarmed, `/predict`
  answers with no key at all. Armed on this deployment: no key → 401. Key **rotation has a
  5-minute grace** where the old key still works; that is by design, not a bug.
- ⚠ **Two image bugs found by running it, both fixed in the Dockerfile:** `${CORP_CA_FILE:+…}`
  set `SSL_CERT_FILE` to the EMPTY STRING, which hf-xet's rustls reads as a path, so the
  checkpoint never downloaded; and upstream's root-run `import torch, laya` smoke check leaves a
  root-owned `/data/.cache` that the non-root engine cannot write (`chown -R`). The second is
  now fixed UPSTREAM too (PR #1); the first is specific to our CA handling.
- ⚠ **The unit suite pins `LAYA_EDIT_ADVICE` off** (`packages/server/vitest.config.ts`). With the
  flag on in `.env`, 16 `flow-chat*` tests timed out dialling the live engine — each passed in
  isolation.

- ⚠ **Request and response bodies ARE captured, PII-scrubbed — UPSTREAM since
  BLANCO-11/LayaWatch#1 (`cf3c2af`), which this repo authored.** v0.1.0 had capture storage and a
  UI banner, but no call site ever passed a payload and the trace page never rendered one. It
  lived here first as a build-time patch and was contributed upstream (PR #1); the vendored
  copy includes the merge. The stored copy gets key-name redaction PLUS value scrubbing of email
  addresses, 10+-digit number runs and credential shapes; **names and addresses written in prose
  are NOT detected.** Payloads are nulled after 24 h. Measured on trace `54057149`: message stored
  as *"send the email to [redacted:email] instead, and text [redacted:number]"*, probabilities
  intact, zero raw PII in either body.
  ⚠ **`LAYWATCH_CAPTURE_PAYLOADS` in compose is the switch that works** — the console's
  Settings toggle writes a row the recorder never reads (it is built once at boot).

⚠ **What was measured, and what that does NOT mean:**

- **Workflow generation is unaffected** — only `flow-chat.service.ts` imports the seam.
  `draft:measure` (gpt-5.6-luna, 2026-09-23): goal 5/5 · 1.0 attempts · outline 1/1 · SC-001
  green · scoped "1 of 3" — the 2026-09-22 baseline on every qualitative line.
- ⚠ **laya's edit-advice answers are WEAK on this map, and every Jev-era number describes a
  different model.** laya warns its checkpoint is **uncalibrated for choices of 11+ options** —
  the op question has 22. On *"change the recipient on the email step"* it chose `replace_step`
  and a near-tie `subject` at confidence 0.005, which is exactly what makes the 2.3 gate **ASK
  "Which step did you mean?"** on an obvious referent. D-223 still holds (a question, never a
  different edit), but with the flag on, expect more questions than Jev produced. **The
  thresholds (I-187) are untuned for laya.**
- **`chat:measure --scenario=1` WITH the seam on** (gpt-5.6-luna + laya/english/cpu,
  2026-09-23): 5 turns · applied 4 · **ambiguous 1** · failed 0 · 5 of 5 steps · 9 calls · 109 s.
  ⚠ Turn 5 (*"Before the chases go out, make a person approve them"*) came back **"Which step
  did you mean?"** — **the first time the 2.3 gate has ever fired** (I-197 said it never had),
  from a near-tie laya `subject`. The flag-off baseline (2026-09-22) applied all five. n=1 —
  a reading, not a property — but it is the predicted cost, observed.
- The feature modules (`jev-edit-advice`, `jev-edit-questions`), the `jev_json` column and the
  persisted `resolved_by` values `jev` / `jev_degraded` KEEP the programme's name — they are
  labels, like `tether_*`. Renaming them is a migration, not a find-and-replace.

### ⚠ The edit question set was REBUILT for laya (2026-09-23) — the Jev-era shape timed out on every turn

`pnpm --filter @foundry/server laya:measure [--out=f.json]` — 19 labelled turns through the
production `adviseEdit` / `agreementOf` / `ambiguousReferent`, no LLM, nothing written.

| | before (8 questions, whole flow + callables as JSON) | after (2 questions, message only) |
| :--- | :--- | :--- |
| laya latency p50 / p90 | **23.4 s / 27.2 s** — every call past the 15 s timeout, so production always fell back to `llm_only` after waiting 15 s | **2.9 s / 3.2 s** |
| op agreement | `op_kind` **3/19** (answered `replace_step` 16/19, empty flows included) | `edit_intent` **14/19** |
| subject agreement | **1/12** (always the first step) | **12/12** |
| confident-wrong (≥ 0.9) | **8** | **0** |
| `chat:measure` s1 | applied 4 · 1 spurious "Which step did you mean?" (earlier record) | applied **5** · ambiguous **0** · wall 105.7 s |

- ⚠ **laya encodes one 512-token sequence PER QUESTION** (`laya/common.py` `build_sequence`),
  re-reading the state each time, so on this CPU cost is linear in `questions × state` (~6.7 ms per
  token). The hosted Jev "fan-out is free" finding does not transfer. The state was also being
  truncated to ~320 of ~840 tokens per question.
- ⚠ **The state is `{ message }` only.** Putting the steps in the state as well (they are already the
  `subject` options) was measured slower AND less accurate (11/12).
- ⚠ **`edit_intent` has ≤ 10 described intents, and `INTENT_OF` maps every op onto one.** 22 op names
  sit in laya's `choice:11+` bucket, which laya itself treats as uncalibrated.
- ⚠ **The prompt block renders only lines at or above `LAYA_CONFIDENCE_ASK`.** Every wrong intent was
  below 0.5 on the labelled set. `jev_json` still records the whole answer.
- **Removed**: `binding_source`, `binding_field`, `branch_position`, `ref_kind`, `is_structural`,
  `has_more`. Only the prompt block read them, and they were noise there. Re-add one only with a
  labelled case in `laya:measure`. `jev_json.agreed.op_kind` is now `agreed.edit_intent`.
- ⚠ n=19 on one CPU, labels by one reader — a reading, not a property. The four wrong intents are
  empty-flow and "otherwise" cases, all below the render floor.

### ⚠ Where laya is used, and where it is NOT (2026-09-28, compiled-builder phase 6 — closed negative)
laya's base `english` checkpoint is used **only where it works zero-shot**: chat edit intent (≤ 10 generic intents over the message
alone — 14/19, 0 confident-wrong). **It decides nothing in the builder.** Measured and ditched against the frozen tuned labels:
choosing a workspace's reader/action (readers 16/34 vs the LLM's 30/34; actions 4/30 vs 27/30, wrong at 0.99) and yes/no flags on a
goal (below the majority-class baseline on both). laya's own README says why: the base checkpoints are near chance on typed decisions
zero-shot ("a base to specialise"), confidence is uncalibrated until a per-type temperature fit, all options share a 192-token budget,
and the English checkpoint reads ~320 tokens of state. It cannot extract values. **Never wire a laya question into a decision without a
labelled set it beats the current behaviour on, and never act on its confidence alone — let it trigger a question to a person.**
Not built, each needs a labelled set first: prompt-injection screening (guard preset), and laya as a classification STEP inside user
workflows (triage/department/complaint over rows — its published strength).

### ⚠ The manual builder is the engine's second front end (2026-09-28, compiled-builder phase 7 — closed)
The canvas takes ONLY actions the engine listed: `@foundry/flow-edit/engine/canvas.ts` (`canvasActions`) turns `legalMoves` into
palette entries, port pickers, pipeline stages, node menus and flow settings — each one an `EngineOp`, or a typed slot whose VALUE
the server judges (`literalFits`). The server applies them (`services/builder/canvas.service.ts`, `GET …/flows/:id/canvas`,
`POST …/canvas/{act,save}`, `POST …/flows/canvas` for a new flow) because only it has `renderInputs`. Four load-bearing facts:
- **Stateless on SIGNED states** (D-329). Every state returned carries an HMAC over (workspace, flow, state); an unsigned or
  altered state is refused, and a signed one is still re-judged by `checkState`. Never accept an op, a step or an expression from
  the client — an action id and a value only.
- **Save is the one funnel.** Complete → `writeRevision` (origin `canvas`); holes → the working copy (`saveIncomplete`). Table
  readers (D-311) are lowered before BOTH saves (I-304: the working copy was refused on schema-only workspaces without it).
- **Proven through the canvas itself**: `legal-moves.property.test.ts -t CANVAS` (0 of 19,030 states refused on the deployment's
  catalogues, the `fits` control fires) and `canvas-e2e.ts` (every workspace, end to end, its own flows deleted).
- **The raw step editor (`StepRaw`) is deleted.** The OLD editor still opens for a flow the engine cannot read (`{legacy}`), with
  its expression fields — the one place a person can still write jq/Pebble (I-303), retired with the legacy flows at cutover.

## ⚠ Builder stability — one plan owns a goal, and the compiler never saves what its runtime cannot run (2026-10-02)

Branch `feature/stability-fixes` (also `prod`). The programme record is `plans/builder-stability-2026-10-01/` (gitignored, local
only — read it as a label). Phases 2, 3 and 5 were **skipped by the user** (folders renamed `*-SKIPPED-*`): compiler-boundary
defects are fixed as found, and the corpus is a spot-check tool, not a target. **Every flow and run on this deployment was wiped
on 2026-10-02** (`slate:clear`) before UAT.

### The shape

- **One plan call owns a goal's whole structure** (`services/builder/plan.ts`, P1-D13): code numbers the goal's clauses; one strict
  `goal_plan` reply holds sources, row tests, the loop, schedule, an if/else-if chain, every action with where it runs, its approval
  and its recipient, and the values that fill inputs. `normalisePlan` applies equivalences, `planFindings` checks coverage exactly
  (one re-ask), `planToSpec` lowers it onto the GoalSpec + Wiring the solver already builds from. **Edits are planned the same way**
  (an edit-only schema extension names the automation's existing lists `step:<id>`, prepared text, and paths `in:<id>`), and the old
  `goal_spec` / `goal_shape` / `goal_wiring` path is **deleted**.
- **Questions name ONE part** (`partQuestion`, conversation.ts): a clause nothing implements, or words whose meaning was not settled
  — a whitelist; anything else is stated, never asked. Each part is asked **once** per build (`askedParts`). An answer whose
  re-understanding would lose an action already placed is **not applied** (the build is replayed as it was, and the turn says so).
  Readers that fit equally (same tested fields AND the inputs the goal fills) are a **one-click choice**, applied by renaming the
  reader in the stored spec (`withReader`) — no model call.

### Root causes fixed, each general (none keyed to a workspace, table or goal)

| Rule | Where |
| :--- | :--- |
| A port only a step's output fills is DECLARED (`fromStep`, e.g. `attach_rows`); the engine refuses a value there and offers no value slot | `tool-declarations.ts`, flow-edit `ops.ts`/`legal.ts` |
| A stated value never fills an address input (who receives is the action's recipient) nor a `fromStep` port | `plan.ts` `ports` |
| A date said with its comparison ("before 22 june", "as of 30 june") is that day at the input's own boundary; a period is never one day | `normalise-value.ts` `dayWithComparison` |
| An input whose description says "One of: a, b, c" declares those values; an unfilled declared input takes the ONE value the goal says | `declaredValues`, `withDeclaredValues` |
| A field compared with another field ("below its class minimum") is `against` in the plan — never a value, never a read's parameter | `plan.ts` |
| The read form compares a column with another column of the same rows (`against`), same-kind types only | `db-operation.service.ts` |
| **A read's SQL must PARSE on the engine that runs it** (PGlite for Postgres — the mock engine — SQLite via execution's translation), checked when a written read is accepted AND in `gateRevisionModel`, the funnel every revision passes | `sql-parse-check.ts` |
| Each action's recipient belongs to THAT action; the same words for one input, more than once, are never all given to one action | `plan.ts`, `goal-spec.ts` |
| An edit's action on a condition it states acts on that condition's rows, not the whole existing list | `plan.ts` |

### Measured (gpt-5.6-luna, n=1 per conversation — readings, not properties)

| | |
| :--- | :--- |
| Plan stability, 5 goals × 5 runs | 19/25 → **22/25** share one structure (S02 3/5 → 5/5; O03 3/5 is two genuine readings of "late orders" → a reader choice) |
| Corpus, 36 conversations (`builder-converse --run --all` + 4 edit checks) | **25/36 → 33/36** met expectation; then FL02 fixed in a targeted re-run. Median 0 questions per complete build; every completed draft run SUCCESS or PAUSED at its approval |
| Still not met, both valid | E04 (my edit check names `#recruiting`, which is not a channel there — asking is right); S01 (plan variance, passed in other runs) |

⚠ **Open, stated:** an approval on a per-item branch still stands before the whole loop (P4-I4 — safe, not what was asked); a
reader's quote can swallow conditions it does not apply (P4-I3). `builder-converse` takes `--corpus=<file>` for extra spot checks.
⚠ **Run only the tests a change touches, and re-run only failed corpus conversations** — the user's standing instruction.

### ⚠ The goal as the person MEANT it (2026-10-03, beta-2.6.11)

Prototyped behind switches, measured on `gpt-5.6-luna` (HR + CS, n=3–6 per arm), then made official — the switches are gone.

- **A typo is read as meant**: the plan names misspelt words (`spelling`), held by code to spelling only (`acceptSpelling`: a
  whole word of the goal, Damerau 1 for 4–7 letters, 2 for 8+), applied before any check, stated in the readback.
- **A written read accounts for EVERY word it is for** (`covers` / `assumed` / `left_out` / `values` / `others`); `covers.by`
  is checked against the identifiers of the read's own compiled SQL. Everything assumed or left out is asked. This REPLACED the
  word lists (`borrowedWords`, `unnamedWords`, `chosenDefinitions`, typo distances) — deleted, with their tests.
- **A value named but not given** ("below the threshold") is `named` — a contract input the person is asked for.
- **A reply mid-build RESTATES the goal** (`restateWithReply`) and the restatement is planned; it is held to the person's words
  (`untracedWords`) and names the parts it removes, refused (re-asked once) if it still names one (`stillNamed` — an "ignore X"
  copied into the goal names X). A refused restate falls back to the reply beside the goal, never silently.
- **A reading is confirmed only by a YES**; a re-plan's new readings are asked (each once, `posed`), re-plans bounded by
  `MAX_REPLANS = 3`; "leave it" settles that one question as built (`LEFT_AS_BUILT`) and the round goes on.
- **How it is delivered chooses the action** ("by email", "on chat"), never a value; `channel` is a destination the goal names.
  Measured: the stray "by email" value 3/5 → 0/6; a named channel still kept 4/4.
- **A port that `needs` another** (a file's format/name needs its rows) gets its partner bound in the engine's `bind`, on every
  path, or a hole — never a file with no rows. A listed value the words NAME ("Excel" → `xlsx`) is used via the plan's `as` /
  the editor's `value_meant`, only when the words themselves do not fit; a value that fits nothing is a stated gap, never dropped.
- **The chat head shows the goal the builder understood** (`understoodGoalOf`, hover).

⚠ Test fixtures DECLINE the restate (`planAware` answers `goal_restate` with `{}`), so scripted specs test what they were written
for; the restate's rules are in `as-meant.test.ts`. ⚠ Still open: Postgres-only SQL on SQLite, a filter on a computed column, the
"for each department" over-ask, and the generic wording of the which-channel question.

### ⚠ The builder applied — no switch, no test cases in the prompt (2026-10-04, beta-2.7.0)

Programme `plans/builder-behaviour-2026-10-04/` (gitignored — read as a label). The `BUILDER_INPUTS` prototype switch is **gone**: the
plan always carries inputs, summaries (group / count / total, a split's `rest:N`), a for-each over a summary's GROUPS, what each action
`sends`, and the recipient's address field chosen from a closed list (`none` = stated, never a nearby address). `RUN_WORDS` is deleted.

- ⚠ **No prompt example may quote a scenario.** The plan prompt and the read writer's worked example quoted the very goals the builder
  is measured on; they now speak of a lending library. Check new examples by four-word overlap against `scenarios/*.json` and the
  corpus files. Every corpus number before this release was taken WITH that leak.
- ⚠ **Kestra v1.3.29's resume takes NO taskrun id — it resumes the FIRST paused task** (its own `/swagger/kestra.yml`; measured: item 1's
  rejection landed on item 0). So an approval inside a loop is REFUSED (engine FT0703, the op, the compiler) and the builder puts one
  approval before the loop. Migration `0081` (per-item `scope`, `taskrun_id`) is applied and inert until a per-item delivery is measured.
  In a loop body every item's tasks share ONE parent; only `value` tells items apart.
- A field declares its time unit (`unit=` tag, or exact from its computation); "older than 3 days" on minutes compares 4320.
  A stated input IS its words wherever a test's value is read (solver, spec match). A read's form offers `aggregate` on a computed column.
- An address that falls back to the runner (`fallsBackToRequester`) is never "gone without" — a named recipient no data holds is a
  stated gap. ⚠ Tool declarations are keyed by tool NAME (P5-I1): a workspace tool named like a shipped one gets its ports.
- Measured (gpt-5.6-luna, n=1 each): creation 22/24, edits 9/9 after two fixes. Pre-existing: `phase2-exit-gate.test.ts` 4 failures at HEAD.

## ⚠ The client is on Next.js 16.4.0 (2026-10-12) — and the things that changed under it

`specs/20261012-123549-nextjs-16-upgrade/` (spec, plan, research, tasks, `baseline.md`, `gate-log.md`, `smoke.md`). `packages/client`
went 14.2.35 → 15.5.27 → **16.4.0**, `next-auth` 5.0.0-beta.31 → **beta.32**, **React stays 18.3.1**. Everything above that says "Next 14" or
"`middleware.ts`" describes the state before this; it is corrected in place only where it would mislead.

- ⚠ **The gate is `src/proxy.ts`, exporting `proxy`** (Next 16 deprecated `middleware.ts` and runs the convention on Node, not Edge). One gate
  file only; `gate.test.ts` fails if both exist. The `jose`/Edge build warning went away with the Edge bundle.
- ⚠ **Client pages read their id with `useParams()`, never `use(params)` and never a `params` prop.** React 18.3.1 has **no `use()`** — so
  `use(params)` cannot render under the test suite or in a React-18 build, whatever Next version it is. `params` is a Promise from 15 and
  Promise-only from 16. `ui-honesty-check.sh` now has two rules for this and both were proven to fire. *(This reverses the plan's first
  choice of `use(params)`; the research file records why.)*
- ⚠ **The proxy route reads `(await ctx.params).path`** — `ctx.params` is a Promise. A sync read dials `/api/undefined` with the parent key.
  `proxy.test.ts` hands it a Promise-shaped `ctx` for every verb and every deny-list segment.
- **The sign-in page is an `async` server component** (awaits `searchParams`); tests call it and `await` the element.
- **`next build` on Next 16 type-checks test files**, which 14/15 did not: five stale fixture errors in `MockPanel.test.tsx` that `tsc` had
  always reported became build failures, and were fixed. Typecheck is now **0 errors**.
- `next lint` is gone; the dead `lint` script was removed. **There is still no ESLint config** (unchanged open gap).
- Next 16 rewrote `tsconfig.json` (`jsx: react-jsx`, `.next/dev/types` in `include`) — kept.
- ⚠ **Next 16 prints "React 18 support is deprecated … removed in Next.js 17".** Moving to React 19 is the next step and is **not done**;
  it also needs a look at `@xyflow/react` (the canvas) and the 28 test files that mock `next/navigation`.
- **Tests that render `[id]` pages set the id with `lib/test-route-params.ts` (`atRoute`)**; the proxy and sign-in-page tests use
  `lib/test-dual-params.ts`. `record-pages.test.tsx` asserts each page USES its id (the old smoke test only asserted "did not throw").
- ⚠ **Baseline facts the older text gets wrong**: the client suite is ~**151 files / ~2,116 tests** (not 51 / ~750); the honesty check is
  **168 PASS / 5 FAIL** (five pre-existing, unrelated); three client tests fail and did before the upgrade (`local-auth-wiring`, `theme`,
  `workspace-placeholder`). `@foundry/{redact,shared,flow-edit}` `dist/` must be rebuilt (`pnpm install` does it) or typecheck reports
  phantom errors about missing exports.
- CI now also runs `next build` for the client (non-blocking, like its neighbours).
- **Not verified**: the authenticated rows of the sign-in matrix (G-8…G-12, G-14), the identity subject after sign-in, and the Entra path —
  they need a person; `smoke.md` lists them.

## ⚠ Forge runs in its own container (2026-10-13, beta-2.26.43)

`packages/forge` (`forge` + `forge-egress` in compose). Forge (`pi`) used to be a child of the API server, in the
container holding every secret with a route to Postgres; its bash could read other chats' folders and the server's
environment. Now:

- **The server relays, the host runs.** `ForgeProcess` (pi-runner.ts) opens one TCP connection per Forge to
  `FORGE_HOST` (`forge:4100`, secret `FORGE_HOST_SECRET` in `.env` — the forge container refuses to start without it).
  `host.mjs` starts `pi` as a **per-conversation Linux user** (uid 30000–59999), folder 0700, `/proc` hidepid,
  prlimit. The AI key arrives per process from the server; the container holds no secret of the stack. With
  `FORGE_HOST` unset, Forge runs as a local child — **development and tests only**; the server image has no `pi` and
  no Python any more.
- **Network:** `forge-net` is `internal: true` (forge, server, forge-egress). The only way out is `forge-egress`, an
  HTTPS CONNECT proxy allowing the host of `LLM_BASE_URL` (or `FORGE_EGRESS_ALLOW`). Measured: postgres, ops-api,
  host.docker.internal and 1.1.1.1 unreachable; example.com refused by the proxy; the gateway reached.
- **Before every message** the host re-hands the folder to the uid (the server writes into it as root between
  turns), copies the workspace catalogue in (`_catalog` is root-only), locks the top levels (0711, no listing), refuses
  a folder over 300 MB, and after `agent_end` kills what the turn left running.
- ⚠ **The server must never read a conversation's file through a link** (`confined()`, sandbox-fs.ts): Forge can
  write links in its folder, and a link to a server file would be read, shown, stored and handed back. Every reader
  uses it; `confined.test.ts` plants links.
- ⚠ **The verifier runs from the server's image** (`TEMPLATE_ROOT`) with an empty environment and
  `FORGE_VERIFY_ROOT` — never the conversation's copy, which Forge can rewrite.
- Known: the AI service answers "403 terminated" to some replies (a 102-department list from HR) — measured identical
  through the proxy and direct, so it is the service, not the container.

## ⚠ A Forge chat has a MODE: Workflow Builder or Forge Agent (2026-10-13, beta-2.27.0)

`pi_chats.mode` (migration 0097). **Workflow Builder** builds and changes the chat's one workflow and answers questions
about it; **Forge Agent** does the job now (questions, real data, files, drafts) and never changes the workflow. It
replaced Forge deciding per message whether a message was a task or a workflow.

- **The workspace permits, the chat chooses.** Forge Agent is offered only where `workspaces.assistant` is on (the
  "Purpose and access" setting, now worded as offering Forge Agent). Turned off later, an agent chat is switched to
  Workflow Builder on its next message, with a note. Reading real data follows that same setting in BOTH modes.
- **Instructions are assembled, not copied:** `pi-builder-template/instructions/{core,workflow,agent}.md` →
  `instructions.ts` writes the chat's SYSTEM.md from the SERVER's template (every turn: Forge can rewrite its folder).
  Forge loads it at process start, so `setMode` releases the process and the next message resumes the session.
- ⚠ **The Forge Agent guard is the server's, not the prompt's.** `workflowSnapshot` before an agent turn; a changed
  `workflow.json`/`steps/` is put back by `restoreWorkflowSnapshot` (each path removed first, never written through a
  link; GOAL.md from the server's record) and the next turn is told. No verify or test runs after an agent turn.
- **Entries:** Chats lists every chat (mode badge; "Draft, not saved" for an unsaved build); Workflows lists only what
  was saved (Save needs the verifier) — plus its existing "Drafts" section of unsaved builds. One chat, at most one
  workflow. Opening from Workflows forces Workflow Builder; reopening a chat keeps its mode.
- ⚠ **A conversation is a CHAT, and lives at `/chats/<id>` (2026-10-30)** — in either mode, with or without a workflow it
  built. "New chat" (rail, Chats, a project) opens `/chats/new`; the first message rewrites the address to `/chats/<id>`.
  That page is live for whoever may continue it (`canChange`) and read-only for anyone it is shared with. `/flows/<id>/builder`
  stays as the way in from Workflows; the Workflows page's "New workflow" is `/chats/new?mode=workflow`. `/flows/new` and
  `/create` redirect. `chatHref` is always `/chats/<id>`.
- **Default:** `platform_users.forge_default_mode` (`PUT /api/me/forge-default-mode`, the person's own); NULL is
  Workflow Builder. The switch is a toggle in the chat's footer and is hidden where Forge Agent is not offered.

## ⚠ Private and published work — who sees whose content (2026-10-15)

Branch `feature/rbac-observability`. Plan: `plans/rbac-observability-2026-10-15/` (gitignored — read as a label). No
spec-kit, by the user's standing instruction.

⚠ **SUPERSEDED 2026-10-30 by "Where it lives, Runs as, and projects" (the next section).** The two regions and the role
table below are the earlier model; the bullets after the table (the one module, the content guard, 404 not 403,
body-named workflows, costs, the access grid) still hold, except where that section corrects them.

**Two regions.** PRIVATE — a person's chats, draft automations, test runs and usage — is visible to its owner and to
whoever holds `content.read.others` (the Admin preset). PUBLISHED — an automation once approved (`armed_revision` set;
revoking turns it off, it does not unpublish it) and its live runs — is visible to the whole workspace.

⚠ **SUPERSEDED 2026-10-28 by migration `0112` (plugins phase 9) — approving no longer publishes.** An automation is
`flows.visibility` `private|public`, chosen by its OWNER (`PUT …/flows/:flowId/visibility`), separate from approval;
0112 backfilled `public` for everything that had been approved. 0112 also added **self-enable**: an owner may switch on
a Forge workflow that uses only their own things, with no reviewer (`enableOwn`, `workspaces.self_enable`). Reviewers
still see every private automation and run (`flowVisible`). The paragraph above is kept as the record of the earlier
rule. The next model ("where it lives": My space / project / Workspace, Runs as, projects) is planned in
`plans/sharing-boundaries-2026-10-30/` (gitignored — read as a label); its phase 0 found two leaks under TODAY's rules:
saving a template from a workflow (`POST …/flow-templates`, body `flowId`) and fragment candidates both read private
workflows without a visibility check.

| Role (stored key) | Shown as | Sees |
| :--- | :--- | :--- |
| `viewer` (new, 0100) | **Observer** | Published only; read-only (5 permissions) |
| `author` | **Creator** | Own private work + published |
| `approver` | **Reviewer** | Every automation and run (to review them) — NOT others' chats or usage |
| `admin` | **Admin** | Everything, incl. others' chats and everyone's usage and cost |

Only the labels changed (`client/src/lib/role-labels.ts`); keys, grants and the database did not. The platform
`support` role was MERGED into `auditor` (0100).

- ⚠ **ONE module decides: `services/content-visibility.service.ts`.** Every list takes its SQL predicate; every by-id
  read goes through the **content guard** (`middleware/content-guard.middleware.ts`), spliced at boot onto EVERY
  workspace route by `mountPermissionGuards`, after the permission guard. It reads the request's own params
  (`flowId`, `chatId`, `sessionId`, `threadId`, `executionId`, a run's `id`) — per request, not from the path at
  boot, because `releaseGatesRouter` is mounted twice and shares its handlers. `content-guard.test.ts` walks the
  real app and fails if a workspace route lacks it.
- ⚠ **Not visible → 404, never 403** (a 403 confirms existence). Visible but not yours to change → 403. Only routes
  whose permission is `flows.write`/`flows.run` need OWNERSHIP; approve, arm, replay and pin need only visibility.
- ⚠ **A workflow named in a request BODY is not seen by the path guard** — `POST …/pi-builder/sessions`,
  `…/bind-flow`, `…/runs` and flow-chat's attach check it themselves (`mayChangeFlowNamedInBody`). Workflow references (`…/references`, `…/referenceable`) pass the viewer to the service: only a workflow the person may SEE is offered, added (else 404) or kept across turns. A new route taking
  a `flowId` in its body must do the same.
- **`flows.owner_subject`** (0101) — set by `flowRepo.create` from the request context (`usageContext`), and claimed
  by the Forge save. Backfilled from the chat that built it; NULL = Admins and Reviewers only until reassigned
  (`flowRepo.setOwner` exists; no route or screen yet).
- **The workspace Files library stays SHARED** — workflows read files by name and names are unique per workspace.
  Chat attachments are private with their chat.
- **Cost is visible to everybody for what they may see** (replaces PO-D1). `/observability` answers `scope: "mine"`
  for a member, `"workspace"` (by person) for an Admin, who may ask `?scope=mine`. **`model_prices`** (0102,
  insert-only) holds $ per 1M input / output tokens, set at `/ai-provider?tab=pricing` (`platform.generation.write`);
  `costOf()` in `model-pricing.service.ts` is the ONE cost definition — the price in effect when the usage happened,
  else the producer's reported cost. Cached input is charged at the input price.
- **An Admin opening somebody else's CHAT is audited** (`access` / `chat`, 0103), once per person per chat per ten
  minutes. A draft or test run is not logged: the Admin preset includes reviewing, and reading those IS the review.
- Proven at the wire: `routes/content-visibility.wire.test.ts` (10 checks, real app, real DB) goes RED with the guard
  splice removed.
- **The UI follows the SERVER's answers, never a client-side guess.** The flows list sends `ownerName` and `mine` per
  row (Owner column, Published/Private, a "Mine" tab); `GET …/flows/:id` sends `canChange` (Edit, rename, Open canvas)
  and `canChangeOwner` (Admin: Details → Owner → Change, `PUT …/flows/:flowId/owner`, permission
  `content.read.others`, audited, never to an Observer or a non-member). The chats list sends `mine` (Admins get a
  Mine / Everyone's choice); reopening somebody else's chat answers `othersChat` and the workbench says whose it is
  and that the open was recorded. "New workflow" / "New chat" / the dashboard composer are hidden only when
  `flows.write` is known DENIED (an Observer, who gets a sentence instead); unreadable still shows them.
- **Model costs** (`/ai-provider?tab=pricing`, the "Costs" tab): input, output, **cached input** and **cache write**
  prices (0104). Cached tokens are PART of `tokens_in`; a cache read/write is charged at its own price, else the input
  price. A price whose latest row is a removal (input and output NULL) stops applying and the reported cost is used
  again. `GET /api/generation/pricing` also returns the full history; `GET /api/generation/pricing/spend?days=`
  (`platform.signals.read`) gives spend per model split into priced / reported, with `uncostedCalls` — calls nothing
  costed, missing from every total. `model-pricing.service.test.ts` pins all of it against the real DB.
- ⚠ **`GET /api/platform/access` is the cross-workspace listing D-27 refused, built on purpose** — `/admin/access`,
  "Who can see what": every person × every workspace, each cell's reach (none / published / own / review /
  everything) and why. Gated by `platform.users.read`. Every cell is `effectivePermissionsService.forWorkspace`,
  never derived from role names, so custom roles, grants and platform conferral show as they really are.

## ⚠ Where it lives, Runs as, and projects — who sees, who edits, whose account (2026-10-30)

Branch `feature/sharing-boundaries`. Plan: `plans/sharing-boundaries-2026-10-30/` (gitignored — read as a label), eight
phases, each folder with DECISIONS / EVIDENCE / ISSUES. No spec-kit. **This replaces "private" and "published"** in the
section above: the guard, 404-not-403 and body-named rules there still hold; the two regions and the role table do not.

**Visibility is WHERE AN ITEM LIVES, never a per-item setting.** A workflow or a chat lives in exactly one place:

| Where it lives | Who sees it | Stored as |
| :--- | :--- | :--- |
| **My space** | Its owner, and Admins (the owner is told each time an Admin looks) | `visibility = 'private'`, no project |
| **A project** | That project's members (and Admins) | `project_id` set (0128) |
| **Workspace** | Every member | `visibility = 'public'`, no project |

- ⚠ **The three words are the only words a person sees** — My space / the project's name / Workspace, and for
  accounts Workspace / Owner / Each person. Never "public", "private", "published" or "armed" on a screen, in a
  refusal, or in Forge's instructions. `WherePill` and `placeLabel` are the one rendering; add no second.
- ⚠ **Changing the place is MOVE, and only Move** (`GET …/move-preview?to=` then `POST …/move`, flows and chats,
  `to` = `mine` | `workspace` | `project:<id>`). The preview says who gains, who LOSES (named), what it switches
  off and whose account it will use, before anything changes (Q5). `PUT …/flows/:flowId/visibility` now carries only
  `othersMayEdit`; a body naming `visibility` there or on the chat PATCH is a **409 `use_move`**, never ignored —
  it was a second way to move that skipped the preview (P7-D1).
- **Reviewers see a workflow only once its owner ASKS** (`flows.review_requested_revision`, 0120) **or it is live**,
  wherever it lives. They judge the flow's validity; they do not read others' chats or usage.
- **Admins see everything, and the owner is SHOWN it** — an Admin's look at somebody's My-space item writes a
  persisted notification (0121) shown in the owner's bell, not only an audit line.
- **A shared chat is shared to READ** (P1-D8): members read it; only its starter continues, renames or deletes it.
- **Editing and managing are two rules.** Editing a shared workflow is every member who builds, unless its owner made
  it view-only (`others_may_edit`, 0123; existing workflows started view-only). Managing — move, delete, view-only,
  ask for review, Runs as — is its owner's or an Admin's (`requireFlowManager`). Duplicate needs only to see it.
- **An ownerless workflow is the Admins'**; a leaver's workflows become ownerless when they are removed (P1-D6/D7).

**Runs as — whose account a connector step uses**, per connector, separate from where it lives:

| Runs as | Means |
| :--- | :--- |
| **Workspace** | The workspace's connection |
| **Owner** | The owner's own connection, whoever triggers it. Forces view-only for everyone else. |
| **Each person** | The own connection of whoever starts the run; "Turn on for me" gives each person their own schedule on the approved revision (`flow_activations`, 0125) |

- ⚠ **My space has no Runs as choice — it always uses its owner's own accounts** (Q3), enforced at RUN time, not only
  on screen: `effectiveAccounts` (`run-as.service.ts`) is the one rule, read by the runner, approval, readiness,
  self-enable reach and the page. A stored "Team" choice in My space is ignored. Building in My space offers only the
  person's own connections (`resolveAccount(…, { ownOnly })`).
- ⚠ **A move that changes what a LIVE workflow runs as switches it off until a reviewer approves it**, and the
  preview says so first (P6-D3). Self-enable (0112) is My-space-only: sharing a self-enabled workflow turns it off.
- **A run on someone's own account records it** (`flow_executions.acts_as_subject`, 0124); its data is that person's
  and the Admins'; others who see the run see that it ran and its status only.
- **Missing setup is told before Run / Turn on / Approve / Duplicate, with who can fix it** (`readiness.service.ts`,
  `readinessOf`, five causes); a live run stops before sending anything.

**Projects (0128) are shared context**: a name, instructions every chat in the project is told each turn, and members
from the workspace only. Its owner (or an Admin) manages members; somebody removed loses everything in it at once and
what they owned passes to the project's owner. Others may own items inside it (Q4). `/projects`, `/projects/[id]`.
**Project files (0132)** are seen only by the project's members (and Admins), deleted with the project, and opened by
its chats (`open-file.mjs --project`, named each turn); a workflow cannot open one at run time.

Proven at the wire on the local DB: `content-visibility.wire.test.ts`, `projects.wire.test.ts` (9),
`my-space.wire.test.ts` (5) — every control perturbation-proven. ⚠ **Owed: the per-role walkthrough by a person**
(`phase-6-ui/WALKTHROUGH.md`); nothing in tests stands in for it. Open: Runs as is not shown on list rows (P6-I2).

## ⚠ ops-api is gone; the built-in tools live in the server (2026-10-30)

Plan: `plans/builtin-tools-2026-10-30/PLAN.md` (gitignored — read as a label). Everything above that describes ops-api,
`:4004`, `foundry_ops`, `OPS_*`, `api_call_log`, the simulated mail/chat/ticket/paging services or `/api/ops/*` is
HISTORY.

- **Three built-in tools, each a `tools` row in every workspace pointing at the server itself**, with its own key derived
  from `PARENT_API_KEY` and the run in `x-foundry-run`: `foundry_email_send` (`/api/mail/send`), `llm_complete`
  (`/api/llm/complete`, key `FOUNDRY_LLM_KEY`) and **`web_fetch`** (`/api/web/fetch`, key `FOUNDRY_WEB_KEY`).
  `pnpm --filter @foundry/server platform:tools` re-registers all three (after rotating `PARENT_API_KEY`).
- **`web_fetch`** reads one public address: GET/HEAD, no login, no body, 10 s, 5 MB cap; HTML → Markdown
  (`html-markdown.ts`), JSON parsed. ⚠ **The address is checked WHEN THE CONNECTION OPENS** — the request's own DNS
  lookup is guarded (`guardedLookup`), an IP literal is checked before dialling, every redirect hop again — so private,
  loopback, link-local/metadata, CGNAT, ULA and unresolvable addresses are refused however they are written. A site
  answering an error FAILS the call. Every call, refusals included, is a `web_fetches` row (0133), credential-shaped
  query values redacted. **`workspaces.web_access`** (0133, default on, admins switch it off on the workspace's
  settings). Forge reads the web while building with `tools/fetch-url.mjs` → `/api/forge/fetch`, same service, same
  rules. The builder's rule (workflow.md): known address → fixed steps; judgement → fetch, trim, `llm_complete`;
  pages to find → Forge finds them while building and writes the addresses in. No search engine; no browsing at run time.
- **The runtime model** (`llm_complete`; AI models → Runtime) is `runtime-model.service.ts` + `runtime_model_provider`
  (0134), key under `CREDENTIAL_ENC_KEY`, routes `/api/runtime-model/*`. ⚠ **Still separate from the builder's model
  (D-35)**: separate table, module and routes; a test forbids `generation-provider` importing it. D-35's "different
  processes" clause is what this amended. The per-minute budget counts `usage_events`. `runtime-model:import` copied
  ops-api's saved settings once (done on the local deployment).
- **A run's "what it called"** is `GET …/flow-executions/:id/calls` (`usage_events` + `web_fetches`), not ops-api's log.
- ⚠ **Owed:** the demo seeds and harnesses (`demo/**`, `kestra/**`, `scenarios/**`, `showcase/**`) still import
  `ops-client.service.ts` and call an ops-api that no longer runs; Helm (`infra/k8s/foundry`) still has an ops-api
  template. The `foundry_ops` database and role are left in Postgres.

## ⚠ Kestra is out of the stack, and nothing is seeded (2026-10-21, prod release)

Every workflow runs on `flow-runner` (Forge workflows, `runtime = 'foundry'`), so the engine was removed from the
deployment. Everything above that describes Kestra, `kestra:check`, `kestra-env.sh`, `plugins.txt` or the `seed`
service is HISTORY.

- **Compose:** `kestra`, `kestra-db-init`, `kestra-plugins`, the `seed` service (AUTO_SEED), `kestra-net`,
  `plugin-net` and the `kestra_storage` / `kestra_plugins` volume declarations are gone. `fragment-base` STAYS: it is
  `flow-runner`'s base image. The old volumes and the `kestra` database are not deleted by any file.
- **Scripts:** `kestra-boundary-check.sh`, `kestra-env.sh`, `kestra-plugins-apply.sh`, `kestra-ui-url.sh`,
  `ci/check-plugin-manifest.sh` and `infra/kestra/` are deleted, with their pnpm aliases and the pipeline gate. Host
  harnesses load credentials with **`scripts/server-env.sh`**; `harness-in-net.sh` runs on `infra_default` only.
  Backups cover `foundry_parent` + `foundry_ops`.
- ⚠ **The server's Kestra code paths are still there** (compiler, replay, approval deploy, `kestra/` harnesses) —
  dead for Forge workflows, removed in a later pass. With `KESTRA_BASE_URL` unset, health leaves the
  `kestra` component out entirely, so it cannot make a healthy deployment read as degraded.
- ⚠ **No seeding anywhere.** `migrate` applies schema only (`seed-platform-tools.ts` is deleted); migration `0105`
  deletes the 34 example templates `0049` inserted. **A workspace gets exactly two tools, at creation**:
  `foundry_email_send` and `llm_complete` (the summary tool, ops-api `/llm/complete`, its model set on
  `/ai-provider`). Both are platform-managed names (cannot be created, edited or removed by hand). No demo catalogue
  carries `llm_complete` any more. `pnpm --filter @foundry/server platform:tools` refreshes both in every workspace,
  on purpose (after rotating `PARENT_API_KEY` or `OPS_API_KEY`).

## ⚠ Connectors — Activepieces pieces, installed per deployment, connected per workspace (2026-10-27)

Branch `feature/plugins-poc`. Plans: `plans/plugins-poc-2026-10-27/` (POC, verdict GO) and `plans/plugins-2026-10-27/`
(gitignored — read as labels). On exactly when the connector is configured — `PLUGINS_CONNECTOR_URL` + `PLUGINS_CONNECTOR_SECRET` — with the `connector` + `connector-egress` containers, part of every compose `up` since 2026-10-29 (no profile; defined in `infra/connector.compose.yml`, included with `env_file: ../.env` so its secrets fill without an `infra/.env`; Helm `plugins.enabled`). ⚠ `PLUGINS_POC` is gone (2026-10-29): it was a second switch that had to agree with the first.

- **`packages/connector`** runs pieces; it never loads piece code itself. Each job is a worker process as its OWN uid
  (pool 30001+; one shared uid let runs read each other's proxy credentials — measured), stripped env, heap cap,
  SIGKILL at timeout (needs `CAP_KILL`; without it the kill fails with EPERM and the worker lives on). Files return in
  the answer (base64, 16 MB), the store is written through to `/data/store`.
- **The only way out is `connector-egress`**: a per-run allowlist signed into the proxy credentials (approved hosts ∪
  the connection's hosts), every resolved address checked, private/internal refused. Every `http(s).Agent` in a worker
  defaults to the proxy — `NODE_USE_ENV_PROXY` alone missed the AWS SDK. A refusal reaches the person by name
  (`egress_refused`), not as `fetch failed`.
- **An enabled action is an ordinary `tools` row** (`plugin://<piece>@<version>/<action>`); the URL is the one
  definition and is in the ref fingerprint, so an upgrade suspends armed automations for re-approval, and the connector
  refuses a call for a version it does not have (`version_mismatch`).
- **A connection's value is written and never read back**: encrypted in `workspace_secrets` (`PLUGIN_<PIECE>_<LABEL>`);
  `plugin_connections` holds names only; rotation merges (blank keeps). "Test" runs the piece's own `validate`; no
  check ⇒ "Not checked", never "Connected". **Sign-in (OAuth2)** works through Foundry's own return address
  (`/api/oauth/callback`): the client secret is entered on the connector's page only, the refresh token never reaches the
  connector, and a "only for me" connection is listed to its owner alone and never used by automations.
- **Forge Agent PROPOSES changes; the person's click performs them** (`pi-builder/agent-changes.ts`): off unless the
  workspace's `agent_changes` is on; deletes are never proposed; a value that is a placeholder is refused; a batch is one
  card. A question card cannot be the confirmation — its answer travels through files Forge can write.
- Permissions: `plugins.read` (author), `plugins.enable` (admin), `platform.plugins.install` (platform admin).
  `/apps` is the Connectors page (it read Kestra's registry before). The POC's stand-ins (`poc/plugins`: fake S3 and
  ServiceNow) and the harnesses built on them are deleted (2026-10-29), and so is the egress proxy's private-address
  allowlist: no setting opens a private address to a connector. `plugins-github.ts` (real GitHub) remains.
- ⚠ The route-map generator (`specs/20260910-130448-feature-rbac-permissions/contracts/dump-routes.mts`) was broken by
  Express 5 and now uses `src/auth/route-stack.ts`; regenerate the map with it — never hand-edit `route-permissions.ts`.

## ⚠ Restricted workspaces — closed to the platform (2026-10-29)

Branch `feature/plugins-poc`. Plan: `plans/restricted-workspaces-2026-10-29/` (gitignored — read as a label). Migration `0113`.

A workspace may be **restricted** (`workspaces.restricted`): only the people its own admins add get in.

- **One rule, `superAdminHere(who, ws)`** (`services/workspace-restriction.service.ts`): the allowlist counts only where the
  workspace is not restricted, or the person holds an open **emergency access**. Every workspace decision that read
  `config.isSuperAdmin` reads it (resolver, member check, members/approvals/local-users routes, run requester).
  Platform conferral (D-9) does not apply in a restricted workspace — in the resolver, so all routes inherit it.
- **Its own admin** = a membership row with role `admin` (`isOwnAdmin`), never a permission. Rename, delete, restrict,
  open up and the local-users access route need it. Creating restricted makes the creator its first admin (a failure
  after the create removes the new workspace).
- **Emergency access**: `POST /api/platform/emergency-access` (outside the workspace — inside, the guard resolves a super
  admin to nothing), reason ≥ 20 chars, 1/2/4 h, audited in that workspace, its admins emailed; listed and ended by its
  admins or the holder (`…/emergency-access`, `…/:accessId/end`); expires on its own.
- **Views across workspaces** ask `closedTo(who)` — restricted workspaces the reader is outside of (by the resolver's
  answer): the list gives the platform tier `{id, name, restricted, closed, admins}`; the access grid a column with no
  cells; the platform audit none of its entries (auditors too); deployment spend leaves it out of every figure and
  names it; signals name the workspace, never its workflow; the ops call log drops its runs' calls; simulated
  mail/chat/ticket captures are withheld while it holds a tool on them (they record no workspace).
- ⚠ **The client never treats a closed stub as a workspace**: `foundryApi.listWorkspaces` drops them; only
  `listClosedWorkspaces` returns them. The active-workspace resolver, switcher and pickers therefore cannot bind to one.
- Proven at the wire: `routes/restricted-workspace.wire.test.ts` sweeps every workspace route (super admin without
  access and platform admin refused, own admin let past), plus `restricted-workspace-views` / `restricted-call-log`;
  every control perturbation-proven (28 server + client).

## ⚠ The cost report is an Admin's, spans workspaces, and can be emailed outside them (2026-10-26)

`/reports` was rebuilt as **Cost & usage**: LLM cost by workspace, workflow, person and run, with a drill-down (click a
workspace to see its workflows, a workflow to see its runs, a person to see what they used). No spec-kit feature, by the
user's direction; this section is the record.

- **`reports.read`** is a new workspace permission, held by the **Admin preset only**. Migration `0116`
  regenerates the two permission CHECKs (INV-2) — ⚠ **renumbered from `0107` on merging with the connector branch**,
  whose `0106`–`0114` took the same numbers and timestamps; the list it writes includes `plugins.read`/`plugins.enable`.
  A super admin holds it everywhere **except a restricted workspace** (the resolver decides, so the report inherits it). **Members, Reviewers and Observers
  get a 403 and no nav row**; the nav asks `/api/me` (`canViewReports`), and an unreadable answer hides the row.
- ⚠ **The four `/api/reports/*` routes are IDENTITY-ONLY in the route map, and that is not open.** The report spans
  workspaces, so there is no single workspace for a per-route guard to ask about. `reportService.allowedWorkspaces`
  checks `reports.read` per workspace and every answer is limited to that set; a workspace named outside it is a **403,
  not an empty report** (a forged id must not look like quiet usage). Same shape as `GET /api/workspaces`.
- **A "run" is one execution (test or live) or one building session**, grouped in SQL from `usage_events`; cost is
  `costOf()`. Drill filters are applied **in memory** over runs already limited to the caller's workspaces, so no filter
  can widen what a caller sees. The workbook (Summary, Workspaces, Workflows, People, Runs) and the screen read the same
  rows. The runs lens pages 50 at a time; **the download carries every run**.
- ⚠ **Email is a SHARING path on purpose.** Person B (Finance) may email the Finance report to person A (HR only), who then
  sees numbers for a workspace they cannot open. So: an attachment (a snapshot, **no link back**), recipients checked
  against `REPORT_EMAIL_DOMAINS` (default `microland.com`, exact match, so a look-alike or subdomain is refused), the sender
  can only share what they could open themselves, and **every attempt is written to `report_shares` before the send**
  (migration `0115`, was `0106`). Delivery is `mailService.send`, the Graph transport behind `foundry_email_send`, **not**
  `POST /api/mail/send`, whose recipient policy is built around a flow run's requester. **There is no recipient or rate
  limit yet** (asked for, "change it later"); the zod cap of 200 addresses is a sanity bound, not a control.
- ⚠ **Nothing reads `report_shares` yet.** It is written and not shown, so it is an audit record nobody can browse. A
  screen (or a line in `GET /api/platform/audit`) is the obvious next step.
- ⚠ Periods are **UTC days**, `days` counting today. The page offers 7/30/90; the dialogs add 60 and a custom range.
- ⚠ The older `GET …/observability` routes and `lib/observability.ts` still exist and are no longer used by `/reports`.

## ⚠ Personal connector actions — "For me" and "For the workspace" (2026-10-29)

Plan: `plans/personal-actions-2026-10-29/` (gitignored — read as a label). Migration `0118` (it was `0117` on its own
branch; the deployment had already applied a different `0117`, which 0118 supersedes). A member can switch a
connector's actions on **for themselves**, through their own connection, without a workspace connection.

- **Two tabs on a connector's page.** *For the workspace*: admins switch (`plugins.enable`), everyone else sees it
  read-only. *For me*: every member (`plugins.read`); an action already on for everyone shows "On for everyone", locked.
  The tab is in the URL (`?tab=`) — browser storage is forbidden by `ui-honesty-check.sh`.
- **Storage**: `plugin_personal_actions` (workspace, subject, piece, action) and `plugin_personal_policy` (per piece;
  no row = members may). A personal action is **never a `tools` row**.
- **At run time it is a VIRTUAL tool** (`services/personal-actions.ts` `personalTools`, id prefix `mine:`), built fresh
  every call with the person's own connection as its credential. Turning it off, an admin turning personal use off, or
  the connection going away all take effect at the next call.
- ⚠ **`mayRunThrough` is the one rule**: a personal tool runs only through a connection OWNED by the person it runs
  for — checked in chat (use, propose, decide) and in the step API before anything is sent. Never through the
  workspace's connection.
- **Workflows**: the step API falls back, when no workspace tool has the name, to the run's acting person
  (`actingSubjectForRun`: live = the flow's owner, test = who started it) and their personal tools. Forge is told via
  `catalogue.mine.json` (per chat) and the verifier accepts TOOL entries from it. Run-as and approval fingerprints
  include them; a personal tool's fingerprint fixes its credential name to "(the person's own)", so rotating a
  connection does not suspend armed flows (`toolFingerprint`, measured 0 of 228 refs moved).
- Routes: `GET /:piece/mine`, `PUT /:piece/mine/actions`, `POST /:piece/mine/call-packs/:pack`,
  `DELETE /:piece/mine/calls/:name`, `PUT /:piece/personal-use` (admin). The subject is always the caller. Packs can be
  switched on for oneself; writing a custom declared call stays admin-only. A member who leaves loses their personal
  actions with their personal connections.
- ⚠ **Forge Agent's chat uses the SAME two places, and there is no "this chat only" any more** (merged 2026-10-29).
  The setting card's **Allow for me** is the "For me" tab's own call (`applyMine` → `pluginService.setMyActions`),
  **Allow for the workspace** is the admin's. `pi_chats.agent_grants` is dropped (0117) and the 0117 table
  `plugin_person_grants` was folded into `plugin_personal_actions` by 0118 — personal rows only; one granted through
  the workspace's connection does not move, because a personal action never runs through the workspace's credentials.
- ⚠ **What a person can reach is ONE definition, `connectedServices` (`pi-builder/agent-grants.ts`)**, reading the
  connections WITH the person as viewer. Forge's list (`connector-actions.mjs`), each turn's message and the card read
  it. Before, the list read workspace connections only and a turn named services only when an action was on, so a
  person's own connection was invisible (chat 48357b29: Forge guessed "github" and said nothing was connected). Every
  turn now names each reachable service — with nothing on, and with any pack offered but off and where to switch it
  on — and a name that matches nothing answers with the ones that ARE connected. Packs are switched on from the For me
  tab, not from a chat card.
- ⚠ **Server tests read the repo-root `.env`, so on the deployment host a DB-touching test runs against the LIVE
  database.** Run DB tests with `DATABASE_URL` pointed at the local Postgres (`localhost:5433`).
- Owed: `routes/personal-actions.wire.test.ts` exists but has not been run (it writes to its database — run it
  against the local one, never the live one).
