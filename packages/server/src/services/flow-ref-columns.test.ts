/**
 * `checkRefOutputFields` — against the fourteen cases that were MEASURED on the
 * live deployment, not against invented ones. 2026-09-08
 *
 * ⚠ **Every expression in `MEASURED` is verbatim from a `flow_revisions` row**
 * on this deployment, and the column lists are verbatim from each operation's
 * `spec_json`. That is the point: the check exists because a real run failed
 * (`3VRhNsJO8222ebwGOQClFH`, `{"to":["Expected string, received null"]}`) and
 * because a scan then found the same defect in 14 of 29 transform steps. A
 * fixture I wrote myself would prove the regex matches my own idea of the bug.
 *
 * ⚠ **`rank_customers` is the reason this check is stage-aware.** It reads
 * `.amount_owed` in `sort_by`, off an object jq itself built one stage earlier —
 * so that name is CORRECT and must not be reported, while `.amount` and
 * `.customer` in the earlier stages are genuinely wrong. A flat name-list
 * version of this check reported `amount_owed` too, which is I-62's failure:
 * a guard that cries wolf gets widened, and the widening permits the defect.
 * The `expectExcluded` column pins that it stays unreported.
 */
import { describe, expect, it } from "vitest";
import { checkRefOutputFields, fieldsReadFrom, jqStages, rowSourceOf, stripStrings } from "./flow-ref-columns.js";

const ORDERS = ["order_id", "order_code", "customer_id", "channel", "placed_at", "promised_at", "order_status"];
const FINANCE = ["invoice_id", "invoice_number", "vendor_id", "amount_cents", "currency", "due_date", "status"];
const SUPPORT = ["ticket_id", "ticket_code", "subject", "status", "opened_priority", "priority", "opened_at", "first_response_at", "resolved_at", "team_name", "assignee_name", "customer_name"];
const HIRING = ["offer_id", "application_id", "candidate_name", "candidate_email", "offer_status", "made_at", "expires_at", "accepted_at"];

/** [name, the operation's real projection, the real jq program, what must be reported] */
const MEASURED: Array<[string, string[], string, string[]]> = [
  ["finance/top_customers", FINANCE, "group_by(.customer) | map({customer: .[0].customer, amount: (map(.amount) | add)}) | sort_by(.amount) | reverse", ["amount", "customer"]],
  ["finance/rank_customers", FINANCE, "group_by(.customer) | map({customer: .[0].customer, amount_owed: (map(.amount) | add)}) | sort_by(.amount_owed) | reverse", ["amount", "customer"]],
  ["support/missed_target_tickets", SUPPORT, "[.[] | select(.target_met == false)]", ["target_met"]],
  ["support/longest_waiting_reply", SUPPORT, "sort_by(.last_customer_message_at) | first", ["last_customer_message_at"]],
  ["support/longest_waiting", SUPPORT, '[.[] | select(.status == "waiting_for_reply")] | sort_by(.created_at) | first', ["created_at"]],
  ["support/longest_waiting_ticket", SUPPORT, "sort_by(.updated_at) | .[0]", ["updated_at"]],
  ["orders/customer_late_order_emails", ORDERS, '[.[] | {to: [.customer_email], subject: "Your order is late", body: tostring}]', ["customer_email"]],
  ["orders/customer_notifications", ORDERS, '[.[] | {to: [(.customer_email // .email)], subject: "x", body: ((.order_id // .id) | tostring)}]', ["customer_email", "email", "id"]],
  ["hiring/expiring_offer_reminder", HIRING, "map({candidate: .candidate, offer: .offer, expires_at: .expires_at})", ["candidate", "offer"]],
  ["hiring/candidate_process_summary", HIRING, "map({candidate: .candidate, application: .application})", ["application", "candidate"]],
  ["hiring/oldest_roles", HIRING, "sort_by(.opened_at)", ["opened_at"]],
];

function flowReading(program: string) {
  return {
    steps: [
      { id: "src", kind: "query", ref: "d.op" },
      {
        id: "t",
        kind: "transform",
        dependsOn: ["src"],
        expr: `{{ json(outputs.src.body).results[0].data | jq('${program.replace(/'/g, "\\'")}') | first }}`,
      },
    ],
  } as never;
}

describe("checkRefOutputFields — the measured cases", () => {
  for (const [name, columns, program, expected] of MEASURED) {
    it(`reports exactly the absent columns in ${name}`, () => {
      const findings = checkRefOutputFields(flowReading(program), { "d.op": { columns } });
      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe("unknown_output_column");
      expect(findings[0].blocking).toBe(true);
      expect(findings[0].facts?.missing).toEqual(expected);
      // The list IS the finding — a redraft without it is a second guess.
      expect(findings[0].facts?.returns).toEqual(columns);
      for (const c of columns) expect(findings[0].message).toContain(c);
    });
  }

  it("does NOT report a key jq built in an earlier stage (the I-62 false positive)", () => {
    const [, columns, program] = MEASURED[1];
    const findings = checkRefOutputFields(flowReading(program), { "d.op": { columns } });
    expect(findings[0].facts?.missing).not.toContain("amount_owed");
  });

  it("DOES report a read whose key is built in the SAME object literal", () => {
    // `map({candidate: .candidate})` — the read is a sibling of the key, not
    // downstream of it, so three of the fourteen cases live here.
    const findings = checkRefOutputFields(
      flowReading("map({candidate: .candidate})"),
      { "d.op": { columns: HIRING } },
    );
    expect(findings[0].facts?.missing).toEqual(["candidate"]);
  });
});

describe("checkRefOutputFields — what it must stay silent about", () => {
  it("says nothing when every column exists", () => {
    expect(
      checkRefOutputFields(
        flowReading('[.[] | {to: [.candidate_email], subject: "x"}]'),
        { "d.op": { columns: HIRING } },
      ),
    ).toEqual([]);
  });

  it("says nothing when the ref declares no columns — a tool or a named query", () => {
    expect(
      checkRefOutputFields(flowReading("[.[] | {to: [.whatever]}]"), { "d.op": {} }),
    ).toEqual([]);
  });

  it("treats an EMPTY column list exactly like an absent one", () => {
    // `refInterfaces` omits the field rather than emitting `[]`, but that is a
    // presentation choice with nothing depending on it — so the behaviour is
    // pinned here rather than asserted in a comment nobody can perturb.
    expect(
      checkRefOutputFields(flowReading("[.[] | {to: [.whatever]}]"), { "d.op": { columns: [] } }),
    ).toEqual([]);
  });

  it("says nothing when the ref is absent from the interfaces entirely", () => {
    expect(checkRefOutputFields(flowReading("[.[] | {to: [.whatever]}]"), {})).toEqual([]);
  });

  it("says nothing about an envelope read — the jq input is not a row", () => {
    const model = {
      steps: [
        { id: "src", kind: "query", ref: "d.op" },
        { id: "t", kind: "transform", dependsOn: ["src"], expr: "{{ json(outputs.src.body) | jq('.succeeded') }}" },
      ],
    } as never;
    expect(checkRefOutputFields(model, { "d.op": { columns: HIRING } })).toEqual([]);
  });

  it("says nothing when two upstream steps are read — the jq input is ambiguous", () => {
    const model = {
      steps: [
        { id: "a", kind: "query", ref: "d.op" },
        { id: "b", kind: "query", ref: "d.op" },
        {
          id: "t",
          kind: "transform",
          dependsOn: ["a", "b"],
          expr:
            "{{ (json(outputs.a.body).results[0].data + json(outputs.b.body).results[0].data) | jq('[.[] | {x: .nope}]') }}",
        },
      ],
    } as never;
    expect(checkRefOutputFields(model, { "d.op": { columns: HIRING } })).toEqual([]);
  });

  it("says nothing about jq builtins written with a leading dot", () => {
    expect(
      checkRefOutputFields(flowReading("[.[] | {n: (.candidate_email | length)}]"), {
        "d.op": { columns: HIRING },
      }),
    ).toEqual([]);
  });
});

describe("jqStages — the split the check depends on", () => {
  it("splits at top-level pipes only", () => {
    expect(jqStages("a | b | c").map((s) => s.trim())).toEqual(["a", "b", "c"]);
  });

  it("does not split a pipe inside parentheses, brackets or braces", () => {
    expect(jqStages("map(.a | b) | c")).toHaveLength(2);
    expect(jqStages("[.a | b]")).toHaveLength(1);
    expect(jqStages("{k: (.a | b)}")).toHaveLength(1);
  });

  it("does not split a pipe inside a string", () => {
    expect(jqStages("select(.a == \"x | y\") | b")).toHaveLength(2);
  });
});

describe("rowSourceOf", () => {
  it("names the one step whose rows feed the program", () => {
    expect(rowSourceOf("{{ json(outputs.src.body).results[0].data | jq('.') }}")).toBe("src");
  });

  it("is null without a .results[…].data read", () => {
    expect(rowSourceOf("{{ json(outputs.src.body) | jq('.') }}")).toBeNull();
  });

  it("is null with no step read at all", () => {
    expect(rowSourceOf("{{ inputs.as_of }}")).toBeNull();
  });
});

// ── ⚠ String literals: the false positive a real authoring attempt hit ──────

describe("stripStrings", () => {
  it("⚠ does not read columns out of a dotted string literal", () => {
    /**
     * ⚠ **THE REPORTED FAILURE.** Saving this flow was refused with *'reads
     * "com", "saini" from "unhappy_responses", which returns no such column'* —
     * because `sender: "himanshu.saini@microland.com"` has two dots in it. Any
     * dotted literal reproduces it: a hostname, a filename, a version number.
     * I-62 exactly, and in the direction that gets a guard widened until the
     * widening permits the defect.
     */
    expect(stripStrings('{sender: "himanshu.saini@microland.com"}')).not.toContain("saini");
    expect(stripStrings('{sender: "himanshu.saini@microland.com"}')).not.toContain(".com");
  });

  it("⚠ KEEPS what an interpolation reads — that is a real column access", () => {
    // jq's `"\(.customer_name)"` reads a column from inside a string. Stripping
    // literals wholesale would trade a false positive for a false NEGATIVE,
    // silently, in the direction this module exists to prevent.
    const out = stripStrings('"Hello \\(.customer_name), ticket \\(.ticket_code)"');
    expect(out).toContain(".customer_name");
    expect(out).toContain(".ticket_code");
  });

  it("separates adjacent interpolations so two names cannot fuse into one", () => {
    const out = stripStrings('"\\(.a)\\(.b)"');
    expect(out.match(/\.[a-z]+/g)).toEqual([".a", ".b"]);
  });

  it("honours nested parens inside an interpolation", () => {
    const out = stripStrings('"n=\\((.rows | length))"');
    expect(out).toContain(".rows");
  });

  it("⚠ an escaped quote does not end the literal early", () => {
    // Otherwise the rest of the program goes unscanned — a silent false
    // negative for every expression after the escape.
    const out = stripStrings('"say \\"hi\\" to .nobody" | .real_column');
    expect(out).not.toContain("nobody");
    expect(out).toContain(".real_column");
  });

  it("leaves a single quote alone — jq has no single-quoted string", () => {
    /**
     * ⚠ **DEFENSIVE, AND NO PERTURBATION REACHES IT — said here rather than
     * implied.** Making `'` open a literal too was tried and reddened nothing:
     * `jqPrograms` hands over the inside of `jq('…')`, so a lone `'` outside a
     * double-quoted literal is not valid jq and does not occur. An apostrophe
     * inside a double-quoted string is already consumed as an ordinary
     * character by the branch above, so it never reaches this one either.
     *
     * The double-quote-only rule stays because it is correct and because the
     * alternative would swallow a whole program if the input ever did carry a
     * stray quote. Kept for the reason `grep -a` is kept in
     * `ci/secret-policy.sh`.
     */
    expect(stripStrings(".it's_fine")).toContain(".it");
    expect(stripStrings("'not a string' | .real_column")).toContain(".real_column");
  });
});

describe("checkRefOutputFields, against a string literal", () => {
  it("⚠ passes the flow that was refused", () => {
    // The whole reported expression, with the email addresses that broke it.
    const flow = {
      steps: [
        { id: "rows", kind: "query" as const, ref: "support_demo.csat_scores", paramsExpr: "[{}]" },
        {
          id: "msg",
          kind: "transform" as const,
          expr:
            "{{ json(outputs.rows.body).results[0].data | jq('[{subject: \"Unhappy survey warning\", " +
            "body: (map(.ticket_code + \": \" + .subject) | join(\"; \")), " +
            "sender: \"himanshu.saini@microland.com\", " +
            "recipients: [\"himanshu.saini@microland.com\"]}]') | first }}",
          dependsOn: ["rows"],
        },
      ],
    };
    const findings = checkRefOutputFields(flow as never, {
      "support_demo.csat_scores": {
        kind: "operation",
        columns: ["score", "comment", "ticket_code", "subject", "customer_name", "customer_email"],
      } as never,
    });
    expect(findings).toEqual([]);
  });

  it("still catches a genuinely absent column beside a dotted literal", () => {
    // The control. If the strip were too eager this would go quiet, and the
    // check would be passing everything.
    const flow = {
      steps: [
        { id: "rows", kind: "query" as const, ref: "support_demo.csat_scores", paramsExpr: "[{}]" },
        {
          id: "msg",
          kind: "transform" as const,
          expr:
            "{{ json(outputs.rows.body).results[0].data | jq('[{to: .vendor_email, " +
            'from: "a.b@c.example"}]\') | first }}',
          dependsOn: ["rows"],
        },
      ],
    };
    const findings = checkRefOutputFields(flow as never, {
      "support_demo.csat_scores": {
        kind: "operation",
        columns: ["score", "ticket_code", "customer_email"],
      } as never,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].message).toContain("vendor_email");
    expect(findings[0].message).not.toContain("example");
  });
});

/**
 * ── 2026-09-17 — step-local SQL, and jq's object SHORTHAND ──────────────────
 *
 * ⚠ **Every fixture below is verbatim from `flow_steps` on this deployment**,
 * exactly as the block at the top of this file demands. The four flows were
 * found by running the check over all 27 revisions before the change shipped;
 * all four are true positives, verified against each statement's own SQL.
 *
 * Two independent gaps had to close before flow `264234b4` could be caught, and
 * either alone leaves it silent:
 *
 *  1. **No shape.** Its reader is step-local SQL naming a ref that does not
 *     exist, so `RefInterface.columns` was `undefined` and this check said
 *     nothing. `selectProjection` reads the projection out of the statement.
 *  2. **No read.** `{partner_count}` is jq's shorthand for
 *     `{partner_count: .partner_count}` — no dot, so `readsIn` missed it; no
 *     colon, so `keysIn` missed it too. The check had the projection and still
 *     saw nothing to compare.
 */
describe("step-local SQL supplies the shape its ref cannot", () => {
  const step = (over: Record<string, unknown>) => ({
    id: "reader",
    kind: "datasource" as const,
    ref: "ML_ZERO_DB.partners_onboarded_count",
    datasourceRef: "ML_ZERO_DB",
    sql: 'SELECT count(*) AS "onboarded_count" FROM "public"."partners_user"',
    ...over,
  });
  const consumer = (expr: string) => ({
    id: "write_report",
    kind: "tool" as const,
    ref: "llm_complete",
    paramsExpr: `[{"input": {{ json(outputs.reader.body).results[0].data | jq('${expr}') | first }}}]`,
  });

  /** ⚠ THE REPORTED DEFECT, reproduced. Flow `264234b4`, revision 2. */
  it("catches `map({partner_count})` over a statement projecting onboarded_count", () => {
    const findings = checkRefOutputFields(
      { steps: [step({}), consumer("map({partner_count}) | tostring | @json")] } as never,
      {},
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.facts).toMatchObject({ missing: ["partner_count"] });
    expect(findings[0]!.facts).toMatchObject({ returns: ["onboarded_count"] });
    expect(findings[0]!.blocking).toBe(true);
  });

  /**
   * ⚠ CONTROL. Without it, a check that flags every shorthand read scores 100%
   * on the assertion above while refusing every correct flow on the deployment.
   */
  it("CONTROL: the SAME shape with the right name is silent", () => {
    expect(
      checkRefOutputFields(
        { steps: [step({}), consumer("map({onboarded_count}) | tostring | @json")] } as never,
        {},
      ),
    ).toEqual([]);
  });

  /**
   * ⚠ This asserted that the shorthand registers as a CONSTRUCTED key, and a
   * perturbation showed the assertion could not fail — removing that half of the
   * change left it green. It is rewritten to pin what is actually true: a
   * shorthand names the same string it reads, so a later read of it is right
   * because the name is a real COLUMN, not because a key was constructed. See
   * `keysIn`'s trailing note.
   */
  it("a later stage reading a shorthand name is silent — the name is a real column", () => {
    expect(
      checkRefOutputFields(
        { steps: [step({}), consumer("map({onboarded_count}) | sort_by(.onboarded_count)")] } as never,
        {},
      ),
    ).toEqual([]);
    // And the same shape with a name that is NOT a column is reported once,
    // however many stages mention it.
    const bad = checkRefOutputFields(
      { steps: [step({}), consumer("map({partner_count}) | sort_by(.partner_count)")] } as never,
      {},
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]!.facts).toMatchObject({ missing: ["partner_count"] });
  });

  it("an unreadable statement falls back to the stored ref rather than guessing", () => {
    // `SELECT *` yields no projection, so the ref's own columns decide.
    const findings = checkRefOutputFields(
      { steps: [step({ sql: "SELECT * FROM t" }), consumer("map({partner_count})")] } as never,
      { "ML_ZERO_DB.partners_onboarded_count": { columns: ["onboarded_count"] } },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.facts).toMatchObject({ missing: ["partner_count"] });
  });

  it("frozen SQL WINS over the stored row, because that is what the executor runs", () => {
    // The stored reader says `partner_count`; the statement actually run says
    // `onboarded_count`. Believing the stored row would report the correct read
    // as wrong — a confident finding in place of silence.
    expect(
      checkRefOutputFields(
        { steps: [step({}), consumer("map({onboarded_count})")] } as never,
        { "ML_ZERO_DB.partners_onboarded_count": { columns: ["partner_count"] } },
      ),
    ).toEqual([]);
  });

  it("says nothing when the step-local statement is not the complete shape", () => {
    // `sql` without `datasourceRef` is not a step-local read (`isStepLocalSql`),
    // and the executor would have to guess the datasource from the ref prefix.
    expect(
      checkRefOutputFields(
        { steps: [step({ datasourceRef: undefined }), consumer("map({partner_count})")] } as never,
        {},
      ),
    ).toEqual([]);
  });

  /** The other three true positives found by the pre-flight scan, verbatim. */
  it.each([
    [
      "9nyq/generate_report",
      'SELECT date_trunc(\'month\', "uploadedAt") AS month, COUNT(*) AS resume_count FROM public."ResumeFile" GROUP BY date_trunc(\'month\', "uploadedAt") ORDER BY month',
      "map({count})",
      ["count"],
    ],
    [
      // ⚠ `active` is a WHERE column, never projected — the author read the filter.
      "j9pr/active_centres",
      "SELECT id, code, name, owner_email FROM public.cost_centres WHERE active = TRUE ORDER BY name",
      "map({id, code, active})",
      ["active"],
    ],
  ])("catches %s", (_name, sql, expr, missing) => {
    const findings = checkRefOutputFields(
      { steps: [step({ sql }), consumer(expr)] } as never,
      {},
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.facts).toMatchObject({ missing });
  });
});

describe("jq object shorthand is not confused with ordinary syntax", () => {
  const cols = ["a", "b"];
  const probe = (expr: string) =>
    checkRefOutputFields(
      {
        steps: [
          { id: "r", kind: "datasource", ref: "d.q" },
          {
            id: "c",
            kind: "tool",
            ref: "t",
            paramsExpr: `[{"x": {{ json(outputs.r.body).results[0].data | jq('${expr}') | first }}}]`,
          },
        ],
      } as never,
      { "d.q": { columns: cols } },
    );

  it("reports a shorthand naming a column that is not there", () => {
    expect(probe("map({nope})")[0]!.facts).toMatchObject({ missing: ["nope"] });
  });

  it.each([
    ["an explicit key is not a shorthand read", "map({nope: .a})"],
    ["a function call is not an object", "map(select(.a, .b))"],
    ["an array is not an object", "map([.a, .b])"],
    ["a quoted key is a key, not a read", 'map({"nope": .a})'],
    ["a string containing braces is left alone", 'map({a: "{nope}"})'],
  ])("%s", (_what, expr) => {
    expect(probe(expr)).toEqual([]);
  });
});

/**
 * `fieldsReadFrom` — the CONSUMER CONTRACT a gap proposer is handed.
 *
 * ⚠ The fixture is flow `264234b4`'s sibling failure, verbatim from the UAT
 * report of 2026-09-17: a transform reading six names off a reader that was
 * about to be written by a different inference call, blind.
 */
describe("fieldsReadFrom — what the next step needs the SQL to be called", () => {
  const model = (expr: string) =>
    ({
      steps: [
        { id: "offer_rows", kind: "datasource", ref: "ML_ZERO_DB.candidates_with_job_offers" },
        {
          id: "report_rows",
          kind: "transform",
          expr: `{{ json(outputs.offer_rows.body).results[0].data | jq('${expr}') | first }}`,
        },
      ],
    }) as never;

  it("collects every row field the consuming step reads", () => {
    expect(
      fieldsReadFrom(
        model(
          "map({candidate_email, candidate_name, job_title, offer_expired, offer_revoked, recruiter_email})",
        ),
        "offer_rows",
      ),
    ).toEqual([
      "candidate_email",
      "candidate_name",
      "job_title",
      "offer_expired",
      "offer_revoked",
      "recruiter_email",
    ]);
  });

  it("reads dotted access as well as the shorthand", () => {
    expect(fieldsReadFrom(model("[.[] | {to: .email, name: .full_name}]"), "offer_rows")).toEqual([
      "email",
      "full_name",
    ]);
  });

  it("excludes what jq built itself — the same stage rule the check uses", () => {
    // `amount_owed` is constructed in stage 2 and read in stage 3, so it is not
    // something the SQL must supply. Asking the proposer for it would send it
    // hunting for a column that was never meant to exist.
    expect(
      fieldsReadFrom(
        model("group_by(.customer) | map({customer: .[0].customer, amount_owed: 1}) | sort_by(.amount_owed)"),
        "offer_rows",
      ),
    ).toEqual(["customer"]);
  });

  it("excludes the envelope and jq builtins", () => {
    expect(fieldsReadFrom(model("sort_by(.created_at) | first | tostring"), "offer_rows")).toEqual([
      "created_at",
    ]);
  });

  it("answers EMPTY for a step nothing reads, and for an ambiguous source", () => {
    expect(fieldsReadFrom(model("map({a})"), "someone_else")).toEqual([]);
    // Two upstream steps in one expression: the jq input could be either, so
    // attributing the reads to one of them would be a guess (`rowSourceOf`).
    expect(
      fieldsReadFrom(
        {
          steps: [
            {
              id: "t",
              kind: "transform",
              expr: "{{ json(outputs.a.body).results[0].data | jq('map({x})') }} {{ json(outputs.b.body).results[0].data }}",
            },
          ],
        } as never,
        "a",
      ),
    ).toEqual([]);
  });

  /** CONTROL — without it, a function returning `[]` passes every case above. */
  it("CONTROL: it can answer non-empty", () => {
    expect(fieldsReadFrom(model("map({candidate_email})"), "offer_rows")).toEqual([
      "candidate_email",
    ]);
  });
});
