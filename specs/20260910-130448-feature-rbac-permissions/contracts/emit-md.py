import json,sys,collections
SP=sys.argv[1]
d=json.load(open(SP+'/map.json'))
sg=json.load(open(SP+'/source-guards.json'))
W=d['W']; D=d['D']; EX=d['EX']
WS='/api/workspaces/:workspaceId/'

# app.ts mount prefixes (relative to WS) -> source file
MOUNTS=[('flows/:flowId/triggers','triggers.ts'),('flows/:flowId/approvals','approvals.ts'),
 ('flows/:flowId/positions','flow-positions.ts'),('flows/:flowId/flags','flow-flags.ts'),
 ('flows/:flowId/phases','flow-phases.ts'),('flows/:flowId/release-gates','release-gates.ts'),
 ('flows/:flowId/scenarios','flow-scenarios.ts'),
 ('flows','flows.ts'),('datasources','datasources.ts'),('flow-templates','flow-templates.ts'),
 ('fragment-candidates','flow-templates.ts'),('secrets','workspace-secrets.ts'),('tools','tools.ts'),
 ('flow-executions','flow-executions.ts'),('flow-chat','flow-chat.ts'),('catalogue','catalogue.ts'),
 ('access-requests','catalogue.ts'),('step-approvals','step-approvals.ts'),('members','members.ts'),('member-capabilities','member-capabilities.ts'),('budget','budgets.ts'),
 ('incidents','incidents.ts'),('credentials','credentials.ts'),('break-glass','break-glass.ts'),
 ('resources','resources.ts'),('pins','pins.ts'),('audit-events','audit-events.ts'),
 ('me','attendance.ts'),('steps','step-try.ts'),('search','search.ts'),
 ('release-gates','release-gates.ts'),('next-fires','next-fires.ts'),('email-box','email-box.ts'),
 ('bootstrap','bootstrap.ts'),('approval-requests','approval-requests.ts')]

def mount_of(tail):
    for pre,f in MOUNTS:
        if tail==pre or tail.startswith(pre+'/'): return pre,f
    raise SystemExit('unmounted '+tail)

# guards from source, keyed by (file, method, path-after-mount)
G={}
for o in sg:
    G[(o['file'],o['method'],o['path'] if o['path'] else '/')]=o['guards']

def today(f,m,tail,pre,stackguard):
    sub='/'+tail[len(pre):].lstrip('/') if tail!=pre else '/'
    g=G.get((f,m,sub)) or G.get((f,m,sub.rstrip('/') or '/')) or []
    lab=[]
    for x in g:
        if x.startswith('role:'): lab.append(x[5:])
        elif x=='requireSuperAdmin': lab.append('super admin')
        elif x=='provenance': lab.append('+provenance')
        elif x=='notRunRequester': lab.append('+not-requester')
    if lab: return '**G** · '+', '.join(lab)
    if stackguard!='-': return 'I'
    return '—'

groups=collections.defaultdict(list)
for m,p,g in d['ws']:
    tail=p[len(WS):]
    pre,f=mount_of(tail)
    groups[(pre,f)].append((m,tail,g))

o=[]
o.append("""# Contract — the route → permission map

**Feature**: Feature-level RBAC · **Regenerated**: 2026-09-12 against the live Express stack

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

**The whole surface is 186 mounted `(method, path)` pairs**: **132** workspace-scoped,
**38** deployment-level, **16** exempt. The earlier figures (132 / 36 / 11 = 179) were
right only on the first.

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
""")
order=[p for p,_ in MOUNTS]
for pre,f in sorted(groups,key=lambda k: order.index(k[0])):
    items=sorted(groups[(pre,f)],key=lambda x:(x[1],x[0]))
    guarded=sum(1 for m,t,g in items if G.get((f,m,('/'+t[len(pre):].lstrip('/')) if t!=pre else '/')))
    o.append(f"\n### `/{pre}` — `{f}` — {len(items)} handlers, {guarded} guarded today, **{len(items)-guarded} newly guarded**\n")
    o.append("| Method | Path | Permission | Today |")
    o.append("| :--- | :--- | :--- | :--- |")
    for m,t,g in items:
        sub=t[len(pre):] or '/'
        o.append(f"| {m} | `/{pre}{sub if sub!='/' else ''}` | `{W[f'{m} {t}']}` | {today(f,m,t,pre,g)} |")
o.append("\n---\n\n## Deployment-level — 38 handlers\n")
o.append("| Method | Path | Guard after | Today |")
o.append("| :--- | :--- | :--- | :--- |")
for m,p,g in sorted(d['dep'],key=lambda x:(x[1],x[0])):
    o.append(f"| {m} | `{p}` | `{D[f'{m} {p}']}` | {'G' if 'requireSuperAdmin' in g else ('I' if g!='-' else '—')} |")
o.append("\n---\n\n## Exempt — 16 handlers that must NOT change (FR-005)\n")
o.append("Recorded as *decided*, not missing, so the completeness check treats them as answered.\n")
o.append("| Method | Path | Authenticated by |")
o.append("| :--- | :--- | :--- |")
for m,p,g in sorted(d['ex'],key=lambda x:(x[1],x[0])):
    o.append(f"| {m} | `{p}` | {EX[f'{m} {p}']} |")
open(SP+'/route-permissions.body.md','w').write("\n".join(o)+"\n")
print("ok")
