import json,re,sys,collections
SP=sys.argv[1]
rows=[]
for line in open(SP+'/routes.clean.tsv'):
    m,rest=line.rstrip('\n').split(' ',1)
    path,guard=rest.split('\t')
    rows.append((m,path,guard))

WS='/api/workspaces/:workspaceId/'

# (method, path-after-mount) -> permission
W = {
 # flows.ts
 ('GET','flows'):'flows.read', ('POST','flows'):'flows.write',
   # ⚠ Arrived with release/beta on 2026-09-15, undeclared. `flows.write`, exactly like its
 # two siblings above: the clarify gate is a step in drafting, and a turn that clarifies
 # is on the way to writing a revision.
  ('GET','flows/:flowId'):'flows.read', ('GET','flows/:flowId/run-as'):'flows.read', ('PUT','flows/:flowId/run-as'):'flows.write', ('PATCH','flows/:flowId'):'flows.write',
 ('DELETE','flows/:flowId'):'flows.write',
 ('GET','flows/:flowId/integration'):'flows.read', ('GET','flows/:flowId/last-run'):'runs.read',
 ('GET','flows/:flowId/revisions'):'flows.read', ('POST','flows/:flowId/revisions'):'flows.write',
 ('DELETE','flows/:flowId/revisions/:revision'):'flows.approve',
 ('GET','flows/:flowId/revisions/:revision/steps'):'flows.read',
 ('POST','flows/:flowId/save-draft'):'flows.write', ('POST','flows/:flowId/inputs'):'flows.write',
 ('GET','flows/:flowId/phases'):'flows.read', ('GET','flows/:flowId/incomplete'):'flows.read', ('POST','flows/:flowId/incomplete/answer'):'flows.write', ('POST','flows/builder/understand'):'flows.write', ('POST','flows/builder/correct'):'flows.write', ('POST','flows/builder/build'):'flows.write', ('GET','flows/:flowId/canvas'):'flows.read', ('GET','flows/:flowId/choices'):'flows.read', ('POST','flows/canvas'):'flows.write', ('POST','flows/:flowId/canvas/act'):'flows.write', ('POST','flows/:flowId/canvas/save'):'flows.write',
 ('GET','flows/:flowId/expectation-suggestions'):'flows.read',
 ('POST','flows/:flowId/steps/:stepId/regenerate'):'flows.write',
 ('GET','flows/:flowId/export'):'flows.read', ('GET','flows/:flowId/export/kestra'):'flows.read',
 ('POST','flows/import/plan'):'flows.write', ('POST','flows/import'):'flows.write',
 ('POST','flows/:flowId/test-run'):'flows.run',
 ('POST','flows/:flowId/run'):'flows.run',
 ('GET','observability'):'runs.read',
 # Forge (pi-runtime): the builder's sessions — reading is flows.read, everything that builds or tests is flows.write.
 ('PATCH','pi-builder/chats/:chatId'):'flows.read',  # owner-or-admin decided in the route, like DELETE
 # Saved chats (0095): listing and reading their files is reading; deleting is owner-or-admin, decided in the route.
 ('GET','pi-builder/chats'):'flows.read',
 ('GET','pi-builder/chats/:chatId/files/:name'):'flows.read',
 ('DELETE','pi-builder/chats/:chatId'):'flows.read',
 # Building: removing a chat file, compacting the conversation and switching its mode all change the build.
 ('DELETE','pi-builder/sessions/:sessionId/files/:name'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/compact'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/mode'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/thinking'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/model'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/steer'):'flows.write',
 # Workflow references (2026-10-17): listing what can be referenced and the chat's references is reading; adding,
 # moving a pin and removing one change what the build learns from. Same-workspace and per-chat rules are in the service.
 ('GET','pi-builder/sessions/:sessionId/referenceable'):'flows.read',
 ('GET','pi-builder/sessions/:sessionId/references'):'flows.read',
 ('POST','pi-builder/sessions/:sessionId/references'):'flows.write',
 ('PATCH','pi-builder/sessions/:sessionId/references/:refId'):'flows.write',
 ('DELETE','pi-builder/sessions/:sessionId/references/:refId'):'flows.write',
 ('GET','pi-builder/sessions/:sessionId'):'flows.read',
 ('GET','pi-builder/sessions/:sessionId/events'):'flows.read',
 ('POST','pi-builder/runs'):'flows.write',
 ('POST','pi-builder/sessions'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/messages'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/answers'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/attachments'):'flows.write',
 ('DELETE','pi-builder/sessions/:sessionId/attachments/:name'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/verify'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/accept'):'flows.write',
 ('DELETE','pi-builder/sessions/:sessionId'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/bind-flow'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/stop'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/test-run'):'flows.write',
 ('POST','pi-builder/sessions/:sessionId/save-version'):'flows.write',
 # Duplicate copies the draft model into a new unarmed draft — same as create/import.
 ('POST','flows/:flowId/duplicate'):'flows.write',
 # ⚠ me/permissions — IDENTITY ONLY, and deliberately. Needing access in order to
 # discover that you have none is a bootstrap nobody can escape: a person refused
 # everywhere must still be able to load the page that explains why.
 ('GET','me/permissions'):'—  (own access; no permission required)',
 # roles.ts (8) — custom workspace roles, added by this feature.
 # ⚠ Reading a role is `members.read`, not `roles.write`: seeing which roles exist and
 # who holds them is part of knowing who has access. AUTHORING one is `roles.write`.
 # ASSIGNING one is `members.grant` — it changes what a person can do, which is the same
 # act as adding them to the workspace, reached by a different door.
 ('GET','roles'):'members.read', ('POST','roles'):'roles.write',
 ('GET','roles/:roleId'):'members.read', ('PATCH','roles/:roleId'):'roles.write',
 ('DELETE','roles/:roleId'):'roles.write',
 ('GET','roles/:roleId/members'):'members.read',
 ('POST','roles/:roleId/members'):'members.grant',
 ('DELETE','roles/:roleId/members/:subject'):'members.grant',
 # datasources.ts (24)
 ('GET','datasources'):'datasources.read', ('POST','datasources'):'datasources.write',
 ('GET','datasources/:dsId'):'datasources.read', ('PATCH','datasources/:dsId'):'datasources.write',
 ('DELETE','datasources/:dsId'):'datasources.write',
 ('POST','datasources/:dsId/test'):'datasources.write',
 ('GET','datasources/:dsId/schema'):'datasources.read',
 ('POST','datasources/:dsId/schema/refresh'):'datasources.write',
 ('GET','datasources/:dsId/sandbox'):'datasources.read',
 # ⚠ Added when release/beta merged in (2026-09-14). Its mock-data feature mounted two
 # new GETs and declared neither, so route-permissions.test.ts went red with "2 mounted
 # route(s) declare no permission and no exemption. A route nobody declared ships OPEN."
 # That is the guard doing exactly its job on an incoming branch that predates it.
 #
 # `datasources.read`, the same as every sibling read here (/schema, /sandbox, /queries,
 # /operations). ⚠ `/mock/rows` returns ROWS and that is still the right tier: fixture
 # rows are generated from the SCHEMA ONLY and are never production data (D-54 — the
 # model must never be shown real rows to imitate), so this is not a read of tenant data
 # and `realdata.use` is not the question being asked.
 ('GET','datasources/:dsId/mock'):'datasources.read',
 ('GET','datasources/:dsId/mock/rows'):'datasources.read',
 # ⚠ `datasources.WRITE`, unlike its two read siblings above — 2026-09-17. A rebuild
 # drops the fixture rows and regenerates them at a new version, which is a change to
 # this datasource, not a read of it. It is the same tier as /schema/refresh, which is
 # the closest analogue: both re-derive stored state from the live schema.
 ('POST','datasources/:dsId/mock/rebuild'):'datasources.write',
 # A SQLite datasource's database FILE, uploaded before the datasource that reads it is
 # registered. The same tier as registering one: the file IS that datasource's credential.
 ('POST','datasources/sqlite-files'):'datasources.write', ('GET','files'):'resources.read', ('POST','files'):'datasources.write', ('GET','files/:fileId/content'):'resources.read', ('DELETE','files/:fileId'):'datasources.write',
 ('GET','datasources/:dsId/queries'):'datasources.read',
 ('GET','datasources/:dsId/queries/:name'):'datasources.read',
 ('GET','datasources/:dsId/queries/:name/impact'):'datasources.read',
 ('POST','datasources/:dsId/queries'):'datasources.query.write',
 ('POST','datasources/:dsId/queries/check'):'datasources.query.write',
 ('POST','datasources/:dsId/queries/propose'):'datasources.query.write',
 ('PATCH','datasources/:dsId/queries/:name'):'datasources.query.write',
 ('DELETE','datasources/:dsId/queries/:name'):'datasources.query.write',
 ('GET','datasources/:dsId/operations'):'datasources.read',
 ('GET','datasources/:dsId/operations/:name'):'datasources.read',
 ('POST','datasources/:dsId/operations'):'datasources.query.write',
 ('POST','datasources/:dsId/operations/check'):'datasources.query.write',
 ('POST','datasources/:dsId/operations/propose'):'datasources.query.write',
 ('PATCH','datasources/:dsId/operations/:name'):'datasources.query.write',
 ('DELETE','datasources/:dsId/operations/:name'):'datasources.query.write',
 # triggers
 ('GET','flows/:flowId/triggers'):'flows.read',
 ('GET','flows/:flowId/triggers/:tid/fires'):'flows.read',
 ('POST','flows/:flowId/triggers'):'flows.arm',
 ('PATCH','flows/:flowId/triggers/:tid'):'flows.arm',
 ('DELETE','flows/:flowId/triggers/:tid'):'flows.arm',
 ('POST','flows/:flowId/triggers/:tid/fire'):'flows.run',
 # approvals (6)
 ('GET','flows/:flowId/approvals'):'approvals.read',
 ('GET','flows/:flowId/approvals/diff'):'approvals.read',
 ('POST','flows/:flowId/approvals'):'flows.approve',
 ('POST','flows/:flowId/approvals/revoke'):'flows.approve',
 ('POST','flows/:flowId/approvals/rearm'):'flows.approve',
 ('POST','flows/:flowId/approvals/recheck'):'flows.approve',
 # step-approvals
 ('GET','step-approvals'):'approvals.read',
 ('GET','step-approvals/execution/:executionId'):'approvals.read',
 ('POST','step-approvals/:approvalId/decide'):'approvals.decide',
 ('GET','approval-requests'):'approvals.read',
 # secrets / credentials
 ('GET','secrets'):'secrets.read', ('GET','secrets/audit'):'secrets.read',
 ('GET','secrets/:id/impact'):'secrets.read',
 ('POST','secrets'):'secrets.write', ('PATCH','secrets/:id'):'secrets.write',
 ('DELETE','secrets/:id'):'secrets.write',
 ('GET','credentials'):'secrets.read', ('POST','credentials'):'secrets.write',
 ('DELETE','credentials/:ref'):'secrets.write',
 # tools
 ('GET','tools'):'tools.read', ('GET','tools/:toolId'):'tools.read',
 ('POST','tools'):'tools.write', ('PATCH','tools/:toolId'):'tools.write',
 ('DELETE','tools/:toolId'):'tools.write', ('POST','tools/probe'):'tools.write',
 # templates
 ('GET','flow-templates'):'templates.read', ('GET','flow-templates/:id'):'templates.read',
 ('GET','fragment-candidates'):'templates.read',
 ('POST','flow-templates'):'templates.write',
 ('POST','flow-templates/from-bundle'):'templates.write',
 ('POST','flow-templates/:id/plan'):'templates.write',
 ('DELETE','flow-templates/:id'):'templates.write',
 ('POST','flow-templates/:id/instantiate'):'flows.write',
 # executions
 ('GET','flow-executions'):'runs.read', ('GET','flow-executions/:id'):'runs.read',
 ('GET','flow-executions/:id/emails'):'runs.read',
 # What a run called, from Foundry's own records (2026-10-30; was ops-api's call log): reading the run, so the same right.
 ('GET','flow-executions/:id/calls'):'runs.read',
 ('GET','flow-executions/:id/replay'):'runs.read',
 ('POST','flow-executions/:id/watch'):'runs.read',
 ('POST','flow-executions/:id/replay'):'runs.replay',
 # chat
 ('GET','flow-chat/threads'):'flows.read',
 ('GET','flow-chat/threads/:threadId/turns'):'flows.read',
 ('POST','flow-chat/threads'):'flows.write',
 ('POST','flow-chat/threads/:threadId/turns'):'flows.write',
 ('POST','flow-chat/threads/:threadId/flow'):'flows.write',
 # canvas mirrors
 ('GET','flows/:flowId/positions'):'flows.read', ('PUT','flows/:flowId/positions'):'flows.write',
 ('GET','flows/:flowId/flags'):'flows.read', ('PATCH','flows/:flowId/flags/:flagId'):'flows.write',
 # audit / resources / misc reads
 ('GET','audit-events'):'audit.read', ('GET','audit-events/export'):'audit.read',
 ('GET','resources'):'resources.read', ('GET','resources/:id'):'resources.read',
 ('GET','email-box'):'runs.read',
 # A held message's attachment, one file at a time (2026-10-13): reading the Email box's content, so the same right.
 ('GET','email-box/:sendId/attachments/:position'):'runs.read',
 # Never-delivered messages (held, refused, failed) in THIS workspace — never a delivered row (2026-10-12).
 ('DELETE','email-box/undelivered'):'flows.run',
 ('DELETE','email-box/messages/:id'):'flows.run',
 ('GET','search'):'search.read',
 ('GET','bootstrap'):'bootstrap.read',
 ('GET','next-fires'):'flows.read',
 ('GET','release-gates'):'gates.read',
 ('GET','flows/:flowId/release-gates'):'gates.read',
 ('GET','flows/:flowId/scenarios'):'scenarios.read',
 ('POST','steps/try'):'steps.try',
 ('GET','pins'):'flows.read', ('POST','pins/:flowId/toggle'):'flows.read',
 # catalogue
 ('GET','catalogue'):'catalogue.read', ('GET','catalogue/items'):'catalogue.read',
 ('POST','catalogue/access-requests'):'catalogue.write',
 ('POST','access-requests'):'catalogue.write',
 # incidents / break-glass
 ('GET','incidents'):'incidents.read', ('GET','incidents/:id'):'incidents.read',
 ('POST','incidents'):'incidents.write',
 ('GET','break-glass/active'):'breakglass.read',
 ('POST','break-glass'):'breakglass.activate',
 ('POST','break-glass/:id/revoke'):'breakglass.activate',
 # members
 ('GET','members'):'members.read', ('POST','members'):'members.grant',
 ('DELETE','members/:subject'):'members.grant',
 # per-member permission grants — the override surface (beta-1.1.0)
 ('GET','member-capabilities'):'members.read',
 ('PUT','member-capabilities/:subject/:capability'):'members.grant',
 ('DELETE','member-capabilities/:subject/:capability'):'members.grant',
 # release gates (beta-1.1.0)
 ('PATCH','release-gates/:gateId'):'gates.write',
 ('PATCH','flows/:flowId/release-gates/:gateId'):'gates.write',
 # the M3 concurrency budget (beta-1.1.0)
 ('GET','budget'):'budget.read',
 ('PUT','budget'):'budget.write',
 ('DELETE','budget'):'budget.write',
 # approvals figures (beta-1.1.0)
 ('GET','approval-requests/figures'):'approvals.read',
 # incident lifecycle (beta-1.1.0)
 ('PATCH','incidents/:id'):'incidents.write',
 # own data
 ('GET','me/attendance'):'—  (own data; subject from the token)',
 ('GET','me/exceptions'):'—  (own data; subject from the token)',
}

D = {
 # platform-roles.ts (8) + permissions.ts (1) — the platform tier, added by this feature.
 # ⚠ `GET /roles` and `/role-assignments` are `platform.users.read`, not
 # `platform.roles.write`: seeing which roles exist and who holds them is reading the
 # people list, not editing policy. Assigning is `platform.members.grant`, the same
 # permission that confers members.read + members.grant into every workspace (D-9).
 ('GET','/api/platform/roles'):'platform.users.read',
 ('POST','/api/platform/roles'):'platform.roles.write',
 ('PATCH','/api/platform/roles/:key'):'platform.roles.write',
 ('DELETE','/api/platform/roles/:key'):'platform.roles.write',
 ('GET','/api/platform/role-assignments'):'platform.users.read',
 ('GET','/api/platform/people'):'platform.users.read',  # admin simplify phase 3: People
 ('POST','/api/platform/role-assignments'):'platform.members.grant',
 ('DELETE','/api/platform/role-assignments/:subject/:roleKey'):'platform.members.grant',
 ('GET','/api/platform/audit'):'platform.audit.read',
 # ⚠ The catalogue is IDENTITY-ONLY. Needing a permission to discover what permissions
 # exist is a bootstrap nobody can escape, and the catalogue is the product's vocabulary
 # — identical on every deployment and already legible from any refusal message. What is
 # sensitive is who HOLDS what, and that is behind members.read.
 ('GET','/api/permissions/catalogue'):'requireIdentity',

 ('GET','/api/workspaces'):'requireIdentity + filtered by grant (FR-015)',
 ('GET','/api/workspaces/:id'):'flows.read in :id',
 ('GET','/api/workspaces/:id/manifest'):'flows.read in :id',
 ('POST','/api/workspaces'):'platform.workspaces.write',
 ('PATCH','/api/workspaces/:id'):'platform.workspaces.write',
 ('DELETE','/api/workspaces/:id'):'platform.workspaces.write',
 ('GET','/api/platform/users'):'platform.users.read',
 ('GET','/api/me'):'requireIdentity (unchanged)',
 # A person's own default chat mode (0097): no workspace in the question, the subject comes from the token.
 ('PUT','/api/me/forge-default-mode'):'— (own setting; subject from the token)',
 # The cost report (2026-10-26): spans workspaces, so no single workspace for a guard to ask about.
 ('GET','/api/reports/summary'):'— (the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those)',
 ('GET','/api/reports/runs'):'— (the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those)',
 ('GET','/api/reports/export'):'— (the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those)',
 ('GET','/api/reports/forecast'):'— (the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those)',
 ('POST','/api/reports/email'):'— (the report spans workspaces; `reports.read` is checked per workspace inside, and the answer is limited to those)',
 ('GET','/api/invitations'):'— (an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check)',
 ('POST','/api/invitations'):'— (an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check)',
 ('DELETE','/api/invitations/:id'):'— (an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check)',
 ('DELETE','/api/invitations/:id/workspaces/:workspaceId'):'— (an invitation spans workspaces; `members.grant` is checked per workspace inside, the platform role by the grantable check)',
 ('GET','/api/templates'):'requireIdentity (unchanged)',
 ('GET','/api/templates/:slug'):'requireIdentity (unchanged)',
 ('GET','/api/templates/suggestions'):'requireIdentity (unchanged)',
 ('GET','/api/engine/plugins'):'requireIdentity',
 ('GET','/api/engine/plugins/:name/credentials'):'requireIdentity',
 ('GET','/api/signals'):'platform.signals.read',
 ('GET','/api/observability'):'platform.signals.read',
# 2026-11-04: the builder-model routes are gone; /api/runtime-model/* is the one model connection.
 # The runtime model (AI models → Runtime), served by Foundry since 2026-10-30 (was /api/ops/llm/* through ops-api).
 ('GET','/api/runtime-model/provider'):'platform.toolmodel.read',
 ('POST','/api/runtime-model/models'):'platform.toolmodel.read',
 ('POST','/api/runtime-model/test'):'platform.toolmodel.read',
 ('PUT','/api/runtime-model/provider'):'platform.toolmodel.write',
 ('DELETE','/api/runtime-model/provider'):'platform.toolmodel.write',
 ('GET','/api/local-users'):'platform.localusers.write',
 ('POST','/api/local-users'):'platform.localusers.write',
 ('PATCH','/api/local-users/:id'):'platform.localusers.write',
 ('DELETE','/api/local-users/:id'):'platform.localusers.write',
 ('POST','/api/local-users/:id/password'):'platform.localusers.write',
 ('POST','/api/local-users/:id/active'):'platform.localusers.write',
 ('GET','/api/local-users/:id/access'):'platform.users.read',
 ('PUT','/api/local-users/:id/access/:workspaceId'):'platform.members.grant',
 ('DELETE','/api/local-users/:id/access/:workspaceId'):'platform.members.grant',
}

# ⚠ rbac-observability (2026-10-15) added these five to the GENERATED file by hand and not here, so the first
# regeneration after it reported them unmapped. Recorded here with the permissions they already carried.
W.update({('PUT','flows/:flowId/owner'):'content.read.others'})
# Plugins phase 9: the owner chooses who sees it, and switches on (or off) an automation that uses only their own things.
W.update({('GET','pi-builder/chats/:chatId'):'flows.read'})  # sharing-boundaries: read a chat without opening it
W.update({('GET','notifications'):'bootstrap.read', ('POST','notifications/read'):'bootstrap.read'})  # sharing-boundaries: one's own notices
W.update({('POST','flows/:flowId/review-request'):'flows.write', ('DELETE','flows/:flowId/review-request'):'flows.write'})  # sharing-boundaries: the owner asks a reviewer
W.update({('GET','flows/:flowId/activation'):'flows.read', ('PUT','flows/:flowId/activation'):'flows.run'})  # sharing-boundaries phase 3: Turn on for me
W.update({('GET','flows/:flowId/readiness'):'flows.read', ('PUT','flows/:flowId/my-account'):'flows.read'})  # sharing-boundaries phase 4: what it needs; which of MY accounts (changes nothing in the workflow)
W.update({('GET','projects'):'flows.read', ('POST','projects'):'flows.write', ('GET','projects/:projectId'):'flows.read',
 ('PATCH','projects/:projectId'):'flows.write', ('DELETE','projects/:projectId'):'flows.write',
 ('POST','projects/:projectId/members'):'flows.write', ('PUT','projects/:projectId/owner'):'flows.write',
 ('DELETE','projects/:projectId/members/:subject'):'flows.read'})  # sharing-boundaries phase 5: projects; the service decides owner-or-Admin, and anybody may leave
# Project files (0132): members read and add; the service answers NOT FOUND outside the project and decides who removes.
W.update({('GET','projects/:projectId/files'):'flows.read', ('POST','projects/:projectId/files'):'flows.write',
 ('GET','projects/:projectId/files/:fileId/content'):'flows.read', ('DELETE','projects/:projectId/files/:fileId'):'flows.write'})
W.update({('GET','flows/:flowId/move-preview'):'flows.read', ('POST','flows/:flowId/move'):'flows.write',
 ('GET','pi-builder/chats/:chatId/move-preview'):'flows.read', ('POST','pi-builder/chats/:chatId/move'):'flows.read'})  # sharing-boundaries phase 5: where it lives (a chat's mover is decided in the route, like its PATCH)
W.update({('PUT','flows/:flowId/visibility'):'flows.write', ('POST','flows/:flowId/switch-on'):'flows.write', ('POST','flows/:flowId/switch-off'):'flows.write'})
D.update({
 ('GET','/api/platform/access'):'platform.users.read',
 ('PUT','/api/generation/pricing'):'platform.generation.write',
 ('GET','/api/generation/pricing/spend'):'platform.signals.read',
 ('GET','/api/generation/pricing'):'— (signed in; a member sees their own cost, so the prices behind it are readable)',
})

# Declared API calls (plans/declared-api-calls-2026-10-29): reading is plugins.read; declaring, a pack and switching
# one off is plugins.enable.
W.update({('GET','plugins/:piece/calls'):'plugins.read', ('POST','plugins/:piece/calls'):'plugins.enable',
 ('POST','plugins/:piece/call-packs/:pack'):'plugins.enable', ('DELETE','plugins/:piece/calls/:name'):'plugins.enable'})

# For me (plans/personal-actions-2026-10-29): a person's own actions are plugins.read (the subject is the caller);
# whether members may switch them on for themselves is plugins.enable.
W.update({('GET','plugins/:piece/mine'):'plugins.read', ('PUT','plugins/:piece/mine/actions'):'plugins.read',
 ('POST','plugins/:piece/mine/call-packs/:pack'):'plugins.read', ('DELETE','plugins/:piece/mine/calls/:name'):'plugins.read',
 ('PUT','plugins/:piece/personal-use'):'plugins.enable'})

# Restricted workspaces (plans/restricted-workspaces-2026-10-29). Restricting is members.grant, narrowed in the handler to
# the workspace's OWN admins; emergency access is started outside the workspace (the guard would resolve a super admin
# to nothing inside it) and read/ended by its admins with members.read, narrowed in the service.
W.update({('PUT','restricted'):'members.grant', ('GET','emergency-access'):'members.read', ('POST','emergency-access/:accessId/end'):'members.read'})
D.update({('POST','/api/platform/emergency-access'):'platform.workspaces.write'})

# Connectors (plans/plugins-2026-10-27, 2026-10-27). Looking is plugins.read; connecting a service, rotating or
# testing its credential and choosing its actions is plugins.enable. Installing is deployment-wide.
W.update({
 ('GET','plugins'):'plugins.read', ('GET','plugins/marketplace'):'plugins.read',
 ('POST','plugins/:piece/connections'):'plugins.read', ('PUT','plugins/:piece/actions'):'plugins.enable',
 # A person may manage their OWN connection ("as me", phase 4) with plugins.read; the handler still requires
 # plugins.enable for a WORKSPACE connection (routes/plugins.ts canEnable) — it only narrows what this allows.
 ('PATCH','plugins/connections/:connectionId'):'plugins.read',
 ('POST','plugins/connections/:connectionId/test'):'plugins.read',
 ('DELETE','plugins/connections/:connectionId'):'plugins.read',
 ('POST','plugins/:piece/oauth/start'):'plugins.read', ('POST','pi-builder/sessions/:sessionId/proposals/:proposalId'):'plugins.read', ('POST','pi-builder/sessions/:sessionId/accounts/clear'):'plugins.read', ('POST','plugins/oauth/callback'):'plugins.read',
})
D.update({
 ('GET','/api/plugins/marketplace'):'platform.plugins.install', ('GET','/api/plugins/installs'):'platform.plugins.install',
 ('POST','/api/plugins/installs'):'platform.plugins.install', ('PUT','/api/plugins/installs/:piece/hosts'):'platform.plugins.install',
 ('POST','/api/plugins/installs/:piece/upgrade'):'platform.plugins.install', ('DELETE','/api/plugins/installs/:piece'):'platform.plugins.install',
 ('GET','/api/plugins/oauth-apps/:piece'):'platform.plugins.install', ('PUT','/api/plugins/oauth-apps/:piece'):'platform.plugins.install',
 ('DELETE','/api/plugins/oauth-apps/:piece'):'platform.plugins.install',
})

EX = {
 ('POST','/api/steps/tool'):'execution token', ('POST','/api/steps/files'):'execution token', ('GET','/api/steps/files/workspace/:name'):'execution token', ('POST','/api/steps/approval'):'execution token',
 ('POST','/api/steps/datasource'):'execution token', ('POST','/api/steps/query'):'execution token',
 ('POST','/api/steps/llm'):'execution token', ('POST','/api/steps/http'):'execution token',
 ('POST','/api/executions/begin'):'Kestra callback secret',
 ('POST','/api/executions/:id/complete'):'execution token',
 ('POST','/api/executions/:id/steps/:stepId/result'):'execution token',
 ('POST','/api/executions/:id/pause'):'execution token',
 ('GET','/api/executions/:id'):'execution token',
 ('GET','/api/health'):'open liveness probe', ('GET','/api/health/strict'):'open liveness probe',
 ('POST','/api/mail/send'):'requireMailKey',
 ('POST','/api/web/fetch'):'requireWebKey',
 ('POST','/api/llm/complete'):'requireLlmKey',
 ('GET','/api/test-oracle/screening'):'test surface; blocked at the proxy',
 ('POST','/api/triggers/:token/webhook'):'public receiver, token in URL',
 ('POST','/api/triggers/:token/api'):'public receiver, token in URL + Bearer',
 ('POST','/api/local-auth/verify'):'answers before anybody has a session',
 # Forge's own tools, called from inside a conversation with that conversation's key — checked in the service.
 ('POST','/api/forge/data'):"Forge's per-conversation tool key (assistant mode, checked in the service)",
 ('POST','/api/forge/file'):"Forge's per-conversation tool key (a workspace File opened while building)",
 ('POST','/api/forge/fetch'):"Forge's per-conversation tool key (a public web address read while building; web access checked in the service)",
 ('POST','/api/forge/plugin'):"Forge's per-conversation tool key (assistant mode; a connector READ — a write is refused in the service)",
 ('POST','/api/forge/propose'):"Forge's per-conversation tool key (Forge Agent; PROPOSES a change, performs nothing — the person's click does)",
 ('POST','/api/forge/actions'):"Forge's per-conversation tool key (Forge Agent; lists the connected services' actions, changes nothing)",
 ('POST','/api/forge/propose-setting'):"Forge's per-conversation tool key (Forge Agent; PROPOSES switching an action on or off, applies nothing — the person's click does)",
}

ws=[r for r in rows if r[1].startswith(WS)]
dep=[r for r in rows if not r[1].startswith(WS) and (r[0],r[1]) not in EX]
ex=[r for r in rows if (r[0],r[1]) in EX]
print(f"rows={len(rows)} ws={len(ws)} dep={len(dep)} exempt={len(ex)}")
missW=[(m,p[len(WS):]) for m,p,_ in ws if (m,p[len(WS):]) not in W]
missD=[(m,p) for m,p,_ in dep if (m,p) not in D]
staleW=[k for k in W if k not in {(m,p[len(WS):]) for m,p,_ in ws}]
staleD=[k for k in D if k not in {(m,p) for m,p,_ in dep}]
print("UNMAPPED ws:",missW); print("UNMAPPED dep:",missD)
print("STALE ws:",staleW); print("STALE dep:",staleD)
json.dump({'ws':[[m,p,g] for m,p,g in ws],'dep':[[m,p,g] for m,p,g in dep],'ex':[[m,p,g] for m,p,g in ex],
           'W':{f"{k[0]} {k[1]}":v for k,v in W.items()},
           'D':{f"{k[0]} {k[1]}":v for k,v in D.items()},
           'EX':{f"{k[0]} {k[1]}":v for k,v in EX.items()}}, open(SP+'/map.json','w'))
