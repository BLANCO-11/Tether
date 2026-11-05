-- HR demo schema (plans/hr-demo-stub-services-plan.md §5).
--
-- Lives in its OWN database (`hr_demo`), not in `foundry_parent`. Two reasons:
--   1. The schema introspector is hardcoded to table_schema = 'public', so demo
--      tables in the parent DB would appear alongside the app's own tables and
--      the agent would see `scripts`, `triggers`, `tools`… as queryable HR data.
--   2. The datasource connection string handed to generated scripts must reach
--      ONLY the demo data. A separate database is the boundary.
--
-- ALL DATA IN THIS DATABASE IS SYNTHETIC. Emails use the RFC 2606 reserved
-- domain `acme-hr.example`, which can never resolve or receive mail. Nothing
-- here is derived from a real person or a real HR system.

DROP TABLE IF EXISTS attendance_daily CASCADE;
DROP TABLE IF EXISTS attendance_monthly CASCADE;
DROP TABLE IF EXISTS leave_requests CASCADE;
DROP TABLE IF EXISTS policy_thresholds CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS departments CASCADE;
DROP TABLE IF EXISTS offices CASCADE;

CREATE TABLE offices (
  id            integer PRIMARY KEY,
  code          varchar(16)  NOT NULL UNIQUE,
  city          varchar(64)  NOT NULL,
  country       varchar(64)  NOT NULL,
  region        varchar(16)  NOT NULL,   -- AMER | EMEA | APAC
  timezone      varchar(64)  NOT NULL
);
COMMENT ON TABLE offices IS 'Physical offices. region is one of AMER, EMEA, APAC.';

CREATE TABLE departments (
  id            integer PRIMARY KEY,
  code          varchar(16)  NOT NULL UNIQUE,
  name          varchar(64)  NOT NULL,
  cost_centre   varchar(16)  NOT NULL
);
COMMENT ON TABLE departments IS 'Departments. Note: one department has zero employees.';

CREATE TABLE employees (
  id              integer PRIMARY KEY,
  employee_code   varchar(16)  NOT NULL UNIQUE,
  full_name       varchar(128) NOT NULL,
  -- NULL for contractors who have no corporate mailbox. Any automation that
  -- emails employees must handle this rather than crashing or sending to "None".
  work_email      varchar(128),
  department_id   integer      NOT NULL REFERENCES departments(id),
  office_id       integer      NOT NULL REFERENCES offices(id),
  -- NULL for the CEO only. Manager-escalation logic must handle the root node.
  manager_id      integer      REFERENCES employees(id),
  job_title       varchar(96)  NOT NULL,
  employment_type varchar(16)  NOT NULL,  -- full_time | part_time | contractor
  status          varchar(16)  NOT NULL,  -- active | on_leave | exited
  hire_date       date         NOT NULL,
  exit_date       date
);
COMMENT ON TABLE employees IS 'Employee roster. manager_id is a self-reference (NULL for the CEO). work_email is NULL for contractors. status: active | on_leave | exited.';

CREATE TABLE attendance_daily (
  id            bigserial PRIMARY KEY,
  employee_id   integer     NOT NULL REFERENCES employees(id),
  work_date     date        NOT NULL,
  status        varchar(16) NOT NULL,   -- present | absent | leave | wfh | holiday
  hours_worked  numeric(4,1) NOT NULL DEFAULT 0,
  UNIQUE (employee_id, work_date)
);
COMMENT ON TABLE attendance_daily IS 'Per-day attendance facts. status present/wfh count as attended; absent/leave do not. Covers 2026-04-01 .. 2026-06-30.';
CREATE INDEX attendance_daily_emp_date_idx ON attendance_daily (employee_id, work_date);

CREATE TABLE attendance_monthly (
  id              bigserial PRIMARY KEY,
  employee_id     integer     NOT NULL REFERENCES employees(id),
  period          char(7)     NOT NULL,      -- YYYY-MM
  working_days    integer     NOT NULL,
  days_attended   integer     NOT NULL,
  -- Pre-computed convenience rollup of attendance_daily, as a PERCENTAGE (0-100),
  -- not a 0-1 fraction. Compare against policy_thresholds.min_attendance_rate,
  -- which uses the same units.
  attendance_rate numeric(5,2) NOT NULL,
  UNIQUE (employee_id, period)
);
COMMENT ON TABLE attendance_monthly IS 'Monthly rollup of attendance_daily. attendance_rate is a PERCENTAGE 0-100 (same units as policy_thresholds.min_attendance_rate).';

CREATE TABLE leave_requests (
  id            integer PRIMARY KEY,
  employee_id   integer     NOT NULL REFERENCES employees(id),
  leave_type    varchar(24) NOT NULL,   -- medical | annual | parental | unpaid
  start_date    date        NOT NULL,
  end_date      date        NOT NULL,
  status        varchar(16) NOT NULL,   -- approved | pending | rejected
  reason        varchar(256)
);
COMMENT ON TABLE leave_requests IS 'Leave applications. An APPROVED medical leave overlapping the reporting period is the documented reason to exclude an employee from attendance screening.';
CREATE INDEX leave_requests_emp_idx ON leave_requests (employee_id);

CREATE TABLE policy_thresholds (
  id                  integer PRIMARY KEY,
  -- NULL department_id = the organisation-wide default. Look up the
  -- department-specific row first and fall back to the NULL row.
  department_id       integer REFERENCES departments(id),
  min_attendance_rate numeric(5,2) NOT NULL,  -- percentage 0-100
  effective_from      date NOT NULL
);
COMMENT ON TABLE policy_thresholds IS 'Minimum attendance policy. department_id NULL is the org-wide default; a department row overrides it. Deliberately NOT a single constant, so screening requires a join.';
