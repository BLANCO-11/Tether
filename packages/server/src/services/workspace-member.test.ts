import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { workspaceMemberService, BOOTSTRAP_GRANT } from "./workspace-member.service.js";
import { config } from "../config/index.js";
import { requirementFor } from "../auth/route-permissions.js";

/**
 * Workspace roles — archive/GAPS.md §1.1.
 *
 * Three things are asserted, and the third is the one that would rot:
 *
 *  1. **The refusals fire**, each with its own reason — an unclaimed workspace,
 *     a non-member and an under-privileged member are three different problems
 *     and one shared 403 would send two of those people to the wrong fix.
 *  2. **The positive control passes.** An `approver` is allowed. Without it,
 *     "refuse everything" scores 100% — and refusing everything is precisely
 *     what the fail-closed empty-workspace rule does by default, so this suite
 *     would otherwise be green over a role model that never grants anything.
 *  3. **Every route that reaches an approval decision carries the guard**,
 *     asserted by reading the route tree. A new approval route that forgot it
 *     would work perfectly and report nothing — the shape this repo has been
 *     bitten by twice (a secret with a second silent reader, `authorOf` as the one
 *     minter of `user`).
 */

const ROUTES_DIR = new URL("../routes/", import.meta.url).pathname;
const ALICE = { subject: "oid-alice", email: "alice@acme-hr.example" };
const BOB = { subject: "oid-bob", email: "bob@acme-hr.example" };

/**
 * ⚠ Its OWN workspace, created here and deleted after.
 *
 * The first version took `(await workspaceRepo.list())[0]`, which passed alone
 * and failed nine ways in the full suite: `list()` is newest-first, so it
 * returned the temporary workspace `workspace-slug.test.ts` creates, and that
 * suite deleted it out from under this one mid-run — every insert then failed
 * the foreign key. Sharing a deployment's rows between parallel suites makes a
 * test depend on file scheduling, which is the kind of flake that gets a suite
 * retried rather than read.
 */
const ws = await workspaceRepo.create({
  name: "gaps-1.1 role tests",
  tenantSlug: "roletest",
  slug: `roletest-${Date.now().toString(36)}`,
});
const reachable = !!ws;

async function wipe() {
  if (ws) await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id));
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  if (ws) await db.delete(workspacesTable).where(eq(workspacesTable.id, ws.id));
});

describe.skipIf(!reachable)("an unclaimed workspace refuses, rather than allowing", () => {
  it("refuses an approver check with a 403 that says how to fix it", async () => {
    // ⚠ The tempting shape is "no members configured ⇒ allow". That is a control
    // which turns itself off exactly where it was never set up, i.e. everywhere
    // it matters.
    const v = await workspaceMemberService.check(ws!.id, ALICE.subject, "approver");
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.status).toBe(403);
      expect(v.reason).toMatch(/no members yet/);
      // ⚠ The refusal must still name the NEXT STEP, and the next step changed:
      // `claim` is deleted, so an unconfigured deployment is told to set the
      // allowlist and a configured one is told who can assign them. A refusal
      // with no way out reads as a broken product.
      expect(v.reason, "the refusal must name the next step").toMatch(
        config.superAdminConfigured ? /super admin/i : /SUPER_ADMIN_EMAILS/,
      );
      expect(v.reason, "it must not name the deleted claim endpoint").not.toMatch(/members\/claim/);
    }
  });

  it("refuses an anonymous caller with 401, not 403 — a different problem", async () => {
    const v = await workspaceMemberService.check(ws!.id, undefined, "approver");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.status).toBe(401);
  });
});

describe.skipIf(!reachable)("assignment replaces claiming", () => {
  const SUPER = "super@acme-hr.example";
  afterEach(() => config.superAdminEmails.delete(SUPER));

  it("⚠ there is no `claim` on the service any more — assignment is the only way in", () => {
    // The bootstrap used to be self-service: the first signed-in caller became
    // the admin of any unclaimed workspace. Asserted as an ABSENCE because the
    // regression is somebody restoring it as a convenience.
    expect((workspaceMemberService as Record<string, unknown>).claim).toBeUndefined();
  });

  it("a super admin can assign the FIRST member of a workspace with none", async () => {
    // This is what makes deleting `claim` safe rather than a dead end: `check`'s
    // super-admin branch runs before the member list is read, so a memberless
    // workspace is still assignable.
    config.superAdminEmails.add(SUPER);
    expect(await workspaceMemberService.count(ws!.id)).toBe(0);
    expect((await workspaceMemberService.check(ws!.id, SUPER, "admin")).allowed).toBe(true);
    const m = await workspaceMemberService.grant(
      ws!.id,
      { subject: ALICE.subject, email: ALICE.email, role: "admin" },
      SUPER,
    );
    expect(m.role).toBe("admin");
    // ⚠ NOT `bootstrap`. That literal survives only to explain rows the deleted
    // endpoint wrote; an assignment records who actually made it.
    expect(m.grantedBy).toBe(SUPER);
    expect(m.grantedBy).not.toBe(BOOTSTRAP_GRANT);
  });

  it("the assigned member then holds real access in that workspace", async () => {
    config.superAdminEmails.add(SUPER);
    await workspaceMemberService.grant(
      ws!.id,
      { subject: ALICE.subject, email: ALICE.email, role: "admin" },
      SUPER,
    );
    // The positive control for the whole feature: assignment grants access, and
    // it grants it without the assignee ever being a super admin.
    for (const needed of ["author", "approver", "admin"] as const) {
      expect((await workspaceMemberService.check(ws!.id, ALICE, needed)).allowed, needed).toBe(true);
    }
  });

  it("⚠ with the allowlist EMPTY, a memberless workspace has no way in at all", async () => {
    // The cost of removing `claim`, asserted rather than described. The refusal
    // has to name the variable, or this state reads as a bug.
    //
    // ⚠ Emptied explicitly: this repo's own `.env` sets SUPER_ADMIN_EMAILS, so a
    // test that assumed an empty allowlist would pass or fail per machine.
    const real = [...config.superAdminEmails];
    config.superAdminEmails.clear();
    try {
    const v = await workspaceMemberService.check(ws!.id, ALICE, "admin");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/SUPER_ADMIN_EMAILS/);
    } finally {
      for (const e of real) config.superAdminEmails.add(e);
    }
  });
});

describe.skipIf(!reachable)("the role comparison itself", () => {
  beforeEach(async () => {
    // Was `claim()`. Inserted directly rather than through `grant()` so this
    // suite tests the comparison and not the assignment path.
    await db
      .insert(workspaceMembers)
      .values({
        workspaceId: ws!.id,
        subject: ALICE.subject,
        email: ALICE.email,
        role: "admin",
        grantedBy: BOOTSTRAP_GRANT,
      });
  });

  it("ALLOWS an approver to approve — the positive control", async () => {
    // Without this, every other assertion in this file is satisfied by a role
    // model that grants nothing to anybody.
    await workspaceMemberService.grant(
      ws!.id,
      { subject: BOB.subject, email: BOB.email, role: "approver" },
      ALICE.email,
    );
    const v = await workspaceMemberService.check(ws!.id, BOB.subject, "approver");
    expect(v.allowed).toBe(true);
  });

  it("refuses an author asked for approver, and says which role they hold", async () => {
    await workspaceMemberService.grant(
      ws!.id,
      { subject: BOB.subject, email: BOB.email, role: "author" },
      ALICE.email,
    );
    const v = await workspaceMemberService.check(ws!.id, BOB.subject, "approver");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/holds? "author"/);
  });

  it("refuses a non-member of THIS workspace even though they are signed in", async () => {
    const v = await workspaceMemberService.check(ws!.id, BOB.subject, "author");
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/not a member/);
  });

  /**
   * ⚠ Pinned as a NAMED property because it was reported as broken and was not.
   * An admin has always passed `requireWorkspaceRole("approver")` on gate 2 and
   * gate 3. What actually stopped an admin approving was the identity SUBJECT
   * rotating on every sign-in (`packages/client/src/auth.ts` signed
   * `token.sub`), so their membership row named somebody the next token was not
   * — and the refusal they got said "you are not a member of this workspace".
   *
   * The lesson worth keeping: a role model that reads correctly can still refuse
   * the right person if the KEY it is looked up by is unstable. Do not "fix"
   * inheritance here — it is not where that bug lives.
   *
   * ⚠ **THE MECHANISM CHANGED AND THIS COMMENT CHANGED WITH IT (RBAC T049).** It
   * used to say *"`RANK` has always been ordered (`author` 1 < `approver` 2 <
   * `admin` 3)"*. `RANK` is **deleted**. Ordering is now **set containment** over
   * the permission presets (INV-4), which answers the same question for these
   * three and the right question for a custom role — a role holding
   * `flows.approve` and nothing else is neither above nor below `author`, and no
   * integer could place it. **The property below is unchanged**; only how it is
   * decided is. A test that went on describing a mechanism that no longer exists
   * is worse than no comment, because it reads as a live description.
   */
  it("⚠ an admin can approve: admin ⊇ approver ⊇ author, by CONTAINMENT not by rank", async () => {
    for (const needed of ["author", "approver", "admin"] as const) {
      const v = await workspaceMemberService.check(ws!.id, ALICE, needed);
      expect(v.allowed, `an admin must satisfy "${needed}"`).toBe(true);
    }
  });

  it("an admin satisfies every lower role — containment, not an integer ladder", async () => {
    for (const role of ["author", "approver", "admin"] as const) {
      expect((await workspaceMemberService.check(ws!.id, ALICE.subject, role)).allowed).toBe(true);
    }
  });

  /**
   * ⚠ The other direction, which an integer ladder also gave and which containment
   * must not quietly lose: an author does NOT satisfy an approver check. Without
   * this, `containsAll` returning `true` unconditionally would pass every
   * assertion above.
   */
  it("CONTROL: an author does NOT satisfy approver or admin", async () => {
    await workspaceMemberService.grant(
      ws!.id,
      { subject: BOB.subject, email: BOB.email, role: "author" },
      "test-granter",
    );
    expect((await workspaceMemberService.check(ws!.id, BOB.subject, "author")).allowed).toBe(true);
    expect((await workspaceMemberService.check(ws!.id, BOB.subject, "approver")).allowed).toBe(
      false,
    );
    expect((await workspaceMemberService.check(ws!.id, BOB.subject, "admin")).allowed).toBe(false);
  });

  /**
   * ⚠ **MEASURED, not reasoned.** The exemption exists because the wire test
   * found the alternative: a super admin assigned the wrong person as a
   * workspace's only member and could not take it back — the removal 409'd, and
   * with `claim` deleted there was no other way in or out. An irreversible
   * mis-assignment is worse than the state the refusal protects against, and for
   * a super admin the refusal's premise ("nobody able to grant again") is false
   * by construction.
   */
  it("⚠ a SUPER ADMIN may remove the last admin — a mis-assignment must be undoable", async () => {
    expect((await workspaceMemberService.list(ws!.id)).filter((m) => m.role === "admin").length).toBe(1);
    await expect(
      workspaceMemberService.revoke(ws!.id, ALICE.subject, { bySuperAdmin: true }),
    ).resolves.toBe(true);
    expect(await workspaceMemberService.count(ws!.id)).toBe(0);
  });

  it("⚠ and may demote them — same reason", async () => {
    await expect(
      workspaceMemberService.grant(
        ws!.id,
        { subject: ALICE.subject, email: ALICE.email, role: "author" },
        "boss@acme-hr.example",
        { bySuperAdmin: true },
      ),
    ).resolves.toMatchObject({ role: "author" });
  });

  it("⚠ refuses to demote or remove the LAST admin", async () => {
    // A workspace with members and no admin can never grant again, and the only
    // repair is a database edit — `claim` refuses it too, because it has members.
    await expect(
      workspaceMemberService.grant(
        ws!.id,
        { subject: ALICE.subject, email: ALICE.email, role: "author" },
        ALICE.email,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(workspaceMemberService.revoke(ws!.id, ALICE.subject)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("membership is keyed on SUBJECT, so an email change does not create a second row", async () => {
    await workspaceMemberService.grant(
      ws!.id,
      { subject: BOB.subject, email: "bob.renamed@acme-hr.example", role: "approver" },
      ALICE.email,
    );
    const bobs = (await workspaceMemberService.list(ws!.id)).filter((m) => m.subject === BOB.subject);
    expect(bobs).toHaveLength(1);
    expect(bobs[0]!.role).toBe("approver");
    expect(bobs[0]!.email).toBe("bob.renamed@acme-hr.example");
  });
});

describe.skipIf(!reachable)("a super admin (env allowlist) acts in every workspace at the top role", () => {
  const SUPER = "super@acme-hr.example";
  afterEach(() => {
    config.superAdminEmails.delete(SUPER);
  });

  it("passes every role check in a workspace they are not a member of", async () => {
    config.superAdminEmails.add(SUPER);
    for (const needed of ["author", "approver", "admin"] as const) {
      const v = await workspaceMemberService.check(ws!.id, SUPER, needed);
      expect(v.allowed, `needed ${needed}`).toBe(true);
      if (v.allowed) expect(v.role).toBe("admin");
    }
  });

  /**
   * ⚠ THE REGRESSION THIS FEATURE FIXED, and it was silent.
   *
   * The check was `superAdminEmails.has(subject)` — subject only, from a
   * variable named `SUPER_ADMIN_EMAILS`. A `FoundryIdentity.subject` is the
   * token's `sub`, which for an Entra sign-in is the **OID**. So a deployment
   * that listed an email (i.e. did what the variable's name says) granted
   * nothing at all, with a correct value in a correct variable and no error
   * anywhere. It only ever appeared to work because the local credentials
   * account's subject is the literal `local-admin` and its email is a real
   * address, so listing either one matched.
   *
   * Revert `config.isSuperAdmin` to a subject-only test and this goes red.
   */
  it("⚠ an EMAIL in the allowlist authorises an identity whose subject is an OID", async () => {
    config.superAdminEmails.add(SUPER);
    const entra = { subject: "00000000-1111-2222-3333-444444444444", email: SUPER };
    const v = await workspaceMemberService.check(ws!.id, entra, "admin");
    expect(v.allowed, "an email-listed super admin must be recognised by email").toBe(true);
  });

  it("matches an email case-insensitively, but a subject exactly", async () => {
    config.superAdminEmails.add(SUPER);
    expect(
      (await workspaceMemberService.check(ws!.id, { subject: "oid-x", email: SUPER.toUpperCase() }, "admin"))
        .allowed,
    ).toBe(true);
    // A subject is an opaque identifier in somebody else's namespace; folding
    // its case would be inventing a match rule for it.
    expect(
      (await workspaceMemberService.check(ws!.id, { subject: SUPER.toUpperCase(), email: "" }, "admin"))
        .allowed,
    ).toBe(false);
  });

  it("grants nothing when the allowlist is empty", async () => {
    // SUPER is never added in this test — but the deployment's real allowlist
    // must not be able to rescue it either, so it is emptied for the duration.
    const real = [...config.superAdminEmails];
    config.superAdminEmails.clear();
    try {
      const v = await workspaceMemberService.check(ws!.id, SUPER, "author");
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.reason).toMatch(/no members yet|not a member/);
      expect(config.superAdminConfigured).toBe(false);
    } finally {
      for (const e of real) config.superAdminEmails.add(e);
    }
  });
});

describe("every route that decides an approval carries the role guard", () => {
  /**
   * ⚠ Stated as *what must be present*, not as a pattern that resembles it.
   * I-62 is the record of the opposite: a guard written as "flag anything that
   * looks like X" produced three false positives and zero real ones, and the
   * widening people reach for is what permits the defect.
   *
   * The subject here is narrow and checkable: a route handler that calls
   * `flowApprovalService.approve`, `.revoke` or `stepApprovalService.decide`
   * must have `requireWorkspaceRole` somewhere in its file.
   */
  const DECIDERS = [
    "flowApprovalService.approve(",
    "flowApprovalService.revoke(",
    "stepApprovalService.decide(",
  ];

  it("flags any route file that reaches an approval decision without it", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!DECIDERS.some((d) => src.includes(d))) continue;
      if (!src.includes("requireWorkspaceRole")) offenders.push(file);
    }
    expect(offenders, "route files that decide an approval with no role guard").toEqual([]);
  });

  it("and the check can FAIL — it finds the deciders it is looking for", () => {
    // Without this, a rename of `decide()` would silently leave the guard above
    // scanning nothing and reporting green for ever.
    const found = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => DECIDERS.some((d) => readFileSync(join(ROUTES_DIR, f), "utf8").includes(d)));
    // flows.ts revokes on an owner change (plugins 8.6) and on switch-off (plugins phase 9) — turning off, which never
    // needs more than turning on; it still carries requireWorkspaceRole for approving.
    expect(found.sort()).toEqual(["approvals.ts", "flows.ts", "step-approvals.ts"]);
  });
});

/**
 * The super-admin gate, asserted by reading the route tree.
 *
 * Same idiom and same reason as the block above: a route that decides workspace
 * membership or lifecycle without the guard would work perfectly and report
 * nothing. Each `it` has its own control, because a grep with nothing to find
 * passes for ever (I-38, and at the largest scale in this repo — 21 client render
 * files that never ran while the summary line said green).
 */
describe("every route that assigns membership or creates a workspace is guarded", () => {
  /**
   * ⚠ **THIS TEST WAS REWRITTEN, NOT KEPT (RBAC T049), AND THE OLD FORM WOULD NOW BE
   * WRONG IN BOTH DIRECTIONS.**
   *
   * It used to grep `members.ts` and `workspaces.ts` for the literal string
   * `requireSuperAdmin`. That string is **gone from `members.ts`** — deliberately. The
   * rule for assigning members is now super admin **OR** `members.grant`, and keeping
   * the super-admin guard alongside the spliced permission guard would have meant AND,
   * which is narrower than before and would stop a workspace administrator managing
   * their own workspace. An allowlist holder still passes, because
   * `config.isSuperAdmin` short-circuits the resolver to the whole catalogue before any
   * row is read.
   *
   * So the property is now stated against the **permission map**, which is both stronger
   * and mechanical: the map is generated from the live Express stack, and
   * `route-permissions.test.ts` separately asserts that the guard each route carries
   * matches it. Grepping for a middleware NAME could never have told you whether the
   * guard was actually mounted.
   *
   * ⚠ Its CONTROL is kept and is the half that matters — see the second test.
   */
  const WRITERS: Record<string, { calls: string[]; routes: Array<[string, string]> }> = {
    "members.ts": {
      calls: ["workspaceMemberService.grant(", "workspaceMemberService.revoke("],
      routes: [
        ["POST", "/api/workspaces/:workspaceId/members"],
        ["DELETE", "/api/workspaces/:workspaceId/members/:subject"],
      ],
    },
    "workspaces.ts": {
      calls: ["workspaceService.create(", "workspaceService.update(", "workspaceService.remove("],
      routes: [
        ["POST", "/api/workspaces"],
        ["PATCH", "/api/workspaces/:id"],
        ["DELETE", "/api/workspaces/:id"],
      ],
    },
  };

  it("each one requires a permission — the workspace one or the platform one", () => {
    const offenders: string[] = [];
    for (const [file, { calls, routes }] of Object.entries(WRITERS)) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!calls.some((c) => src.includes(c))) continue;
      for (const [method, path] of routes) {
        const req = requirementFor(method, path);
        const guarded =
          req?.kind === "workspace" || req?.kind === "platform"
            ? req.permission
            : null;
        if (!guarded) offenders.push(`${file}: ${method} ${path} requires no permission`);
      }
    }
    expect(
      offenders,
      "membership or workspace writes that nothing authorises",
    ).toEqual([]);
  });

  it("and the check can FAIL — it finds the writers it is looking for", () => {
    // ⚠ The original control, kept verbatim in spirit: without it the loop above
    // iterates nothing and passes for ever.
    const found = Object.entries(WRITERS).filter(([file, { calls }]) => {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      return calls.some((c) => src.includes(c));
    });
    expect(found.map(([f]) => f).sort()).toEqual(["members.ts", "workspaces.ts"]);
  });

  it("membership writes take `members.grant`, and the reads take `members.read`", () => {
    expect(requirementFor("POST", "/api/workspaces/:workspaceId/members")).toMatchObject({
      permission: "members.grant",
    });
    expect(
      requirementFor("DELETE", "/api/workspaces/:workspaceId/members/:subject"),
    ).toMatchObject({ permission: "members.grant" });
    expect(requirementFor("GET", "/api/workspaces/:workspaceId/members")).toMatchObject({
      permission: "members.read",
    });
  });

  it("⚠ workspace CREATE/RENAME/DELETE stay on the PLATFORM tier, not a workspace one", () => {
    // A workspace permission cannot authorise creating a workspace — there is no
    // workspace to hold it in yet. This is the boundary that keeps a tenant admin from
    // minting tenants.
    for (const [method, path] of WRITERS["workspaces.ts"]!.routes) {
      const req = requirementFor(method, path);
      expect(req?.kind, `${method} ${path}`).toBe("platform");
      if (req?.kind === "platform") expect(req.permission).toBe("platform.workspaces.write");
    }
  });
});
