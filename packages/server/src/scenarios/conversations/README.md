# Builder conversations — the test corpus

Human-written goals and replies, run through the real chat builder (`builderStart` → `builderAnswer`) against each
workspace's own catalogue and data. **This corpus is the specification of what the builder must do; it is never edited
to make a run pass.** A conversation that fails is a builder defect (or, rarely, a catalogue one — say which).

Written 2026-10-01 against the data as profiled that day. Every value a goal names (a month, a status, a channel, a
leave type) exists in that workspace's data, so a gap is the builder's, not the goal's.

## The data each workspace reads (profiled 2026-10-01)

| Workspace | Datasource | What is in it |
| :--- | :--- | :--- |
| HR | `Attenadance_DB` (SQLite, **real data**) | 6,832 employees (4,133 Active), 51,778 `daily_schedule` rows **1–15 Aug 2026 only**, 2,031 absences (14 types), 27,287 leave-account rows, 431 projects, 4,702 allocations. 2,696 employees have no email. ⚠ Its `hr_*` tools read the older 62-person `hr_demo`, not this database. |
| Finance | `finance_demo` | 27 invoices (due 30 Apr – 31 Jul 2026), 18 expense claims, budgets for 2026-04/05/06, 6 cost centres. Amounts in cents; budgets in major units. |
| Customer Support (+ schema-only) | `support_demo` | 18 tickets opened 1–14 Jun 2026, plans enterprise/business/starter, teams billing/tech/onboard. |
| Orders & Fulfilment (+ schema-only) | `orders_demo` | 12 orders (promised 8–30 Jun 2026), lines, shipments, inventory in 3 warehouses. |
| Recruitment | `hiring_demo` | 16 applications, 3 offers (one outstanding, expires 18 Jun 2026), 6 requisitions. |
| Legal | `legal_demo` | 24 contracts (end dates Dec 2025 – Dec 2027), 22 obligations, 20 clauses with risk ratings. |
| IT Operations | `itops_demo` | 30 incidents (P1–P4), 12 vulnerabilities (KEV flags), 14 assets (prod/nonprod). |
| Fleet Telemetry | `fleet_demo` | 41 devices, 3,089 readings 28–30 Jun 2026, per-class temperature and battery limits. |

Chat channels that exist: `#hr-ops #hr-announcements #eng-leads #compliance #finance-ops #ap-alerts #legal-ops
#contracts-renewals #it-incidents #it-changes #support-floor #support-escalations #fulfilment #order-exceptions`.

## The format (`corpus.json`)

```jsonc
{
  "id": "H03",                         // stable; a result row is keyed by it
  "workspace": "HR",                   // by name
  "kinds": ["multi-table", "rate", "threshold"],
  "goal": "…",                         // the person's first message, as a person types it
  "replies": [                         // how the person answers, matched in order against each question asked
    { "when": "which month|period", "say": "August 2026" }
  ],
  "then": ["…"],                       // later messages after the build finishes (an edit, a repair) — optional
  "expect": {
    "outcome": "complete",             // or "gap": the data genuinely cannot give it, and the builder must SAY so
    "maxQuestions": 1,
    "has": ["branch", "email"],        // step kinds / actions the flow must contain — only what ANY correct flow must have
    "tests": ["budget"],               // a word per stated condition; some step must test it (see below)
    "truth": "…"                       // the right answer on the real data, in words (not machine-checked)
  }
}
```

**`has` names only what the person's words force.** An action asked for (`email`, `ticket`, `chat`, `page`), a `schedule`, an
`approval`, a `loop` for "each". `branch` only where the words CHOOSE between different actions ("if … raise a ticket, otherwise
email me"). A condition with one action and "otherwise nothing" can be applied by the read itself, and a shape word there fails a
correct flow while passing a wrong one.

**`tests` checks the condition is applied, wherever it is.** Each word must appear in what the flow tests: a branch condition, a
filter step's comparisons, a written read's filters and having, a reader's literal inputs, or the chosen saved reader's own
filters / `WHERE`. Projection does not count: a field shown is not a field tested. **Words name the DATA** — a field or a
value the condition must test (`status`, `Sick Leave` → `sick`, `promised_date` → `promised`), read off the schema; never the
person's paraphrase ("open" is `status != resolved` in a correct flow), and never copied from a build. Where the schema holds the
thing under two names, list both as `a|b` (H05: `v_time_account` has `balance` and `available`).

The harness answers every question by the first `replies` entry whose `when` (a case-insensitive regex) matches the
question. Questions no entry matches get the shared defaults below, and anything else is "leave it". **A conversation
that reaches "leave it" has failed**, because a person was asked something the goal already said or that nobody can
answer.

Shared defaults: an assumptions question ("By … I took …", "I read these …") → `yes`. A recipient or address question
→ `foundry-test-ops@microland.com`. A run-time month question → the month the goal names, else `the month it runs`.

Addresses are placeholders on `microland.com`, the one domain this deployment's mail allowlist
(`MAIL_ALLOWED_RECIPIENT_DOMAINS`) accepts. The engine refuses reserved `.example` domains on any address, so a
conversation naming one could never finish, whatever the builder did (P5-I2). No mail is sent: builds never send, and
`--run` skips any flow calling a tool that leaves the stack, real mail included.

## Core and extended

`corpus.json` is the **12-conversation core** the harness runs by default: HR's real database (aggregate and period, loop,
approval, schedule with CSV, a stated gap, a vague goal, an edit), Finance (a date, a branch over units), and one
branch-and-action case each from Customer Support, Orders and Legal. The other 18 are in `corpus-extended.json` and run
with `--all`. `--only=` searches both.
