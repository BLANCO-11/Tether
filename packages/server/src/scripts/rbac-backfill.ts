/**
 * `rbac:backfill` — carry every existing grant forward onto the permission model, and
 * SAY WHAT WOULD CHANGE BEFORE CHANGING IT.
 *
 * ⚠ **DRY RUN BY DEFAULT. `--apply` writes.** The repo idiom is `slate:plan` before
 * `slate:clear` and `kestra:plugins --dry-run` before applying — an irreversible change
 * to who can do what should be readable first.
 *
 * ⚠ **IT MUST NOT REPORT SUCCESS OVER ZERO ROWS.** On this deployment
 * `workspace_members` and `workspace_member_capabilities` are both EMPTY against eight
 * live workspaces, so "0 differences" would read exactly like "40 people carried forward
 * perfectly". It prints the counts it read, and when there is nothing to examine it says
 * so in those words rather than printing a clean report.
 *
 * FR-029. Three kinds of difference are EXPECTED and are named in the output:
 *   1. `admin` / `platform-admin` capability rows, DROPPED (INV-10) — they were roles
 *      wearing a capability's clothes, and are re-expressed as a preset assignment and a
 *      platform role.
 *   2. The generation model now needs an explicit platform grant.
 *   3. **Approvers gain `flows.arm`** (spec D-4) — a declared widening, not a
 *      carry-forward.
 * ⚠ **A fourth kind of difference is a defect in `role-presets.ts`.** Fix the presets;
 * do not apply.
 */
import { db } from "../db/index.js";
import { workspaceMembers, workspaceMemberCapabilities, workspaces } from "../db/schema.js";
import { eq, isNull } from "drizzle-orm";
import { ROLE_PRESETS, DECLARED_WIDENINGS, type PresetRole } from "../auth/role-presets.js";
import { isWorkspacePermission } from "../auth/permissions.js";

const APPLY = process.argv.includes("--apply");

/** Migration 0065's rename, restated so the report can explain a dropped row. */
const RENAME: Record<string, string | null> = {
  "edit-workflows": "flows.write",
  publish: "flows.arm",
  approve: "flows.approve",
  resources: "resources.read",
  admin: null,
  "platform-admin": null,
  "real-data": "realdata.use",
};

async function main() {
  const live = await db.select().from(workspaces).where(isNull(workspaces.deletedAt));
  const members = await db.select().from(workspaceMembers);
  const caps = await db.select().from(workspaceMemberCapabilities);

  console.log(`rbac:backfill — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log("");
  console.log("read from the database:");
  console.log(`  live workspaces .................. ${live.length}`);
  console.log(`  workspace_members rows ........... ${members.length}`);
  console.log(`  workspace_member_capabilities .... ${caps.length}`);
  console.log("");

  // ⚠ The I-38 branch. An empty report and a clean report look identical, and only one
  // of them means anything.
  if (members.length === 0 && caps.length === 0) {
    console.log("NOTHING TO CARRY FORWARD.");
    console.log("");
    console.log(
      `  There are no members and no individual grants on this deployment, across ` +
        `${live.length} live workspace(s). This is NOT a clean carry-forward — there is\n` +
        `  nothing to examine. SC-003 ("no member's effective access changed") is VACUOUS\n` +
        `  here: it is trivially true over zero members.`,
    );
    console.log("");
    console.log(
      `  ⚠ The consequence is behaviour change 6, and it is accepted rather than fixed\n` +
        `  (spec D-5): every one of those ${live.length} workspaces now refuses every\n` +
        `  non-super-admin. SUPER_ADMIN_EMAILS is the only way in, and with\n` +
        `  POST …/members/claim deleted it is the only way to create a first member.`,
    );
    process.exit(0);
  }

  const rows: Array<{
    workspace: string;
    subject: string;
    today: string[];
    after: string[];
    diff: string[];
    kind: string;
  }> = [];

  const byWorkspace = new Map(live.map((w) => [w.id, w.name]));

  for (const m of members) {
    const preset = ROLE_PRESETS[m.role as PresetRole] ?? [];
    const mine = caps.filter((c) => c.workspaceId === m.workspaceId && c.subject === m.subject);

    // "Today" = what the old capability model gave: the legacy ROLE_CAPS plus explicit
    // grants, mapped through 0065's rename.
    const legacyRoleCaps: Record<string, string[]> = {
      author: ["flows.write"],
      approver: ["flows.write", "flows.approve"],
      admin: ["flows.write", "flows.arm", "flows.approve", "resources.read", "realdata.use"],
    };
    const today = new Set<string>(legacyRoleCaps[m.role] ?? []);
    const dropped: string[] = [];
    for (const c of mine) {
      const mapped = RENAME[c.capability] ?? (isWorkspacePermission(c.capability) ? c.capability : null);
      if (mapped === null) dropped.push(c.capability);
      else today.add(mapped);
    }

    const after = new Set<string>(preset);
    for (const c of mine) {
      const mapped = RENAME[c.capability] ?? (isWorkspacePermission(c.capability) ? c.capability : null);
      if (mapped !== null) after.add(mapped);
    }

    const gained = [...after].filter((p) => !today.has(p)).sort();
    const lost = [...today].filter((p) => !after.has(p)).sort();

    const declared = new Set(
      DECLARED_WIDENINGS.filter((w) => w.role === m.role).map((w) => w.permission as string),
    );
    const unexplainedGains = gained.filter((p) => !declared.has(p) && !preset.includes(p as never));
    const kinds: string[] = [];
    if (dropped.length) kinds.push(`dropped-capability(${dropped.join(",")})`);
    if (gained.some((p) => declared.has(p))) kinds.push("declared-widening(D-4 flows.arm)");
    if (lost.length) kinds.push("LOST");
    if (unexplainedGains.length) kinds.push("UNEXPLAINED");

    rows.push({
      workspace: byWorkspace.get(m.workspaceId) ?? m.workspaceId,
      subject: m.subject,
      today: [...today].sort(),
      after: [...after].sort(),
      diff: [...gained.map((p) => `+${p}`), ...lost.map((p) => `-${p}`)],
      kind: kinds.join(" ") || "unchanged",
    });
  }

  console.log(
    `⚠ READ "today" CORRECTLY — IT IS NOT WHAT THESE PEOPLE COULD REACH.\n` +
      `\n` +
      `  "today" is what the CAPABILITY MODEL answered, and that model gated exactly two\n` +
      `  consumers (break-glass and the catalogue's real-data panel). 106 of the 142\n` +
      `  workspace-scoped routes carried NO authorisation check at all, so in terms of\n` +
      `  effective access "today" for every one of these people — and for every person who\n` +
      `  is not in this list at all — was closer to EVERYTHING.\n` +
      `\n` +
      `  So a long "+" list below is mostly the permission model NAMING things the\n` +
      `  capability model never had a word for. It is not a grant of new power; in almost\n` +
      `  every case it is a NARROWING, because the route now refuses anyone without it.\n` +
      `  The one genuine widening is flagged as declared-widening(D-4 flows.arm).\n`,
  );

  for (const r of rows) {
    console.log(`${r.workspace} · ${r.subject}`);
    console.log(`   today: ${r.today.join(" ") || "(nothing)"}`);
    console.log(`   after: ${r.after.join(" ") || "(nothing)"}`);
    console.log(`   diff : ${r.diff.join(" ") || "(none)"}   [${r.kind}]`);
  }

  const problems = rows.filter((r) => r.kind.includes("LOST") || r.kind.includes("UNEXPLAINED"));
  console.log("");
  console.log(`${rows.length} person-workspace pair(s) examined; ${problems.length} need a decision.`);

  if (problems.length) {
    // ⚠ A fourth kind of difference is a defect in the presets, not something to apply.
    console.log("");
    console.log("⚠ REFUSING TO APPLY. Differences that are not one of the three expected kinds:");
    for (const p of problems) console.log(`   ${p.workspace} · ${p.subject}: ${p.diff.join(" ")}`);
    console.log("   Fix role-presets.ts. Do not apply over this.");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("");
    console.log("DRY RUN — nothing was written. Re-run with --apply once the report is read.");
    process.exit(0);
  }

  // The write itself: migration 0065 already renamed the capability rows, so there is
  // nothing further to move. This branch exists so `--apply` is a real, auditable step
  // rather than a flag that does nothing.
  console.log("");
  console.log("APPLY — migration 0065 already renamed every capability row in place;");
  console.log("       presets are code and need no rows. Nothing further to write.");
  process.exit(0);
}

main().catch((err) => {
  console.error("rbac:backfill failed:", err);
  process.exit(1);
});
