/**
 * `people:tidy` — one person, one row in the signed-in list (admin simplify, phase 1).
 *
 * ⚠ **DRY RUN BY DEFAULT. `--apply` writes.** Two things, each printed before anything changes:
 *
 *   1. **Merge** a person recorded under their email AND under their sign-in id: the email row folds into the id row
 *      (`personMergeService.merge`, reason `email_was_id`). Only when exactly ONE other id carries that email — two or
 *      more is a reused-mailbox question for an admin, listed and left alone.
 *   2. **Remove test identities** from the signed-in list: reserved test domains (example.com/.org/.net, .example,
 *      .test, .local), or ids test harnesses mint (`oid-…`, `timing-probe`).
 *      Only `platform_users` rows: it is a record of who has signed in, not of anybody's access, so nothing anybody can
 *      do changes. Tests now write to their own database (vitest.config.ts), so these do not come back.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { personMergeService } from "../services/person-merge.service.js";

const apply = process.argv.includes("--apply");
// RFC 2606 / 6761 reserved names never belong to a real person: example.com/.org/.net, and the .example, .test and
// .local suffixes. Plus the ids test harnesses mint (`oid-…`, the identity timing probe).
const TEST_PATTERN = "(email ~* '(@example\\.(com|org|net)|\\.(example|test|local))$' OR subject LIKE 'oid-%' OR subject = 'timing-probe')";
const TEST_SHAPED = sql.raw(TEST_PATTERN);

const total = (await db.execute(sql`SELECT count(*)::int n FROM platform_users`)).rows[0] as { n: number };
console.log(`people:tidy — ${apply ? "APPLYING" : "dry run (add --apply to change anything)"}`);
console.log(`signed-in list: ${total.n} rows read`);

const pairs = (
  await db.execute(sql`
    SELECT e.subject AS from_subject, array_agg(o.subject) AS to_subjects
      FROM platform_users e
      JOIN platform_users o ON lower(o.email) = lower(e.subject) AND o.subject <> e.subject
     WHERE e.subject ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND NOT ${sql.raw(TEST_PATTERN.replaceAll("email", "e.email").replaceAll("subject", "e.subject"))}
     GROUP BY e.subject`)
).rows as { from_subject: string; to_subjects: string[] }[];

console.log(`\n1. Recorded under an email and under a sign-in id: ${pairs.length}`);
for (const p of pairs) {
  if (p.to_subjects.length !== 1) {
    console.log(`   LEFT for an admin: ${p.from_subject} matches ${p.to_subjects.length} sign-in ids (${p.to_subjects.join(", ")})`);
    continue;
  }
  const to = p.to_subjects[0]!;
  if (!apply) {
    console.log(`   would merge ${p.from_subject} → ${to}`);
    continue;
  }
  const r = await personMergeService.merge(p.from_subject, to, { reason: "email_was_id", mergedBy: "people:tidy", email: p.from_subject });
  console.log(`   merged ${p.from_subject} → ${to}: ${JSON.stringify(r.moved)}`);
}

const test = (await db.execute(sql`SELECT count(*)::int n FROM platform_users WHERE ${TEST_SHAPED}`)).rows[0] as { n: number };
const sample = (await db.execute(sql`SELECT email, subject FROM platform_users WHERE ${TEST_SHAPED} ORDER BY email LIMIT 5`)).rows;
console.log(`\n2. Test identities in the signed-in list: ${test.n}`);
for (const s of sample as { email: string; subject: string }[]) console.log(`   e.g. ${s.email}  (${s.subject})`);
if (apply && test.n > 0) {
  const r = await db.execute(sql`DELETE FROM platform_users WHERE ${TEST_SHAPED}`);
  console.log(`   removed ${r.rowCount ?? 0}`);
} else if (test.n > 0) {
  console.log(`   would remove ${test.n}`);
}

const kept = (await db.execute(sql`SELECT email, subject FROM platform_users WHERE NOT ${TEST_SHAPED} ORDER BY email`)).rows as {
  email: string;
  subject: string;
}[];
console.log(`\nKept (${kept.length}):`);
for (const k of kept) console.log(`   ${k.email || "(no email)"}  (${k.subject})`);
await pool.end();
