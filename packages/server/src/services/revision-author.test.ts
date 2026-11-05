import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { systemAuthor, authorClaim, SYSTEM_AUTHOR_NAME } from "./revision-author.js";
import type { FlowModel } from "./flow-compiler.service.js";
import { pgErrorCode } from "../db/pg-error.js";

/**
 * What Postgres said when it refused a statement. From drizzle-orm 0.44 the error a query rejects with is Drizzle's
 * wrapper (`Failed query: …`) and Postgres's own refusal is its `cause` — so a refusal is matched on the SQLSTATE and on
 * the database's message, never on the wrapper's text.
 */
async function refusal(q: Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try {
    await q;
  } catch (e) {
    const db = (e as { cause?: unknown }).cause ?? e;
    return { code: pgErrorCode(e), message: db instanceof Error ? db.message : String(db) };
  }
  throw new Error("the statement was expected to be refused");
}

/**
 * `flow_revisions.created_by_kind` — archive/GAPS.md §1.2, ISSUES.md I-32.
 *
 * ── What each half of this file is for ───────────────────────────────────────
 *
 * The gap was never that the author column existed. It was that the column was
 * written from a verified identity on one path and from a request body on every
 * other, **and the row did not record which** — so gate 2's self-approval
 * refusal compared one value the server established against one it may merely
 * have been told, and a caller holding the API key could author as
 * `someone-else@…` and approve as themselves.
 *
 * Three properties close that, and each is tested by the thing that would break
 * if it stopped holding rather than by re-reading the implementation:
 *
 *  1. **`user` has exactly one minter.** A second place that constructs an
 *     attested author would work perfectly, pass every other test in this repo
 *     and report nothing — the one-reader-per-secret shape (D-42). So
 *     it is asserted by reading the source tree.
 *  2. **No route reads a body `createdBy` without `authorOf`.** Two did:
 *     `…/steps/:stepId/regenerate` and `POST …/import`, both straight out of
 *     `req.body`. A signed-in caller could therefore name anyone as the author
 *     of the revision they were about to approve. The grep below goes red if
 *     either comes back, or if a third appears.
 *  3. **The database refuses a row with no attestation, and refuses an invented
 *     one.** `created_by_kind` is NOT NULL with **no default**, so a future
 *     writer that forgets it fails loudly instead of silently acquiring a
 *     provenance — and the CHECK means a fourth value has to be added
 *     deliberately, in a migration, rather than typed at a call site.
 *
 * ⚠ **None of this is separation of duties** (I-13). There are no roles, anyone
 * who can sign in can approve, and anything holding `RUNTIME_JWT_SECRET` can
 * mint an identity — `e2e:ui` does. What the column buys is smaller and exactly
 * stateable: "a second pair of eyes was possible and happened" and "there was
 * nobody to be the first pair" are now different rows.
 */

const SRC = path.resolve(import.meta.dirname, "..");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("systemAuthor", () => {
  it("cannot mint a `user` kind, however person-shaped the name is", () => {
    // The whole reason harnesses, seeds and the CLI go through this function.
    // They keep their labels — a run log saying `phase3-verify@…` is useful —
    // and the label stops carrying any claim that somebody checked it.
    expect(systemAuthor("alice@acme-hr.example")).toEqual({
      createdBy: "alice@acme-hr.example",
      createdByKind: "system",
    });
    expect(systemAuthor().createdByKind).toBe("system");
    expect(systemAuthor().createdBy).toBe(SYSTEM_AUTHOR_NAME);
    // Blank is not an author. An empty name with a `system` kind reads, in the
    // revision list, as a missing value rather than as a machine write.
    expect(systemAuthor("   ").createdBy).toBe(SYSTEM_AUTHOR_NAME);
  });

  it("says something DIFFERENT for each kind, and never claims verification for two of them", () => {
    const user = authorClaim("user", "alice@acme-hr.example");
    const system = authorClaim("system", "showcase-seed@acme-hr.example");
    const unknown = authorClaim("unknown", null);
    expect(new Set([user, system, unknown]).size).toBe(3);
    expect(user).toMatch(/signed in/);
    // The two unattested kinds must not be phrased as if anybody was checked.
    expect(system).toMatch(/self-asserted|nobody/);
    expect(unknown).toMatch(/nothing says/);
  });
});

describe("one minter, and no route that bypasses it", () => {
  it("mints `createdByKind: \"user\"` in exactly ONE file", () => {
    const hits = tsFilesUnder(SRC)
      // ⚠ Test files excluded, for the reason `kestra:check` excludes them from
      // the LLM-credential grep: a test that asserts what `authorOf` returns has
      // to write the attested shape down, so counting tests makes this guard and
      // that assertion refute each other — and the "fix" for that is to delete
      // one of them. Production source is what the claim is about.
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => /createdByKind:\s*"user"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    // `authorOf` is the only thing in this codebase that has seen a verified
    // token. A second constructor is a second definition of "verified".
    expect(hits).toEqual(["middleware/identity.middleware.ts"]);
  });

  /**
   * ⚠ The classification below is deliberately narrow, and the reason is worth
   * more than the check.
   *
   * The first version flagged any line mentioning `createdBy` that was neither a
   * destructure nor an `authorOf(` call. That is too crude in a way that would
   * have destroyed the check within a week: it fired on
   * `createdBy: z.string()…` — declaring the field, which every route MUST do in
   * order to hand it to `authorOf` — and on `createdBy: t.createdBy` in a
   * template LIST response, which is reading a stored value back out, the
   * opposite direction. Three false positives against zero real ones.
   *
   * A guard that cries wolf gets relaxed, and the relaxation people reach for is
   * "allow `createdBy:` followed by anything", which permits precisely the defect
   * (I-38: a control that cannot fail is worse than none). So it is stated as
   * what is actually forbidden — a BODY-DERIVED value reaching anything but
   * `authorOf` — with the legal shapes enumerated rather than pattern-guessed.
   */
  it("never lets a route pass a body `createdBy` anywhere but into `authorOf`", () => {
    // Identifiers a parsed request body lands in. `createdBy: t.createdBy` off a
    // database row is a read; `createdBy: input.createdBy` is the value
    // travelling on, and they are otherwise the same shape.
    const BODY = /^(input|body|parsed|req|request|payload)$/;
    const offenders: string[] = [];
    for (const file of tsFilesUnder(path.join(SRC, "routes"))) {
      /**
       * ⚠ **Route IMPLEMENTATIONS, not their tests — added 2026-09-08 with the
       * control below.** A test file cannot be a route handler, and
       * `local-users.test.ts` legitimately posts `{ createdBy: "…" }` as a
       * fixture proving `.strict()` REFUSES it. Flagging the assertion that a
       * shape is forbidden, because it names the shape, is I-62 exactly.
       *
       * ⚠ This narrows the scan, which is the direction that goes silently
       * vacuous — hence the control asserting it still reads implementations
       * and still sees `createdBy` in one.
       */
      if (/\.test\.tsx?$/.test(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!/createdBy/.test(line)) return;
          const flag = () => offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // prose
          if (/authorOf\(/.test(line)) return; // the one legal destination
          // Declaring the field on a zod schema. Necessary: it cannot be parsed
          // out of the body and handed to `authorOf` without being declared.
          if (/\bcreatedBy\s*:\s*z\./.test(line)) return;
          // Destructuring it out of a parse — also necessary, and inert until
          // the resulting identifier is used, which the checks below cover.
          if (/^\s*(const|let)\s*\{[^}]*\bcreatedBy\b[^}]*\}\s*=/.test(line)) return;
          /**
           * ⚠ **TWO SHAPES ADDED 2026-09-08, and each is provably not
           * body-derived rather than merely plausible** — I-62's warning is
           * that the widening people reach for is the one that permits the
           * defect, so neither of these is "allow `createdBy:` followed by
           * anything".
           *
           * A literal `null` carries no value at all. And `req.user` is the
           * VERIFIED IDENTITY set by `resolveIdentity` after `jwtVerify` — a
           * different object from `req.body` and structurally the same
           * guarantee `authorOf` provides. `routes/local-users.ts` records who
           * created a local account from exactly that.
           *
           * ⚠ `req.user` is NOT added to `BODY` below and must not be: that
           * list is what makes `req.body.createdBy` a finding, and `req` is on
           * it.
           */
          if (/\bcreatedBy\s*:\s*null\b/.test(line)) return;
          if (/\bcreatedBy\s*:\s*req\??\.user\b/.test(line)) return;

          // ── Now the two shapes that were the actual defect ──────────────────
          // `POST …/import` did this via `input.createdBy`.
          const from = line.match(/\b(\w+)\??\.createdBy\b/)?.[1];
          if (from && BODY.test(from)) return flag();
          // `…/steps/:stepId/regenerate` did this straight off `req.body`.
          if (/req\??\.body\??\.?\s*(\.|\[['"])?createdBy/.test(line)) return flag();
          /**
           * ⚠ **A NESTED body path — a hole found 2026-09-08 by writing the
           * control below, not by reading.** Both checks above match only when
           * `createdBy` sits DIRECTLY on the body identifier, so
           * `req.body.user.createdBy` and `input.flow.createdBy` passed
           * cleanly: the `from` capture returned `user`/`flow`, which are not
           * on `BODY`, and the line then fell through the `if (from) return`
           * below as though it were reading a database row.
           */
          if (/\b(input|body|parsed|req|request|payload)\??\.[\w.?[\]'"]*createdBy\b/.test(line)) return flag();
          // The bare destructured identifier travelling on, as a shorthand
          // property or an assignment — `{ createdBy }` or `createdBy: createdBy`.
          if (/[,{(]\s*createdBy\s*[,}]/.test(line)) return flag();
          if (/\bcreatedBy\s*:\s*createdBy\b/.test(line)) return flag();
          // Reading a stored row's value into a response. `t.createdBy` where
          // `t` is a row, already excluded from the body list above.
          if (from) return;
          flag();
        });
    }
    expect(offenders).toEqual([]);
    /**
     * ⚠ **THE CONTROL, and the scan had none until 2026-09-08.** Every
     * assertion above is an absence, so a scan that read nothing — a moved
     * `routes/` directory, a changed extension, a narrowed file filter — would
     * pass for ever and read exactly like a clean tree (I-38). Two claims: it
     * saw real route files, and it saw `createdBy` in at least one of them.
     */
    const files = tsFilesUnder(path.join(SRC, "routes")).filter((f) => !/\.test\.tsx?$/.test(f));
    /**
     * ⚠ **NAMED FILES, not a count — found by perturbation.** The first version
     * asserted `files.length > 10` and a `createdBy` hit somewhere, and
     * repointing the scan at `src/repositories` SATISFIED BOTH: enough files,
     * and one of them mentions the field. A control a wrong directory can pass
     * is not a control (I-38).
     */
    const names = files.map((f) => path.basename(f));
    for (const required of ["flows.ts", "local-users.ts"]) expect(names).toContain(required);
    expect(files.filter((f) => /createdBy/.test(readFileSync(f, "utf8"))).length).toBeGreaterThan(0);
  });

  it("⚠ the scan STILL catches both shapes that were the real defect", () => {
    /**
     * ⚠ A control for the two legal shapes added above. The guard's own
     * docblock records that its first version had three false positives and
     * zero real ones; a widening is exactly where that repeats, so the two
     * historical defects are re-run as literal strings rather than trusted to
     * stay caught.
     */
    const BODY = /^(input|body|parsed|req|request|payload)$/;
    const judge = (line: string): boolean => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
      if (/authorOf\(/.test(line)) return false;
      if (/\bcreatedBy\s*:\s*z\./.test(line)) return false;
      if (/^\s*(const|let)\s*\{[^}]*\bcreatedBy\b[^}]*\}\s*=/.test(line)) return false;
      if (/\bcreatedBy\s*:\s*null\b/.test(line)) return false;
      if (/\bcreatedBy\s*:\s*req\??\.user\b/.test(line)) return false;
      const from = line.match(/\b(\w+)\??\.createdBy\b/)?.[1];
      if (from && BODY.test(from)) return true;
      if (/req\??\.body\??\.?\s*(\.|\[['"])?createdBy/.test(line)) return true;
      if (/\b(input|body|parsed|req|request|payload)\??\.[\w.?[\]'"]*createdBy\b/.test(line)) return true;
      if (/[,{(]\s*createdBy\s*[,}]/.test(line)) return true;
      if (/\bcreatedBy\s*:\s*createdBy\b/.test(line)) return true;
      if (from) return false;
      return true;
    };
    // The two real historical defects.
    expect(judge("      createdBy: input.createdBy,")).toBe(true);
    expect(judge("      createdBy: req.body.createdBy,")).toBe(true);
    // And the two shapes just permitted, which must stay permitted.
    expect(judge("      createdBy: null,")).toBe(false);
    expect(judge("      createdBy: req.user?.subject ?? null,")).toBe(false);
    /**
     * ⚠ **NESTED body paths, which the guard did NOT catch until this control
     * was written.** `req.body.user.createdBy` and `input.flow.createdBy`
     * passed cleanly: the `from` capture returned `user`/`flow`, neither on
     * `BODY`, and the line fell through as though it were reading a database
     * row. Found by writing the control, not by reading the guard.
     */
    expect(judge("      createdBy: req.body.user.createdBy,")).toBe(true);
    expect(judge("      createdBy: input.flow.createdBy,")).toBe(true);
    expect(judge("      createdBy: parsed.body?.createdBy,")).toBe(true);
    // ⚠ And a row read is STILL not a finding — the false-positive class the
    // guard's own docblock records. `t.createdBy` off a template row is the
    // opposite direction.
    expect(judge("        createdBy: t.createdBy,")).toBe(false);
  });
});

// ── The database half ────────────────────────────────────────────────────────

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(
      `\n[GAPS §1.2] SKIPPING the created_by_kind DB tests — parent DB unreachable: ${(e as Error).message}\n`,
    );
    return false;
  }
})();

const stamp = Date.now();
const MODEL: FlowModel = { id: `author-kind-${stamp}`, steps: [{ id: "t", kind: "transform", expr: "{{ 1 }}" }] };

describe.skipIf(!reachable)("the column the migration added", () => {
  let wsId: string;
  let flowId: string;

  const revision = (n: number, kind: string, name: string | null) => ({
    flowId,
    revision: n,
    modelJson: MODEL,
    compiledYamlHash: "sha256:t",
    structureHash: "sha256:t",
    createdBy: name,
    createdByKind: kind,
  });

  it("sets up", async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({
        name: `author-kind ${stamp}`,
        slug: `author-kind-${stamp}`,
        tenantSlug: "authorkind",
        description: "GAPS §1.2 test; safe to delete",
      })
      .returning();
    wsId = ws.id;
    const flow = await flowRepo.create({
      workspaceId: wsId,
      name: "attestation",
      kestraFlowId: MODEL.id,
      draftRevision: 0,
      status: "draft",
    });
    if (!flow) throw new Error("setup: flow insert unexpectedly conflicted");
    flowId = flow.id;
    expect(flowId).toBeTruthy();
  });

  it("REFUSES a revision with no attestation — there is no silent default", async () => {
    // The load-bearing negative control. With a database default this insert
    // would succeed and quietly acquire a provenance nobody chose, which is the
    // original defect wearing a new column. `$inferInsert` makes omitting it a
    // compile error too; this is the backstop for anything that reaches the
    // table without going through drizzle's types.
    const r = await refusal(
      db.execute(
        sql`insert into flow_revisions (flow_id, revision, model_json, compiled_yaml_hash, structure_hash)
            values (${flowId}, 90, ${JSON.stringify(MODEL)}::jsonb, 'sha256:t', 'sha256:t')`,
      ),
    );
    expect(r.code).toBe("23502"); // not_null_violation
    expect(r.message).toMatch(/created_by_kind/);
  });

  it("REFUSES a kind nobody wrote down", async () => {
    // A fourth value has to be a migration, not a typo at a call site. Without
    // the CHECK the column is a free-text field that only looks like an enum,
    // and the first `"person"` would read as attested to every consumer.
    const r = await refusal(
      db.execute(
        sql`insert into flow_revisions
              (flow_id, revision, model_json, compiled_yaml_hash, structure_hash, created_by_kind)
            values (${flowId}, 91, ${JSON.stringify(MODEL)}::jsonb, 'sha256:t', 'sha256:t', 'person')`,
      ),
    );
    expect(r.code).toBe("23514"); // check_violation
    expect(r.message).toMatch(/ck_flow_revisions_created_by_kind|check constraint/i);
  });

  it("keeps a user-authored and a system-authored revision APART, all the way to the approval", async () => {
    const attested = await flowRepo.insertRevision(revision(1, "user", "alice@acme-hr.example"));
    const asserted = await flowRepo.insertRevision(
      revision(2, "system", systemAuthor("showcase-seed@acme-hr.example").createdBy),
    );

    // Before this column, these two rows were indistinguishable: same shape,
    // same person-shaped string, and the only difference — whether anything
    // verified it — recorded nowhere.
    expect(attested.createdByKind).toBe("user");
    expect(asserted.createdByKind).toBe("system");

    // Gate 2 copies the revision's kind onto the approval, so the audit record
    // answers "was there anybody to be the first pair of eyes" without the
    // reader knowing to join. `flow_revisions` is insert-only, so the copy can
    // never disagree with its source.
    for (const rev of [attested, asserted]) {
      await flowRepo.insertApproval({
        flowId,
        revision: rev.revision,
        approverUserId: "approver@acme-hr.example",
        approverKind: "client_admin",
        manifestFingerprint: "sha256:t",
        revisionAuthorKind: rev.createdByKind as "user" | "system",
      });
    }

    const approvals = await flowRepo.listApprovals(flowId);
    const byRevision = new Map(approvals.map((a) => [a.revision, a.revisionAuthorKind]));
    expect(byRevision.get(1)).toBe("user");
    expect(byRevision.get(2)).toBe("system");
  });

  it("tears down", async () => {
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await pool.end();
  });
});
