-- The IT operations / service desk demo database — `itops_demo`.
--
-- ── ALL DATA IS SYNTHETIC ────────────────────────────────────────────────────
--
-- Invented hostnames, invented people, invented CVE identifiers, every address
-- on an RFC 2606 reserved domain that can never resolve or receive mail. No CVE
-- id here corresponds to a real advisory and nothing is fetched from NVD or
-- CISA. Never replace any of it with real data.
--
-- ── THE ONE THING TO UNDERSTAND BEFORE WRITING A QUERY AGAINST THIS ──────────
--
-- **An SLA clock is not `resolved_at - opened_at`.** Two things come off it, and
-- a query that does the obvious subtraction gets a different ANSWER, not merely
-- a different number:
--
--   1. `services.business_hours_only` — for such a service the clock runs only
--      09:00–17:00 Mon–Fri (UTC). An incident opened 16:40 on a Friday and
--      resolved 09:20 the following Monday consumed FORTY MINUTES, not
--      sixty-four hours. INC-1007 is exactly that incident and it is BREACHED
--      under the naive arithmetic and comfortably healthy under the correct one.
--   2. `incident_pauses` — a span awaiting the customer is not the service
--      desk's time. INC-1009 is breached with pauses ignored and inside SLA with
--      them honoured.
--
-- INC-1012 needs BOTH corrections, so a query that applies one and not the other
-- is still wrong. That is deliberate: two independent traps that also compose.
--
-- ── AND THE POLICY KEY IS TWO COLUMNS, NOT ONE ───────────────────────────────
--
-- `sla_policies` is keyed on (tier, priority). A query that looks up a budget by
-- priority alone reads some other tier's row: a bronze P1 has 480 minutes to
-- resolve and a platinum P1 has 60. Take the wrong one and a healthy bronze
-- incident reports as breached. This is `hr_demo`'s employee #14 — the org-wide
-- default versus the departmental override — in a second domain.
--
-- ── ALL TIMESTAMPS ARE UTC AND ALL ARE LITERALS ──────────────────────────────
--
-- `timestamptz`, stored UTC, and business hours are defined in UTC too. A
-- per-service timezone would be a realistic fourth trap and is deliberately
-- ABSENT: it would make the business-hours trap harder to attribute when a query
-- got the answer wrong, and one clearly-attributable trap is worth more than two
-- entangled ones.
--
-- Nothing here is computed from the wall clock. A dataset whose traps move with
-- `now()` cannot have an oracle, and the failure is invisible until the day a
-- boundary row stops sitting on the boundary.

DROP TABLE IF EXISTS asset_vulnerabilities CASCADE;
DROP TABLE IF EXISTS vulnerabilities CASCADE;
DROP TABLE IF EXISTS assets CASCADE;
DROP TABLE IF EXISTS change_freezes CASCADE;
DROP TABLE IF EXISTS incident_pauses CASCADE;
DROP TABLE IF EXISTS incidents CASCADE;
DROP TABLE IF EXISTS on_call CASCADE;
DROP TABLE IF EXISTS sla_policies CASCADE;
DROP TABLE IF EXISTS services CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS org_settings CASCADE;

-- Org-wide defaults. The escalation fallback lives here and is deliberately
-- unequal to every team's own `escalation_email`, so a query that skips the
-- team-level hop resolves a DIFFERENT address rather than the same one by luck.
CREATE TABLE org_settings (
  key          text PRIMARY KEY,
  value        text NOT NULL,
  description  text NOT NULL
);

CREATE TABLE teams (
  id                integer PRIMARY KEY,
  team_code         text NOT NULL UNIQUE,
  name              text NOT NULL,
  -- Where routine work goes.
  contact_email     text NOT NULL,
  -- ⚠ Where a BREACH goes, and it is a different address on purpose. A flow that
  -- sends a breach to `contact_email` has not escalated it — it has filed it in
  -- the same inbox as the at-risk warnings nobody is paged for.
  escalation_email  text,
  timezone          text NOT NULL
);

CREATE TABLE services (
  id                  integer PRIMARY KEY,
  service_code        text NOT NULL UNIQUE,
  name                text NOT NULL,
  -- platinum | gold | silver | bronze. Half of the SLA policy key.
  tier                text NOT NULL,
  owner_team_id       integer NOT NULL REFERENCES teams(id),
  -- ⚠ THE HEADLINE TRAP. See the header.
  business_hours_only boolean NOT NULL,
  criticality_note    text
);

-- ⚠ TWO-COLUMN KEY. Neither column identifies a row on its own.
CREATE TABLE sla_policies (
  tier          text NOT NULL,
  priority      text NOT NULL,
  respond_mins  integer NOT NULL,
  resolve_mins  integer NOT NULL,
  PRIMARY KEY (tier, priority)
);

CREATE TABLE on_call (
  id              integer PRIMARY KEY,
  team_id         integer NOT NULL REFERENCES teams(id),
  -- Half-open: [starts_at, ends_at). A closed upper bound double-covers the
  -- handover instant and a "who is on call" query returns two people.
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  person_name     text NOT NULL,
  person_email    text NOT NULL,
  escalation_to   text
);

CREATE TABLE incidents (
  id               integer PRIMARY KEY,
  incident_code    text NOT NULL UNIQUE,
  service_id       integer NOT NULL REFERENCES services(id),
  -- P1 | P2 | P3 | P4. The other half of the policy key.
  priority         text NOT NULL,
  summary          text NOT NULL,
  status           text NOT NULL,
  opened_at        timestamptz NOT NULL,
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  assignee_email   text,
  -- Set on the handful of incidents raised by an automated check rather than a
  -- person. Present so a flow can tell them apart; carries no SLA meaning.
  source           text NOT NULL
);

-- Time that must NOT count against the resolve clock.
--
-- ⚠ Spans are clipped to business hours too, for a business-hours service. A
-- pause that runs over a weekend removes no business minutes at all, and a query
-- that subtracts raw pause duration from a business-hours elapsed figure can
-- produce a NEGATIVE consumed time. INC-1012 is that case.
CREATE TABLE incident_pauses (
  id           integer PRIMARY KEY,
  incident_id  integer NOT NULL REFERENCES incidents(id),
  reason       text NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz
);

CREATE TABLE assets (
  id            integer PRIMARY KEY,
  hostname      text NOT NULL UNIQUE,
  os            text NOT NULL,
  -- prod | nonprod. ⚠ SEVERITY IS NOT PRIORITY: a `critical` CVE on a nonprod
  -- sandbox is not a P1, and deriving urgency from severity alone pages the
  -- on-call engineer at 03:00 for a machine nobody depends on.
  environment   text NOT NULL,
  service_id    integer REFERENCES services(id),
  owner_team_id integer NOT NULL REFERENCES teams(id),
  last_seen_at  timestamptz
);

CREATE TABLE vulnerabilities (
  cve           text PRIMARY KEY,
  title         text NOT NULL,
  -- critical | high | medium | low
  severity      text NOT NULL,
  cvss          numeric(3,1) NOT NULL,
  published_at  date NOT NULL,
  -- ⚠ KNOWN-EXPLOITED, AND IT OUTRANKS SEVERITY. A `medium` being actively
  -- exploited is more urgent than a `high` that is not. It is a separate column
  -- precisely so that an ordering has to READ it: `ORDER BY severity` alone
  -- buries the one thing that matters underneath nine that do not.
  kev           boolean NOT NULL,
  fix_available boolean NOT NULL
);

CREATE TABLE asset_vulnerabilities (
  asset_id    integer NOT NULL REFERENCES assets(id),
  cve         text NOT NULL REFERENCES vulnerabilities(cve),
  -- missing | installed | not_applicable
  state       text NOT NULL,
  detected_at date NOT NULL,
  PRIMARY KEY (asset_id, cve)
);

-- ⚠ A FREEZE MEANS DEFER, NOT SKIP. Remediation due inside one of these windows
-- must be deferred to `ends_at` and ANNOUNCED. Dropping it is silent and looks
-- exactly like there having been nothing to do.
CREATE TABLE change_freezes (
  id          integer PRIMARY KEY,
  freeze_code text NOT NULL UNIQUE,
  name        text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  -- NULL = every service. A freeze scoped to one service must not stop work
  -- everywhere else.
  service_id  integer REFERENCES services(id),
  reason      text NOT NULL
);

CREATE INDEX ON incidents (service_id, priority);
CREATE INDEX ON incidents (status);
CREATE INDEX ON incident_pauses (incident_id);
CREATE INDEX ON asset_vulnerabilities (cve);
CREATE INDEX ON assets (environment);
