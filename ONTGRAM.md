# Ontogram Memory — foundry

> Auto-managed by Ontogram (`integrations/ensure_memory.py`). Do not edit the header.
> This file mirrors `deck_foundry_memory` (project scope) and `deck_global_memory` when relevant.
> Agents: `recall` this file via Ontogram at session start; `remember` durable facts as they happen.

## Project facts (scope: project)

<!-- Add one dense fact per bullet. The bootstrap will push these to Ontogram if the graph is empty. -->
- Synced from Ontogram on first run:
**Decisions & architecture**
- Workspace = tenant-scoped component: `workspaces` table with immutable `slug`, mandatory `tenantSlug`, `kind` null (real) vs "fixture" (harness), `mailRecipientAllowlist`.
- All resources (tools, secrets, datasources, flows, triggers, executions, budgets, operations) scoped by `workspaceId` FK cascade; everything filtered `WHERE workspaceId=?`.
- Namespaces: live `foundry.<tenantSlug>.<slug>`, draft `...draft`; draft reads sandbox DSN, live reads production. `systemNamespace` = `foundry.system` (2 segments, cannot resolve workspace — D-09). No cross-workspace listing of templates/fragments (D-27).
- Secrets: `workspace_secrets`, AES-256-GCM (`valueEnc`, `sandboxValueEnc`), env-var name regex, unique per `(workspaceId, name)`; 409 on shadowed secret collisions.
- RBAC roles author < approver < admin; `workspaceMembers` unique `(workspaceId, subject)`; super-admin via `SUPER_ADMIN_EMAILS`, exact subject + case-insensitive email. Zero members = approvals refused until super-admin assigns; last admin cannot be demoted.
- Client: `workspace.tsx` provider, `workspace-choice.ts` store. Routes: `/api/workspaces` CRUD super-admin only; `/api/workspaces/:workspaceId/members` per-workspace RBAC.
- Infra: `infra/docker-compose.yml` — server :4000/:4001, client :4002, ops-api :4004, postgres :5433, Kestra internal (no port), mcp-bridge :4003 (4 read-only MCP tools, requires `MCP_BRIDGE_API_KEY`, fail-closed) **disabled** via `profiles:["mcp-bridge"]` (previously :3015). Cognee MCP on :9481 (Ontogram memory) is separate.
- Docs: CLAUDE.md (super-admin load-bearing), GAPS.md §1.1, spec `20260820-193547-superadmin-workspace-assignment`.

**Open threads / notes**
- Ontogram direct test: `opencode go deepseek` works without litellm proxy.
- mcp-bridge currently disabled — reason not stated in context.

## Global facts (scope: global)

- 

## Session notes

-

## Synced from Ontogram (project:foundry)

**Decisions**
- Workspaces: immutable `slug`, mandatory `tenantSlug`, `kind` null=real tenant vs "fixture"=harness, `mailRecipientAllowlist`.
- Isolation: `workspaceId` FK cascades on tools/secrets/datasources/flows/triggers/executions/budgets/operations; all filtered `WHERE workspaceId=?`; no cross-workspace templates/fragments (D-27).
- Namespaces: live `foundry.<tenantSlug>.<slug>`, draft `...draft` (draft reads sandbox DSN, live reads production); `systemNamespace` = `foundry.system` — 2 segments, cannot resolve workspace (D-09).
- Secrets: AES-256-GCM `valueEnc`/`sandboxValueEnc`, unique `(workspaceId,name)`, env-var regex.
- RBAC: author < approver < admin (RANK); unique `(workspaceId,subject)`; super-admin via `SUPER_ADMIN_EMAILS` (exact subject, case-insensitive email); zero members ⇒ approvals refused; last admin cannot be demoted.
- mcp-bridge: read-only, requires `MCP_BRIDGE_API_KEY`, fail-closed, disabled via `profiles:["mcp-bridge"]`.

**Architecture**
- Foundry = parent app over Tether Harness (:6800).
- `infra/docker-compose.yml`: server :4000/:4001, client :4002, ops-api :4004, postgres :5433, Kestra internal (no port), mcp-bridge :4003 (was :3015).
- Key tables: `workspaces` (schema.ts:26), `workspace_secrets` (:180), datasources (:227), flows (:635), flowExecutions (:951), workspaceMembers (:1497).
- Key services: workspace.service.ts:125, workspace-member.service.ts:167, workspace-secret.service.ts:33, tenant-mapper.service.ts:67, kestra-client.service.ts:46.
- Routes: `/api/workspaces` super-admin CRUD; `/api/workspaces/:workspaceId/members` per-workspace RBAC.
- Client: `workspace.tsx` provider, `workspace-choice.ts` store, MembersPanel/PlatformUsersPanel.
- mcp-bridge: 4 read-only tools via schema-store.ts:50 (`WHERE workspaceId=?`); Cognee MCP (Ontogram memory) on :9481 is separate.

**Preferences / notes**
- Docs: CLAUDE.md (super-admin load-bearing), GAPS.md §1.1, spec `20260820-193547-superadmin-workspace-assignment`.

**Open threads**
- mcp-bridge currently disabled via profiles (reason not in context).
- Ontogram direct test: `opencode go deepseek` works without litellm proxy.
