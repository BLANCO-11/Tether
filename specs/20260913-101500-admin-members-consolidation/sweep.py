#!/usr/bin/env python3
"""
The perturbation sweep for the admin-members-consolidation feature.

⚠ A PERTURBATION WHOSE ANCHOR DOES NOT MATCH DID NOT RUN, AND ITS GREEN RESULT IS
MEANINGLESS — NOT A PASS. That has happened twice in this repo already, so this script
reports n fired / n attempted, and an unmatched anchor is its own outcome (NOT RUN),
never silently counted as anything. Run from `packages/client`.
"""
import subprocess
import sys

PERTURBATIONS = [
    ("P01", 1, "restore the dead capability gate",
     "src/app/(app)/admin/members/page.tsx",
     "  const nothingOffered = membersRead.denied && membersGrant.denied && localUsersWrite.denied;",
     '  const nothingOffered = !me.data.superAdmin && !(me.data as { capabilities?: string[] }).capabilities?.includes("admin");',
     ["src/app/(app)/admin/members"]),

    ("P02", 2, "MultiSelect never sets indeterminate",
     "src/components/ui/MultiSelect.tsx",
     "    if (selectAllRef.current) selectAllRef.current.indeterminate = someChosen;",
     "    if (selectAllRef.current) selectAllRef.current.indeterminate = false;",
     ["src/components/ui/MultiSelect.test.tsx"]),

    ("P03", 2, "Drawer uses a CONSTANT title id (Modal's bug)",
     "src/components/ui/Drawer.tsx",
     "  const titleId = useId();",
     '  const titleId = "drawer-title";',
     ["src/components/ui/Drawer.test.tsx"]),

    # ⚠ RE-ANCHORED 2026-09-15. The tier filter moved into `groupByPreset` when the
    # permissions were banded, so the old anchor stopped matching — which this script
    # reports as NOT RUN rather than as a pass, which is the whole reason it says so.
    ("P04", 3, "INV-9: platform permissions rendered in the drawer",
     "src/components/access/permission-catalogue.ts",
     "  const all = (catalogue?.permissions ?? []).filter((p) => p.tier === tier).map((p) => p.key);",
     "  const all = (catalogue?.permissions ?? []).map((p) => p.key);",
     ["src/components/admin/MemberDrawer.test.tsx"]),

    ("P04b", 3, "INV-9: the drawer asks for the PLATFORM tier",
     "src/components/admin/MemberDrawer.tsx",
     '  const groups = useMemo(() => groupByPreset(catalogue.data, "workspace"), [catalogue.data]);',
     '  const groups = useMemo(() => groupByPreset(catalogue.data, "platform"), [catalogue.data]);',
     ["src/components/admin/MemberDrawer.test.tsx"]),

    # ── the bands are a disclosure now (2026-09-15) ──────────────────────────────────
    ("P21", 8, "the band body renders whether or not the band is open",
     "src/components/access/PermissionBand.tsx",
     '      {open && (\n        <div id={bodyId} className="ml-5 mt-2">\n          {children}\n        </div>\n      )}',
     '      <div id={bodyId} className="ml-5 mt-2">\n        {children}\n      </div>',
     ["src/components/admin/MemberDrawer.test.tsx", "src/components/access/RoleEditor.test.tsx"]),

    ("P22", 8, "a closed head drops its count — detail removed AND evidence with it",
     "src/components/access/PermissionBand.tsx",
     '        <span className="ml-auto shrink-0 text-xs text-muted">{summary}</span>',
     '        {open && <span className="ml-auto shrink-0 text-xs text-muted">{summary}</span>}',
     ["src/components/admin/MemberDrawer.test.tsx", "src/components/access/RoleEditor.test.tsx"]),

    ("P23", 8, "a closed band swallows its hint too",
     "src/components/access/PermissionBand.tsx",
     '      <p className="ml-5 mt-0.5 text-xs text-muted">{hint}</p>',
     '      {open && <p className="ml-5 mt-0.5 text-xs text-muted">{hint}</p>}',
     ["src/components/admin/MemberDrawer.test.tsx", "src/components/access/RoleEditor.test.tsx"]),

    ("P24", 8, "the disclosure does not declare its state",
     "src/components/access/PermissionBand.tsx",
     "        aria-expanded={open}",
     "        aria-expanded={false}",
     ["src/components/admin/MemberDrawer.test.tsx"]),

    ("P25", 8, "every band starts OPEN (the editor's chosen-only rule gone)",
     "src/components/access/RoleEditor.tsx",
     "              defaultOpen={picked > 0}",
     "              defaultOpen={true}",
     ["src/components/access/RoleEditor.test.tsx"]),

    ("P05", 3, "INV-3: a custom role in the preset dropdown",
     "src/components/admin/MemberDrawer.tsx",
     'const ROLES: WorkspaceRole[] = ["author", "approver", "admin"];',
     'const ROLES = ["author", "approver", "admin", "incident-responder"] as WorkspaceRole[];',
     ["src/components/admin/MemberDrawer.test.tsx"]),

    ("P06", 3, "INV-6: the role-is-not-identity footer removed",
     "src/components/admin/MembersPanel.tsx",
     "          <p>{ACCESS_IS_NOT_IDENTITY}</p>",
     "          <p>Members of this workspace.</p>",
     ["src/components/admin/MemberDrawer.test.tsx"]),

    ("P07", 3, "the drawer opens itself on the first member",
     "src/components/admin/MembersPanel.tsx",
     "    () => (members.data ?? []).find((m) => m.subject === openSubject) ?? null,",
     "    () => (members.data ?? []).find((m) => m.subject === openSubject) ?? (members.data ?? [])[0] ?? null,",
     ["src/components/admin/MemberDrawer.test.tsx"]),

    ("P08", 3, "rows are not keyboard reachable",
     "src/components/admin/MembersPanel.tsx",
     "                      tabIndex={0}",
     "                      tabIndex={-1}",
     ["src/components/admin/MemberDrawer.test.tsx"]),

    ("P09", 4, "bulk assign ignores the selection and submits to all",
     "src/components/admin/BulkAssignPanel.tsx",
     "    for (const id of checked) {",
     "    for (const id of workspaces.map((w) => w.id)) {",
     ["src/components/admin/BulkAssignPanel.test.tsx"]),

    ("P10", 4, "one result instead of per-workspace results",
     "src/components/admin/BulkAssignPanel.tsx",
     "    setResults(out);",
     "    setResults(out.slice(0, 1));",
     ["src/components/admin/BulkAssignPanel.test.tsx"]),

    ("P11", 4, "zero selected can submit",
     "src/components/admin/BulkAssignPanel.tsx",
     '    email.trim() !== "" && subject.trim() !== "" && checked.length > 0 && !busy;',
     '    email.trim() !== "" && subject.trim() !== "" && !busy;',
     ["src/components/admin/BulkAssignPanel.test.tsx"]),

    ("P12", 4, "re-seed on every change (clobbers a deselection)",
     "src/components/admin/BulkAssignPanel.tsx",
     "    if (seeded.current || workspaces.length === 0) return;",
     "    if (workspaces.length === 0) return;",
     ["src/components/admin/BulkAssignPanel.test.tsx"]),

    ("P13", 4, "never seed (a late list stays unselected)",
     "src/components/admin/BulkAssignPanel.tsx",
     "    seeded.current = true;\n    setChecked(workspaces.map((w) => w.id));",
     "    seeded.current = true;",
     ["src/components/admin/BulkAssignPanel.test.tsx"]),

    ("P14", 5, "the tab is React state only, not the URL",
     "src/app/(app)/admin/members/page.tsx",
     '  const tab: TabKey = TABS.some((t) => t.key === rawTab) ? (rawTab as TabKey) : "members";',
     '  const [tab] = useState<TabKey>("members");',
     ["src/components/admin/MemberTabs.test.tsx"]),

    ("P15", 5, "INV-1: the Platform tab gated on useCan",
     "src/app/(app)/admin/members/page.tsx",
     '  const platformUsersRead = useCanPlatform("platform.users.read");',
     '  const platformUsersRead = useCan("platform.users.read");',
     ["src/components/admin/MemberTabs.test.tsx"]),

    ("P16", 5, "an unrecognised ?tab= is used verbatim",
     "src/app/(app)/admin/members/page.tsx",
     '  const tab: TabKey = TABS.some((t) => t.key === rawTab) ? (rawTab as TabKey) : "members";',
     '  const tab: TabKey = (rawTab ?? "members") as TabKey;',
     ["src/components/admin/MemberTabs.test.tsx"]),

    ("P17", 5, "an unreadable platform check HIDES the tab",
     "src/app/(app)/admin/members/page.tsx",
     "  const showPlatformTab = !platformUsersRead.denied;",
     "  const showPlatformTab = platformUsersRead.allowed;",
     ["src/components/admin/MemberTabs.test.tsx"]),

    ("P18", 6, "/organization loses its could-not-be-checked state",
     "src/app/(app)/organization/page.tsx",
     "  if (me.error || !me.data) {",
     "  if (false) {",
     ["src/app/(app)/organization"]),

    ("P19", 6, "the two super-admin refusals collapse into one sentence",
     "src/app/(app)/organization/page.tsx",
     "            {me.data.superAdminConfigured ? NOT_SUPER_ADMIN : NO_SUPER_ADMIN_CONFIGURED}",
     "            {NOT_SUPER_ADMIN}",
     ["src/app/(app)/organization"]),

    ("P20", 6, "a members panel comes back to /organization",
     "src/app/(app)/organization/page.tsx",
     '      <Zone name="content">',
     '      <Zone name="content"><h2>Members</h2>',
     ["src/app/(app)/organization"]),
]

fired, not_run, missed = [], [], []
for pid, phase, desc, path, old, new, targets in PERTURBATIONS:
    src = open(path).read()
    if old not in src:
        not_run.append((pid, phase, desc, path))
        print(f"{pid}  NOT RUN   (anchor did not match in {path}) — {desc}", flush=True)
        continue
    backup = src
    open(path, "w").write(src.replace(old, new, 1))
    try:
        r = subprocess.run(["npx", "vitest", "run", *targets], capture_output=True, text=True)
        red = r.returncode != 0
    finally:
        open(path, "w").write(backup)
    (fired if red else missed).append((pid, phase, desc))
    print(f"{pid}  {'FIRED' if red else '*** MISSED ***'}  [phase {phase}] {desc}", flush=True)

print()
print(f"SWEEP: {len(fired)} fired / {len(PERTURBATIONS)} attempted")
print(f"       {len(not_run)} NOT RUN (anchor did not match — NOT a pass)")
print(f"       {len(missed)} MISSED (the control does not fire)")
for pid, phase, desc in missed:
    print(f"       MISSED {pid} [phase {phase}] {desc}")
for pid, phase, desc, path in not_run:
    print(f"       NOT RUN {pid} [phase {phase}] {desc} — {path}")
sys.exit(1 if (missed or not_run) else 0)
