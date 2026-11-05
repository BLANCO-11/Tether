-- Finance demo schema — the second domain (Programme 3, Stage 1).
--
-- Lives in its OWN database (`finance_demo`), for the same reason `hr_demo`
-- does: the credential registered as a datasource must reach only the data that
-- workspace declares. `finance_ro` can connect here and nowhere else.
--
-- ALL DATA IN THIS DATABASE IS SYNTHETIC. Vendor and employee names are
-- invented; every email address is on an RFC 2606 reserved domain
-- (`acme-fin.example`, `*-bounce.example`, and the per-vendor `*.example`
-- domains) which can never resolve or receive mail. Nothing here is derived
-- from a real company, a real person, or a real ledger.
--
-- ── THE UNITS TRAP IS DELIBERATE AND LOAD-BEARING ────────────────────────────
--
--   invoices.amount_cents   bigint        MINOR units (cents)
--   expense_claims.amount_cents bigint    MINOR units (cents)
--   budgets.amount          numeric(12,2) MAJOR units (dollars)
--
-- Budget-versus-actual therefore requires a division by 100 on one side. Get it
-- wrong and Engineering reports as 62x over budget — a number so large it looks
-- like a data problem rather than an arithmetic one. This is the `0-100` versus
-- `0-1` lesson from `hr_demo` / `hr_demo_alt` reproduced in a second domain, and
-- it is the reason a Finance flow needs an oracle rather than a green run.

DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS expense_claims CASCADE;
DROP TABLE IF EXISTS expense_policy CASCADE;
DROP TABLE IF EXISTS budgets CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
DROP TABLE IF EXISTS cost_centres CASCADE;
DROP TABLE IF EXISTS org_settings CASCADE;

CREATE TABLE org_settings (
  key           varchar(64)  PRIMARY KEY,
  value         varchar(128) NOT NULL,
  description   text
);
COMMENT ON TABLE org_settings IS 'Organisation-wide defaults. default_payment_terms_days is the fallback when a vendor has no terms of its own — a query that omits the COALESCE silently drops those invoices.';

CREATE TABLE cost_centres (
  id            integer      PRIMARY KEY,
  code          varchar(16)  NOT NULL UNIQUE,
  name          varchar(64)  NOT NULL,
  -- Where a budget-variance report is sent. Never NULL: every cost centre has
  -- an owner, which is what makes the zero-spend one reportable rather than
  -- invisible.
  owner_email   varchar(128) NOT NULL,
  active        boolean      NOT NULL DEFAULT true
);
COMMENT ON TABLE cost_centres IS 'Cost centres. Note: one cost centre has zero spend in every period — the empty-group case.';

CREATE TABLE vendors (
  id                 integer      PRIMARY KEY,
  vendor_code        varchar(16)  NOT NULL UNIQUE,
  name               varchar(128) NOT NULL,
  -- NULL for a vendor with no accounts-payable contact on record. Any
  -- automation that emails vendors must handle this rather than sending to
  -- "None" and counting it as delivered.
  contact_email      varchar(128),
  -- NULL means "use org_settings.default_payment_terms_days". Stored as NULL
  -- rather than as the default so the fallback is a real join, not a copy.
  payment_terms_days integer,
  country            varchar(64)  NOT NULL,
  status             varchar(16)  NOT NULL DEFAULT 'active'  -- active | inactive
);
COMMENT ON TABLE vendors IS 'Supplier master. payment_terms_days is NULL for vendors on the org default. contact_email is NULL for one vendor; one more is on a domain that always hard-bounces.';

CREATE TABLE employees (
  id              integer      PRIMARY KEY,
  employee_code   varchar(16)  NOT NULL UNIQUE,
  full_name       varchar(128) NOT NULL,
  -- NULL for a contractor with no corporate mailbox, as in hr_demo.
  work_email      varchar(128),
  cost_centre_id  integer      NOT NULL REFERENCES cost_centres(id)
);
COMMENT ON TABLE employees IS 'People who can raise an expense claim. work_email is NULL for one contractor.';

CREATE TABLE invoices (
  id               integer      PRIMARY KEY,
  invoice_number   varchar(32)  NOT NULL UNIQUE,
  vendor_id        integer      NOT NULL REFERENCES vendors(id),
  cost_centre_id   integer      NOT NULL REFERENCES cost_centres(id),
  issue_date       date         NOT NULL,
  -- NULL means the due date is not stated on the document and must be derived:
  -- issue_date + COALESCE(vendor.payment_terms_days, org default).
  due_date         date,
  -- MINOR UNITS. Negative on a credit note. See the header.
  amount_cents     bigint       NOT NULL,
  currency         char(3)      NOT NULL DEFAULT 'USD',
  -- open | paid | void | credit
  --
  -- ⚠ `status` is the ledger's opinion and is not always current: one invoice
  -- is fully paid and still reads `open`. Outstanding amount is computed from
  -- `payments`, and that is the truth. A chase driven by status alone dunned a
  -- vendor who had already paid.
  status           varchar(16)  NOT NULL DEFAULT 'open',
  received_date    date         NOT NULL
);
COMMENT ON TABLE invoices IS 'Purchase invoices. amount_cents is in MINOR units (cents); budgets.amount is in MAJOR units. Negative amount_cents is a credit note (status=credit) and must never be chased. status can lag reality — compute outstanding from payments.';
CREATE INDEX invoices_vendor_idx ON invoices (vendor_id);
CREATE INDEX invoices_issue_idx  ON invoices (issue_date);

CREATE TABLE payments (
  id            integer      PRIMARY KEY,
  invoice_id    integer      NOT NULL REFERENCES invoices(id),
  paid_date     date         NOT NULL,
  -- MINOR units, same as invoices.amount_cents. A partial payment leaves the
  -- invoice open with a smaller outstanding balance.
  amount_cents  bigint       NOT NULL,
  method        varchar(16)  NOT NULL,   -- bank_transfer | card | cheque
  reference     varchar(32)  NOT NULL
);
COMMENT ON TABLE payments IS 'Payments against invoices, in MINOR units. One invoice is only partially paid; one is fully paid while its invoice row still says open.';
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

CREATE TABLE expense_policy (
  id             integer      PRIMARY KEY,
  category       varchar(32)  NOT NULL UNIQUE,
  -- MINOR units. The limit is INCLUSIVE: a claim exactly at the limit is within
  -- policy. A `>=` where `>` belongs sends a compliant claim to an approver.
  limit_cents    bigint       NOT NULL,
  effective_from date         NOT NULL
);
COMMENT ON TABLE expense_policy IS 'Per-category claim limits in MINOR units. The limit is INCLUSIVE — a claim exactly at the limit is within policy.';

CREATE TABLE expense_claims (
  id              integer      PRIMARY KEY,
  claim_code      varchar(16)  NOT NULL UNIQUE,
  employee_id     integer      NOT NULL REFERENCES employees(id),
  cost_centre_id  integer      NOT NULL REFERENCES cost_centres(id),
  category        varchar(32)  NOT NULL REFERENCES expense_policy(category),
  claim_date      date         NOT NULL,
  amount_cents    bigint       NOT NULL,   -- MINOR units
  -- submitted | approved | rejected. A rejected claim is settled: it must never
  -- be routed for approval again, however far over policy it is.
  status          varchar(16)  NOT NULL DEFAULT 'submitted',
  receipt_ref     varchar(32)
);
COMMENT ON TABLE expense_claims IS 'Employee expense claims in MINOR units. A rejected claim is settled and must not be re-routed for approval even when it is over policy.';
CREATE INDEX expense_claims_date_idx ON expense_claims (claim_date);

CREATE TABLE budgets (
  id              integer       PRIMARY KEY,
  cost_centre_id  integer       NOT NULL REFERENCES cost_centres(id),
  period          char(7)       NOT NULL,       -- YYYY-MM
  -- ⚠ MAJOR UNITS (dollars), unlike every *_cents column in this database.
  amount          numeric(12,2) NOT NULL,
  currency        char(3)       NOT NULL DEFAULT 'USD',
  UNIQUE (cost_centre_id, period)
);
COMMENT ON TABLE budgets IS 'Monthly budget per cost centre. ⚠ amount is in MAJOR units (dollars) while invoices and claims are in MINOR units (cents) — compare only after dividing the cents side by 100.';
