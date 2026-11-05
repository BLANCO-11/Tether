import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformUserAliases, platformUsers, workspaceMembers, workspaces as workspacesTable } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { _resetPersonMergeCache, personMergeService } from "./person-merge.service.js";

/**
 * One person, one record (admin simplify, phase 1). Runs against the tests' own database (vitest.config.ts).
 *
 * The control is the case that must NOT merge: two different sign-in ids sharing an email. Without it, "merge
 * everything with the same email" passes every positive case here — and hands a reused mailbox somebody else's access.
 */

const tag = Date.now().toString(36);
const EMAIL = `merge-${tag}@merge.example`;
const OID = `oid-merge-${tag}`;
const OTHER_OID = `oid-other-${tag}`;

const ws = await workspaceRepo.create({ name: "person-merge tests", tenantSlug: "mergetest", slug: `mergetest-${tag}` });
const ws2 = await workspaceRepo.create({ name: "person-merge tests 2", tenantSlug: "mergetest", slug: `mergetest2-${tag}` });
const ids = [EMAIL, EMAIL.toUpperCase(), OID, OTHER_OID];

async function wipe() {
  await db.delete(workspaceMembers).where(inArray(workspaceMembers.workspaceId, [ws!.id, ws2!.id]));
  await db.delete(platformUsers).where(inArray(platformUsers.subject, ids));
  await db.delete(platformUserAliases).where(inArray(platformUserAliases.oldSubject, ids));
  _resetPersonMergeCache();
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.delete(workspacesTable).where(inArray(workspacesTable.id, [ws!.id, ws2!.id]));
});

const member = (workspaceId: string, subject: string, role: string) =>
  db.insert(workspaceMembers).values({ workspaceId, subject, email: EMAIL, role, grantedBy: "test" } as never);

const roleOf = async (workspaceId: string, subject: string) =>
  (await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))).find(
    (m) => m.subject === subject,
  )?.role ?? null;

describe("an id that is the person's email becomes theirs on first sight", () => {
  it("moves the membership, removes the duplicate person, and records the alias", async () => {
    await member(ws!.id, EMAIL, "approver");
    await db.insert(platformUsers).values({ subject: EMAIL, email: EMAIL });

    await personMergeService.onFirstSight({ subject: OID, email: EMAIL });

    expect(await roleOf(ws!.id, OID)).toBe("approver");
    expect(await roleOf(ws!.id, EMAIL)).toBeNull();
    const people = await db.select().from(platformUsers).where(inArray(platformUsers.subject, [EMAIL, OID]));
    expect(people.map((p) => p.subject)).toEqual([OID]);
    const [alias] = await db.select().from(platformUserAliases).where(eq(platformUserAliases.oldSubject, EMAIL));
    expect(alias).toMatchObject({ subject: OID, reason: "email_was_id" });
  });

  it("matches the email whatever its case", async () => {
    await member(ws!.id, EMAIL.toUpperCase(), "author");
    await personMergeService.onFirstSight({ subject: OID, email: EMAIL });
    expect(await roleOf(ws!.id, OID)).toBe("author");
  });

  it("keeps the stronger role where both ids are members of one workspace, and moves the rest", async () => {
    await member(ws!.id, EMAIL, "admin");
    await member(ws!.id, OID, "author");
    await member(ws2!.id, EMAIL, "viewer");
    await personMergeService.onFirstSight({ subject: OID, email: EMAIL });
    expect(await roleOf(ws!.id, OID)).toBe("admin");
    expect(await roleOf(ws2!.id, OID)).toBe("viewer");
    const left = await db.execute(sql`SELECT count(*)::int n FROM workspace_members WHERE subject = ${EMAIL}`);
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it("CONTROL: two different sign-in ids with the same email are never merged on their own", async () => {
    await member(ws!.id, OTHER_OID, "admin");
    await db.insert(platformUsers).values({ subject: OTHER_OID, email: EMAIL });
    await personMergeService.onFirstSight({ subject: OID, email: EMAIL });
    expect(await roleOf(ws!.id, OID)).toBeNull();
    expect(await roleOf(ws!.id, OTHER_OID)).toBe("admin");
  });

  it("never merges a local account's id away", async () => {
    await expect(personMergeService.merge("local:abc", OID, { reason: "admin_merge" })).rejects.toThrow(/local account/);
  });
});

describe("sign-in calls it, and waits for it", () => {
  it("resolveIdentity awaits onFirstSight before the request is authorised", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../middleware/identity.middleware.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(1000); // CONTROL: the file was read, so the absence below means something
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // a comment naming the call is not the call
    expect(code).toMatch(/await personMergeService\.onFirstSight\(req\.user\);\s*return next\(\);/);
  });
});
