/**
 * THE QUOTING CHECK — the half of I-118 that does not depend on the model.
 *
 * Two halves to this file, and the second is the one that matters. The
 * positives are easy: a Prisma-shaped schema, SQL written bare, a finding. The
 * NEGATIVES are the control on I-62 — a guard that fires on correct SQL gets
 * widened until the widening permits the defect, so every legal shape that
 * *resembles* the defect is pinned here as producing nothing.
 *
 * The lower-case regression arm is load-bearing on its own: `hr_demo`,
 * `finance_demo` and `legal_demo` are all lower-case snake_case, and this check
 * must be incapable of saying anything about them.
 */
import { describe, expect, it } from "vitest";
import { bareWords, checkIdentifierQuoting } from "./db-identifier-quoting.js";
import type { SchemaRow } from "../repositories/schema.repo.js";

function row(
  entityName: string,
  columnName: string | null,
  extra: Partial<SchemaRow> = {},
): SchemaRow {
  return {
    id: `${entityName}.${columnName ?? "_"}`,
    datasourceId: "ds1",
    entityType: "table",
    entitySchema: "public",
    entityName,
    columnName,
    columnType: "text",
    isPrimaryKey: false,
    isForeignKey: false,
    foreignKeyReference: null,
    nullable: true,
    characterMaximumLength: null,
    rowCountEstimate: null,
    nullPercentage: null,
    extractedAt: new Date("2026-09-17T00:00:00Z"),
    ...extra,
  } as SchemaRow;
}

/** The shape that produced the bug: PascalCase tables, camelCase columns. */
const PRISMA: SchemaRow[] = [
  row("User", null),
  row("User", "id"),
  row("User", "email"),
  row("User", "firstName"),
  row("User", "createdAt"),
  row("User", "emailVerified"),
  row("Post", null),
  row("Post", "id"),
  row("Post", "authorId"),
  row("Post", "publishedAt"),
];

/** The shape every existing demo datasource has. */
const SNAKE: SchemaRow[] = [
  row("invoices", null),
  row("invoices", "invoice_code"),
  row("invoices", "due_date"),
  row("invoices", "amount_cents"),
  row("customers", null),
  row("customers", "id"),
  row("customers", "name"),
];

const msgs = (p: { message: string }[]) => p.map((x) => x.message).join(" || ");

describe("the measured failure", () => {
  it("flags the exact SQL that came back from the live datasource", () => {
    const problems = checkIdentifierQuoting(
      "SELECT id, email, firstName, createdAt FROM public.User ORDER BY email",
      PRISMA,
    );
    expect(problems.map((p) => p.code)).toEqual(
      problems.map(() => "unquoted_identifier" as const),
    );
    expect(msgs(problems)).toContain("firstName");
    expect(msgs(problems)).toContain("createdAt");
    expect(msgs(problems)).toContain("User");
  });

  it("flags the half-quoted second measurement — quoted table, bare column", () => {
    const problems = checkIdentifierQuoting(
      'SELECT firstName FROM "public"."User"',
      PRISMA,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("firstName");
  });

  it("names the identifier AND shows the quoted form to write instead", () => {
    const [p] = checkIdentifierQuoting("SELECT firstName FROM x", PRISMA);
    expect(p!.message).toContain('"firstName"');
    expect(p!.message).toContain("firstname"); // what it would actually ask for
  });

  it("reports each offending identifier once, however often it appears", () => {
    const problems = checkIdentifierQuoting(
      "SELECT firstName FROM public.User WHERE firstName IS NOT NULL ORDER BY firstName",
      PRISMA,
    );
    expect(problems.filter((p) => p.message.includes("firstName"))).toHaveLength(1);
  });
});

describe("what it must never flag — the I-62 control", () => {
  it("says nothing about fully quoted SQL", () => {
    expect(
      checkIdentifierQuoting(
        'SELECT "u"."firstName", "u"."createdAt" FROM "public"."User" AS "u" ' +
          'JOIN "public"."Post" AS "p" ON "p"."authorId" = "u"."id" ' +
          'WHERE "u"."emailVerified" = $1 ORDER BY "u"."createdAt" LIMIT 500',
        PRISMA,
      ),
    ).toEqual([]);
  });

  it("CANNOT produce a finding against a lower-case snake_case schema", () => {
    // The regression arm: hr_demo / finance_demo / legal_demo are all this shape.
    // Bare here is correct SQL, and so is quoted.
    expect(
      checkIdentifierQuoting(
        "SELECT invoice_code, due_date FROM public.invoices WHERE due_date < $1",
        SNAKE,
      ),
    ).toEqual([]);
    expect(
      checkIdentifierQuoting(
        'SELECT "invoice_code" FROM "public"."invoices" WHERE "due_date" < $1',
        SNAKE,
      ),
    ).toEqual([]);
  });

  it("ignores the name inside a string literal", () => {
    expect(
      checkIdentifierQuoting(
        `SELECT 'firstName' AS label, 'public.User' AS src FROM "public"."User"`,
        PRISMA,
      ),
    ).toEqual([]);
  });

  it("ignores the name inside a comment, line and block", () => {
    expect(
      checkIdentifierQuoting(
        'SELECT "id" -- firstName was dropped\nFROM "public"."User" /* see public.User */',
        PRISMA,
      ),
    ).toEqual([]);
  });

  it("ignores an explicit AS alias, and a later reference to it", () => {
    expect(
      checkIdentifierQuoting(
        'SELECT "u"."firstName" AS firstName FROM "public"."User" AS "u" ORDER BY firstName',
        PRISMA,
      ),
    ).toEqual([]);
  });

  it("ignores an implicit alias after a quoted identifier or a closing paren", () => {
    expect(
      checkIdentifierQuoting('SELECT "u"."firstName" firstName FROM "public"."User" "u"', PRISMA),
    ).toEqual([]);
    expect(
      checkIdentifierQuoting('SELECT coalesce("u"."firstName", $1) firstName FROM "public"."User" "u"', PRISMA),
    ).toEqual([]);
  });

  it("ignores a different spelling — bare `user` is not proof of a reference to `User`", () => {
    // `user` is a Postgres reserved word. Only the catalog's own spelling is proof.
    expect(checkIdentifierQuoting('SELECT current_user, user FROM "public"."User"', PRISMA)).toEqual([]);
  });

  it("ignores a name whose folded form is ALSO a real identifier", () => {
    const both = [...PRISMA, row("user", null), row("user", "id")];
    expect(checkIdentifierQuoting("SELECT id FROM public.User", both)).toEqual([]);
  });

  it("never flags a keyword, a function name or a parameter", () => {
    // `count`/`now` are lower case so they could not be flagged anyway; the
    // assertion that carries weight is that no finding mentions them.
    const problems = checkIdentifierQuoting(
      'SELECT count(*), now() FROM "public"."User" WHERE "createdAt" > $1',
      PRISMA,
    );
    expect(problems).toEqual([]);
  });
});

describe("the scanner underneath it", () => {
  it("does not read a quoted identifier or a literal as words", () => {
    expect(bareWords(`SELECT "a b" FROM t WHERE x = 'y z'`).map((w) => w.word)).toEqual([
      "SELECT",
      "FROM",
      "t",
      "WHERE",
      "x",
    ]);
  });

  it("records what precedes a word, which is the whole alias exclusion", () => {
    const ws = bareWords('SELECT "u"."c" alias, t.col FROM x');
    expect(ws.find((w) => w.word === "alias")!.prev).toBe('"');
    expect(ws.find((w) => w.word === "col")!.prev).toBe(".");
    expect(ws.find((w) => w.word === "t")!.prev).toBe(",");
  });

  it("does not let a comma-separated word inherit the previous one as prevWord", () => {
    // Without this, `SELECT as_of, firstName` would read `as_of` as an alias
    // keyword for the next token. (It is `prevWord === "as"` that excludes.)
    const ws = bareWords("SELECT a, b");
    expect(ws.find((w) => w.word === "b")!.prevWord).toBeNull();
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The OTHER direction — a quoted identifier that matches nothing real.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the failure mode the quoting rule itself introduces, measured at the
 * wire on the same database:
 *
 *     SELECT Email   FROM "public"."User"  -> OK    (folds to `email`)
 *     SELECT "Email" FROM "public"."User"  -> FAIL  column "Email" does not exist
 *
 * ⚠ Its most important case is on a SNAKE_CASE schema, because that is where the
 * new rule could REGRESS something that works today: those datasources produce
 * no fold findings at all, so if this half were gated behind "does this schema
 * need quoting", it would be switched off precisely where it is needed.
 */
describe("a quoted identifier that is not how the schema spells it", () => {
  it("catches the mis-cased quote the rule itself invites", () => {
    const p = checkIdentifierQuoting(`SELECT "Email" FROM "public"."User"`, PRISMA);
    expect(p.map((x) => x.code)).toContain("misquoted_identifier");
    // The finding has to carry the spelling that works, or it is a complaint
    // rather than a fix.
    expect(msgs(p)).toContain(`"email"`);
  });

  it("⚠ fires on a LOWER-CASE schema, which has no fold findings at all", () => {
    // The regression guard. `SNAKE` needs no quoting anywhere, so an
    // implementation that returns early when nothing needs quoting reports
    // nothing here — and every existing demo datasource loses the check.
    const p = checkIdentifierQuoting(`SELECT "Due_Date" FROM "invoices"`, SNAKE);
    expect(p.map((x) => x.code)).toEqual(["misquoted_identifier"]);
    expect(msgs(p)).toContain(`"due_date"`);
  });

  it("accepts the correct spelling", () => {
    expect(checkIdentifierQuoting(`SELECT "firstName" FROM "public"."User"`, PRISMA)).toEqual([]);
    expect(checkIdentifierQuoting(`SELECT "due_date" FROM "invoices"`, SNAKE)).toEqual([]);
  });

  it("does NOT flag an alias, however it collides", () => {
    // Aliasing to a prettier name is a thing people do, and an output column may
    // be called anything. This is the exclusion that matters most (I-62).
    expect(
      checkIdentifierQuoting(`SELECT "firstName" AS "FirstName" FROM "public"."User"`, PRISMA),
    ).toEqual([]);
  });

  it("does NOT flag an implicit table alias", () => {
    expect(
      checkIdentifierQuoting(`SELECT "U"."firstName" FROM "public"."User" "U"`, PRISMA),
    ).toEqual([]);
  });

  it("does NOT flag a name matching nothing at all — no proof, no finding", () => {
    // `"user_id"`, `"recent"`, `"total"`: an alias, a CTE, a derived column.
    // There is no real identifier it could be a mis-spelling OF.
    expect(
      checkIdentifierQuoting(`SELECT "id" AS "user_id", 1 AS "total" FROM "public"."User"`, PRISMA),
    ).toEqual([]);
    expect(checkIdentifierQuoting(`SELECT "nonsense" FROM "public"."User"`, PRISMA)).toEqual([]);
  });

  it("does NOT read a string literal as an identifier", () => {
    expect(checkIdentifierQuoting(`SELECT 'Email' AS kind FROM "public"."User"`, PRISMA)).toEqual([]);
  });

  it("reports both directions from one statement", () => {
    // The realistic half-fixed state: the table quoted by hand, the columns not,
    // and one column quoted wrongly.
    const p = checkIdentifierQuoting(
      `SELECT firstName, "CreatedAt" FROM "public"."User"`,
      PRISMA,
    );
    expect(p.map((x) => x.code).sort()).toEqual(["misquoted_identifier", "unquoted_identifier"]);
  });
});
