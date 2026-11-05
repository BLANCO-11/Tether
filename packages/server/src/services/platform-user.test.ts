import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformUsers } from "../db/schema.js";
import { platformUserService, _resetSeenThrottle } from "./platform-user.service.js";

/**
 * `platform_users` — the list a super admin assigns from.
 *
 * ⚠ The two properties worth protecting are both about it being SAFE to call
 * from `resolveIdentity`, which runs on the path of every authenticated request:
 * one row per subject however many times it is called, and never throwing.
 */

const SUBJECTS = ["test-seen-a", "test-seen-b"];
const A = { subject: SUBJECTS[0]!, email: "a@acme-hr.example", name: "A Person" };

async function wipe() {
  await db.delete(platformUsers).where(inArray(platformUsers.subject, SUBJECTS));
}

let reachable = true;
try {
  await wipe();
} catch {
  reachable = false;
}

beforeEach(async () => {
  _resetSeenThrottle();
  await wipe();
});
afterAll(wipe);

describe.skipIf(!reachable)("platformUserService.seen", () => {
  it("records an identity once, and keeps first_seen while moving last_seen", async () => {
    await platformUserService.seen(A);
    const [first] = await db.select().from(platformUsers).where(inArray(platformUsers.subject, [A.subject]));
    expect(first?.email).toBe(A.email);
    expect(first?.name).toBe(A.name);

    // Past the throttle, a second sighting must UPDATE rather than insert.
    _resetSeenThrottle();
    await new Promise((r) => setTimeout(r, 15));
    await platformUserService.seen({ ...A, email: "renamed@acme-hr.example" });
    const rows = await db.select().from(platformUsers).where(inArray(platformUsers.subject, [A.subject]));
    expect(rows.length, "one row per subject").toBe(1);
    // The address is refreshed — it is what a super admin picks from — and
    // first_seen is the one fact a later request cannot restate.
    expect(rows[0]!.email).toBe("renamed@acme-hr.example");
    expect(rows[0]!.firstSeenAt.getTime()).toBe(first!.firstSeenAt.getTime());
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
  });

  it("⚠ the throttle suppresses a repeat write — this is what makes it callable per request", async () => {
    await platformUserService.seen(A);
    const [before] = await db.select().from(platformUsers).where(inArray(platformUsers.subject, [A.subject]));
    await new Promise((r) => setTimeout(r, 10));
    await platformUserService.seen(A); // inside the 60s window
    const [after] = await db.select().from(platformUsers).where(inArray(platformUsers.subject, [A.subject]));
    expect(after!.lastSeenAt.getTime()).toBe(before!.lastSeenAt.getTime());
  });

  it("ignores an identity with no subject rather than writing a blank row", async () => {
    await platformUserService.seen({ subject: "", email: "nobody@acme-hr.example" });
    await platformUserService.seen({ subject: null, email: null });
    const rows = await db.select().from(platformUsers).where(inArray(platformUsers.subject, [""]));
    expect(rows).toEqual([]);
  });

  it("⚠ NEVER throws — bookkeeping must not be able to fail a request", async () => {
    // ⚠ The first version of this test used a 40,000-character subject and it
    // PROVED NOTHING: `subject` is `text`, so Postgres accepted it happily and
    // the assertion passed over a successful write, leaving a junk row behind.
    // Found by reading the live table, not by the test. I-38 in miniature — a
    // control that cannot fail.
    //
    // A NUL byte is a value Postgres genuinely refuses in a text column, so the
    // write really does throw and `seen` really does have to swallow it.
    const bad = { subject: "nul-\u0000-subject", email: "e@x.test" };
    await expect(platformUserService.seen(bad)).resolves.toBeUndefined();
    // ⚠ And it wrote nothing. Checked with a LIKE rather than by querying for
    // the subject itself: the NUL byte that makes the INSERT fail also makes the
    // verification query fail, so the obvious assertion throws inside the test
    // instead of inside the code under test.
    const left = (await platformUserService.list()).filter((u) => u.subject.startsWith("nul-"));
    expect(left).toEqual([]);
  });

  it("lists most-recently-seen first", async () => {
    await platformUserService.seen(A);
    await new Promise((r) => setTimeout(r, 15));
    await platformUserService.seen({ subject: SUBJECTS[1]!, email: "b@acme-hr.example" });
    const mine = (await platformUserService.list()).filter((u) => SUBJECTS.includes(u.subject));
    expect(mine.map((u) => u.subject)).toEqual([SUBJECTS[1], SUBJECTS[0]]);
  });
});
