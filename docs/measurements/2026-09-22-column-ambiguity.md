# Measuring phase 4a.3 — how often is a column name ambiguous, really?

**Taken** 2026-09-22 · **HEAD** `b579404` + the dedupe fix below · **command**
`pnpm --filter @foundry/server ambiguity:measure` (via `./scripts/harness-in-net.sh` on macOS)

No model is involved. `compileOperation` is pure, so this touches no tenant database, opens no
DSN and writes no row — it recompiles every saved operation against that datasource's real
introspected schema and counts.

---

## The result

| | |
| :--- | ---: |
| saved operations on the deployment | **16** |
| reading more than one table | **16** |
| whose tables **share** a column name — *the control* | **16** |
| shared names in total | **42** |
| operations where the detector **fired** | **12** |
| operations that no longer compile | **0** |

**12 of 16 — 75% — of the saved operations on this deployment read at least one bare column
name that two or more of their own joined tables both carry.** Before 4a.3 every one of those
was resolved silently, to the first table in the chain, with nothing anywhere saying a choice
had been made.

### ⚠ Firing is not the same as being wrong

This measures how often the compiler **made a choice on the author's behalf**, not how often it
chose badly. The first-owner rule may well be right in all twelve. What was wrong was that the
choice was invisible; what this number bounds is how much there was to be invisible about.

### ⚠ The control is what makes the number mean anything

`0 fired` has two readings a positive-only run cannot separate — *the operations are
unambiguous* or *the detector is broken*. So the harness computes, **from the `schemas` rows
alone and never from the detector**, how many column names each operation's tables share. That
is a schema fact. All 16 operations *could* have been ambiguous; 12 were; the other four read
past every shared name.

Had the control come back at zero, the harness prints **"THIS RUN PROVES NOTHING"** rather than
a tick — the detector would never have been given a chance to fire (I-38).

---

## The four that are worth a person's eye

Not because they are known to be wrong — none has been checked against its oracle — but because
the wrong answer would be plausible, would compile, and would go green.

| operation | the column | the risk if the other table was meant |
| :--- | :--- | :--- |
| `orders_demo.order_lines_by_status` | `unit_price_cents` → `order_lines` (also on `products`) | ⚠ A **price** read from the catalogue rather than the line. CLAUDE.md's units trap, one table over. |
| `support_demo.ticket_sla_rows` | `priority` → `tickets` (also on `sla_policies`) | ⚠ The SLA budget is keyed on **(plan, priority)**. Reading the policy's own priority instead of the ticket's collapses the key. |
| `itops_demo.incident_sla_rows` | `id` → `incidents` (also on `services`, `teams`) | ⚠ Three tables, one name. `propose:measure`'s recorded failure exactly — *"an employee id equated to a department id"* — which compiled and read fluently in the readback. |
| `hr_demo.employees_with_attendance` | `id` → `employees` (also on `attendance_monthly`) | The join's own key. Correct here, and the clearest illustration that firing ≠ wrong. |

`status` is the single most-shared name, ambiguous in seven operations across three domains.

---

## ⚠ A defect the measurement found, that reading did not

The first run printed `status`, `cve` and `id` **twice each**. `resolveColumn` pushed one entry
per *call*, so a column read in both a filter and a sort was reported twice — on the review
surface, duplicate rows in the one place a person is being asked to concentrate. Noise is how a
reader learns to skim past the entry that mattered.

Fixed by deduping on **column AND winner**, unioning `alsoOn`. Pinned with a control (a dedupe
that dropped everything would otherwise pass).

⚠ **And the perturbation for the `resolvedTo` half of that key did not fire.** Keying on the
column alone passes every test. For one name to be reported twice with two different winners,
two resolutions would need different first-holders — but `owners` only ever grows during a
compile and its order is stable, so that cannot happen today. The composite key is **kept and
recorded as unreachable** rather than given a fabricated test.

---

## What this does and does not establish

**Establishes** — the gap 4a.3 closed was real and common on this deployment, not theoretical;
the detector fires on real tenant schemas and not only on fixtures; and the four operations that
dodged it did so by reading past every shared name, which a single new join would change.

**Does not establish** — that any of the twelve resolves to the wrong table. Nothing here scores
an operation against an oracle. ⚠ Only a domain oracle can say whether
`order_lines_by_status`'s `unit_price_cents` is the price anybody meant, and this harness
deliberately makes no such claim.

**Not measured** — whether authors actually use the `table.column` qualifier now that it exists.
That needs somebody building an operation after this shipped; no such row exists yet.

---

## Raw output, as taken

```

  AMBIGUOUS hiring_demo.applications_inactive_since           4 table(s)    3 shared name(s)
      status → public.applications (also on public.requisitions)
      full_name → public.candidates (also on public.recruiters)
  AMBIGUOUS hiring_demo.offers_expiring_status                4 table(s)    2 shared name(s)
      status → public.offers (also on public.applications, public.requisitions)
  AMBIGUOUS hiring_demo.outstanding_offer_rows                5 table(s)    3 shared name(s)
      full_name → public.candidates (also on public.recruiters)
      status → public.offers (also on public.applications, public.requisitions)
  dodged    hiring_demo.requisitions_by_status                2 table(s)    1 shared name(s)
  AMBIGUOUS orders_demo.open_order_line_rows                  4 table(s)    3 shared name(s)
      id → public.order_lines (also on public.orders, public.customers)
      order_id → public.order_lines (also on public.shipments)
      status → public.order_lines (also on public.orders)
  AMBIGUOUS orders_demo.order_lines_by_status                 4 table(s)    5 shared name(s)
      sku → public.order_lines (also on public.products)
      unit_price_cents → public.order_lines (also on public.products)
      status → public.order_lines (also on public.orders)
      name → public.customers (also on public.products)
  AMBIGUOUS orders_demo.orders_past_promised_date             3 table(s)    1 shared name(s)
      id → public.orders (also on public.customers)
  dodged    support_demo.csat_scores                          3 table(s)    1 shared name(s)
  AMBIGUOUS support_demo.tickets_by_status                    4 table(s)    3 shared name(s)
      name → public.customers (also on public.teams)
      team_code → public.tickets (also on public.agents)
  AMBIGUOUS support_demo.ticket_sla_rows                      6 table(s)    5 shared name(s)
      name → public.customers (also on public.teams)
      plan → public.customers (also on public.sla_policies)
      priority → public.tickets (also on public.sla_policies)
      team_code → public.tickets (also on public.agents)
  AMBIGUOUS support_demo.tickets_opened_since                 3 table(s)    2 shared name(s)
      name → public.customers (also on public.teams)
  AMBIGUOUS itops_demo.incident_sla_rows                      6 table(s)    4 shared name(s)
      id → public.incidents (also on public.services, public.teams)
      priority → public.incidents (also on public.sla_policies)
      name → public.services (also on public.teams)
      tier → public.services (also on public.sla_policies)
  dodged    itops_demo.oncall_roster_rows                     3 table(s)    1 shared name(s)
  AMBIGUOUS itops_demo.vuln_finding_rows                      7 table(s)    5 shared name(s)
      owner_team_id → public.assets (also on public.services)
      cve → public.asset_vulnerabilities (also on public.vulnerabilities)
  dodged    hr_demo.attendance_period_rows                    4 table(s)    2 shared name(s)
  AMBIGUOUS hr_demo.employees_with_attendance                 2 table(s)    1 shared name(s)
      id → public.employees (also on public.attendance_monthly)

  operations                 16
  reading more than 1 table  16
  whose tables SHARE a name  16   ← the control: a schema fact
  shared names in total      42
  detector FIRED on          12
  no longer compiling        0

the control held: 16 operation(s) COULD have been ambiguous, and 12 were.
  the rest read past every shared name — real, and a property of these
  operations rather than of the detector. A new join can change it.
```
