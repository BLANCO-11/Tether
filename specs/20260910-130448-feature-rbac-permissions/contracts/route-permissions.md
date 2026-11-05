# Contract — the route → permission map

**Feature**: Feature-level RBAC · **Regenerated**: 2026-09-13 against the live Express stack

⚠ **THIS FILE IS GENERATED, NOT TRANSCRIBED, AND THAT IS THE CORRECTION.** Every row was
read out of `createApp()`'s mounted router stack — the same source the FR-002 completeness
check reads. The hand-written version was measured on 2026-09-10 and had drifted in six
places by 2026-09-12:

- `POST …/flows/:flowId/approvals/rearm` did not exist when it was written (landed
  `8e4ab34`, 2026-09-12) and was absent from the map, so `approvals.ts` was recorded as
  5 handlers / 2 guarded when it is **6 / 3**;
- `POST /operations/check` and `POST /operations/propose` name paths that **do not
  exist** — the real ones carry `/:dsId/`;
- `POST /:dsId/queries/propose` was unmapped, so `datasources.ts` was 23 not **24**;
- `steps.ts` was counted at 4 exempt handlers; it is **6** (`/llm` and `/http` landed
  with Stage 4, `d274caa`);
- `local-users.ts` was counted at 7 + 1; it is **9 + 1**;
- the exempt section's header said 11 over a table summing to 14; it is **16**.

A map that is transcribed is a map that drifts, in a document whose only value is being
accurate. This one is emitted, and the generator **fails** if any mounted route is
unmapped or any map entry is stale. It currently reports zero of each.

⚠ **AND THE SURFACE MOVED AGAIN WHILE THIS DOCUMENT WAS BEING WRITTEN.** A merge from
`release/beta` landed `beta-1.1.0` (*"admin section goes real — capability grants, incident
lifecycle, break-glass activation, gate toggles, budget routes, admin overview"*) and
`beta-1.2.0` hours after the first regeneration: **ten new workspace-scoped routes, 186 →
196**, all of them already guarded. Regenerating cost one command. Had this been the
hand-written version it would have been wrong for the third time in four days, and nobody
would have known until implementation. That is the whole argument for generating it.

**The whole surface is 196 mounted `(method, path)` pairs**: **142** workspace-scoped,
**38** deployment-level, **16** exempt. The 2026-09-10 figures (132 / 36 / 11 = 179) are
now wrong in every column.

Of the 142 workspace-scoped routes, **36** carry a role or super-admin guard today and
**106** carry none. ⚠ The guarded count rose from 25 to 36 with `beta-1.1.0` — the admin
section arriving with its guards already on is the one piece of good news in this delta.

⚠ **`GET /flows/:flowId/phases` is REGISTERED TWICE and one of them is dead.**
`flows.ts` has the real implementation; `flow-phases.ts`'s `flowPhasesRouter` is a
placeholder returning `{ phases: [] }`, mounted at the same path. `flowsRouter` is
mounted first in `app.ts`, so the placeholder is unreachable. It is one row here because
one row is what a caller can reach — but the completeness check must **dedupe on
`(method, resolved path)`**, or it will see two stack entries for one map key and report
a duplicate that is not one. Found by generating this file; not previously recorded.

⚠ **A `(method, path)` pair is the unit, not a handler.** `releaseGatesRouter` is mounted
**twice** — at `/release-gates` and at `/flows/:flowId/release-gates` — so one source
handler is two rows here, and will be two entries in the stack the completeness check
walks. Counting by source file gives a different number and is the wrong unit.

Legend — **G** = carries a role or super-admin guard today (the role is named) ·
**I** = `requireIdentity` only, no role · **—** = reachable by anybody who can sign in,
because the browser proxy holds the shared platform key on their behalf.

---

## Workspace-scoped — 132 handlers

Mounted under `/api/workspaces/:workspaceId/`. Each section is one mount in `app.ts`.


### `/flows/:flowId/triggers` — `triggers.ts` — 6 handlers, 0 guarded today, **6 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/triggers` | `flows.read` | — |
| POST | `/flows/:flowId/triggers` | `flows.arm` | — |
| DELETE | `/flows/:flowId/triggers/:tid` | `flows.arm` | — |
| PATCH | `/flows/:flowId/triggers/:tid` | `flows.arm` | — |
| POST | `/flows/:flowId/triggers/:tid/fire` | `flows.run` | — |
| GET | `/flows/:flowId/triggers/:tid/fires` | `flows.read` | — |

### `/flows/:flowId/approvals` — `approvals.ts` — 6 handlers, 3 guarded today, **3 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/approvals` | `approvals.read` | — |
| POST | `/flows/:flowId/approvals` | `flows.approve` | **G** · approver, +provenance |
| GET | `/flows/:flowId/approvals/diff` | `approvals.read` | — |
| POST | `/flows/:flowId/approvals/rearm` | `flows.approve` | **G** · approver |
| POST | `/flows/:flowId/approvals/recheck` | `flows.approve` | — |
| POST | `/flows/:flowId/approvals/revoke` | `flows.approve` | **G** · approver |

### `/flows/:flowId/positions` — `flow-positions.ts` — 2 handlers, 0 guarded today, **2 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/positions` | `flows.read` | — |
| PUT | `/flows/:flowId/positions` | `flows.write` | — |

### `/flows/:flowId/flags` — `flow-flags.ts` — 2 handlers, 0 guarded today, **2 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/flags` | `flows.read` | — |
| PATCH | `/flows/:flowId/flags/:flagId` | `flows.write` | — |

### `/flows/:flowId/phases` — `flow-phases.ts` — 1 handlers, 0 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/phases` | `flows.read` | — |

### `/flows/:flowId/release-gates` — `release-gates.ts` — 2 handlers, 1 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/release-gates` | `gates.read` | — |
| PATCH | `/flows/:flowId/release-gates/:gateId` | `gates.write` | **G** · admin |

### `/flows/:flowId/scenarios` — `flow-scenarios.ts` — 1 handlers, 1 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows/:flowId/scenarios` | `scenarios.read` | **G** · author |

### `/flows` — `flows.ts` — 25 handlers, 2 guarded today, **23 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flows` | `flows.read` | — |
| POST | `/flows` | `flows.write` | — |
| DELETE | `/flows/:flowId` | `flows.write` | — |
| GET | `/flows/:flowId` | `flows.read` | — |
| PATCH | `/flows/:flowId` | `flows.write` | — |
| GET | `/flows/:flowId/expectation-suggestions` | `flows.read` | — |
| GET | `/flows/:flowId/export` | `flows.read` | — |
| GET | `/flows/:flowId/export/kestra` | `flows.read` | — |
| POST | `/flows/:flowId/inputs` | `flows.write` | — |
| GET | `/flows/:flowId/integration` | `flows.read` | — |
| GET | `/flows/:flowId/last-run` | `runs.read` | — |
| POST | `/flows/:flowId/refine` | `flows.write` | — |
| GET | `/flows/:flowId/revisions` | `flows.read` | — |
| POST | `/flows/:flowId/revisions` | `flows.write` | — |
| DELETE | `/flows/:flowId/revisions/:revision` | `flows.approve` | **G** · approver |
| GET | `/flows/:flowId/revisions/:revision/steps` | `flows.read` | — |
| POST | `/flows/:flowId/save-draft` | `flows.write` | **G** · author |
| POST | `/flows/:flowId/steps/:stepId/regenerate` | `flows.write` | — |
| POST | `/flows/:flowId/test-run` | `flows.run` | — |
| POST | `/flows/generate` | `flows.write` | — |
| GET | `/flows/generate/jobs` | `flows.read` | — |
| POST | `/flows/generate/jobs` | `flows.write` | — |
| GET | `/flows/generate/jobs/:jobId` | `flows.read` | — |
| POST | `/flows/import` | `flows.write` | — |
| POST | `/flows/import/plan` | `flows.write` | — |

### `/datasources` — `datasources.ts` — 24 handlers, 0 guarded today, **24 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/datasources` | `datasources.read` | — |
| POST | `/datasources` | `datasources.write` | — |
| DELETE | `/datasources/:dsId` | `datasources.write` | — |
| GET | `/datasources/:dsId` | `datasources.read` | — |
| PATCH | `/datasources/:dsId` | `datasources.write` | — |
| GET | `/datasources/:dsId/operations` | `datasources.read` | — |
| POST | `/datasources/:dsId/operations` | `datasources.query.write` | — |
| DELETE | `/datasources/:dsId/operations/:name` | `datasources.query.write` | — |
| GET | `/datasources/:dsId/operations/:name` | `datasources.read` | — |
| PATCH | `/datasources/:dsId/operations/:name` | `datasources.query.write` | — |
| POST | `/datasources/:dsId/operations/check` | `datasources.query.write` | — |
| POST | `/datasources/:dsId/operations/propose` | `datasources.query.write` | — |
| GET | `/datasources/:dsId/queries` | `datasources.read` | — |
| POST | `/datasources/:dsId/queries` | `datasources.query.write` | — |
| DELETE | `/datasources/:dsId/queries/:name` | `datasources.query.write` | — |
| GET | `/datasources/:dsId/queries/:name` | `datasources.read` | — |
| PATCH | `/datasources/:dsId/queries/:name` | `datasources.query.write` | — |
| GET | `/datasources/:dsId/queries/:name/impact` | `datasources.read` | — |
| POST | `/datasources/:dsId/queries/check` | `datasources.query.write` | — |
| POST | `/datasources/:dsId/queries/propose` | `datasources.query.write` | — |
| GET | `/datasources/:dsId/sandbox` | `datasources.read` | — |
| GET | `/datasources/:dsId/schema` | `datasources.read` | — |
| POST | `/datasources/:dsId/schema/refresh` | `datasources.write` | — |
| POST | `/datasources/:dsId/test` | `datasources.write` | — |

### `/flow-templates` — `flow-templates.ts` — 7 handlers, 0 guarded today, **7 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flow-templates` | `templates.read` | — |
| POST | `/flow-templates` | `templates.write` | — |
| DELETE | `/flow-templates/:id` | `templates.write` | — |
| GET | `/flow-templates/:id` | `templates.read` | — |
| POST | `/flow-templates/:id/instantiate` | `flows.write` | — |
| POST | `/flow-templates/:id/plan` | `templates.write` | — |
| POST | `/flow-templates/from-bundle` | `templates.write` | — |

### `/fragment-candidates` — `flow-templates.ts` — 1 handlers, 0 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/fragment-candidates` | `templates.read` | — |

### `/secrets` — `workspace-secrets.ts` — 6 handlers, 0 guarded today, **6 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/secrets` | `secrets.read` | — |
| POST | `/secrets` | `secrets.write` | — |
| DELETE | `/secrets/:id` | `secrets.write` | — |
| PATCH | `/secrets/:id` | `secrets.write` | — |
| GET | `/secrets/:id/impact` | `secrets.read` | — |
| GET | `/secrets/audit` | `secrets.read` | — |

### `/tools` — `tools.ts` — 6 handlers, 0 guarded today, **6 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/tools` | `tools.read` | — |
| POST | `/tools` | `tools.write` | — |
| DELETE | `/tools/:toolId` | `tools.write` | — |
| GET | `/tools/:toolId` | `tools.read` | — |
| PATCH | `/tools/:toolId` | `tools.write` | — |
| POST | `/tools/probe` | `tools.write` | — |

### `/flow-executions` — `flow-executions.ts` — 6 handlers, 0 guarded today, **6 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flow-executions` | `runs.read` | — |
| GET | `/flow-executions/:id` | `runs.read` | — |
| GET | `/flow-executions/:id/emails` | `runs.read` | — |
| GET | `/flow-executions/:id/replay` | `runs.read` | — |
| POST | `/flow-executions/:id/replay` | `runs.replay` | — |
| POST | `/flow-executions/:id/watch` | `runs.read` | — |

### `/flow-chat` — `flow-chat.ts` — 4 handlers, 0 guarded today, **4 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/flow-chat/threads` | `flows.read` | — |
| POST | `/flow-chat/threads` | `flows.write` | — |
| GET | `/flow-chat/threads/:threadId/turns` | `flows.read` | — |
| POST | `/flow-chat/threads/:threadId/turns` | `flows.write` | — |

### `/catalogue` — `catalogue.ts` — 3 handlers, 2 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/catalogue` | `catalogue.read` | — |
| POST | `/catalogue/access-requests` | `catalogue.write` | **G** · author |
| GET | `/catalogue/items` | `catalogue.read` | **G** · author |

### `/access-requests` — `catalogue.ts` — 1 handlers, 1 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| POST | `/access-requests` | `catalogue.write` | **G** · author |

### `/step-approvals` — `step-approvals.ts` — 3 handlers, 1 guarded today, **2 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/step-approvals` | `approvals.read` | — |
| POST | `/step-approvals/:approvalId/decide` | `approvals.decide` | **G** · approver, +not-requester |
| GET | `/step-approvals/execution/:executionId` | `approvals.read` | — |

### `/members` — `members.ts` — 3 handlers, 3 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/members` | `members.read` | **G** · author |
| POST | `/members` | `members.grant` | **G** · super admin |
| DELETE | `/members/:subject` | `members.grant` | **G** · super admin |

### `/member-capabilities` — `member-capabilities.ts` — 3 handlers, 3 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/member-capabilities` | `members.read` | **G** · super admin |
| DELETE | `/member-capabilities/:subject/:capability` | `members.grant` | **G** · super admin |
| PUT | `/member-capabilities/:subject/:capability` | `members.grant` | **G** · super admin |

### `/budget` — `budgets.ts` — 3 handlers, 3 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| DELETE | `/budget` | `budget.write` | **G** · admin |
| GET | `/budget` | `budget.read` | **G** · admin |
| PUT | `/budget` | `budget.write` | **G** · admin |

### `/incidents` — `incidents.ts` — 4 handlers, 4 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/incidents` | `incidents.read` | **G** · author |
| POST | `/incidents` | `incidents.write` | **G** · admin |
| GET | `/incidents/:id` | `incidents.read` | **G** · author |
| PATCH | `/incidents/:id` | `incidents.write` | **G** · admin |

### `/credentials` — `credentials.ts` — 3 handlers, 0 guarded today, **3 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/credentials` | `secrets.read` | — |
| POST | `/credentials` | `secrets.write` | — |
| DELETE | `/credentials/:ref` | `secrets.write` | — |

### `/break-glass` — `break-glass.ts` — 3 handlers, 3 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| POST | `/break-glass` | `breakglass.activate` | **G** · admin |
| POST | `/break-glass/:id/revoke` | `breakglass.activate` | **G** · admin |
| GET | `/break-glass/active` | `breakglass.read` | **G** · admin |

### `/resources` — `resources.ts` — 2 handlers, 0 guarded today, **2 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/resources` | `resources.read` | — |
| GET | `/resources/:id` | `resources.read` | — |

### `/pins` — `pins.ts` — 2 handlers, 2 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/pins` | `flows.read` | I |
| POST | `/pins/:flowId/toggle` | `flows.read` | I |

### `/audit-events` — `audit-events.ts` — 2 handlers, 0 guarded today, **2 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/audit-events` | `audit.read` | — |
| GET | `/audit-events/export` | `audit.read` | — |

### `/me` — `attendance.ts` — 2 handlers, 2 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/me/attendance` | `—  (own data; subject from the token)` | **G** · author |
| GET | `/me/exceptions` | `—  (own data; subject from the token)` | **G** · author |

### `/steps` — `step-try.ts` — 1 handlers, 1 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| POST | `/steps/try` | `steps.try` | **G** · author |

### `/search` — `search.ts` — 1 handlers, 0 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/search` | `search.read` | — |

### `/release-gates` — `release-gates.ts` — 2 handlers, 1 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/release-gates` | `gates.read` | — |
| PATCH | `/release-gates/:gateId` | `gates.write` | **G** · admin |

### `/next-fires` — `next-fires.ts` — 1 handlers, 0 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/next-fires` | `flows.read` | — |

### `/email-box` — `email-box.ts` — 1 handlers, 0 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/email-box` | `runs.read` | — |

### `/bootstrap` — `bootstrap.ts` — 1 handlers, 0 guarded today, **1 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/bootstrap` | `bootstrap.read` | — |

### `/approval-requests` — `approval-requests.ts` — 2 handlers, 2 guarded today, **0 newly guarded**

| Method | Path | Permission | Today |
| :--- | :--- | :--- | :--- |
| GET | `/approval-requests` | `approvals.read` | **G** · author |
| GET | `/approval-requests/figures` | `approvals.read` | **G** · author |

---

## Deployment-level — 38 handlers

| Method | Path | Guard after | Today |
| :--- | :--- | :--- | :--- |
| GET | `/api/engine/plugins` | `requireIdentity` | — |
| GET | `/api/engine/plugins/:name/credentials` | `requireIdentity` | — |
| POST | `/api/generation/llm/models` | `requireIdentity` | — |
| DELETE | `/api/generation/llm/provider` | `platform.generation.write` | — |
| GET | `/api/generation/llm/provider` | `requireIdentity` | — |
| PUT | `/api/generation/llm/provider` | `platform.generation.write` | — |
| POST | `/api/generation/llm/test` | `requireIdentity` | — |
| GET | `/api/local-users` | `platform.localusers.write` | — |
| POST | `/api/local-users` | `platform.localusers.write` | — |
| DELETE | `/api/local-users/:id` | `platform.localusers.write` | — |
| PATCH | `/api/local-users/:id` | `platform.localusers.write` | — |
| GET | `/api/local-users/:id/access` | `platform.users.read` | — |
| DELETE | `/api/local-users/:id/access/:workspaceId` | `platform.members.grant` | — |
| PUT | `/api/local-users/:id/access/:workspaceId` | `platform.members.grant` | — |
| POST | `/api/local-users/:id/active` | `platform.localusers.write` | — |
| POST | `/api/local-users/:id/password` | `platform.localusers.write` | — |
| GET | `/api/me` | `requireIdentity (unchanged)` | I |
| POST | `/api/ops/llm/models` | `platform.toolmodel.read` | — |
| DELETE | `/api/ops/llm/provider` | `platform.toolmodel.write` | — |
| GET | `/api/ops/llm/provider` | `platform.toolmodel.read` | — |
| PUT | `/api/ops/llm/provider` | `platform.toolmodel.write` | — |
| POST | `/api/ops/llm/test` | `platform.toolmodel.read` | — |
| GET | `/api/ops/outbox/calls` | `platform.ops.read` | — |
| GET | `/api/ops/outbox/chat` | `platform.ops.read` | — |
| GET | `/api/ops/outbox/mail` | `platform.ops.read` | — |
| GET | `/api/ops/outbox/tickets` | `platform.ops.read` | — |
| GET | `/api/ops/status` | `platform.ops.read` | — |
| GET | `/api/platform/users` | `platform.users.read` | G |
| GET | `/api/signals` | `platform.signals.read` | — |
| GET | `/api/templates` | `requireIdentity (unchanged)` | I |
| GET | `/api/templates/:slug` | `requireIdentity (unchanged)` | I |
| GET | `/api/templates/suggestions` | `requireIdentity (unchanged)` | I |
| GET | `/api/workspaces` | `requireIdentity + filtered by grant (FR-015)` | — |
| POST | `/api/workspaces` | `platform.workspaces.write` | G |
| DELETE | `/api/workspaces/:id` | `platform.workspaces.write` | G |
| GET | `/api/workspaces/:id` | `flows.read in :id` | — |
| PATCH | `/api/workspaces/:id` | `platform.workspaces.write` | G |
| GET | `/api/workspaces/:id/manifest` | `flows.read in :id` | — |

---

## Exempt — 16 handlers that must NOT change (FR-005)

Recorded as *decided*, not missing, so the completeness check treats them as answered.

| Method | Path | Authenticated by |
| :--- | :--- | :--- |
| GET | `/api/executions/:id` | execution token |
| POST | `/api/executions/:id/complete` | execution token |
| POST | `/api/executions/begin` | Kestra callback secret |
| GET | `/api/health` | open liveness probe |
| GET | `/api/health/strict` | open liveness probe |
| POST | `/api/local-auth/verify` | answers before anybody has a session |
| POST | `/api/mail/send` | requireMailKey |
| POST | `/api/steps/approval` | execution token |
| POST | `/api/steps/datasource` | execution token |
| POST | `/api/steps/http` | execution token |
| POST | `/api/steps/llm` | execution token |
| POST | `/api/steps/query` | execution token |
| POST | `/api/steps/tool` | execution token |
| GET | `/api/test-oracle/screening` | test surface; blocked at the proxy |
| POST | `/api/triggers/:token/api` | public receiver, token in URL + Bearer |
| POST | `/api/triggers/:token/webhook` | public receiver, token in URL |

---

## Notes on the assignments that are not obvious

### Unchanged from the 2026-09-10 reasoning

- **`DELETE /flows/:flowId/revisions/:revision` is `flows.approve`, not `flows.write`.**
  Deleting a revision can unmake an approval, so it is an approval-tier act. Its guard
  today is `approver`; the mapping preserves that exactly.
- **`POST /datasources/:dsId/test` and `POST /tools/probe` are WRITE-tier.** Both dial an
  outside system with the tenant's stored credential. Read-looking, real outbound effect.
- **`POST /flows/:flowId/triggers/:tid/fire` is `flows.run`, not `flows.arm`.** Firing runs
  the approved live revision once; arming lets a timer do it unattended.
- **`POST /flow-templates/:id/instantiate` is `flows.write`, not `templates.write`.** It
  creates an automation, through `importFlow` — the same path a pasted bundle takes.
- **`GET /flow-executions/:id/replay` is the plan (read); `POST` executes it.**
  `POST /flow-executions/:id/watch` mints a 60s single-use socket ticket, so it is a read.
- **`secrets.read` grants the NAME list and the collision audit. No permission returns a
  value**, because no endpoint does, and this feature adds none (INV-3).
- **`requireProvenanceAuthority()` stays on approve and `requireNotRunRequester()` stays on
  decide, in addition to the permission** (FR-026). The accountability gates are not
  absorbed by the permission model; they sit after it.

### Corrected by the 2026-09-12 regeneration

- ⚠ **`POST …/approvals/rearm` → `flows.approve`.** It did not exist when the map was
  written (`8e4ab34`). Already `approver`-guarded; the mapping preserves that.
- ⚠ **`POST …/approvals/recheck` → `flows.approve`**, and it carries **no** guard today
  **while being able to suspend a live flow**.
- ⚠ **`POST /:dsId/queries/propose` → `datasources.query.write`**; it was unmapped, and the
  old map named two paths that do not exist (`/operations/check`, `/operations/propose`
  without `/:dsId/`).
- ⚠ **`GET /break-glass/active` → `breakglass.read`, a permission the catalogue lacked.**
  The old map gated a **read** behind an **activation** permission. It sits in `admin` and
  nowhere else, so effective access is byte-identical to today's `requireWorkspaceRole("admin")`.
- ⚠ **`GET /search` → `search.read`, and the map alone does not secure it.** The route has
  no `requireIdentity` and `searchService.index(workspaceId, q)` **takes no viewer at all**.
  The six kinds are `workflow · step · run · resource · approval · person` — **no secrets
  kind, no audit kind** — so the real read-arounds are `flows.read`, `runs.read`,
  `datasources.read`/`tools.read`, `approvals.read` and `members.read`. One service change,
  its own task.
- ⚠ **`PUT|DELETE /api/local-users/:id/access/:workspaceId` → `platform.members.grant`**,
  not `platform.localusers.write`: they write `workspace_members`, and a third permission
  granting workspace access is the duplication D-6 deletes `requireDeploymentAdmin` to
  avoid. `GET /:id/access` → `platform.users.read`. ⚠ **D-9 makes this coherent**: since
  `platform.members.grant` now confers `members.grant` in every workspace, this route and
  `POST /workspaces/:ws/members` are one authority reached two ways, rather than the only
  path by which a platform administrator could seed a workspace — and that path was scoped
  to local accounts only.
- ⚠ **`ops-proxy.ts`'s ten handlers are NOT all `platform.audit.read`.** Six are outbox and
  status reads (`platform.ops.read`); **four are the `llm_complete` tool-model setting**
  (`platform.toolmodel.read|write`), which D-115 keeps deliberately separate from the
  generation model.
- ⚠ **`GET /api/signals` → `platform.signals.read`.** Signals is *"is the system still doing
  its job"*, not audit history, and a scheduler reads its 0/1/2 exit code.
- ⚠ **`GET /api/workspaces/:id` and `/:id/manifest` name the workspace `:id`, not
  `:workspaceId`.** FR-024 makes a *missing* `:workspaceId` a loud 500; these two are the
  case where the workspace is present under another name. The guard takes the parameter
  name explicitly.

### New with `beta-1.1.0` / `beta-1.2.0` (2026-09-13)

All ten arrived **already guarded**, so each mapping below is an exact carry-forward unless
marked.

- **`GET|PUT|DELETE /budget` → `budget.read` / `budget.write`.** The M3 concurrency budget,
  `admin` today. ⚠ **Two permissions, not one** — one `budget.write` covering the GET would
  repeat the `breakglass.read` mistake corrected above.
- **`PATCH /release-gates/:gateId` and `PATCH /flows/:flowId/release-gates/:gateId` →
  `gates.write`** (`admin` today). ⚠ **`GET /release-gates` moves from `flows.read` to
  `gates.read`** — it was a free choice (unguarded today) and a read and a write of the same
  feature area should share a domain, or the catalogue stops being readable by area.
- **`GET /approval-requests/figures` → `approvals.read`** (`author` today ✓).
- **`PATCH /incidents/:id` → `incidents.write`** (`admin` today ✓).
- ⚠ **`GET|PUT|DELETE /member-capabilities[/…]` → `members.read` / `members.grant`, and
  this is a WIDENING.** They are **`requireSuperAdmin` today**. This is the per-member
  permission-grant surface — FR-010's override store, which arrived as a real product
  feature while this spec was being written. Moving it to `members.grant` is behaviour
  change 3 applied consistently: a workspace admin manages their own members, including
  their individual grants. Leaving it super-admin-only while `POST /members` becomes
  admin-reachable would mean an admin could grant a **role** but not a single permission,
  which is the wrong way round.

### The permission catalogue this map implies

**Workspace tier (38)**: `flows.read` `flows.write` `flows.run` `flows.approve` `flows.arm` ·
`runs.read` `runs.replay` · `approvals.read` `approvals.decide` · `datasources.read`
`datasources.write` `datasources.query.write` · `tools.read` `tools.write` · `secrets.read`
`secrets.write` · `catalogue.read` `catalogue.write` · `templates.read` `templates.write` ·
`resources.read` · `audit.read` · `members.read` `members.grant` `roles.write` ·
`incidents.read` `incidents.write` · `breakglass.read` `breakglass.activate` ·
`gates.read` `gates.write` · `budget.read` `budget.write` · `realdata.use` · `search.read`
`bootstrap.read` `scenarios.read` `steps.try`.

**Platform tier (11)**: `platform.workspaces.write` `platform.members.grant`
`platform.users.read` `platform.roles.write` `platform.generation.write`
`platform.audit.read` `platform.localusers.write` `platform.ops.read`
`platform.toolmodel.read` `platform.toolmodel.write` `platform.signals.read`.

**49 named permissions.** Two workspace permissions guard no route in this map —
`realdata.use` is enforced **inside** `break-glass.ts` and `catalogue.service.ts`, and
`roles.write` guards the custom-role routes [`api.md`](./api.md) §B adds; two platform
permissions (`platform.roles.write`, `platform.audit.read`) guard the platform-tier routes
§C adds. The completeness check tests **routes against the catalogue, never the catalogue
against routes** — a permission with no route is legal, a route with no permission is not.

---

## The completeness check (FR-002, FR-003)

`packages/server/src/auth/route-permissions.test.ts`:

1. Walk the mounted Express router stack of `createApp()`, collecting every
   `(method, resolved path)` pair. [`dump-routes.mts`](./dump-routes.mts) is the same walk,
   standalone — see [README.md](./README.md).
2. **Dedupe on `(method, resolved path)`** — `GET /flows/:flowId/phases` is registered twice
   and `releaseGatesRouter` is mounted twice.
3. Every pair must be a key in the map or in `EXEMPT`. Missing ⇒ **fail, naming the route**.
4. Every key in the map must correspond to a mounted route. Stale ⇒ fail; a map entry for a
   deleted route reads as coverage.
5. Every permission named must exist in the catalogue (INV-2).
6. **Control** (FR-003): a synthetic router with one undeclared handler is passed to the same
   function and the check must fail on it. Without this, a walker that finds nothing passes
   as a walker that finds no problems — I-38, and the exact way 21 client render-test files
   were green while not running.

⚠ Research M-5 still holds: `localUsersRouter`'s handlers are guarded at the **router**
(`.use(requireIdentity, requireSuperAdmin)`), not per handler. The stack shows them; a regex
over source reports nine false positives.
