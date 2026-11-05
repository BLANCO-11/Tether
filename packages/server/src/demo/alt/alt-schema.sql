-- WS-E.1 — the ALT demo schema (plans/production-substitution-plan.md §8.1).
--
-- Same DOMAIN as hr_demo, deliberately different SHAPE. Every difference below is
-- there to catch one thing the primary dataset cannot, because it is the only
-- dataset in existence:
--
--   * a NAMED SCHEMA (`hr`), not `public`      → the WS-C.1 hardcode
--   * different table names (staff/org_units/…) → names baked into a prompt
--   * attendance exposed as a VIEW              → WS-C.2 views-as-tables
--   * rates as a FRACTION (0–1), not 0–100      → a unit assumption
--   * a threshold-RESOLVING view                → the WS-F.4 COALESCE trap
--   * a composite primary key                   → WS-C.3 composite keys
--
-- ALL DATA IS SYNTHETIC. Addresses use `alt-hr.example` / `alt-hr-bounce.example`,
-- reserved by RFC 2606 and unable to resolve or receive mail. See alt-dataset.ts.

DROP SCHEMA IF EXISTS hr CASCADE;
CREATE SCHEMA hr;

CREATE TABLE hr.sites (
  id          integer PRIMARY KEY,
  site_code   varchar(8)  NOT NULL UNIQUE,
  city        varchar(64) NOT NULL,
  country     varchar(64) NOT NULL,
  zone        varchar(64) NOT NULL
);
COMMENT ON TABLE hr.sites IS 'Physical sites. zone is an IANA timezone.';

CREATE TABLE hr.org_units (
  id          integer PRIMARY KEY,
  unit_code   varchar(8)  NOT NULL UNIQUE,
  unit_name   varchar(64) NOT NULL,
  ledger_code varchar(16) NOT NULL
);
COMMENT ON TABLE hr.org_units IS 'Organisational units. One unit has zero staff.';

CREATE TABLE hr.staff (
  id             integer PRIMARY KEY,
  badge          varchar(16)  NOT NULL UNIQUE,
  full_name      varchar(128) NOT NULL,
  -- NULL for agency staff with no corporate mailbox.
  work_mailbox   varchar(128),
  unit_id        integer      NOT NULL REFERENCES hr.org_units(id),
  site_id        integer      NOT NULL REFERENCES hr.sites(id),
  -- NULL for the root of the reporting tree only.
  supervisor_id  integer      REFERENCES hr.staff(id),
  role           varchar(96)  NOT NULL,
  contract_type  varchar(16)  NOT NULL,  -- permanent | part_time | agency
  state          varchar(16)  NOT NULL,  -- working | sabbatical | left
  joined_on      date         NOT NULL,
  left_on        date
);
COMMENT ON TABLE hr.staff IS 'Staff roster. state: working | sabbatical | left. work_mailbox is NULL for agency staff.';

-- Composite primary key (WS-C.3): (staff_id, period) rather than a surrogate id.
CREATE TABLE hr.presence_rollup (
  staff_id      integer     NOT NULL REFERENCES hr.staff(id),
  period        char(7)     NOT NULL,   -- YYYY-MM
  working_days  integer     NOT NULL,
  days_present  integer     NOT NULL,
  -- ⚠ UNITS: a FRACTION in [0,1], NOT a percentage. hr_demo uses 0-100. Compare
  -- only against hr.attendance_policy.min_rate, which uses the same units.
  presence_rate numeric(6,4) NOT NULL,
  PRIMARY KEY (staff_id, period)
);
COMMENT ON TABLE hr.presence_rollup IS 'Monthly presence per staff member. presence_rate is a FRACTION 0-1 (not a percentage). Covers 2025-09 .. 2025-11.';

CREATE TABLE hr.attendance_policy (
  id            integer PRIMARY KEY,
  -- NULL unit_id = the organisation-wide default; a unit row overrides it.
  unit_id       integer REFERENCES hr.org_units(id),
  min_rate      numeric(6,4) NOT NULL,  -- FRACTION 0-1
  active_from   date NOT NULL
);
COMMENT ON TABLE hr.attendance_policy IS 'Minimum presence policy as a FRACTION 0-1. unit_id NULL is the org-wide default; a unit row overrides it.';

-- ── Views ──────────────────────────────────────────────────────────────────
-- WS-C.2: production commonly exposes views rather than base tables, and WS-A.7
-- recommends granting SELECT on views precisely so column exposure is controlled
-- in the database. Both cases must be introspected correctly.

CREATE VIEW hr.staff_directory AS
  SELECT s.id, s.badge, s.full_name, s.work_mailbox, s.state, s.contract_type,
         u.unit_code, u.unit_name, t.site_code, t.city, t.zone
    FROM hr.staff s
    JOIN hr.org_units u ON u.id = s.unit_id
    JOIN hr.sites     t ON t.id = s.site_id;
COMMENT ON VIEW hr.staff_directory IS 'Staff joined to unit and site. Read-only view.';

/*
 * WS-F.4 — the RESOLVED form of the policy join.
 *
 * The primary dataset's worst measured failure was a LEFT JOIN onto the policy
 * table with no COALESCE to the org-wide default, which blanked 6 of 7
 * departments. The plan's conclusion generalises: where a join is easy to get
 * wrong, EXPOSE THE RESOLVED FORM so the correct answer is also the easy one.
 *
 * This view does the COALESCE once, in the database. A script that uses it cannot
 * make that mistake. A script that hand-writes the join against
 * hr.attendance_policy still can — which is what makes it a useful comparison
 * rather than a way of hiding the trap.
 */
CREATE VIEW hr.presence_vs_policy AS
  SELECT r.staff_id,
         r.period,
         r.working_days,
         r.days_present,
         r.presence_rate,
         s.unit_id,
         COALESCE(unit_policy.min_rate, default_policy.min_rate) AS min_rate,
         (r.presence_rate < COALESCE(unit_policy.min_rate, default_policy.min_rate)) AS below_policy
    FROM hr.presence_rollup r
    JOIN hr.staff s ON s.id = r.staff_id
    LEFT JOIN hr.attendance_policy unit_policy
           ON unit_policy.unit_id = s.unit_id
    LEFT JOIN hr.attendance_policy default_policy
           ON default_policy.unit_id IS NULL;
COMMENT ON VIEW hr.presence_vs_policy IS 'Presence with the applicable policy ALREADY RESOLVED (unit override falling back to the org default) and a below_policy flag. Both rates are FRACTIONS 0-1. Prefer this over joining attendance_policy by hand.';

CREATE INDEX presence_rollup_period_idx ON hr.presence_rollup (period);
CREATE INDEX staff_unit_idx ON hr.staff (unit_id);
