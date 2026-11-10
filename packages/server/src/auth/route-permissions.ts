import type { PlatformPermission, WorkspacePermission } from "./permissions.js";

/**
 * Which permission each mounted route requires.
 *
 * ⚠ **THIS FILE IS GENERATED. DO NOT EDIT IT BY HAND.**
 * Regenerate with the procedure in
 * `specs/20260910-130448-feature-rbac-permissions/contracts/README.md`:
 * `dump-routes.mts` walks the live Express stack, `gen-map.py` carries the only
 * hand-authored part (the assignment table) and fails loudly on any unmapped route or
 * stale entry, and `emit-ts.py` writes this file.
 *
 * The hand-written version of this map drifted in six places in two days, and the route
 * surface moved twice in four days — `beta-1.1.0` added ten routes mid-session.
 * Regenerating costs one command; transcribing 196 routes is 196 chances to be wrong in
 * the one file whose only value is being exactly right.
 *
 * ## ⚠ Completeness is checked against the STACK, never against source
 *
 * `route-permissions.test.ts` walks the same `createApp()` this was generated from and
 * requires every `(method, path)` to appear here or in `EXEMPT`. A regex over route
 * files reports nine false positives on `local-users.ts` alone, which is guarded at the
 * router rather than per handler (research M-5).
 *
 * The check runs in ONE direction: **routes are checked against the map, never the map
 * against routes.** A permission with no route is legal — `roles.write` guards routes
 * this feature adds. A route with no permission is not.
 *
 * ## ⚠ Scope is declared, never inferred from the parameter's presence
 *
 * `GET /api/workspaces/:id` is workspace-scoped and its parameter is `:id`.
 * `PUT /api/local-users/:id/access/:workspaceId` is **deployment-level** and carries a
 * `:workspaceId`. Inferring scope from "does this path contain :workspaceId" gets one of
 * those wrong in each direction, so every workspace entry names its parameter.
 *
 * Counts at generation time: **348 mounted routes** —
 * 255 workspace-scoped, 42 platform, 22 identity-only,
 * 29 exempt. ⚠ Read these from the exported arrays, never from this comment.
 */

export type RouteRequirement =
  /** Answered against `(person, workspace)`. `param` names where the workspace id is. */
  | { kind: "workspace"; permission: WorkspacePermission; param: string }
  /** Answered against a person alone — no workspace in the question. */
  | { kind: "platform"; permission: PlatformPermission }
  /**
   * Signed in, and nothing more.
   *
   * ⚠ NOT the same as exempt, and the difference is the point. These routes answer
   * about the caller themselves — their own attendance, their own permissions, the
   * workspaces they can see — so requiring a permission to reach them would be a
   * bootstrap nobody can escape: you would need access in order to discover you have
   * none. `GET /api/workspaces` is the sharpest case: it is identity-only AND the list
   * it returns is filtered per grant, so the authorisation is in the *contents*, not in
   * reaching it.
   */
  | { kind: "identity"; why: string }
  /**
   * No identity at all, with a stated reason.
   *
   * ⚠ Every entry carries a REASON string, so an exemption is something somebody
   * decided rather than something nobody noticed (FR-005). An exemption with no reason
   * is indistinguishable from an oversight, and both look like a passing test.
   */
  | { kind: "exempt"; reason: string };

/** `"METHOD /full/path"` → what it requires. */
export const ROUTE_PERMISSIONS: ReadonlyMap<string, RouteRequirement> = Object.freeze(
  new Map<string, RouteRequirement>([
    // ── workspace-scoped ─────────────────────────────────────────────────────
    ["DELETE /api/workspaces/:workspaceId/budget", { kind: "workspace", permission: "budget.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/credentials/:ref", { kind: "workspace", permission: "secrets.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/datasources/:dsId", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/datasources/:dsId/operations/:name", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/datasources/:dsId/queries/:name", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/email-box/messages/:id", { kind: "workspace", permission: "flows.run", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/email-box/undelivered", { kind: "workspace", permission: "flows.run", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/files/:fileId", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/flow-templates/:id", { kind: "workspace", permission: "templates.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/edge/devices/:deviceId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/flows/:flowId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/flows/:flowId/review-request", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/flows/:flowId/revisions/:revision", { kind: "workspace", permission: "flows.approve", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/flows/:flowId/triggers/:tid", { kind: "workspace", permission: "flows.arm", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/member-capabilities/:subject/:capability", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/members/:subject", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/pi-builder/chats/:chatId", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/attachments/:name", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/files/:name", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/references/:refId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/plugins/:piece/calls/:name", { kind: "workspace", permission: "plugins.enable", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/plugins/:piece/mine/calls/:name", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/plugins/connections/:connectionId", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/projects/:projectId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/projects/:projectId/files/:fileId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/projects/:projectId/members/:subject", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/roles/:roleId", { kind: "workspace", permission: "roles.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/roles/:roleId/members/:subject", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/secrets/:id", { kind: "workspace", permission: "secrets.write", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/tools/:toolId", { kind: "workspace", permission: "tools.write", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/approval-requests", { kind: "workspace", permission: "approvals.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/approval-requests/figures", { kind: "workspace", permission: "approvals.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/audit-events", { kind: "workspace", permission: "audit.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/audit-events/export", { kind: "workspace", permission: "audit.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/bootstrap", { kind: "workspace", permission: "bootstrap.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/break-glass/active", { kind: "workspace", permission: "breakglass.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/budget", { kind: "workspace", permission: "budget.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/catalogue", { kind: "workspace", permission: "catalogue.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/catalogue/items", { kind: "workspace", permission: "catalogue.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/credentials", { kind: "workspace", permission: "secrets.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/mock", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/mock/rows", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/operations", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/operations/:name", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/queries", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/queries/:name", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/queries/:name/impact", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/sandbox", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/datasources/:dsId/schema", { kind: "workspace", permission: "datasources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/edge/connects/pending", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/edge/devices", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/edge/devices/:deviceId/jobs", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/edge/pending", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/email-box", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/email-box/:sendId/attachments/:position", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/emergency-access", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/files", { kind: "workspace", permission: "resources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/files/:fileId/content", { kind: "workspace", permission: "resources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-chat/threads", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-chat/threads/:threadId/turns", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-executions", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-executions/:id", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-executions/:id/shares", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-executions/:id/calls", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-executions/:id/emails", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-executions/:id/replay", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-templates", { kind: "workspace", permission: "templates.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flow-templates/:id", { kind: "workspace", permission: "templates.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/activation", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/approvals", { kind: "workspace", permission: "approvals.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/approvals/diff", { kind: "workspace", permission: "approvals.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/canvas", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/choices", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/expectation-suggestions", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/export", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/export/kestra", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/flags", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/incomplete", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/integration", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/last-run", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/move-preview", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/phases", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/positions", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/readiness", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/release-gates", { kind: "workspace", permission: "gates.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/revisions", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/revisions/:revision/steps", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/run-as", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/scenarios", { kind: "workspace", permission: "scenarios.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/triggers", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/flows/:flowId/triggers/:tid/fires", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/fragment-candidates", { kind: "workspace", permission: "templates.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/incidents", { kind: "workspace", permission: "incidents.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/incidents/:id", { kind: "workspace", permission: "incidents.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/member-capabilities", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/members", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/next-fires", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/notifications", { kind: "workspace", permission: "bootstrap.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/observability", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/chats", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/chats/:chatId", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/chats/:chatId/files/:name", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/chats/:chatId/move-preview", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/background", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/events", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/referenceable", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/references", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/pins", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/plugins", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/plugins/:piece/calls", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/plugins/:piece/mine", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/plugins/marketplace", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/projects", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/projects/:projectId", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/projects/:projectId/files", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/projects/:projectId/files/:fileId/content", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/release-gates", { kind: "workspace", permission: "gates.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/resources", { kind: "workspace", permission: "resources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/resources/:id", { kind: "workspace", permission: "resources.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/roles", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/roles/:roleId", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/roles/:roleId/members", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/search", { kind: "workspace", permission: "search.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/secrets", { kind: "workspace", permission: "secrets.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/secrets/:id/impact", { kind: "workspace", permission: "secrets.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/secrets/audit", { kind: "workspace", permission: "secrets.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/step-approvals", { kind: "workspace", permission: "approvals.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/step-approvals/execution/:executionId", { kind: "workspace", permission: "approvals.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/tools", { kind: "workspace", permission: "tools.read", param: "workspaceId" }],
    ["GET /api/workspaces/:workspaceId/tools/:toolId", { kind: "workspace", permission: "tools.read", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/datasources/:dsId", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/datasources/:dsId/operations/:name", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/datasources/:dsId/queries/:name", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/flows/:flowId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/flows/:flowId/flags/:flagId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/flows/:flowId/release-gates/:gateId", { kind: "workspace", permission: "gates.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/flows/:flowId/triggers/:tid", { kind: "workspace", permission: "flows.arm", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/incidents/:id", { kind: "workspace", permission: "incidents.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/pi-builder/chats/:chatId", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/references/:refId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/plugins/connections/:connectionId", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/projects/:projectId", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/release-gates/:gateId", { kind: "workspace", permission: "gates.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/roles/:roleId", { kind: "workspace", permission: "roles.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/secrets/:id", { kind: "workspace", permission: "secrets.write", param: "workspaceId" }],
    ["PATCH /api/workspaces/:workspaceId/tools/:toolId", { kind: "workspace", permission: "tools.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/access-requests", { kind: "workspace", permission: "catalogue.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/break-glass", { kind: "workspace", permission: "breakglass.activate", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/break-glass/:id/revoke", { kind: "workspace", permission: "breakglass.activate", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/catalogue/access-requests", { kind: "workspace", permission: "catalogue.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/credentials", { kind: "workspace", permission: "secrets.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/mock/rebuild", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/operations", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/operations/check", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/operations/propose", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/queries", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/queries/check", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/queries/propose", { kind: "workspace", permission: "datasources.query.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/schema/refresh", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/:dsId/test", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/datasources/sqlite-files", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/emergency-access/:accessId/end", { kind: "workspace", permission: "members.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/files", { kind: "workspace", permission: "datasources.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-chat/threads", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-chat/threads/:threadId/flow", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-chat/threads/:threadId/turns", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-executions/:id/replay", { kind: "workspace", permission: "runs.replay", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-executions/:id/watch", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-executions/:id/shares", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    ["DELETE /api/workspaces/:workspaceId/flow-executions/:id/shares/:subject", { kind: "workspace", permission: "runs.read", param: "workspaceId" }],
    // Same bar as starting a run: an author who can fire one can stop one of theirs.
    ["POST /api/workspaces/:workspaceId/flow-executions/:id/cancel", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-templates", { kind: "workspace", permission: "templates.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-templates/:id/instantiate", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-templates/:id/plan", { kind: "workspace", permission: "templates.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flow-templates/from-bundle", { kind: "workspace", permission: "templates.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/devices/:deviceId/approve-connect", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/devices/:deviceId/deny-connect", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/devices/:deviceId/jobs", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/devices/pair", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/jobs/:jobId/approve", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/jobs/:jobId/reject", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/relay/:id/decide", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/edge/setup-link", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/approvals", { kind: "workspace", permission: "flows.approve", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/approvals/rearm", { kind: "workspace", permission: "flows.approve", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/approvals/recheck", { kind: "workspace", permission: "flows.approve", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/approvals/revoke", { kind: "workspace", permission: "flows.approve", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/canvas/act", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/canvas/save", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/duplicate", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/incomplete/answer", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/inputs", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/move", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/review-request", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/revisions", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/run", { kind: "workspace", permission: "flows.run", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/save-draft", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/steps/:stepId/regenerate", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/switch-off", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/switch-on", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/test-run", { kind: "workspace", permission: "flows.run", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/triggers", { kind: "workspace", permission: "flows.arm", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/:flowId/triggers/:tid/fire", { kind: "workspace", permission: "flows.run", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/builder/build", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/builder/correct", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/builder/understand", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/canvas", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/import", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/flows/import/plan", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/incidents", { kind: "workspace", permission: "incidents.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/members", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/notifications/read", { kind: "workspace", permission: "bootstrap.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/chats/:chatId/move", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/runs", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/accept", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/accounts/clear", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/answers", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/attachments", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/bind-flow", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/compact", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/messages", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/mode", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/model", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/proposals/:proposalId", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/references", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/save-version", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/steer", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/background/:jobId/cancel", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/stop", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/test-run", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/thinking", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pi-builder/sessions/:sessionId/verify", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/pins/:flowId/toggle", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/:piece/call-packs/:pack", { kind: "workspace", permission: "plugins.enable", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/:piece/calls", { kind: "workspace", permission: "plugins.enable", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/:piece/connections", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/:piece/mine/call-packs/:pack", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/:piece/oauth/start", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/connections/:connectionId/test", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/plugins/oauth/callback", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/projects", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/projects/:projectId/files", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/projects/:projectId/members", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/roles", { kind: "workspace", permission: "roles.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/roles/:roleId/members", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/secrets", { kind: "workspace", permission: "secrets.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/step-approvals/:approvalId/decide", { kind: "workspace", permission: "approvals.decide", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/steps/try", { kind: "workspace", permission: "steps.try", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/tools", { kind: "workspace", permission: "tools.write", param: "workspaceId" }],
    ["POST /api/workspaces/:workspaceId/tools/probe", { kind: "workspace", permission: "tools.write", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/budget", { kind: "workspace", permission: "budget.write", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/flows/:flowId/activation", { kind: "workspace", permission: "flows.run", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/flows/:flowId/my-account", { kind: "workspace", permission: "flows.read", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/flows/:flowId/owner", { kind: "workspace", permission: "content.read.others", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/flows/:flowId/positions", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/flows/:flowId/run-as", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/flows/:flowId/visibility", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/member-capabilities/:subject/:capability", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/plugins/:piece/actions", { kind: "workspace", permission: "plugins.enable", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/plugins/:piece/mine/actions", { kind: "workspace", permission: "plugins.read", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/plugins/:piece/personal-use", { kind: "workspace", permission: "plugins.enable", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/projects/:projectId/owner", { kind: "workspace", permission: "flows.write", param: "workspaceId" }],
    ["PUT /api/workspaces/:workspaceId/restricted", { kind: "workspace", permission: "members.grant", param: "workspaceId" }],
    ["GET /api/workspaces/:id", { kind: "workspace", permission: "flows.read", param: "id" }],
    ["GET /api/workspaces/:id/manifest", { kind: "workspace", permission: "flows.read", param: "id" }],

    // ── platform tier ────────────────────────────────────────────────────────
    ["DELETE /api/allowed-users/:id", { kind: "identity", why: "allowlist admin: requireUserAdmin inside the router (allowed_users admin or SUPER_ADMIN_EMAILS)" }],
    ["DELETE /api/local-users/:id", { kind: "platform", permission: "platform.localusers.write" }],
    ["DELETE /api/local-users/:id/access/:workspaceId", { kind: "platform", permission: "platform.members.grant" }],
    ["DELETE /api/platform/role-assignments/:subject/:roleKey", { kind: "platform", permission: "platform.members.grant" }],
    ["DELETE /api/platform/roles/:key", { kind: "platform", permission: "platform.roles.write" }],
    ["DELETE /api/plugins/installs/:piece", { kind: "platform", permission: "platform.plugins.install" }],
    ["DELETE /api/plugins/oauth-apps/:piece", { kind: "platform", permission: "platform.plugins.install" }],
    ["DELETE /api/runtime-model/provider", { kind: "identity", why: "personal BYOK: each signed-in subject owns their own AI connection" }],
    ["DELETE /api/workspaces/:id", { kind: "platform", permission: "platform.workspaces.write" }],
    ["GET /api/generation/pricing/spend", { kind: "platform", permission: "platform.signals.read" }],
    ["GET /api/allowed-users", { kind: "identity", why: "allowlist admin: requireUserAdmin inside the router (allowed_users admin or SUPER_ADMIN_EMAILS)" }],
    ["GET /api/local-users", { kind: "platform", permission: "platform.localusers.write" }],
    ["GET /api/local-users/:id/access", { kind: "platform", permission: "platform.users.read" }],
    ["GET /api/observability", { kind: "platform", permission: "platform.signals.read" }],
    ["GET /api/platform/access", { kind: "platform", permission: "platform.users.read" }],
    ["GET /api/platform/audit", { kind: "platform", permission: "platform.audit.read" }],
    ["GET /api/platform/people", { kind: "platform", permission: "platform.users.read" }],
    ["GET /api/platform/role-assignments", { kind: "platform", permission: "platform.users.read" }],
    ["GET /api/platform/roles", { kind: "platform", permission: "platform.users.read" }],
    ["GET /api/platform/users", { kind: "platform", permission: "platform.users.read" }],
    ["GET /api/plugins/installs", { kind: "platform", permission: "platform.plugins.install" }],
    ["GET /api/plugins/marketplace", { kind: "platform", permission: "platform.plugins.install" }],
    ["GET /api/plugins/oauth-apps/:piece", { kind: "platform", permission: "platform.plugins.install" }],
    ["GET /api/runtime-model/provider", { kind: "identity", why: "personal BYOK: each signed-in subject owns their own AI connection" }],
    ["GET /api/signals", { kind: "platform", permission: "platform.signals.read" }],
    ["PATCH /api/allowed-users/:id", { kind: "identity", why: "allowlist admin: requireUserAdmin inside the router (allowed_users admin or SUPER_ADMIN_EMAILS)" }],
    ["PATCH /api/local-users/:id", { kind: "platform", permission: "platform.localusers.write" }],
    ["PATCH /api/platform/roles/:key", { kind: "platform", permission: "platform.roles.write" }],
    ["PATCH /api/workspaces/:id", { kind: "platform", permission: "platform.workspaces.write" }],
    ["POST /api/allowed-users", { kind: "identity", why: "allowlist admin: requireUserAdmin inside the router (allowed_users admin or SUPER_ADMIN_EMAILS)" }],
    ["POST /api/local-users", { kind: "platform", permission: "platform.localusers.write" }],
    ["POST /api/local-users/:id/active", { kind: "platform", permission: "platform.localusers.write" }],
    ["POST /api/local-users/:id/password", { kind: "platform", permission: "platform.localusers.write" }],
    ["POST /api/platform/emergency-access", { kind: "platform", permission: "platform.workspaces.write" }],
    ["POST /api/platform/role-assignments", { kind: "platform", permission: "platform.members.grant" }],
    ["POST /api/platform/roles", { kind: "platform", permission: "platform.roles.write" }],
    ["POST /api/plugins/installs", { kind: "platform", permission: "platform.plugins.install" }],
    ["POST /api/plugins/installs/:piece/upgrade", { kind: "platform", permission: "platform.plugins.install" }],
    ["POST /api/runtime-model/models", { kind: "identity", why: "personal BYOK: each signed-in subject owns their own AI connection" }],
    ["POST /api/runtime-model/test", { kind: "identity", why: "personal BYOK: each signed-in subject owns their own AI connection" }],
    ["POST /api/workspaces", { kind: "platform", permission: "platform.workspaces.write" }],
    ["PUT /api/generation/pricing", { kind: "platform", permission: "platform.generation.write" }],
    ["PUT /api/local-users/:id/access/:workspaceId", { kind: "platform", permission: "platform.members.grant" }],
    ["PUT /api/plugins/installs/:piece/hosts", { kind: "platform", permission: "platform.plugins.install" }],
    ["PUT /api/plugins/oauth-apps/:piece", { kind: "platform", permission: "platform.plugins.install" }],
    ["PUT /api/runtime-model/provider", { kind: "identity", why: "personal BYOK: each signed-in subject owns their own AI connection" }],

    // ── identity only ────────────────────────────────────────────────────────
    ["GET /api/workspaces/:workspaceId/me/attendance", { kind: "identity", why: "own data; subject from the token" }],
    ["GET /api/workspaces/:workspaceId/me/exceptions", { kind: "identity", why: "own data; subject from the token" }],
    ["GET /api/workspaces/:workspaceId/me/permissions", { kind: "identity", why: "own access; no permission required" }],
    ["DELETE /api/invitations/:id", { kind: "identity", why: "an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check" }],
    ["DELETE /api/invitations/:id/workspaces/:workspaceId", { kind: "identity", why: "an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check" }],
    ["GET /api/engine/plugins", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/engine/plugins/:name/credentials", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/generation/pricing", { kind: "identity", why: "signed in; a member sees their own cost, so the prices behind it are readable" }],
    ["GET /api/invitations", { kind: "identity", why: "an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check" }],
    ["GET /api/me", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/permissions/catalogue", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/reports/export", { kind: "identity", why: "the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those" }],
    ["GET /api/reports/forecast", { kind: "identity", why: "the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those" }],
    ["GET /api/reports/runs", { kind: "identity", why: "the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those" }],
    ["GET /api/reports/summary", { kind: "identity", why: "the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those" }],
    ["GET /api/templates", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/templates/:slug", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/templates/suggestions", { kind: "identity", why: "signed in; no further permission" }],
    ["GET /api/workspaces", { kind: "identity", why: "signed in; the LIST ITSELF is filtered per grant (FR-015)" }],
    ["POST /api/invitations", { kind: "identity", why: "an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check" }],
    ["POST /api/reports/email", { kind: "identity", why: "the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those" }],
    ["PUT /api/me/forge-default-mode", { kind: "identity", why: "own setting; subject from the token" }],
  ]),
);

/**
 * Routes that require no identity at all, each with the reason it does not.
 *
 * ⚠ These are the routes an unauthenticated caller can reach, so this is the shortest
 * and most security-relevant list in the feature. Six are step callbacks carrying an
 * execution token, three are the engine's execution lifecycle, two are liveness probes,
 * two are public receivers whose credential is the token in the URL, one is the mail
 * key, one is a test surface blocked at the proxy, and one answers before anybody has a
 * session — which is what mints one.
 */
export const EXEMPT: ReadonlyMap<string, { reason: string }> = Object.freeze(
  new Map<string, { reason: string }>([
    ["GET /api/executions/:id", { reason: "execution token" }],
    ["GET /api/edge/agent.mjs", { reason: "public edge bootstrap script (no secrets; used by setup fmt=sh)" }],
    ["GET /api/edge/setup", { reason: "public edge setup instructions / bootstrap (setup token in query)" }],
    ["GET /api/health", { reason: "open liveness probe" }],
    ["GET /api/health/strict", { reason: "open liveness probe" }],
    ["GET /api/steps/files/workspace/:name", { reason: "execution token" }],
    ["GET /api/test-oracle/screening", { reason: "test surface; blocked at the proxy" }],
    ["POST /api/edge/jobs/:jobId/complete", { reason: "edge device Bearer token" }],
    ["POST /api/edge/jobs/claim", { reason: "edge device Bearer token" }],
    ["POST /api/edge/relay", { reason: "edge device Bearer token (plugin relay)" }],
    ["GET /api/edge/relay/:id", { reason: "edge device Bearer token (plugin relay status)" }],
    ["POST /api/edge/pair", { reason: "public edge OTP pairing (6-digit code)" }],
    ["POST /api/edge/setup/register", { reason: "public edge setup register (setup token in body)" }],
    ["POST /api/edge/setup/wait", { reason: "public edge setup wait (deviceId + waitSecret)" }],
    ["POST /api/executions/:id/complete", { reason: "execution token" }],
    ["POST /api/executions/:id/pause", { reason: "execution token" }],
    ["POST /api/executions/:id/steps/:stepId/result", { reason: "execution token" }],
    ["POST /api/executions/begin", { reason: "Kestra callback secret" }],
    ["POST /api/forge/actions", { reason: "Forge's per-conversation tool key (Forge Agent; lists the connected services' actions, changes nothing)" }],
    ["POST /api/forge/card", { reason: "Forge's per-conversation tool key (Forge Agent; shows a structured info/ask card in chat, performs nothing)" }],
    ["POST /api/forge/data", { reason: "Forge's per-conversation tool key (assistant mode, checked in the service)" }],
    ["POST /api/forge/edge/devices", { reason: "Forge's per-conversation tool key (personal thin; lists the person's paired edge devices)" }],
    ["POST /api/forge/edge/enqueue", { reason: "Forge's per-conversation tool key (personal thin; queues a job on a paired edge device)" }],
    ["POST /api/forge/edge/job", { reason: "Forge's per-conversation tool key (personal thin; polls an edge job)" }],
    ["POST /api/forge/fetch", { reason: "Forge's per-conversation tool key (a public web address read while building; web access checked in the service)" }],
    ["POST /api/forge/file", { reason: "Forge's per-conversation tool key (a workspace File opened while building)" }],
    ["POST /api/forge/plugin", { reason: "Forge's per-conversation tool key (assistant mode; a connector READ — a write is refused in the service)" }],
    ["POST /api/forge/propose", { reason: "Forge's per-conversation tool key (Forge Agent; PROPOSES a change, performs nothing — the person's click does)" }],
    ["POST /api/forge/propose-setting", { reason: "Forge's per-conversation tool key (Forge Agent; PROPOSES switching an action on or off, applies nothing — the person's click does)" }],
    ["POST /api/llm/complete", { reason: "requireLlmKey" }],
    ["POST /api/email-otp/request", { reason: "answers before anybody has a session (email sign-in code; API key + own throttles)" }],
    ["POST /api/email-otp/status", { reason: "answers before anybody has a session (email sign-in code; API key + own throttles)" }],
    ["POST /api/email-otp/verify", { reason: "answers before anybody has a session (email sign-in code; API key + own throttles)" }],
    ["POST /api/local-auth/verify", { reason: "answers before anybody has a session" }],
    ["POST /api/mail/send", { reason: "requireMailKey" }],
    ["POST /api/steps/approval", { reason: "execution token" }],
    ["POST /api/steps/datasource", { reason: "execution token" }],
    ["POST /api/steps/files", { reason: "execution token" }],
    ["POST /api/steps/http", { reason: "execution token" }],
    ["POST /api/steps/llm", { reason: "execution token" }],
    ["POST /api/steps/query", { reason: "execution token" }],
    ["POST /api/steps/tool", { reason: "execution token" }],
    ["POST /api/triggers/:token/api", { reason: "public receiver, token in URL + Bearer" }],
    ["POST /api/triggers/:token/webhook", { reason: "public receiver, token in URL" }],
    ["POST /api/web/fetch", { reason: "requireWebKey" }],
  ]),
);

/** `"METHOD /path"`, the key shape both maps use. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function requirementFor(method: string, path: string): RouteRequirement | undefined {
  const key = routeKey(method, path);
  const exempt = EXEMPT.get(key);
  if (exempt) return { kind: "exempt", reason: exempt.reason };
  return ROUTE_PERMISSIONS.get(key);
}
